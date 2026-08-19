import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { Subject } from "../../core/artifacts/schema.js";
import { renderArtifactComment } from "../../core/artifacts/codec.js";
import type { PlanMaterializationRequest, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { InMemoryRemediationAdmissionRepository } from "../../core/ports/repositories.js";
import { GitHubArtifactRepository, GitHubClient, renderPaginatedPullRequestDiff, repositoryFromRemote, reviewFindingLaneMarker, reviewFindingMarker, reviewFindingReconciliationCandidates, reviewFindingSemanticMarker, workflowLabelForState } from "./github-client.js";

class CommentClient {
  comments = new Map<string, string[]>();
  postCalls = 0;
  failAfterPost = false;
  async listIssueComments(subject: Subject): Promise<string[]> { return this.comments.get(key(subject)) ?? []; }
  async postIssueComment(subject: Subject, body: string): Promise<void> {
    this.postCalls += 1;
    const values = this.comments.get(key(subject)) ?? []; values.push(body); this.comments.set(key(subject), values);
    if (this.failAfterPost) {
      this.failAfterPost = false;
      throw new Error("projection interrupted after remote write");
    }
  }
}
function key(subject: Subject) { return `${subject.repo}#${subject.pr ? `pr${subject.pr}` : `i${subject.issue}`}`; }

describe("GitHub read retry boundary", () => {
  it("retries a transient read failure and returns the eventual result", async () => {
    let attempts = 0;
    const client = new GitHubClient();
    Object.defineProperty(client, "runGh", { value: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("gh repo failed (1): HTTP 503: No server is currently available to service your request");
      return JSON.stringify({ nameWithOwner: "a/b", defaultBranchRef: { name: "main" } });
    } });

    assert.deepEqual(await client.getRepository("a/b"), { repo: "a/b", defaultBranch: "main" });
    assert.equal(attempts, 2);
  });

  it("bounds retries for a persistently unavailable read", async () => {
    let attempts = 0;
    const client = new GitHubClient();
    Object.defineProperty(client, "runGh", { value: async () => {
      attempts += 1;
      throw new Error("gh repo failed (1): HTTP 503: unavailable");
    } });

    await assert.rejects(client.getRepository("a/b"), /HTTP 503: unavailable/);
    assert.equal(attempts, 6);
  });

  it("does not replay a GitHub write after a transient failure", async () => {
    let attempts = 0;
    const client = new GitHubClient();
    Object.defineProperty(client, "runGh", { value: async () => {
      attempts += 1;
      throw new Error("gh api failed (1): HTTP 503: unavailable");
    } });

    await assert.rejects(client.postIssueComment({ repo: "a/b", issue: 7 }, "body"), /HTTP 503: unavailable/);
    assert.equal(attempts, 1);
  });
});

describe("GitHub repository resolution", () => {
  it("extracts the target repository from origin URLs without selecting upstream", () => {
    assert.equal(repositoryFromRemote("https://github.com/RapierCraftStudios/ForgeDockCLI"), "RapierCraftStudios/ForgeDockCLI");
    assert.equal(repositoryFromRemote("git@github.com:RapierCraftStudios/ForgeDockCLI.git"), "RapierCraftStudios/ForgeDockCLI");
    assert.equal(repositoryFromRemote("https://git.example.test/owner/repo.git"), undefined);
    assert.equal(repositoryFromRemote("https://evilgithub.com/attacker/repo.git"), undefined);
    assert.equal(repositoryFromRemote("https://evil.github.com/attacker/repo.git"), undefined);
  });

  it("refreshes expired credentials once and retries the same GitHub operation", async () => {
    let attempts = 0;
    let refreshed = 0;
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository(), async () => {
      refreshed += 1;
      return true;
    });
    Object.defineProperty(client, "runGh", { value: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("gh api failed (1): gh: Bad credentials (HTTP 401)");
      return JSON.stringify({ nameWithOwner: "a/b", defaultBranchRef: { name: "main" } });
    } });
    assert.deepEqual(await client.getRepository("a/b"), { repo: "a/b", defaultBranch: "main" });
    assert.equal(attempts, 2);
    assert.equal(refreshed, 1);
  });
});

describe("GitHub issue-search resolution", () => {
  it("returns only open issue members for a decoded search query", async () => {
    const client = new GitHubClient();
    let received: string[] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      received = args;
      return JSON.stringify([
        { number: 9, state: "OPEN", milestone: null },
        { number: 7, state: "CLOSED", milestone: null },
        { number: 8, state: "OPEN", milestone: null },
      ]);
    } });
    assert.deepEqual(await client.listOpenIssueNumbersForSearch("is:issue  state:open no:milestone", "a/b"), [9, 8]);
    assert.deepEqual(received, [
      "issue", "list", "--repo", "a/b", "--state", "open",
      "--search", "is:issue state:open no:milestone", "--limit", "1000", "--json", "number,state,milestone",
    ]);
  });

  it("returns the bounded no-milestone membership projection without reordering it", async () => {
    const client = new GitHubClient();
    let received: string[] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      received = args;
      return JSON.stringify([
        { number: 12, state: "OPEN", milestone: null },
        { number: 11, state: "OPEN", milestone: { title: "Later" } },
        { number: 10, state: "CLOSED", milestone: null },
      ]);
    } });

    assert.deepEqual(await client.listOpenIssueNumbersWithoutMilestone("a/b"), [12]);
    assert.deepEqual(received, [
      "issue", "list", "--repo", "a/b", "--state", "open",
      "--limit", "1000", "--json", "number,state,milestone",
    ]);
  });
});

describe("GitHub immutable comparison reads", () => {
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const comparison = (files: Array<{ filename: string; patch?: string }>) => ({
    status: "ahead",
    ahead_by: 1,
    base_commit: { sha: baseSha },
    merge_base_commit: { sha: baseSha },
    commits: [{ sha: headSha }],
    files,
  });

  it("shares one exact compare response across changed paths and hunks", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      return JSON.stringify(comparison([
        { filename: "src/b.ts", patch: "@@ -1 +4,2 @@ function changed()" },
        { filename: "src/a.ts", patch: "@@ -2 +7 @@" },
      ]));
    } });

    assert.deepEqual(await client.getChangedPathsBetween("a/b", baseSha, headSha), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(await client.getChangedHunksBetween("a/b", baseSha, headSha), [
      "src/a.ts:L7-L7",
      "src/b.ts:L4-L5:function changed()",
    ]);
    assert.deepEqual(calls, [["api", `repos/a/b/compare/${baseSha}...${headSha}`]]);
  });

  it("accepts 299 complete patched files and rejects GitHub's 300-file cap", async () => {
    const files = Array.from({ length: 300 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      patch: `@@ -1 +${index + 1} @@`,
    }));
    const accepted = new GitHubClient();
    Object.defineProperty(accepted, "gh", { value: async () => JSON.stringify(comparison(files.slice(0, 299))) });
    assert.equal((await accepted.getChangedPathsBetween("a/b", baseSha, headSha)).length, 299);

    const capped = new GitHubClient();
    Object.defineProperty(capped, "gh", { value: async () => JSON.stringify(comparison(files)) });
    await assert.rejects(capped.getChangedHunksBetween("a/b", baseSha, headSha), /at least 300 files.*cannot prove completeness/);
  });

  it("fails closed on missing patches, non-descendant lineage, and non-SHA inputs", async () => {
    const missingPatch = new GitHubClient();
    Object.defineProperty(missingPatch, "gh", { value: async () => JSON.stringify(comparison([{ filename: "asset.bin" }])) });
    await assert.rejects(missingPatch.getChangedHunksBetween("a/b", baseSha, headSha), /omitted the patch/);

    const diverged = new GitHubClient();
    Object.defineProperty(diverged, "gh", { value: async () => JSON.stringify({ ...comparison([]), status: "diverged" }) });
    await assert.rejects(diverged.getChangedPathsBetween("a/b", baseSha, headSha), /strict descendant/);

    const invalid = new GitHubClient();
    Object.defineProperty(invalid, "gh", { value: async () => { throw new Error("must not query"); } });
    await assert.rejects(invalid.getChangedPathsBetween("a/b", "base", "head"), /full 40-character commit SHAs/);
  });
});

