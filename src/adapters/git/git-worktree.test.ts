import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { GitWorktreeManager } from "./git-worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitWithInput(cwd: string, input: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function restoreMergeHead(cwd: string, sha: string): void {
  const mergeHeadPath = resolve(cwd, git(cwd, "rev-parse", "--git-path", "MERGE_HEAD"));
  writeFileSync(mergeHeadPath, `${sha}\n`);
}

async function remoteBaseIntegrationFixture(conflicting: boolean): Promise<{
  root: string;
  manager: GitWorktreeManager;
  workspace: Awaited<ReturnType<GitWorktreeManager["create"]>>;
  headSha: string;
  baseSha: string;
  updatedBaseSha: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "forgedock-git-integrate-base-"));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "ForgeDock Test");
  git(repo, "config", "user.email", "forgedock@example.invalid");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "base");
  git(repo, "branch", "-M", "main");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  const baseSha = git(repo, "rev-parse", "HEAD");

  const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
  const workspace = await manager.create({ runId: "run_integrate_base", issue: 22, baseRef: "origin/main" });
  if (conflicting) writeFileSync(join(workspace.path, "README.md"), "delivery\n");
  else writeFileSync(join(workspace.path, "feature.txt"), "delivery\n");
  git(workspace.path, "add", "--all");
  git(workspace.path, "commit", "-m", "delivery");
  const headSha = git(workspace.path, "rev-parse", "HEAD");
  git(workspace.path, "push", "-u", "origin", workspace.branch);

  if (conflicting) writeFileSync(join(repo, "README.md"), "base update\n");
  else writeFileSync(join(repo, "base.txt"), "base update\n");
  git(repo, "add", "--all");
  git(repo, "commit", "-m", "advance base");
  git(repo, "push", "origin", "main");
  const updatedBaseSha = git(repo, "rev-parse", "HEAD");
  return { root, manager, workspace, headSha, baseSha, updatedBaseSha };
}

