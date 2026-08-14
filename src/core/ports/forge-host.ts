// SPDX-License-Identifier: AGPL-3.0-or-later

export interface IssueMilestone {
  number: number;
  title: string;
}

export interface IssueSnapshot {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
  labels?: readonly string[];
  milestone?: IssueMilestone;
}

export interface BranchSnapshot {
  name: string;
  headSha: string;
}

export interface DecompositionChild {
  title: string;
  outcome: string;
  dependsOn: string[];
}

export interface ReviewFindingInput {
  id: string;
  severity: "critical" | "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  blocking: boolean;
  title: string;
  causalRoot?: string;
  /** Stable controller-normalized root identity used for projection adoption. */
  normalizedRoot?: string;
  evidence: string;
  location?: string;
  intentRelevance: string;
  remediation: string;
  sourceFindingIds?: readonly string[];
  sourceSessionRefs?: readonly string[];
  reviewerRoles?: readonly string[];
  scopeDisposition?: "in_scope" | "follow_up" | "rejected";
  scopeRationale?: string;
  matchedAcceptanceCriteria?: readonly string[];
  matchedPriorFindingIds?: readonly string[];
  introducedByRemediation?: boolean;
  evidenceAnchor?: {
    kind: "repository-location" | "delivery-authority" | "deterministic-check";
    reference: string;
  };
}

export interface PullRequestSnapshot {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headSha: string;
  headBranch: string;
  baseBranch: string;
}

export interface ForgeHost {
  getIssue?(number: number, repo?: string): Promise<IssueSnapshot>;
  materializeBatchIssue?(input: {
    repo: string;
    title: string;
    body: string;
    priorityLabel: "priority:P0" | "P0" | "priority:P1" | "P1" | "priority:P2" | "P2" | "priority:P3" | "P3";
    milestone?: string;
  }): Promise<IssueSnapshot>;
  publishIssueComment?(input: {
    repo: string;
    issue: number;
    marker: string;
    body: string;
  }): Promise<void>;
  materializeRemediationChildren?(input: {
    repo: string;
    parentRunId: string;
    parentIssue: number;
    parentPullRequest: number;
    headSha: string;
    headBranch: string;
    baseBranch: string;
    checkpointKey: string;
    remediationDepth: number;
    findings: readonly {
      id: string;
      title: string;
      evidence: string;
      location: string;
      remediation: string;
      acceptanceCriterion: string;
    }[];
  }): Promise<IssueSnapshot[]>;
  materializeDecomposition(input: {
    repo: string;
    parentIssue: number;
    children: DecompositionChild[];
  }): Promise<IssueSnapshot[]>;
  createPullRequest(input: {
    repo: string;
    issue: number;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestSnapshot>;
  /** Create a branch-to-branch promotion PR without inventing an issue subject. */
  createPromotionPullRequest?(input: {
    repo: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<PullRequestSnapshot>;
  findOpenPullRequest?(repo: string, headBranch: string): Promise<PullRequestSnapshot | undefined>;
  findOpenPromotionPullRequest?(repo: string, headBranch: string, baseBranch: string): Promise<PullRequestSnapshot | undefined>;
  /** Production promotion fails closed when branch protection cannot be proven. */
  isBranchProtected?(repo: string, branch: string): Promise<boolean>;
  getPullRequest(repo: string, number: number): Promise<PullRequestSnapshot>;
  /** Read the Git ref directly when a PR projection may lag a successful push. */
  getBranchHead?(repo: string, branch: string): Promise<string>;
  /** Enumerate a bounded ref namespace for deterministic lane classification. */
  listBranches?(repo: string, prefix: string): Promise<BranchSnapshot[]>;
  /** Create a branch ref from an authoritative existing branch head. */
  createBranch?(repo: string, branch: string, fromBranch: string): Promise<BranchSnapshot>;
  getPullRequestDiff(repo: string, number: number): Promise<string>;
  /** Exact changed paths between two controller-reviewed commits, when the host can prove them. */
  getChangedPathsBetween?(repo: string, baseSha: string, headSha: string): Promise<readonly string[]>;
  publishPullRequestComment(input: {
    repo: string;
    pullRequest: number;
    marker: string;
    body: string;
  }): Promise<void>;
  materializeReviewFinding(input: {
    repo: string;
    sourceIssue?: number;
    pullRequest: PullRequestSnapshot;
    runId: string;
    reviewedHeadSha: string;
    reviewerRoles: readonly string[];
    finding: ReviewFindingInput;
  }): Promise<IssueSnapshot>;
  /** Close review-finding projections superseded by the latest authoritative verdict. */
  reconcileReviewFindings?(input: {
    repo: string;
    pullRequest: PullRequestSnapshot;
    runId: string;
    activeFindings: readonly ReviewFindingInput[];
  }): Promise<readonly number[]>;
  mergePullRequest(repo: string, number: number, expectedHeadSha: string, expectedBaseBranch: string): Promise<void>;
  /** Request closure; the controller independently re-reads getIssue before terminal publication. */
  closeIssue(repo: string, number: number, reason: string): Promise<void>;
}
