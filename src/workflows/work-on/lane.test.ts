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
    ], "staging", "staging");
    assert.equal(lane.kind, "feature");
    assert.equal(lane.targetBranch, "milestone/verifiable-workflow-authority-portability");
    assert.equal(lane.resolution, "canonical");
    assert.equal(lane.promotionTarget, "staging");
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

  it("honors an explicit configured staging fast-lane target", () => {
    assert.deepEqual(classifyIssueLane(issueWithoutMilestone, "main", [], "staging"), {
      kind: "fast", targetBranch: "staging", resolution: "configured-fast-lane",
    });
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

  it("honors an explicit target branch in acceptance text for an unmilestoned issue", () => {
    const explicit = {
      ...issueWithoutMilestone,
      body: "Open the delivery PR only against `milestone/forgedock-e2e-simple-20260809-130336-bb51b7`, never main.",
    };
    assert.deepEqual(classifyIssueLane(explicit, "main", [], "staging"), {
      kind: "fast", targetBranch: "milestone/forgedock-e2e-simple-20260809-130336-bb51b7", resolution: "explicit-target-branch",
    });
  });

  it("does not treat inline branch examples in issue evidence as routing authority", () => {
    const finding = {
      ...issueWithoutMilestone,
      body: [
        "## Problem",
        "Explicit branch evidence bypasses the protected production-target guard",
        "",
        "## Evidence",
        "With productionTarget=main and issue evidence such as **Code branch**: `main` or **Target branch**: `main`, the run incorrectly targets main.",
      ].join("\n"),
    };
    assert.deepEqual(classifyIssueLane(finding, "main", [], "staging", "staging", "main"), {
      kind: "fast", targetBranch: "staging", resolution: "configured-fast-lane",
    });
  });

  it("rejects every explicit branch field that targets protected production", () => {
    for (const body of [
      "**Code branch**: `main`",
      "**Worktree base**: `origin/main`",
      "**Target branch**: `main`",
    ]) {
      assert.throws(
        () => classifyIssueLane({ ...issueWithoutMilestone, body }, "main", [], "staging", "staging", "main"),
        /protected production branch main/,
      );
    }
  });

  it("rejects an explicit target that conflicts with a milestone lane", () => {
    assert.throws(() => classifyIssueLane({
      ...issue,
      body: "**Target branch**: `staging`",
    }, "main", [branch("milestone/verifiable-workflow-authority-portability")]), /conflicts with milestone/);
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

  it("can preview a canonical milestone lane before provisioning its branch", () => {
    const lane = classifyIssueLane(issue, "main", [], "staging", "staging", "main", { allowMissingMilestoneBranch: true });
    assert.equal(lane.kind, "feature");
    assert.equal(lane.targetBranch, "milestone/verifiable-workflow-authority-portability");
    assert.equal(lane.resolution, "planned-canonical");
  });

  it("provisions each missing milestone branch once from the default branch", async () => {
    const calls: string[] = [];
    let catalog: BranchSnapshot[] = [];
    const branches = {
      async listBranches() { return catalog; },
      async getBranchHead(_repo: string, branchName: string) { calls.push(`head:${branchName}`); return sha; },
      async createBranch(_repo: string, branchName: string, fromBranch: string) {
        calls.push(`create:${branchName}<- ${fromBranch}`);
        catalog = [...catalog, branch(branchName)];
        return branch(branchName);
      },
    };
    const created = await (await import("./lane.js")).provisionMissingMilestoneBranches([issue], "main", branches);
    assert.deepEqual(created, ["milestone/verifiable-workflow-authority-portability"]);
    assert.deepEqual(calls, [
      "head:main",
      "create:milestone/verifiable-workflow-authority-portability<- main",
    ]);
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

  it("freezes promotion and production targets and rejects policy drift", () => {
    const feature = classifyIssueLane(issue, "main", [branch("milestone/verifiable-workflow-authority")], "staging", "staging");
    const run = createRun({
      workflow: "work-on",
      subject: { repo: issue.repo, issue: issue.number },
      target: runTargetForLane(feature, "main"),
    });
    assert.equal(run.promotionTarget, "staging");
    assert.equal(run.productionTarget, "main");
    assert.doesNotThrow(() => assertRunFollowsLane(run, feature, "main"));
    assert.throws(() => assertRunFollowsLane(run, feature, "production"), /production target/);
  });

  it("prevents a persisted run from crossing to a newly classified lane", () => {
    const fast = classifyIssueLane(issueWithoutMilestone, "main");
    const run = createRun({
      workflow: "work-on",
      subject: { repo: issue.repo, issue: issue.number },
      target: runTargetForLane(fast),
    });
    const feature = classifyIssueLane(issue, "main", [branch("milestone/verifiable-workflow-authority")], "staging", "staging");
    assert.throws(() => assertRunFollowsLane(run, feature), /refusing cross-lane continuation/);
  });
});
