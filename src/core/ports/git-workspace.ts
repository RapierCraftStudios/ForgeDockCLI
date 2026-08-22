// SPDX-License-Identifier: AGPL-3.0-or-later

export interface GitWorkspace {
  path: string;
  branch: string;
  baseRef: string;
  /** Immutable commit resolved when the workspace was created, when available. */
  baseSha?: string;
}

export interface ManagedWorktreeResetLifecycle {
  /** Re-read exact path/branch/HEAD identity, then force-remove only that managed worktree. */
  removeExactManaged(input: { path: string; branch: string; headSha: string }): Promise<void>;
}
export interface ReviewWorkspaceManager {
  createReview(input: { runId: string; pr: number; headSha: string }): Promise<GitWorkspace>;
  remove(workspace: GitWorkspace): Promise<void>;
}
export interface PullRequestRepairWorkspaceManager extends ReviewWorkspaceManager { changedPaths(workspace: GitWorkspace): Promise<string[]>; commit(workspace: GitWorkspace, message: string): Promise<string>; head(workspace: GitWorkspace): Promise<string>; publishPullRequestRepair(workspace: GitWorkspace, input: { branch: string; expectedRemoteHeadSha: string }): Promise<void>; }

export class AdvertisedRemoteHeadMismatchError extends Error {
  constructor(
    readonly expectedSha: string,
    readonly observedSha: string,
  ) {
    super(`Advertised remote head ${expectedSha} does not match fetched remote head ${observedSha}`);
    this.name = "AdvertisedRemoteHeadMismatchError";
  }
}

export interface GitWorkspaceManager {
  create(input: { runId: string; issue: number; baseRef: string; baseSha?: string; signal?: AbortSignal }): Promise<GitWorkspace>;
  /** Resolve the exact advertised commit used to freeze an investigation wave. */
  resolveBaseSha?(baseRef: string): Promise<string>;
  /**
   * Move an untouched delivery workspace to an exact, host-advertised target
   * revision. Implementations must fetch the branch directly, reject dirty or
   * merge state and non-ancestor movement, use ff-only, and return the newly
   * frozen base identity without resetting local work.
   */
  fastForwardToRemoteTarget?(workspace: GitWorkspace, advertisedHeadSha: string): Promise<GitWorkspace>;
  /** Prove exact HEAD, no in-progress merge, and no changed delivery paths. */
  assertPristineAtHead?(workspace: GitWorkspace, expectedHeadSha: string): Promise<void>;
  /** Uncommitted paths in the current build/remediation attempt. */
  changedPaths(workspace: GitWorkspace): Promise<string[]>;
  /** Complete path set carried by the delivery revision relative to its frozen base. */
  revisionChangedPaths(workspace: GitWorkspace): Promise<string[]>;
  /** Fast-forward a clean retained workspace to one authoritative remote branch SHA. */
  syncToRemoteHead(workspace: GitWorkspace, expectedHeadSha: string): Promise<void>;
  /**
   * Integrate one exact remote base revision into a clean retained delivery
   * workspace. A conflict leaves the controller-owned merge in progress so a
   * bounded resolver can inspect only the returned unmerged paths; callers may
   * safely repeat the operation after a restart with the same MERGE_HEAD.
   * `mergeCommitExists` is true only when the current HEAD is the exact
   * two-parent merge `(expectedHeadSha, expectedBaseSha)`.
   */
  integrateRemoteBase?(
    workspace: GitWorkspace,
    input: { expectedHeadSha: string; expectedBaseSha: string },
  ): Promise<{ workspace: GitWorkspace; conflictPaths: string[]; mergeCommitExists: boolean }>;
  /** Read the currently unmerged index paths from a retained merge workspace. */
  unmergedPaths?(workspace: GitWorkspace): Promise<string[]>;
  /** Stage only controller-authorized conflict paths so Git can prove they are resolved. */
  stageConflictResolutions?(workspace: GitWorkspace, paths: readonly string[]): Promise<void>;
  /** Prove one fetched commit is contained in a descendant revision. */
  isAncestor(workspace: GitWorkspace, ancestorSha: string, descendantSha: string): Promise<boolean>;
  /** Install lockfile dependencies without executing repository lifecycle scripts. */
  prepareWorkspaceDependencies(workspace: GitWorkspace, signal?: AbortSignal): Promise<void>;
  /** Compare committed regular-file blobs with the exact content verified in the worktree; Git mode 120000 entries must fail the proof. */
  committedContentMatches(
    workspace: GitWorkspace,
    paths: readonly string[],
    expectedDigest: string,
    revision: string,
  ): Promise<boolean>;
  /** Exact ordered parents for HEAD, used to recognize one retained non-merge commit. */
  commitParents?(workspace: GitWorkspace): Promise<string[]>;
  commit(workspace: GitWorkspace, message: string): Promise<string>;
  push(workspace: GitWorkspace): Promise<void>;
  head(workspace: GitWorkspace): Promise<string>;
  remove(workspace: GitWorkspace): Promise<void>;
}
