// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { ArtifactKind } from "../../core/artifacts/schema.js";
import { applyPristineReset, dryRunPristineReset, replayLabels, resetManifestDigest, sha256, type PristineResetManifest, type ResetPlanDependencies } from "./pristine-reset.js";

const sha = "a".repeat(40);
function fakeDeps(overrides: Partial<ResetPlanDependencies> = {}): ResetPlanDependencies & { mutations: string[] } {
  const mutations: string[] = [];
  const closedPrs = new Set<number>();
  const deletedRefs = new Set<string>();
  const deletedComments = new Set<number>();
  const deps: ResetPlanDependencies & { mutations: string[] } = {
    mutations,
    host: {
      readIssue: async (_repo, issue) => ({ number: issue, state: "OPEN", labels: ["workflow:building", "customer"], body: "original body" }),
      listComments: async (_repo, issue) => (issue === 1 ? [{ id: 11, issue, marker: "artifact:a1", runId: "run-1", artifactId: "a1", bodySha256: sha256("managed"), body: "managed", managed: true as const }, { id: 13, issue, marker: "<!-- FORGEDOCK:REVIEWER run-1 -->", bodySha256: sha256("copied"), body: "copied marker", managed: true as const }] : [{ id: 12, issue, marker: "human", bodySha256: "y", body: "human", managed: true as const }]).filter((comment) => !deletedComments.has(comment.id)),
      deleteComment: async (_repo, comment) => { deletedComments.add(comment.id); mutations.push(`comment:${comment.id}`); },
      readLabels: async () => ({ current: ["workflow:building"], events: [], restored: [] }),
      restoreLabels: async (_repo, issue, labels) => { mutations.push(`labels:${issue}:${labels.join(",")}`); },
      readPullRequest: async (_repo, number) => ({ number, state: closedPrs.has(number) ? "CLOSED" as const : "OPEN" as const, headSha: sha, headBranch: "forgedock/issue-1-run", baseBranch: "main" }),
      closePullRequest: async (_repo, number) => { closedPrs.add(number); mutations.push(`close:${number}`); },
      readRef: async (_repo, ref) => deletedRefs.has(ref) ? undefined : sha,
      deleteExactRef: async (_repo, ref) => { deletedRefs.add(ref); mutations.push(`ref:${ref}`); },
    },
    state: {
      capture: async () => ({ runs: [{ runId: "run-1", version: 1, state: "building" }], artifacts: [{ artifactId: "a1", subjectKey: "o/r|i:1|p:", kind: "Intent" as ArtifactKind, sha256: "artifact" }], tasks: [], observations: [], fences: [], promotions: [], dags: [], leases: [], archive: [] }),
      purgeExactManifest: async () => ({ runs: 0, artifacts: 0, orchestrations: 0, promotions: 0, telemetry: 0, remediationAdmissions: 0, reviewFindingFences: 0, leases: 0 }),
    },
    workspaces: { capture: async () => [], archiveDirty: async () => undefined, removeExact: async () => undefined },
    cancellation: { fence: async () => { mutations.push("fence"); }, stopWorkers: async () => { mutations.push("stop"); } },
  };
  return Object.assign(deps, overrides);
}

