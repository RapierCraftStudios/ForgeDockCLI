import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { Subject } from "../../core/artifacts/schema.js";
import { renderArtifactComment } from "../../core/artifacts/codec.js";
import { GitHubArtifactRepository, GitHubClient, remediationChildMarker, repositoryFromRemote, reviewFindingMarker, reviewFindingReconciliationCandidates, workflowLabelForState } from "./github-client.js";

class CommentClient {
  comments = new Map<string, string[]>();
  async listIssueComments(subject: Subject): Promise<string[]> { return this.comments.get(key(subject)) ?? []; }
  async postIssueComment(subject: Subject, body: string): Promise<void> {
    const values = this.comments.get(key(subject)) ?? []; values.push(body); this.comments.set(key(subject), values);
  }
}
function key(subject: Subject) { return `${subject.repo}#${subject.pr ? `pr${subject.pr}` : `i${subject.issue}`}`; }

describe("GitHub repository resolution", () => {
  it("extracts the target repository from origin URLs without selecting upstream", () => {
    assert.equal(repositoryFromRemote("https://github.com/RapierCraftStudios/ForgeDockCLI"), "RapierCraftStudios/ForgeDockCLI");
    assert.equal(repositoryFromRemote("git@github.com:RapierCraftStudios/ForgeDockCLI.git"), "RapierCraftStudios/ForgeDockCLI");
    assert.equal(repositoryFromRemote("https://git.example.test/owner/repo.git"), undefined);
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
    const body = (marker: string, run = "run-1", pr = 57) => `**Source:** PR #${pr} — Fix\n**Run:** \`${run}\`\n${marker}`;
    const staleMarker = reviewFindingMarker("a/b", 57, { ...finding, id: "review-2222222222222222", evidence: "Different root cause" });
    const issues = [
      { repo: "a/b", number: 1, title: "active", body: body(reviewFindingMarker("a/b", 57, finding)), url: "u1", state: "OPEN" as const },
      { repo: "a/b", number: 2, title: "stale", body: body(staleMarker), url: "u2", state: "OPEN" as const },
      { repo: "a/b", number: 3, title: "other run", body: body(staleMarker, "run-2"), url: "u3", state: "OPEN" as const },
      { repo: "a/b", number: 4, title: "closed", body: body(staleMarker), url: "u4", state: "CLOSED" as const },
    ];
    assert.deepEqual(reviewFindingReconciliationCandidates(issues, {
      repo: "a/b", pullRequest, runId: "run-1", activeFindings: [finding],
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
});

describe("GitHub decomposition materialization", () => {
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
          labels: number === 7 ? [{ name: "enhancement" }] : [{ name: "enhancement" }],
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

describe("GitHub remediation materialization", () => {
  it("reuses an existing deterministic marker on retry", async () => {
    const client = new GitHubClient();
    const input = {
      repo: "a/b", parentRunId: "run_parent", parentIssue: 20, parentPullRequest: 9,
      headSha: "a".repeat(40), headBranch: "forge/parent", baseBranch: "main", checkpointKey: "c".repeat(64), remediationDepth: 1,
      findings: [{ id: "finding-1", title: "Fix", evidence: "Evidence", location: "src/a.ts:1", remediation: "Guard", acceptanceCriterion: "Guard passes" }],
    };
    const marker = remediationChildMarker(input.repo, input.parentRunId, input.parentIssue, input.parentPullRequest, input.headSha, "finding-1");
    let issue: { number: number; title: string; body: string; html_url: string; state: string } | undefined;
    let creates = 0;
    Object.defineProperty(client, "gh", { value: async (args: string[], body?: string) => {
      if (args[0] === "api" && args[1]?.includes("issues?state=all")) return JSON.stringify([issue ? [issue] : []]);
      if (args[0] === "issue" && args[1] === "create") {
        creates += 1;
        issue = { number: 40, title: "Child", body: `<!-- FORGEDOCK:REMEDIATION_CHILD ${marker} -->`, html_url: "https://github.test/a/b/issues/40", state: "open" };
        return "https://github.test/a/b/issues/40\n";
      }
      throw new Error(`Unexpected gh call: ${args.join(" ")}`);
    } });
    const first = await client.materializeRemediationChildren(input);
    const second = await client.materializeRemediationChildren(input);
    assert.deepEqual(first.map((child) => child.number), [40]);
    assert.deepEqual(second.map((child) => child.number), [40]);
    assert.equal(creates, 1);
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
