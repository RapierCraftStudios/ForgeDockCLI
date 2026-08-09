// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BranchSnapshot, IssueMilestone, IssueSnapshot } from "../../core/ports/forge-host.js";
import type { RunState, RunTarget } from "../../core/state/machine.js";

export type IssueLane =
  | {
    kind: "fast";
    targetBranch: string;
    resolution: "repository-default";
  }
  | {
    kind: "feature";
    targetBranch: string;
    resolution: "canonical" | "stable-title-prefix";
    milestone: IssueMilestone;
    canonicalBranch: string;
  };

export interface ParentRemediationTarget {
  parentRunId: string;
  parentIssue: number;
  parentPullRequest: number;
  parentBranch: string;
  parentHeadSha: string;
  findingId: string;
  findingLocation?: string;
  remediationDepth: number;
  maxRemediationDepth: number;
  maxRemediationChildren?: number;
}

export interface IssueLaneBranchReader {
  listBranches(repo: string, prefix: string): Promise<BranchSnapshot[]>;
  getBranchHead(repo: string, branch: string): Promise<string>;
}

/**
 * Match the established ForgeDock milestone spelling: lowercase ASCII words,
 * hyphen boundaries, and no Git-ref punctuation.
 */
export function sanitizeMilestoneSlug(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Pure classification over an authoritative issue snapshot and remote branch catalog. */
export function classifyIssueLane(
  issue: Pick<IssueSnapshot, "repo" | "number" | "milestone">,
  defaultBranch: string,
  milestoneBranches: readonly BranchSnapshot[] = [],
): IssueLane {
  assertBranchName(defaultBranch, "repository default branch");
  if (!issue.milestone) {
    return { kind: "fast", targetBranch: defaultBranch, resolution: "repository-default" };
  }

  const title = issue.milestone.title.trim();
  const canonicalSlug = sanitizeMilestoneSlug(title);
  if (!canonicalSlug) {
    throw new Error(`Milestone '${issue.milestone.title}' for issue #${issue.number} has no ASCII-safe branch slug`);
  }
  const canonicalBranch = `milestone/${canonicalSlug}`;
  const branchNames = new Set(milestoneBranches.map((branch) => {
    assertBranchName(branch.name, "remote milestone branch");
    return branch.name;
  }));
  if (branchNames.has(canonicalBranch)) {
    return {
      kind: "feature",
      targetBranch: canonicalBranch,
      resolution: "canonical",
      milestone: issue.milestone,
      canonicalBranch,
    };
  }

  // A milestone title may gain a secondary "& ..." qualifier after its stable
  // branch was created. Follow that one explicit prior-title spelling only when
  // it exists remotely; never guess arbitrary fuzzy prefixes.
  const stableTitle = title.split(/\s+&\s+/u, 1)[0] ?? title;
  const stableSlug = sanitizeMilestoneSlug(stableTitle);
  const stableBranch = stableSlug ? `milestone/${stableSlug}` : canonicalBranch;
  if (stableBranch !== canonicalBranch && branchNames.has(stableBranch)) {
    return {
      kind: "feature",
      targetBranch: stableBranch,
      resolution: "stable-title-prefix",
      milestone: issue.milestone,
      canonicalBranch,
    };
  }

  const expected = stableBranch === canonicalBranch
    ? `\`${canonicalBranch}\``
    : `\`${canonicalBranch}\` or established branch \`${stableBranch}\``;
  throw new Error(
    `Issue #${issue.number} is assigned to milestone '${issue.milestone.title}', but no corresponding remote branch exists; expected ${expected}`,
  );
}

/** Resolve and revalidate a lane before any workspace or pull request exists. */
export async function resolveIssueLane(
  issue: Pick<IssueSnapshot, "repo" | "number" | "milestone">,
  defaultBranch: string,
  branches: IssueLaneBranchReader,
): Promise<IssueLane> {
  const catalog = issue.milestone ? await branches.listBranches(issue.repo, "milestone/") : [];
  const lane = classifyIssueLane(issue, defaultBranch, catalog);
  await branches.getBranchHead(issue.repo, lane.targetBranch);
  return lane;
}

export function laneEvidence(lane: IssueLane): string {
  return lane.kind === "feature"
    ? `Feature lane: milestone '${lane.milestone.title}' targets ${lane.targetBranch} (${lane.resolution}).`
    : `Fast lane: no milestone targets repository default branch ${lane.targetBranch}.`;
}

export function runTargetForLane(lane: IssueLane): RunTarget {
  return {
    lane: lane.kind,
    targetBranch: lane.targetBranch,
    ...(lane.kind === "feature" ? { milestone: lane.milestone } : {}),
  };
}

export function assertRunFollowsLane(run: RunState, lane: IssueLane): void {
  if (!run.targetBranch || !run.lane) {
    throw new Error(`Run ${run.runId} has no frozen lane target and cannot perform branch-authoritative delivery`);
  }
  if (run.targetBranch !== lane.targetBranch || run.lane !== lane.kind) {
    throw new Error(
      `Run ${run.runId} is frozen to ${run.lane}:${run.targetBranch}, but issue #${run.subject.issue ?? "?"} currently classifies to ${lane.kind}:${lane.targetBranch}; refusing cross-lane continuation`,
    );
  }
  if (lane.kind === "feature" && run.milestone?.number !== lane.milestone.number) {
    throw new Error(`Run ${run.runId} milestone identity no longer matches issue #${run.subject.issue ?? "?"}`);
  }
}

export function parentRemediationClaim(target: ParentRemediationTarget): string {
  assertParentRemediationTarget(target);
  return `branch:${target.parentBranch}`;
}

export function assertParentRemediationTarget(target: ParentRemediationTarget): void {
  if (!target.parentRunId || !Number.isSafeInteger(target.parentIssue) || target.parentIssue < 1 || !Number.isSafeInteger(target.parentPullRequest) || target.parentPullRequest < 1) {
    throw new Error("Parent remediation target has invalid run, issue, or pull request identity");
  }
  assertBranchName(target.parentBranch, "parent remediation branch");
  if (!/^[0-9a-f]{7,64}$/i.test(target.parentHeadSha)) throw new Error("Parent remediation target requires a captured head SHA");
  if (!target.findingId.trim()) throw new Error("Parent remediation target requires a finding ID");
  if (target.findingLocation !== undefined && (!target.findingLocation.trim() || target.findingLocation.startsWith("/") || target.findingLocation.includes(".."))) {
    throw new Error("Parent remediation target requires a repository-relative finding location");
  }
  if (!Number.isSafeInteger(target.remediationDepth) || target.remediationDepth < 1 || target.remediationDepth > target.maxRemediationDepth) throw new Error("Parent remediation depth is outside its configured bound");
  if (target.maxRemediationChildren !== undefined
    && (!Number.isSafeInteger(target.maxRemediationChildren) || target.maxRemediationChildren < 1)) {
    throw new Error("Parent remediation child limit is invalid");
  }
}

export function assertRunTargetsBranch(run: RunState, branch: string): void {
  if (!run.targetBranch || !run.lane) {
    throw new Error(`Run ${run.runId} has no frozen lane target and cannot perform branch-authoritative delivery`);
  }
  if (run.targetBranch !== branch) {
    throw new Error(`Run ${run.runId} targets ${run.targetBranch}, not ${branch}`);
  }
}

function assertBranchName(branch: string, label: string): void {
  if (!branch
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("..")
    || branch.includes("@{")
    || branch.includes("[")
    || /[\x00-\x20~^:?*\\]/u.test(branch)) {
    throw new Error(`Invalid ${label}: '${branch}'`);
  }
}
