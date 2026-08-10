import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BranchSnapshot, IssueSnapshot } from "../../core/ports/forge-host.js";
import { createRun } from "../../core/state/machine.js";
import {
  assertRunFollowsLane,
  classifyIssueLane,
  resolveIssueLane,
  runTargetForLane,
  sanitizeMilestoneSlug,
} from "./lane.js";

const sha = "a".repeat(40);
const milestone = { number: 1, title: "Verifiable Workflow Authority & Portability" };
const issue: IssueSnapshot = {
  repo: "a/b",
  number: 6,
  title: "Freeze trust contract",
  body: "",
  url: "https://github.test/a/b/issues/6",
  state: "OPEN",
  milestone,
};
const issueWithoutMilestone: IssueSnapshot = {
  repo: issue.repo,
  number: issue.number,
  title: issue.title,
  body: issue.body,
  url: issue.url,
  state: issue.state,
};

function branch(name: string): BranchSnapshot {
  return { name, headSha: sha };
}

describe("issue lane classification", () => {
  it("sanitizes milestone titles deterministically", () => {
    assert.equal(
      sanitizeMilestoneSlug(milestone.title),
      "verifiable-workflow-authority-portability",
    );
    assert.equal(sanitizeMilestoneSlug(" 🚀 "), "");
  });

  it("uses the canonical sanitized milestone branch when it exists", () => {
    const lane = classifyIssueLane(issue, "main", [
      branch("milestone/verifiable-workflow-authority-portability"),
      branch("milestone/unrelated"),
    ]);
    assert.equal(lane.kind, "feature");
    assert.equal(lane.targetBranch, "milestone/verifiable-workflow-authority-portability");
    assert.equal(lane.resolution, "canonical");
  });

  it("follows an established pre-qualifier branch after a milestone title gains an ampersand suffix", () => {
    const lane = classifyIssueLane(issue, "main", [
      branch("milestone/verifiable-workflow-authority"),
      branch("milestone/compounding-project-intelligence"),
    ]);
    assert.equal(lane.kind, "feature");
    assert.equal(lane.targetBranch, "milestone/verifiable-workflow-authority");
    assert.equal(lane.resolution, "stable-title-prefix");
  });

  it("does not guess an arbitrary fuzzy milestone prefix", () => {
    assert.throws(
      () => classifyIssueLane(issue, "main", [branch("milestone/verifiable-workflow")]),
      /no corresponding remote branch exists/,
    );
  });

  it("routes an issue without a milestone to the repository default branch", () => {
    const lane = classifyIssueLane(issueWithoutMilestone, "main");
    assert.deepEqual(lane, { kind: "fast", targetBranch: "main", resolution: "repository-default" });
  });

  it("honors explicit staging-review source branch evidence instead of defaulting to main", () => {
    const stagingReview: IssueSnapshot = {
      ...issueWithoutMilestone,
      labels: ["staging-review"],
      body: [
        "**Code branch**: `staging`",
        "**Worktree base**: `origin/staging`",
      ].join("\n"),
    };
    assert.deepEqual(classifyIssueLane(stagingReview, "main"), {
      kind: "fast", targetBranch: "staging", resolution: "explicit-source-branch",
    });
  });

  it("accepts the documented Code branch evidence without requiring a duplicate Worktree base", () => {
    assert.deepEqual(classifyIssueLane({
      ...issueWithoutMilestone,
      labels: ["staging-review"],
      body: "**Code branch**: `staging`",
    }, "main"), {
      kind: "fast", targetBranch: "staging", resolution: "explicit-source-branch",
    });
  });

  it("fails closed when a staging-review issue omits its source branch evidence", () => {
    assert.throws(
      () => classifyIssueLane({ ...issueWithoutMilestone, labels: ["staging-review"] }, "main"),
      /requires explicit.*Worktree base/,
    );
  });

  it("rejects conflicting staging-review code and worktree branches", () => {
    assert.throws(
      () => classifyIssueLane({
        ...issueWithoutMilestone,
        labels: ["staging-review"],
        body: "**Code branch**: `staging`\n**Worktree base**: `origin/main`",
      }, "main"),
      /conflicts/,
    );
  });

  it("fails closed when the milestone branch is absent", () => {
    assert.throws(
      () => classifyIssueLane(issue, "main", []),
      /expected `milestone\/verifiable-workflow-authority-portability` or established branch `milestone\/verifiable-workflow-authority`/,
    );
  });

  it("revalidates the selected remote ref before returning it", async () => {
    const reads: string[] = [];
    const lane = await resolveIssueLane(issue, "main", {
      async listBranches(repo, prefix) {
        assert.equal(repo, "a/b");
        assert.equal(prefix, "milestone/");
        return [branch("milestone/verifiable-workflow-authority")];
      },
      async getBranchHead(repo, name) {
        reads.push(`${repo}:${name}`);
        return sha;
      },
    });
    assert.equal(lane.targetBranch, "milestone/verifiable-workflow-authority");
    assert.deepEqual(reads, ["a/b:milestone/verifiable-workflow-authority"]);
  });

  it("prevents a persisted run from crossing to a newly classified lane", () => {
    const fast = classifyIssueLane(issueWithoutMilestone, "main");
    const run = createRun({
      workflow: "work-on",
      subject: { repo: issue.repo, issue: issue.number },
      target: runTargetForLane(fast),
    });
    const feature = classifyIssueLane(issue, "main", [branch("milestone/verifiable-workflow-authority")]);
    assert.throws(() => assertRunFollowsLane(run, feature), /refusing cross-lane continuation/);
  });
});
