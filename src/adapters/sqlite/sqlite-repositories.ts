// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeArtifact, normalizeSubject, subjectIdentityKey, type ArtifactKind, type DurableArtifact, type SubjectInput } from "../../core/artifacts/schema.js";
import type { Lease, LeaseRepository } from "../../core/ports/lease.js";
import { ConcurrentRunUpdateError, type ArtifactRepository, type RunRepository } from "../../core/ports/repositories.js";
import type { RunState, TransitionRecord } from "../../core/state/machine.js";

const SQLITE_BUSY_TIMEOUT_MS = 30_000;

export class SqliteRepositories implements ArtifactRepository, RunRepository, LeaseRepository {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    this.#database = database;
    try {
      this.#database.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
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
          acquired_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      this.migrateArtifactSubjectIndex();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  private migrateArtifactSubjectIndex(): void {
    const version = "canonical-subject-v1";
    const applied = this.#database.prepare("SELECT value FROM schema_meta WHERE key = ?").get("artifact_subject_index") as { value: string } | undefined;
    if (applied?.value === version) return;

    try {
      // busy_timeout lets another opener finish its migration instead of making
      // this constructor fail with a transient SQLITE_BUSY.
      this.#database.exec("BEGIN IMMEDIATE");
      // The pre-lock read is only a fast path. Re-check while holding the write
      // lock so concurrent openers do not repeat or race the migration.
      const lockedApplied = this.#database.prepare("SELECT value FROM schema_meta WHERE key = ?").get("artifact_subject_index") as { value: string } | undefined;
      if (lockedApplied?.value === version) {
        this.#database.exec("COMMIT");
        return;
      }
      const rows = this.#database.prepare("SELECT artifact_id, artifact_json FROM artifacts ORDER BY rowid").all() as Array<{ artifact_id: string; artifact_json: string }>;
      const update = this.#database.prepare("UPDATE artifacts SET subject_key = ? WHERE artifact_id = ?");
      for (const row of rows) {
        const parsed: unknown = JSON.parse(row.artifact_json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Artifact ${row.artifact_id} is not an object`);
        const subject = normalizeSubject((parsed as { subject?: unknown }).subject);
        update.run(subjectIdentityKey(subject), row.artifact_id);
      }
      this.#database.prepare("INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run("artifact_subject_index", version);
      this.#database.exec("COMMIT");
    } catch (error) {
      // BEGIN IMMEDIATE can fail before a transaction is established; do not
      // replace the useful SQLite error with a secondary ROLLBACK error.
      try { this.#database.exec("ROLLBACK"); } catch { /* no active transaction */ }
      throw error;
    }
  }

  async append(artifact: DurableArtifact): Promise<void> {
    const canonical = normalizeArtifact(artifact);
    this.#database.prepare(`
      INSERT INTO artifacts (artifact_id, subject_key, kind, artifact_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO NOTHING
    `).run(canonical.id, subjectKey(canonical.subject), canonical.kind, JSON.stringify(canonical));
  }

  async list(subject: SubjectInput, kind?: ArtifactKind): Promise<DurableArtifact[]> {
    const query = normalizeSubject(subject);
    const rows = kind
      ? this.#database.prepare("SELECT artifact_json FROM artifacts WHERE kind = ? ORDER BY rowid").all(kind)
      : this.#database.prepare("SELECT artifact_json FROM artifacts ORDER BY rowid").all();
    return rows
      .map((row) => normalizeArtifact(JSON.parse(String((row as { artifact_json: string }).artifact_json))))
      .filter((artifact) => subjectMatches(artifact.subject, query));
  }

  async create(state: RunState): Promise<void> {
    const canonical = canonicalRunState(state);
    try {
      this.#database.prepare("INSERT INTO runs (run_id, version, state_json) VALUES (?, ?, ?)")
        .run(canonical.runId, canonical.version, JSON.stringify(canonical));
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) throw new Error(`Run already exists: ${state.runId}`);
      throw error;
    }
  }

  async load(runId: string): Promise<RunState | undefined> {
    const row = this.#database.prepare("SELECT state_json FROM runs WHERE run_id = ?").get(runId) as { state_json: string } | undefined;
    return row ? canonicalRunState(JSON.parse(row.state_json) as RunState) : undefined;
  }

  listRuns(limit = 50): RunState[] {
    const rows = this.#database.prepare("SELECT state_json FROM runs ORDER BY rowid DESC LIMIT ?").all(limit);
    return rows.map((row) => canonicalRunState(JSON.parse(String((row as { state_json: string }).state_json)) as RunState));
  }

  rebuildRun(state: RunState): void {
    const canonical = canonicalRunState(state);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("DELETE FROM transitions WHERE run_id = ?").run(canonical.runId);
      this.#database.prepare(`
        INSERT INTO runs (run_id, version, state_json) VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json
      `).run(canonical.runId, canonical.version, JSON.stringify(canonical));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async commit(expectedVersion: number, state: RunState, record: TransitionRecord): Promise<void> {
    const canonical = canonicalRunState(state);
    if (canonical.version !== expectedVersion + 1 || record.sequence !== canonical.version) {
      throw new Error("Run commit must advance exactly one version");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.#database.prepare(`
        UPDATE runs SET version = ?, state_json = ?
        WHERE run_id = ? AND version = ?
      `).run(canonical.version, JSON.stringify(canonical), canonical.runId, expectedVersion);
      if (result.changes !== 1) {
        const row = this.#database.prepare("SELECT version FROM runs WHERE run_id = ?").get(canonical.runId) as { version: number } | undefined;
        if (!row) throw new Error(`Unknown run: ${canonical.runId}`);
        throw new ConcurrentRunUpdateError(canonical.runId, expectedVersion, row.version);
      }
      this.#database.prepare("INSERT INTO transitions (run_id, sequence, record_json) VALUES (?, ?, ?)")
        .run(canonical.runId, record.sequence, JSON.stringify(record));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async history(runId: string): Promise<TransitionRecord[]> {
    const rows = this.#database.prepare("SELECT record_json FROM transitions WHERE run_id = ? ORDER BY sequence").all(runId);
    return rows.map((row) => JSON.parse(String((row as { record_json: string }).record_json)) as TransitionRecord);
  }

  acquire(itemId: string, owner: string, ttlMs: number, now = Date.now()): Lease | undefined {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("DELETE FROM leases WHERE item_id = ? AND expires_at <= ?").run(itemId, now);
      const token = crypto.randomUUID();
      const result = this.#database.prepare(`
        INSERT INTO leases (item_id, owner, token, acquired_at, heartbeat_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(item_id) DO NOTHING
      `).run(itemId, owner, token, now, now, now + ttlMs);
      this.#database.exec("COMMIT");
      return result.changes === 1 ? { itemId, owner, token, acquiredAt: now, heartbeatAt: now, expiresAt: now + ttlMs } : undefined;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeat(itemId: string, token: string, ttlMs: number, now = Date.now()): Lease {
    const result = this.#database.prepare(`
      UPDATE leases SET heartbeat_at = ?, expires_at = ?
      WHERE item_id = ? AND token = ? AND expires_at > ?
    `).run(now, now + ttlMs, itemId, token, now);
    if (result.changes !== 1) throw new Error(`Lease is absent, stale, or owned by another worker: ${itemId}`);
    const row = this.#database.prepare("SELECT * FROM leases WHERE item_id = ?").get(itemId) as Record<string, string | number>;
    return leaseFromRow(row);
  }

  release(itemId: string, token: string): boolean {
    return this.#database.prepare("DELETE FROM leases WHERE item_id = ? AND token = ?").run(itemId, token).changes === 1;
  }

  close(): void {
    this.#database.close();
  }
}

function subjectKey(subject: SubjectInput): string {
  return subjectIdentityKey(subject);
}

function subjectMatches(left: SubjectInput, right: SubjectInput): boolean {
  const artifact = normalizeSubject(left);
  const query = normalizeSubject(right);
  if (artifact.forge !== query.forge || artifact.repo !== query.repo) return false;
  return (query.issue !== undefined && artifact.issue === query.issue)
    || (query.pr !== undefined && artifact.pr === query.pr);
}

function canonicalRunState(state: RunState): RunState {
  return { ...state, subject: normalizeSubject(state.subject) };
}

function leaseFromRow(row: Record<string, string | number>): Lease {
  return {
    itemId: String(row.item_id), owner: String(row.owner), token: String(row.token),
    acquiredAt: Number(row.acquired_at), heartbeatAt: Number(row.heartbeat_at), expiresAt: Number(row.expires_at),
  };
}
