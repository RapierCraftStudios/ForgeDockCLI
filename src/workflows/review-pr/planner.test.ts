// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { assertReviewPlan, computeReviewPlanId, MAX_REVIEW_TOOL_CALLS_PER_EXECUTION_GROUP, planReviewPanel, reviewerToolCallBudget, scopedReviewDiff, type ReviewBudget, type ReviewPlan } from "./planner.js";

function packet(risks: Array<{ risk: string; mitigation: string }> = []) {
  return createArtifact({
    kind: "BuildPacket", runId: "run_plan", subject: { repo: "a/b", issue: 1 }, producer: { role: "packet-author" },
    payload: {
      scope: ["Implement the requested change"], acceptanceCriteria: ["It works"], context: [],
      implementationPlan: ["Change the bounded surface"], expectedPaths: ["src/a.ts"], verificationPlan: ["npm test"],
      risks, outOfScope: [],
    },
  });
}

const authorityDiff = [
  "diff --git a/SECURITY.md b/SECURITY.md",
  "--- a/SECURITY.md",
  "+++ b/SECURITY.md",
  "+Controller signatures and trust roots fail closed.",
  "diff --git a/docs/forgedock-next.html b/docs/forgedock-next.html",
  "--- a/docs/forgedock-next.html",
  "+++ b/docs/forgedock-next.html",
  "+<p>Architecture link</p>",
  "diff --git a/docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md b/docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md",
  "--- a/docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md",
  "+++ b/docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md",
  "+Canonical bytes, payload schema, portable bundle, lease fencing, atomic CAS, and event ordering are normative.",
].join("\n");

