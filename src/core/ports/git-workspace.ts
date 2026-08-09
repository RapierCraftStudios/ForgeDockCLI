// SPDX-License-Identifier: AGPL-3.0-or-later

export interface GitWorkspace {
  path: string;
  branch: string;
  baseRef: string;
  /** Immutable commit resolved when the workspace was created, when available. */
  baseSha?: string;
}

export interface ReviewWorkspaceManager {
  createReview(input: { runId: string; pr: number; headSha: string }): Promise<GitWorkspace>;
  remove(workspace: GitWorkspace): Promise<void>;
}

export interface GitWorkspaceManager {
  create(input: { runId: string; issue: number; baseRef: string }): Promise<GitWorkspace>;
  /** Uncommitted paths in the current build/remediation attempt. */
  changedPaths(workspace: GitWorkspace): Promise<string[]>;
  /** Complete path set carried by the delivery revision relative to its frozen base. */
  revisionChangedPaths(workspace: GitWorkspace): Promise<string[]>;
  /** Fast-forward a clean retained workspace to one authoritative remote branch SHA. */
  syncToRemoteHead(workspace: GitWorkspace, expectedHeadSha: string): Promise<void>;
  /** Prove one fetched commit is contained in a descendant revision. */
  isAncestor(workspace: GitWorkspace, ancestorSha: string, descendantSha: string): Promise<boolean>;
  /** Install lockfile dependencies without executing repository lifecycle scripts. */
  prepareWorkspaceDependencies(workspace: GitWorkspace): Promise<void>;
  /** Compare raw committed blobs with the exact content verified in the worktree. */
  committedContentMatches(
    workspace: GitWorkspace,
    paths: readonly string[],
    expectedDigest: string,
    revision: string,
  ): Promise<boolean>;
  commit(workspace: GitWorkspace, message: string): Promise<string>;
  push(workspace: GitWorkspace): Promise<void>;
  head(workspace: GitWorkspace): Promise<string>;
  remove(workspace: GitWorkspace): Promise<void>;
}
