// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { assertArtifact, type ArtifactKind, type DurableArtifact, type Subject } from "../../core/artifacts/schema.js";
import type { IssueSnapshot } from "../../core/ports/forge-host.js";
import { LeaseContinuityError, type AuthenticatedLeaseCheckpoint, type Lease, type LeaseGuard, type LeaseRepository, type LeaseWitness, type LeaseWitnessSnapshot } from "../../core/ports/lease.js";
import type { OrchestrationRecord, OrchestrationRepository } from "../../core/ports/orchestration.js";
import { ConcurrentPromotionUpdateError, type PromotionRecord, type PromotionRepository } from "../../core/ports/promotion.js";
import { ConcurrentRunUpdateError, remediationAdmissionKey, type ArtifactRepository, type RemediationAdmissionClaim, type RemediationAdmissionKey, type RemediationAdmissionRepository, type RunProgressRecord, type RunRepository } from "../../core/ports/repositories.js";
import type { AgentRunReceipt, TelemetryRepository } from "../../core/ports/telemetry.js";
import type { RunState, TransitionRecord } from "../../core/state/machine.js";

const SQLITE_BUSY_TIMEOUT_MS = 10_000;
const SQLITE_BUSY_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

export class SqliteRepositories implements ArtifactRepository, RunRepository, LeaseRepository, TelemetryRepository, RemediationAdmissionRepository, OrchestrationRepository, PromotionRepository {
  readonly #database: DatabaseSync;
  readonly #witness: LeaseWitness | undefined;
  #recoveryEpoch: number | undefined;
  #leaseFailure: string | undefined;

