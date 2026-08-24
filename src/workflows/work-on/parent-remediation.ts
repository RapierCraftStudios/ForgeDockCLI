// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost } from "../../core/ports/forge-host.js";
import type { ArtifactRepository } from "../../core/ports/repositories.js";
import {
  canonicalReviewFindingMarkers,
  remediationChildMarker,
  reviewFindingLaneMarker,
  sameRepository,
} from "../../core/remediation-identity.js";
import { repositoryPathFromLocation } from "../review-pr/scope.js";
import type { ParentRemediationTarget } from "./lane.js";

type AdmissionHost = Pick<ForgeHost, "getPullRequest" | "getIssue" | "getBranchHead">;

/**
 * Resolve retained remediation only from the immutable artifact chain.  The
 * issue body supplies a lookup key, never authority: every source identity is
 * dereferenced and compared before a target is returned.
 */
export async function resolveParentRemediationTargetFromIssue(
  issue: { repo: string; number: number; body: string },
  artifacts: ArtifactRepository,
  host?: AdmissionHost,
): Promise<ParentRemediationTarget | undefined> {
  const markerMatch = /<!-- FORGEDOCK:REMEDIATION_CHILD ([a-f0-9]{64}) -->/i.exec(issue.body);
  if (!markerMatch) return undefined;
  const remediationMarker = markerMatch[1].toLowerCase();
  const parentIssue = Number(/\*\*Parent issue:\*\*\s+#(\d+)/i.exec(issue.body)?.[1]);
  const checkpointKey = /\*\*Checkpoint:\*\*\s+`([a-f0-9]{64})`/i.exec(issue.body)?.[1];
  const findingId = /\*\*Finding ID:\*\*\s+`([^`]+)`/i.exec(issue.body)?.[1]?.trim();
  if (!Number.isSafeInteger(parentIssue) || parentIssue < 1 || !checkpointKey || !findingId) {
    throw new Error(`Remediation child #${issue.number} has incomplete controller routing metadata`);
  }

  const candidates = (await artifacts.list({ repo: issue.repo, issue: parentIssue }, "RemediationBlocked"))
    .filter((artifact): artifact is DurableArtifact<"RemediationBlocked"> => artifact.kind === "RemediationBlocked")
    .filter((artifact) => artifact.id && artifact.payload.checkpointKey === checkpointKey
      && artifact.payload.parentIssue === parentIssue
      && artifact.payload.childIssues.includes(issue.number)
      && (artifact.payload.status === "children-running" || artifact.payload.status === "ready-to-resume"));
  const orderedCandidates = [...candidates].sort((left, right) => left.payload.checkpointSequence - right.payload.checkpointSequence);
  const checkpoint = orderedCandidates.at(-1);
  if (!checkpoint) throw new Error(`Remediation child #${issue.number} is not authorized by active checkpoint ${checkpointKey}`);
  if (orderedCandidates.filter((candidate) => candidate.payload.checkpointSequence === checkpoint.payload.checkpointSequence).length !== 1) {
    throw new Error(`Remediation child #${issue.number} has an ambiguous checkpoint ${checkpointKey}`);
  }
  const payload = checkpoint.payload;
  if (!sameRepository(issue.repo, checkpoint.subject.repo)
    || checkpoint.subject.issue !== parentIssue
    || checkpoint.runId !== payload.parentRunId
    || !payload.buildResultArtifactId
    || !payload.projectionArtifactId) {
    throw new Error(`Remediation checkpoint ${checkpointKey} has missing or foreign source provenance`);
  }

  const all = await artifacts.list({ repo: issue.repo, issue: parentIssue });
  const exact = <K extends DurableArtifact["kind"]>(id: string, kind: K): DurableArtifact<K> | undefined => {
    const matches = all.filter((artifact): artifact is DurableArtifact<K> => artifact.kind === kind && artifact.id === id);
    if (matches.length !== 1) throw new Error(`Remediation checkpoint ${checkpointKey} has ambiguous ${kind} reference ${id}`);
    return matches[0];
  };
  const packet = exact(payload.packetArtifactId, "BuildPacket");
  const verdict = exact(payload.verdictArtifactId, "ReviewVerdict");
  const buildResult = exact(payload.buildResultArtifactId, "BuildResult");
  const projection = exact(payload.projectionArtifactId, "ReviewFindingProjection");
  if (!packet || !verdict || !buildResult || !projection
    || ![packet, verdict, buildResult, projection].every((artifact) => artifact.runId === payload.parentRunId && sameRepository(artifact.subject.repo, issue.repo))) {
    throw new Error(`Remediation checkpoint ${checkpointKey} references missing or foreign source artifacts`);
  }
  if (packet.subject.issue !== parentIssue || verdict.subject.issue !== parentIssue || verdict.subject.pr !== payload.pullRequest
    || buildResult.subject.issue !== parentIssue || projection.subject.issue !== parentIssue || projection.subject.pr !== payload.pullRequest) {
    throw new Error(`Remediation checkpoint ${checkpointKey} source subjects do not match parent issue`);
  }

  const sourceFindings = payload.findings.filter((candidate) => candidate.id === findingId);
  const verdictFindings = verdict.payload.findings.filter((candidate) => candidate.id === findingId);
  const projectionFindings = projection.payload.findings.filter((candidate) => candidate.id === findingId);
  const projectionEntries = projection.payload.projections.filter((entry) => entry.findingId === findingId);
  const sourceFinding = sourceFindings[0];
  const verdictFinding = verdictFindings[0];
  const projectionFinding = projectionFindings[0];
  const projectionEntry = projectionEntries[0];
  if (sourceFindings.length !== 1 || verdictFindings.length !== 1 || projectionFindings.length !== 1 || projectionEntries.length !== 1
    || !sourceFinding || !verdictFinding || !projectionFinding || !projectionEntry
    || !verdictFinding.rootId || !verdictFinding.matchedAcceptanceCriteria?.length
    || !verdictFinding.sourceSnapshot
    || projection.payload.status !== "completed"
    || projection.payload.pullRequest !== payload.pullRequest
    || projectionEntry.status !== "materialized" && projectionEntry.status !== "adopted"
    || !projectionEntry.issueNumber || !projectionEntry.marker) {
    throw new Error(`Remediation checkpoint ${checkpointKey} has no completed exact finding projection for ${findingId}`);
  }
  assertFindingIdentity(checkpointKey, sourceFinding, verdictFinding, projectionFinding);

  const sourceBaseSha = buildResult.payload.baseSha;
  if (!sourceBaseSha
    || buildResult.payload.headSha.toLowerCase() !== payload.headSha.toLowerCase()
    || buildResult.payload.branch !== payload.headBranch
    || buildResult.payload.targetBranch !== payload.baseBranch
    || verdict.payload.headSha.toLowerCase() !== payload.headSha.toLowerCase()
    || verdict.payload.headBranch !== payload.headBranch
    || verdict.payload.baseBranch !== payload.baseBranch
    || projection.payload.headSha.toLowerCase() !== payload.headSha.toLowerCase()
    || projection.payload.headBranch !== payload.headBranch
    || projection.payload.baseBranch !== payload.baseBranch
    || projectionEntry.marker !== canonicalReviewFindingMarkers(issue.repo, payload.pullRequest, verdictFinding)[0]
    || !verdictFinding.sourceSnapshot
    || verdictFinding.sourceSnapshot.reviewedHeadSha.toLowerCase() !== payload.headSha.toLowerCase()
    || !projection.payload.findingProjection.materializedFindingIds.includes(findingId)) {
    throw new Error(`Remediation checkpoint ${checkpointKey} source lineage does not match ${findingId}`);
  }
  const [sourceReviewFindingMarker, sourceReviewFindingSemanticMarker] = canonicalReviewFindingMarkers(issue.repo, payload.pullRequest, verdictFinding);
  const expectedChildMarker = remediationChildMarker(issue.repo, payload.parentRunId, parentIssue, payload.pullRequest, payload.headSha, findingId);
  if (remediationMarker !== expectedChildMarker) throw new Error(`Remediation child #${issue.number} has a mismatched canonical remediation marker`);

  if (host) await assertLiveSourceLineage(host, issue.repo, payload.pullRequest, payload.headSha, payload.headBranch, payload.baseBranch, sourceBaseSha, projectionEntry.issueNumber, sourceReviewFindingMarker, sourceReviewFindingSemanticMarker);

  return {
    sourceRepo: issue.repo,
    checkpointKey,
    parentRunId: payload.parentRunId,
    parentIssue,
    parentPullRequest: payload.pullRequest,
    parentBranch: payload.headBranch,
    parentHeadSha: payload.headSha,
    sourceBaseBranch: payload.baseBranch,
    sourceBaseSha,
    sourceBuildResultArtifactId: buildResult.id,
    sourceVerdictArtifactId: verdict.id,
    sourceProjectionArtifactId: projection.id,
    sourceSnapshotReviewedSha: verdictFinding.sourceSnapshot.reviewedHeadSha,
    sourceReviewFindingMarker,
    sourceReviewFindingSemanticMarker,
    remediationMarker,
    findingId,
    findingRootId: verdictFinding.rootId,
    findingCriterion: verdictFinding.matchedAcceptanceCriteria[0],
    ...(verdictFinding.location ? { findingLocation: repositoryPathFromLocation(verdictFinding.location) ?? verdictFinding.location } : {}),
    remediationDepth: payload.remediationDepth + 1,
    maxRemediationDepth: payload.maxRemediationDepth,
    ...(payload.maxRemediationChildren !== undefined ? { maxRemediationChildren: payload.maxRemediationChildren } : {}),
  };
}

