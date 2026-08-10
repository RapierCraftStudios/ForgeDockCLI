// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { ArtifactRepository } from "../../core/ports/repositories.js";
import { repositoryPathFromLocation } from "../review-pr/scope.js";
import type { ParentRemediationTarget } from "./lane.js";

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
  const matchingCheckpoints = checkpoints
    .filter((artifact): artifact is DurableArtifact<"RemediationBlocked"> =>
      artifact.kind === "RemediationBlocked"
      && artifact.payload.checkpointKey === checkpointKey
      && artifact.payload.parentIssue === parentIssue)
    .sort((left, right) => right.payload.checkpointSequence - left.payload.checkpointSequence);
  const checkpoint = matchingCheckpoints[0];
  if (!checkpoint
    || (checkpoint.payload.status !== "children-running" && checkpoint.payload.status !== "ready-to-resume")
    || !checkpoint.payload.childIssues.includes(issue.number)) {
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