async function removeRemoteBaseIntegrationFixture(fixture: Awaited<ReturnType<typeof remoteBaseIntegrationFixture>>): Promise<void> {
  try {
    await fixture.manager.remove(fixture.workspace);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

function advanceRemoteBase(fixture: Awaited<ReturnType<typeof remoteBaseIntegrationFixture>>, contents: string): string {
  const repo = join(fixture.root, "repo");
  writeFileSync(join(repo, "README.md"), contents);
  git(repo, "add", "--all");
  git(repo, "commit", "-m", "advance base again");
  git(repo, "push", "origin", "main");
  return git(repo, "rev-parse", "HEAD");
}

describe("isolated Git worktrees", () => {
  it("reclaims a repository metadata lock immediately when its owner is dead", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-git-dead-owner-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");

    const lockPath = join(repo, ".forgedock", "git-metadata.lock");
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ pid: 999_999, token: "dead", startedAt: Date.now() }));
    utimesSync(lockPath, new Date(), new Date());

    const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
    const workspace = await manager.recover({ runId: "run_dead_owner", issue: 91, baseRef: "HEAD" });

    assert.equal(workspace.branch, "forgedock/issue-91-run_dead_owner");
    assert.equal(existsSync(lockPath), false);
  });

  it("creates, inspects, commits and removes a managed worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-git-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    writeFileSync(join(repo, "README.md"), "base\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "worktree-fixture", version: "1.0.0", dependencies: { example: "file:vendor/example" } }));
    mkdirSync(join(repo, "vendor", "example"), { recursive: true });
    writeFileSync(join(repo, "vendor", "example", "package.json"), JSON.stringify({ name: "example", version: "1.0.0" }));
    writeFileSync(join(repo, "vendor", "example", "index.js"), "export {};\n");
    execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repo, stdio: "ignore", shell: process.platform === "win32" });
    git(repo, "add", "README.md", "package.json", "package-lock.json", "vendor/example");
    git(repo, "commit", "-m", "base");

    const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
    const workspace = await manager.create({ runId: "run_test", issue: 12, baseRef: "HEAD" });
    assert.equal(existsSync(join(workspace.path, "node_modules", "example", "package.json")), true);
    writeFileSync(join(workspace.path, "feature.txt"), "partial implementation\n");
    // A success stamp must not hide a partial tree left by an interrupted npm
    // operation. Recovery should reinstall the missing direct package entry.
    const partialPackage = join(workspace.path, "node_modules", "example");
    if (lstatSync(partialPackage).isSymbolicLink()) unlinkSync(partialPackage);
    else rmSync(partialPackage, { recursive: true, force: true });
    mkdirSync(partialPackage);
    writeFileSync(join(partialPackage, "package.json"), JSON.stringify({ name: "example", version: "1.0.0", main: "index.js" }));
    const staleDependencyLock = join(workspace.path, ".forgedock", "dependencies-install.lock");
    mkdirSync(staleDependencyLock, { recursive: true });
    const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1_000);
    utimesSync(staleDependencyLock, staleAt, staleAt);
    const recovered = await manager.recover({ runId: "run_test", issue: 12, baseRef: "HEAD" });
    assert.equal(existsSync(staleDependencyLock), false, "a dead stale dependency lease must be reclaimed before reinstall");
    assert.equal(existsSync(join(recovered.path, "node_modules", "example", "index.js")), true);
    assert.deepEqual(recovered, workspace);
    assert.equal(readFileSync(join(recovered.path, "feature.txt"), "utf8"), "partial implementation\n");

    // The in-memory queue cannot serialize independent controller processes.
    // Force two workers through the same worktree so the on-disk lease is the
    // only protection against concurrent destructive npm ci operations.
    const managerEntry = fileURLToPath(new URL("./git-worktree.js", import.meta.url));
    const dependencyWorker = join(root, "prepare-dependencies.mjs");
    writeFileSync(dependencyWorker, [
      `import { GitWorktreeManager } from ${JSON.stringify(pathToFileURL(managerEntry).href)};`,
      "const [repo, worktreeRoot, path] = process.argv.slice(2);",
      "await new GitWorktreeManager(repo, worktreeRoot).prepareWorkspaceDependencies({ path, branch: 'forgedock/test', baseRef: 'HEAD', baseSha: 'HEAD' });",
    ].join("\n"));
    const dependencyStamp = join(workspace.path, ".forgedock", "dependency-install.json");
    rmSync(dependencyStamp, { force: true });
    const prepareInChild = () => new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [dependencyWorker, repo, join(root, "worktrees"), workspace.path], {
        cwd: repo,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stderr }));
    });
    const dependencyWorkers = await Promise.all([prepareInChild(), prepareInChild()]);
    for (const result of dependencyWorkers) assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(workspace.path, "node_modules", "example", "index.js")), true);
    assert.equal(existsSync(dependencyStamp), true);
    assert.equal(existsSync(join(workspace.path, ".forgedock", "dependencies-install.lock")), false);

    writeFileSync(join(workspace.path, "feature.txt"), "implemented\n");
    renameSync(join(workspace.path, "README.md"), join(workspace.path, "GUIDE.md"));
    mkdirSync(join(workspace.path, "docs", "pipeline-probes"), { recursive: true });
    writeFileSync(join(workspace.path, "docs", "pipeline-probes", "receipt.md"), "probe\n");
    mkdirSync(join(workspace.path, ".pi-subagents", "artifacts"), { recursive: true });
    writeFileSync(join(workspace.path, ".pi-subagents", "artifacts", "review.jsonl"), "operational\n");
    mkdirSync(join(workspace.path, ".forgedock"), { recursive: true });
    writeFileSync(join(workspace.path, ".forgedock", "state.db"), "operational\n");
    assert.deepEqual(await manager.changedPaths(workspace), ["GUIDE.md", "README.md", "docs/pipeline-probes/receipt.md", "feature.txt"]);
    const hooks = git(repo, "rev-parse", "--git-path", "hooks");
    const preCommit = join(repo, hooks, "pre-commit");
    writeFileSync(preCommit, "#!/bin/sh\nprintf 'hook-mutated\\n' > feature.txt\ngit add feature.txt\n");
    chmodSync(preCommit, 0o755);
    const sha = await manager.commit(workspace, "feat: implement issue 12");
    assert.match(sha, /^[0-9a-f]{40,64}$/);
    assert.equal(git(workspace.path, "show", `${sha}:feature.txt`), "implemented", "controller commits disable repository hooks");
    assert.equal(await manager.head(workspace), sha);
    assert.deepEqual(await manager.revisionChangedPaths(workspace), ["GUIDE.md", "README.md", "docs/pipeline-probes/receipt.md", "feature.txt"]);
    const recoveredAfterCommit = await manager.recover({ runId: "run_test", issue: 12, baseRef: "HEAD" });
    assert.equal(recoveredAfterCommit.baseSha, workspace.baseSha);
    assert.deepEqual(await manager.revisionChangedPaths(recoveredAfterCommit), ["GUIDE.md", "README.md", "docs/pipeline-probes/receipt.md", "feature.txt"]);
    assert.deepEqual(git(workspace.path, "show", "--pretty=", "--name-only").split(/\r?\n/).filter(Boolean).sort(), [
      "GUIDE.md",
      "docs/pipeline-probes/receipt.md",
      "feature.txt",
    ]);
    await manager.remove(workspace);
    assert.equal(existsSync(join(repo, "vendor", "example", "index.js")), true);
    assert.doesNotMatch(git(repo, "worktree", "list", "--porcelain"), new RegExp(workspace.branch.replaceAll("/", "\\/")));
  });

  it("applies only the pinned ForgeDock dependency patch after script-free installation", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-git-patch-"));
    const repo = join(root, "repo");
    try {
      execFileSync("git", ["init", repo], { stdio: "ignore" });
      git(repo, "config", "user.name", "ForgeDock Test");
      git(repo, "config", "user.email", "forgedock@example.invalid");
      writeFileSync(join(repo, "README.md"), "base\n");
      writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "patch-fixture", version: "1.0.0" }));
      execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repo, stdio: "ignore", shell: process.platform === "win32" });
      mkdirSync(join(repo, "scripts"), { recursive: true });
      writeFileSync(join(repo, "scripts", "patch-pi-subagents-visibility.mjs"),
        'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync("node_modules", { recursive: true }); writeFileSync("node_modules/.forgedock-patch", "applied");\n');
      git(repo, "add", "README.md", "package.json", "package-lock.json", "scripts/patch-pi-subagents-visibility.mjs");
      git(repo, "commit", "-m", "base");

      const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
      const workspace = await manager.create({ runId: "run_patch", issue: 15, baseRef: "HEAD" });
      assert.equal(readFileSync(join(workspace.path, "node_modules", ".forgedock-patch"), "utf8"), "applied");
      await manager.remove(workspace);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores npm bin modes without hiding real tracked mode changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-git-bin-mode-"));
    const repo = join(root, "repo");
    try {
      execFileSync("git", ["init", repo], { stdio: "ignore" });
      git(repo, "config", "user.name", "ForgeDock Test");
      git(repo, "config", "user.email", "forgedock@example.invalid");
      writeFileSync(join(repo, "README.md"), "base\n");
      writeFileSync(join(repo, "package.json"), JSON.stringify({
        name: "bin-mode-fixture",
        version: "1.0.0",
        bin: { launcher: "bin/launcher.js" },
        dependencies: { "bin-fixture": "file:vendor/bin-fixture" },
      }));
      mkdirSync(join(repo, "bin"), { recursive: true });
      writeFileSync(join(repo, "bin", "launcher.js"), "#!/usr/bin/env node\n");
      chmodSync(join(repo, "bin", "launcher.js"), 0o755);
      mkdirSync(join(repo, "vendor", "bin-fixture", "bin"), { recursive: true });
      writeFileSync(join(repo, "vendor", "bin-fixture", "package.json"), JSON.stringify({
        name: "bin-fixture", version: "1.0.0", bin: { "bin-fixture": "bin/cli.js" },
      }));
      writeFileSync(join(repo, "vendor", "bin-fixture", "bin", "cli.js"), "#!/usr/bin/env node\n");
      // npm ci makes this file executable because it is a package bin target.
      // Keep the committed mode non-executable to prove the side effect is
      // restored to Git's verified delivery mode.
      chmodSync(join(repo, "vendor", "bin-fixture", "bin", "cli.js"), 0o644);
      writeFileSync(join(repo, "src.js"), "export {};\n");
      execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: repo, stdio: "ignore", shell: process.platform === "win32" });
      git(repo, "add", "README.md", "package.json", "package-lock.json", "bin", "vendor", "src.js");
      git(repo, "commit", "-m", "base");

      const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
      const workspace = await manager.create({ runId: "run_bin_mode", issue: 17, baseRef: "HEAD" });
      const dependencyBin = join(workspace.path, "vendor", "bin-fixture", "bin", "cli.js");
      const launcher = join(workspace.path, "bin", "launcher.js");
      assert.equal(lstatSync(dependencyBin).mode & 0o111, 0, "npm's dependency bin chmod must not dirty the tracked source");
      assert.notEqual(lstatSync(launcher).mode & 0o111, 0, "an intended executable launcher must remain executable");
      assert.deepEqual(await manager.changedPaths(workspace), []);

      chmodSync(join(workspace.path, "src.js"), 0o755);
      await manager.prepareWorkspaceDependencies(workspace);
      assert.notEqual(lstatSync(launcher).mode & 0o111, 0);
      assert.notEqual(lstatSync(join(workspace.path, "src.js")).mode & 0o111, 0, "real tracked mode changes remain visible");
      assert.deepEqual(await manager.changedPaths(workspace), ["src.js"]);
      await manager.remove(workspace);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects clean-filter transformations between verified bytes and committed blobs", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-git-filter-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    git(repo, "config", "filter.corrupt.clean", "sed s/VERIFIED/MALICIOUS/g");
    writeFileSync(join(repo, ".gitattributes"), "src/a.txt filter=corrupt\n");
    git(repo, "add", ".gitattributes");
    git(repo, "commit", "-m", "base");
    const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
    const workspace = await manager.create({ runId: "run_filter", issue: 14, baseRef: "HEAD" });
    mkdirSync(join(workspace.path, "src"), { recursive: true });
    const path = "src/a.txt";
    writeFileSync(join(workspace.path, path), "VERIFIED\n");
    await assert.rejects(
      manager.commit(workspace, "test clean filter"),
      /Repository clean filter 'corrupt' is not permitted/,
    );
    assert.equal(readFileSync(join(workspace.path, path), "utf8"), "VERIFIED\n");
    await manager.remove(workspace);
  });

  it("rejects mode-120000 committed delivery entries before the hash-object fallback", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-git-symlink-proof-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");
    const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
    const workspace = await manager.create({ runId: "run_symlink_proof", issue: 16, baseRef: "HEAD" });
    const path = "escape";
    try {
      // The index entry deliberately carries an escaping link target. Keeping
      // matching bytes in the worktree makes the old hash-object fallback
      // return true even for a deliberately mismatching expected digest.
      writeFileSync(join(workspace.path, path), "../../outside/secret\n");
      const blob = git(workspace.path, "hash-object", "-w", "--", path);
      git(workspace.path, "update-index", "--add", "--cacheinfo", `120000,${blob},${path}`);
      git(workspace.path, "commit", "-m", "add escaping link entry");
      const revision = git(workspace.path, "rev-parse", "HEAD");
      assert.equal(
        await manager.committedContentMatches(workspace, [path], "0".repeat(64), revision),
        false,
      );
    } finally {
      await manager.remove(workspace);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the fetched origin tip instead of a stale remote-tracking ref", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-git-fetch-"));
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    writeFileSync(join(repo, "README.md"), "base\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");
    git(repo, "branch", "-M", "main");
    const baseSha = git(repo, "rev-parse", "HEAD");
    git(repo, "remote", "add", "origin", remote);
    git(repo, "push", "-u", "origin", "main");
    writeFileSync(join(repo, "README.md"), "fetched\n");
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, ".githooks", "pre-push"), "#!/bin/sh\nexit 91\n");
    chmodSync(join(repo, ".githooks", "pre-push"), 0o755);
    git(repo, "add", "README.md", ".githooks/pre-push");
    git(repo, "update-index", "--chmod=+x", ".githooks/pre-push");
    git(repo, "commit", "-m", "remote update");
    const fetchedSha = git(repo, "rev-parse", "HEAD");
    git(repo, "push", "origin", "main");
    git(repo, "update-ref", "refs/remotes/origin/main", baseSha);
    git(repo, "config", "core.hooksPath", ".githooks");

    const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
    const workspace = await manager.create({ runId: "run_fetch", issue: 13, baseRef: "origin/main" });
    assert.equal(workspace.baseSha, fetchedSha);
    assert.equal(
      git(repo, "rev-parse", "refs/remotes/origin/main"),
      baseSha,
      "authoritative base discovery must not mutate the checkout's shared tracking ref",
    );
    const parallel = await Promise.all([14, 15, 16, 17].map((issue) => manager.create({
      runId: `run_parallel_fetch_${issue}`,
      issue,
      baseRef: "origin/main",
    })));
    assert.deepEqual(parallel.map((candidate) => candidate.baseSha), [fetchedSha, fetchedSha, fetchedSha, fetchedSha]);
    assert.equal(git(repo, "rev-parse", "refs/remotes/origin/main"), baseSha);
    const managerEntry = fileURLToPath(new URL("./git-worktree.js", import.meta.url));
    const createWorker = join(root, "create-worktree.mjs");
    writeFileSync(createWorker, [
      `import { GitWorktreeManager } from ${JSON.stringify(pathToFileURL(managerEntry).href)};`,
      "const [repo, worktreeRoot, issue] = process.argv.slice(2);",
      "const workspace = await new GitWorktreeManager(repo, worktreeRoot).create({ runId: `run_process_fetch_${issue}`, issue: Number(issue), baseRef: 'origin/main' });",
      "process.stdout.write(JSON.stringify(workspace));",
    ].join("\n"));
    const createInChild = (issue: number) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [createWorker, repo, join(root, "worktrees"), String(issue)], {
        cwd: repo,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    const processResults = await Promise.all([18, 19, 20, 21].map(createInChild));
    const processWorkspaces = processResults.map((result) => {
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as typeof workspace;
    });
    assert.deepEqual(processWorkspaces.map((candidate) => candidate.baseSha), [fetchedSha, fetchedSha, fetchedSha, fetchedSha]);
    assert.equal(git(repo, "rev-parse", "refs/remotes/origin/main"), baseSha);
    assert.equal(
      readFileSync(join(workspace.path, "README.md"), "utf8").replaceAll("\r\n", "\n"),
      "fetched\n",
    );
    assert.equal(await manager.isAncestor(workspace, baseSha, fetchedSha), true);
    assert.equal(await manager.isAncestor(workspace, fetchedSha, baseSha), false);
    await manager.push(workspace);
    for (const candidate of processWorkspaces) await manager.remove(candidate);
    for (const candidate of parallel) await manager.remove(candidate);
    await manager.remove(workspace);
  });

  it("rejects recovery when the frozen workspace base does not belong to the requested lane", async () => {
    const root = mkdtempSync(join(tmpdir(), "forgedock-git-lane-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "ForgeDock Test");
    git(repo, "config", "user.email", "forgedock@example.invalid");
    writeFileSync(join(repo, "README.md"), "old base\n");
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "old base");
    const oldBase = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "README.md"), "new default base\n");
    git(repo, "commit", "-am", "new base");
    git(repo, "branch", "milestone/old-lane", oldBase);

    const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
    const workspace = await manager.create({ runId: "run_lane", issue: 6, baseRef: "HEAD" });
    const frozenBase = workspace.baseSha;
    assert.ok(frozenBase);
    await assert.rejects(
      manager.recover({
        runId: "run_lane",
        issue: 6,
        baseRef: "milestone/old-lane",
        baseSha: frozenBase,
      }),
      /does not belong to target ref milestone\/old-lane/,
    );
    await manager.remove(workspace);
  });

  it("integrates an exact remote base into a clean delivery workspace", async () => {
    const fixture = await remoteBaseIntegrationFixture(false);
    try {
      const result = await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });

      assert.deepEqual(result.conflictPaths, []);
      assert.equal(result.mergeCommitExists, false);
      assert.equal(result.workspace.baseSha, fixture.updatedBaseSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "MERGE_HEAD"), fixture.updatedBaseSha);
      assert.equal(readFileSync(join(fixture.workspace.path, "base.txt"), "utf8"), "base update\n");
      assert.equal(readFileSync(join(fixture.workspace.path, "feature.txt"), "utf8"), "delivery\n");
      assert.deepEqual(await fixture.manager.unmergedPaths(fixture.workspace), []);
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("leaves exact conflict paths and the merge checkpoint for bounded resolution", async () => {
    const fixture = await remoteBaseIntegrationFixture(true);
    try {
      const result = await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });

      assert.deepEqual(result.conflictPaths, ["README.md"]);
      assert.equal(result.mergeCommitExists, false);
      assert.equal(result.workspace.baseSha, fixture.updatedBaseSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "MERGE_HEAD"), fixture.updatedBaseSha);
      assert.match(git(fixture.workspace.path, "status", "--porcelain"), /UU README\.md/);
      assert.deepEqual(await fixture.manager.unmergedPaths(fixture.workspace), ["README.md"]);
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("reports only unresolved index paths after resolution, excluding staged target paths", async () => {
    const fixture = await remoteBaseIntegrationFixture(true);
    try {
      await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });

      assert.deepEqual(await fixture.manager.unmergedPaths(fixture.workspace), ["README.md"]);
      await assert.rejects(
        fixture.manager.stageConflictResolutions(fixture.workspace, ["README.md"]),
        /git --literal-pathspecs failed/,
      );
      assert.deepEqual(await fixture.manager.unmergedPaths(fixture.workspace), ["README.md"]);

      writeFileSync(join(fixture.workspace.path, "README.md"), "resolved delivery and base\n");
      await fixture.manager.stageConflictResolutions(fixture.workspace, ["README.md"]);

      assert.deepEqual(await fixture.manager.unmergedPaths(fixture.workspace), []);
      assert.deepEqual(await fixture.manager.changedPaths(fixture.workspace), ["README.md"]);
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("rejects stale delivery and remote-base evidence without mutating the workspace", async () => {
    const staleHead = await remoteBaseIntegrationFixture(false);
    try {
      await assert.rejects(
        staleHead.manager.integrateRemoteBase(staleHead.workspace, {
          expectedHeadSha: staleHead.baseSha,
          expectedBaseSha: staleHead.updatedBaseSha,
        }),
        /does not match expected delivery head/,
      );
      assert.equal(git(staleHead.workspace.path, "rev-parse", "HEAD"), staleHead.headSha);
      assert.equal(git(staleHead.workspace.path, "status", "--porcelain"), "");
    } finally {
      await removeRemoteBaseIntegrationFixture(staleHead);
    }

    const staleBase = await remoteBaseIntegrationFixture(false);
    try {
      await assert.rejects(
        staleBase.manager.integrateRemoteBase(staleBase.workspace, {
          expectedHeadSha: staleBase.headSha,
          expectedBaseSha: staleBase.baseSha,
        }),
        /resolved to .*expected/,
      );
      assert.equal(git(staleBase.workspace.path, "rev-parse", "HEAD"), staleBase.headSha);
      assert.equal(git(staleBase.workspace.path, "status", "--porcelain"), "");
    } finally {
      await removeRemoteBaseIntegrationFixture(staleBase);
    }
  });

  it("re-enters an exact in-progress merge without repeating or losing conflicts", async () => {
    const fixture = await remoteBaseIntegrationFixture(true);
    try {
      const first = await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });
      const second = await fixture.manager.integrateRemoteBase(first.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });

      assert.deepEqual(second.conflictPaths, ["README.md"]);
      assert.equal(second.mergeCommitExists, false);
      assert.equal(second.workspace.baseSha, fixture.updatedBaseSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "HEAD"), fixture.headSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "MERGE_HEAD"), fixture.updatedBaseSha);
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("supersedes an ancestor merge checkpoint only after proving the reviewed head and retained base", async () => {
    const fixture = await remoteBaseIntegrationFixture(true);
    try {
      const first = await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });
      const newerBaseSha = advanceRemoteBase(fixture, "base update newer\n");

      const superseded = await fixture.manager.integrateRemoteBase(first.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: newerBaseSha,
      });

      assert.deepEqual(superseded.conflictPaths, ["README.md"]);
      assert.equal(superseded.mergeCommitExists, false);
      assert.equal(superseded.workspace.baseSha, newerBaseSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "HEAD"), fixture.headSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "MERGE_HEAD"), newerBaseSha);
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("supersedes a stale merge after restart with the immutable frozen base", async () => {
    const fixture = await remoteBaseIntegrationFixture(true);
    try {
      await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });
      const newerBaseSha = advanceRemoteBase(fixture, "base update newer\n");

      // A new controller reconstructs the workspace from the durable
      // BuildResult base while MERGE_HEAD retains the prior target checkpoint.
      const restartedManager = new GitWorktreeManager(
        join(fixture.root, "repo"),
        join(fixture.root, "worktrees"),
      );
      const recovered = await restartedManager.recover({
        runId: "run_integrate_base",
        issue: 22,
        baseRef: "origin/main",
        baseSha: fixture.baseSha,
      });
      const superseded = await restartedManager.integrateRemoteBase(recovered, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: newerBaseSha,
      });

      assert.deepEqual(superseded.conflictPaths, ["README.md"]);
      assert.equal(superseded.mergeCommitExists, false);
      assert.equal(superseded.workspace.baseSha, newerBaseSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "HEAD"), fixture.headSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "MERGE_HEAD"), newerBaseSha);
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("rejects merge supersession when the retained checkpoint lineage or target ancestry is stale", async () => {
    const mismatched = await remoteBaseIntegrationFixture(true);
    try {
      const first = await mismatched.manager.integrateRemoteBase(mismatched.workspace, {
        expectedHeadSha: mismatched.headSha,
        expectedBaseSha: mismatched.updatedBaseSha,
      });
      const newerBaseSha = advanceRemoteBase(mismatched, "base update newer\n");
      const repo = join(mismatched.root, "repo");
      const tree = git(repo, "rev-parse", "HEAD^{tree}");
      const unrelatedFrozenBaseSha = gitWithInput(repo, "unrelated frozen base\n", "commit-tree", tree, "-p", mismatched.baseSha);

      await assert.rejects(
        mismatched.manager.integrateRemoteBase({ ...first.workspace, baseSha: unrelatedFrozenBaseSha }, {
          expectedHeadSha: mismatched.headSha,
          expectedBaseSha: newerBaseSha,
        }),
        /merge checkpoint .* is not a descendant of frozen workspace base .*supersession/,
      );
      assert.equal(git(mismatched.workspace.path, "rev-parse", "MERGE_HEAD"), mismatched.updatedBaseSha);
    } finally {
      await removeRemoteBaseIntegrationFixture(mismatched);
    }

    const diverged = await remoteBaseIntegrationFixture(true);
    try {
      const first = await diverged.manager.integrateRemoteBase(diverged.workspace, {
        expectedHeadSha: diverged.headSha,
        expectedBaseSha: diverged.updatedBaseSha,
      });
      const repo = join(diverged.root, "repo");
      const tree = git(repo, "rev-parse", "HEAD^{tree}");
      const unrelatedBaseSha = gitWithInput(repo, "diverged base\n", "commit-tree", tree, "-p", diverged.baseSha);
      git(repo, "update-ref", "refs/heads/main", unrelatedBaseSha);
      git(repo, "push", "--force", "origin", "main");

      await assert.rejects(
        diverged.manager.integrateRemoteBase(first.workspace, {
          expectedHeadSha: diverged.headSha,
          expectedBaseSha: unrelatedBaseSha,
        }),
        /not an ancestor of requested remote base .*supersession/,
      );
      assert.equal(git(diverged.workspace.path, "rev-parse", "MERGE_HEAD"), diverged.updatedBaseSha);
    } finally {
      await removeRemoteBaseIntegrationFixture(diverged);
    }
  });

  it("rejects unrelated dirty paths before aborting a stale merge checkpoint", async () => {
    const fixture = await remoteBaseIntegrationFixture(true);
    try {
      const first = await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });
      const newerBaseSha = advanceRemoteBase(fixture, "base update newer\n");
      writeFileSync(join(fixture.workspace.path, "unrelated.txt"), "do not discard\n");

      await assert.rejects(
        fixture.manager.integrateRemoteBase(first.workspace, {
          expectedHeadSha: fixture.headSha,
          expectedBaseSha: newerBaseSha,
        }),
        /unrelated dirty paths: unrelated\.txt/,
      );
      assert.equal(git(fixture.workspace.path, "rev-parse", "HEAD"), fixture.headSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "MERGE_HEAD"), fixture.updatedBaseSha);
      assert.equal(readFileSync(join(fixture.workspace.path, "unrelated.txt"), "utf8"), "do not discard\n");
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("rejects an advanced HEAD even when the exact MERGE_HEAD remains", async () => {
    const fixture = await remoteBaseIntegrationFixture(true);
    try {
      await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });
      const tree = git(fixture.workspace.path, "rev-parse", "HEAD^{tree}");
      const advancedHead = gitWithInput(
        fixture.workspace.path,
        "unexpected advanced delivery\n",
        "commit-tree",
        tree,
        "-p",
        fixture.headSha,
      );
      git(fixture.workspace.path, "reset", "--hard", advancedHead);
      restoreMergeHead(fixture.workspace.path, fixture.updatedBaseSha);

      await assert.rejects(
        fixture.manager.integrateRemoteBase(fixture.workspace, {
          expectedHeadSha: fixture.headSha,
          expectedBaseSha: fixture.updatedBaseSha,
        }),
        /does not match expected delivery head .* while merge .* is in progress/,
      );
      assert.equal(git(fixture.workspace.path, "rev-parse", "HEAD"), advancedHead);
      assert.equal(git(fixture.workspace.path, "rev-parse", "MERGE_HEAD"), fixture.updatedBaseSha);
      assert.equal(git(fixture.workspace.path, "status", "--porcelain"), "");
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("rejects a reset HEAD even when the exact MERGE_HEAD remains", async () => {
    const fixture = await remoteBaseIntegrationFixture(true);
    try {
      await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });
      git(fixture.workspace.path, "reset", "--hard", fixture.baseSha);
      restoreMergeHead(fixture.workspace.path, fixture.updatedBaseSha);

      await assert.rejects(
        fixture.manager.integrateRemoteBase(fixture.workspace, {
          expectedHeadSha: fixture.headSha,
          expectedBaseSha: fixture.updatedBaseSha,
        }),
        /does not match expected delivery head .* while merge .* is in progress/,
      );
      assert.equal(git(fixture.workspace.path, "rev-parse", "HEAD"), fixture.baseSha);
      assert.equal(git(fixture.workspace.path, "rev-parse", "MERGE_HEAD"), fixture.updatedBaseSha);
      assert.equal(git(fixture.workspace.path, "status", "--porcelain"), "");
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("recognizes an exact completed merge commit after crash re-entry", async () => {
    const fixture = await remoteBaseIntegrationFixture(true);
    try {
      const integrated = await fixture.manager.integrateRemoteBase(fixture.workspace, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });
      assert.equal(integrated.mergeCommitExists, false);
      writeFileSync(join(fixture.workspace.path, "README.md"), "resolved delivery\n");
      git(fixture.workspace.path, "add", "README.md");
      const mergeSha = await fixture.manager.commit(integrated.workspace, "resolve target synchronization");
      assert.deepEqual(git(fixture.workspace.path, "rev-list", "--parents", "-n", "1", mergeSha).split(/\s+/u), [
        mergeSha,
        fixture.headSha,
        fixture.updatedBaseSha,
      ]);

      // A fresh adapter instance models the controller process restarting
      // after the merge commit was durably created but before its checkpoint
      // advanced.
      const restartedManager = new GitWorktreeManager(
        join(fixture.root, "repo"),
        join(fixture.root, "worktrees"),
      );
      const recovered = await restartedManager.recover({
        runId: "run_integrate_base",
        issue: 22,
        baseRef: "origin/main",
        baseSha: fixture.updatedBaseSha,
      });
      const reentered = await restartedManager.integrateRemoteBase(recovered, {
        expectedHeadSha: fixture.headSha,
        expectedBaseSha: fixture.updatedBaseSha,
      });

      assert.equal(reentered.mergeCommitExists, true);
      assert.deepEqual(reentered.conflictPaths, []);
      assert.equal(reentered.workspace.baseSha, fixture.updatedBaseSha);
      assert.equal(await restartedManager.head(reentered.workspace), mergeSha);
    } finally {
      await removeRemoteBaseIntegrationFixture(fixture);
    }
  });

  it("fails closed for unrelated and parent-swapped merge commits", async () => {
    const unrelated = await remoteBaseIntegrationFixture(false);
    try {
      const tree = git(unrelated.workspace.path, "rev-parse", "HEAD^{tree}");
      const unrelatedMerge = gitWithInput(
        unrelated.workspace.path,
        "unrelated merge\n",
        "commit-tree",
        tree,
        "-p",
        unrelated.headSha,
        "-p",
        unrelated.baseSha,
      );
      git(unrelated.workspace.path, "reset", "--hard", unrelatedMerge);
      await assert.rejects(
        unrelated.manager.integrateRemoteBase(unrelated.workspace, {
          expectedHeadSha: unrelated.headSha,
          expectedBaseSha: unrelated.updatedBaseSha,
        }),
        /does not match expected delivery head/,
      );
      assert.equal(git(unrelated.workspace.path, "rev-parse", "HEAD"), unrelatedMerge);
      assert.equal(git(unrelated.workspace.path, "status", "--porcelain"), "");
    } finally {
      await removeRemoteBaseIntegrationFixture(unrelated);
    }

    const parentSwapped = await remoteBaseIntegrationFixture(false);
    try {
      const tree = git(parentSwapped.workspace.path, "rev-parse", "HEAD^{tree}");
      const swappedMerge = gitWithInput(
        parentSwapped.workspace.path,
        "parent swapped merge\n",
        "commit-tree",
        tree,
        "-p",
        parentSwapped.updatedBaseSha,
        "-p",
        parentSwapped.headSha,
      );
      git(parentSwapped.workspace.path, "reset", "--hard", swappedMerge);
      await assert.rejects(
        parentSwapped.manager.integrateRemoteBase(parentSwapped.workspace, {
          expectedHeadSha: parentSwapped.headSha,
          expectedBaseSha: parentSwapped.updatedBaseSha,
        }),
        /does not match expected delivery head/,
      );
      assert.equal(git(parentSwapped.workspace.path, "rev-parse", "HEAD"), swappedMerge);
      assert.equal(git(parentSwapped.workspace.path, "status", "--porcelain"), "");
    } finally {
      await removeRemoteBaseIntegrationFixture(parentSwapped);
    }
  });
});
