// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ArtifactKind, Subject } from "../artifacts/schema.js";

export type Workflow = "work-on" | "review-pr" | "orchestrate";
export type RunStateName =
  | "queued"
  | "investigating"
  | "preparing"
  | "building"
  | "verifying"
  | "publishing"
  | "target_recovery"
  | "retry_wait"
  | "reviewing"
  | "remediating"
  | "merging"
  | "closing"
  | "completed"
  | "invalid"
  | "decomposed"
  | "blocked"
  | "failed"
  | "cancelled";

export type TransitionEvent =
  | "START_INVESTIGATION"
  | "RESUME_INVESTIGATION"
  | "INVESTIGATION_CONFIRMED"
  | "INVESTIGATION_INVALID"
  | "INVESTIGATION_DECOMPOSED"
  | "BUILD_PACKET_READY"
  | "RESUME_PREPARATION"
  | "BUILD_COMPLETED"
  | "RESUME_BUILD"
  | "VERIFICATION_PASSED"
  | "VERIFICATION_FAILED"
  | "VERIFICATION_REPAIR_REQUESTED"
  | "VERIFICATION_REPAIR_EXHAUSTED"
  | "RESUME_VERIFICATION"
  | "RESUME_REVIEW"
  | "RESUME_EXPANDED_REVIEW"
  | "RESUME_REMEDIATION"
  | "RESUME_COMPLETION"
  | "RESUME_CONFLICT_RECOVERY"
  | "RESUME_PUBLICATION"
  | "TARGET_ADVANCE_DETECTED"
  | "TARGET_RECOVERY_REQUESTED"
  | "RESUME_TARGET_ADVANCE"
  | "TARGET_RECOVERY_RESUMED"
  | "TARGET_ADVANCE_COMPLETED"
  | "RETRY_WAIT_STARTED"
  | "RETRY_WAIT_SCHEDULED"
  | "RESUME_RETRY_WAIT"
  | "RETRY_WAIT_EXPIRED"
  | "RETRY_DUE"
  | "RECOVER_REVISION_PUBLICATION"
  | "PR_PUBLISHED"
  | "REVIEW_APPROVED"
  | "REVIEW_CHANGES_REQUESTED"
  | "REVIEW_BLOCKED"
  | "REMEDIATION_COMPLETED"
  | "MERGE_COMPLETED"
  | "CLOSE_COMPLETED"
  | "BLOCK"
  | "FAIL"
  | "CANCEL";

export interface RunTarget {
  lane: "fast" | "feature";
  targetBranch: string;
  /** Integration target for a feature-lane delivery; never an implicit merge target. */
  promotionTarget?: string;
  /** Protected production target; reached only through a separate promotion workflow. */
  productionTarget?: string;
  milestone?: { number: number; title: string };
}

export interface PersistedScopeManifest {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  writePaths?: readonly string[];
  source: "issue-hints" | "build-packet" | "remediation";
}

export interface RunState {
  schema: "forgedock.run/v1";
  runId: string;
  workflow: Workflow;
  subject: Subject;
  state: RunStateName;
  lane?: RunTarget["lane"];
  targetBranch?: string;
  promotionTarget?: RunTarget["promotionTarget"];
  productionTarget?: RunTarget["productionTarget"];
  milestone?: RunTarget["milestone"];
  scopeManifest?: PersistedScopeManifest;
  attempt: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  headSha?: string;
  artifactIds: Partial<Record<ArtifactKind, string[]>>;
  blockedReason?: string;
  failure?: string;
}

export interface TransitionRecord {
  runId: string;
  sequence: number;
  event: TransitionEvent;
  from: RunStateName;
  to: RunStateName;
  occurredAt: string;
  reason?: string;
}