describe("typed pristine repository reset", () => {
  it("dry-run is read-only and replays labels deterministically", async () => {
    assert.deepEqual(replayLabels([
      { name: "workflow:building", action: "labeled", occurredAt: "2026-01-02", eventId: 2 },
      { name: "workflow:building", action: "unlabeled", occurredAt: "2026-01-03", eventId: 3 },
      { name: "workflow:investigating", action: "labeled", occurredAt: "2026-01-01", eventId: 1 },
    ]), ["workflow:investigating"]);
    const deps = fakeDeps();
    const manifest = await dryRunPristineReset({ repo: "o/r", issueNumbers: [1], dagIds: [] }, deps);
    assert.equal(manifest.schema, "forgedock.pristine-reset/v1");
    const { digest: _digest, ...unsigned } = manifest;
    assert.equal(manifest.digest, resetManifestDigest(unsigned));
    assert.deepEqual(deps.mutations, []);
    assert.deepEqual(manifest.comments.map((comment) => comment.id), [11]);
  });

  it("restores labels from the pre-workflow cutoff rather than current workflow labels", async () => {
    const deps = fakeDeps();
    deps.host.readLabels = async () => ({
      current: ["workflow:building", "needs-human"],
      events: [
        { name: "customer", action: "labeled", occurredAt: "2026-01-01T00:00:00Z", eventId: 1 },
        { name: "workflow:building", action: "labeled", occurredAt: "2026-01-02T00:00:00Z", eventId: 2 },
        { name: "needs-human", action: "labeled", occurredAt: "2026-01-03T00:00:00Z", eventId: 3 },
      ], restored: [],
    });
    const manifest = await dryRunPristineReset({ repo: "o/r", issueNumbers: [1], dagIds: [] }, deps);
    assert.deepEqual(manifest.labels["1"]?.restored, ["customer"]);
  });

  it("rejects a tampered digest before fencing or cleanup", async () => {
    const deps = fakeDeps();
    const manifest = await dryRunPristineReset({ repo: "o/r", issueNumbers: [1], dagIds: [] }, deps);
    await assert.rejects(() => applyPristineReset({ ...manifest, repo: "other/repo" }, manifest.digest, deps), /digest/i);
    assert.deepEqual(deps.mutations, []);
  });

  it("deletes only managed comments, closes rather than deletes PRs, and preserves unrelated refs", async () => {
    const deps = fakeDeps();
    const manifest = await dryRunPristineReset({ repo: "o/r", issueNumbers: [1], dagIds: [] }, deps);
    const selected: PristineResetManifest = { ...manifest, pullRequests: [{ number: 7, state: "OPEN", headSha: sha, headBranch: "forgedock/issue-1-run", baseBranch: "main" }], refs: [{ name: "run", kind: "remote", sha, exactRef: "refs/heads/forgedock/issue-1-run", managed: true }], actions: manifest.actions };
    const { digest: _selectedDigest, ...selectedUnsigned } = selected;
    const prepared = { ...selected, digest: resetManifestDigest(selectedUnsigned) };
    await applyPristineReset(prepared, prepared.digest, deps);
    assert.ok(deps.mutations.includes("comment:11"));
    assert.ok(!deps.mutations.includes("comment:12"));
    assert.ok(deps.mutations.includes("close:7"));
    assert.ok(deps.mutations.includes("ref:refs/heads/forgedock/issue-1-run"));
  });
  it("rechecks selected canonical comments after fencing", async () => {
    const deps = fakeDeps();
    let fenced = false;
    deps.cancellation.fence = async () => { fenced = true; };
    const original = deps.host.listComments;
    deps.host.listComments = async (repo, issue) => {
      const comments = await original(repo, issue);
      return fenced ? [...comments, { id: 99, issue, marker: "artifact:a1", runId: "run-1", artifactId: "a1", bodySha256: sha256("late"), body: "late", managed: true as const }] : comments;
    };
    const manifest = await dryRunPristineReset({ repo: "o/r", issueNumbers: [1], dagIds: [] }, deps);
    await assert.rejects(() => applyPristineReset(manifest, manifest.digest, deps), /newly appeared selected comment/i);
    assert.deepEqual(deps.mutations, ["stop"]);
  });

  it("refuses destructive actions when the pre-destruction archive is incomplete", async () => {
    const deps = fakeDeps();
    deps.state.archiveSnapshots = async () => [{ path: "/definitely/missing/archive", sha256: "b".repeat(64), kind: "evidence" }];
    const manifest = await dryRunPristineReset({ repo: "o/r", issueNumbers: [1], dagIds: [] }, deps);
    await assert.rejects(() => applyPristineReset(manifest, manifest.digest, deps), /archive is missing/i);
    assert.deepEqual(deps.mutations, ["fence", "stop"]);
  });

  it("archives dirty worktrees before exact force removal", async () => {
    const deps = fakeDeps();
    const order: string[] = [];
    deps.workspaces = {
      capture: async () => [{ path: "/tmp/managed", branch: "forgedock/issue-1-run", headSha: sha, dirty: ["src/change.ts"], managed: true as const }],
      archiveDirty: async () => { writeFileSync("/tmp/archive.diff", "diff"); order.push("archive"); return { path: "/tmp/archive.diff", sha256: sha256("diff"), kind: "dirty-diff" }; },
      removeExact: async () => { order.push("remove"); },
    };
    const manifest = await dryRunPristineReset({ repo: "o/r", issueNumbers: [1], dagIds: [] }, deps);
    await applyPristineReset(manifest, manifest.digest, deps);
    assert.deepEqual(order, ["archive", "remove"]);
  });
});
