import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { Subject } from "../../core/artifacts/schema.js";
import { renderArtifactComment } from "../../core/artifacts/codec.js";
import type { PlanMaterializationRequest } from "../../core/ports/forge-host.js";
import { InMemoryRemediationAdmissionRepository } from "../../core/ports/repositories.js";
import { terminalReviewFindings } from "../../workflows/review-pr/review.js";
import { GitHubArtifactRepository, GitHubClient, renderPaginatedPullRequestDiff, repositoryFromRemote, reviewFindingLaneMarker, reviewFindingMarker, reviewFindingReconciliationCandidates, workflowLabelForState } from "./github-client.js";

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
    assert.deepEqual(await client.listOpenIssueNumbersForSearch("is:issue  state:open no:milestone", "a/b"), [8, 9]);
    assert.deepEqual(received, [
      "issue", "list", "--repo", "a/b", "--state", "open",
      "--search", "is:issue state:open no:milestone", "--limit", "1000", "--json", "number,state,milestone",
    ]);
  });
});

describe("GitHub branch provisioning", () => {
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
      if (args[0] === "pr" && args[1] === "checks") return "[]";
      if (args[0] === "pr" && args[1] === "merge") {
        state = "MERGED";
        throw new Error("transport closed after GitHub accepted the merge");
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await client.mergePullRequest("a/b", 186, headSha, "staging");
    assert.equal(state, "MERGED");
  });

  it("requires the initial pull request to be open before reading its merge gate", async () => {
    const client = new GitHubClient();
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "pr" && args[1] === "view") return JSON.stringify(pullRequestProjection(186, "CLOSED"));
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    await assert.rejects(
      client.getPullRequestMergeGate("a/b", 186, headSha, "staging"),
      /is not open \(GitHub state: CLOSED\)/,
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

describe("GitHub review finding projection", () => {
  it("derives a stable deduplication marker from PR, location, and finding identity", () => {
    const finding = {
      id: "security-1", severity: "medium" as const, confidence: "high" as const, blocking: true,
      title: "Token can be replayed", evidence: "No nonce", location: "src/auth.ts:20",
      intentRelevance: "Breaks authorization", remediation: "Consume a nonce",
    };
    const first = reviewFindingMarker("A/B", 57, finding);
    const second = reviewFindingMarker("a/b", 57, { ...finding, id: "renamed", evidence: "Expanded evidence" });
    assert.equal(first, second);
    assert.match(first, /^<!-- FORGEDOCK:REVIEW-FINDING [a-f0-9]{64} -->$/);
    assert.equal(reviewFindingLaneMarker("A/B", 57), reviewFindingLaneMarker("a/b", 57));
    assert.match(reviewFindingLaneMarker("a/b", 57), /^<!-- FORGEDOCK:REVIEW-FINDING-LANE v1 [a-f0-9]{64} -->$/);
  });

  it("reconciles only stale open findings from the same run and pull request", () => {
    const finding = {
      id: "review-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Schema is incomplete", evidence: "Request fields are missing", location: "src/schema.ts:20",
      intentRelevance: "Breaks clients", remediation: "Define fields",
    };
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: "a".repeat(40), headBranch: "fix", baseBranch: "main",
    };
    const aggregate = terminalReviewFindings([
      { ...finding, reviewerRoles: ["correctness"], scopeDisposition: "in_scope" },
      { ...finding, id: "review-2222222222222222", title: "Response schema is incomplete", evidence: "Response fields are missing", reviewerRoles: ["data"], scopeDisposition: "in_scope" },
    ])[0]!;
    const body = (marker: string, run = "run-1", pr = 57) => `**Source:** PR #${pr} — Fix\n**Run:** \`${run}\`\n${marker}`;
    const staleMarker = reviewFindingMarker("a/b", 57, finding);
    const issues = [
      { repo: "a/b", number: 1, title: "active aggregate", body: body(reviewFindingMarker("a/b", 57, aggregate)), url: "u1", state: "OPEN" as const },
      { repo: "a/b", number: 2, title: "stale component", body: body(staleMarker), url: "u2", state: "OPEN" as const },
      { repo: "a/b", number: 3, title: "other run", body: body(staleMarker, "run-2"), url: "u3", state: "OPEN" as const },
      { repo: "a/b", number: 4, title: "closed", body: body(staleMarker), url: "u4", state: "CLOSED" as const },
    ];
    assert.deepEqual(reviewFindingReconciliationCandidates(issues, {
      repo: "a/b", pullRequest, runId: "run-1", activeFindings: [aggregate],
    }).map(({ number }) => number), [2]);
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

  it("adopts an existing open lane issue across a fresh admission store", async () => {
    const pullRequest = {
      repo: "a/b", number: 57, title: "Fix", body: "", url: "https://github.test/a/b/pull/57",
      state: "OPEN" as const, headSha: "a".repeat(40), headBranch: "fix", baseBranch: "main",
    };
    const finding = {
      id: "review-terminal-1111111111111111", severity: "high" as const, confidence: "high" as const, blocking: true,
      title: "Retained finding", evidence: "The open lane issue already records this root.", location: "src/schema.ts:20",
      intentRelevance: "Keeps the review root durable", remediation: "Apply the recorded fix.",
    };
    const issue = {
      number: 88, title: "existing lane finding", body: `**Source:** PR #57 — Fix\n${reviewFindingLaneMarker("a/b", 57)}\n${reviewFindingMarker("a/b", 57, finding)}`,
      html_url: "https://github.test/a/b/issues/88", state: "open" as const,
    };
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
    let created = false;
    Object.defineProperty(client, "gh", { value: async (args: string[]) => {
      if (args[0] === "label" && args[1] === "create") return "";
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return JSON.stringify([[issue]]);
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
  it("adopts an existing open lane issue when an aggregate root set changes and closes duplicates", async () => {
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
    const firstAggregate = terminalReviewFindings([
      finding("review-1111111111111111", 1), finding("review-2222222222222222", 2),
    ])[0]!;
    const secondAggregate = terminalReviewFindings([
      finding("review-3333333333333333", 3), finding("review-4444444444444444", 4),
    ])[0]!;
    assert.notEqual(firstAggregate.id, secondAggregate.id);
    assert.notEqual(reviewFindingMarker("a/b", 57, firstAggregate), reviewFindingMarker("a/b", 57, secondAggregate));

    const issues: Array<{ number: number; title: string; body: string; html_url: string; state: "open" | "closed" }> = [];
    const closed: number[] = [];
    const client = new GitHubClient(".", new InMemoryRemediationAdmissionRepository());
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
          state: issue.state.toUpperCase(), labels: [], milestone: null,
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
    const firstIssue = await client.materializeReviewFinding({ ...baseInput, finding: firstAggregate });
    const secondIssue = await client.materializeReviewFinding({ ...baseInput, finding: secondAggregate });
    assert.equal(firstIssue.number, secondIssue.number);
    assert.equal(issues.length, 1);
    issues.push({
      number: 999,
      title: "duplicate lane finding",
      body: `**Source:** PR #57 — Fix\n**Run:** \`run-old\`\n${reviewFindingLaneMarker("a/b", 57)}\n${reviewFindingMarker("a/b", 57, firstAggregate)}`,
      html_url: "https://github.test/a/b/issues/999",
      state: "open",
    });
    assert.deepEqual(await client.reconcileReviewFindings({
      repo: "a/b", pullRequest, runId: "run-1", activeFindings: [secondAggregate],
    }), [999]);
    assert.deepEqual(closed, [999]);
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
