import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { GitWorktreeManager } from "./git-worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

describe("isolated Git worktrees", () => {
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
      readFileSync(join(workspace.path, "README.md"), "utf8").replaceAll("\r\n", "\n"),
      "fetched\n",
    );
    assert.equal(await manager.isAncestor(workspace, baseSha, fetchedSha), true);
    assert.equal(await manager.isAncestor(workspace, fetchedSha, baseSha), false);
    await manager.push(workspace);
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
});
