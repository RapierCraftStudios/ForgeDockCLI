import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { GitHubClient } from "./github-client.js";

const sha = "a".repeat(40);
const pr: PullRequestSnapshot = {
  repo: "a/b", number: 8, title: "Promote", body: "<!-- FORGEDOCK:PROMOTION repo=a/b from=staging to=main -->",
  url: "https://github.test/pull/8", state: "OPEN", headSha: sha, headBranch: "staging", baseBranch: "main",
};

function immutableCommitCheckResponse(
  args: readonly string[],
  checks: readonly { name: string; state: string; link?: string }[],
): string | undefined {
  if (args[0] !== "api") return undefined;
  if (args[1]?.includes(`/commits/${sha}/check-runs`)) {
    return JSON.stringify([{ check_runs: checks.map((check) => {
      const state = check.state.toUpperCase();
      const pending = ["PENDING", "QUEUED", "IN_PROGRESS", "REQUESTED", "WAITING"].includes(state);
      const conclusion = ["SUCCESS", "PASSED", "PASS"].includes(state)
        ? "success"
        : ["CANCELLED", "CANCELED"].includes(state)
          ? "cancelled"
          : state === "STALE" ? "stale" : "failure";
      return {
        name: check.name,
        head_sha: sha,
        status: pending ? "in_progress" : "completed",
        conclusion: pending ? null : conclusion,
        ...(check.link ? { html_url: check.link } : {}),
      };
    }) }]);
  }
  if (args[1]?.includes(`/commits/${sha}/status`)) return JSON.stringify({ sha, statuses: [] });
  return undefined;
}

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
    const checks = [{ name: "Unit Tests", state: "SUCCESS", link: "https://github.test/check" }, { name: "Docs", state: "PENDING" }];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checks);
      const immutable = immutableCommitCheckResponse(args, checks);
      if (immutable !== undefined) return immutable;
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(gate.mergeable, true);
    assert.equal(gate.requiredChecksProvenance, "github-required");
    assert.equal(gate.requiredChecksHeadSha, sha);
    assert.deepEqual(gate.requiredChecks.map((check) => [check.name, check.state]), [["Unit Tests", "passed"], ["Docs", "pending"]]);
  });

  it("reads exact immutable required checks for an already merged PR", async () => {
    const client = new GitHubClient();
    const checks = [{ name: "Required CI", state: "SUCCESS", link: "https://github.test/check" }];
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "MERGED", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checks);
      const immutable = immutableCommitCheckResponse(args, checks);
      if (immutable !== undefined) return immutable;
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });

    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(gate.mergeability, "mergeable");
    assert.equal(gate.requiredChecksProvenance, "github-required");
    assert.equal(gate.requiredChecksHeadSha, sha);
    assert.deepEqual(gate.requiredChecks, [{ name: "Required CI", state: "passed", detailsUrl: "https://github.test/check" }]);
    assert.equal(calls.some((args) => args[0] === "pr" && args[1] === "merge"), false);
  });

  it("keeps UNKNOWN distinct from a confirmed conflict and refreshes UNKNOWN only when requested", async () => {
    const client = new GitHubClient();
    let mergeabilityReads = 0;
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        mergeabilityReads += 1;
        return JSON.stringify({ mergeable: mergeabilityReads < 3 ? "UNKNOWN" : "MERGEABLE", mergeStateStatus: "UNKNOWN" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "Required CI", state: "SUCCESS" }]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });

    const unknown = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(unknown.mergeability, "unknown");
    assert.equal(unknown.mergeable, false);
    assert.equal(mergeabilityReads, 1);

    const refreshed = await client.getPullRequestMergeGate("a/b", 8, sha, "main", { refreshUnknown: true });
    assert.equal(refreshed.mergeability, "mergeable");
    assert.equal(refreshed.mergeable, true);
    assert.equal(mergeabilityReads, 3);
  });

  it("preserves an unavailable mergeability query as transport evidence", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) throw new Error("mergeability service unavailable");
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "Required CI", state: "SUCCESS" }]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(gate.mergeability, "unavailable");
    assert.equal(gate.mergeable, false);
    assert.match(gate.mergeabilityReason ?? "", /service unavailable/);
  });

  it("does not merge when legacy CodeQL remains pending beside a passing default-setup replacement", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    const checks = [
      { name: "Analyze (javascript-typescript)", state: "PENDING", link: "https://github.test/actions/runs/legacy" },
      { name: "CodeQL default setup", state: "SUCCESS", link: "https://github.test/actions/runs/default" },
    ];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checks);
      const immutable = immutableCommitCheckResponse(args, checks);
      if (immutable !== undefined) return immutable;
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

  it("normalizes failed, cancelled, pending, and stale required-check observations", async () => {
    const cases = [
      ["FAILURE", "failed"],
      ["CANCELLED", "cancelled"],
      ["IN_PROGRESS", "pending"],
      ["STALE", "failed"],
    ] as const;
    for (const [reported, expected] of cases) {
      const client = new GitHubClient();
      const checks = [{ name: "CodeQL default setup", state: reported }];
      Object.defineProperty(client, "gh", { value: async (args: string[]) => {
        if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE" });
        if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
        if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checks);
        const immutable = immutableCommitCheckResponse(args, checks);
        if (immutable !== undefined) return immutable;
        throw new Error(`Unexpected gh call: ${args.join(" ")}`);
      } });
      const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
      assert.equal(gate.requiredChecks[0]?.state, expected, reported);
    }
  });

  it("rejects required-check observations stamped from another commit", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE" });
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "CI", state: "SUCCESS" }]);
      if (args[0] === "api" && args[1]?.includes("/check-runs")) return JSON.stringify([{ check_runs: [
        { name: "CI", head_sha: "b".repeat(40), status: "completed", conclusion: "success" },
      ] }]);
      if (args[0] === "api" && args[1]?.includes("/status?")) return JSON.stringify({ sha, statuses: [] });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(gate.requiredChecksProvenance, "unavailable");
    assert.equal(gate.requiredChecksHeadSha, undefined);
    assert.match(gate.requiredChecks[0]?.detailsUrl ?? "", /not bound to the expected head SHA/);
  });

  it("marks malformed required-check output as unavailable authority", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE" });
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "CI", state: "UNKNOWN_STATE" }]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(gate.requiredChecksProvenance, "unavailable");
    assert.equal(gate.requiredChecks[0]?.state, "unavailable");
    assert.match(gate.requiredChecks[0]?.detailsUrl ?? "", /unrecognized state/);
  });

  it("preserves contradictory same-name check runs so a newer success cannot mask a failure", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    const checks = [
      { name: "Unit tests (node --test)", state: "FAILURE", link: "https://github.test/old", completedAt: "2026-08-14T12:28:55Z" },
      { name: "Unit tests (node --test)", state: "SUCCESS", link: "https://github.test/new", completedAt: "2026-08-14T12:29:13Z" },
    ];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checks);
      const immutable = immutableCommitCheckResponse(args, checks);
      if (immutable !== undefined) return immutable;
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
    const checks = [
      { name: "Unit tests (node --test)", state: "SUCCESS", link: "https://github.test/old", completedAt: "2026-08-14T12:29:13Z", startedAt: "2026-08-14T12:28:17Z" },
      { name: "Unit tests (node --test)", state: "IN_PROGRESS", link: "https://github.test/new", completedAt: "0001-01-01T00:00:00Z", startedAt: "2026-08-14T12:30:00Z" },
    ];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checks);
      const immutable = immutableCommitCheckResponse(args, checks);
      if (immutable !== undefined) return immutable;
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
    const checks = [{ name: "Deployment smoke test", state: "FAILURE" }];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checks);
      const immutable = immutableCommitCheckResponse(args, checks);
      if (immutable !== undefined) return immutable;
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(gate.mergeable, true);
    assert.deepEqual(gate.requiredChecks.map((check) => [check.name, check.state]), [["Deployment smoke test", "failed"]]);
  });

  it("treats missing required-check configuration as unavailable without querying arbitrary checks", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) {
        return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "UNSTABLE" });
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: 8, title: pr.title, body: pr.body, url: pr.url, state: "OPEN", headRefOid: sha, headRefName: "staging", baseRefName: "main" });
      if (args[0] === "pr" && args[1] === "checks" && args.includes("--required")) throw new Error("gh: no required checks reported on the 'main' branch");
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const gate = await client.getPullRequestMergeGate("a/b", 8, sha, "main");
    assert.equal(gate.requiredChecksProvenance, "unavailable");
    assert.deepEqual(gate.requiredChecks.map((check) => [check.name, check.state]), [["required-checks-query", "unavailable"]]);
    assert.equal(calls.filter((args) => args[0] === "pr" && args[1] === "checks").length, 1);
    assert.equal(calls.find((args) => args[0] === "pr" && args[1] === "checks")?.includes("--required"), true);
  });

  it("rechecks exact SHA/base before merge", async () => {
    const client = new GitHubClient();
    let current = { ...pr };
    const calls: string[][] = [];
    const checks = [{ name: "Required CI", state: "SUCCESS" }];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.join(" ").includes("mergeable")) return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ number: current.number, title: current.title, body: current.body, url: current.url, state: current.state, headRefOid: current.headSha, headRefName: current.headBranch, baseRefName: current.baseBranch });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify(checks);
      const immutable = immutableCommitCheckResponse(args, checks);
      if (immutable !== undefined) return immutable;
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