describe("GitHub branch provisioning", () => {
  it("paginates the complete matching-refs branch catalog", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      return JSON.stringify([
        [{ ref: "refs/heads/milestone/one", object: { sha: "a".repeat(40) } }],
        [{ ref: "refs/heads/milestone/two", object: { sha: "b".repeat(40) } }],
      ]);
    } });

    assert.deepEqual(await client.listBranches("a/b", "milestone/"), [
      { name: "milestone/one", headSha: "a".repeat(40) },
      { name: "milestone/two", headSha: "b".repeat(40) },
    ]);
    assert.deepEqual(calls, [[
      "api", "repos/a/b/git/matching-refs/heads/milestone/?per_page=100", "--paginate", "--slurp",
    ]]);
  });

  it("rejects a matching-refs catalog beyond the bounded orchestration size", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async () => JSON.stringify([Array.from(
      { length: 5_001 },
      (_, index) => ({ ref: `refs/heads/milestone/${index}`, object: { sha: "a".repeat(40) } }),
    )]) });

    await assert.rejects(
      client.listBranches("a/b", "milestone/"),
      /branch catalog exceeds the safe bound of 5000 branches/,
    );
  });

  it("creates a milestone branch from an authoritative default head and reconciles its SHA", async () => {
    const client = new GitHubClient();
    const calls: Array<{ args: string[]; input?: string }> = [];
    Object.defineProperty(client, "gh", { value: async (args: string[], input?: string) => {
      calls.push({ args, ...(input !== undefined ? { input } : {}) });
      if (args[0] === "api" && args[1] === "repos/a/b/git/ref/heads/main") return JSON.stringify({ object: { sha: "a".repeat(40) } });
      if (args[0] === "api" && args[1] === "repos/a/b/git/refs") return "";
      if (args[0] === "api" && args[1] === "repos/a/b/git/ref/heads/milestone%2Fship") return JSON.stringify({ object: { sha: "a".repeat(40) } });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    assert.deepEqual(await client.createBranch("a/b", "milestone/ship", "main"), { name: "milestone/ship", headSha: "a".repeat(40) });
    assert.deepEqual(JSON.parse(calls.find(({ args }) => args[1] === "repos/a/b/git/refs")?.input ?? "{}"), { ref: "refs/heads/milestone/ship", sha: "a".repeat(40) });
  });

  it("adopts an existing branch only when its SHA matches the requested source head", async () => {
    const sourceSha = "a".repeat(40);
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[1] === "repos/a/b/git/ref/heads/main") return JSON.stringify({ object: { sha: sourceSha } });
      if (args[1] === "repos/a/b/git/refs") throw new Error("gh api failed (422): Reference already exists");
      if (args[1] === "repos/a/b/git/ref/heads/milestone%2Fship") return JSON.stringify({ object: { sha: "b".repeat(40) } });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await assert.rejects(
      client.createBranch("a/b", "milestone/ship", "main"),
      /already existed at b{40}, expected source head a{40}/,
    );
  });

  it("does not treat an unrelated 422 response as an existing-branch conflict", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[1] === "repos/a/b/git/ref/heads/main") return JSON.stringify({ object: { sha: "a".repeat(40) } });
      if (args[1] === "repos/a/b/git/refs") throw new Error("gh api failed (422): invalid reference name");
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await assert.rejects(client.createBranch("a/b", "milestone/ship", "main"), /invalid reference name/);
  });
});

describe("GitHub pull request diff retrieval", () => {
  it("uses the ordinary complete diff when GitHub accepts it", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      return "diff --git a/src/a.ts b/src/a.ts\n+change";
    } });

    assert.match(await client.getPullRequestDiff("a/b", 7), /src\/a\.ts/);
    assert.deepEqual(calls, [["pr", "diff", "7", "--repo", "a/b"]]);
  });

  it("paginates files when GitHub rejects a diff over 20,000 lines", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr") {
        throw new Error("gh pr failed (1): could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000) PullRequest.diff too_large");
      }
      return JSON.stringify([[
        { filename: "src/added.ts", status: "added", additions: 2, deletions: 0, changes: 2, patch: "@@ -0,0 +1,2 @@\n+one\n+two" },
      ], [
        { filename: "assets/binary.png", status: "modified", additions: 0, deletions: 0, changes: 0 },
      ]]);
    } });

    const diff = await client.getPullRequestDiff("a/b", 186);
    assert.match(diff, /diff --git a\/src\/added\.ts b\/src\/added\.ts/);
    assert.match(diff, /--- \/dev\/null/);
    assert.match(diff, /\+one/);
    assert.match(diff, /diff --git a\/assets\/binary\.png b\/assets\/binary\.png/);
    assert.match(diff, /GitHub omitted this file patch/);
    assert.deepEqual(calls[1], [
      "api", "repos/a/b/pulls/186/files?per_page=100", "--paginate", "--slurp",
    ]);
  });

  it("does not disguise ordinary GitHub failures as oversized diffs", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async () => {
      throw new Error("gh pr failed (1): HTTP 403: forbidden");
    } });
    await assert.rejects(client.getPullRequestDiff("a/b", 7), /HTTP 403/);
  });

  it("rejects malformed or unprovably complete fallback file sets", () => {
    assert.throws(() => renderPaginatedPullRequestDiff("{}"), /invalid paginated/);
    assert.throws(() => renderPaginatedPullRequestDiff(JSON.stringify([[]])), /returned no files/);
    assert.throws(() => renderPaginatedPullRequestDiff(JSON.stringify([[{ filename: "bad\npath", status: "modified" }]])), /invalid filename/);
    assert.throws(() => renderPaginatedPullRequestDiff(JSON.stringify([[{ filename: "../outside", status: "modified" }]])), /unsafe filename/);
    assert.throws(
      () => renderPaginatedPullRequestDiff(JSON.stringify([Array.from({ length: 3_000 }, (_, index) => ({ filename: `f${index}`, status: "modified" }))])),
      /cannot prove the complete file set/,
    );
  });
});

describe("GitHub pull request admission", () => {
  const headSha = "c".repeat(40);
  const pullRequestProjection = (number: number, state: "OPEN" | "CLOSED" | "MERGED" = "OPEN") => ({
    number,
    title: "Delivery",
    body: "",
    url: `https://github.test/a/b/pull/${number}`,
    state,
    headRefOid: headSha,
    headRefName: "forgedock/issue-186",
    baseRefName: "staging",
  });

  it("rejects a GitHub projection whose PR identity differs from the requested number", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async () => JSON.stringify(pullRequestProjection(187)) });
    await assert.rejects(client.getPullRequest("a/b", 186), /returned PR #187 while #186 was requested/);
  });

  it("fails closed on the PR #186 duplicate push and pull-request check pattern", async () => {
    let mergeCommands = 0;
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.includes("number,title,body,url,state,headRefOid,headRefName,baseRefName")) {
        return JSON.stringify(pullRequestProjection(186));
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" });
      if (args[0] === "pr" && args[1] === "checks") {
        return JSON.stringify([
          { name: "CI", state: "FAILURE", link: "https://github.test/checks/push", completedAt: "2026-08-14T10:00:00Z" },
          { name: "CI", state: "SUCCESS", link: "https://github.test/checks/pull-request", completedAt: "2026-08-14T10:01:00Z" },
        ]);
      }
      if (args[0] === "api" && args[1]?.includes("/check-runs")) return JSON.stringify([{ check_runs: [
        { name: "CI", head_sha: headSha, status: "completed", conclusion: "failure", html_url: "https://github.test/checks/push" },
        { name: "CI", head_sha: headSha, status: "completed", conclusion: "success", html_url: "https://github.test/checks/pull-request" },
      ] }]);
      if (args[0] === "api" && args[1]?.includes("/status?")) return JSON.stringify({ sha: headSha, statuses: [] });
      if (args[0] === "pr" && args[1] === "merge") { mergeCommands += 1; return ""; }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await assert.rejects(
      client.mergePullRequest("a/b", 186, headSha, "staging"),
      /Required GitHub checks are not all passing for PR #186: CI=failed/,
    );
    assert.equal(mergeCommands, 0);
  });

  it("accepts an exact merged state when the merge command reports failure after landing", async () => {
    let state: "OPEN" | "MERGED" = "OPEN";
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view" && args.includes("number,title,body,url,state,headRefOid,headRefName,baseRefName")) {
        return JSON.stringify(pullRequestProjection(186, state));
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "Required CI", state: "SUCCESS" }]);
      if (args[0] === "api" && args[1]?.includes("/check-runs")) return JSON.stringify([{ check_runs: [
        { name: "Required CI", head_sha: headSha, status: "completed", conclusion: "success" },
      ] }]);
      if (args[0] === "api" && args[1]?.includes("/status?")) return JSON.stringify({ sha: headSha, statuses: [] });
      if (args[0] === "pr" && args[1] === "merge") {
        state = "MERGED";
        throw new Error("transport closed after GitHub accepted the merge");
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await client.mergePullRequest("a/b", 186, headSha, "staging");
    assert.equal(state, "MERGED");
  });

  it("reads an exact merged pull request gate and revalidates its final merged identity", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "pr" && args[1] === "view" && args.includes("number,title,body,url,state,headRefOid,headRefName,baseRefName")) {
        return JSON.stringify(pullRequestProjection(186, "MERGED"));
      }
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "Required CI", state: "SUCCESS" }]);
      if (args[0] === "api" && args[1]?.includes("/check-runs")) return JSON.stringify([{ check_runs: [
        { name: "Required CI", head_sha: headSha, status: "completed", conclusion: "success" },
      ] }]);
      if (args[0] === "api" && args[1]?.includes("/status?")) return JSON.stringify({ sha: headSha, statuses: [] });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });

    const gate = await client.getPullRequestMergeGate("a/b", 186, headSha, "staging");
    assert.equal(gate.requiredChecksProvenance, "github-required");
    assert.equal(gate.requiredChecksHeadSha, headSha);
    assert.deepEqual(gate.requiredChecks, [{ name: "Required CI", state: "passed" }]);
    assert.equal(calls.filter((args) => args[0] === "pr" && args[1] === "view" && args.includes("number,title,body,url,state,headRefOid,headRefName,baseRefName")).length, 2);
  });

  it("continues to reject a closed pull request before reading its merge gate", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify(pullRequestProjection(186, "CLOSED"));
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await assert.rejects(
      client.getPullRequestMergeGate("a/b", 186, headSha, "staging"),
      /neither open nor merged \(GitHub state: CLOSED\)/,
    );
  });
});

