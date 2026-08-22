// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../core/artifacts/schema.js";
import type { ArtifactRepository } from "../core/ports/repositories.js";
import type { OrchestrationNodeRecord, OrchestrationRecord } from "../core/ports/orchestration.js";
import { orchestrationNodeRepository } from "../core/ports/orchestration.js";
import { reconcileLatestRunArtifacts } from "../core/state/reconcile.js";
import { GitHubClient } from "../adapters/github/github-client.js";
import { affectedFilesFromIssueBody } from "../workflows/orchestrate/batching.js";
import { resolveIssueLane, type IssueLane } from "../workflows/work-on/lane.js";
import { materializeClaimDependencies, type ScheduledWorkItem } from "../workflows/orchestrate/scheduler.js";
import { mapWithConcurrency } from "../core/concurrency.js";
import { decompositionQualifiedNodeId, mapDecompositionDependencies } from "../workflows/orchestrate/decomposition-dependencies.js";
import type { EffectiveOrchestrationConfig } from "../core/config/forgedock-config.js";
import { setOrchestrationRoute, type OrchestrationRouteCache } from "./orchestration-route-cache.js";

export function decompositionChildIssuesFromArtifacts(
  parentIssue: number,
  artifacts: readonly DurableArtifact[],
  runId: string | undefined,
): number[] {
  if (!runId) throw new Error(`Issue #${parentIssue} is decomposed but has no authoritative run id`);
  let outcome: DurableArtifact<"Outcome"> | undefined;
  for (let index = artifacts.length - 1; index >= 0; index--) {
    const artifact = artifacts[index];
    if (artifact?.kind === "Outcome" && artifact.runId === runId) {
      outcome = artifact;
      break;
    }
  }
  if (outcome?.payload.status !== "decomposed") {
    throw new Error(`Issue #${parentIssue} is decomposed but has no authoritative decomposed Outcome`);
  }
  const seen = new Set<number>();
  return outcome.payload.childIssues.map((reference) => {
    const match = /^#(\d+)\b/.exec(reference.trim());
    const child = Number(match?.[1]);
    if (!Number.isSafeInteger(child) || child < 1) throw new Error(`Issue #${parentIssue} has malformed decomposition child reference '${reference}'`);
    if (child === parentIssue) throw new Error(`Issue #${parentIssue} decomposition points back to itself`);
    if (seen.has(child)) throw new Error(`Issue #${parentIssue} decomposition repeats child #${child}`);
    seen.add(child);
    return child;
  });
}

