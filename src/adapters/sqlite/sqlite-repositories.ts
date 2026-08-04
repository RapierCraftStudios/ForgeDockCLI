// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertArtifact, type ArtifactKind, type DurableArtifact, type Subject } from "../../core/artifacts/schema.js";
import type { Lease, LeaseRepository } from "../../core/ports/lease.js";
import { ConcurrentRunUpdateError, type ArtifactRepository, type RunRepository } from "../../core/ports/repositories.js";
import type { RunState, TransitionRecord } from "../../core/state/machine.js";

export class SqliteRepositories implements ArtifactRepository, RunRepository, LeaseRepository {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
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
    `);
  }

  async append(artifact: DurableArtifact): Promise<void> {
    assertArtifact(artifact);
    this.#database.prepare(`
      INSERT INTO artifacts (artifact_id, subject_key, kind, artifact_json)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(artifact_id) DO NOTHING
    `).run(artifact.id, subjectKey(artifact.subject), artifact.kind, JSON.stringify(artifact));
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
      this.#database.prepare("INSERT INTO runs (run_id, version, state_json) VALUES (?, ?, ?)")
        .run(state.runId, state.version, JSON.stringify(state));
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

  rebuildRun(state: RunState): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare("DELETE FROM transitions WHERE run_id = ?").run(state.runId);
      this.#database.prepare(`
        INSERT INTO runs (run_id, version, state_json) VALUES (?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json
      `).run(state.runId, state.version, JSON.stringify(state));
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  async commit(expectedVersion: number, state: RunState, record: TransitionRecord): Promise<void> {
    if (state.version !== expectedVersion + 1 || record.sequence !== state.version) {
      throw new Error("Run commit must advance exactly one version");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
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

function subjectKey(subject: Subject): string {
  return `${subject.repo}|i:${subject.issue ?? ""}|p:${subject.pr ?? ""}`;
}

function leaseFromRow(row: Record<string, string | number>): Lease {
  return {
    itemId: String(row.item_id), owner: String(row.owner), token: String(row.token),
    acquiredAt: Number(row.acquired_at), heartbeatAt: Number(row.heartbeat_at), expiresAt: Number(row.expires_at),
  };
}