describe("GitHub workflow label projection", () => {
  it("maps typed run states to the canonical legacy-compatible labels", () => {
    assert.equal(workflowLabelForState("investigating"), "workflow:investigating");
    assert.equal(workflowLabelForState("preparing"), "workflow:ready-to-build");
    assert.equal(workflowLabelForState("verifying"), "workflow:building");
    assert.equal(workflowLabelForState("reviewing"), "workflow:in-review");
    assert.equal(workflowLabelForState("merging"), "workflow:awaiting-merge");
    assert.equal(workflowLabelForState("completed"), "workflow:merged");
    assert.equal(workflowLabelForState("decomposed"), "workflow:decomposed");
    assert.equal(workflowLabelForState("blocked"), "needs-human");
    assert.equal(workflowLabelForState("failed"), "workflow:engine-error");
    assert.equal(workflowLabelForState("cancelled"), undefined);
  });
});

describe("GitHub canonical marker admission", () => {
  it("does not let an untrusted substring impersonate a canonical comment marker", async () => {
    const marker = "<!-- FORGEDOCK:TEST exact -->";
    const comments = [{ body: `prose prefix ${marker} suffix` }];
    let posts = 0;
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[], input?: string) => {
      if (args[0] === "api" && args.includes("POST")) {
        posts += 1;
        comments.push({ body: (JSON.parse(input ?? "{}") as { body: string }).body });
        return "{}";
      }
      if (args[0] === "api" && args[1]?.includes("/comments")) return JSON.stringify([comments]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await client.publishIssueComment({ repo: "a/b", issue: 2, marker, body: `Authoritative update\n\n${marker}` });
    assert.equal(posts, 1);
    assert.equal(comments.length, 2);
  });

  it("requires the outgoing marker itself to occupy a canonical line", async () => {
    const marker = "<!-- FORGEDOCK:TEST exact -->";
    const client = new GitHubClient();
    await assert.rejects(
      client.publishIssueComment({ repo: "a/b", issue: 2, marker, body: `prefix ${marker} suffix` }),
      /canonical idempotency marker/,
    );
  });
});

describe("GitHub batch issue projection", () => {
  const batchBody = [
    "## Problem",
    "Deliver the batch.",
    "<!-- FORGEDOCK:BATCH_CONTRACT:v1 -->",
    JSON.stringify({
      members: [
        { issue: 218, title: "First", acceptanceCriteria: ["First passes"], affectedFiles: ["src/a.ts"], claims: ["src/a.ts"], riskClass: "routine" },
        { issue: 225, title: "Second", acceptanceCriteria: ["Second passes"], affectedFiles: ["src/a.ts"], claims: ["src/a.ts"], riskClass: "routine" },
      ],
    }),
    "<!-- /FORGEDOCK:BATCH_CONTRACT:v1 -->",
    "<!-- FORGEDOCK:BATCH 218-225 -->",
  ].join("\n");

  function batchProjectionHarness() {
    const admissions = new InMemoryRemediationAdmissionRepository();
    const issues: Array<{ number: number; title: string; body: string; html_url: string; state: "open" | "closed" }> = [];
    const client = new GitHubClient(".", admissions);
    let creates = 0;
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return JSON.stringify([issues]);
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "view") {
        const issue = issues.find((candidate) => candidate.number === Number(args[2]));
        if (!issue) throw new Error(`Unknown issue ${args[2] ?? ""}`);
        return JSON.stringify({
          number: issue.number, title: issue.title, body: issue.body, url: issue.html_url,
          state: issue.state.toUpperCase(), labels: [{ name: "batch" }], milestone: null,
        });
      }
      if (args[0] === "issue" && args[1] === "create") {
        creates += 1;
        const number = 300 + creates;
        issues.push({
          number,
          title: args[args.indexOf("--title") + 1] ?? "Batch",
          body: body ?? "",
          html_url: `https://github.test/a/b/issues/${number}`,
          state: "open",
        });
        return `https://github.test/a/b/issues/${number}\n`;
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    return { admissions, client, issues, creates: () => creates };
  }

  it("invalidates a closed cached batch projection and safely creates a replacement", async () => {
    const harness = batchProjectionHarness();
    const input = { repo: "a/b", title: "Batch 218-225", body: batchBody, priorityLabel: "priority:P2" as const };
    const first = await harness.client.materializeBatchIssue(input);
    harness.issues[0]!.state = "closed";
    const second = await harness.client.materializeBatchIssue(input);

    assert.equal(first.number, 301);
    assert.equal(second.number, 302);
    assert.equal(harness.creates(), 2);
    assert.equal(harness.admissions.records.size, 1);
    assert.equal([...harness.admissions.records.values()][0]?.snapshot?.number, 302);
  });

  it("does not replace an open cached batch issue that lost its identity marker", async () => {
    const harness = batchProjectionHarness();
    const input = { repo: "a/b", title: "Batch 218-225", body: batchBody, priorityLabel: "priority:P2" as const };
    await harness.client.materializeBatchIssue(input);
    harness.issues[0]!.body = "marker removed";

    await assert.rejects(harness.client.materializeBatchIssue(input), /lost its canonical root marker/);
    assert.equal(harness.creates(), 1);
  });
});

describe("GitHub review finding projection", () => {
  it("derives a stable deduplication marker from PR, location, and finding identity", () => {
    const finding = {
      id: "security-1", severity: "medium" as const, confidence: "high" as const, blocking: true,
      title: "Token can be replayed", evidence: "No nonce", location: "src/auth.ts:20",
      intentRelevance: "Breaks authorization", remediation: "Consume a nonce",
    };
    const first = reviewFindingMarker("A/B", 57, finding);
    const second = reviewFindingMarker("a/b", 57, { ...finding, evidence: "Expanded evidence" });
    assert.equal(first, second);
    assert.match(first, /^<!-- FORGEDOCK:REVIEW-FINDING [a-f0-9]{64} -->$/);
    const rooted = { ...finding, normalizedRoot: "authorization nonce is reusable" };
    assert.equal(
      reviewFindingSemanticMarker("a/b", 57, rooted),
      reviewFindingSemanticMarker("a/b", 57, { ...rooted, title: "Updated wording", location: "src/auth.ts:99" }),
    );
    assert.equal(reviewFindingLaneMarker("A/B", 57), reviewFindingLaneMarker("a/b", 57));
    assert.match(reviewFindingLaneMarker("a/b", 57), /^<!-- FORGEDOCK:REVIEW-FINDING-LANE v1 [a-f0-9]{64} -->$/);
    const durableRoot = { ...finding, rootId: "root-redaction-marker", normalizedRoot: "old prose", causalRoot: "quoted marker suffix" };
    assert.equal(
      reviewFindingSemanticMarker("a/b", 57, durableRoot),
      reviewFindingSemanticMarker("a/b", 57, {
        ...durableRoot,
        title: "Terminal metadata paraphrase no longer controls identity",
        normalizedRoot: "completely changed controller prose",
        causalRoot: "different wording",
        location: "src/observer.ts:99",
      }),
    );
  });

  it("retains one issue per active root and reconciles stale or duplicate lane projections", () => {
    const finding = {
      id: "review-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Schema is incomplete", evidence: "Request fields are missing", location: "src/schema.ts:20",
      intentRelevance: "Breaks clients", remediation: "Define fields",
    };
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: "a".repeat(40), headBranch: "fix", baseBranch: "main",
    };
    const secondFinding = { ...finding, id: "review-2222222222222222", title: "Response schema is incomplete", evidence: "Response fields are missing" };
    const staleFinding = { ...finding, id: "review-3333333333333333", title: "Stale schema concern", evidence: "Old evidence" };
    const body = (marker: string, pr = 57) => `**Source:** PR #${pr} — Fix\n${reviewFindingLaneMarker("a/b", pr)}\n${marker}`;
    const issues = [
      { repo: "a/b", number: 1, title: "active first", body: body(reviewFindingMarker("a/b", 57, finding)), url: "u1", state: "OPEN" as const },
      { repo: "a/b", number: 2, title: "duplicate first", body: body(reviewFindingMarker("a/b", 57, finding)), url: "u2", state: "OPEN" as const },
      { repo: "a/b", number: 3, title: "active second", body: body(reviewFindingMarker("a/b", 57, secondFinding)), url: "u3", state: "OPEN" as const },
      { repo: "a/b", number: 4, title: "stale", body: body(reviewFindingMarker("a/b", 57, staleFinding)), url: "u4", state: "OPEN" as const },
      { repo: "a/b", number: 5, title: "other PR", body: body(reviewFindingMarker("a/b", 58, finding), 58), url: "u5", state: "OPEN" as const },
      { repo: "a/b", number: 6, title: "closed", body: body(reviewFindingMarker("a/b", 57, staleFinding)), url: "u6", state: "CLOSED" as const },
    ];
    assert.deepEqual(reviewFindingReconciliationCandidates(issues, {
      repo: "a/b", pullRequest, runId: "run-1", activeFindings: [finding, secondFinding],
    }).map(({ number }) => number), [2, 4]);
  });

  it("does not collapse distinct consolidated root causes that share a title and location", () => {
    const finding = {
      id: "review-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Schema is incomplete", evidence: "Request fields are missing", location: "src/schema.ts:20",
      intentRelevance: "Breaks clients", remediation: "Define fields",
    };
    assert.notEqual(
      reviewFindingMarker("a/b", 57, finding),
      reviewFindingMarker("a/b", 57, { ...finding, id: "review-2222222222222222", evidence: "Response variants are missing" }),
    );
  });

  it("rejects an older publication generation after a newer head wins, including ABA", async () => {
    const admissions = new InMemoryRemediationAdmissionRepository();
    const client = new GitHubClient(".", admissions);
    const headA = "a".repeat(40);
    const headB = "b".repeat(40);
    let live: PullRequestSnapshot = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN", headSha: headA, headBranch: "fix", baseBranch: "main",
    };
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...live }) });
    let mutations = 0;
    Object.defineProperty(client, "gh", { value: async () => { mutations += 1; return "[[]]"; } });

    const older = await client.beginReviewFindingPublication({ repo: "a/b", pullRequest: live, runId: "run-old" });
    live = { ...live, headSha: headB };
    const newer = await client.beginReviewFindingPublication({ repo: "a/b", pullRequest: live, runId: "run-new" });
    assert.equal(newer.generation, older.generation + 1);
    live = { ...live, headSha: headA };

    await assert.rejects(client.reconcileReviewFindings({
      repo: "a/b",
      pullRequest: { ...live },
      runId: "run-old",
      publicationFence: older,
      activeFindings: [],
    }), /publication fence is stale/);
    assert.equal(mutations, 0);
  });

  it("adopts an existing marker-matched root issue across a fresh admission store", async () => {
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: "a".repeat(40), headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Retained finding", evidence: "The open lane issue already records this root.", location: "src/schema.ts:20",
      intentRelevance: "Keeps the review root durable", remediation: "Apply the recorded fix.",
    };
    const issue = {
      number: 88, title: "existing lane finding", body: `**Source:** PR #57 — Fix\n${reviewFindingLaneMarker("a/b", 57)}\n${reviewFindingMarker("a/b", 57, finding)}`,
      html_url: "https://github.test/a/b/issues/88", state: "open" as const,
      labels: ["review-finding", "needs-validation", "priority:P1"],
    };
    issue.body = `**Source:** PR #57 - Fix\n**Reviewed SHA:** \`${pullRequest.headSha}\`\n${reviewFindingLaneMarker("a/b", 57)}\n${reviewFindingMarker("a/b", 57, finding)}`;
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    let created = false;
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return JSON.stringify([[issue]]);
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "view" && args[2] === "88") return JSON.stringify({
        number: issue.number, title: issue.title, body: issue.body, url: issue.html_url,
        state: "OPEN", labels: issue.labels.map((name) => ({ name })), milestone: null,
      });
      if (args[0] === "issue" && args[1] === "view" && args[2] === "2") return JSON.stringify({ milestone: null });
      if (args[0] === "issue" && args[1] === "edit" && args[2] === "88") {
        issue.title = args[args.indexOf("--title") + 1] ?? issue.title;
        issue.body = body ?? issue.body;
        issue.labels = [...new Set([...issue.labels, ...(args[args.indexOf("--add-label") + 1]?.split(",") ?? [])])];
        return "";
      }
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "issue" && args[1] === "create") { created = true; return "https://github.test/a/b/issues/99\n"; }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const adopted = await client.materializeReviewFinding({
      repo: "a/b", sourceIssue: 2, pullRequest, runId: "run-new", reviewedHeadSha: pullRequest.headSha,
      reviewerRoles: ["correctness"], finding,
    });
    assert.equal(adopted.number, 88);
    assert.equal(created, false);
  });

  it("adopts a semantic-identity issue when the legacy root marker was lost", async () => {
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: "a".repeat(40), headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Retained finding", evidence: "The semantic identity is durable.", location: "src/schema.ts:20",
      normalizedRoot: "schema contract is incomplete", intentRelevance: "Keeps the review root durable", remediation: "Apply the recorded fix.",
    };
    const issue = {
      number: 88,
      title: "old projection",
      body: `**Source:** PR #57 - Fix\n**Reviewed SHA:** \`${pullRequest.headSha}\`\n${reviewFindingLaneMarker("a/b", 57)}\n${reviewFindingSemanticMarker("a/b", 57, finding)}`,
      html_url: "https://github.test/a/b/issues/88", state: "open" as const,
      labels: ["review-finding", "needs-validation", "priority:P1"],
    };
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    let created = false;
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return JSON.stringify([[issue]]);
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "view" && args[2] === "88") return JSON.stringify({
        number: issue.number, title: issue.title, body: issue.body, url: issue.html_url,
        state: "OPEN", labels: issue.labels.map((name) => ({ name })), milestone: null,
      });
      if (args[0] === "issue" && args[1] === "view" && args[2] === "2") return JSON.stringify({ milestone: null });
      if (args[0] === "issue" && args[1] === "edit" && args[2] === "88") {
        issue.title = args[args.indexOf("--title") + 1] ?? issue.title;
        issue.body = body ?? issue.body;
        issue.labels = [...new Set([...issue.labels, ...(args[args.indexOf("--add-label") + 1]?.split(",") ?? [])])];
        return "";
      }
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "issue" && args[1] === "create") { created = true; return "https://github.test/a/b/issues/99\n"; }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const adopted = await client.materializeReviewFinding({
      repo: "a/b", sourceIssue: 2, pullRequest, runId: "run-new", reviewedHeadSha: pullRequest.headSha,
      reviewerRoles: ["correctness"], finding,
    });
    assert.equal(adopted.number, 88);
    assert.equal(adopted.projection?.status, "adopted");
    assert.match(issue.body, /FORGEDOCK:REVIEW-FINDING [a-f0-9]{64}/);
    assert.equal(created, false);
  });

  it("creates distinct root issues and reconciles a stale aggregate plus duplicate root", async () => {
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: "a".repeat(40), headBranch: "fix", baseBranch: "main",
    };
    const finding = (id: string, index: number) => ({
      id, severity: "high" as const, confidence: "high" as const, blocking: true,
      title: `Root ${index}`, evidence: `Evidence ${index}`, location: `src/schema.ts:${index}`,
      intentRelevance: "Breaks clients", remediation: `Fix root ${index}`,
      scopeDisposition: "in_scope" as const, reviewerRoles: ["correctness"],
    });
    const firstRoot = finding("review-1111111111111111", 1);
    const secondRoot = finding("review-2222222222222222", 2);
    const staleAggregate = finding("review-terminal-3333333333333333", 3);
    assert.notEqual(reviewFindingMarker("a/b", 57, firstRoot), reviewFindingMarker("a/b", 57, secondRoot));

    const issues: Array<{ number: number; title: string; body: string; html_url: string; state: "open" | "closed" }> = [];
    const closed: number[] = [];
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return JSON.stringify([issues]);
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "view") {
        const issue = issues.find((candidate) => candidate.number === Number(args[2]));
        if (!issue) throw new Error(`Unknown issue: ${args[2] ?? ""}`);
        return JSON.stringify({
          number: issue.number, title: issue.title, body: issue.body, url: issue.html_url,
          state: issue.state.toUpperCase(), labels: [{ name: "review-finding" }, { name: "needs-validation" }, { name: "priority:P1" }], milestone: null,
        });
      }
      if (args[0] === "issue" && args[1] === "create") {
        const number = 100 + issues.length + 1;
        issues.push({ number, title: args[args.indexOf("--title") + 1] ?? "Finding", body: body ?? "", html_url: `https://github.test/a/b/issues/${number}`, state: "open" });
        return `https://github.test/a/b/issues/${number}\n`;
      }
      if (args[0] === "issue" && args[1] === "close") {
        const number = Number(args[2]);
        const issue = issues.find((candidate) => candidate.number === number);
        if (issue) issue.state = "closed";
        closed.push(number);
        return "";
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const baseInput = { repo: "a/b", sourceIssue: 2, pullRequest, runId: "run-1", reviewedHeadSha: pullRequest.headSha, reviewerRoles: ["correctness"] };
    const firstIssue = await client.materializeReviewFinding({ ...baseInput, finding: firstRoot });
    const secondIssue = await client.materializeReviewFinding({ ...baseInput, finding: secondRoot });
    assert.notEqual(firstIssue.number, secondIssue.number);
    assert.equal(issues.length, 2);
    issues.push({
      number: 999,
      title: "duplicate root finding",
      body: `**Source:** PR #57 — Fix\n**Run:** \`run-old\`\n${reviewFindingLaneMarker("a/b", 57)}\n${reviewFindingMarker("a/b", 57, firstRoot)}`,
      html_url: "https://github.test/a/b/issues/999",
      state: "open",
    });
    issues.push({
      number: 998,
      title: "stale aggregate finding",
      body: `**Source:** PR #57 — Fix\n**Run:** \`run-old\`\n${reviewFindingLaneMarker("a/b", 57)}\n${reviewFindingMarker("a/b", 57, staleAggregate)}`,
      html_url: "https://github.test/a/b/issues/998",
      state: "open",
    });
    assert.deepEqual(await client.reconcileReviewFindings({
      repo: "a/b", pullRequest, runId: "run-1", activeFindings: [firstRoot, secondRoot],
    }), [998, 999]);
    assert.deepEqual(closed, [998, 999]);
  });

  it("records a same-root recurrence on a new reviewed head without reusing stale evidence silently", async () => {
    const oldHead = "a".repeat(40);
    const newHead = "b".repeat(40);
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: newHead, headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Retained finding", evidence: "Current evidence", location: "src/schema.ts:20",
      intentRelevance: "Breaks clients", remediation: "Apply the current fix.",
    };
    const issue: { number: number; title: string; body: string; html_url: string; state: "open"; labels: string[] } = {
      number: 88, title: "existing finding",
      body: `**Source:** PR #57 - Fix\n**Reviewed SHA:** \`${oldHead}\`\n${reviewFindingLaneMarker("a/b", 57)}\n${reviewFindingMarker("a/b", 57, finding)}`,
      html_url: "https://github.test/a/b/issues/88", state: "open", labels: ["review-finding", "needs-validation", "priority:P3"],
    };
    const recurrenceComments: string[] = [];
    let created = false;
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return JSON.stringify([[issue]]);
      if (args[0] === "issue" && args[1] === "view") return JSON.stringify({
        number: issue.number, title: issue.title, body: issue.body, url: issue.html_url, state: "OPEN",
        labels: issue.labels.map((name) => ({ name })), milestone: null,
      });
      if (args[0] === "api" && args[1]?.includes("/comments") && args.includes("POST")) {
        recurrenceComments.push(JSON.parse(body ?? "{}").body ?? "");
        return "{}";
      }
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "issue" && args[1] === "edit" && args[2] === "88") {
        issue.title = args[args.indexOf("--title") + 1] ?? issue.title;
        issue.body = body ?? issue.body;
        const remove = new Set(args.includes("--remove-label") ? args[args.indexOf("--remove-label") + 1]?.split(",") : []);
        issue.labels = issue.labels.filter((label) => !remove.has(label));
        issue.labels = [...new Set([...issue.labels, ...(args[args.indexOf("--add-label") + 1]?.split(",") ?? [])])];
        return "";
      }
      if (args[0] === "issue" && args[1] === "create") { created = true; return "https://github.test/a/b/issues/99\n"; }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const adopted = await client.materializeReviewFinding({
      repo: "a/b", pullRequest, runId: "run-new-head", reviewedHeadSha: newHead,
      reviewerRoles: ["correctness"], finding,
    });
    assert.equal(adopted.number, 88);
    assert.equal(created, false);
    assert.equal(recurrenceComments.length, 1);
    assert.match(recurrenceComments[0] ?? "", new RegExp(newHead));
    assert.match(recurrenceComments[0] ?? "", /Current evidence/);
    assert.ok(issue.body.includes(`**Reviewed SHA:** \`${newHead}\``));
    assert.match(issue.body, /Current evidence/);
    assert.match(issue.body, /Severity:\*\* HIGH/);
    assert.deepEqual(issue.labels.filter((label) => label.startsWith("priority:")), ["priority:P1"]);
    assert.doesNotMatch(issue.body, /FORGE:BATCHABLE/);
  });

  it("invalidates a closed cached projection and creates an elevated regression issue", async () => {
    const head = "a".repeat(40);
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: head, headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-1111111111111111", severity: "low" as const, confidence: "high" as const, blocking: false,
      title: "Output is ambiguous", evidence: "Empty output", location: "src/output.ts:20",
      intentRelevance: "Confuses users", remediation: "Render an explicit result.",
    };
    const issues: Array<{ number: number; title: string; body: string; html_url: string; state: "open" | "closed"; labels: string[] }> = [];
    const createArgs: string[][] = [];
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return JSON.stringify([issues]);
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "view") {
        const issue = issues.find((candidate) => candidate.number === Number(args[2]));
        if (!issue) throw new Error(`Unknown issue ${args[2] ?? ""}`);
        return JSON.stringify({
          number: issue.number, title: issue.title, body: issue.body, url: issue.html_url,
          state: issue.state.toUpperCase(), labels: issue.labels.map((name) => ({ name })), milestone: null,
        });
      }
      if (args[0] === "issue" && args[1] === "create") {
        createArgs.push(args);
        const number = 101 + issues.length;
        const labels = args.flatMap((value, index) => args[index - 1] === "--label" ? [value] : []);
        issues.push({ number, title: args[args.indexOf("--title") + 1] ?? "Finding", body: body ?? "", html_url: `https://github.test/a/b/issues/${number}`, state: "open", labels });
        return `https://github.test/a/b/issues/${number}\n`;
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const input = { repo: "a/b", pullRequest, runId: "run-regression", reviewedHeadSha: head, reviewerRoles: ["correctness"], finding };
    const first = await client.materializeReviewFinding(input);
    issues[0]!.state = "closed";
    const second = await client.materializeReviewFinding(input);
    assert.notEqual(first.number, second.number);
    assert.equal(issues.length, 2);
    assert.ok(createArgs[1]?.includes("priority:P1"));
    assert.match(issues[1]?.body ?? "", /Regression.*#101/);
    assert.doesNotMatch(issues[1]?.body ?? "", /FORGE:BATCHABLE/);
  });

  it("inherits the delivery milestone and keeps invoice findings out of P3 batches", async () => {
    const head = "a".repeat(40);
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "Closes #2", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: head, headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-1111111111111111", severity: "low" as const, confidence: "high" as const, blocking: false,
      title: "Invoice rendering is ambiguous", evidence: "Empty total", location: "src/invoice/render.ts:20",
      intentRelevance: "Confuses billing", remediation: "Render the total.",
    };
    let createdBody = "";
    let createdTitle = "";
    let createdArgs: string[] = [];
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return "[[]]";
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "view" && args[2] === "2") return JSON.stringify({ milestone: { title: "Billing v2" } });
      if (args[0] === "issue" && args[1] === "create") {
        createdArgs = args;
        createdBody = body ?? "";
        return "https://github.test/a/b/issues/101\n";
      }
      if (args[0] === "issue" && args[1] === "view" && args[2] === "101") return JSON.stringify({
        number: 101, title: createdArgs[createdArgs.indexOf("--title") + 1], body: createdBody, url: "https://github.test/a/b/issues/101", state: "OPEN",
        labels: [{ name: "review-finding" }, { name: "needs-validation" }, { name: "priority:P3" }], milestone: { number: 1, title: "Billing v2" },
      });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await client.materializeReviewFinding({
      repo: "a/b", sourceIssue: 2, pullRequest, runId: "run-milestone", reviewedHeadSha: head,
      reviewerRoles: ["correctness"], finding,
    });
    assert.equal(createdArgs[createdArgs.indexOf("--milestone") + 1], "Billing v2");
    assert.doesNotMatch(createdBody, /FORGE:BATCHABLE/);
  });

  it("falls back to a milestone-branch slug when no PR or delivery issue milestone exists", async () => {
    const head = "a".repeat(40);
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: head, headBranch: "fix", baseBranch: "milestone/quality-roadmap",
    };
    const finding = {
      id: "review-1111111111111111", severity: "medium" as const, confidence: "high" as const, blocking: false,
      title: "Roadmap finding", evidence: "Evidence", location: "src/a.ts:1",
      intentRelevance: "Relevant", remediation: "Fix it",
    };
    let createdBody = "";
    let createdArgs: string[] = [];
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return "[[]]";
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "api" && args[1]?.includes("/milestones?")) return JSON.stringify([[{ title: "Quality Roadmap" }]]);
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "create") {
        createdArgs = args;
        createdBody = body ?? "";
        return "https://github.test/a/b/issues/101\n";
      }
      if (args[0] === "issue" && args[1] === "view" && args[2] === "101") return JSON.stringify({
        number: 101, title: createdArgs[createdArgs.indexOf("--title") + 1], body: createdBody, url: "https://github.test/a/b/issues/101", state: "OPEN",
        labels: [{ name: "review-finding" }, { name: "needs-validation" }, { name: "priority:P2" }], milestone: { number: 1, title: "Quality Roadmap" },
      });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await client.materializeReviewFinding({
      repo: "a/b", pullRequest, runId: "run-branch-milestone", reviewedHeadSha: head,
      reviewerRoles: ["correctness"], finding,
    });
    assert.equal(createdArgs[createdArgs.indexOf("--milestone") + 1], "Quality Roadmap");
  });

  it("fails closed when GitHub does not preserve the created finding marker", async () => {
    const head = "a".repeat(40);
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: head, headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Finding", evidence: "Evidence", location: "src/a.ts:1", intentRelevance: "Relevant", remediation: "Fix it",
    };
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return "[[]]";
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "create") return "https://github.test/a/b/issues/101\n";
      if (args[0] === "issue" && args[1] === "view") return JSON.stringify({
        number: 101, title: "Finding", body: "marker removed", url: "https://github.test/a/b/issues/101", state: "OPEN",
        labels: [{ name: "review-finding" }, { name: "needs-validation" }, { name: "priority:P1" }], milestone: null,
      });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await assert.rejects(client.materializeReviewFinding({
      repo: "a/b", pullRequest, runId: "run-bad-readback", reviewedHeadSha: head,
      reviewerRoles: ["correctness"], finding,
    }), /failed authoritative identity validation/);
  });

  it("accepts GitHub line-ending normalization but rejects body content changes", async () => {
    const head = "a".repeat(40);
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: head, headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Finding", evidence: "First line\r\nSecond line", location: "src/a.ts:1",
      intentRelevance: "Relevant", remediation: "Fix it",
    };
    let createdBody = "";
    let createdTitle = "";
    let contentChanged = false;
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return "[[]]";
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "create") {
        createdBody = body ?? "";
        createdTitle = args[args.indexOf("--title") + 1] ?? "";
        return "https://github.test/a/b/issues/101\n";
      }
      if (args[0] === "issue" && args[1] === "edit") return "";
      if (args[0] === "issue" && args[1] === "view") return JSON.stringify({
        number: 101,
        title: createdTitle,
        body: (contentChanged ? createdBody.replace("Second line", "Changed line") : createdBody).replace(/\r\n?/g, "\n"),
        url: "https://github.test/a/b/issues/101",
        state: "OPEN",
        labels: [{ name: "review-finding" }, { name: "needs-validation" }, { name: "priority:P1" }],
        milestone: null,
      });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const issue = await client.materializeReviewFinding({
      repo: "a/b", pullRequest, runId: "run-line-endings", reviewedHeadSha: head,
      reviewerRoles: ["correctness"], finding,
    });
    assert.equal(issue.number, 101);
    assert.match(createdBody, /First line\r\nSecond line/);
    contentChanged = true;
    const drifted = await client.materializeReviewFinding({
      repo: "a/b", pullRequest, runId: "run-line-endings", reviewedHeadSha: head,
      reviewerRoles: ["correctness"], finding,
    });
    assert.equal(drifted.number, 101);
    assert.equal(drifted.projection?.status, "projection-drift");
    assert.ok(drifted.projection?.mismatches?.some((mismatch) => mismatch.startsWith("body-diff-at:")));
  });

  it("accepts GitHub caret normalization of escaped C1 controls", async () => {
    const head = "a".repeat(40);
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: head, headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Finding", evidence: "First `\\u009d52;c;` then `\\u009cvisible`, plus `\\u009b` and `\\u0007`", location: "src/a.ts:1",
      intentRelevance: "Relevant", remediation: "Fix it",
    };
    let createdBody = "";
    let createdTitle = "";
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return "[[]]";
      if (args[0] === "api" && args[1] === "repos/a/b/issues/57") return "{}";
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "create") {
        createdBody = body ?? "";
        createdTitle = args[args.indexOf("--title") + 1] ?? "";
        return "https://github.test/a/b/issues/101\n";
      }
      if (args[0] === "issue" && args[1] === "view") return JSON.stringify({
        number: 101,
        title: createdTitle,
        body: createdBody
          .replaceAll("\\u0007", "\\^G")
          .replaceAll("\\u009b", "\\^[")
          .replaceAll("\\u009d", "\\^]")
          .replaceAll("\\u009c", "\\^\\"),
        url: "https://github.test/a/b/issues/101",
        state: "OPEN",
        labels: [{ name: "review-finding" }, { name: "needs-validation" }, { name: "priority:P1" }],
        milestone: null,
      });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const issue = await client.materializeReviewFinding({
      repo: "a/b", pullRequest, runId: "run-c1-normalization", reviewedHeadSha: head,
      reviewerRoles: ["correctness"], finding,
    });
    assert.equal(issue.number, 101);
    assert.match(createdBody, /\\u0007/);
    assert.match(createdBody, /\\u009b/);
    assert.match(createdBody, /\\u009d/);
    assert.match(createdBody, /\\u009c/);
  });

  it("accepts GitHub caret normalization regardless of escaped-control hex case", async () => {
    const head = "b".repeat(40);
    const pullRequest = {
      repo: "a/b", number: 58, title: "Fix", body: "", url: "https://github.test/a/b/pull/58",
      state: "OPEN" as const, headSha: head, headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-2222222222222222", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Finding", evidence: "Upper `\\u009D52;c;` and mixed `\\u009cvisible`, plus `\\u009B` and `\\u0007`", location: "src/a.ts:2",
      intentRelevance: "Relevant", remediation: "Fix it",
    };
    let createdBody = "";
    let createdTitle = "";
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    Object.defineProperty(client, "getPullRequest", { value: async () => ({ ...pullRequest }) });
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return "[[]]";
      if (args[0] === "api" && args[1] === "repos/a/b/issues/58") return "{}";
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "issue" && args[1] === "create") {
        createdBody = body ?? "";
        createdTitle = args[args.indexOf("--title") + 1] ?? "";
        return "https://github.test/a/b/issues/102\n";
      }
      if (args[0] === "issue" && args[1] === "view") return JSON.stringify({
        number: 102,
        title: createdTitle,
        body: createdBody
          .replace(/\\u0007/gi, "\\^G")
          .replace(/\\u009b/gi, "\\^[")
          .replace(/\\u009d/gi, "\\^]")
          .replace(/\\u009c/gi, "\\^\\"),
        url: "https://github.test/a/b/issues/102",
        state: "OPEN",
        labels: [{ name: "review-finding" }, { name: "needs-validation" }, { name: "priority:P1" }],
        milestone: null,
      });
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const issue = await client.materializeReviewFinding({
      repo: "a/b", pullRequest, runId: "run-c1-case-normalization", reviewedHeadSha: head,
      reviewerRoles: ["correctness"], finding,
    });
    assert.equal(issue.number, 102);
    assert.match(createdBody, /\\u009B/);
    assert.match(createdBody, /\\u009D/);
    assert.match(createdBody, /\\u009c/);
    assert.match(createdBody, /\\u0007/);
  });
});