const transitions: Readonly<Record<RunStateName, Partial<Record<TransitionEvent, RunStateName>>>> = {
  queued: { START_INVESTIGATION: "investigating", BLOCK: "blocked", FAIL: "failed", CANCEL: "cancelled" },
  investigating: {
    RESUME_INVESTIGATION: "investigating",
    INVESTIGATION_CONFIRMED: "preparing",
    INVESTIGATION_INVALID: "invalid",
    INVESTIGATION_DECOMPOSED: "decomposed",
    BLOCK: "blocked",
    FAIL: "failed",
    CANCEL: "cancelled",
  },
  preparing: { RESUME_PREPARATION: "preparing", BUILD_PACKET_READY: "building", BLOCK: "blocked", FAIL: "failed", CANCEL: "cancelled" },
  building: { BUILD_COMPLETED: "verifying", RESUME_BUILD: "building", BLOCK: "blocked", FAIL: "failed", CANCEL: "cancelled" },
  verifying: {
    VERIFICATION_PASSED: "publishing",
    VERIFICATION_FAILED: "blocked",
    TARGET_ADVANCE_DETECTED: "target_recovery",
    VERIFICATION_REPAIR_REQUESTED: "building",
    BLOCK: "blocked",
    FAIL: "failed",
    CANCEL: "cancelled",
  },
  publishing: { RESUME_PUBLICATION: "publishing", TARGET_ADVANCE_DETECTED: "target_recovery", TARGET_RECOVERY_REQUESTED: "target_recovery", PR_PUBLISHED: "reviewing", BLOCK: "blocked", FAIL: "failed", CANCEL: "cancelled" },
  target_recovery: {
    RESUME_TARGET_ADVANCE: "target_recovery", TARGET_RECOVERY_RESUMED: "target_recovery", TARGET_ADVANCE_COMPLETED: "publishing",
    RETRY_WAIT_STARTED: "retry_wait", RETRY_WAIT_SCHEDULED: "retry_wait", BLOCK: "blocked", FAIL: "failed", CANCEL: "cancelled",
  },
  retry_wait: {
    RESUME_RETRY_WAIT: "retry_wait", RETRY_WAIT_EXPIRED: "target_recovery", RETRY_DUE: "target_recovery",
    BLOCK: "blocked", FAIL: "failed", CANCEL: "cancelled",
  },
  reviewing: {
    REVIEW_APPROVED: "merging",
    REVIEW_CHANGES_REQUESTED: "remediating",
    REVIEW_BLOCKED: "blocked",
    BLOCK: "blocked",
    FAIL: "failed",
    CANCEL: "cancelled",
  },
  remediating: { RESUME_REMEDIATION: "remediating", REMEDIATION_COMPLETED: "verifying", BLOCK: "blocked", FAIL: "failed", CANCEL: "cancelled" },
  merging: { RESUME_COMPLETION: "merging", TARGET_ADVANCE_DETECTED: "target_recovery", MERGE_COMPLETED: "closing", BLOCK: "blocked", FAIL: "failed", CANCEL: "cancelled" },
  closing: { CLOSE_COMPLETED: "completed", BLOCK: "blocked", FAIL: "failed", CANCEL: "cancelled" },
  completed: {},
  invalid: {},
  decomposed: {},
  blocked: {
    VERIFICATION_REPAIR_REQUESTED: "building",
    VERIFICATION_REPAIR_EXHAUSTED: "blocked",
    RESUME_VERIFICATION: "verifying",
    RESUME_REVIEW: "reviewing",
    RESUME_EXPANDED_REVIEW: "reviewing",
    // Conflict recovery is a distinct admission boundary. Ordinary resume
    // must never turn a stale approved head into an implicit rebase/merge.
    RESUME_CONFLICT_RECOVERY: "verifying",
  },
  // A failed revision publication may be recovered only through the distinct
  // proof-checked controller path; ordinary publication resume is insufficient.
  failed: { RECOVER_REVISION_PUBLICATION: "publishing" },
  cancelled: {},
};

export const terminalStates = new Set<RunStateName>([
  "completed", "invalid", "decomposed", "blocked", "failed", "cancelled",
]);

