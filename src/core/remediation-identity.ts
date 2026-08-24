// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";

/** The immutable identity inputs used by both GitHub projection and admission. */
export interface RemediationFindingIdentity {
  id: string;
  title: string;
  location?: string;
  rootId?: string;
  normalizedRoot?: string;
  causalRoot?: string;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedRepo(repo: string): string { return repo.trim().toLowerCase(); }
function normalizedText(value: string): string { return value.replace(/\s+/g, " ").trim().toLowerCase(); }
function normalizedPath(value: string): string { return value.replaceAll("\\", "/").trim().toLowerCase(); }

export function remediationChildMarker(
  repo: string,
  parentRunId: string,
  parentIssue: number,
  parentPullRequest: number,
  headSha: string,
  findingId: string,
): string {
  return digest([
    normalizedRepo(repo), parentRunId, String(parentIssue), String(parentPullRequest), headSha.toLowerCase(), findingId.trim(),
  ].join("\n"));
}

export function reviewFindingMarker(repo: string, pullRequest: number, finding: RemediationFindingIdentity): string {
  const identity = [
    normalizedRepo(repo), String(pullRequest), finding.location ? normalizedPath(finding.location) : "", normalizedText(finding.title),
  ].join("\n");
  return `<!-- FORGEDOCK:REVIEW-FINDING ${digest(`${identity}\n${finding.id.trim()}`)} -->`;
}

export function reviewFindingSemanticMarker(repo: string, pullRequest: number, finding: RemediationFindingIdentity): string {
  const root = finding.rootId?.trim() || finding.normalizedRoot?.trim() || finding.causalRoot?.trim()
    || [finding.location ?? "", finding.title].join("\n");
  const identity = [normalizedRepo(repo), String(pullRequest), normalizedText(root.replaceAll("\\", "/"))].join("\n");
  return `<!-- FORGEDOCK:REVIEW-FINDING-IDENTITY v1 ${digest(identity)} -->`;
}

export function reviewFindingLaneMarker(repo: string, pullRequest: number): string {
  return `<!-- FORGEDOCK:REVIEW-FINDING-LANE v1 ${digest(`${normalizedRepo(repo)}\n${pullRequest}`)} -->`;
}

export function canonicalReviewFindingMarkers(repo: string, pullRequest: number, finding: RemediationFindingIdentity): readonly string[] {
  return [reviewFindingMarker(repo, pullRequest, finding), reviewFindingSemanticMarker(repo, pullRequest, finding)];
}

export function sameRepository(left: string, right: string): boolean {
  return normalizedRepo(left) === normalizedRepo(right);
}