describe("GitHub decomposition materialization", () => {
  it("rejects unknown dependency names before issuing any GitHub writes", async () => {
    const client = new GitHubClient();
    let calls = 0;
    Object.defineProperty(client, "gh", { value: async () => {
      calls += 1;
      throw new Error("GitHub must not be called for an invalid decomposition DAG");
    } });
    await assert.rejects(client.materializeDecomposition({
      repo: "a/b",
      parentIssue: 7,
      children: [{ title: "Child", outcome: "Deliver child", dependsOn: ["Missing prerequisite"] }],
    }), /Unknown decomposition dependency 'Missing prerequisite' for child 'Child'/);
    assert.equal(calls, 0);
  });

  it("inherits and authoritatively verifies the parent milestone on new children", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        const number = Number(args[2]);
        return JSON.stringify({
          number,
          title: number === 7 ? "Parent" : "Child",
          body: "",
          url: `https://github.test/a/b/issues/${number}`,
          state: "OPEN",
          labels: number === 7
            ? [{ name: "enhancement" }, { name: "priority:P2" }, { name: "batch" }, { name: "review-finding" }, { name: "staging-review" }]
            : [{ name: "enhancement" }, { name: "priority:P2" }, { name: "staging-review" }],
          milestone: { number: 1, title: "Milestone One" },
        });
      }
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return "[[]]";
      if (args[0] === "issue" && args[1] === "create") return "https://github.test/a/b/issues/110\n";
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });

    const children = await client.materializeDecomposition({
      repo: "a/b",
      parentIssue: 7,
      children: [{ title: "Child", outcome: "Deliver child", dependsOn: [] }],
    });

    const create = calls.find((args) => args[0] === "issue" && args[1] === "create");
    assert.ok(create);
    assert.deepEqual(create.slice(create.indexOf("--milestone")), ["--milestone", "Milestone One"]);
    assert.ok(create.includes("enhancement"));
    assert.ok(create.includes("priority:P2"));
    assert.ok(create.includes("staging-review"));
    assert.equal(create.includes("batch"), false);
    assert.equal(create.includes("review-finding"), false);
    assert.equal(children[0]?.milestone?.number, 1);
  });

  it("repairs a marker-matched child that predates milestone inheritance", async () => {
    const client = new GitHubClient();
    const calls: string[][] = [];
    let repaired = false;
    const marker = createHash("sha256").update("a/b#7\nchild").digest("hex");
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "view") {
        const number = Number(args[2]);
        return JSON.stringify({
          number,
          title: number === 7 ? "Parent" : "Child",
          body: number === 7 ? "" : `<!-- FORGEDOCK:DECOMPOSITION ${marker} -->`,
          url: `https://github.test/a/b/issues/${number}`,
          state: "OPEN",
          labels: [],
          milestone: number === 7 || repaired ? { number: 1, title: "Milestone One" } : null,
        });
      }
      if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) {
        return JSON.stringify([[{ number: 110, title: "Child", body: `<!-- FORGEDOCK:DECOMPOSITION ${marker} -->`, html_url: "https://github.test/a/b/issues/110", state: "open" }]]);
      }
      if (args[0] === "issue" && args[1] === "edit") { repaired = true; return ""; }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });

    const children = await client.materializeDecomposition({
      repo: "a/b",
      parentIssue: 7,
      children: [{ title: "Child", outcome: "Deliver child", dependsOn: [] }],
    });

    const edit = calls.find((args) => args[0] === "issue" && args[1] === "edit");
    assert.ok(edit);
    assert.deepEqual(edit.slice(edit.indexOf("--milestone")), ["--milestone", "Milestone One"]);
    assert.equal(children[0]?.milestone?.number, 1);
  });
});

