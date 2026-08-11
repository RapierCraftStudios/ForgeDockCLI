// SPDX-License-Identifier: AGPL-3.0-or-later

import { migrateArtifact, normalizeSubject, subjectsMatch, type ArtifactKind, type DurableArtifact, type SubjectInput } from "../artifacts/schema.js";
import type { RunState, TransitionRecord } from "../state/machine.js";

export interface ArtifactRepository {
  append(artifact: DurableArtifact): Promise<void>;
  list(subject: SubjectInput, kind?: ArtifactKind): Promise<DurableArtifact[]>;
}

export interface RunProgressRecord {
  runId: string;
  phase: string;
  message: string;
  occurredAt: string;
}

export interface RunRepository {
  create(state: RunState): Promise<void>;
  load(runId: string): Promise<RunState | undefined>;
  commit(expectedVersion: number, state: RunState, record: TransitionRecord): Promise<void>;
  history(runId: string): Promise<TransitionRecord[]>;
  recordProgress(progress: RunProgressRecord): Promise<void>;
  listProgress(runId: string): Promise<RunProgressRecord[]>;
}

/** Writes authoritative storage first, then refreshes the rebuildable cache. */
export class CachedArtifactRepository implements ArtifactRepository {
  constructor(readonly authoritative: ArtifactRepository, readonly cache: ArtifactRepository) {}

  async append(artifact: DurableArtifact): Promise<void> {
    await this.authoritative.append(artifact);
    await this.cache.append(artifact);
  }

  async list(subject: SubjectInput, kind?: ArtifactKind): Promise<DurableArtifact[]> {
    const artifacts = await this.authoritative.list(subject, kind);
    for (const artifact of artifacts) await this.cache.append(artifact);
    return artifacts;
  }
}

/** Mirrors committed operational state into a rebuildable external view such as GitHub labels. */
export class ProjectedRunRepository implements RunRepository {
  constructor(
    readonly inner: RunRepository,
    readonly project: (state: RunState) => Promise<void>,
    readonly onProjectionError: (error: unknown, state: RunState) => void = () => undefined,
  ) {}

  async create(state: RunState): Promise<void> {
    await this.inner.create(state);
    await this.tryProject(state);
  }

  load(runId: string): Promise<RunState | undefined> { return this.inner.load(runId); }

  async commit(expectedVersion: number, state: RunState, record: TransitionRecord): Promise<void> {
    await this.inner.commit(expectedVersion, state, record);
    await this.tryProject(state);
  }

  history(runId: string): Promise<TransitionRecord[]> { return this.inner.history(runId); }
  recordProgress(progress: RunProgressRecord): Promise<void> { return this.inner.recordProgress(progress); }
  listProgress(runId: string): Promise<RunProgressRecord[]> { return this.inner.listProgress(runId); }

  private async tryProject(state: RunState): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.project(structuredClone(state));
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    this.onProjectionError(lastError, structuredClone(state));
  }
}

export class InMemoryArtifactRepository implements ArtifactRepository {
  readonly artifacts: DurableArtifact[] = [];

  async append(artifact: DurableArtifact): Promise<void> {
    const canonical = migrateArtifact(artifact);
    if (this.artifacts.some((item) => item.id === canonical.id)) return;
    this.artifacts.push(structuredClone(canonical));
  }

  async list(subject: SubjectInput, kind?: ArtifactKind): Promise<DurableArtifact[]> {
    const canonical = normalizeSubject(subject);
    return this.artifacts
      .filter((artifact) => subjectsMatch(artifact.subject, canonical) && (!kind || artifact.kind === kind))
      .map((artifact) => structuredClone(artifact));
  }
}

export class InMemoryRunRepository implements RunRepository {
  readonly runs = new Map<string, RunState>();
  readonly records = new Map<string, TransitionRecord[]>();
  readonly progress = new Map<string, RunProgressRecord[]>();

  async create(state: RunState): Promise<void> {
    if (this.runs.has(state.runId)) throw new Error(`Run already exists: ${state.runId}`);
    this.runs.set(state.runId, structuredClone(state));
    this.records.set(state.runId, []);
    this.progress.set(state.runId, []);
  }

  async load(runId: string): Promise<RunState | undefined> {
    const state = this.runs.get(runId);
    return state ? structuredClone(state) : undefined;
  }

  async commit(expectedVersion: number, state: RunState, record: TransitionRecord): Promise<void> {
    const current = this.runs.get(state.runId);
    if (!current) throw new Error(`Unknown run: ${state.runId}`);
    if (current.version !== expectedVersion) {
      throw new ConcurrentRunUpdateError(state.runId, expectedVersion, current.version);
    }
    if (state.version !== expectedVersion + 1 || record.sequence !== state.version) {
      throw new Error("Run commit must advance exactly one version");
    }
    this.runs.set(state.runId, structuredClone(state));
    this.records.get(state.runId)?.push(structuredClone(record));
  }

  async history(runId: string): Promise<TransitionRecord[]> {
    return (this.records.get(runId) ?? []).map((record) => structuredClone(record));
  }

  async recordProgress(progress: RunProgressRecord): Promise<void> {
    if (!this.runs.has(progress.runId)) throw new Error(`Unknown run: ${progress.runId}`);
    this.progress.get(progress.runId)?.push(structuredClone(progress));
  }

  async listProgress(runId: string): Promise<RunProgressRecord[]> {
    return (this.progress.get(runId) ?? []).map((record) => structuredClone(record));
  }
}

export class ConcurrentRunUpdateError extends Error {
  constructor(readonly runId: string, readonly expected: number, readonly actual: number) {
    super(`Run ${runId} changed concurrently (expected v${expected}, found v${actual})`);
    this.name = "ConcurrentRunUpdateError";
  }
}
