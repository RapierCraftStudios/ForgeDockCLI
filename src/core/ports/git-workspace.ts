// SPDX-License-Identifier: AGPL-3.0-or-later

export interface GitWorkspace {
  path: string;
  branch: string;
  baseRef: string;
}

export interface ReviewWorkspaceManager {
  createReview(input: { runId: string; pr: number; headSha: string }): Promise<GitWorkspace>;
  remove(workspace: GitWorkspace): Promise<void>;
}

export interface GitWorkspaceManager {
  create(input: { runId: string; issue: number; baseRef: string }): Promise<GitWorkspace>;
  changedPaths(workspace: GitWorkspace): Promise<string[]>;
  commit(workspace: GitWorkspace, message: string): Promise<string>;
  push(workspace: GitWorkspace): Promise<void>;
  head(workspace: GitWorkspace): Promise<string>;
  remove(workspace: GitWorkspace): Promise<void>;
}
