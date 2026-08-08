// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { ControllerTimingSummary, TelemetrySummary } from "../../core/ports/telemetry.js";
import type { BatchMemberContract } from "../orchestrate/batching.js";

export const TRAJECTORY_OPEN = "<!-- FORGE:TRAJECTORY -->";
export const TRAJECTORY_COMPLETE = "<!-- FORGE:TRAJECTORY:COMPLETE -->";
export const TRAJECTORY_SCHEMA = "forgedock.trajectory/v1";
export const MAX_TRAJECTORY_RECEIPT_CHARS = 48_000;

export interface TrajectoryCriterion {
  criterion: string;
  status: "passed" | "failed";
  evidence: string;
}

export interface TrajectoryReceipt {
  schema: typeof TRAJECTORY_SCHEMA;
  memberIssue: number;
  batchParent?: number;
  memberContract?: BatchMemberContract;
  artifactIds: Partial<Record<"Intent" | "Investigation" | "BuildPacket" | "BuildResult" | "ReviewVerdict" | "Outcome", string>>;
  acceptanceCriteria: TrajectoryCriterion[];
  changedPaths: string[];
  verificationSummary: string;
  pullRequest: { url: string; number: number; finalSha: string; targetBranch: string };
  review: {
    verdictId?: string;
    disposition: string;
    reviewerRoles: string[];
    findingIds: string[];
    sessionRefs: string[];
  };
  disposition: "direct-merge" | "recursive-remediation" | "blocked";
  childIssues: number[];
  childOutcomeIds: string[];
  telemetry?: TelemetrySummary;
  controllerTiming?: ControllerTimingSummary;
  completedAt: string;
  controllerRunId: string;
}

export function trajectoryCommentMarker(input: Pick<TrajectoryReceipt, "memberIssue" | "controllerRunId" | "pullRequest">): string {
  return `<!-- FORGEDOCK:TRAJECTORY ${input.controllerRunId}:${input.memberIssue}:${input.pullRequest.finalSha} -->`;
}

export function renderTrajectoryComment(receipt: TrajectoryReceipt): string {
  validateReceipt(receipt);
  const marker = trajectoryCommentMarker(receipt);
  const json = JSON.stringify(receipt);
  if (json.length > MAX_TRAJECTORY_RECEIPT_CHARS) throw new Error(`Trajectory receipt exceeds ${MAX_TRAJECTORY_RECEIPT_CHARS} characters`);
  return [
    TRAJECTORY_OPEN,
    marker,
    "## ForgeDock Trajectory",
    "",
    `Completed member #${receipt.memberIssue} through ${receipt.disposition} at ${receipt.pullRequest.finalSha}.`,
    "",
    "```json",
    json,
    "```",
    TRAJECTORY_COMPLETE,
  ].join("\n");
}

export function parseTrajectoryComment(body: string): TrajectoryReceipt {
  if (!body.startsWith(TRAJECTORY_OPEN)) throw new Error("Trajectory comment must begin with FORGE:TRAJECTORY");
  if (!body.includes(TRAJECTORY_COMPLETE)) throw new Error("Trajectory comment is missing its completion sentinel");
  const match = /```json\s*([\s\S]*?)\s*```/.exec(body);
  if (!match?.[1]) throw new Error("Trajectory comment is missing its JSON receipt");
  let value: unknown;
  try { value = JSON.parse(match[1]); }
  catch (error) { throw new Error("Trajectory receipt contains invalid JSON", { cause: error }); }
  validateReceipt(value);
  return value;
}

export function validateReceipt(value: unknown): asserts value is TrajectoryReceipt {
  if (!value || typeof value !== "object") throw new Error("Trajectory receipt must be an object");
  const receipt = value as Partial<TrajectoryReceipt>;
  if (receipt.schema !== TRAJECTORY_SCHEMA) throw new Error("Unsupported trajectory schema");
  if (!Number.isSafeInteger(receipt.memberIssue) || (receipt.memberIssue ?? 0) < 1) throw new Error("Trajectory memberIssue is invalid");
  if (!receipt.artifactIds || typeof receipt.artifactIds !== "object") throw new Error("Trajectory artifactIds are required");
  if (!Array.isArray(receipt.acceptanceCriteria) || !Array.isArray(receipt.changedPaths)) throw new Error("Trajectory evidence arrays are required");
  if (receipt.acceptanceCriteria.length > 100 || receipt.changedPaths.length > 100) throw new Error("Trajectory evidence arrays exceed their bounded limits");
  if (receipt.acceptanceCriteria.some((criterion) => !criterion || typeof criterion.criterion !== "string" || criterion.criterion.length > 2_000 || typeof criterion.evidence !== "string" || criterion.evidence.length > 8_000)) {
    throw new Error("Trajectory acceptance evidence is invalid or unbounded");
  }
  if (receipt.changedPaths.some((path) => typeof path !== "string" || path.length > 500)) throw new Error("Trajectory changed paths are invalid or unbounded");
  if (!receipt.pullRequest || typeof receipt.pullRequest !== "object" || !receipt.pullRequest.url || !receipt.pullRequest.finalSha || !receipt.pullRequest.targetBranch) {
    throw new Error("Trajectory pullRequest proof is incomplete");
  }
  if (!receipt.review || typeof receipt.review !== "object" || typeof receipt.review.disposition !== "string"
    || !Array.isArray(receipt.review.reviewerRoles) || !Array.isArray(receipt.review.findingIds) || !Array.isArray(receipt.review.sessionRefs)) {
    throw new Error("Trajectory review proof is incomplete");
  }
  if (receipt.review.reviewerRoles.length > 20 || receipt.review.findingIds.length > 100 || receipt.review.sessionRefs.length > 100) throw new Error("Trajectory review references exceed their bounded limits");
  if (!Array.isArray(receipt.childIssues) || !Array.isArray(receipt.childOutcomeIds)) throw new Error("Trajectory child references are required");
  if (receipt.childIssues.length > 100 || receipt.childOutcomeIds.length > 100) throw new Error("Trajectory child references exceed their bounded limits");
  if (receipt.telemetry !== undefined) {
    const telemetry = receipt.telemetry;
    if (!telemetry || typeof telemetry !== "object" || !Number.isSafeInteger(telemetry.taskCount) || telemetry.taskCount < 0
      || !Number.isSafeInteger(telemetry.activeMs) || telemetry.activeMs < 0
      || !Number.isSafeInteger(telemetry.queueMs) || telemetry.queueMs < 0
      || !Number.isSafeInteger(telemetry.retries) || telemetry.retries < 0) {
      throw new Error("Trajectory telemetry summary is invalid");
    }
  }
  if (receipt.controllerTiming !== undefined) {
    const timing = receipt.controllerTiming;
    if (!timing || typeof timing !== "object" || !Number.isSafeInteger(timing.activeMs) || timing.activeMs < 0
      || !Number.isSafeInteger(timing.queuedMs) || timing.queuedMs < 0
      || !Number.isSafeInteger(timing.humanHeldMs) || timing.humanHeldMs < 0
      || !Array.isArray(timing.phases) || timing.phases.length > 100) {
      throw new Error("Trajectory controller timing is invalid");
    }
  }
  if (JSON.stringify(receipt).length > MAX_TRAJECTORY_RECEIPT_CHARS) throw new Error(`Trajectory receipt exceeds ${MAX_TRAJECTORY_RECEIPT_CHARS} characters`);
  if (!receipt.controllerRunId || !receipt.completedAt) throw new Error("Trajectory completion identity is required");
}

