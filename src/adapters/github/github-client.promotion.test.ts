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
});
