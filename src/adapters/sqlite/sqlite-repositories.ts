// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, chmodSync, renameSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertArtifact, type ArtifactKind, type DurableArtifact, type Subject } from "../../core/artifacts/schema.js";
import type { IssueSnapshot, ReviewFindingPublicationFence } from "../../core/ports/forge-host.js";
import { LeaseContinuityError, type AuthenticatedLeaseCheckpoint, type Lease, type LeaseAcquisitionOptions, type LeaseGuard, type LeaseInspection, type LeaseRepository, type LeaseWitness, type LeaseWitnessSnapshot } from "../../core/ports/lease.js";
import { findRunningOrchestrationIssueConflicts, MAX_ORCHESTRATION_PAGE_SIZE, OrchestrationIssueOwnershipConflictError, orchestrationRecordIssueIdentities, type OrchestrationExecutionFence, type OrchestrationListCursor, type OrchestrationRecord, type OrchestrationRepository } from "../../core/ports/orchestration.js";
import { ConcurrentPromotionUpdateError, type PromotionRecord, type PromotionRepository } from "../../core/ports/promotion.js";
import { ConcurrentRunUpdateError, remediationAdmissionKey, reviewFindingPublicationFenceKey, sameReviewFindingPublicationFence, type ArtifactRepository, type RemediationAdmissionClaim, type RemediationAdmissionKey, type RemediationAdmissionRepository, type ReviewFindingPublicationFenceRepository, type RunProgressRecord, type RunRepository } from "../../core/ports/repositories.js";
import type { AgentRunReceipt, TelemetryRepository } from "../../core/ports/telemetry.js";
import type { RunState, TransitionRecord } from "../../core/state/machine.js";
import { initializeSqliteDatabase, withSqliteBusyRetry } from "../../core/sqlite-retry.js";

/** Exact persisted identities accepted by the internal cleanup boundary. */
export interface SqliteRepositoryPurgeManifest {
  runs?: readonly { runId: string }[];
  artifacts?: readonly { artifactId: string; subjectKey: string; kind: ArtifactKind }[];
  orchestrations?: readonly { orchestrationId: string }[];
  promotions?: readonly { promotionId: string }[];
  telemetry?: readonly { telemetryKey: string; runId: string; taskId: string; sessionRef: string }[];
  remediationAdmissions?: readonly { admissionKey: string }[];
  reviewFindingFences?: readonly { fenceKey: string }[];
  leases?: readonly { itemId: string }[];
}

export interface SqliteRepositoryPurgeResult {
  runs: number;
  artifacts: number;
  orchestrations: number;
  promotions: number;
  telemetry: number;
  remediationAdmissions: number;
  reviewFindingFences: number;
  leases: number;
}

export class SqliteRepositories implements ArtifactRepository, RunRepository, LeaseRepository, TelemetryRepository, RemediationAdmissionRepository, ReviewFindingPublicationFenceRepository, OrchestrationRepository, PromotionRepository {
  readonly #database: DatabaseSync;
  readonly #path: string;
  readonly #witness: LeaseWitness | undefined;
  #recoveryEpoch: number | undefined;
  #leaseFailure: string | undefined;

