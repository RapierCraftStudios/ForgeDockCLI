// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitWorkspace, GitWorkspaceManager, PullRequestRepairWorkspaceManager, ReviewWorkspaceManager } from "../../core/ports/git-workspace.js";
import { verificationEnvironment } from "../../runtime/controller-environment.js";

const execFileAsync = promisify(execFile);
const dependencyInstallLocks = new Map<string, Promise<void>>();
const repositoryMetadataLocks = new Map<string, Promise<void>>();
const DEPENDENCY_LOCK_STALE_MS = 2 * 60 * 60 * 1_000;
const DEPENDENCY_LOCK_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const REPOSITORY_LOCK_STALE_MS = 10 * 60 * 1_000;
const REPOSITORY_LOCK_TIMEOUT_MS = 10 * 60 * 1_000;

type DependencyStamp = {
  schema: "forgedock.dependencies/v1";
  fingerprint: string;
  installedAt: string;
};

type DependencyLease = {
  lockPath: string;
  ownerPath: string;
  token: string;
  heartbeat: NodeJS.Timeout;
};

export class GitWorktreeManager implements GitWorkspaceManager, ReviewWorkspaceManager, PullRequestRepairWorkspaceManager {
  readonly #repo: string;
  readonly #root: string;

  constructor(repo = process.cwd(), root = join(dirname(repo), ".forgedock-worktrees", basename(repo))) {
    this.#repo = resolve(repo);
    this.#root = resolve(root);
  }