  constructor(path: string, options: { witness?: LeaseWitness } = {}) {
    this.#witness = options.witness;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    // WAL permits concurrent readers, but SQLite still has one writer. Wait for
    // short cross-process controller transactions instead of turning contention
    // into a terminal workflow failure. Set it before WAL initialization so a
    // concurrent constructor is covered too.
    this.#database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    // Setting journal mode may replace SQLite's busy handler, so configure the
    // timeout after WAL is enabled.
    this.#database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transitions (
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS run_progress (
        progress_id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        message TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS run_progress_run ON run_progress(run_id, progress_id);
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        subject_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        artifact_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_subject_kind ON artifacts(subject_key, kind);
      CREATE TABLE IF NOT EXISTS leases (
        item_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        token TEXT NOT NULL,
        epoch INTEGER NOT NULL DEFAULT 0,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lease_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        max_epoch INTEGER NOT NULL
      );
      INSERT INTO lease_state (singleton, max_epoch) VALUES (1, 0) ON CONFLICT(singleton) DO NOTHING;
      CREATE TABLE IF NOT EXISTS run_telemetry (
        telemetry_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        session_ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        receipt_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_telemetry_run ON run_telemetry(run_id, created_at);
      CREATE TABLE IF NOT EXISTS remediation_admissions (
        admission_key TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        parent_issue INTEGER NOT NULL,
        parent_pull_request INTEGER NOT NULL,
        head_sha TEXT NOT NULL,
        marker TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'materialized')),
        issue_json TEXT
      );
      CREATE TABLE IF NOT EXISTS orchestrations (
        orchestration_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orchestrations_updated ON orchestrations(updated_at);
      CREATE TABLE IF NOT EXISTS promotion_records (
        promotion_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        phase TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS promotions_updated ON promotion_records(updated_at);
    `);
    // Existing operational stores predate fencing. They are retained for
    // inspection, but lease use remains fail-closed until a witness is bound.
    try { this.#database.exec("ALTER TABLE leases ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
  }

  async append(artifact: DurableArtifact): Promise<void> {
    assertArtifact(artifact);
    await withSqliteBusyRetry(() => this.#database.prepare(`
      INSERT INTO artifacts (artifact_id, subject_key, kind, artifact_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO NOTHING
    `).run(artifact.id, subjectKey(artifact.subject), artifact.kind, JSON.stringify(artifact)));
  }

  async list(subject: Subject, kind?: ArtifactKind): Promise<DurableArtifact[]> {
    const rows = kind
      ? this.#database.prepare("SELECT artifact_json FROM artifacts WHERE subject_key = ? AND kind = ? ORDER BY rowid").all(subjectKey(subject), kind)
      : this.#database.prepare("SELECT artifact_json FROM artifacts WHERE subject_key = ? ORDER BY rowid").all(subjectKey(subject));
    return rows.map((row) => {
      const parsed: unknown = JSON.parse(String((row as { artifact_json: string }).artifact_json));
      assertArtifact(parsed);
      return parsed;
    });
  }

  async create(state: RunState): Promise<void> {
    try {
      await withSqliteBusyRetry(() => this.#database.prepare("INSERT INTO runs (run_id, version, state_json) VALUES (?, ?, ?)")
        .run(state.runId, state.version, JSON.stringify(state)));
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new Error(`Run already exists: ${state.runId}`);
      throw error;
    }
  }

  async load(runId: string): Promise<RunState | undefined> {
    const row = this.#database.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as RunState : undefined;
  }

  listRuns(limit = 50): RunState[] {
    const rows = this.#database.prepare("SELECT state_json FROM runs ORDER BY rowid DESC LIMIT ?").all(limit);
    return rows.map((row) => JSON.parse(String((row as { state_json: string }).state_json)) as RunState);
  }

  async createOrchestration(record: OrchestrationRecord): Promise<void> {
    await withSqliteBusyRetry(() => this.#database.prepare(`
      INSERT INTO orchestrations (orchestration_id, repository, status, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.orchestrationId, record.repository, record.status, record.updatedAt, JSON.stringify(record)));
  }

  async loadOrchestration(orchestrationId: string): Promise<OrchestrationRecord | undefined> {
    const row = this.#database.prepare("SELECT record_json FROM orchestrations WHERE orchestration_id = ?")
      .get(orchestrationId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as OrchestrationRecord : undefined;
  }

  async saveOrchestration(record: OrchestrationRecord): Promise<void> {
    await withSqliteBusyRetry(() => this.#database.prepare(`
      INSERT INTO orchestrations (orchestration_id, repository, status, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(orchestration_id) DO UPDATE SET
        repository = excluded.repository,
        status = excluded.status,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `).run(record.orchestrationId, record.repository, record.status, record.updatedAt, JSON.stringify(record)));
  }

  async listOrchestrations(limit = 50): Promise<OrchestrationRecord[]> {
    const rows = this.#database.prepare("SELECT record_json FROM orchestrations ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map((row) => JSON.parse(String((row as { record_json: string }).record_json)) as OrchestrationRecord);
  }

  async createPromotion(record: PromotionRecord): Promise<void> {
    try {
      await withSqliteBusyRetry(() => this.#database.prepare(`
        INSERT INTO promotion_records (promotion_id, repository, phase, version, updated_at, record_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(record.promotionId, record.repository, record.phase, record.version, record.updatedAt, JSON.stringify(record)));
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new Error(`Promotion already exists: ${record.promotionId}`);
      throw error;
    }
  }

  async loadPromotion(promotionId: string): Promise<PromotionRecord | undefined> {
    const row = this.#database.prepare("SELECT record_json FROM promotion_records WHERE promotion_id = ?")
      .get(promotionId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as PromotionRecord : undefined;
  }

  async savePromotion(expectedVersion: number, record: PromotionRecord): Promise<void> {
    if (record.version !== expectedVersion + 1) throw new Error("Promotion save must advance exactly one version");
    await withSqliteBusyRetry(() => this.inTransaction(() => {
      const result = this.#database.prepare(`
        UPDATE promotion_records SET phase = ?, version = ?, updated_at = ?, record_json = ?
        WHERE promotion_id = ? AND version = ?
      `).run(record.phase, record.version, record.updatedAt, JSON.stringify(record), record.promotionId, expectedVersion);
      if (result.changes !== 1) {
        const row = this.#database.prepare("SELECT version FROM promotion_records WHERE promotion_id = ?")
          .get(record.promotionId) as { version: number } | undefined;
        if (!row) throw new Error(`Unknown promotion: ${record.promotionId}`);
        throw new ConcurrentPromotionUpdateError(record.promotionId, expectedVersion, row.version);
      }
    }));
  }

  async listPromotions(limit = 50): Promise<PromotionRecord[]> {
    const rows = this.#database.prepare("SELECT record_json FROM promotion_records ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map((row) => JSON.parse(String((row as { record_json: string }).record_json)) as PromotionRecord);
  }

  async claim(key: RemediationAdmissionKey): Promise<RemediationAdmissionClaim> {
    const admissionKey = remediationAdmissionKey(key);
    return withSqliteBusyRetry(() => this.inTransaction(() => {
      const inserted = this.#database.prepare(`
        INSERT INTO remediation_admissions
          (admission_key, repository, parent_issue, parent_pull_request, head_sha, marker, status)
        VALUES (?, ?, ?, ?, ?, ?, 'pending') ON CONFLICT(admission_key) DO NOTHING
      `).run(admissionKey, key.repo.trim().toLowerCase(), key.parentIssue, key.parentPullRequest, key.headSha.trim().toLowerCase(), key.marker.trim());
      const row = this.#database.prepare("SELECT status, issue_json FROM remediation_admissions WHERE admission_key = ?")
        .get(admissionKey) as { status: "pending" | "materialized"; issue_json?: string } | undefined;
      if (!row) throw new Error(`Unable to read remediation admission: ${admissionKey}`);
      if (row.status === "materialized" && row.issue_json) {
        return { status: "materialized", snapshot: JSON.parse(row.issue_json) as IssueSnapshot };
      }
      return inserted.changes === 1 ? { status: "claimed" } : { status: "pending" };
    }));
  }

  async complete(key: RemediationAdmissionKey, snapshot: IssueSnapshot): Promise<void> {
    const admissionKey = remediationAdmissionKey(key);
    await withSqliteBusyRetry(() => {
      const result = this.#database.prepare(`
        UPDATE remediation_admissions SET status = 'materialized', issue_json = ? WHERE admission_key = ?
      `).run(JSON.stringify(snapshot), admissionKey);
      if (result.changes !== 1) throw new Error(`Unknown remediation admission: ${admissionKey}`);
    });
  }

  async invalidateMaterialized(key: RemediationAdmissionKey, expectedIssueNumber: number): Promise<boolean> {
    const admissionKey = remediationAdmissionKey(key);
    return withSqliteBusyRetry(() => this.inTransaction(() => {
      const row = this.#database.prepare("SELECT status, issue_json FROM remediation_admissions WHERE admission_key = ?")
        .get(admissionKey) as { status: "pending" | "materialized"; issue_json?: string } | undefined;
      if (row?.status !== "materialized" || !row.issue_json) return false;
      const snapshot = JSON.parse(row.issue_json) as IssueSnapshot;
      if (snapshot.number !== expectedIssueNumber) return false;
      return this.#database.prepare("DELETE FROM remediation_admissions WHERE admission_key = ? AND status = 'materialized'")
        .run(admissionKey).changes === 1;
    }));
  }

  async recordTelemetry(receipt: AgentRunReceipt): Promise<void> {
    await withSqliteBusyRetry(() => this.#database.prepare(`
      INSERT INTO run_telemetry (telemetry_key, run_id, task_id, session_ref, created_at, receipt_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(telemetry_key) DO NOTHING
    `).run(receipt.key, receipt.runId, receipt.taskId, receipt.sessionRef, receipt.timing.completedAt, JSON.stringify(receipt)));
  }

  listTelemetry(runId: string): AgentRunReceipt[] {
    const rows = this.#database.prepare("SELECT receipt_json FROM run_telemetry WHERE run_id = ? ORDER BY rowid").all(runId);
    return rows.map((row) => JSON.parse(String((row as { receipt_json: string }).receipt_json)) as AgentRunReceipt);
  }

  async rebuildRun(state: RunState): Promise<void> {
    await withSqliteBusyRetry(() => this.inTransaction(() => {
      this.#database.prepare("DELETE FROM transitions WHERE run_id = ?").run(state.runId);
      this.#database.prepare("DELETE FROM run_progress WHERE run_id = ?").run(state.runId);
      this.#database.prepare(`
        INSERT INTO runs (run_id, version, state_json) VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json
      `).run(state.runId, state.version, JSON.stringify(state));
    }));
  }

  async commit(expectedVersion: number, state: RunState, record: TransitionRecord): Promise<void> {
    if (state.version !== expectedVersion + 1 || record.sequence !== state.version) {
      throw new Error("Run commit must advance exactly one version");
    }
    await withSqliteBusyRetry(() => this.inTransaction(() => {
      const result = this.#database.prepare(`
        UPDATE runs SET version = ?, state_json = ?
        WHERE run_id = ? AND version = ?
      `).run(state.version, JSON.stringify(state), state.runId, expectedVersion);
      if (result.changes !== 1) {
        const row = this.#database.prepare("SELECT version FROM runs WHERE run_id = ?").get(state.runId) as { version: number } | undefined;
        if (!row) throw new Error(`Unknown run: ${state.runId}`);
        throw new ConcurrentRunUpdateError(state.runId, expectedVersion, row.version);
      }
      this.#database.prepare("INSERT INTO transitions (run_id, sequence, record_json) VALUES (?, ?, ?)")
        .run(state.runId, record.sequence, JSON.stringify(record));
    }));
  }

  async history(runId: string): Promise<TransitionRecord[]> {
    const rows = this.#database.prepare("SELECT record_json FROM transitions WHERE run_id = ? ORDER BY sequence").all(runId);
    return rows.map((row) => JSON.parse(String((row as { record_json: string }).record_json)) as TransitionRecord);
  }

  async recordProgress(progress: RunProgressRecord): Promise<void> {
    await withSqliteBusyRetry(() => this.#database.prepare(`
      INSERT INTO run_progress (run_id, phase, message, occurred_at)
      VALUES (?, ?, ?, ?)
    `).run(progress.runId, progress.phase, progress.message, progress.occurredAt));
  }

  async listProgress(runId: string): Promise<RunProgressRecord[]> {
    const rows = this.#database.prepare(`
      SELECT run_id, phase, message, occurred_at
      FROM run_progress WHERE run_id = ? ORDER BY progress_id
    `).all(runId) as Array<{ run_id: string; phase: string; message: string; occurred_at: string }>;
    return rows.map((row) => ({ runId: row.run_id, phase: row.phase, message: row.message, occurredAt: row.occurred_at }));
  }

  acquire(itemId: string, owner: string, ttlMs: number, now = Date.now()): Lease | undefined {
    this.#assertLeaseContinuity();
    return this.inTransaction(() => {
      const current = this.#database.prepare("SELECT epoch, expires_at FROM leases WHERE item_id = ?").get(itemId) as { epoch: number; expires_at: number } | undefined;
      if (current && current.epoch > this.#localMaximum()) this.#failLease("local lease epoch is ahead of the retained witness");
      const recoveredRow = current && this.#recoveryEpoch !== undefined && current.epoch < this.#recoveryEpoch;
      if (current && current.expires_at > now && !recoveredRow) return undefined;
      // Advancing the retained witness happens before assigning the row. A
      // failed SQLite commit therefore consumes an epoch and can never reuse it.
      const advanced = this.#witness!.compareAndAdvance(this.#localMaximum());
      this.#acceptWitness(advanced);
      if (recoveredRow) this.#database.prepare("DELETE FROM leases WHERE item_id = ?").run(itemId);
      else this.#database.prepare("DELETE FROM leases WHERE item_id = ? AND expires_at <= ?").run(itemId, now);
      const token = crypto.randomUUID();
      const result = this.#database.prepare(`
        INSERT INTO leases (item_id, owner, token, epoch, acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO NOTHING
      `).run(itemId, owner, token, advanced.epoch, now, now, now + ttlMs);
      if (result.changes !== 1) return undefined;
      this.#recoveryEpoch = undefined;
      return { itemId, owner, token, epoch: advanced.epoch, acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs, continuity: "verified" as const };
    });
  }

  heartbeat(itemId: string, token: string, ttlMs: number, now = Date.now()): Lease {
    this.#assertLeaseContinuity();
    const rowBefore = this.#database.prepare("SELECT epoch FROM leases WHERE item_id = ?").get(itemId) as { epoch: number } | undefined;
    if (rowBefore && rowBefore.epoch > this.#localMaximum()) this.#failLease("lease row is divergent from the retained witness");
    if (rowBefore && this.#recoveryEpoch !== undefined && rowBefore.epoch < this.#recoveryEpoch) {
      throw new LeaseContinuityError("lease row predates authenticated re-enrollment");
    }
    const result = this.#database.prepare(`
      UPDATE leases SET heartbeat_at = ?, expires_at = ?
      WHERE item_id = ? AND token = ? AND expires_at > ?
    `).run(now, now + ttlMs, itemId, token, now);
    if (result.changes !== 1) throw new Error(`Lease is absent, stale, or owned by another worker: ${itemId}`);
    return leaseFromRow(this.#database.prepare("SELECT * FROM leases WHERE item_id = ?").get(itemId) as Record<string, string | number>);
  }

  release(itemId: string, token: string): boolean {
    this.#assertLeaseContinuity();
    const row = this.#database.prepare("SELECT epoch FROM leases WHERE item_id = ?").get(itemId) as { epoch: number } | undefined;
    if (row && row.epoch > this.#localMaximum()) this.#failLease("lease row is divergent from the retained witness");
    if (row && this.#recoveryEpoch !== undefined && row.epoch < this.#recoveryEpoch) {
      throw new LeaseContinuityError("lease row predates authenticated re-enrollment");
    }
    return this.#database.prepare("DELETE FROM leases WHERE item_id = ? AND token = ?").run(itemId, token).changes === 1;
  }

  guard(itemId: string, token: string): LeaseGuard {
    return { assertValid: () => {
      this.#assertLeaseContinuity();
      const row = this.#database.prepare("SELECT token, epoch FROM leases WHERE item_id = ?").get(itemId) as { token: string; epoch: number } | undefined;
      if (row && this.#recoveryEpoch !== undefined && row.epoch < this.#recoveryEpoch) {
        throw new LeaseContinuityError("lease row predates authenticated re-enrollment");
      }
      if (!row || row.token !== token) throw new LeaseContinuityError(`holder token is no longer current for ${itemId}`);
    }, check: () => { this.guard(itemId, token).assertValid(); } };
  }

  continuity(): LeaseWitnessSnapshot {
    if (this.#leaseFailure) return { state: "unverifiable", epoch: this.#localMaximum(), reason: this.#leaseFailure };
    if (!this.#witness) return { state: "unverifiable", epoch: this.#localMaximum(), reason: "no retained checkpoint witness is configured" };
    const snapshot = this.#witness.verify();
    if (snapshot.state !== "verified" || snapshot.epoch !== this.#localMaximum()) {
      return { ...snapshot, state: "unverifiable", reason: snapshot.reason ?? "local maximum diverges from the retained witness" };
    }
    return snapshot;
  }

  reEnroll(checkpoint: AuthenticatedLeaseCheckpoint): void {
    if (!this.#witness) throw new LeaseContinuityError("no retained checkpoint witness is configured");
    if (!Number.isSafeInteger(checkpoint.epoch) || checkpoint.epoch <= this.#localMaximum()) {
      throw new LeaseContinuityError("re-enrollment checkpoint is not higher than the local maximum");
    }
    const snapshot = this.#witness.reEnroll(checkpoint);
    this.#acceptWitness(snapshot);
    this.#recoveryEpoch = snapshot.epoch;
    this.#leaseFailure = undefined;
  }

  #localMaximum(): number {
    return Number((this.#database.prepare("SELECT max_epoch FROM lease_state WHERE singleton = 1").get() as { max_epoch: number } | undefined)?.max_epoch ?? 0);
  }
  #acceptWitness(snapshot: LeaseWitnessSnapshot): void {
    if (snapshot.state !== "verified" || !Number.isSafeInteger(snapshot.epoch) || snapshot.epoch < 0 || snapshot.epoch < this.#localMaximum()) this.#failLease(snapshot.reason ?? "retained witness rolled back or failed verification");
    this.#database.prepare("UPDATE lease_state SET max_epoch = ? WHERE singleton = 1").run(snapshot.epoch);
  }
  #failLease(reason: string): never {
    this.#leaseFailure = reason;
    throw new LeaseContinuityError(reason);
  }
  #assertLeaseContinuity(): void {
    if (this.#leaseFailure) throw new LeaseContinuityError(this.#leaseFailure);
    if (!this.#witness) this.#failLease("no retained checkpoint witness is configured");
    const snapshot = this.#witness.verify();
    // Recover the historical bootstrap mismatch only for a demonstrably
    // unused lease store. Old bootstraps seeded the witness at epoch 1 while
    // SQLite began at 0, making the documented first acquire impossible.
    // Never apply this bridge once either side has lease history.
    if (snapshot.state === "verified"
      && snapshot.epoch === 1
      && this.#localMaximum() === 0
      && Number((this.#database.prepare("SELECT COUNT(*) AS count FROM leases").get() as { count: number }).count) === 0) {
      this.#acceptWitness(snapshot);
    }
    if (snapshot.state !== "verified" || snapshot.epoch !== this.#localMaximum()) {
      this.#failLease(snapshot.reason ?? "local maximum diverges from the retained witness");
    }
    this.#acceptWitness(snapshot);
  }

  close(): void {
    this.#database.close();
  }

  private inTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    let active = true;
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      active = false;
      return result;
    } catch (error) {
      if (active) {
        try { this.#database.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
      }
      throw error;
    }
  }
}

async function withSqliteBusyRetry<T>(operation: () => T | Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length) throw error;
      await sleep(SQLITE_BUSY_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
  return /database is locked|database is busy|SQLITE_(?:BUSY|LOCKED)/i.test(message);
}

function subjectKey(subject: Subject): string {
  return `${subject.repo}|i:${subject.issue ?? ""}|p:${subject.pr ?? ""}`;
}

function leaseFromRow(row: Record<string, string | number>): Lease {
  return {
    itemId: String(row.item_id), owner: String(row.owner), token: String(row.token), epoch: Number(row.epoch),
    acquiredAt: Number(row.acquired_at), heartbeatAt: Number(row.heartbeat_at), expiresAt: Number(row.expires_at), continuity: "verified",
  };
}