export async function materializeCliDecomposition(input: {
  github: GitHubClient;
  artifacts: Pick<ArtifactRepository, "list">;
  repository: string;
  defaultBranch: string;
  effective: EffectiveOrchestrationConfig;
  orchestration: Readonly<OrchestrationRecord>;
  node: Readonly<OrchestrationNodeRecord>;
  item: ScheduledWorkItem;
  childIssues?: readonly number[];
  routedIssues?: OrchestrationRouteCache<{ issue: Awaited<ReturnType<GitHubClient["getIssue"]>>; lane: IssueLane }>;
}): Promise<{
  childIssues: readonly number[];
  items: readonly ScheduledWorkItem[];
  serializationEdges?: readonly { predecessor: string; successor: string; overlappingClaims: readonly string[] }[];
} | undefined> {
  let children = input.childIssues === undefined ? undefined : [...input.childIssues];
  if (children === undefined) {
    const scheduledRepository = input.item.repository ?? input.repository;
    const artifacts = await input.artifacts.list({ repo: scheduledRepository, issue: input.item.issue });
    const reconciled = reconcileLatestRunArtifacts(artifacts);
    if (reconciled.state !== "decomposed") return undefined;
    children = decompositionChildIssuesFromArtifacts(input.item.issue, artifacts, reconciled.runId);
  }
  if (!children.length) throw new Error(`Issue #${input.item.issue} decomposition has no replacement children`);
  const scheduledRepository = input.item.repository ?? input.repository;
  const existingNodeIds = new Set(input.orchestration.nodes.map((candidate) => candidate.id));
  const childNodeIds = new Map(children.map((issue) => [issue, existingNodeIds.has(`issue-${issue}`)
    ? decompositionQualifiedNodeId(scheduledRepository, issue)
    : `issue-${issue}`] as const));
  const dependencyNodes = [
    ...input.orchestration.nodes.map((candidate) => ({
      id: candidate.id,
      issue: candidate.issue,
      repository: orchestrationNodeRepository(input.orchestration, candidate),
      ...(candidate.memberIssues !== undefined ? { memberIssues: candidate.memberIssues } : {}),
    })),
    ...children.map((issue) => ({ id: childNodeIds.get(issue)!, issue, repository: scheduledRepository, memberIssues: [issue] })),
  ];
  const scheduledRepositoryInfo = scheduledRepository === input.repository
    ? { defaultBranch: input.defaultBranch }
    : await input.github.getRepository(scheduledRepository);
  const snapshots = await mapWithConcurrency(children, (issue) => input.github.getIssue(issue, scheduledRepository));
  const childItems: ScheduledWorkItem[] = [];
  for (const issue of snapshots) {
    if (issue.state !== "OPEN") throw new Error(`Decomposition child #${issue.number} is not open`);
    const lane = await resolveIssueLane(
      issue,
      scheduledRepositoryInfo.defaultBranch,
      input.github,
      input.effective.fastLaneTarget,
      input.effective.featurePromotionTarget,
      input.effective.productionTarget,
    );
    if (input.routedIssues) setOrchestrationRoute(input.routedIssues, { repository: scheduledRepository, issue: issue.number }, { issue, lane });
    const affectedFiles = affectedFilesFromIssueBody(issue.body);
    const labels = issue.labels ?? [];
    const priority = labels.some((label) => /(?:^|:)P0$/i.test(label)) ? 0
      : labels.some((label) => /(?:^|:)P1$/i.test(label)) ? 100
        : labels.some((label) => /(?:^|:)P2$/i.test(label)) ? 200
          : labels.some((label) => /(?:^|:)P3$/i.test(label)) ? 300 : 400;
    const sourcePullRequest = /^\*\*Source:\*\*\s*PR\s+#(\d+)\b/im.exec(issue.body)?.[1];
    const defectClass = /<!--\s*FORGE:CLASS:\s*([A-Za-z0-9_-]+)\s*-->/i.exec(issue.body)?.[1];
    childItems.push({
      id: childNodeIds.get(issue.number) ?? decompositionQualifiedNodeId(scheduledRepository, issue.number),
      issue: issue.number,
      priority,
      dependencies: mapDecompositionDependencies(issue.number, issue.body, dependencyNodes, scheduledRepository),
      claims: affectedFiles.length ? [...affectedFiles] : [`component:${scheduledRepository}`],
      repository: scheduledRepository,
      targetBranch: lane.targetBranch,
      lane: lane.kind,
      ...(lane.kind === "feature" && lane.promotionTarget !== undefined ? { promotionTarget: lane.promotionTarget } : {}),
      ...(input.orchestration.productionTarget ?? input.effective.productionTarget
        ? { productionTarget: input.orchestration.productionTarget ?? input.effective.productionTarget } : {}),
      affectedFiles,
      memberIssues: [issue.number],
      title: issue.title,
      summary: issue.body.slice(0, 4_000),
      ...(issue.milestone ? { milestone: issue.milestone } : {}),
      ...(sourcePullRequest !== undefined ? { sourcePullRequest: Number(sourcePullRequest) } : {}),
      ...(defectClass !== undefined ? { defectClass } : {}),
    });
  }
  const existingItems: ScheduledWorkItem[] = input.orchestration.nodes.map((candidate) => ({
    id: candidate.id,
    issue: candidate.issue,
    priority: candidate.priority,
    dependencies: candidate.dependencies.filter((dependency) => dependency !== input.node.id),
    claims: [...candidate.claims],
    ...(candidate.repository !== undefined ? { repository: candidate.repository } : {}),
    ...(candidate.targetBranch !== undefined ? { targetBranch: candidate.targetBranch } : {}),
    ...(candidate.lane !== undefined ? { lane: candidate.lane } : {}),
    ...(candidate.promotionTarget !== undefined ? { promotionTarget: candidate.promotionTarget } : {}),
    ...(candidate.productionTarget !== undefined ? { productionTarget: candidate.productionTarget } : {}),
  }));
  const claimGraph = materializeClaimDependencies([...existingItems, ...childItems]);
  const serializationEdges = claimGraph.edges.filter((edge) =>
    childItems.some((child) => child.id === edge.predecessor || child.id === edge.successor));
  return { childIssues: children, items: childItems, serializationEdges };
}
