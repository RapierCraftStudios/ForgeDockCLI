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
  workspace: GitWorkspace;
  targetBranch: string;
  observedTargetSha: string;
  phase?: TargetAdvanceCheckpointPayload["phase"];
  attempt?: number;
  maxAttempts?: number;
  verdict?: DurableArtifact<"ReviewVerdict">;
  artifacts?: ArtifactRepository;
}): Promise<DurableArtifact<"TargetAdvanceCheckpoint"> | undefined> {
  if (!input.artifacts) return undefined;
  const now = new Date().toISOString();
  const verification = (await input.artifacts.list(input.run.subject, "VerificationCheckpoint"))
    .filter((artifact): artifact is DurableArtifact<"VerificationCheckpoint"> => artifact.kind === "VerificationCheckpoint" && artifact.runId === input.run.runId)
    .at(-1);
  const verifiedContentDigest = verification?.payload.verifiedContentDigest
    ?? createHash("sha256").update(JSON.stringify({ head: input.buildResult.payload.headSha, paths: input.buildResult.payload.changedPaths })).digest("hex");
  const payload: TargetAdvanceCheckpointPayload = {
    checkpoint: "target-advance",
    version: "forgedock.target-advance/v1",
    repository: input.run.subject.repo,
    targetBranch: input.targetBranch,
    routeClaimKey: normalizedTargetRouteClaim(input.run.subject.repo, input.targetBranch),
    ...(input.verdict ? { sourceVerdictId: input.verdict.id } : {}),
    packetArtifactId: input.packet.id,
    sourceBuildResultId: input.buildResult.id,
    sourceBaseSha: input.buildResult.payload.baseSha ?? input.workspace.baseSha ?? input.buildResult.payload.headSha,
    sourceHeadSha: input.buildResult.payload.headSha,
    observedTargetSha: input.observedTargetSha,
    phase: input.phase ?? "target-read",
    expectedPaths: [...input.packet.payload.expectedPaths],
    verifiedContentDigest,
    verificationPlanId: createHash("sha256").update(JSON.stringify(input.packet.payload.verificationPlan)).digest("hex"),
    attempt: { number: input.attempt ?? 1, max: input.maxAttempts ?? 3 },
    workspace: { path: input.workspace.path, branch: input.workspace.branch, baseRef: input.workspace.baseRef },
    createdAt: now,
    updatedAt: now,
  };
  const artifact = createArtifact({
    kind: "TargetAdvanceCheckpoint",
    runId: input.run.runId,
    subject: input.run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload,
  }, { id: `target_${createHash("sha256").update(`${input.run.runId}:${payload.routeClaimKey}:${payload.sourceHeadSha}:${payload.observedTargetSha}`).digest("hex").slice(0, 40)}` });
  await input.artifacts.append(artifact);
  return artifact;
}
