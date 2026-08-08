import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { Subject } from "../../core/artifacts/schema.js";
import { renderArtifactComment } from "../../core/artifacts/codec.js";
import { GitHubArtifactRepository, workflowLabelForState } from "./github-client.js";

class CommentClient {
  comments = new Map<string, string[]>();
  async listIssueComments(subject: Subject): Promise<string[]> { return this.comments.get(key(subject)) ?? []; }
  async postIssueComment(subject: Subject, body: string): Promise<void> {
    const values = this.comments.get(key(subject)) ?? []; values.push(body); this.comments.set(key(subject), values);
  }
}
function key(subject: Subject) { return `${subject.repo}#${subject.pr ? `pr${subject.pr}` : `i${subject.issue}`}`; }

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
    assert.equal((await repository.list(artifact.subject, "ReviewVerdict")).length, 1);
    assert.equal((await repository.list(artifact.subject, "Intent")).length, 0);
  });

  it("filters embedded artifacts by canonical subject while retaining issue/PR overlap", async () => {
    const client = new CommentClient();
    const repository = new GitHubArtifactRepository(client);
    const makeArtifact = (id: string, subject: Subject) => createArtifact({
      kind: "Intent", runId: id, subject, producer: { role: "test" },
      payload: { title: id, problem: "test", constraints: [], acceptanceHints: [], dependencies: [] },
    }, { id, createdAt: "2026-01-01T00:00:00.000Z" });
    const issue = makeArtifact("issue", { repo: "A/B", issue: 2 });
    const pull = makeArtifact("pull", { repo: "a/b", pr: 3 });
    const both = makeArtifact("both", { repo: "a/b", issue: 2, pr: 3 });
    const wrongIssue = makeArtifact("wrong-issue", { repo: "a/b", issue: 99 });
    const wrongPull = makeArtifact("wrong-pull", { repo: "a/b", pr: 99 });
    const wrongRepo = makeArtifact("wrong-repo", { repo: "other/repo", issue: 2 });
    const embedded = [issue, pull, both, wrongIssue, wrongPull, wrongRepo].map(renderArtifactComment).join("\n");
    client.comments.set("a/b#pr3", [embedded]);
    client.comments.set("a/b#i2", [embedded]);

    assert.deepEqual(
      (await repository.list({ repo: " A/B ", issue: 2, pr: 3 })).map((artifact) => artifact.id),
      [issue.id, pull.id, both.id],
    );
  });
});