  constructor(path: string, options: { witness?: LeaseWitness; readOnly?: boolean } = {}) {
    this.#path = path;
    this.#witness = options.witness;
    if (path !== ":memory:" && !options.readOnly) mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path, options.readOnly ? { readOnly: true } : {});
    if (!options.readOnly) initializeSqliteDatabase(this.#database, `
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
        binding TEXT,
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
      CREATE TABLE IF NOT EXISTS review_finding_publication_fences (
        fence_key TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        fence_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orchestrations (
        orchestration_id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS orchestrations_updated ON orchestrations(updated_at);
      CREATE INDEX IF NOT EXISTS orchestrations_running_updated ON orchestrations(status, updated_at, orchestration_id);
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
    if (options.readOnly) return;
    // Existing operational stores predate fencing. They are retained for
    // inspection, but lease use remains fail-closed until a witness is bound.
    try { this.#database.exec("ALTER TABLE leases ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0"); } catch { /* already migrated */ }
    try { this.#database.exec("ALTER TABLE leases ADD COLUMN binding TEXT"); } catch { /* already migrated */ }
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

  assertResetNoLiveLeases(itemIds: readonly string[], now = Date.now()): void {
    for (const itemId of itemIds) {
      const row = this.#database.prepare("SELECT owner, expires_at FROM leases WHERE item_id = ?").get(itemId) as { owner: string; expires_at: number } | undefined;
      if (row && row.expires_at > now) throw new Error(`Reset cannot fence live lease ${itemId} owned by ${row.owner} until ${new Date(row.expires_at).toISOString()}`);
    }
  }

  assertResetNoLiveLeasePatterns(patterns: readonly string[], now = Date.now()): void {
    const rows = this.#database.prepare("SELECT item_id, owner, expires_at FROM leases").all() as Array<{ item_id: string; owner: string; expires_at: number }>;
    for (const row of rows) {
      if (patterns.some((pattern) => row.item_id === pattern || row.item_id.startsWith(pattern)) && row.expires_at > now) {
        throw new Error(`Reset cannot fence live lease ${row.item_id} owned by ${row.owner} until ${new Date(row.expires_at).toISOString()}`);
      }
    }
  }

  listReviewFindingPublicationFenceSnapshots(): Array<{ fenceKey: string; generation: number; snapshotSha256: string; repository?: string; pullRequest?: number }> {
    const rows = this.#database.prepare("SELECT fence_key, generation, repository, pull_request, fence_json FROM review_finding_publication_fences ORDER BY rowid").all() as Array<{ fence_key: string; generation: number; repository: string; pull_request: number; fence_json: string }>;
    return rows.map((row) => ({ fenceKey: row.fence_key, generation: row.generation, repository: row.repository, pullRequest: row.pull_request, snapshotSha256: createSha256(row.fence_json) }));
  }

  listResetTaskIdentities(runIds: readonly string[]): Array<{ taskId: string; runId: string; snapshotSha256: string }> {
    const result: Array<{ taskId: string; runId: string; snapshotSha256: string }> = [];
    for (const runId of runIds) {
      const run = this.loadSync(runId);
      if (!run) continue;
      result.push({ taskId: `run:${runId}`, runId, snapshotSha256: createSha256(JSON.stringify(run)) });
    }
    return result;
  }

  private loadSync(runId: string): RunState | undefined {
    const row = this.#database.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as RunState : undefined;
  }


  listArtifactsForRuns(runIds: readonly string[]): Array<{ artifactId: string; subjectKey: string; kind: ArtifactKind; sha256: string }> {
    if (!runIds.length) return [];
    const result: Array<{ artifactId: string; subjectKey: string; kind: ArtifactKind; sha256: string }> = [];
    for (const runId of runIds) {
      const rows = this.#database.prepare("SELECT artifact_id, subject_key, kind, artifact_json FROM artifacts WHERE json_extract(artifact_json, '$.runId') = ? ORDER BY rowid").all(runId) as Array<{ artifact_id: string; subject_key: string; kind: ArtifactKind; artifact_json: string }>;
      for (const row of rows) result.push({ artifactId: row.artifact_id, subjectKey: row.subject_key, kind: row.kind, sha256: createSha256(row.artifact_json) });
    }
    return result;
  }

  listAllLeaseSnapshots(): Array<{ itemId: string; expiresAt: number; owner: string; tokenSha256: string }> {
    const rows = this.#database.prepare("SELECT item_id, expires_at, owner, token FROM leases ORDER BY rowid").all() as Array<{ item_id: string; expires_at: number; owner: string; token: string }>;
    return rows.map((row) => ({ itemId: row.item_id, expiresAt: row.expires_at, owner: row.owner, tokenSha256: createSha256(row.token) }));
  }
  listLeaseSnapshots(itemIds: readonly string[]): Array<{ itemId: string; expiresAt: number; owner: string; tokenSha256: string }> {
    const result: Array<{ itemId: string; expiresAt: number; owner: string; tokenSha256: string }> = [];
    for (const itemId of itemIds) {
      const row = this.#database.prepare("SELECT item_id, expires_at, owner, token FROM leases WHERE item_id = ?").get(itemId) as { item_id: string; expires_at: number; owner: string; token: string } | undefined;
      if (row) result.push({ itemId: row.item_id, expiresAt: row.expires_at, owner: row.owner, tokenSha256: createSha256(row.token) });
    }
    return result;
  }
  listTelemetryIdentitiesForRuns(runIds: readonly string[]): Array<{ key: string; runId: string; taskId: string; sessionRef: string; receiptSha256: string }> {
    const result: Array<{ key: string; runId: string; taskId: string; sessionRef: string; receiptSha256: string }> = [];
    for (const runId of runIds) {
      const rows = this.#database.prepare("SELECT telemetry_key, run_id, task_id, session_ref, receipt_json FROM run_telemetry WHERE run_id = ? ORDER BY rowid").all(runId) as Array<{ telemetry_key: string; run_id: string; task_id: string; session_ref: string; receipt_json: string }>;
      for (const row of rows) result.push({ key: row.telemetry_key, runId: row.run_id, taskId: row.task_id, sessionRef: row.session_ref, receiptSha256: createSha256(row.receipt_json) });
    }
    return result;
  }

  async createOrchestration(record: OrchestrationRecord): Promise<void> {
    await withSqliteBusyRetry(() => this.inTransaction(() => {
      if (record.status === "running") {
        const rows = this.#database.prepare("SELECT record_json FROM orchestrations WHERE status = 'running'")
          .all() as Array<{ record_json: string }>;
        const existing = rows.map((row) => JSON.parse(row.record_json) as OrchestrationRecord);
        const conflicts = findRunningOrchestrationIssueConflicts(
          existing,
          orchestrationRecordIssueIdentities(record),
        );
        if (conflicts.length) throw new OrchestrationIssueOwnershipConflictError(conflicts);
      }
      this.#database.prepare(`
        INSERT INTO orchestrations (orchestration_id, repository, status, updated_at, record_json)
        VALUES (?, ?, ?, ?, ?)
      `).run(record.orchestrationId, record.repository, record.status, record.updatedAt, JSON.stringify(record));
    }));
  }

  async loadOrchestration(orchestrationId: string): Promise<OrchestrationRecord | undefined> {
    const row = this.#database.prepare("SELECT record_json FROM orchestrations WHERE orchestration_id = ?")
      .get(orchestrationId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as OrchestrationRecord : undefined;
  }

  async saveOrchestration(record: OrchestrationRecord): Promise<void> {
    await withSqliteBusyRetry(() => this.inTransaction(() => {
      this.saveOrchestrationInTransaction(record);
    }));
  }

  async saveOrchestrationFenced(record: OrchestrationRecord, fence: OrchestrationExecutionFence): Promise<void> {
    await withSqliteBusyRetry(() => this.inTransaction(() => {
      this.#assertLeaseContinuity();
      const lease = this.#database.prepare("SELECT token, epoch, expires_at FROM leases WHERE item_id = ?")
        .get(fence.itemId) as { token: string; epoch: number; expires_at: number } | undefined;
      if (!lease || lease.token !== fence.token || lease.epoch !== fence.epoch) {
        throw new LeaseContinuityError("orchestration execution claim is no longer current");
      }
      if (lease.expires_at <= fence.now()) {
        throw new LeaseContinuityError("orchestration execution claim expired before durable save");
      }
      this.saveOrchestrationInTransaction(record);
    }));
  }

  async listOrchestrations(limit = 50): Promise<OrchestrationRecord[]> {
    const rows = this.#database.prepare("SELECT record_json FROM orchestrations ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map((row) => JSON.parse(String((row as { record_json: string }).record_json)) as OrchestrationRecord);
  }

  async listRunningOrchestrations(limit = 100, before?: OrchestrationListCursor): Promise<OrchestrationRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ORCHESTRATION_PAGE_SIZE) {
      throw new Error(`Orchestration page limit must be an integer from 1 to ${MAX_ORCHESTRATION_PAGE_SIZE}`);
    }
    const rows = before === undefined
      ? this.#database.prepare("SELECT record_json FROM orchestrations WHERE status = 'running' ORDER BY updated_at DESC, orchestration_id DESC LIMIT ?").all(limit)
      : this.#database.prepare("SELECT record_json FROM orchestrations WHERE status = 'running' AND (updated_at < ? OR (updated_at = ? AND orchestration_id < ?)) ORDER BY updated_at DESC, orchestration_id DESC LIMIT ?").all(before.updatedAt, before.updatedAt, before.orchestrationId, limit);
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

  async beginReviewFindingPublication(input: Omit<ReviewFindingPublicationFence, "generation">): Promise<ReviewFindingPublicationFence> {
    const key = reviewFindingPublicationFenceKey(input.repo, input.pullRequest);
    return withSqliteBusyRetry(() => this.inTransaction(() => {
      const current = this.#database.prepare(`
        SELECT generation FROM review_finding_publication_fences WHERE fence_key = ?
      `).get(key) as { generation: number } | undefined;
      const fence: ReviewFindingPublicationFence = {
        ...structuredClone(input),
        generation: (current?.generation ?? 0) + 1,
      };
      this.#database.prepare(`
        INSERT INTO review_finding_publication_fences
          (fence_key, repository, pull_request, generation, fence_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(fence_key) DO UPDATE SET
          generation = excluded.generation,
          fence_json = excluded.fence_json
        WHERE review_finding_publication_fences.generation = excluded.generation - 1
      `).run(key, input.repo.trim().toLowerCase(), input.pullRequest, fence.generation, JSON.stringify(fence));
      const installed = this.#database.prepare(`
        SELECT generation, fence_json FROM review_finding_publication_fences WHERE fence_key = ?
      `).get(key) as { generation: number; fence_json: string } | undefined;
      if (!installed || installed.generation !== fence.generation || installed.fence_json !== JSON.stringify(fence)) {
        throw new Error(`Review-finding publication fence CAS failed for ${input.repo}#${input.pullRequest}`);
      }
      return fence;
    }));
  }

  async assertReviewFindingPublication(fence: ReviewFindingPublicationFence): Promise<void> {
    const key = reviewFindingPublicationFenceKey(fence.repo, fence.pullRequest);
    await withSqliteBusyRetry(() => {
      const current = this.#database.prepare(`
        SELECT generation, fence_json FROM review_finding_publication_fences WHERE fence_key = ?
      `).get(key) as { generation: number; fence_json: string } | undefined;
      const decoded = current ? JSON.parse(current.fence_json) as ReviewFindingPublicationFence : undefined;
      if (!current || current.generation !== fence.generation || !decoded || !sameReviewFindingPublicationFence(decoded, fence)) {
        throw new Error(`Review-finding publication fence is stale for ${fence.repo}#${fence.pullRequest} generation ${fence.generation}`);
      }
    });
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
      // Rebuild only the rebuildable current-state row. Transition history,
      // progress, and telemetry are operational evidence and must survive a
      // cache/state repair; deleting them made stalls look like fresh runs.
      const highWater = this.#database.prepare("SELECT MAX(sequence) AS sequence FROM transitions WHERE run_id = ?")
        .get(state.runId) as { sequence?: number } | undefined;
      const version = Math.max(state.version, highWater?.sequence ?? state.version);
      const persisted = version === state.version ? state : { ...state, version };
      this.#database.prepare(`
        INSERT INTO runs (run_id, version, state_json) VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json
      `).run(state.runId, version, JSON.stringify(persisted));
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

  acquire(itemId: string, owner: string, ttlMs: number, now = Date.now(), options?: LeaseAcquisitionOptions): Lease | undefined {
    return this.inTransaction(() => {
      // The retained checkpoint is advanced before the SQLite epoch is
      // committed. Serialize verification with that entire two-store update
      // so another process cannot mistake the intentional transient gap for
      // rollback or divergence.
      this.#assertLeaseContinuity();
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
      const binding = normalizeLeaseBinding(options?.binding);
      const result = this.#database.prepare(`
        INSERT INTO leases (item_id, owner, token, binding, epoch, acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO NOTHING
      `).run(itemId, owner, token, binding ?? null, advanced.epoch, now, now, now + ttlMs);
      if (result.changes !== 1) return undefined;
      this.#recoveryEpoch = undefined;
      return { itemId, owner, token, ...(binding !== undefined ? { binding } : {}), epoch: advanced.epoch, acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs, continuity: "verified" as const };
    });
  }

  inspect(itemId: string): LeaseInspection | undefined {
    return this.inTransaction(() => {
      this.#assertLeaseContinuity();
      const row = this.#database.prepare("SELECT * FROM leases WHERE item_id = ?")
        .get(itemId) as Record<string, string | number> | undefined;
      if (!row) return undefined;
      const { token: _token, ...inspection } = leaseFromRow(row);
      return inspection;
    });
  }

  heartbeat(itemId: string, token: string, ttlMs: number, now = Date.now()): Lease {
    return this.inTransaction(() => {
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
    });
  }

  release(itemId: string, token: string): boolean {
    return this.inTransaction(() => {
      this.#assertLeaseContinuity();
      const row = this.#database.prepare("SELECT epoch FROM leases WHERE item_id = ?").get(itemId) as { epoch: number } | undefined;
      if (row && row.epoch > this.#localMaximum()) this.#failLease("lease row is divergent from the retained witness");
      if (row && this.#recoveryEpoch !== undefined && row.epoch < this.#recoveryEpoch) {
        throw new LeaseContinuityError("lease row predates authenticated re-enrollment");
      }
      return this.#database.prepare("DELETE FROM leases WHERE item_id = ? AND token = ?").run(itemId, token).changes === 1;
    });
  }

  guard(itemId: string, token: string, now: () => number = Date.now): LeaseGuard {
    const assertValid = (): void => {
      this.inTransaction(() => {
        this.#assertLeaseContinuity();
        const row = this.#database.prepare("SELECT token, epoch, expires_at FROM leases WHERE item_id = ?").get(itemId) as { token: string; epoch: number; expires_at: number } | undefined;
        if (row && this.#recoveryEpoch !== undefined && row.epoch < this.#recoveryEpoch) {
          throw new LeaseContinuityError("lease row predates authenticated re-enrollment");
        }
        if (!row || row.token !== token) throw new LeaseContinuityError(`holder token is no longer current for ${itemId}`);
        if (row.expires_at <= now()) throw new LeaseContinuityError(`holder lease has expired for ${itemId}`);
      });
    };
    return { assertValid, check: assertValid };
  }

  continuity(): LeaseWitnessSnapshot {
    if (this.#leaseFailure) return { state: "unverifiable", epoch: this.#localMaximum(), reason: this.#leaseFailure };
    if (!this.#witness) return { state: "unverifiable", epoch: this.#localMaximum(), reason: "no retained checkpoint witness is configured" };
    return this.inTransaction(() => {
      const snapshot = this.#witness!.verify();
      if (snapshot.state !== "verified" || snapshot.epoch !== this.#localMaximum()) {
        return { ...snapshot, state: "unverifiable" as const, reason: snapshot.reason ?? "local maximum diverges from the retained witness" };
      }
      return snapshot;
    });
  }

  reEnroll(checkpoint: AuthenticatedLeaseCheckpoint): void {
    if (!this.#witness) throw new LeaseContinuityError("no retained checkpoint witness is configured");
    const recoveryEpoch = this.inTransaction(() => {
      if (!Number.isSafeInteger(checkpoint.epoch) || checkpoint.epoch <= this.#localMaximum()) {
        throw new LeaseContinuityError("re-enrollment checkpoint is not higher than the local maximum");
      }
      const current = this.#witness!.verify();
      // The witness is intentionally advanced before SQLite. If a prior
      // attempt reached the witness and then lost its SQLite commit, adopt the
      // exact authenticated checkpoint idempotently instead of requiring the
      // operator to mint another, still-higher recovery epoch.
      const snapshot = current.state === "verified" && sameCheckpoint(current.checkpoint, checkpoint)
        ? current
        : this.#witness!.reEnroll(checkpoint);
      this.#acceptWitness(snapshot);
      return snapshot.epoch;
    });
    // Do not publish in-memory recovery state until SQLite committed it.
    this.#recoveryEpoch = recoveryEpoch;
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

  /**
   * Delete only rows named by a previously captured manifest. This is kept off
   * the repository ports deliberately: cleanup must not become a general
   * deletion primitive, and an identity mismatch aborts the whole transaction.
   */
  verifyResetPurged(ids: { runs: readonly string[]; artifacts: readonly string[]; orchestrations: readonly string[]; promotions: readonly string[]; telemetry: readonly string[]; fences: readonly string[]; leases: readonly string[] }): void {
    const checks: Array<[string, string, readonly string[]]> = [
      ["runs", "run_id", ids.runs], ["artifacts", "artifact_id", ids.artifacts], ["orchestrations", "orchestration_id", ids.orchestrations],
      ["promotion_records", "promotion_id", ids.promotions], ["run_telemetry", "telemetry_key", ids.telemetry],
      ["review_finding_publication_fences", "fence_key", ids.fences], ["leases", "item_id", ids.leases],
    ];
    for (const [table, column, keys] of checks) for (const key of keys) {
      const row = this.#database.prepare(`SELECT 1 AS found FROM ${table} WHERE ${column} = ?`).get(key) as { found: number } | undefined;
      if (row) throw new Error(`Reset purge postcondition failed; ${table} row remains: ${key}`);
    }
  }

  async purgeExactManifest(manifest: SqliteRepositoryPurgeManifest, now = Date.now(), options: { allowAbsent?: boolean } = {}): Promise<SqliteRepositoryPurgeResult> {
    const allowAbsent = options.allowAbsent === true;
    return withSqliteBusyRetry(() => this.inTransaction(() => {
      const runs = manifest.runs ?? [];
      const artifacts = manifest.artifacts ?? [];
      const orchestrations = manifest.orchestrations ?? [];
      const promotions = manifest.promotions ?? [];
      const telemetry = manifest.telemetry ?? [];
      const remediationAdmissions = manifest.remediationAdmissions ?? [];
      const reviewFindingFences = manifest.reviewFindingFences ?? [];
      const leases = manifest.leases ?? [];
      assertUniqueManifestValues(runs.map(({ runId }) => runId), "run");
      assertUniqueManifestValues(artifacts.map(({ artifactId }) => artifactId), "artifact");
      assertUniqueManifestValues(orchestrations.map(({ orchestrationId }) => orchestrationId), "orchestration");
      assertUniqueManifestValues(promotions.map(({ promotionId }) => promotionId), "promotion");
      assertUniqueManifestValues(telemetry.map(({ telemetryKey }) => telemetryKey), "telemetry");
      assertUniqueManifestValues(remediationAdmissions.map(({ admissionKey }) => admissionKey), "remediation admission");
      assertUniqueManifestValues(reviewFindingFences.map(({ fenceKey }) => fenceKey), "review finding fence");
      assertUniqueManifestValues(leases.map(({ itemId }) => itemId), "lease");

      for (const row of runs) this.assertExactRow("runs", "run_id", row.runId, ["run_id"], undefined, allowAbsent);
      for (const row of artifacts) this.assertExactRow("artifacts", "artifact_id", row.artifactId, ["artifact_id", "subject_key", "kind"], [row.artifactId, row.subjectKey, row.kind], allowAbsent);
      for (const row of orchestrations) this.assertExactRow("orchestrations", "orchestration_id", row.orchestrationId, ["orchestration_id"], undefined, allowAbsent);
      for (const row of promotions) this.assertExactRow("promotion_records", "promotion_id", row.promotionId, ["promotion_id"], undefined, allowAbsent);
      for (const row of telemetry) this.assertExactRow("run_telemetry", "telemetry_key", row.telemetryKey, ["telemetry_key", "run_id", "task_id", "session_ref"], [row.telemetryKey, row.runId, row.taskId, row.sessionRef], allowAbsent);
      for (const row of remediationAdmissions) this.assertExactRow("remediation_admissions", "admission_key", row.admissionKey, ["admission_key"], undefined, allowAbsent);
      for (const row of reviewFindingFences) this.assertExactRow("review_finding_publication_fences", "fence_key", row.fenceKey, ["fence_key"], undefined, allowAbsent);
      for (const row of leases) {
        const current = this.#database.prepare("SELECT expires_at FROM leases WHERE item_id = ?").get(row.itemId) as { expires_at: number } | undefined;
        if (!current) {
          if (allowAbsent) continue;
          throw new Error(`Purge manifest lease is absent: ${row.itemId}`);
        }
        if (current.expires_at > now) throw new Error(`Cannot purge active lease: ${row.itemId}`);
      }

      // Delete children explicitly before their parent rows even though the
      // schema also carries ON DELETE CASCADE. This remains safe for older
      // databases whose foreign-key pragma was not enabled at creation time.
      for (const row of runs) {
        this.#database.prepare("DELETE FROM transitions WHERE run_id = ?").run(row.runId);
        this.#database.prepare("DELETE FROM run_progress WHERE run_id = ?").run(row.runId);
      }
      const result: SqliteRepositoryPurgeResult = {
        runs: 0, artifacts: 0, orchestrations: 0, promotions: 0,
        telemetry: 0, remediationAdmissions: 0, reviewFindingFences: 0, leases: 0,
      };
      for (const row of runs) result.runs += Number(this.#database.prepare("DELETE FROM runs WHERE run_id = ?").run(row.runId).changes ?? 0);
      for (const row of artifacts) result.artifacts += Number(this.#database.prepare("DELETE FROM artifacts WHERE artifact_id = ? AND subject_key = ? AND kind = ?").run(row.artifactId, row.subjectKey, row.kind).changes ?? 0);
      for (const row of orchestrations) result.orchestrations += Number(this.#database.prepare("DELETE FROM orchestrations WHERE orchestration_id = ?").run(row.orchestrationId).changes ?? 0);
      for (const row of promotions) result.promotions += Number(this.#database.prepare("DELETE FROM promotion_records WHERE promotion_id = ?").run(row.promotionId).changes ?? 0);
      for (const row of telemetry) result.telemetry += Number(this.#database.prepare("DELETE FROM run_telemetry WHERE telemetry_key = ? AND run_id = ? AND task_id = ? AND session_ref = ?").run(row.telemetryKey, row.runId, row.taskId, row.sessionRef).changes ?? 0);
      for (const row of remediationAdmissions) result.remediationAdmissions += Number(this.#database.prepare("DELETE FROM remediation_admissions WHERE admission_key = ?").run(row.admissionKey).changes ?? 0);
      for (const row of reviewFindingFences) result.reviewFindingFences += Number(this.#database.prepare("DELETE FROM review_finding_publication_fences WHERE fence_key = ?").run(row.fenceKey).changes ?? 0);
      for (const row of leases) result.leases += Number(this.#database.prepare("DELETE FROM leases WHERE item_id = ? AND expires_at <= ?").run(row.itemId, now).changes ?? 0);
      return result;
    }));
  }

  archiveResetDatabase(directory: string, prefix: string): Array<{ path: string; sha256: string; kind: "database" }> {
    if (this.#path === ":memory:") return [];
    mkdirSync(directory, { recursive: true });
    // Checkpoint before copying so the main file plus any retained WAL set is
    // a recoverable, self-consistent restore set. Keep WAL/SHM when present.
    this.#database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const result: Array<{ path: string; sha256: string; kind: "database" }> = [];
    for (const source of [this.#path, `${this.#path}-wal`, `${this.#path}-shm`]) {
      if (!existsSync(source)) continue;
      const destination = `${directory}/${prefix}${source === this.#path ? ".db" : source.endsWith("-wal") ? ".db-wal" : ".db-shm"}`;
      const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
      if (existsSync(destination)) {
        const existing = readFileSync(destination);
        result.push({ path: destination, sha256: createSha256(existing), kind: "database" });
        continue;
      }
      copyFileSync(source, temporary);
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
      const bytes = readFileSync(destination);
      result.push({ path: destination, sha256: createSha256(bytes), kind: "database" });
    }
    return result;
  }
  close(): void {
    this.#database.close();
  }

  private assertExactRow(table: string, keyColumn: string, key: string, columns: readonly string[], expected?: readonly (string | number)[], allowAbsent = false): void {
    const row = this.#database.prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE ${keyColumn} = ?`).get(key) as Record<string, string | number> | undefined;
    if (!row) {
      if (allowAbsent) return;
      throw new Error(`Purge manifest ${table} row is absent: ${key}`);
    }
    if (expected && columns.some((column, index) => String(row[column]) !== String(expected[index]))) {
      throw new Error(`Purge manifest identity mismatch in ${table}: ${key}`);
    }
  }

  private saveOrchestrationInTransaction(record: OrchestrationRecord): void {
    const current = this.#database.prepare("SELECT record_json FROM orchestrations WHERE orchestration_id = ?")
      .get(record.orchestrationId) as { record_json: string } | undefined;
    if (current) {
      const persisted = JSON.parse(current.record_json) as OrchestrationRecord;
      const incomingAttempt = orchestrationExecutionAttempt(record);
      const persistedAttempt = orchestrationExecutionAttempt(persisted);
      if (incomingAttempt < persistedAttempt) {
        throw new Error(`Stale orchestration update for ${record.orchestrationId}: execution attempt ${incomingAttempt} is behind persisted attempt ${persistedAttempt}`);
      }
      if (incomingAttempt > 0 && persistedAttempt === incomingAttempt
        && (record.executionClaimId ?? "") !== (persisted.executionClaimId ?? "")) {
        throw new Error(`Conflicting orchestration claim for ${record.orchestrationId}: execution attempt ${incomingAttempt} belongs to another controller`);
      }
    }
    if (record.status === "running") {
      const rows = this.#database.prepare(
        "SELECT record_json FROM orchestrations WHERE status = 'running' AND orchestration_id <> ?",
      ).all(record.orchestrationId) as Array<{ record_json: string }>;
      const conflicts = findRunningOrchestrationIssueConflicts(
        rows.map((row) => JSON.parse(row.record_json) as OrchestrationRecord),
        orchestrationRecordIssueIdentities(record),
      );
      if (conflicts.length) throw new OrchestrationIssueOwnershipConflictError(conflicts);
    }
    this.#database.prepare(`
      INSERT INTO orchestrations (orchestration_id, repository, status, updated_at, record_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(orchestration_id) DO UPDATE SET
        repository = excluded.repository,
        status = excluded.status,
        updated_at = excluded.updated_at,
        record_json = excluded.record_json
    `).run(record.orchestrationId, record.repository, record.status, record.updatedAt, JSON.stringify(record));
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

function createSha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameCheckpoint(left: AuthenticatedLeaseCheckpoint | undefined, right: AuthenticatedLeaseCheckpoint): boolean {
  return left?.epoch === right.epoch
    && left.signature === right.signature
    && left.keyId === right.keyId;
}

function subjectKey(subject: Subject): string {
  return `${subject.repo}|i:${subject.issue ?? ""}|p:${subject.pr ?? ""}`;
}

function leaseFromRow(row: Record<string, string | number>): Lease {
  const binding = typeof row.binding === "string" && row.binding.trim() ? row.binding : undefined;
  return {
    itemId: String(row.item_id), owner: String(row.owner), token: String(row.token), ...(binding !== undefined ? { binding } : {}), epoch: Number(row.epoch),
    acquiredAt: Number(row.acquired_at), heartbeatAt: Number(row.heartbeat_at), expiresAt: Number(row.expires_at), continuity: "verified",
  };
}

function normalizeLeaseBinding(binding: string | undefined): string | undefined {
  if (binding === undefined) return undefined;
  const value = binding.trim();
  if (!value) throw new Error("Lease binding must not be empty");
  if (value.length > 512) throw new Error("Lease binding is too long");
  return value;
}

function assertUniqueManifestValues(values: readonly string[], label: string): void {
  if (values.some((value) => typeof value !== "string" || value.length === 0)) throw new Error(`Purge manifest ${label} identity must be non-empty`);
  if (new Set(values).size !== values.length) throw new Error(`Purge manifest contains duplicate ${label} identities`);
}

function orchestrationExecutionAttempt(record: OrchestrationRecord): number {
  return Number.isSafeInteger(record.executionAttempt) && record.executionAttempt !== undefined
    ? record.executionAttempt
    : 0;
}
