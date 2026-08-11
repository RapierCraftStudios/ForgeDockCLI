// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ArtifactKind, DurableArtifact, Subject } from "../artifacts/schema.js";
import type { RunState, TransitionRecord } from "../state/machine.js";
import type { IssueSnapshot } from "./forge-host.js";

export interface RemediationAdmissionKey {
  repo: string;
  parentIssue: number;
  parentPullRequest: number;
  headSha: string;
  marker: string;
}

export type RemediationAdmissionClaim =
  | { status: "claimed" }
  | { status: "pending" }
  | { status: "materialized"; snapshot: IssueSnapshot };

/** Durable, fail-closed admission for one deterministic remediation marker. */
export interface RemediationAdmissionRepository {
  claim(key: RemediationAdmissionKey): Promise<RemediationAdmissionClaim>;
  complete(key: RemediationAdmissionKey, snapshot: IssueSnapshot): Promise<void>;
}

export interface ArtifactRepository {
  append(artifact: DurableArtifact): Promise<void>;
  list(subject: Subject, kind?: ArtifactKind): Promise<DurableArtifact[]>;
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

  async list(subject: Subject, kind?: ArtifactKind): Promise<DurableArtifact[]> {
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

export class InMemoryRemediationAdmissionRepository implements RemediationAdmissionRepository {
  readonly records = new Map<string, { status: "pending" | "materialized"; snapshot?: IssueSnapshot }>();

  async claim(key: RemediationAdmissionKey): Promise<RemediationAdmissionClaim> {
    const admissionKey = remediationAdmissionKey(key);
    const existing = this.records.get(admissionKey);
    if (existing?.status === "materialized" && existing.snapshot) {
      return { status: "materialized", snapshot: structuredClone(existing.snapshot) };
    }
    if (existing) return { status: "pending" };
    this.records.set(admissionKey, { status: "pending" });
    return { status: "claimed" };
  }

  async complete(key: RemediationAdmissionKey, snapshot: IssueSnapshot): Promise<void> {
    const admissionKey = remediationAdmissionKey(key);
    if (!this.records.has(admissionKey)) throw new Error(`Unknown remediation admission: ${admissionKey}`);
    this.records.set(admissionKey, { status: "materialized", snapshot: structuredClone(snapshot) });
  }
}

export class InMemoryArtifactRepository implements ArtifactRepository {
  readonly artifacts: DurableArtifact[] = [];

  async append(artifact: DurableArtifact): Promise<void> {
    if (this.artifacts.some((item) => item.id === artifact.id)) return;
    this.artifacts.push(structuredClone(artifact));
  }

  async list(subject: Subject, kind?: ArtifactKind): Promise<DurableArtifact[]> {
    return this.artifacts
      .filter((artifact) => sameSubject(artifact.subject, subject) && (!kind || artifact.kind === kind))
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

function sameSubject(left: Subject, right: Subject): boolean {
  return left.repo === right.repo && left.issue === right.issue && left.pr === right.pr;
}

export function remediationAdmissionKey(key: RemediationAdmissionKey): string {
  return [
    key.repo.trim().toLowerCase(),
    `issue:${key.parentIssue}`,
    `pr:${key.parentPullRequest}`,
    `sha:${key.headSha.trim().toLowerCase()}`,
    `marker:${key.marker.trim()}`,
  ].join("|");
}
