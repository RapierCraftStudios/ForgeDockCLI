// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createArtifact, type DurableArtifact, type TargetAdvanceCheckpointPayload } from "../../core/artifacts/schema.js";
import type { GitWorkspace } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository } from "../../core/ports/repositories.js";
import type { RunState } from "../../core/state/machine.js";

/** Stable serialization resource for all target-sensitive delivery work. */
export function normalizedTargetRouteClaim(repository: string, targetBranch: string): string {
  const repo = repository.trim().toLowerCase().replaceAll("\\", "/").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const target = targetBranch.trim().replaceAll("\\", "/").replace(/^refs\/heads\//, "");
  if (!repo || !target) throw new Error("A repository and target branch are required for a target route claim");
  return `target-route:${repo}:${target}`;
}

/** Persist authority before any target mutation or publication retry. */
export async function persistTargetAdvanceCheckpoint(input: {
  run: RunState;
  packet: DurableArtifact<"BuildPacket">;
  buildResult: DurableArtifact<"BuildResult">;
  /** Original reviewed source identity retained across phase receipts. */
  sourceBuildResult?: DurableArtifact<"BuildResult">;
  workspace: GitWorkspace;
  targetBranch: string;
  observedTargetSha: string;
  phase?: TargetAdvanceCheckpointPayload["phase"];
  attempt?: number;
  maxAttempts?: number;
  verdict?: DurableArtifact<"ReviewVerdict">;
  claimId?: string;
  integrationHeadSha?: string;
  mergeHeadSha?: string;
  freshVerificationCheckpointId?: string;
  freshBuildResultId?: string;
  pullRequest?: number;
  pushedHeadSha?: string;
  artifacts?: ArtifactRepository;
}): Promise<DurableArtifact<"TargetAdvanceCheckpoint"> | undefined> {
  if (!input.artifacts) return undefined;
  const now = new Date().toISOString();
  const verification = (await input.artifacts.list(input.run.subject, "VerificationCheckpoint"))
    .filter((artifact): artifact is DurableArtifact<"VerificationCheckpoint"> => artifact.kind === "VerificationCheckpoint" && artifact.runId === input.run.runId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
  const prior = (await input.artifacts.list(input.run.subject, "TargetAdvanceCheckpoint"))
    .filter((artifact): artifact is DurableArtifact<"TargetAdvanceCheckpoint"> => artifact.kind === "TargetAdvanceCheckpoint" && artifact.runId === input.run.runId)
    .sort((left, right) => left.payload.updatedAt.localeCompare(right.payload.updatedAt) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
  const sourceBuildResult = input.sourceBuildResult ?? input.buildResult;
  const verifiedContentDigest = verification?.payload.verifiedContentDigest
    ?? createHash("sha256").update(JSON.stringify({ head: sourceBuildResult.payload.headSha, paths: sourceBuildResult.payload.changedPaths })).digest("hex");
  const phase = input.phase ?? "target-read";
  const attemptNumber = input.attempt ?? 1;
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Target recovery checkpoint attempt must be a positive bounded integer");
  }
  const sourceVerdictId = input.verdict?.id
    ?? prior?.payload.sourceVerdictId;
  const verificationPlanId = createHash("sha256").update(JSON.stringify(input.packet.payload.verificationPlan)).digest("hex");
  const supersedes = prior?.id;
  const identity = [
    input.run.runId, input.packet.id, sourceBuildResult.id, input.targetBranch,
    sourceBuildResult.payload.headSha, phase, String(attemptNumber), supersedes ?? "root",
  ].join(":");
  const payload: TargetAdvanceCheckpointPayload = {
    checkpoint: "target-advance",
    version: "forgedock.target-advance/v1",
    repository: input.run.subject.repo,
    targetBranch: input.targetBranch,
    routeClaimKey: normalizedTargetRouteClaim(input.run.subject.repo, input.targetBranch),
    ...(input.claimId ? { claimId: input.claimId } : {}),
    ...(sourceVerdictId ? { sourceVerdictId } : {}),
    packetArtifactId: input.packet.id,
    sourceBuildResultId: sourceBuildResult.id,
    sourceBaseSha: sourceBuildResult.payload.baseSha ?? input.workspace.baseSha ?? sourceBuildResult.payload.headSha,
    sourceHeadSha: sourceBuildResult.payload.headSha,
    observedTargetSha: input.observedTargetSha,
    phase,
    expectedPaths: [...input.packet.payload.expectedPaths],
    verifiedContentDigest,
    verificationPlanId,
    attempt: { number: attemptNumber, max: maxAttempts },
    workspace: { path: input.workspace.path, branch: input.workspace.branch, baseRef: input.workspace.baseRef },
    ...(input.integrationHeadSha ? { integrationHeadSha: input.integrationHeadSha } : {}),
    ...(input.mergeHeadSha ? { mergeHeadSha: input.mergeHeadSha } : {}),
    ...(input.freshVerificationCheckpointId ? { freshVerificationCheckpointId: input.freshVerificationCheckpointId } : {}),
    ...(input.freshBuildResultId ? { freshBuildResultId: input.freshBuildResultId } : {}),
    ...(input.pullRequest !== undefined ? { pullRequest: input.pullRequest } : {}),
    ...(input.pushedHeadSha ? { pushedHeadSha: input.pushedHeadSha } : {}),
    ...(supersedes ? { supersedes } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const artifact = createArtifact({
    kind: "TargetAdvanceCheckpoint",
    runId: input.run.runId,
    subject: input.run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload,
  }, { id: `target_${createHash("sha256").update(identity).digest("hex").slice(0, 40)}` });
  await input.artifacts.append(artifact);
  return artifact;
}