describe("GitHub plan materialization", () => {
  const request = (): PlanMaterializationRequest => ({
    repo: "a/b",
    planId: "plan-session-1",
    revision: 3,
    objective: "Deliver the confirmed, dependency-ordered capability.",
    assumptions: ["The existing adapter remains the GitHub authority."],
    evidence: [{
      id: "repo-adapter",
      authority: "repository",
      source: "src/adapters/github/github-client.ts",
      locator: "GitHubClient",
      claim: "Issue projection belongs in the GitHub adapter.",
      detail: "The adapter already owns deterministic issue materialization and authoritative re-reads.",
    }],
    vocabulary: [{
      id: "plan-node",
      term: "Plan node",
      definition: "One independently deliverable and verifiable work unit.",
      aliases: ["work unit"],
      evidenceIds: ["repo-adapter"],
      status: "accepted",
    }],
    decisions: [{
      round: 1,
      questionId: "delivery-shape",
      values: ["issue-dag"],
      labels: ["GitHub issue DAG"],
      customText: "Keep each node independently reviewable.",
      note: "The user confirmed durable GitHub handoff.",
      optionNotes: { "issue-dag": "Preferred for dogfooding." },
      authority: "user",
    }],
    outOfScope: ["Automatic dispatch before confirmation."],
    // Deliberately reverse dependency order: the adapter, not caller order,
    // owns topological creation.
    nodes: [
      {
        planId: "plan-session-1",
        revision: 3,
        nodeId: "verify",
        title: "Verify the materialized plan",
        outcome: "The issue graph is independently verified.",
        dependsOnNodeIds: ["build"],
        acceptanceCriteria: ["The returned dependency mapping points at the build issue."],
        affectedFiles: ["src/adapters/github/github-client.test.ts"],
        claims: ["component:github-plan-verification"],
        verificationPlan: ["Run the focused GitHub adapter tests."],
        priority: 20,
        riskClass: "routine",
        evidenceIds: ["repo-adapter"],
      },
      {
        planId: "plan-session-1",
        revision: 3,
        nodeId: "build",
        title: "Build the plan materializer",
        outcome: "Confirmed plan nodes become durable GitHub issues.",
        dependsOnNodeIds: [],
        acceptanceCriteria: ["Every node has one deterministic issue.", "No dependency is invented."],
        affectedFiles: ["src/adapters/github/github-client.ts"],
        claims: ["component:github-plan-materialization"],
        verificationPlan: ["Compile the adapter.", "Run plan materialization regressions."],
        priority: 10,
        riskClass: "security",
        evidenceIds: ["repo-adapter"],
      },
    ],
  });

  function fixture() {
    const issues: Array<{ number: number; title: string; body: string; html_url: string; state: "open" }> = [];
    const createTitles: string[] = [];
    let calls = 0;
    const makeClient = (admissions = new InMemoryRemediationAdmissionRepository()) => {
      const client = new GitHubClient(".", admissions);
      Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
        calls += 1;
        if (args[0] === "api" && args[1]?.includes("issues?state=all")) return JSON.stringify([issues]);
        if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
        if (args[0] === "issue" && args[1] === "create") {
          const number = 100 + issues.length + 1;
          const title = args[args.indexOf("--title") + 1] ?? "Plan node";
          createTitles.push(title);
          issues.push({ number, title, body: body ?? "", html_url: `https://github.test/a/b/issues/${number}`, state: "open" });
          return `https://github.test/a/b/issues/${number}\n`;
        }
        if (args[0] === "issue" && args[1] === "view") {
          const issue = issues.find((candidate) => candidate.number === Number(args[2]));
          if (!issue) throw new Error(`Unknown issue: ${args[2] ?? ""}`);
          return JSON.stringify({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            url: issue.html_url,
            state: "OPEN",
            labels: [],
            milestone: null,
          });
        }
        throw new Error(`Unexpected gh call: ${args.join(" ")}`);
      } });
      return client;
    };
    return { issues, createTitles, calls: () => calls, makeClient };
  }

  it("creates the issue DAG topologically and returns authoritative dependency mappings", async () => {
    const github = fixture();
    const input = request();
    const result = await github.makeClient().materializePlan(input);

    assert.deepEqual(github.createTitles, ["Build the plan materializer", "Verify the materialized plan"]);
    assert.deepEqual(result.nodes.map((node) => node.nodeId), ["verify", "build"]);
    const build = result.nodes.find((node) => node.nodeId === "build")!;
    const verify = result.nodes.find((node) => node.nodeId === "verify")!;
    assert.deepEqual(verify.dependsOnNodeIds, ["build"]);
    assert.deepEqual(verify.dependencyIssueNumbers, [build.issue.number]);
    assert.equal(build.issue.state, "OPEN");
    assert.match(build.issue.body.split("\n")[0] ?? "", /^<!-- FORGEDOCK:PLAN-NODE v1 identity=[a-f0-9]{64} contract=[a-f0-9]{64} -->$/);
    for (const expected of [
      "Every node has one deterministic issue.",
      "src/adapters/github/github-client.ts",
      "component:github-plan-materialization",
      "Run plan materialization regressions.",
      "**Priority:** 10",
      "**Risk class:** `security`",
      "Issue projection belongs in the GitHub adapter.",
      "The adapter already owns deterministic issue materialization",
      "The existing adapter remains the GitHub authority.",
      "One independently deliverable and verifiable work unit.",
      "Keep each node independently reviewable.",
      "Automatic dispatch before confirmation.",
    ]) assert.ok(build.issue.body.includes(expected), `missing full plan context: ${expected}`);
    assert.ok(verify.issue.body.includes(`#${build.issue.number} — build: Build the plan materializer`));
  });

  it("adopts exact marker/digest matches across cached and fresh admission stores", async () => {
    const github = fixture();
    const input = request();
    const cachedClient = github.makeClient();
    const first = await cachedClient.materializePlan(input);
    const cached = await cachedClient.materializePlan(input);
    const fresh = await github.makeClient().materializePlan(input);
    assert.equal(github.issues.length, 2);
    assert.deepEqual(cached.nodes.map((node) => node.issue.number), first.nodes.map((node) => node.issue.number));
    assert.deepEqual(fresh.nodes.map((node) => node.issue.number), first.nodes.map((node) => node.issue.number));
  });

  it("rejects a changed node contract at the same immutable identity before another write", async () => {
    const github = fixture();
    const input = request();
    await github.makeClient().materializePlan(input);
    const changed: PlanMaterializationRequest = {
      ...input,
      nodes: input.nodes.map((node) => node.nodeId === "verify"
        ? { ...node, outcome: "A different contract under the same revision." }
        : node),
    };
    await assert.rejects(
      github.makeClient().materializePlan(changed),
      /Plan node verify already exists with a different contract digest/,
    );
    assert.equal(github.issues.length, 2);
  });

  it("preflights every dependency before making a GitHub call", async () => {
    const input = request();
    const invalid: PlanMaterializationRequest = {
      ...input,
      nodes: input.nodes.map((node) => node.nodeId === "verify"
        ? { ...node, dependsOnNodeIds: ["missing"] }
        : node),
    };
    let calls = 0;
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async () => { calls += 1; throw new Error("must not call GitHub"); } });
    await assert.rejects(client.materializePlan(invalid), /Unknown plan dependency 'missing' for node 'verify'/);
    assert.equal(calls, 0);
  });
});

