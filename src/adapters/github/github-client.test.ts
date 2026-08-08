import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { Subject } from "../../core/artifacts/schema.js";
import { renderArtifactComment } from "../../core/artifacts/codec.js";
import { GitHubArtifactRepository, repositoryFromRemote, reviewFindingMarker, reviewFindingReconciliationCandidates, workflowLabelForState } from "./github-client.js";

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
