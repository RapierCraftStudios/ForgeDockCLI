import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    const recovered = await manager.recover({ runId: "run_test", issue: 12, baseRef: "HEAD" });
    assert.deepEqual(recovered, workspace);
    assert.equal(readFileSync(join(recovered.path, "feature.txt"), "utf8"), "partial implementation\n");
    writeFileSync(join(workspace.path, "feature.txt"), "implemented\n");
    mkdirSync(join(workspace.path, "docs", "pipeline-probes"), { recursive: true });
    writeFileSync(join(workspace.path, "docs", "pipeline-probes", "receipt.md"), "probe\n");
    mkdirSync(join(workspace.path, ".pi-subagents", "artifacts"), { recursive: true });
    writeFileSync(join(workspace.path, ".pi-subagents", "artifacts", "review.jsonl"), "operational\n");
    mkdirSync(join(workspace.path, ".forgedock"), { recursive: true });
    writeFileSync(join(workspace.path, ".forgedock", "state.db"), "operational\n");
    assert.deepEqual(await manager.changedPaths(workspace), ["docs/pipeline-probes/receipt.md", "feature.txt"]);
    const sha = await manager.commit(workspace, "feat: implement issue 12");
    assert.match(sha, /^[0-9a-f]{40,64}$/);
    assert.equal(await manager.head(workspace), sha);
    assert.deepEqual(await manager.revisionChangedPaths(workspace), ["docs/pipeline-probes/receipt.md", "feature.txt"]);
    const recoveredAfterCommit = await manager.recover({ runId: "run_test", issue: 12, baseRef: "HEAD" });
    assert.equal(recoveredAfterCommit.baseSha, workspace.baseSha);
    assert.deepEqual(await manager.revisionChangedPaths(recoveredAfterCommit), ["docs/pipeline-probes/receipt.md", "feature.txt"]);
    assert.deepEqual(git(workspace.path, "show", "--pretty=", "--name-only").split(/\r?\n/).filter(Boolean).sort(), [
      "docs/pipeline-probes/receipt.md",
      "feature.txt",
    ]);
    await manager.remove(workspace);
    assert.equal(existsSync(join(repo, "vendor", "example", "index.js")), true);
    assert.doesNotMatch(git(repo, "worktree", "list", "--porcelain"), new RegExp(workspace.branch.replaceAll("/", "\\/")));
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
