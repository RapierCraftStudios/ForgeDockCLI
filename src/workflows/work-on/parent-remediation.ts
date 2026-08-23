// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact, ReviewFindingRoute } from "../../core/artifacts/schema.js";
import type { ForgeHost } from "../../core/ports/forge-host.js";
import type { ArtifactRepository } from "../../core/ports/repositories.js";
import { repositoryPathFromLocation } from "../review-pr/scope.js";
import type { ParentRemediationTarget } from "./lane.js";

export async function validateRetainedRevisionRoute(
  route: ReviewFindingRoute,
  input: { repo: string; issue: number; host: ForgeHost; artifacts: ArtifactRepository },
): Promise<void> {
  if (route.routeKind !== "retained-revision") throw new Error("Only retained-revision routes may authorize delivery mutation");
  if (route.repository.trim().toLowerCase() !== input.repo.trim().toLowerCase()) throw new Error("Retained route repository does not match the admitted issue");
  const pullRequest = await input.host.getPullRequest(input.repo, route.pullRequest);
  if (pullRequest.state !== "OPEN"
    || pullRequest.repo.trim().toLowerCase() !== route.repository.trim().toLowerCase()
    || pullRequest.number !== route.pullRequest
    || pullRequest.headSha.toLowerCase() !== route.reviewedHeadSha.toLowerCase()
    || pullRequest.headBranch !== route.headBranch
    || pullRequest.baseBranch !== route.baseBranch
    || !pullRequest.baseSha
    || pullRequest.baseSha.toLowerCase() !== route.baseSha?.toLowerCase()) {
    throw new Error(`Retained route PR #${route.pullRequest} is stale, moved, closed, merged, or otherwise mismatched; refusing retargeting`);
  }
  if (route.deliveryIssue !== undefined) {
    const artifacts = await input.artifacts.list({ repo: route.repository, issue: route.deliveryIssue });
    if (!artifacts.some((artifact) => artifact.runId === route.deliveryRun)) {
      throw new Error(`Retained route delivery ${route.repository}#${route.deliveryIssue} is not managed by run ${route.deliveryRun}`);
    }
  } else {
    throw new Error("Retained route is missing its managed delivery issue");
  }
  if (route.lineage.sourceRunId !== route.deliveryRun
    || route.lineage.sourcePullRequest !== route.pullRequest
    || route.lineage.sourceHeadSha.toLowerCase() !== route.reviewedHeadSha.toLowerCase()
    || route.lineage.findingId !== route.findingId) {
    throw new Error("Retained route lineage does not match its source PR and finding identity");
  }
  if (route.deliveryIssue === input.issue) {
    throw new Error("A projected review finding cannot use its own issue as the delivery authority");
  }
}

export function retainedRevisionParentTarget(route: ReviewFindingRoute, issue: { repo: string; number: number }): ParentRemediationTarget {
  if (route.routeKind !== "retained-revision") throw new Error("Cannot create a retained target from a non-retained route");
  return {
    parentRunId: route.deliveryRun,
    parentIssue: route.deliveryIssue ?? issue.number,
    parentPullRequest: route.pullRequest,
    parentBranch: route.headBranch,
    parentHeadSha: route.reviewedHeadSha,
    findingId: route.findingId,
    ...(route.sourceSnapshot?.path ? { findingLocation: route.sourceSnapshot.path } : {}),
    remediationDepth: 1,
    maxRemediationDepth: 1,
    retainedRevision: route,
  };
}

export async function resolveParentRemediationTargetFromIssue(
  issue: { repo: string; number: number; body: string },
  artifacts: ArtifactRepository,
): Promise<ParentRemediationTarget | undefined> {
  if (!/<!-- FORGEDOCK:REMEDIATION_CHILD [a-f0-9]{64} -->/i.test(issue.body)) return undefined;
  const parentIssue = Number(/\*\*Parent issue:\*\*\s+#(\d+)/i.exec(issue.body)?.[1]);
  const checkpointKey = /\*\*Checkpoint:\*\*\s+`([a-f0-9]{64})`/i.exec(issue.body)?.[1];
  const findingId = /\*\*Finding ID:\*\*\s+`([^`]+)`/i.exec(issue.body)?.[1]?.trim();
  if (!Number.isSafeInteger(parentIssue) || parentIssue < 1 || !checkpointKey || !findingId) {
    throw new Error(`Remediation child #${issue.number} has incomplete controller routing metadata`);
  }
  const checkpoints = await artifacts.list({ repo: issue.repo, issue: parentIssue }, "RemediationBlocked");
  const checkpoint = checkpoints
    .filter((artifact): artifact is DurableArtifact<"RemediationBlocked"> =>
      artifact.kind === "RemediationBlocked"
      && artifact.payload.checkpointKey === checkpointKey
      && artifact.payload.parentIssue === parentIssue
      && artifact.payload.childIssues.includes(issue.number)
      && (artifact.payload.status === "children-running" || artifact.payload.status === "ready-to-resume"))
    .at(-1);
  if (!checkpoint) {
    throw new Error(`Remediation child #${issue.number} is not authorized by active checkpoint ${checkpointKey}`);
  }
  const finding = checkpoint.payload.findings.find((candidate) => candidate.id === findingId);
  if (!finding) throw new Error(`Checkpoint ${checkpointKey} does not authorize finding ${findingId}`);
  return {
    parentRunId: checkpoint.payload.parentRunId,
    parentIssue: checkpoint.payload.parentIssue,
    parentPullRequest: checkpoint.payload.pullRequest,
    parentBranch: checkpoint.payload.headBranch,
    parentHeadSha: checkpoint.payload.headSha,
    findingId,
    ...(finding.location ? { findingLocation: repositoryPathFromLocation(finding.location) ?? finding.location } : {}),
    remediationDepth: checkpoint.payload.remediationDepth + 1,
    maxRemediationDepth: checkpoint.payload.maxRemediationDepth,
    ...(checkpoint.payload.maxRemediationChildren !== undefined
      ? { maxRemediationChildren: checkpoint.payload.maxRemediationChildren }
      : {}),
  };
}