describe("evidence-backed review planning", () => {
  it("routes the authority-contract PR to four independent risk surfaces without docs/frontend or prose/infra false positives", () => {
    const plan = planReviewPanel({
      changedPaths: ["SECURITY.md", "docs/forgedock-next.html", "docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md"],
      diff: authorityDiff,
      packet: packet([
        { risk: "Cryptographic signatures and replay could be underspecified", mitigation: "Require trust roots and revocation" },
        { risk: "Persisted schema and canonical bundle formats may drift", mitigation: "Freeze canonical encoding" },
        { risk: "Lease fencing and atomic CAS can permit split-brain writes", mitigation: "Specify distributed coordination" },
        { risk: "Workflow authority must remain controller-owned", mitigation: "Do not add runtime behavior" },
      ]),
    });
    assert.deepEqual(plan.selected.map(({ role }) => role), ["correctness", "security", "data", "concurrency"]);
    assert.equal(plan.skipped.find(({ role }) => role === "frontend")?.reason, "below-threshold");
    assert.equal(plan.skipped.find(({ role }) => role === "infrastructure")?.reason, "below-threshold");
    assert.equal(plan.riskTier, "critical");
  });

  it("requires concrete product paths for frontend and infrastructure review", () => {
    const proseOnly = planReviewPanel({
      changedPaths: ["docs/workflow.html"],
      diff: "diff --git a/docs/workflow.html b/docs/workflow.html\n+workflow CSS deployment accessibility",
      packet: packet([{ risk: "Workflow documentation drift", mitigation: "Review the HTML" }]),
    });
    assert.deepEqual(proseOnly.selected.map(({ role }) => role), ["correctness"]);

    const concrete = planReviewPanel({
      changedPaths: ["web/src/App.tsx", ".github/workflows/ci.yml"],
      diff: [
        "diff --git a/web/src/App.tsx b/web/src/App.tsx", "+export function App() {}",
        "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml", "+jobs: {}",
      ].join("\n"),
      packet: packet(),
    });
    assert.deepEqual(concrete.selected.map(({ role }) => role), ["correctness", "frontend", "infrastructure"]);
  });

  it("hard-bounds specialist sessions while preserving all independently evidenced capabilities", () => {
    const plan = planReviewPanel({
      changedPaths: ["src/auth/token.ts", "db/migration.sql", "web/src/App.tsx", "infra/terraform/main.tf", "src/lease.ts"],
      diff: "",
      packet: packet(),
      maxSpecialists: 2,
    });
    assert.equal(plan.executionGroups.length, 3);
    assert.equal(plan.executionGroups.slice(1).length, 2);
    assert.equal(plan.budget.maxSpecialistExecutionGroups, 2);
    assert.equal(plan.budget.maxLogicalReviewerSessions, 3);
    assert.equal(plan.budget.maxAttemptsPerExecutionGroup, 2);
    assert.equal(plan.budget.maxToolCallsPerExecutionGroup, MAX_REVIEW_TOOL_CALLS_PER_EXECUTION_GROUP);
    assert.ok(plan.executionGroups.every((group) => reviewerToolCallBudget(group, plan) <= MAX_REVIEW_TOOL_CALLS_PER_EXECUTION_GROUP));
    assert.deepEqual(new Set(plan.capabilities.map(({ id }) => id)), new Set([
      "acceptance-correctness", "security", "data-integrity", "frontend", "release", "concurrency",
    ]));
    assert.ok(plan.executionGroups.slice(1).some(({ capabilities }) => capabilities.length > 1));
    assert.doesNotThrow(() => assertReviewPlan(plan));
  });

  it("does not let the hard session budget suppress an explicitly declared security capability", () => {
    const plan = planReviewPanel({
      changedPaths: ["docs/contract.md", "web/src/App.tsx"],
      diff: "diff --git a/docs/contract.md b/docs/contract.md\n+Trust contract clarified.\ndiff --git a/web/src/App.tsx b/web/src/App.tsx\n+export function App() {}",
      packet: packet([{ risk: "Signature replay and trust root ambiguity", mitigation: "Require revocation" }]),
      maxSpecialists: 1,
    });
    assert.equal(plan.executionGroups.length, 2);
    assert.deepEqual(new Set(plan.executionGroups[1]?.capabilities), new Set(["frontend", "security"]));
  });

  it("does not double-route semantic schema/protocol prose without independently concrete API and data surfaces", () => {
    const plan = planReviewPanel({
      changedPaths: ["docs/protocol.md"],
      diff: "diff --git a/docs/protocol.md b/docs/protocol.md\n+The public API uses a payload schema and canonical encoding.",
      packet: packet([
        { risk: "Public API backward compatibility and payload schema drift", mitigation: "Freeze the wire protocol" },
      ]),
    });
    const interoperability = plan.selected.map(({ role }) => role).filter((role) => role === "data" || role === "api-compatibility");
    assert.equal(interoperability.length, 1);
    assert.deepEqual(new Set(plan.capabilities.map(({ id }) => id)), new Set([
      "acceptance-correctness", "data-integrity", "api-compatibility",
    ]));
    assert.ok(plan.executionGroups.some(({ capabilities }) => capabilities.includes("data-integrity") && capabilities.includes("api-compatibility")));
    assert.equal(plan.skipped.find(({ role }) => role === "data" || role === "api-compatibility")?.reason, "overlapping-coverage");
  });

  it("uses explicit repository review policy as scored required evidence without matching generic specialty prose", () => {
    const required = planReviewPanel({
      changedPaths: ["docs/authority.md"],
      diff: "diff --git a/docs/authority.md b/docs/authority.md\n+Authority contract clarified.",
      packet: packet(),
      repositoryPolicy: [{ path: "FORGE.md", content: "Authority contract changes must receive a security review." }],
      maxSpecialists: 1,
    });
    assert.deepEqual(required.selected.map(({ role }) => role), ["correctness", "security"]);
    assert.equal(required.selected[1]?.required, true);
    assert.match(required.selected[1]?.reasons.join(" ") ?? "", /FORGE\.md/);

    const generic = planReviewPanel({
      changedPaths: ["docs/authority.md"], diff: "", packet: packet(),
      repositoryPolicy: [{ path: "AGENTS.md", content: "Security work can use the audit command catalog." }],
    });
    assert.deepEqual(generic.selected.map(({ role }) => role), ["correctness"]);
  });

  it("freezes plan identity and topology before review execution", () => {
    const plan = planReviewPanel({ changedPaths: ["src/worker.ts"], diff: "+commitResult(worker)", packet: packet(), maxSpecialists: 1 });
    assert.deepEqual(plan.selected.map(({ role }) => role), ["correctness"]);
    assert.equal(plan.frozen, true);
    assert.equal(plan.generation, 1);
    assert.match(plan.planId, /^review-plan-[a-f0-9]{20}$/);
    assert.equal(computeReviewPlanId(plan), plan.planId);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.executionGroups), true);
    assert.throws(() => plan.executionGroups.push({ ...plan.executionGroups[0]!, id: "adaptive" }));
  });

  it("rejects an uncovered capability or exceeded budget before any reviewer is launched", () => {
    const plan = planReviewPanel({ changedPaths: ["src/auth/token.ts", "db/a.sql"], diff: "", packet: packet(), maxSpecialists: 1 });
    assert.doesNotThrow(() => assertReviewPlan(plan));
    const mutated = { ...plan, riskTier: "critical" as const };
    assert.throws(() => assertReviewPlan(mutated), /canonical identity/);
    const uncovered = { ...plan, executionGroups: plan.executionGroups.slice(0, 1) };
    assert.throws(() => assertReviewPlan({ ...uncovered, planId: computeReviewPlanId(uncovered) }), /does not cover required capabilities|budget is invalid/);
    const exceeded = {
      ...plan,
      executionGroups: [...plan.executionGroups, { ...plan.executionGroups[1]!, id: "extra-specialist", role: "data" as const }],
      selected: [...plan.selected, { ...plan.selected[1]!, role: "data" as const }],
    };
    assert.throws(() => assertReviewPlan({ ...exceeded, planId: computeReviewPlanId(exceeded) }), /budget is invalid or exceeded/);
  });

  it("rejects every missing, noninteger, or invalid authority budget field even with a matching canonical ID", () => {
    const plan = planReviewPanel({ changedPaths: ["src/worker.ts"], diff: "+work();", packet: packet() });
    const fields: Array<keyof ReviewBudget> = [
      "maxSpecialistExecutionGroups",
      "maxLogicalReviewerSessions",
      "maxParallelSessions",
      "maxAttemptsPerExecutionGroup",
      "maxReviewerAttempts",
      "maxScopeAdjudicationAttempts",
      "maxModelCalls",
    ];
    const reidentify = (budget: Partial<ReviewBudget>): ReviewPlan => {
      const candidate = { ...plan, budget } as unknown as ReviewPlan;
      return { ...candidate, planId: computeReviewPlanId(candidate) };
    };
    for (const field of fields) {
      const { [field]: _missing, ...withoutField } = plan.budget;
      assert.throws(() => assertReviewPlan(reidentify(withoutField)), /budget fields must all be present safe integers/, `${field} missing`);
      assert.throws(() => assertReviewPlan(reidentify({ ...plan.budget, [field]: 1.5 })), /budget fields must all be present safe integers/, `${field} noninteger`);
      assert.throws(() => assertReviewPlan(reidentify({ ...plan.budget, [field]: 0 })), /absolute budget is invalid or exceeded/, `${field} invalid`);
    }
  });

  it("size-bounds the initial diff across files while preserving workspace follow-up authority", () => {
    const diff = [
      "diff --git a/src/first.ts b/src/first.ts", `+${"a".repeat(120_000)}`,
      "diff --git a/src/last.ts b/src/last.ts", `+${"b".repeat(120_000)}`,
    ].join("\n");
    const plan = planReviewPanel({ changedPaths: ["src/first.ts", "src/last.ts"], diff, packet: packet() });
    const bounded = scopedReviewDiff(plan, "correctness", diff);
    assert.ok(bounded.length <= 30_000);
    const deploymentBounded = scopedReviewDiff(plan, "correctness", diff, { maxInitialDiffChars: 60_000 });
    assert.ok(deploymentBounded.length <= 60_000);
    assert.match(bounded, /src\/first\.ts/);
    assert.match(bounded, /src\/last\.ts/);
    assert.match(bounded, /read\/grep/);
  });

  it("provides specialists a bounded file slice while correctness and security retain the full diff", () => {
    const diff = [
      "diff --git a/db/migration.sql b/db/migration.sql", "+ALTER TABLE jobs ADD COLUMN lease_id text;",
      "diff --git a/web/src/App.tsx b/web/src/App.tsx", "+export function App() {}",
    ].join("\n");
    const plan = planReviewPanel({ changedPaths: ["db/migration.sql", "web/src/App.tsx"], diff, packet: packet() });
    const dataSlice = scopedReviewDiff(plan, "data", diff);
    assert.match(dataSlice, /db\/migration\.sql/);
    assert.doesNotMatch(dataSlice, /web\/src\/App\.tsx/);
    assert.equal(scopedReviewDiff(plan, "correctness", diff), diff);
  });

  it("freezes large reviews into bounded deterministic execution groups without losing changed-path coverage", () => {
    const paths = Array.from({ length: 70 }, (_, index) => `src/module-${String(index).padStart(2, "0")}.ts`);
    const diff = paths.map((path) => `diff --git a/${path} b/${path}\n+export const changed = true;`).join("\n");
    const plan = planReviewPanel({ changedPaths: paths, diff, packet: packet() });
    const correctness = plan.executionGroups.filter(({ role }) => role === "correctness");
    assert.equal(plan.schemaVersion, 4);
    assert.equal(correctness.length, 3);
    assert.ok(correctness.every(({ scope }) => scope.length > 0 && scope.length <= 24));
    assert.deepEqual(correctness[0]?.scope, paths.slice(0, 24));
    assert.deepEqual(correctness[1]?.scope, paths.slice(24, 48));
    assert.deepEqual(correctness[2]?.scope, paths.slice(48));
    assert.deepEqual(correctness.flatMap(({ scope }) => scope).sort(), paths);
    assert.equal(new Set(correctness.map(({ id }) => id)).size, correctness.length);
    assert.deepEqual(plan.selected.map(({ role }) => role), ["correctness"]);
    assert.equal(plan.budget.maxLogicalReviewerSessions, correctness.length);
    assert.ok(plan.budget.maxParallelSessions <= 4);
    assert.doesNotThrow(() => assertReviewPlan(plan));
    const reversed = planReviewPanel({ changedPaths: [...paths].reverse(), diff, packet: packet() });
    assert.deepEqual(reversed.executionGroups, plan.executionGroups);
    const duplicateScope = plan.executionGroups.map((group, index) => index === 1
      ? { ...group, scope: [correctness[0]!.scope[0]!, ...group.scope.slice(1)] }
      : group);
    const malformed = { ...plan, executionGroups: duplicateScope };
    assert.throws(
      () => assertReviewPlan({ ...malformed, planId: computeReviewPlanId(malformed) }),
      /exactly and uniquely cover/,
    );
  });

  it("keeps oversized deployment shards component-coherent without manufacturing extra sessions", () => {
    const paths = Array.from({ length: 232 }, (_, index) => `src/lease-module-${String(index).padStart(3, "0")}.ts`);
    const diff = paths.map((path, index) => [
      `diff --git a/${path} b/${path}`,
      `+export const leaseChange${index} = "${"x".repeat(12_000)}";`,
    ].join("\n")).join("\n");
    const plan = planReviewPanel({ changedPaths: paths, diff, packet: packet(), maxSpecialists: 1 });
    const correctness = plan.executionGroups.filter(({ role }) => role === "correctness");
    const concurrency = plan.executionGroups.filter(({ role }) => role === "concurrency");

    assert.equal(correctness.length, 10);
    assert.equal(concurrency.length, 10);
    assert.equal(plan.executionGroups.length, 20);
    assert.ok(plan.executionGroups.every(({ scope }) => scope.length > 0 && scope.length <= 24));
    assert.deepEqual(correctness[0]?.scope, paths.slice(0, 24));
    assert.deepEqual(concurrency[0]?.scope, paths.slice(0, 24));
    assert.deepEqual(correctness.flatMap(({ scope }) => scope).sort(), paths);
    assert.deepEqual(concurrency.flatMap(({ scope }) => scope).sort(), paths);
    assert.doesNotThrow(() => assertReviewPlan(plan));
  });
});