export function trajectoryReceiptFromArtifacts(input: {
  memberIssue: number;
  batchParent?: number;
  contract?: BatchMemberContract;
  artifacts: readonly DurableArtifact[];
  pullRequest: { url: string; number: number; finalSha: string; targetBranch: string };
  disposition?: TrajectoryReceipt["disposition"];
  childIssues?: readonly number[];
  childOutcomeIds?: readonly string[];
  telemetry?: TelemetrySummary;
  controllerTiming?: ControllerTimingSummary;
  completedAt?: string;
}): TrajectoryReceipt {
  const latest = <K extends DurableArtifact["kind"]>(kind: K): Extract<DurableArtifact, { kind: K }> | undefined => input.artifacts
    .filter((artifact): artifact is Extract<DurableArtifact, { kind: K }> => artifact.kind === kind)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
  const build = latest("BuildResult");
  const verdict = latest("ReviewVerdict");
  const outcome = latest("Outcome");
  const ids: TrajectoryReceipt["artifactIds"] = {};
  for (const artifact of input.artifacts) {
    const kind = artifact.kind;
    if (kind === "Intent" || kind === "Investigation" || kind === "BuildPacket" || kind === "BuildResult" || kind === "ReviewVerdict" || kind === "Outcome") ids[kind] = artifact.id;
  }
  const packet = latest("BuildPacket");
  const criteria = packet?.payload.acceptanceCriteria ?? input.contract?.acceptanceCriteria ?? [];
  const acceptanceCriteria = criteria.map((criterion) => ({
    criterion,
    status: "passed" as const,
    evidence: build?.payload.acceptanceEvidence.find((item) => item.criterion === criterion)?.evidence ?? "Controller completion proof recorded.",
  }));
  return {
    schema: TRAJECTORY_SCHEMA,
    memberIssue: input.memberIssue,
    ...(input.batchParent !== undefined ? { batchParent: input.batchParent } : {}),
    ...(input.contract ? { memberContract: input.contract } : {}),
    artifactIds: ids,
    acceptanceCriteria,
    changedPaths: [...(build?.payload.changedPaths ?? [])].slice(0, 100),
    verificationSummary: (build?.payload.checks ?? []).map((check) => `${check.command}: ${check.status}${check.summary ? ` — ${check.summary}` : ""}`).join("; ") || "No verification checks recorded.",
    pullRequest: input.pullRequest,
    review: {
      ...(verdict ? { verdictId: verdict.id } : {}),
      disposition: verdict?.payload.disposition ?? "approve",
      reviewerRoles: [...(verdict?.payload.reviewerRoles ?? [])],
      findingIds: [...(verdict?.payload.findings.map((finding) => finding.id) ?? [])],
      sessionRefs: [...new Set(verdict?.payload.findings.flatMap((finding) => finding.sourceSessionRefs ?? []) ?? [])],
    },
    disposition: input.disposition ?? (outcome?.payload.childIssues.length ? "recursive-remediation" : "direct-merge"),
    childIssues: [...new Set(input.childIssues ?? [])].filter((issue) => Number.isSafeInteger(issue) && issue > 0),
    childOutcomeIds: [...new Set(input.childOutcomeIds ?? [])],
    ...(input.telemetry !== undefined ? { telemetry: input.telemetry } : {}),
    ...(input.controllerTiming !== undefined ? { controllerTiming: input.controllerTiming } : {}),
    completedAt: input.completedAt ?? new Date().toISOString(),
    controllerRunId: input.artifacts[0]?.runId ?? "unknown-run",
  };
}