describe("GitHub remediation admission", () => {
  const input = {
    repo: "Owner/Repo",
    parentRunId: "run-parent",
    parentIssue: 20,
    parentPullRequest: 9,
    headSha: "a".repeat(40),
    headBranch: "forge/parent",
    baseBranch: "main",
    checkpointKey: "checkpoint-1",
    remediationDepth: 1,
    findings: [{ id: "finding-1", title: "Fix", evidence: "Evidence", location: "src/a.ts:1", remediation: "Add guard", acceptanceCriterion: "The guard exists" }],
  } as const;

  function clients(options: { visibleAfter: number; failFirstRead?: boolean }) {
    const admissions = new InMemoryRemediationAdmissionRepository();
    const issues: Array<{ number: number; title: string; body: string; html_url: string; state: "open" }> = [];
    let listCalls = 0;
    let creates = 0;
    let failFirstRead = options.failFirstRead ?? false;
    const make = () => {
      const client = new GitHubClient(".", admissions);
      Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
        if (args[0] === "api" && args[1]?.includes("issues?state=all")) {
          listCalls += 1;
          return JSON.stringify([listCalls >= options.visibleAfter ? issues : []]);
        }
        if (args[0] === "issue" && args[1] === "create") {
          creates += 1;
          const number = 100 + creates;
          issues.push({ number, title: args[args.indexOf("--title") + 1] ?? "Child", body: body ?? "", html_url: `https://github.test/a/b/issues/${number}`, state: "open" });
          return `https://github.test/a/b/issues/${number}\n`;
        }
        if (args[0] === "issue" && args[1] === "view") {
          if (failFirstRead) { failFirstRead = false; throw new Error("post-create read interrupted"); }
          const issue = issues.find((candidate) => candidate.number === Number(args[2]));
          if (!issue) throw new Error("issue not found");
          return JSON.stringify({ number: issue.number, title: issue.title, body: issue.body, url: issue.html_url, state: "OPEN", labels: [], milestone: null });
        }
        if (args[0] === "api" && args[1]?.includes("/comments")) return "[[]]";
        throw new Error(`Unexpected gh call: ${args.join(" ")}`);
      } });
      return client;
    };
    return { make, creates: () => creates };
  }

  it("uses one durable admission for concurrent clients and adopts delayed visibility", async () => {
    const fixture = clients({ visibleAfter: 10 });
    const [first, second] = await Promise.all([
      fixture.make().materializeRemediationChildren(input),
      fixture.make().materializeRemediationChildren(input),
    ]);
    assert.equal(fixture.creates(), 1);
    assert.equal(first[0]?.number, second[0]?.number);
  });

  it("fails closed after an accepted create when marker visibility remains unresolved", async () => {
    const fixture = clients({ visibleAfter: Number.MAX_SAFE_INTEGER, failFirstRead: true });
    await assert.rejects(fixture.make().materializeRemediationChildren(input), /post-create read interrupted/);
    await assert.rejects(fixture.make().materializeRemediationChildren(input), /remains unresolved/);
    assert.equal(fixture.creates(), 1);
  });
});