function assertFindingIdentity(
  checkpointKey: string,
  checkpointFinding: DurableArtifact<"RemediationBlocked">["payload"]["findings"][number],
  verdictFinding: DurableArtifact<"ReviewVerdict">["payload"]["findings"][number],
  projectionFinding: DurableArtifact<"ReviewFindingProjection">["payload"]["findings"][number],
): void {
  const same = checkpointFinding.title === verdictFinding.title
    && checkpointFinding.location === verdictFinding.location
    && checkpointFinding.rootId === verdictFinding.rootId
    && checkpointFinding.normalizedRoot === verdictFinding.normalizedRoot
    && checkpointFinding.causalRoot === verdictFinding.causalRoot
    && checkpointFinding.acceptanceCriterion === verdictFinding.matchedAcceptanceCriteria?.[0]
    && checkpointFinding.sourceSnapshot?.reviewedHeadSha.toLowerCase() === verdictFinding.sourceSnapshot?.reviewedHeadSha.toLowerCase()
    && checkpointFinding.sourceSnapshot?.path === verdictFinding.sourceSnapshot?.path
    && projectionFinding.id === verdictFinding.id
    && projectionFinding.title === verdictFinding.title
    && projectionFinding.location === verdictFinding.location
    && projectionFinding.rootId === verdictFinding.rootId
    && projectionFinding.sourceSnapshot?.reviewedHeadSha.toLowerCase() === verdictFinding.sourceSnapshot?.reviewedHeadSha.toLowerCase();
  if (!same) throw new Error(`Remediation checkpoint ${checkpointKey} finding identity is mismatched or tampered`);
}

