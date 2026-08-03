import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    git(repo, "add", "README.md");
    git(repo, "commit", "-m", "base");

    const manager = new GitWorktreeManager(repo, join(root, "worktrees"));
    const workspace = await manager.create({ runId: "run_test", issue: 12, baseRef: "HEAD" });
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
    assert.deepEqual(git(workspace.path, "show", "--pretty=", "--name-only").split(/\r?\n/).filter(Boolean).sort(), [
      "docs/pipeline-probes/receipt.md",
      "feature.txt",
    ]);
    await manager.remove(workspace);
    assert.doesNotMatch(git(repo, "worktree", "list", "--porcelain"), new RegExp(workspace.branch.replaceAll("/", "\\/")));
  });
});
