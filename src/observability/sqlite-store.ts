// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  OBSERVATION_SCHEMA_VERSION,
  type ObservationDraft,
  type ObservationEnvelopeV1,
  type ObservationLayoutStore,
  type ObservationQuery,
  type ObservationRetentionPolicy,
  type ObservationRetentionResult,
  type ObservationStore,
  normalizeObservationDraft,
  observationScopeKey,
} from "./contracts.js";
import { initializeSqliteDatabase } from "../core/sqlite-retry.js";
import type { WorkspaceLayout } from "./workspace-layout.js";

const DEFAULT_QUERY_LIMIT = 500;
const MAX_QUERY_LIMIT = 5_000;

/** Operational journal for observations. It is rebuildable and never owns workflow state. */
export class SqliteObservationStore implements ObservationStore, ObservationLayoutStore {
  readonly #database: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    initializeSqliteDatabase(this.#database, `
      CREATE TABLE IF NOT EXISTS observation_events (
        event_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        run_sequence INTEGER NOT NULL,
        producer_component TEXT NOT NULL,
        producer_process_instance_id TEXT NOT NULL,
        producer_pid INTEGER,
        producer_sequence INTEGER NOT NULL,
        occurred_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        identity_json TEXT NOT NULL,
        source TEXT NOT NULL,
        channel TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        delivery_json TEXT NOT NULL,
        security_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS observation_events_scope_sequence
        ON observation_events(scope_key, run_sequence);
      CREATE INDEX IF NOT EXISTS observation_events_identity_run
        ON observation_events(json_extract(identity_json, '$.forgeRunId'), run_sequence);
      CREATE INDEX IF NOT EXISTS observation_events_kind
        ON observation_events(kind, occurred_at);
      CREATE TABLE IF NOT EXISTS observation_output_chunks (
        event_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        chunk_sequence INTEGER NOT NULL,
        text TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES observation_events(event_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS observation_output_scope_sequence
        ON observation_output_chunks(scope_key, chunk_sequence);
      CREATE TABLE IF NOT EXISTS observation_attention (
        attention_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        event_id TEXT NOT NULL,
        level TEXT NOT NULL,
        reason TEXT NOT NULL,
        decision_id TEXT,
        resolved_at TEXT,
        FOREIGN KEY (event_id) REFERENCES observation_events(event_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS observation_attention_open
        ON observation_attention(scope_key, resolved_at);
      CREATE TABLE IF NOT EXISTS observation_retention (
        scope_key TEXT PRIMARY KEY,
        max_age_ms INTEGER,
        max_events INTEGER,
        max_output_bytes INTEGER,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observation_layouts (
        layout_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        panes_json TEXT NOT NULL,
        focused_pane_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  async append(input: ObservationDraft): Promise<ObservationEnvelopeV1> {
    const draft = normalizeObservationDraft(input);
    const scopeKey = observationScopeKey(draft.identity ?? {});
    const eventId = randomUUID();
    const occurredAt = draft.occurredAt ?? new Date().toISOString();
    const ingestedAt = new Date().toISOString();

    return this.withTransaction(() => {
      const runSequence = this.nextInteger(
        "SELECT COALESCE(MAX(run_sequence), 0) + 1 AS value FROM observation_events WHERE scope_key = ?",
        scopeKey,
      );
      const producerSequence = draft.producerSequence ?? this.nextInteger(
        "SELECT COALESCE(MAX(producer_sequence), 0) + 1 AS value FROM observation_events WHERE producer_process_instance_id = ?",
        draft.producer.processInstanceId,
      );
      const delivery = draft.delivery ?? {};
      const security = {
        redacted: draft.security?.redacted === true,
        ...(draft.security?.sensitivity ? { sensitivity: draft.security.sensitivity } : {}),
      };
      const envelope: ObservationEnvelopeV1 = {
        schemaVersion: OBSERVATION_SCHEMA_VERSION,
        eventId,
        runSequence,
        producerSequence,
        occurredAt,
        ingestedAt,
        identity: { ...(draft.identity ?? {}) },
        producer: { ...draft.producer },
        source: draft.source,
        channel: draft.channel,
        kind: draft.kind,
        severity: draft.severity ?? "info",
        payload: draft.payload ?? {},
        delivery: { ...delivery },
        security,
        ...(draft.output ? {
          output: {
            channel: draft.output.channel,
            text: draft.output.text,
            chunkSequence: draft.output.chunkSequence ?? runSequence,
            bytes: Buffer.byteLength(draft.output.text, "utf8"),
          },
        } : {}),
      };
      this.#database.prepare(`
        INSERT INTO observation_events (
          event_id, scope_key, run_sequence, producer_component,
          producer_process_instance_id, producer_pid, producer_sequence,
          occurred_at, ingested_at, identity_json, source, channel, kind,
          severity, payload_json, delivery_json, security_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        envelope.eventId,
        scopeKey,
        envelope.runSequence,
        envelope.producer.component,
        envelope.producer.processInstanceId,
        envelope.producer.pid ?? null,
        envelope.producerSequence,
        envelope.occurredAt,
        envelope.ingestedAt,
        JSON.stringify(envelope.identity),
        envelope.source,
        envelope.channel,
        envelope.kind,
        envelope.severity,
        JSON.stringify(envelope.payload),
        JSON.stringify(envelope.delivery),
        JSON.stringify(envelope.security),
      );
      if (envelope.output) {
        this.#database.prepare(`
          INSERT INTO observation_output_chunks (event_id, scope_key, channel, chunk_sequence, text, bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          envelope.eventId,
          scopeKey,
          envelope.output.channel,
          envelope.output.chunkSequence,
          envelope.output.text,
          envelope.output.bytes,
          envelope.ingestedAt,
        );
      }
      this.updateAttention(envelope, scopeKey);
      return envelope;
    });
  }

  async query(query: ObservationQuery = {}): Promise<ObservationEnvelopeV1[]> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (query.scopeKey) { clauses.push("e.scope_key = ?"); params.push(query.scopeKey); }
    if (query.forgeRunId) { clauses.push("json_extract(e.identity_json, '$.forgeRunId') = ?"); params.push(query.forgeRunId); }
    if (query.orchestrationId) { clauses.push("json_extract(e.identity_json, '$.orchestrationId') = ?"); params.push(query.orchestrationId); }
    if (query.source) { clauses.push("e.source = ?"); params.push(query.source); }
    if (query.channel) { clauses.push("e.channel = ?"); params.push(query.channel); }
    if (query.kinds?.length) {
      clauses.push(`e.kind IN (${query.kinds.map(() => "?").join(", ")})`);
      params.push(...query.kinds);
    }
    if (query.sinceRunSequence !== undefined) { clauses.push("e.run_sequence > ?"); params.push(query.sinceRunSequence); }
    const limit = Math.min(MAX_QUERY_LIMIT, Math.max(1, query.limit ?? DEFAULT_QUERY_LIMIT));
    const direction = query.newestFirst ? "DESC" : "ASC";
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.#database.prepare(`
      SELECT e.*, o.channel AS output_channel, o.chunk_sequence AS output_sequence, o.text AS output_text, o.bytes AS output_bytes
      FROM observation_events e
      LEFT JOIN observation_output_chunks o ON o.event_id = e.event_id
      ${where}
      ORDER BY e.run_sequence ${direction}, e.ingested_at ${direction}
      LIMIT ?
    `).all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => decodeEnvelope(row));
  }

  async saveLayout(layout: WorkspaceLayout): Promise<void> {
    this.#database.prepare(`
      INSERT INTO observation_layouts (layout_id, name, panes_json, focused_pane_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(layout_id) DO UPDATE SET
        name = excluded.name,
        panes_json = excluded.panes_json,
        focused_pane_id = excluded.focused_pane_id,
        updated_at = excluded.updated_at
    `).run(layout.id, layout.name, JSON.stringify(layout.panes), layout.focusedPaneId, layout.updatedAt);
  }

  async loadLayout(id: string): Promise<WorkspaceLayout | undefined> {
    const row = this.#database.prepare(`
      SELECT layout_id, name, panes_json, focused_pane_id, updated_at
      FROM observation_layouts WHERE layout_id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.layout_id),
      name: String(row.name),
      panes: parseJson(row.panes_json, [] as WorkspaceLayout["panes"]),
      focusedPaneId: String(row.focused_pane_id),
      updatedAt: String(row.updated_at),
    };
  }

  async prune(scopeKey: string | undefined, policy: ObservationRetentionPolicy): Promise<ObservationRetentionResult> {
    return this.withTransaction(() => {
      const scopes = scopeKey ? [scopeKey] : (this.#database.prepare("SELECT DISTINCT scope_key FROM observation_events").all() as Array<{ scope_key: string }>).map((row) => row.scope_key);
      let deletedEvents = 0;
      let deletedOutputChunks = 0;
      for (const scope of scopes) {
        const maxAge = policy.maxAgeMs !== undefined ? Date.now() - policy.maxAgeMs : undefined;
        if (maxAge !== undefined) {
          const oldIds = this.#database.prepare("SELECT event_id FROM observation_events WHERE scope_key = ? AND ingested_at < ?").all(scope, new Date(maxAge).toISOString()) as Array<{ event_id: string }>;
          deletedOutputChunks += this.deleteOutputChunks(oldIds.map((row) => row.event_id));
          deletedEvents += this.deleteEvents(oldIds.map((row) => row.event_id));
        }
        if (policy.maxEventsPerScope !== undefined) {
          const excess = this.#database.prepare(`
            SELECT event_id FROM observation_events
            WHERE scope_key = ? ORDER BY run_sequence DESC LIMIT -1 OFFSET ?
          `).all(scope, Math.max(0, policy.maxEventsPerScope)) as Array<{ event_id: string }>;
          deletedOutputChunks += this.deleteOutputChunks(excess.map((row) => row.event_id));
          deletedEvents += this.deleteEvents(excess.map((row) => row.event_id));
        }
        if (policy.maxOutputBytesPerScope !== undefined) {
          const chunks = this.#database.prepare(`
            SELECT event_id, bytes FROM observation_output_chunks
            WHERE scope_key = ? ORDER BY chunk_sequence DESC
          `).all(scope) as Array<{ event_id: string; bytes: number }>;
          let total = 0;
          const excessIds: string[] = [];
          for (const chunk of chunks) {
            if (total + chunk.bytes <= policy.maxOutputBytesPerScope) total += chunk.bytes;
            else excessIds.push(chunk.event_id);
          }
          deletedOutputChunks += this.deleteOutputChunks(excessIds);
          deletedEvents += this.deleteEvents(excessIds);
        }
      }
      const remainingEvents = Number((this.#database.prepare("SELECT COUNT(*) AS value FROM observation_events").get() as { value: number }).value);
      return { deletedEvents, deletedOutputChunks, remainingEvents };
    });
  }

  close(): void {
    this.#database.close();
  }

  private updateAttention(envelope: ObservationEnvelopeV1, scopeKey: string): void {
    if (envelope.kind === "attention.created") {
      const payload = asRecord(envelope.payload);
      const attentionId = typeof payload?.attentionId === "string" ? payload.attentionId : envelope.eventId;
      const level = typeof payload?.level === "string" ? payload.level : "action-required";
      const reason = typeof payload?.reason === "string" ? payload.reason : "Attention required";
      const decisionId = typeof payload?.decisionId === "string" ? payload.decisionId : null;
      this.#database.prepare(`
        INSERT INTO observation_attention (attention_id, scope_key, event_id, level, reason, decision_id, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(attention_id) DO UPDATE SET level = excluded.level, reason = excluded.reason, decision_id = excluded.decision_id, resolved_at = NULL
      `).run(attentionId, scopeKey, envelope.eventId, level, reason, decisionId);
    } else if (envelope.kind === "attention.resolved") {
      const payload = asRecord(envelope.payload);
      if (typeof payload?.attentionId === "string") {
        this.#database.prepare("UPDATE observation_attention SET resolved_at = ? WHERE attention_id = ? AND scope_key = ?").run(envelope.ingestedAt, payload.attentionId, scopeKey);
      }
    }
  }

  private deleteEvents(ids: readonly string[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    return Number(this.#database.prepare(`DELETE FROM observation_events WHERE event_id IN (${placeholders})`).run(...ids).changes ?? 0);
  }

  private deleteOutputChunks(ids: readonly string[]): number {
    if (!ids.length) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    return Number(this.#database.prepare(`DELETE FROM observation_output_chunks WHERE event_id IN (${placeholders})`).run(...ids).changes ?? 0);
  }

  private nextInteger(sql: string, value: string): number {
    return Number((this.#database.prepare(sql).get(value) as { value: number }).value);
  }

  private withTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
  }
}

function decodeEnvelope(row: Record<string, unknown>): ObservationEnvelopeV1 {
  const identity = parseJson(row.identity_json, {});
  const producer: ObservationEnvelopeV1["producer"] = {
    component: String(row.producer_component),
    processInstanceId: String(row.producer_process_instance_id),
    ...(row.producer_pid !== null && row.producer_pid !== undefined ? { pid: Number(row.producer_pid) } : {}),
  };
  const outputText = row.output_text;
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    eventId: String(row.event_id),
    runSequence: Number(row.run_sequence),
    producerSequence: Number(row.producer_sequence),
    occurredAt: String(row.occurred_at),
    ingestedAt: String(row.ingested_at),
    identity: identity as ObservationEnvelopeV1["identity"],
    producer,
    source: String(row.source) as ObservationEnvelopeV1["source"],
    channel: String(row.channel) as ObservationEnvelopeV1["channel"],
    kind: String(row.kind),
    severity: String(row.severity) as ObservationEnvelopeV1["severity"],
    payload: parseJson(row.payload_json, {}),
    delivery: parseJson(row.delivery_json, {}),
    security: parseJson(row.security_json, { redacted: false }),
    ...(typeof outputText === "string" ? {
      output: {
        channel: String(row.output_channel) as "stdout" | "stderr",
        text: outputText,
        chunkSequence: Number(row.output_sequence),
        bytes: Number(row.output_bytes),
      },
    } : {}),
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
