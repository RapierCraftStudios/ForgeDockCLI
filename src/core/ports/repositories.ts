// SPDX-License-Identifier: AGPL-3.0-or-later

import { normalizeArtifact, normalizeSubject, type ArtifactKind, type DurableArtifact, type SubjectInput } from "../artifacts/schema.js";
import type { RunState, TransitionRecord } from "../state/machine.js";

export interface ArtifactRepository {
  append(artifact: DurableArtifact): Promise<void>;
  list(subject: SubjectInput, kind?: ArtifactKind): Promise<DurableArtifact[]>;
}

export interface RunRepository {
  create(state: RunState): Promise<void>;
  load(runId: string): Promise<RunState | undefined>;
  commit(expectedVersion: number, state: RunState, record: TransitionRecord): Promise<void>;
  history(runId: string): Promise<TransitionRecord[]>;
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
    const canonical = canonicalRunState(state);
    await this.inner.create(canonical);
    await this.tryProject(canonical);
  }

  load(runId: string): Promise<RunState | undefined> { return this.inner.load(runId); }

  async commit(expectedVersion: number, state: RunState, record: TransitionRecord): Promise<void> {
    const canonical = canonicalRunState(state);
    await this.inner.commit(expectedVersion, canonical, record);
    await this.tryProject(canonical);
  }

  history(runId: string): Promise<TransitionRecord[]> { return this.inner.history(runId); }

  private async tryProject(state: RunState): Promise<void> {
    try { await this.project(structuredClone(state)); }
    catch (error) { this.onProjectionError(error, structuredClone(state)); }
  }
}

export class InMemoryArtifactRepository implements ArtifactRepository {
  readonly artifacts: DurableArtifact[] = [];

  async append(artifact: DurableArtifact): Promise<void> {
    const canonical = normalizeArtifact(artifact);
    if (this.artifacts.some((item) => item.id === canonical.id)) return;
    this.artifacts.push(structuredClone(canonical));
  }

  async list(subject: SubjectInput, kind?: ArtifactKind): Promise<DurableArtifact[]> {
    const canonical = normalizeSubject(subject);
    return this.artifacts
      .filter((artifact) => subjectMatches(artifact.subject, canonical) && (!kind || artifact.kind === kind))
      .map((artifact) => structuredClone(normalizeArtifact(artifact)));
  }
}

export class InMemoryRunRepository implements RunRepository {
  readonly runs = new Map<string, RunState>();
  readonly records = new Map<string, TransitionRecord[]>();

  async create(state: RunState): Promise<void> {
    const canonical = canonicalRunState(state);
    if (this.runs.has(canonical.runId)) throw new Error(`Run already exists: ${canonical.runId}`);
    this.runs.set(canonical.runId, structuredClone(canonical));
    this.records.set(canonical.runId, []);
  }

  async load(runId: string): Promise<RunState | undefined> {
    const state = this.runs.get(runId);
    return state ? structuredClone(canonicalRunState(state)) : undefined;
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
    const canonical = canonicalRunState(state);
    this.runs.set(canonical.runId, structuredClone(canonical));
    this.records.get(canonical.runId)?.push(structuredClone(record));
  }

  async history(runId: string): Promise<TransitionRecord[]> {
    return (this.records.get(runId) ?? []).map((record) => structuredClone(record));
  }
}

function canonicalRunState(state: RunState): RunState {
  return { ...state, subject: normalizeSubject(state.subject) };
}

export class ConcurrentRunUpdateError extends Error {
  constructor(readonly runId: string, readonly expected: number, readonly actual: number) {
    super(`Run ${runId} changed concurrently (expected v${expected}, found v${actual})`);
    this.name = "ConcurrentRunUpdateError";
  }
}

function subjectMatches(left: SubjectInput, right: SubjectInput): boolean {
  const artifact = normalizeSubject(left);
  const query = normalizeSubject(right);
  if (artifact.forge !== query.forge || artifact.repo !== query.repo) return false;
  return (query.issue !== undefined && artifact.issue === query.issue)
    || (query.pr !== undefined && artifact.pr === query.pr);
}
