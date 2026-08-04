// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
    const { branch, path } = this.workspaceIdentity(input);
    await mkdir(dirname(path), { recursive: true });
    if (input.baseRef.startsWith("origin/")) {
      await this.git(["fetch", "origin", input.baseRef.slice("origin/".length)], this.#repo);
    }
    await this.git(["worktree", "add", "-b", branch, path, input.baseRef], this.#repo);
    await this.installDependencies(path);
    return { path, branch, baseRef: input.baseRef };
  }

  async recover(input: { runId: string; issue: number; baseRef: string }): Promise<GitWorkspace> {
    const { branch, path } = this.workspaceIdentity(input);
    await mkdir(dirname(path), { recursive: true });
    if (input.baseRef.startsWith("origin/")) {
      await this.git(["fetch", "origin", input.baseRef.slice("origin/".length)], this.#repo);
    }
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
        : ["worktree", "add", "-b", branch, path, input.baseRef], this.#repo);
    }
    await this.installDependencies(path);
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
    await this.installDependencies(path);
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

  private workspaceIdentity(input: { runId: string; issue: number }): { branch: string; path: string } {
    const suffix = input.runId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-24);
    const branch = `forgedock/issue-${input.issue}-${suffix}`;
    const path = resolve(this.#root, `issue-${input.issue}-${suffix}`);
    assertInside(this.#root, path);
    return { branch, path };
  }

  private async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.#repo);
      return true;
    } catch {
      return false;
    }
  }

  private async installDependencies(worktreePath: string): Promise<void> {
    if (!existsSync(join(worktreePath, "package-lock.json"))) return;
    const command = process.platform === "win32" ? process.execPath : "npm";
    const npmCli = process.platform === "win32"
      ? [process.env.npm_execpath, join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
        .find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
      : undefined;
    if (process.platform === "win32" && !npmCli) throw new Error("Unable to locate npm-cli.js while preparing isolated worktree dependencies");
    const args = [...(npmCli ? [npmCli] : []), "ci", "--no-audit", "--no-fund"];
    try {
      await execFileAsync(command, args, { cwd: worktreePath, encoding: "utf8", windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new Error(`npm ci failed while preparing ${basename(worktreePath)}: ${detail.stderr?.trim() || detail.message}`, { cause: error });
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
    || normalized.startsWith(".forgedock/")
    || normalized === "node_modules"
    || normalized.startsWith("node_modules/");
}

function assertInside(root: string, candidate: string): void {
  const path = relative(root, resolve(candidate));
  if (path.startsWith("..") || resolve(candidate) === resolve(root)) {
    throw new Error(`Unsafe worktree path outside managed root: ${candidate}`);
  }
}