describe("GitHub issue closure", () => {
  function closeClient(closeChangesState: boolean) {
    let state: "OPEN" | "CLOSED" = "OPEN";
    const comments: Array<{ body: string }> = [];
    let closeCalls = 0;
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[], input?: string) => {
      if (args[0] === "issue" && args[1] === "view") {
        return JSON.stringify({ number: 2, title: "Issue", body: "", url: "https://github.test/a/b/issues/2", state, labels: [], milestone: null });
      }
      if (args[0] === "issue" && args[1] === "close") {
        closeCalls += 1;
        if (closeChangesState) state = "CLOSED";
        return "";
      }
      if (args[0] === "api" && args.some((arg) => arg === "POST")) {
        comments.push({ body: JSON.parse(input ?? "{}").body as string });
        return "{}";
      }
      if (args[0] === "api") return JSON.stringify([comments]);
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    return { client, comments, closeCalls: () => closeCalls };
  }

  it("confirms authoritative closure and deduplicates its audit comment", async () => {
    const fixture = closeClient(true);
    await fixture.client.closeIssue("a/b", 2, "Done");
    await fixture.client.closeIssue("a/b", 2, "Done");
    assert.equal(fixture.closeCalls(), 1);
    assert.equal(fixture.comments.length, 1);
  });

  it("rejects a close command that leaves authoritative GitHub state open", async () => {
    const fixture = closeClient(false);
    await assert.rejects(fixture.client.closeIssue("a/b", 2, "Done"), /authoritative GitHub state is OPEN/);
  });
});