export function createRun(input: {
  workflow: Workflow;
  subject: Subject;
  runId?: string;
  now?: string;
  target?: RunTarget;
  scopeManifest?: PersistedScopeManifest;
}): RunState {
  const now = input.now ?? new Date().toISOString();
  if (input.target && !input.target.targetBranch.trim()) throw new Error("Run target branch is required");
  if (input.target?.promotionTarget !== undefined && !input.target.promotionTarget.trim()) throw new Error("Run promotion target must not be blank");
  if (input.target?.productionTarget !== undefined && !input.target.productionTarget.trim()) throw new Error("Run production target must not be blank");
  if (input.target?.lane === "feature" && !input.target.milestone) throw new Error("Feature-lane runs require milestone identity");
  return {
    schema: "forgedock.run/v1",
    runId: input.runId ?? `run_${crypto.randomUUID()}`,
    workflow: input.workflow,
    subject: input.subject,
    state: input.workflow === "review-pr" ? "reviewing" : "queued",
    ...(input.target ? {
      lane: input.target.lane,
      targetBranch: input.target.targetBranch,
      ...(input.target.promotionTarget !== undefined ? { promotionTarget: input.target.promotionTarget } : {}),
      ...(input.target.productionTarget !== undefined ? { productionTarget: input.target.productionTarget } : {}),
      ...(input.target.milestone ? { milestone: input.target.milestone } : {}),
    } : {}),
    ...(input.scopeManifest ? { scopeManifest: input.scopeManifest } : {}),
    attempt: 1,
    version: 0,
    createdAt: now,
    updatedAt: now,
    artifactIds: {},
  };
}

export function canTransition(state: RunState, event: TransitionEvent): boolean {
  return transitions[state.state][event] !== undefined;
}

export function transition(
  state: RunState,
  event: TransitionEvent,
  options: { now?: string; reason?: string; headSha?: string; scopeManifest?: PersistedScopeManifest } = {},
): { state: RunState; record: TransitionRecord } {
  if (options.scopeManifest !== undefined && event !== "BUILD_PACKET_READY") {
    throw new Error(`Scope authority can be replaced only when the Build Packet freezes, not during ${event}`);
  }
  const next = transitions[state.state][event];
  if (!next) throw new InvalidTransitionError(state.state, event);
  const now = options.now ?? new Date().toISOString();
  const nextState: RunState = {
    ...state,
    state: next,
    version: state.version + 1,
    updatedAt: now,
  };
  if (options.headSha !== undefined) nextState.headSha = options.headSha;
  if (options.scopeManifest !== undefined) nextState.scopeManifest = options.scopeManifest;
if (event === "RESUME_INVESTIGATION" || event === "RESUME_PREPARATION" || event === "RESUME_VERIFICATION" || event === "RESUME_REVIEW" || event === "RESUME_EXPANDED_REVIEW" || event === "RESUME_REMEDIATION" || event === "RESUME_COMPLETION" || event === "RESUME_CONFLICT_RECOVERY" || event === "RESUME_BUILD" || event === "RESUME_PUBLICATION" || event === "RESUME_TARGET_ADVANCE" || event === "TARGET_RECOVERY_RESUMED" || event === "RETRY_DUE" || event === "RETRY_WAIT_EXPIRED" || event === "RECOVER_REVISION_PUBLICATION" || event === "VERIFICATION_REPAIR_REQUESTED") {
    nextState.attempt = state.attempt + 1;
    delete nextState.blockedReason;
  }
  if (next === "blocked" && options.reason !== undefined) nextState.blockedReason = options.reason;
  if (next === "failed" && options.reason !== undefined) nextState.failure = options.reason;
  return {
    state: nextState,
    record: {
      runId: state.runId,
      sequence: nextState.version,
      event,
      from: state.state,
      to: next,
      occurredAt: now,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
    },
  };
}

export function attachArtifact(state: RunState, kind: ArtifactKind, artifactId: string): RunState {
  const existing = state.artifactIds[kind] ?? [];
  if (existing.includes(artifactId)) return state;
  return {
    ...state,
    artifactIds: { ...state.artifactIds, [kind]: [...existing, artifactId] },
  };
}

export class InvalidTransitionError extends Error {
  constructor(readonly from: RunStateName, readonly event: TransitionEvent) {
    super(`Cannot apply ${event} while run is ${from}`);
    this.name = "InvalidTransitionError";
  }
}