  async create(input: { runId: string; issue: number; baseRef: string }): Promise<GitWorkspace> {
    const { branch, path } = this.workspaceIdentity(input);
    await mkdir(dirname(path), { recursive: true });
    const fetchedBase = input.baseRef.startsWith("origin/")
      ? await this.fetchOriginBase(input.baseRef)
      : input.baseRef;
    const baseSha = (await this.git(["rev-parse", fetchedBase], this.#repo)).trim();
    await this.withRepositoryMetadataLock(async () => {
      await this.git(["worktree", "add", "-b", branch, path, baseSha], this.#repo);
      await this.git(["config", `branch.${branch}.forgedockBaseSha`, baseSha], this.#repo);
    });
    await this.installDependencies(path);
    return { path, branch, baseRef: input.baseRef, baseSha };
  }

  async recover(input: { runId: string; issue: number; baseRef: string; baseSha?: string }): Promise<GitWorkspace> {
    const { branch, path } = this.workspaceIdentity(input);
    await mkdir(dirname(path), { recursive: true });
    const fetchedBase = input.baseRef.startsWith("origin/")
      ? await this.fetchOriginBase(input.baseRef)
      : input.baseRef;
    const baseSha = await this.withRepositoryMetadataLock(async () => {
      if (existsSync(path)) {
        const root = resolve((await this.git(["rev-parse", "--show-toplevel"], path)).trim());
        const observedBranch = (await this.git(["branch", "--show-current"], path)).trim();
        if (root !== path || observedBranch !== branch) {
          throw new Error(`Retained workspace identity mismatch for ${path}: expected ${branch}, found ${observedBranch || "detached HEAD"}`);
        }
      } else {
        await this.git(["worktree", "prune"], this.#repo);
        const branchExists = await this.branchExists(branch);
        await this.git(branchExists
          ? ["worktree", "add", path, branch]
          : ["worktree", "add", "-b", branch, path, fetchedBase], this.#repo);
      }
      const configuredBaseSha = await this.configuredBaseSha(branch);
      const frozenBaseSha = input.baseSha
        ?? configuredBaseSha
        ?? (await this.git(["merge-base", fetchedBase, "HEAD"], path)).trim();
      try {
        await this.git(["merge-base", "--is-ancestor", frozenBaseSha, fetchedBase], path);
      } catch (error) {
        throw new Error(`Frozen base ${frozenBaseSha} does not belong to target ref ${input.baseRef}`, { cause: error });
      }
      try {
        await this.git(["merge-base", "--is-ancestor", frozenBaseSha, "HEAD"], path);
      } catch (error) {
        throw new Error(`Frozen base ${frozenBaseSha} is not an ancestor of retained workspace ${branch}`, { cause: error });
      }
      await this.git(["config", `branch.${branch}.forgedockBaseSha`, frozenBaseSha], this.#repo);
      return frozenBaseSha;
    });
    await this.installDependencies(path);
    return { path, branch, baseRef: input.baseRef, baseSha };
  }

  async createReview(input: { runId: string; pr: number; headSha: string }): Promise<GitWorkspace> {
    const suffix = input.runId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-24);
    const path = resolve(this.#root, `review-${input.pr}-${suffix}`);
    assertInside(this.#root, path);
    await mkdir(dirname(path), { recursive: true });
    const fetched = await this.fetchRemoteCommit(`refs/pull/${input.pr}/head`, this.#repo);
    if (fetched !== input.headSha) throw new Error(`Fetched review SHA ${fetched} does not match PR head ${input.headSha}`);
    await this.withRepositoryMetadataLock(() => this.git(["worktree", "add", "--detach", path, fetched], this.#repo));
    await this.installDependencies(path);
    return { path, branch: `review/pr-${input.pr}`, baseRef: input.headSha, baseSha: input.headSha };
  }

  async changedPaths(workspace: GitWorkspace): Promise<string[]> {
    const output = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], workspace.path);
    const paths = new Set<string>();
    const entries = output.split("\0").filter(Boolean);
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry || entry.length < 4) continue;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (!isOperationalPath(path)) paths.add(path);
      if ((status.includes("R") || status.includes("C")) && entries[index + 1]) {
        const priorPath = entries[index + 1] as string;
        if (!isOperationalPath(priorPath)) paths.add(priorPath);
        index++;
      }
    }
    return [...paths].sort();
  }

  async revisionChangedPaths(workspace: GitWorkspace): Promise<string[]> {
    const baseSha = workspace.baseSha
      ?? (await this.git(["merge-base", workspace.baseRef, "HEAD"], workspace.path)).trim();
    const output = await this.git(["diff", "--no-renames", "--name-only", "-z", `${baseSha}..HEAD`], workspace.path);
    return [...new Set(output.split("\0").filter((path) => path && !isOperationalPath(path)))].sort();
  }

  async syncToRemoteHead(workspace: GitWorkspace, expectedHeadSha: string): Promise<void> {
    const dirty = await this.changedPaths(workspace);
    if (dirty.length) throw new Error(`Cannot synchronize dirty retained workspace: ${dirty.join(", ")}`);
    const fetched = await this.fetchRemoteCommit(`refs/heads/${workspace.branch}`, workspace.path);
    if (fetched.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      throw new Error(`Fetched parent branch head ${fetched} does not match authoritative PR head ${expectedHeadSha}`);
    }
    const current = await this.head(workspace);
    if (current.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      try {
        await this.git(["merge-base", "--is-ancestor", current, expectedHeadSha], workspace.path);
      } catch (error) {
        throw new Error(`Retained workspace ${current} cannot fast-forward to parent head ${expectedHeadSha}`, { cause: error });
      }
      await this.git(["merge", "--ff-only", expectedHeadSha], workspace.path);
    }
    const synchronized = await this.head(workspace);
    if (synchronized.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      throw new Error(`Retained workspace synchronized to ${synchronized}, expected ${expectedHeadSha}`);
    }
  }

  async integrateRemoteBase(
    workspace: GitWorkspace,
    input: { expectedHeadSha: string; expectedBaseSha: string },
  ): Promise<{ workspace: GitWorkspace; conflictPaths: string[]; mergeCommitExists: boolean }> {
    assertSha(input.expectedHeadSha, "expected delivery head SHA");
    assertSha(input.expectedBaseSha, "expected remote base SHA");
    if (!workspace.baseSha) throw new Error("Remote base integration requires a frozen prior workspace base SHA");
    assertSha(workspace.baseSha, "frozen workspace base SHA");

    const expectedHeadSha = input.expectedHeadSha.toLowerCase();
    const expectedBaseSha = input.expectedBaseSha.toLowerCase();
    const existingMergeHead = await this.readMergeHead(workspace);
    if (existingMergeHead && existingMergeHead.toLowerCase() !== expectedBaseSha) {
      throw new Error(`Retained workspace has an unrelated merge in progress at ${existingMergeHead}; refusing remote base integration`);
    }

    const localHead = await this.head(workspace);
    if (existingMergeHead && localHead.toLowerCase() !== expectedHeadSha) {
      throw new Error(`Retained workspace head ${localHead} does not match expected delivery head ${input.expectedHeadSha} while merge ${existingMergeHead} is in progress`);
    }
    const fetchedBase = await this.fetchRemoteCommit(this.remoteBaseRef(workspace.baseRef), workspace.path);
    if (fetchedBase.toLowerCase() !== expectedBaseSha) {
      throw new Error(`Remote base ${workspace.baseRef} resolved to ${fetchedBase}, expected ${input.expectedBaseSha}`);
    }
    if (!await this.isAncestor(workspace, workspace.baseSha, input.expectedBaseSha)) {
      throw new Error(`Frozen workspace base ${workspace.baseSha} is not an ancestor of remote base ${input.expectedBaseSha}`);
    }

    const integratedWorkspace = { ...workspace, baseSha: input.expectedBaseSha };
    if (existingMergeHead) {
      return { workspace: integratedWorkspace, conflictPaths: await this.unmergedPaths(workspace), mergeCommitExists: false };
    }

    const completedMerge = await this.isCompletedRemoteBaseMerge(workspace, expectedHeadSha, expectedBaseSha);
    if (completedMerge) {
      const dirty = await this.changedPaths(workspace);
      if (dirty.length) throw new Error(`Cannot re-enter completed remote base merge with dirty workspace: ${dirty.join(", ")}`);
      return { workspace: integratedWorkspace, conflictPaths: [], mergeCommitExists: true };
    }

    if (localHead.toLowerCase() !== expectedHeadSha) {
      throw new Error(`Retained workspace head ${localHead} does not match expected delivery head ${input.expectedHeadSha}`);
    }

    const dirty = await this.changedPaths(workspace);
    if (dirty.length) throw new Error(`Cannot integrate remote base into dirty workspace: ${dirty.join(", ")}`);

    try {
      await this.git(["merge", "--no-commit", "--no-ff", input.expectedBaseSha], workspace.path);
    } catch (error) {
      const mergeHead = await this.readMergeHead(workspace);
      if (!mergeHead || mergeHead.toLowerCase() !== expectedBaseSha) throw error;
      const conflictPaths = await this.unmergedPaths(workspace);
      if (conflictPaths.length) return { workspace: integratedWorkspace, conflictPaths, mergeCommitExists: false };
      try {
        await this.git(["merge", "--abort"], workspace.path);
      } catch (abortError) {
        throw new Error("Remote base integration failed without a recoverable conflict and could not be aborted", { cause: abortError });
      }
      throw new Error("Remote base integration failed without a recoverable conflict; merge was aborted", { cause: error });
    }

    const mergeHead = await this.readMergeHead(workspace);
    if (mergeHead && mergeHead.toLowerCase() !== expectedBaseSha) {
      throw new Error(`Remote base integration created an unexpected merge state at ${mergeHead}`);
    }
    return {
      workspace: integratedWorkspace,
      conflictPaths: mergeHead ? await this.unmergedPaths(workspace) : [],
      mergeCommitExists: false,
    };
  }

  async isAncestor(workspace: GitWorkspace, ancestorSha: string, descendantSha: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", ancestorSha, descendantSha], workspace.path);
      return true;
    } catch (error) {
      const cause = (error as Error & { cause?: { code?: number | string } }).cause;
      if (cause?.code === 1 || cause?.code === "1") return false;
      throw error;
    }
  }

  async committedContentMatches(
    workspace: GitWorkspace,
    paths: readonly string[],
    expectedDigest: string,
    revision: string,
  ): Promise<boolean> {
    const hash = createHash("sha256");
    for (const path of [...paths].sort()) {
      hash.update(path).update("\0");
      const entry = (await this.git(["--literal-pathspecs", "ls-tree", "-z", revision, "--", path], workspace.path))
        .split("\0")[0];
      if (!entry) {
        hash.update("deleted\0");
        continue;
      }
      const parsed = /^(\d+)\s+(\S+)\s+([0-9a-f]+)\t/.exec(entry);
      if (!parsed) throw new Error(`Committed delivery path is not a blob: ${path}`);
      const mode = parsed[1]!;
      if (mode === "120000") return false;
      if (parsed[2] !== "blob") throw new Error(`Committed delivery path is not a blob: ${path}`);
      const blob = await this.gitBuffer(["cat-file", "blob", parsed[3]!], workspace.path);
      hash.update(mode === "100755" ? "1" : "0").update("\0");
      hash.update("file\0").update(blob).update("\0");
    }
    if (hash.digest("hex") === expectedDigest) return true;

    // Git's built-in text/EOL normalization may legitimately make raw blobs
    // differ from worktree bytes. After rejecting executable clean filters,
    // compare Git's canonical object IDs without allowing repository code to run.
    await this.assertNoCleanFilters(workspace, paths);
    for (const path of [...paths].sort()) {
      const entry = (await this.git(["--literal-pathspecs", "ls-tree", "-z", revision, "--", path], workspace.path))
        .split("\0")[0];
      if (!entry) {
        if (existsSync(join(workspace.path, path))) return false;
        continue;
      }
      const parsed = /^(\d+)\s+(\S+)\s+([0-9a-f]+)\t/.exec(entry);
      if (!parsed || parsed[2] !== "blob") return false;
      const worktreeObject = (await this.git([
        "--literal-pathspecs", "hash-object", `--path=${path}`, "--", path,
      ], workspace.path)).trim();
      if (worktreeObject !== parsed[3]) return false;
    }
    return true;
  }

  async prepareWorkspaceDependencies(workspace: GitWorkspace): Promise<void> {
    await this.installDependencies(workspace.path);
  }

  async commit(workspace: GitWorkspace, message: string): Promise<string> {
    const paths = await this.changedPaths(workspace);
    if (!paths.length) throw new Error("Builder produced no repository changes");
    await this.assertNoCleanFilters(workspace, paths);
    await this.git(["add", "--all", "--", ...paths], workspace.path);
    const expectedTree = (await this.git(["write-tree"], workspace.path)).trim();
    const disabledHooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
    await this.git(["-c", `core.hooksPath=${disabledHooksPath}`, "commit", "--no-verify", "-m", message], workspace.path);
    const committedTree = (await this.git(["rev-parse", "HEAD^{tree}"], workspace.path)).trim();
    if (committedTree !== expectedTree) {
      throw new Error(`Committed tree ${committedTree} does not match verified staged tree ${expectedTree}`);
    }
    return this.head(workspace);
  }

  async push(workspace: GitWorkspace): Promise<void> {
    const disabledHooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
    await this.git([
      "-c", `core.hooksPath=${disabledHooksPath}`,
      "push", "--no-verify", "--set-upstream", "origin", workspace.branch,
    ], workspace.path);
  }
  async publishPullRequestRepair(workspace: GitWorkspace, input: { branch: string; expectedRemoteHeadSha: string }): Promise<void> {
    if (!isSafeRepairBranch(input.branch) || ["main", "master"].includes(input.branch)) throw new Error(`CI repair refuses to publish to protected or unsafe branch '${input.branch}'`);
    if (!/^[0-9a-f]{40,64}$/i.test(input.expectedRemoteHeadSha)) throw new Error("CI repair requires an exact expected remote head SHA");
    const remote = await this.fetchRemoteCommit(`refs/heads/${input.branch}`, workspace.path);
    if (remote.toLowerCase() !== input.expectedRemoteHeadSha.toLowerCase()) throw new Error(`PR head changed before CI repair push: expected ${input.expectedRemoteHeadSha}, current ${remote}`);
    const local = await this.head(workspace);
    try {
      await this.git(["merge-base", "--is-ancestor", input.expectedRemoteHeadSha, local], workspace.path);
    } catch (error) {
      throw new Error(`CI repair commit ${local} is not a descendant of reviewed PR head ${input.expectedRemoteHeadSha}`, { cause: error });
    }
    const disabledHooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
    await this.git(["-c", `core.hooksPath=${disabledHooksPath}`, "push", "--no-verify", "origin", `HEAD:refs/heads/${input.branch}`], workspace.path);
  }

  async head(workspace: GitWorkspace): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"], workspace.path)).trim();
  }

  async remove(workspace: GitWorkspace): Promise<void> {
    assertInside(this.#root, workspace.path);
    await this.withRepositoryMetadataLock(async () => {
      await this.git(["worktree", "remove", "--force", workspace.path], this.#repo);
      if (workspace.branch.startsWith("forgedock/")) {
        try { await this.git(["branch", "-D", workspace.branch], this.#repo); } catch { /* branch may already be absent */ }
      }
    });
  }

  private workspaceIdentity(input: { runId: string; issue: number }): { branch: string; path: string } {
    const suffix = input.runId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-24);
    const branch = `forgedock/issue-${input.issue}-${suffix}`;
    const path = resolve(this.#root, `issue-${input.issue}-${suffix}`);
    assertInside(this.#root, path);
    return { branch, path };
  }

  private async fetchOriginBase(baseRef: string): Promise<string> {
    const branch = baseRef.slice("origin/".length);
    return this.fetchRemoteCommit(`refs/heads/${branch}`, this.#repo);
  }

  private remoteBaseRef(baseRef: string): string {
    if (baseRef.startsWith("origin/") && baseRef.length > "origin/".length) {
      return `refs/heads/${baseRef.slice("origin/".length)}`;
    }
    if (baseRef.startsWith("refs/heads/") && baseRef.length > "refs/heads/".length) return baseRef;
    throw new Error(`Remote base integration requires a remote branch baseRef, found ${baseRef || "blank"}`);
  }

  private async readMergeHead(workspace: GitWorkspace): Promise<string | undefined> {
    const mergeHeadPath = resolve(workspace.path, (await this.git(["rev-parse", "--git-path", "MERGE_HEAD"], workspace.path)).trim());
    try {
      const contents = (await readFile(mergeHeadPath, "utf8")).trim();
      if (!contents) return undefined;
      const values = contents.split(/\s+/u);
      if (values.length !== 1 || !isSha(values[0] ?? "")) {
        throw new Error(`Retained workspace has an invalid MERGE_HEAD at ${mergeHeadPath}`);
      }
      return values[0];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async unmergedPaths(workspace: GitWorkspace): Promise<string[]> {
    const output = await this.git(["diff", "--name-only", "--diff-filter=U", "-z", "--"], workspace.path);
    return [...new Set(output.split("\0").filter(Boolean))].sort();
  }

  async stageConflictResolutions(workspace: GitWorkspace, paths: readonly string[]): Promise<void> {
    const authorized = [...new Set(paths)].sort();
    if (!authorized.length) throw new Error("Conflict resolution staging requires at least one authorized path");
    const entries = (await this.git([
      "--literal-pathspecs", "ls-files", "-u", "-z", "--", ...authorized,
    ], workspace.path)).split("\0").filter(Boolean);
    const stages = new Map<string, Set<number>>();
    for (const entry of entries) {
      const parsed = /^(\d+)\s+[0-9a-f]+\s+([123])\t([\s\S]+)$/.exec(entry);
      if (!parsed || (parsed[1] !== "100644" && parsed[1] !== "100755")) {
        throw new Error("Automatic conflict resolution supports only ordinary regular-file conflicts");
      }
      const pathStages = stages.get(parsed[3]!) ?? new Set<number>();
      pathStages.add(Number(parsed[2]));
      stages.set(parsed[3]!, pathStages);
    }
    for (const path of authorized) {
      const pathStages = stages.get(path);
      if (!pathStages || ![1, 2, 3].every((stage) => pathStages.has(stage))) {
        throw new Error(`Automatic conflict resolution requires a three-stage regular-file conflict: ${path}`);
      }
      const candidate = resolve(workspace.path, path);
      assertInside(workspace.path, candidate);
      const metadata = await lstat(candidate);
      if (!metadata.isFile() || (await readFile(candidate)).includes(0)) {
        throw new Error(`Automatic conflict resolution requires text file content: ${path}`);
      }
    }
    await this.assertNoCleanFilters(workspace, authorized);
    // Validate the worktree before mutating the index. Git's check rejects
    // leftover conflict-marker lines, so a no-op resolver cannot convert a
    // text conflict into a durable "resolved" checkpoint merely by naming it.
    await this.git(["--literal-pathspecs", "diff", "--check", "--", ...authorized], workspace.path);
    await this.git(["--literal-pathspecs", "add", "--all", "--", ...authorized], workspace.path);
  }

  private async isCompletedRemoteBaseMerge(
    workspace: GitWorkspace,
    expectedHeadSha: string,
    expectedBaseSha: string,
  ): Promise<boolean> {
    const parents = await this.commitParents(workspace);
    return parents.length === 2
      && parents[0]!.toLowerCase() === expectedHeadSha
      && parents[1]!.toLowerCase() === expectedBaseSha;
  }

  private async commitParents(workspace: GitWorkspace): Promise<string[]> {
    const output = (await this.git(["rev-list", "--parents", "-n", "1", "HEAD"], workspace.path)).trim();
    const values = output.split(/\s+/u).filter(Boolean);
    if (!values[0] || !isSha(values[0]) || values.slice(1).some((value) => !isSha(value))) {
      throw new Error(`Retained workspace HEAD has invalid commit parent evidence: ${output || "blank"}`);
    }
    return values.slice(1);
  }

  /** Fetch an advertised commit without mutating shared tracking refs or FETCH_HEAD. */
  private async fetchRemoteCommit(remoteRef: string, cwd: string): Promise<string> {
    const advertised = await this.git(["ls-remote", "--exit-code", "origin", remoteRef], cwd);
    const matches = advertised.split(/\r?\n/)
      .map((line) => line.split(/\s+/, 2))
      .filter((parts) => parts.length === 2 && parts[1] === remoteRef);
    if (matches.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(matches[0]?.[0] ?? "")) {
      throw new Error(`Remote ref ${remoteRef} did not resolve to exactly one commit`);
    }
    const sha = matches[0]![0]!;
    await this.git(["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin", remoteRef], cwd);
    try {
      await this.git(["cat-file", "-e", `${sha}^{commit}`], cwd);
    } catch (error) {
      throw new Error(`Remote ref ${remoteRef} changed while fetching advertised commit ${sha}`, { cause: error });
    }
    return sha;
  }

  private async withRepositoryMetadataLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = process.platform === "win32" ? this.#repo.toLowerCase() : this.#repo;
    const previous = repositoryMetadataLocks.get(key) ?? Promise.resolve();
    let result!: T;
    const current = previous.catch(() => undefined).then(async () => {
      const lease = await this.acquireRepositoryMetadataLock();
      try {
        result = await operation();
      } finally {
        await this.releaseDependencyInstallLock(lease);
      }
    });
    repositoryMetadataLocks.set(key, current);
    try {
      await current;
      return result;
    } finally {
      if (repositoryMetadataLocks.get(key) === current) repositoryMetadataLocks.delete(key);
    }
  }

  private async acquireRepositoryMetadataLock(): Promise<DependencyLease> {
    const lockPath = join(this.#repo, ".forgedock", "git-metadata.lock");
    const ownerPath = join(lockPath, "owner.json");
    await mkdir(dirname(lockPath), { recursive: true });
    const startedAt = Date.now();
    const token = randomUUID();
    for (;;) {
      try {
        await mkdir(lockPath);
        try {
          await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token, startedAt }), "utf8");
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        const heartbeat = setInterval(() => {
          void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
        }, 30_000);
        return { lockPath, ownerPath, token, heartbeat };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const age = Date.now() - (await stat(lockPath)).mtimeMs;
          const ownerStatus = await dependencyOwnerStatus(ownerPath);
          // A lock whose recorded owner has exited is safe to reclaim
          // immediately. Waiting for the stale-age window after a controller
          // interruption strands every resumed worker behind a dead lease.
          // Unknown/malformed owner metadata still uses the conservative age
          // threshold so a writer cannot be raced between mkdir and owner.json.
          if (ownerStatus === "dead" || (age > REPOSITORY_LOCK_STALE_MS && ownerStatus !== "alive")) {
            await rm(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          // A competing controller may have released or renewed the lock.
        }
        if (Date.now() - startedAt > REPOSITORY_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for Git metadata lock in ${basename(this.#repo)}`);
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
      }
    }
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.#repo);
      return true;
    } catch {
      return false;
    }
  }

  private async configuredBaseSha(branch: string): Promise<string | undefined> {
    try {
      return (await this.git(["config", "--get", `branch.${branch}.forgedockBaseSha`], this.#repo)).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async installDependencies(worktreePath: string): Promise<void> {
    if (!existsSync(join(worktreePath, "package-lock.json"))) return;
    const path = resolve(worktreePath);
    this.assertDependencyInstallTarget(path);
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    const previous = dependencyInstallLocks.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.withDependencyInstallLock(path, () => this.installDependenciesExclusive(path)));
    dependencyInstallLocks.set(key, current);
    try {
      await current;
    } finally {
      if (dependencyInstallLocks.get(key) === current) dependencyInstallLocks.delete(key);
    }
  }

  private assertDependencyInstallTarget(worktreePath: string): void {
    if (worktreePath === this.#repo) {
      throw new Error(`Refusing to run npm ci in the controller checkout ${worktreePath}; dependency installation is worktree-only`);
    }
    assertInside(this.#root, worktreePath);
    if (!existsSync(join(worktreePath, ".git"))) {
      throw new Error(`Refusing to prepare dependencies outside a managed Git worktree: ${worktreePath}`);
    }
  }

  private async installDependenciesExclusive(worktreePath: string): Promise<void> {
    const stampPath = join(worktreePath, ".forgedock", "dependency-install.json");
    const fingerprint = await this.dependencyFingerprint(worktreePath);
    if (await this.dependenciesReady(stampPath, fingerprint, worktreePath)) {
      try {
        await this.applyPinnedDependencyPatch(worktreePath);
        return;
      } catch (error) {
        await rm(stampPath, { force: true });
        throw error;
      } finally {
        await this.restoreTrackedDependencyBinModes(worktreePath);
      }
    }

    // npm ci is intentionally destructive. Remove our success receipt first so
    // an interrupted install can never be mistaken for a healthy tree later.
    await rm(stampPath, { force: true });
    const command = process.platform === "win32" ? process.execPath : "npm";
    const npmCli = process.platform === "win32"
      ? [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
        .find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
      : undefined;
    if (process.platform === "win32" && !npmCli) throw new Error("Unable to locate npm-cli.js while preparing isolated worktree dependencies");
    const args = [...(npmCli ? [npmCli] : []), "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
    try {
      await execFileAsync(command, args, {
        cwd: worktreePath,
        env: verificationEnvironment(process.env),
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(`npm ci failed while preparing ${basename(worktreePath)}: ${detail.stderr?.trim() || detail.message}`, { cause: error });
    }

    // npm links package executables by chmod'ing their source files. A file
    // dependency in this repository (the vendored Pi runtime) is therefore
    // able to dirty a tracked delivery path even though npm only prepared
    // operational dependencies. Restore the index's verified mode for those
    // package bin targets before any delivery-scope check observes the tree.
    await this.restoreTrackedDependencyBinModes(worktreePath);
    await this.assertInstalledDependencies(worktreePath);
    await this.applyPinnedDependencyPatch(worktreePath);
    await this.assertInstalledDependencies(worktreePath);
    await mkdir(dirname(stampPath), { recursive: true });
    const stamp: DependencyStamp = {
      schema: "forgedock.dependencies/v1",
      fingerprint,
      installedAt: new Date().toISOString(),
    };
    await writeFile(stampPath, `${JSON.stringify(stamp)}\n`, "utf8");
  }

  private async restoreTrackedDependencyBinModes(worktreePath: string): Promise<void> {
    const packagePaths = (await this.git(["ls-files", "-z"], worktreePath))
      .split("\0")
      .filter((path) => path.endsWith("package.json"));
    const binTargets = new Set<string>();
    for (const packagePath of packagePaths) {
      let manifest: { bin?: unknown };
      try {
        manifest = JSON.parse(await readFile(join(worktreePath, packagePath), "utf8")) as { bin?: unknown };
      } catch {
        continue;
      }
      const bins = typeof manifest.bin === "string"
        ? [manifest.bin]
        : manifest.bin && typeof manifest.bin === "object"
          ? Object.values(manifest.bin as Record<string, unknown>)
          : [];
      for (const bin of bins) {
        if (typeof bin !== "string" || !bin) continue;
        const target = resolve(worktreePath, dirname(packagePath), bin.replaceAll("\\", "/"));
        const targetRelative = relative(worktreePath, target).replaceAll("\\", "/");
        if (!targetRelative || targetRelative.startsWith("../") || targetRelative === "..") continue;
        binTargets.add(targetRelative);
      }
    }
    if (!binTargets.size) return;

    const entries = (await this.git(["ls-files", "-s", "-z", "--", ...binTargets], worktreePath))
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      const parsed = /^(100644|100755)\s+[0-9a-f]+\s+\d+\t([\s\S]+)$/.exec(entry);
      if (!parsed) continue;
      const target = join(worktreePath, parsed[2]!);
      let current;
      try {
        current = await lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!current.isFile()) continue;
      const executable = (current.mode & 0o111) !== 0;
      const expectedExecutable = parsed[1] === "100755";
      if (executable === expectedExecutable) continue;
      await chmod(target, expectedExecutable ? 0o755 : 0o644);
    }
  }

  private async withDependencyInstallLock<T>(worktreePath: string, operation: () => Promise<T>): Promise<T> {
    const lease = await this.acquireDependencyInstallLock(worktreePath);
    try {
      return await operation();
    } finally {
      await this.releaseDependencyInstallLock(lease);
    }
  }

  private async acquireDependencyInstallLock(worktreePath: string): Promise<DependencyLease> {
    const lockPath = join(worktreePath, ".forgedock", "dependencies-install.lock");
    const ownerPath = join(lockPath, "owner.json");
    await mkdir(dirname(lockPath), { recursive: true });
    const startedAt = Date.now();
    const token = randomUUID();
    for (;;) {
      try {
        await mkdir(lockPath);
        try {
          await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token, startedAt }), "utf8");
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        const heartbeat = setInterval(() => {
          void utimes(lockPath, new Date(), new Date()).catch(() => undefined);
        }, 30_000);
        return { lockPath, ownerPath, token, heartbeat };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        await this.reclaimStaleDependencyLock(lockPath, ownerPath);
        if (Date.now() - startedAt > DEPENDENCY_LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for dependency installation lock in ${basename(worktreePath)}`);
        }
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
  }

  private async reclaimStaleDependencyLock(lockPath: string, ownerPath: string): Promise<void> {
    try {
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (age <= DEPENDENCY_LOCK_STALE_MS || await dependencyOwnerAlive(ownerPath)) return;
      await rm(lockPath, { recursive: true, force: true });
    } catch {
      // A competing process may have released or renewed the lock between checks.
    }
  }

  private async releaseDependencyInstallLock(lease: DependencyLease): Promise<void> {
    clearInterval(lease.heartbeat);
    try {
      const owner = JSON.parse(await readFile(lease.ownerPath, "utf8")) as { token?: unknown };
      if (owner.token === lease.token) await rm(lease.lockPath, { recursive: true, force: true });
    } catch {
      // The lock may already have been reclaimed after a process failure.
    }
  }

  private async dependencyFingerprint(worktreePath: string): Promise<string> {
    const hash = createHash("sha256");
    for (const relativePath of ["package.json", "package-lock.json", "npm-shrinkwrap.json", "vendor/pi-runtime/package.json"]) {
      const path = join(worktreePath, relativePath);
      if (!existsSync(path)) continue;
      hash.update(relativePath).update("\0").update(await readFile(path)).update("\0");
    }
    return hash.digest("hex");
  }

  private async dependenciesReady(stampPath: string, fingerprint: string, worktreePath: string): Promise<boolean> {
    let stamp: DependencyStamp;
    try {
      stamp = JSON.parse(await readFile(stampPath, "utf8")) as DependencyStamp;
    } catch {
      return false;
    }
    if (stamp.schema !== "forgedock.dependencies/v1" || stamp.fingerprint !== fingerprint) return false;
    try {
      await this.assertInstalledDependencies(worktreePath);
      return true;
    } catch {
      return false;
    }
  }

  private async assertInstalledDependencies(worktreePath: string): Promise<void> {
    let lock: { packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }> };
    try {
      lock = JSON.parse(await readFile(join(worktreePath, "package-lock.json"), "utf8")) as typeof lock;
    } catch (error) {
      throw new Error(`Cannot inspect package-lock.json while preparing ${basename(worktreePath)}`, { cause: error });
    }
    const root = lock.packages?.[""] ?? {};
    const optional = new Set(Object.keys(root.optionalDependencies ?? {}));
    const direct = new Set([
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.devDependencies ?? {}),
    ]);
    const failures: string[] = [];
    for (const name of direct) {
      if (optional.has(name)) continue;
      const packageRoot = join(worktreePath, "node_modules", ...name.split("/"));
      const manifestPath = join(packageRoot, "package.json");
      try {
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { main?: unknown };
        if (typeof manifest.main === "string" && !existsSync(join(packageRoot, manifest.main))) {
          failures.push(`${name} main entry ${manifest.main} is missing`);
        }
      } catch {
        failures.push(`${name} package manifest is missing or unreadable`);
      }
    }
    if (failures.length) {
      throw new Error(`Dependency installation is incomplete in ${worktreePath}: ${failures.join("; ")}`);
    }
  }

  private async applyPinnedDependencyPatch(worktreePath: string): Promise<void> {
    // Dependency installation deliberately skips arbitrary lifecycle scripts.
    // ForgeDock still needs its one pinned, source-controlled pi-subagents
    // visibility patch before any controller verification command runs.
    const pinnedPatch = join(worktreePath, "scripts", "patch-pi-subagents-visibility.mjs");
    if (!existsSync(pinnedPatch)) return;
    try {
      await execFileAsync(process.execPath, [pinnedPatch], {
        cwd: worktreePath,
        env: verificationEnvironment(process.env),
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(`Pinned pi-subagents visibility patch failed while preparing ${basename(worktreePath)}: ${detail.stderr?.trim() || detail.message}`, { cause: error });
    }
  }

  private async assertNoCleanFilters(workspace: GitWorkspace, paths: readonly string[]): Promise<void> {
    const attributes = (await this.git([
      "--literal-pathspecs", "check-attr", "-z", "filter", "--", ...paths,
    ], workspace.path)).split("\0");
    for (let index = 0; index + 2 < attributes.length; index += 3) {
      const path = attributes[index]!;
      const value = attributes[index + 2]!;
      if (value && value !== "unspecified" && value !== "unset") {
        throw new Error(`Repository clean filter '${value}' is not permitted for controller commit path ${path}`);
      }
    }
  }

  private async gitBuffer(args: string[], cwd: string): Promise<Buffer> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        encoding: null,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    } catch (error) {
      const detail = error as Error & { stderr?: Buffer | string };
      const stderr = Buffer.isBuffer(detail.stderr) ? detail.stderr.toString("utf8") : detail.stderr;
      throw new Error(`git ${args[0] ?? ""} failed in ${basename(cwd)}: ${stderr?.trim() || detail.message}`, { cause: error });
    }
  }

  private async git(args: string[], cwd: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(`git ${args[0] ?? ""} failed in ${basename(cwd)}: ${detail.stderr?.trim() || detail.message}`, { cause: error });
    }
  }
}

type DependencyOwnerStatus = "alive" | "dead" | "unknown";

async function dependencyOwnerStatus(ownerPath: string): Promise<DependencyOwnerStatus> {
  try {
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown };
    if (typeof owner.pid !== "number") return "unknown";
    process.kill(owner.pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM") return "alive";
    if (code === "ESRCH") return "dead";
    return "unknown";
  }
}

async function dependencyOwnerAlive(ownerPath: string): Promise<boolean> {
  return (await dependencyOwnerStatus(ownerPath)) === "alive";
}

function isOperationalPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === ".pi-subagents"
    || normalized.startsWith(".pi-subagents/")
    || normalized === ".forgedock"
    || normalized.startsWith(".forgedock/")
    || normalized === "node_modules"
    || normalized.startsWith("node_modules/");
}
function isSafeRepairBranch(value: string): boolean { return Boolean(value) && value.length <= 240 && !value.startsWith("-") && !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".") && !value.includes("..") && !value.includes("@{") && !/[\s~^:?*\[\\]/.test(value) && value.split("/").every((segment) => Boolean(segment) && segment !== "." && segment !== ".."); }

function isSha(value: string): boolean { return /^[0-9a-f]{40,64}$/i.test(value); }

function assertSha(value: string, label: string): void {
  if (!isSha(value)) throw new Error(`${label} must be a full Git commit SHA`);
}

function assertInside(root: string, candidate: string): void {
  const path = relative(root, resolve(candidate));
  if (path.startsWith("..") || resolve(candidate) === resolve(root)) {
    throw new Error(`Unsafe worktree path outside managed root: ${candidate}`);
  }
}
