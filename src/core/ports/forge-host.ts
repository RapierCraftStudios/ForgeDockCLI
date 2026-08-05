// SPDX-License-Identifier: AGPL-3.0-or-later

export interface IssueSnapshot {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
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
  evidence: string;
  location?: string;
  intentRelevance: string;
  remediation: string;
  sourceFindingIds?: readonly string[];
  sourceSessionRefs?: readonly string[];
  reviewerRoles?: readonly string[];
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
  findOpenPullRequest?(repo: string, headBranch: string): Promise<PullRequestSnapshot | undefined>;
  getPullRequest(repo: string, number: number): Promise<PullRequestSnapshot>;
  /** Read the Git ref directly when a PR projection may lag a successful push. */
  getBranchHead?(repo: string, branch: string): Promise<string>;
  getPullRequestDiff(repo: string, number: number): Promise<string>;
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
  mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<void>;
  closeIssue(repo: string, number: number, reason: string): Promise<void>;
}