export async function assertParentRemediationArtifactRoute(
  artifacts: ArtifactRepository,
  target: ParentRemediationTarget,
  expectedRepo = target.sourceRepo,
): Promise<void> {
  const repo = target.sourceRepo;
  if (!repo || !expectedRepo || !sameRepository(repo, expectedRepo)) throw new Error("Retained remediation target belongs to a foreign repository");
  if (!repo || !target.sourceBaseBranch || !target.sourceBaseSha || !target.sourceBuildResultArtifactId
    || !target.sourceVerdictArtifactId || !target.sourceProjectionArtifactId || !target.sourceSnapshotReviewedSha
    || !target.sourceReviewFindingMarker || !target.sourceReviewFindingSemanticMarker || !target.remediationMarker) {
    throw new Error("Retained remediation target has incomplete immutable source lineage");
  }
  const all = await artifacts.list({ repo, issue: target.parentIssue });
  const find = (id: string, kind: DurableArtifact["kind"]): DurableArtifact | undefined => all.find((artifact) => artifact.id === id && artifact.kind === kind);
  const build = find(target.sourceBuildResultArtifactId, "BuildResult");
  const verdict = find(target.sourceVerdictArtifactId, "ReviewVerdict");
  const projection = find(target.sourceProjectionArtifactId, "ReviewFindingProjection");
  if (!build || build.kind !== "BuildResult" || !verdict || verdict.kind !== "ReviewVerdict" || !projection || projection.kind !== "ReviewFindingProjection") {
    throw new Error("Retained remediation target references missing source artifacts");
  }
  const finding = verdict.payload.findings.find((candidate) => candidate.id === target.findingId);
  const projected = projection.payload.findings.find((candidate) => candidate.id === target.findingId);
  const entry = projection.payload.projections.find((candidate) => candidate.findingId === target.findingId);
  if (![build, verdict, projection].every((artifact) => sameRepository(artifact.subject.repo, repo)
      && artifact.subject.issue === target.parentIssue && artifact.runId === target.parentRunId)
    || (verdict.subject.pr !== target.parentPullRequest)
    || (projection.subject.pr !== target.parentPullRequest)
    || build.payload.headSha.toLowerCase() !== target.parentHeadSha.toLowerCase()
    || build.payload.branch !== target.parentBranch || build.payload.targetBranch !== target.sourceBaseBranch
    || !build.payload.baseSha || build.payload.baseSha.toLowerCase() !== target.sourceBaseSha.toLowerCase()
    || verdict.payload.headSha.toLowerCase() !== target.parentHeadSha.toLowerCase()
    || verdict.payload.headBranch !== target.parentBranch || verdict.payload.baseBranch !== target.sourceBaseBranch
    || projection.payload.status !== "completed" || projection.payload.pullRequest !== target.parentPullRequest
    || projection.payload.headSha.toLowerCase() !== target.parentHeadSha.toLowerCase()
    || projection.payload.headBranch !== target.parentBranch || projection.payload.baseBranch !== target.sourceBaseBranch
    || !finding || !projected || !entry || (entry.status !== "materialized" && entry.status !== "adopted")
    || !finding.sourceSnapshot || finding.sourceSnapshot.reviewedHeadSha.toLowerCase() !== target.sourceSnapshotReviewedSha.toLowerCase()
    || projected.id !== finding.id || projected.title !== finding.title || projected.location !== finding.location
    || projected.rootId !== finding.rootId || entry.marker !== target.sourceReviewFindingMarker
    || target.findingRootId !== finding.rootId || target.findingCriterion !== finding.matchedAcceptanceCriteria?.[0]
    || target.sourceReviewFindingMarker !== canonicalReviewFindingMarkers(repo, target.parentPullRequest, finding)[0]
    || target.sourceReviewFindingSemanticMarker !== canonicalReviewFindingMarkers(repo, target.parentPullRequest, finding)[1]
    || target.remediationMarker.toLowerCase() !== remediationChildMarker(repo, target.parentRunId, target.parentIssue, target.parentPullRequest, target.parentHeadSha, target.findingId)) {
    throw new Error("Retained remediation target source artifact identity is stale, forged, or mismatched");
  }
}

