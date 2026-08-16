// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_REVIEW_CI } from "../../core/config/forgedock-config.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, PullRequestRepairWorkspaceManager } from "../../core/ports/git-workspace.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { PullRequestCiBlockedError } from "./ci-policy.js";
import { makePullRequestCiGreen } from "./fix-ci.js";
const first = "a".repeat(40), repaired = "b".repeat(40);
class Host { sha = first; states: PullRequestMergeGate["requiredChecks"][] = [[{ name: "CI", state: "failed" }], [{ name: "CI", state: "passed" }]]; cross = false; async getPullRequest(): Promise<PullRequestSnapshot> { return { repo: "a/b", number: 8, title: "PR", body: "", url: "https://github.com/a/b/pull/8", state: "OPEN", headSha: this.sha, headBranch: "fix/ci", baseBranch: "main" }; } async getPullRequestMergeGate() { return { repo: "a/b", pullRequest: 8, headSha: this.sha, baseBranch: "main", mergeable: true, requiredChecks: this.states.shift()!, observedAt: new Date().toISOString() }; } async getPullRequestHeadRepository() { return { repo: this.cross ? "fork/b" : "a/b", isCrossRepository: this.cross }; } async getPullRequestCheckDiagnostics() { return [{ name: "CI", state: "failed" as const, logExcerpt: "assertion failed" }]; } async getPullRequestDiff() { return "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts"; } async getBranchHead() { return this.sha; } async publishPullRequestComment() {} }
class Workspaces implements PullRequestRepairWorkspaceManager { pushed = 0; constructor(readonly host: Host) {} async createReview(): Promise<GitWorkspace> { return { path: "C:/repair", branch: "review", baseRef: first, baseSha: first }; } async changedPaths() { return ["src/a.ts"]; } async commit() { return repaired; } async head() { return repaired; } async publishPullRequestRepair() { this.pushed += 1; this.host.sha = repaired; } async remove() {} }
const policy = { ...DEFAULT_REVIEW_CI, failureAction: "auto-fix" as const };
describe("review CI auto-fix", () => {
  it("verifies and publishes one exact-head repair commit", async () => { const host = new Host(); const workspaces = new Workspaces(host); const runtime = new FakeAgentRuntime([{ summary: "Fixed assertion", diagnosis: "stale expectation", changedPaths: ["src/a.ts"] }]); const result = await makePullRequestCiGreen({ repo: "a/b", pullRequest: 8, policy }, { runtime, host: host as unknown as ForgeHost, workspaces, verifier: { async run() { return [{ command: "test", status: "passed", durationMs: 1 }]; } }, verificationCommands: () => [{ id: "test", command: "npm", args: ["test"], timeoutMs: 1000, required: true }], wait: async () => undefined }); assert.equal(result.attempts, 1); assert.equal(workspaces.pushed, 1); assert.match(runtime.tasks[0]?.instructions ?? "", /untrusted evidence/); });
  it("refuses cross-repository heads before allocating a write agent", async () => { const host = new Host(); host.cross = true; const runtime = new FakeAgentRuntime(); await assert.rejects(makePullRequestCiGreen({ repo: "a/b", pullRequest: 8, policy }, { runtime, host: host as unknown as ForgeHost, workspaces: new Workspaces(host), verifier: { async run() { return []; } }, verificationCommands: () => [], wait: async () => undefined }), /refuses cross-repository/); assert.equal(runtime.tasks.length, 0); });
  it("bounds repeated unmatched wildcard absence at maxFixAttempts", async () => {
    const host = new Host();
    host.states = [
      [{ name: "CI", state: "passed" }],
      [{ name: "CI", state: "passed" }],
      [{ name: "CI", state: "passed" }],
    ];
    const workspaces = new Workspaces(host);
    const runtime = new FakeAgentRuntime([
      { summary: "First bounded repair", diagnosis: "missing matching check", changedPaths: ["src/a.ts"] },
      { summary: "Second bounded repair", diagnosis: "missing matching check", changedPaths: ["src/a.ts"] },
    ]);
    let waits = 0;

    await assert.rejects(
      makePullRequestCiGreen(
        { repo: "a/b", pullRequest: 8, policy: { ...policy, maxFixAttempts: 2, deliveryChecks: ["Pipeline *"] } },
        {
          runtime,
          host: host as unknown as ForgeHost,
          workspaces,
          verifier: { async run() { return [{ command: "test", status: "passed", durationMs: 1 }]; } },
          verificationCommands: () => [{ id: "test", command: "npm", args: ["test"], timeoutMs: 1000, required: true }],
          wait: async () => { waits += 1; },
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof PullRequestCiBlockedError);
        assert.match(error.message, /Pipeline \*=unavailable/);
        assert.equal(error.assessment.ready, false);
        return true;
      },
    );

    assert.equal(runtime.tasks.length, 2);
    assert.equal(workspaces.pushed, 2);
    assert.equal(waits, 0);
    assert.equal(host.states.length, 0);
  });
  it("honors an already-aborted signal before starting CI repair", async () => {
    const host = new Host();
    const runtime = new FakeAgentRuntime();
    const signal = AbortSignal.abort(new Error("cancelled before attempt"));

    await assert.rejects(
      makePullRequestCiGreen(
        { repo: "a/b", pullRequest: 8, policy, signal },
        {
          runtime,
          host: host as unknown as ForgeHost,
          workspaces: new Workspaces(host),
          verifier: { async run() { return []; } },
          verificationCommands: () => [],
        },
      ),
      /cancelled before attempt/,
    );
    assert.equal(runtime.tasks.length, 0);
  });
});
