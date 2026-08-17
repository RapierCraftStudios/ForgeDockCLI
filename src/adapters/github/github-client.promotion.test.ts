import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { GitHubClient } from "./github-client.js";

const sha = "a".repeat(40);
const pr: PullRequestSnapshot = {
  repo: "a/b", number: 8, title: "Promote", body: "<!-- FORGEDOCK:PROMOTION repo=a/b from=staging to=main -->",
  url: "https://github.test/pull/8", state: "OPEN", headSha: sha, headBranch: "staging", baseBranch: "main",
};

describe("GitHub promotion transport", () => {
  it("creates a branch-only PR and requires exact source/target lookup", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[], _body?: string) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "create") return "https://github.test/pull/8";
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "list") return JSON.stringify([{ number: 8 }]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const created = await client.createPromotionPullRequest({ repo: "a/b", headBranch: "staging", baseBranch: "main", title: "Promote", body: pr.body });
    assert.equal(created.number, 8);
    const found = await client.findOpenPromotionPullRequest("a/b", "staging", "main");
    assert.equal(found?.number, 8);
    assert.ok(calls.some((args) => args.includes("--head") && args.includes("staging") && args.includes("--base") && args.includes("main")));
  });

  it("reads mergeability and required check state at the reviewed SHA", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "Unit Tests", state: "SUCCESS", link: "https://github.test/check" }, { name: "Docs", state: "PENDING" }]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(gate.mergeable, true);
    assert.deepEqual(gate.requiredChecks.map((check) => [check.name, check.state]), [["Unit Tests", "passed"], ["Docs", "pending"]]);
  });

  it("does not merge when legacy CodeQL remains pending beside a passing default-setup replacement", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([
        { name: "Analyze (javascript-typescript)", state: "PENDING", link: "https://github.test/actions/runs/legacy" },
        { name: "CodeQL default setup", state: "SUCCESS", link: "https://github.test/actions/runs/default" },
      ]);
      if (args[0] === "pr" && args[1] === "merge") return "";
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });

    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.deepEqual(gate.requiredChecks, [
      { name: "Analyze (javascript-typescript)", state: "pending", detailsUrl: "https://github.test/actions/runs/legacy" },
      { name: "CodeQL default setup", state: "passed", detailsUrl: "https://github.test/actions/runs/default" },
    ]);
    await assert.rejects(
      () => client.mergePullRequest("a/b", 8, sha, "main"),
      /Required GitHub checks are not all passing.*Analyze \(javascript-typescript\)=pending/,
    );
    assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "merge"), false);
  });

  it("normalizes failed, cancelled, pending, stale, and unavailable check observations", async () => {
    const cases = [
      ["FAILURE", "failed"],
      ["CANCELLED", "cancelled"],
      ["IN_PROGRESS", "pending"],
      ["STALE", "failed"],
      ["UNKNOWN_STATE", "unavailable"],
    ] as const;
    for (const [reported, expected] of cases) {
      const client = new GitHubClient();
      Object.defineProperty(client, "gh", { value: async (args: string[]) => {
        if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE" });
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
        if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "CodeQL default setup", state: reported }]);
        throw new Error(`Unexpected gh call: ${args.join(" ")}`);
      } });
      const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
      assert.equal(gate.requiredChecks[0]?.state, expected, reported);
    }
  });

  it("preserves contradictory same-name check runs so a newer success cannot mask a failure", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([
        { name: "Unit tests (node --test)", state: "FAILURE", link: "https://github.test/old", completedAt: "2026-08-14T12:28:55Z" },
        { name: "Unit tests (node --test)", state: "SUCCESS", link: "https://github.test/new", completedAt: "2026-08-14T12:29:13Z" },
      ]);
      if (args[0] === "pr" && args[1] === "merge") return "";
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.deepEqual(gate.requiredChecks, [
      { name: "Unit tests (node --test)", state: "failed", detailsUrl: "https://github.test/old" },
      { name: "Unit tests (node --test)", state: "passed", detailsUrl: "https://github.test/new" },
    ]);
    await assert.rejects(
      () => client.mergePullRequest("a/b", 8, sha, "main"),
      /Required GitHub checks are not all passing.*Unit tests \(node --test\)=failed/,
    );
    assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "merge"), false);
  });

  it("preserves both completed and in-progress same-name observations", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([
        { name: "Unit tests (node --test)", state: "SUCCESS", link: "https://github.test/old", completedAt: "2026-08-14T12:29:13Z", startedAt: "2026-08-14T12:28:17Z" },
        { name: "Unit tests (node --test)", state: "IN_PROGRESS", link: "https://github.test/new", completedAt: "0001-01-01T00:00:00Z", startedAt: "2026-08-14T12:30:00Z" },
      ]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.deepEqual(gate.requiredChecks, [
      { name: "Unit tests (node --test)", state: "passed", detailsUrl: "https://github.test/old" },
      { name: "Unit tests (node --test)", state: "pending", detailsUrl: "https://github.test/new" },
    ]);
  });

  it("keeps API mergeability separate from individual check state", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "Deployment smoke test", state: "FAILURE" }]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(gate.mergeable, true);
    assert.deepEqual(gate.requiredChecks.map((check) => [check.name, check.state]), [["Deployment smoke test", "failed"]]);
  });

  it("falls back to all checks when the branch has no required-check configuration", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks" && args.includes("--required")) throw new Error("gh: no required checks reported on the 'staging' branch");
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([
        { name: "Unit Tests", state: "SUCCESS" },
        { name: "Full corpus", state: "SKIPPED" },
        { name: "Optional advisory", state: "NEUTRAL" },
        { name: "Deployment smoke test", state: "FAILURE" },
      ]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.deepEqual(gate.requiredChecks.map((check) => [check.name, check.state]), [["Unit Tests", "passed"], ["Deployment smoke test", "failed"]]);
  });

  it("rechecks exact SHA/base before merge", async () => {
    const client = new GitHubClient();
    let current = { ...pr };
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: current.number, title: current.title, body: current.body, url: current.url, state: current.state, headRefOid: current.headSha, headRefName: current.headBranch, baseRefName: current.baseBranch });
      if (args[0] === "pr" && args[1] === "checks") return "[]";
      if (args[0] === "pr" && args[1] === "merge") return "";
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await client.mergePullRequest("a/b", 8, sha, "main");
    assert.ok(calls.at(-1)?.includes("--match-head-commit") && calls.at(-1)?.includes(sha));
    current = { ...current, baseBranch: "staging" };
    await assert.rejects(() => client.mergePullRequest("a/b", 8, sha, "main"), /target changed/);
  });

  it("rejects a head race after checks are collected without issuing a merge", async () => {
    const client = new GitHubClient();
    const advancedSha = "b".repeat(40);
    let basicViews = 0;
    let headAdvanced = false;
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (args[0] === "pr" && args[1] === "view") {
        basicViews++;
        const headSha = headAdvanced && basicViews >= 3 ? advancedSha : sha;
        return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: headSha, headRefName: "staging", baseRefName: "main" });
      }
      if (args[0] === "pr" && args[1] === "checks") {
        headAdvanced = true;
        return JSON.stringify([{ name: "CodeQL default setup", state: "SUCCESS" }]);
      }
      if (args[0] === "pr" && args[1] === "merge") return "";
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });

    await assert.rejects(
      () => client.mergePullRequest("a/b", 8, sha, "main"),
      /head changed while reading required checks/,
    );
    assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "merge"), false);
  });

  it("rejects an open-state race after checks are collected without issuing a merge", async () => {
    const client = new GitHubClient();
    let basicViews = 0;
    let closed = false;
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (args[0] === "pr" && args[1] === "view") {
        basicViews++;
        return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: closed && basicViews >= 3 ? "CLOSED" : "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      }
      if (args[0] === "pr" && args[1] === "checks") {
        closed = true;
        return JSON.stringify([{ name: "CodeQL default setup", state: "SUCCESS" }]);
      }
      if (args[0] === "pr" && args[1] === "merge") return "";
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });

    await assert.rejects(
      () => client.mergePullRequest("a/b", 8, sha, "main"),
      /changed state while reading required checks: CLOSED/,
    );
    assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "merge"), false);
  });
});
