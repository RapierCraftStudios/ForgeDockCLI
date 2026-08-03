// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitWorkspace, GitWorkspaceManager, ReviewWorkspaceManager } from "../../core/ports/git-workspace.js";

const execFileAsync = promisify(execFile);

export class GitWorktreeManager implements GitWorkspaceManager, ReviewWorkspaceManager {
  readonly #repo: string;
  readonly #root: string;

  constructor(repo = process.cwd(), root = join(dirname(repo), ".forgedock-worktrees", basename(repo))) {
    this.#repo = resolve(repo);
    this.#root = resolve(root);
  }

  async create(input: { runId: string; issue: number; baseRef: string }): Promise<GitWorkspace> {
    const suffix = input.runId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-24);
    const branch = `forgedock/issue-${input.issue}-${suffix}`;
    const path = resolve(this.#root, `issue-${input.issue}-${suffix}`);
    assertInside(this.#root, path);
    await mkdir(dirname(path), { recursive: true });
    if (input.baseRef.startsWith("origin/")) {
      await this.git(["fetch", "origin", input.baseRef.slice("origin/".length)], this.#repo);
    }
    await this.git(["worktree", "add", "-b", branch, path, input.baseRef], this.#repo);
    return { path, branch, baseRef: input.baseRef };
  }

  async createReview(input: { runId: string; pr: number; headSha: string }): Promise<GitWorkspace> {
    const suffix = input.runId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-24);
    const path = resolve(this.#root, `review-${input.pr}-${suffix}`);
    assertInside(this.#root, path);
    await mkdir(dirname(path), { recursive: true });
    await this.git(["fetch", "origin", `pull/${input.pr}/head`], this.#repo);
    const fetched = (await this.git(["rev-parse", "FETCH_HEAD"], this.#repo)).trim();
    if (fetched !== input.headSha) throw new Error(`Fetched review SHA ${fetched} does not match PR head ${input.headSha}`);
    await this.git(["worktree", "add", "--detach", path, fetched], this.#repo);
    return { path, branch: `review/pr-${input.pr}`, baseRef: input.headSha };
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

  async commit(workspace: GitWorkspace, message: string): Promise<string> {
    const paths = await this.changedPaths(workspace);
    if (!paths.length) throw new Error("Builder produced no repository changes");
    await this.git(["add", "--all", "--", ...paths], workspace.path);
    await this.git(["commit", "-m", message], workspace.path);
    return this.head(workspace);
  }

  async push(workspace: GitWorkspace): Promise<void> {
    await this.git(["push", "--set-upstream", "origin", workspace.branch], workspace.path);
  }

  async head(workspace: GitWorkspace): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"], workspace.path)).trim();
  }

  async remove(workspace: GitWorkspace): Promise<void> {
    assertInside(this.#root, workspace.path);
    await this.git(["worktree", "remove", "--force", workspace.path], this.#repo);
    if (workspace.branch.startsWith("forgedock/")) {
      try { await this.git(["branch", "-D", workspace.branch], this.#repo); } catch { /* branch may already be absent */ }
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

function isOperationalPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  return normalized === ".pi-subagents"
    || normalized.startsWith(".pi-subagents/")
    || normalized === ".forgedock"
    || normalized.startsWith(".forgedock/");
}

function assertInside(root: string, candidate: string): void {
  const path = relative(root, resolve(candidate));
  if (path.startsWith("..") || resolve(candidate) === resolve(root)) {
    throw new Error(`Unsafe worktree path outside managed root: ${candidate}`);
  }
}
