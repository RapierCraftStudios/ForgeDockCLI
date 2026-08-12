// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ArtifactKind, DurableArtifact, Subject } from "../artifacts/schema.js";
import type { RunState, TransitionRecord } from "../state/machine.js";
import type { IssueSnapshot } from "./forge-host.js";
import type { LeaseFence } from "./lease.js";
import type { OrchestrationRecord, OrchestrationRepository } from "./orchestration.js";

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
  claim(key: RemediationAdmissionKey, fence?: LeaseFence): Promise<RemediationAdmissionClaim>;
  complete(key: RemediationAdmissionKey, snapshot: IssueSnapshot, fence?: LeaseFence): Promise<void>;
}

export interface RemediationDispatchClaim {
  status: "claimed" | "pending" | "materialized";
  checkpointSequence: number;
  childIssues?: readonly number[];
}

/** Durable single-dispatch admission for a remediation checkpoint. */
export interface RemediationDispatchRepository {
  claimDispatch(checkpointKey: string, checkpointSequence: number, fence?: LeaseFence): Promise<RemediationDispatchClaim>;
  completeDispatch(checkpointKey: string, childIssues: readonly number[], fence?: LeaseFence): Promise<void>;
  abandonDispatch(checkpointKey: string, fence?: LeaseFence): Promise<void>;
}

export interface ArtifactRepository {
  append(artifact: DurableArtifact): Promise<void>;
  /** Fenced publication is optional for compatibility with non-remediation stores. */
  appendFenced?(artifact: DurableArtifact, fence: LeaseFence): Promise<void>;
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

  async appendFenced(artifact: DurableArtifact, fence: LeaseFence): Promise<void> {
    if (this.authoritative.appendFenced) await this.authoritative.appendFenced(artifact, fence);
    else await this.authoritative.append(artifact);
    if (this.cache.appendFenced) await this.cache.appendFenced(artifact, fence);
    else await this.cache.append(artifact);
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

  async claim(key: RemediationAdmissionKey, _fence?: LeaseFence): Promise<RemediationAdmissionClaim> {
    const admissionKey = remediationAdmissionKey(key);
    const existing = this.records.get(admissionKey);
    if (existing?.status === "materialized" && existing.snapshot) {
      return { status: "materialized", snapshot: structuredClone(existing.snapshot) };
    }
    if (existing) return { status: "pending" };
    this.records.set(admissionKey, { status: "pending" });
    return { status: "claimed" };
  }

  async complete(key: RemediationAdmissionKey, snapshot: IssueSnapshot, _fence?: LeaseFence): Promise<void> {
    const admissionKey = remediationAdmissionKey(key);
    if (!this.records.has(admissionKey)) throw new Error(`Unknown remediation admission: ${admissionKey}`);
    this.records.set(admissionKey, { status: "materialized", snapshot: structuredClone(snapshot) });
  }
}

export class InMemoryRemediationDispatchRepository implements RemediationDispatchRepository {
  readonly records = new Map<string, { status: "pending" | "claimed" | "materialized"; checkpointSequence: number; childIssues?: number[]; fence?: LeaseFence }>();

  async claimDispatch(checkpointKey: string, checkpointSequence: number, fence?: LeaseFence): Promise<RemediationDispatchClaim> {
    const existing = this.records.get(checkpointKey);
    if (!existing) {
      this.records.set(checkpointKey, { status: "claimed", checkpointSequence, ...(fence ? { fence: { ...fence } } : {}) });
      return { status: "claimed", checkpointSequence };
    }
    if (existing.status === "materialized") return { status: "materialized", checkpointSequence: existing.checkpointSequence, childIssues: [...(existing.childIssues ?? [])] };
    if (existing.status === "pending") {
      existing.status = "claimed";
      if (fence) existing.fence = { ...fence };
      else delete existing.fence;
      return { status: "claimed", checkpointSequence: existing.checkpointSequence };
    }
    if (fence && (!existing.fence || existing.fence.token !== fence.token || existing.fence.epoch !== fence.epoch)) {
      existing.fence = { ...fence };
      return { status: "claimed", checkpointSequence: existing.checkpointSequence };
    }
    return { status: "pending", checkpointSequence: existing.checkpointSequence };
  }

  async completeDispatch(checkpointKey: string, childIssues: readonly number[], _fence?: LeaseFence): Promise<void> {
    const existing = this.records.get(checkpointKey);
    if (!existing) throw new Error(`Unknown remediation dispatch: ${checkpointKey}`);
    if (_fence && existing.fence && (existing.fence.token !== _fence.token || existing.fence.epoch !== _fence.epoch)) throw new Error(`Stale remediation dispatch fence: ${checkpointKey}`);
    existing.status = "materialized";
    existing.childIssues = [...childIssues];
  }

  async abandonDispatch(checkpointKey: string, _fence?: LeaseFence): Promise<void> {
    const existing = this.records.get(checkpointKey);
    if (existing?.status === "claimed") existing.status = "pending";
  }
}

export class InMemoryArtifactRepository implements ArtifactRepository {
  readonly artifacts: DurableArtifact[] = [];

  async append(artifact: DurableArtifact): Promise<void> {
    if (this.artifacts.some((item) => item.id === artifact.id)) return;
    this.artifacts.push(structuredClone(artifact));
  }

  async appendFenced(artifact: DurableArtifact, _fence: LeaseFence): Promise<void> {
    await this.append(artifact);
  }

  async list(subject: Subject, kind?: ArtifactKind): Promise<DurableArtifact[]> {
    return this.artifacts
      .filter((artifact) => sameSubject(artifact.subject, subject) && (!kind || artifact.kind === kind))
      .map((artifact) => structuredClone(artifact));
  }
}

export class InMemoryOrchestrationRepository implements OrchestrationRepository {
  readonly records = new Map<string, OrchestrationRecord>();

  async createOrchestration(record: OrchestrationRecord): Promise<void> {
    if (this.records.has(record.orchestrationId)) throw new Error(`Orchestration already exists: ${record.orchestrationId}`);
    this.records.set(record.orchestrationId, structuredClone(record));
  }

  async loadOrchestration(orchestrationId: string): Promise<OrchestrationRecord | undefined> {
    const record = this.records.get(orchestrationId);
    return record ? structuredClone(record) : undefined;
  }

  async saveOrchestration(record: OrchestrationRecord): Promise<void> {
    if (!this.records.has(record.orchestrationId)) throw new Error(`Unknown orchestration: ${record.orchestrationId}`);
    this.records.set(record.orchestrationId, structuredClone(record));
  }

  async listOrchestrations(limit = 50): Promise<OrchestrationRecord[]> {
    return [...this.records.values()].slice(-limit).reverse().map((record) => structuredClone(record));
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