export async function assertParentRemediationSourceRoute(
  host: Pick<ForgeHost, "getPullRequest" | "getBranchHead">,
  target: ParentRemediationTarget,
): Promise<void> {
  const sourceRepo = target.sourceRepo;
  const sourceBaseBranch = target.sourceBaseBranch;
  const sourceBaseSha = target.sourceBaseSha;
  if (!sourceRepo || !sourceBaseBranch || !sourceBaseSha || !target.sourceBuildResultArtifactId
    || !target.sourceVerdictArtifactId || !target.sourceProjectionArtifactId || !target.sourceSnapshotReviewedSha
    || !target.sourceReviewFindingMarker || !target.sourceReviewFindingSemanticMarker || !target.remediationMarker) {
    throw new Error("Retained remediation target has incomplete immutable source lineage");
  }
  if (!host.getPullRequest || !host.getBranchHead) throw new Error("Retained remediation admission lacks authoritative source readers");
  const live = await host.getPullRequest(sourceRepo, target.parentPullRequest);
  if (!sameRepository(live.repo, sourceRepo) || live.number !== target.parentPullRequest || live.state !== "OPEN"
    || live.headSha.toLowerCase() !== target.parentHeadSha.toLowerCase()
    || live.headBranch !== target.parentBranch || live.baseBranch !== sourceBaseBranch) {
    throw new Error(`Retained remediation source PR #${target.parentPullRequest} no longer matches the persisted route`);
  }
  const liveBaseSha = await host.getBranchHead(sourceRepo, sourceBaseBranch);
  if (liveBaseSha.toLowerCase() !== sourceBaseSha.toLowerCase()) {
    throw new Error(`Retained remediation source base ${sourceBaseBranch} advanced`);
  }
}

