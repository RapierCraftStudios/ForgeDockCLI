// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { OrchestrationNodeRecord } from "../../core/ports/orchestration.js";

/** Read-only evidence supplied by a legacy-state inspector. */
export interface LegacyTargetFenceNode {
  node: OrchestrationNodeRecord;
  artifacts: readonly DurableArtifact[];
  workspace?: LegacyWorkspaceEvidence;
  /** Legacy controller error/reason, retained verbatim for the report. */
  reason?: string;
  /** A transport stop, rather than a target-fence decision. */
  stopped?: boolean;
}

export interface LegacyWorkspaceEvidence {
  path: string;
  branch: string;
  baseRef: string;
  headSha?: string;
  targetBranch?: string;
  observedTargetSha?: string;
}

export type LegacyTargetFenceDisposition =
  | "convert-target-advance"
  | "reset-fresh"
  | "retry-requeue"
  | "leave-for-reset";

export interface LegacyTargetFenceProposal {
  nodeId: string;
  issue: number;
  disposition: LegacyTargetFenceDisposition;
  /** Conversion is a proposal only; this helper never persists it. */
  checkpoint?: {
    packetArtifactId: string;
    sourceBuildResultId: string;
    sourceBaseSha: string;
    sourceHeadSha: string;
    targetBranch: string;
    workspace: { path: string; branch: string; baseRef: string };
    observedTargetSha: string;
  };
  evidence: readonly string[];
  reason: string;
}

export interface LegacyTargetFenceMigrationReport {
  schema: "forgedock.target-fence-migration-report/v1";
  readOnly: true;
  proposals: readonly LegacyTargetFenceProposal[];
  counts: Readonly<Record<LegacyTargetFenceDisposition, number>>;
}

/**
 * Classify old blocked target-fence nodes without changing local or GitHub state.
 * Conversion is deliberately strict: packet, build, and workspace identities
 * must form one exact chain. Generic or incomplete evidence remains reset-only.
 */
export function reportLegacyTargetFenceMigration(nodes: readonly LegacyTargetFenceNode[]): LegacyTargetFenceMigrationReport {
  const proposals = nodes.map(classifyLegacyTargetFenceNode);
  const counts = {
    "convert-target-advance": proposals.filter((p) => p.disposition === "convert-target-advance").length,
    "reset-fresh": proposals.filter((p) => p.disposition === "reset-fresh").length,
    "retry-requeue": proposals.filter((p) => p.disposition === "retry-requeue").length,
    "leave-for-reset": proposals.filter((p) => p.disposition === "leave-for-reset").length,
  } as const;
  return { schema: "forgedock.target-fence-migration-report/v1", readOnly: true, proposals, counts };
}

/** Alias useful to callers that already use classifier terminology. */
export const classifyLegacyTargetFenceNodes = reportLegacyTargetFenceMigration;

function classifyLegacyTargetFenceNode(input: LegacyTargetFenceNode): LegacyTargetFenceProposal {
  const { node } = input;
  const evidence: string[] = [];
  const reason = input.reason ?? node.error ?? "legacy target-fence state";
  const targetFence = /target[- _:](?:fence|advance)|target fence/i.test(reason)
    || node.targetAdvanceCheckpointId !== undefined;
  const packet = input.artifacts.filter((artifact) => artifact.kind === "BuildPacket").at(-1);
  const build = input.artifacts.filter((artifact) => artifact.kind === "BuildResult").at(-1);
  if (node.status === "running" || node.status === "queued" || input.stopped) {
    return proposal(node, "retry-requeue", ["stopped running/queued work is retryable"], "stopped nonterminal work should be retried or requeued");
  }
  if (node.status !== "blocked") {
    return proposal(node, "leave-for-reset", ["node is not a blocked legacy target-fence node"], "only blocked legacy nodes are migration candidates");
  }
  if (isGenericOnly(reason, packet, build)) {
    return proposal(node, "reset-fresh", ["generic prepacket target-fence failure", "HTTP 400-style evidence has no packet authority"], "prepacket generic failures cannot authorize checkpoint conversion");
  }
  if (!targetFence) {
    return proposal(node, "leave-for-reset", ["node is not an identified target-fence checkpoint"], "unsupported legacy state remains under reset authority");
  }
  const exact = exactChain(packet, build, input.workspace);
  if (!exact) {
    return proposal(node, "leave-for-reset", ["packet/build/workspace chain is incomplete or inconsistent"], "target-fence conversion requires exact packet, build, and workspace evidence");
  }
  evidence.push("exact BuildPacket identity", "exact BuildResult identity", "exact workspace identity");
  return {
    nodeId: node.id, issue: node.issue, disposition: "convert-target-advance", evidence,
    reason: "exact packet/build/workspace evidence supports TargetAdvanceCheckpoint conversion",
    checkpoint: exact,
  };
}

function proposal(node: OrchestrationNodeRecord, disposition: LegacyTargetFenceDisposition, evidence: string[], reason: string): LegacyTargetFenceProposal {
  return { nodeId: node.id, issue: node.issue, disposition, evidence, reason };
}

function isGenericOnly(reason: string, packet: DurableArtifact | undefined, build: DurableArtifact | undefined): boolean {
  return /(?:400|bad request|generic)/i.test(reason) && packet === undefined && build === undefined;
}

function exactChain(packet: DurableArtifact | undefined, build: DurableArtifact | undefined, workspace: LegacyWorkspaceEvidence | undefined): LegacyTargetFenceProposal["checkpoint"] | undefined {
  if (!packet || !build || packet.kind !== "BuildPacket" || build.kind !== "BuildResult" || !workspace) return undefined;
  if (packet.subject.repo.toLowerCase() !== build.subject.repo.toLowerCase()
    || packet.subject.issue !== build.subject.issue
    || packet.runId !== build.runId
    || workspace.branch !== build.payload.branch
    || !workspace.path || !workspace.branch || !workspace.baseRef
    || !/^[0-9a-f]{40}$/i.test(build.payload.headSha)
    || !build.payload.baseSha || !/^[0-9a-f]{40}$/i.test(build.payload.baseSha)
    || (workspace.headSha !== undefined && !/^[0-9a-f]{40}$/i.test(workspace.headSha))) return undefined;
  const targetBranch = workspace.targetBranch ?? build.payload.targetBranch;
  const observedTargetSha = workspace.observedTargetSha;
  if (!targetBranch || !observedTargetSha || !/^[0-9a-f]{40}$/i.test(observedTargetSha)) return undefined;
  return {
    packetArtifactId: packet.id, sourceBuildResultId: build.id,
    sourceBaseSha: build.payload.baseSha,
    sourceHeadSha: build.payload.headSha,
    targetBranch,
    workspace: { path: workspace.path, branch: workspace.branch, baseRef: workspace.baseRef },
    observedTargetSha,
  };
}
