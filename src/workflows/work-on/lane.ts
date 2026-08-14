// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BranchSnapshot, IssueMilestone, IssueSnapshot } from "../../core/ports/forge-host.js";
import type { RunState, RunTarget } from "../../core/state/machine.js";

export type IssueLane =
  | {
    kind: "fast";
    targetBranch: string;
    resolution: "repository-default" | "configured-fast-lane" | "explicit-source-branch" | "explicit-target-branch";
  }
  | {
    kind: "feature";
    targetBranch: string;
    resolution: "canonical" | "stable-title-prefix" | "planned-canonical";
    milestone: IssueMilestone;
    canonicalBranch: string;
    /** Integration branch receiving this feature lane after review. */
    promotionTarget?: string;
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

export interface IssueLaneBranchProvisioner extends IssueLaneBranchReader {
  createBranch?(repo: string, branch: string, fromBranch: string): Promise<BranchSnapshot>;
}

export interface LaneClassificationOptions {
  /**
   * Allow a dispatch preview to describe the branch it would create. This is
   * never accepted by resolveIssueLane, which remains strict before delivery.
   */
  allowMissingMilestoneBranch?: boolean;
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
  issue: Pick<IssueSnapshot, "repo" | "number" | "milestone" | "body" | "labels">,
  defaultBranch: string,
  milestoneBranches: readonly BranchSnapshot[] = [],
  fastLaneTarget = defaultBranch,
  featurePromotionTarget?: string,
  productionTarget?: string,
  options: LaneClassificationOptions = {},
): IssueLane {
  assertBranchName(defaultBranch, "repository default branch");
  assertBranchName(fastLaneTarget, "configured fast-lane target");
  if (featurePromotionTarget !== undefined) assertBranchName(featurePromotionTarget, "configured feature promotion target");
  if (productionTarget !== undefined) assertBranchName(productionTarget, "configured production target");
  if (productionTarget !== undefined && fastLaneTarget === productionTarget) {
    throw new Error(`Configured fast-lane target ${fastLaneTarget} is the protected production target; configure an integration branch instead`);
  }
  if (productionTarget !== undefined && featurePromotionTarget === productionTarget) {
    throw new Error(`Configured feature promotion target ${featurePromotionTarget} is the protected production target; use a separate integration branch`);
  }
  const explicitEvidence = explicitBranchEvidence(issue);
  if (explicitEvidence.branch && explicitEvidence.kind === "source") {
    return { kind: "fast", targetBranch: explicitEvidence.branch, resolution: "explicit-source-branch" };
  }
  if (!issue.milestone) {
    if (explicitEvidence.branch) {
      return { kind: "fast", targetBranch: explicitEvidence.branch, resolution: "explicit-target-branch" };
    }
    if (isStagingReview(issue)) {
      throw new Error(`Staging-review issue #${issue.number} requires explicit Code branch or Worktree base branch evidence`);
    }
    return {
      kind: "fast",
      targetBranch: fastLaneTarget,
      resolution: fastLaneTarget === defaultBranch ? "repository-default" : "configured-fast-lane",
    };
  }

  const title = issue.milestone.title.trim();
  const canonicalSlug = sanitizeMilestoneSlug(title);
  if (!canonicalSlug) {
    throw new Error(`Milestone '${issue.milestone.title}' for issue #${issue.number} has no ASCII-safe branch slug`);
  }
  const canonicalBranch = `milestone/${canonicalSlug}`;
  const stableTitle = title.split(/\s+&\s+/u, 1)[0] ?? title;
  const stableSlug = sanitizeMilestoneSlug(stableTitle);
  const stableBranch = stableSlug ? `milestone/${stableSlug}` : canonicalBranch;
  if (explicitEvidence.branch && ![canonicalBranch, stableBranch].includes(explicitEvidence.branch)) {
    throw new Error(`Issue #${issue.number} explicitly targets ${explicitEvidence.branch}, which conflicts with milestone '${issue.milestone.title}' (expected ${canonicalBranch}${stableBranch !== canonicalBranch ? ` or ${stableBranch}` : ""})`);
  }
  const branchNames = new Set(milestoneBranches.map((branch) => {
    assertBranchName(branch.name, "remote milestone branch");
    return branch.name;
  }));
  const explicitMilestoneBranch = explicitEvidence.branch && branchNames.has(explicitEvidence.branch)
    ? explicitEvidence.branch
    : undefined;
  if (explicitMilestoneBranch) {
    return {
      kind: "feature",
      targetBranch: explicitMilestoneBranch,
      resolution: explicitMilestoneBranch === canonicalBranch ? "canonical" : "stable-title-prefix",
      milestone: issue.milestone,
      canonicalBranch,
      ...(featurePromotionTarget !== undefined ? { promotionTarget: featurePromotionTarget } : {}),
    };
  }
  if (explicitEvidence.branch && !options.allowMissingMilestoneBranch) {
    throw new Error(`Issue #${issue.number} explicitly targets ${explicitEvidence.branch}, but that branch is not present in the authoritative milestone branch catalog`);
  }
  if (branchNames.has(canonicalBranch)) {
    return {
      kind: "feature",
      targetBranch: canonicalBranch,
      resolution: "canonical",
      milestone: issue.milestone,
      canonicalBranch,
      ...(featurePromotionTarget !== undefined ? { promotionTarget: featurePromotionTarget } : {}),
    };
  }

  // A milestone title may gain a secondary "& ..." qualifier after its stable
  // branch was created. Follow that one explicit prior-title spelling only when
  // it exists remotely; never guess arbitrary fuzzy prefixes.
  if (stableBranch !== canonicalBranch && branchNames.has(stableBranch)) {
    return {
      kind: "feature",
      targetBranch: stableBranch,
      resolution: "stable-title-prefix",
      milestone: issue.milestone,
      canonicalBranch,
      ...(featurePromotionTarget !== undefined ? { promotionTarget: featurePromotionTarget } : {}),
    };
  }

  if (options.allowMissingMilestoneBranch) {
    return {
      kind: "feature",
      targetBranch: canonicalBranch,
      resolution: "planned-canonical",
      milestone: issue.milestone,
      canonicalBranch,
      ...(featurePromotionTarget !== undefined ? { promotionTarget: featurePromotionTarget } : {}),
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
  issue: Pick<IssueSnapshot, "repo" | "number" | "milestone" | "body" | "labels">,
  defaultBranch: string,
  branches: IssueLaneBranchReader,
  fastLaneTarget = defaultBranch,
  featurePromotionTarget?: string,
  productionTarget?: string,
): Promise<IssueLane> {
  const catalog = issue.milestone ? await branches.listBranches(issue.repo, "milestone/") : [];
  const lane = classifyIssueLane(issue, defaultBranch, catalog, fastLaneTarget, featurePromotionTarget, productionTarget);
  await branches.getBranchHead(issue.repo, lane.targetBranch);
  return lane;
}

export function laneEvidence(lane: IssueLane): string {
  if (lane.kind === "feature") {
    return `Feature lane: milestone '${lane.milestone.title}' targets ${lane.targetBranch} (${lane.resolution})${lane.resolution === "planned-canonical" ? "; branch will be provisioned from the repository default before dispatch" : ""}${lane.promotionTarget ? `; promotion target ${lane.promotionTarget}` : ""}.`;
  }
  if (lane.resolution === "explicit-source-branch") return `Fast lane: staging-review source evidence targets explicit branch ${lane.targetBranch}.`;
  if (lane.resolution === "explicit-target-branch") return `Fast lane: issue acceptance evidence targets explicit branch ${lane.targetBranch}.`;
  if (lane.resolution === "configured-fast-lane") return `Fast lane: project policy targets ${lane.targetBranch}.`;
  return `Fast lane: no milestone targets repository default branch ${lane.targetBranch}.`;
}

export function missingMilestoneBranchForIssue(
  issue: Pick<IssueSnapshot, "repo" | "number" | "milestone" | "body" | "labels">,
  milestoneBranches: readonly BranchSnapshot[],
): { branch: string; milestone: IssueMilestone } | undefined {
  if (!issue.milestone || sourceBranchFromIssue(issue)) return undefined;
  const canonicalSlug = sanitizeMilestoneSlug(issue.milestone.title);
  if (!canonicalSlug) return undefined;
  const canonicalBranch = `milestone/${canonicalSlug}`;
  const branchNames = new Set(milestoneBranches.map((branch) => branch.name));
  if (branchNames.has(canonicalBranch)) return undefined;
  const stableSlug = issue.milestone.title.trim().split(/\s+&\s+/u, 1)[0] ?? issue.milestone.title;
  const stableBranch = `milestone/${sanitizeMilestoneSlug(stableSlug)}`;
  if (stableBranch !== canonicalBranch && branchNames.has(stableBranch)) return undefined;
  return { branch: canonicalBranch, milestone: issue.milestone };
}

export async function provisionMissingMilestoneBranches(
  issues: readonly Pick<IssueSnapshot, "repo" | "number" | "milestone" | "body" | "labels">[],
  defaultBranch: string,
  branches: IssueLaneBranchProvisioner,
): Promise<readonly string[]> {
  if (!issues.length) return [];
  const repo = issues[0]?.repo;
  if (!repo) return [];
  const catalog = await branches.listBranches(repo, "milestone/");
  const missing = [...new Map(issues
    .map((issue) => missingMilestoneBranchForIssue(issue, catalog))
    .filter((value): value is { branch: string; milestone: IssueMilestone } => value !== undefined)
    .map((value) => [value.branch, value])).values()];
  if (!missing.length) return [];
  if (!branches.createBranch) {
    throw new Error(`Milestone branch provisioning is unavailable; create ${missing.map((value) => value.branch).join(", ")} from ${defaultBranch} before dispatch`);
  }
  await branches.getBranchHead(repo, defaultBranch);
  for (const value of missing) await branches.createBranch(repo, value.branch, defaultBranch);
  const refreshed = await branches.listBranches(repo, "milestone/");
  const missingAfter = missing.filter((value) => !refreshed.some((branch) => branch.name === value.branch));
  if (missingAfter.length) throw new Error(`Milestone branch provisioning did not become authoritative: ${missingAfter.map((value) => value.branch).join(", ")}`);
  return missing.map((value) => value.branch);
}

export function runTargetForLane(lane: IssueLane, productionTarget?: string): RunTarget {
  return {
    lane: lane.kind,
    targetBranch: lane.targetBranch,
    ...(lane.kind === "feature" && lane.promotionTarget !== undefined ? { promotionTarget: lane.promotionTarget } : {}),
    ...(productionTarget !== undefined ? { productionTarget } : {}),
    ...(lane.kind === "feature" ? { milestone: lane.milestone } : {}),
  };
}

export function assertRunFollowsLane(run: RunState, lane: IssueLane, productionTarget?: string): void {
  if (!run.targetBranch || !run.lane) {
    throw new Error(`Run ${run.runId} has no frozen lane target and cannot perform branch-authoritative delivery`);
  }
  if (run.targetBranch !== lane.targetBranch || run.lane !== lane.kind) {
    throw new Error(
      `Run ${run.runId} is frozen to ${run.lane}:${run.targetBranch}, but issue #${run.subject.issue ?? "?"} currently classifies to ${lane.kind}:${lane.targetBranch}; refusing cross-lane continuation`,
    );
  }
  const expectedPromotionTarget = lane.kind === "feature" ? lane.promotionTarget : undefined;
  if (run.promotionTarget !== expectedPromotionTarget) {
    throw new Error(`Run ${run.runId} promotion target ${run.promotionTarget ?? "unset"} no longer matches issue lane target ${expectedPromotionTarget ?? "unset"}`);
  }
  if (run.productionTarget !== productionTarget) {
    throw new Error(`Run ${run.runId} production target ${run.productionTarget ?? "unset"} no longer matches configured target ${productionTarget ?? "unset"}`);
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

function sourceBranchFromIssue(
  issue: Pick<IssueSnapshot, "body" | "labels">,
): string | undefined {
  const evidence = explicitBranchEvidence(issue);
  return evidence.kind === "source" ? evidence.branch : undefined;
}

function explicitBranchEvidence(
  issue: Pick<IssueSnapshot, "body" | "labels">,
): { branch?: string; kind?: "source" | "target" } {
  const body = issue.body ?? "";
  const sourceValues = [
    sourceBranchValue(/\*\*Code branch\*\*:\s*`?([^`\r\n]+)`?/i.exec(body)?.[1]),
    sourceBranchValue(/\*\*Worktree base(?: branch)?\*\*:\s*`?([^`\r\n]+)`?/i.exec(body)?.[1]),
  ].filter((value): value is string => Boolean(value));
  const targetValues = [
    sourceBranchValue(/\*\*Target branch\*\*:\s*`?([^`\r\n]+)`?/i.exec(body)?.[1]),
    sourceBranchValue(/(?:pull request|delivery PR|PR)[^`\r\n]{0,160}\bonly against\s+`([^`]+)`/i.exec(body)?.[1]),
    sourceBranchValue(/(?:pull request|PR)[^`\r\n]{0,160}\b(?:base|target) branch exactly\s+`([^`]+)`/i.exec(body)?.[1]),
  ].filter((value): value is string => Boolean(value));
  const uniqueSources = [...new Set(sourceValues)];
  const uniqueTargets = [...new Set(targetValues)];
  if (uniqueSources.length > 1) {
    throw new Error(`Staging-review source branch evidence conflicts: ${uniqueSources.join(" versus ")}`);
  }
  if (uniqueTargets.length > 1) {
    throw new Error(`Issue target branch evidence conflicts: ${uniqueTargets.join(" versus ")}`);
  }
  if (uniqueSources[0] && uniqueTargets[0] && uniqueSources[0] !== uniqueTargets[0]) {
    throw new Error(`Issue branch evidence conflicts: source branch '${uniqueSources[0]}' versus target branch '${uniqueTargets[0]}'`);
  }
  const branch = uniqueSources[0] ?? uniqueTargets[0];
  if (branch) {
    assertBranchName(branch, uniqueSources[0] ? "staging-review source branch" : "explicit target branch");
    return { branch, kind: uniqueSources[0] ? "source" : "target" };
  }
  return {};
}

function sourceBranchValue(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^origin\//i, "");
  return normalized || undefined;
}

function isStagingReview(issue: Pick<IssueSnapshot, "labels">): boolean {
  return (issue.labels ?? []).some((label) => label.trim().toLowerCase() === "staging-review");
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