export async function assertParentRemediationIssueRoute(
  host: Pick<ForgeHost, "getIssue">,
  target: ParentRemediationTarget,
  child: { repo: string; number: number },
): Promise<void> {
  if (!host.getIssue || !target.checkpointKey || !target.sourceRepo || !target.remediationMarker) {
    throw new Error("Retained remediation issue route lacks authoritative identity");
  }
  const current = await host.getIssue(child.number, child.repo);
  const parent = /\*\*Parent issue:\*\*\s+#(\d+)/i.exec(current.body)?.[1];
  const checkpoint = /\*\*Checkpoint:\*\*\s+`([a-f0-9]{64})`/i.exec(current.body)?.[1];
  const finding = /\*\*Finding ID:\*\*\s+`([^`]+)`/i.exec(current.body)?.[1]?.trim();
  if (!sameRepository(current.repo, target.sourceRepo) || current.number !== child.number || current.state !== "OPEN"
    || parent !== String(target.parentIssue) || checkpoint?.toLowerCase() !== target.checkpointKey.toLowerCase()
    || finding !== target.findingId || !hasExactMarker(current.body, `<!-- FORGEDOCK:REMEDIATION_CHILD ${target.remediationMarker} -->`)) {
    throw new Error(`Remediation child #${child.number} is not the persisted canonical route`);
  }
}

async function assertLiveSourceLineage(
  host: AdmissionHost,
  repo: string,
  pullRequest: number,
  headSha: string,
  headBranch: string,
  baseBranch: string,
  baseSha: string,
  findingIssue: number,
  reviewMarker: string,
  semanticMarker: string,
): Promise<void> {
  if (!host.getPullRequest || !host.getBranchHead || !host.getIssue) throw new Error("Retained remediation admission lacks authoritative source readers");
  const live = await host.getPullRequest(repo, pullRequest);
  if (!sameRepository(live.repo, repo) || live.number !== pullRequest || live.state !== "OPEN"
    || live.headSha.toLowerCase() !== headSha.toLowerCase() || live.headBranch !== headBranch || live.baseBranch !== baseBranch) {
    throw new Error(`Retained remediation source PR #${pullRequest} no longer matches the persisted route`);
  }
  const liveBaseSha = await host.getBranchHead(repo, baseBranch);
  if (liveBaseSha.toLowerCase() !== baseSha.toLowerCase()) throw new Error(`Retained remediation source base ${baseBranch} advanced`);
  const finding = await host.getIssue(findingIssue, repo);
  if (finding.state !== "OPEN" || !hasExactMarker(finding.body, reviewMarker)
    || !hasExactMarker(finding.body, semanticMarker)
    || !hasExactMarker(finding.body, reviewFindingLaneMarker(repo, pullRequest))) {
    throw new Error(`Retained remediation source finding #${findingIssue} failed canonical identity validation`);
  }
}

function hasExactMarker(body: string, marker: string): boolean {
  return body.split(/\r?\n/).some((line) => line.trim() === marker);
}
