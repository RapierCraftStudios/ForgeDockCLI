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
  getPullRequest(repo: string, number: number): Promise<PullRequestSnapshot>;
  getPullRequestDiff(repo: string, number: number): Promise<string>;
  mergePullRequest(repo: string, number: number, expectedHeadSha: string): Promise<void>;
  closeIssue(repo: string, number: number, reason: string): Promise<void>;
}