describe("GitHub durable artifact projection", () => {
  it("publishes cross-artifact review verdicts to both PR and issue idempotently", async () => {
    const client = new CommentClient();
    const repository = new GitHubArtifactRepository(client);
    const artifact = createArtifact({
      kind: "ReviewVerdict", runId: "run", subject: { repo: "a/b", issue: 2, pr: 3 }, producer: { role: "controller" },
      payload: { headSha: "a".repeat(40), disposition: "approve", reviewerRoles: ["correctness"], findings: [], checks: [] },
    });
    await repository.append(artifact);
    await repository.append(artifact);
    assert.equal(client.comments.get("a/b#pr3")?.length, 1);
    assert.equal(client.comments.get("a/b#i2")?.length, 1);
    assert.equal((await repository.list(artifact.subject)).length, 1);
  });

  it("recovers a projection after the remote comment succeeds before admission completion", async () => {
    const client = new CommentClient();
    const admissions = new InMemoryRemediationAdmissionRepository();
    const artifact = createArtifact({
      kind: "Intent", runId: "run-recovery", subject: { repo: "a/b", issue: 2 }, producer: { role: "test" },
      payload: { title: "Recovery", problem: "test", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    client.failAfterPost = true;
    await assert.rejects(new GitHubArtifactRepository(client, admissions).append(artifact), /after remote write/);
    await new GitHubArtifactRepository(client, admissions).append(artifact);
    assert.equal(client.postCalls, 1);
    assert.equal((await new GitHubArtifactRepository(client, admissions).list(artifact.subject)).length, 1);
  });

  it("re-reads GitHub before honoring a cached materialized artifact admission", async () => {
    const client = new CommentClient();
    const admissions = new InMemoryRemediationAdmissionRepository();
    const repository = new GitHubArtifactRepository(client, admissions);
    const artifact = createArtifact({
      kind: "Intent", runId: "run-stale-cache", subject: { repo: "a/b", issue: 2 }, producer: { role: "test" },
      payload: { title: "Stale cache", problem: "test", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    await repository.append(artifact);
    client.comments.delete("a/b#i2");
    await assert.rejects(repository.append(artifact), /admission is retained pending reconciliation/);
    assert.equal(client.postCalls, 1);
  });

  it("filters embedded artifacts by canonical target while retaining issue/PR overlap", async () => {
    const client = new CommentClient();
    const repository = new GitHubArtifactRepository(client);
    const make = (id: string, subject: Subject) => createArtifact({
      kind: "Intent", runId: id, subject, producer: { role: "test" },
      payload: { title: id, problem: "test", constraints: [], acceptanceHints: [], dependencies: [] },
    }, { id, createdAt: "2026-01-01T00:00:00.000Z" });
    const issue = make("issue", { repo: "A/B", issue: 2 });
    const pull = make("pull", { repo: "a/b", pr: 3 });
    const both = make("both", { repo: "a/b", issue: 2, pr: 3 });
    const wrongIssue = make("wrong-issue", { repo: "a/b", issue: 99 });
    const wrongPull = make("wrong-pull", { repo: "a/b", pr: 99 });
    const wrongRepo = make("wrong-repo", { repo: "other/repo", issue: 2 });
    const embedded = [issue, pull, both, wrongIssue, wrongPull, wrongRepo].map(renderArtifactComment).join("\\n");
    client.comments.set("a/b#pr3", [embedded]);
    client.comments.set("a/b#i2", [embedded]);
    assert.deepEqual(
      (await repository.list({ repo: " A/B ", issue: 2, pr: 3 })).map((item) => item.id),
      [issue.id, pull.id, both.id],
    );
  });
});
