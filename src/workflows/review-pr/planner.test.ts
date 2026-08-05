// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact } from "../../core/artifacts/schema.js";
import { assertReviewPlan, escalateReviewPlan, planReviewPanel, scopedReviewDiff } from "./planner.js";

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

  it("treats the specialist budget as soft for independently concrete changed surfaces", () => {
    const plan = planReviewPanel({
      changedPaths: ["src/auth/token.ts", "db/migration.sql", "web/src/App.tsx", "infra/terraform/main.tf"],
      diff: "",
      packet: packet(),
      maxSpecialists: 2,
    });
    assert.deepEqual(plan.selected.map(({ role }) => role), ["correctness", "security", "data", "frontend", "infrastructure"]);
    assert.ok(plan.selected.slice(1).every(({ required }) => required));
  });

  it("does not let the soft budget suppress an explicitly declared security risk", () => {
    const plan = planReviewPanel({
      changedPaths: ["docs/contract.md", "web/src/App.tsx"],
      diff: "diff --git a/docs/contract.md b/docs/contract.md\n+Trust contract clarified.\ndiff --git a/web/src/App.tsx b/web/src/App.tsx\n+export function App() {}",
      packet: packet([{ risk: "Signature replay and trust root ambiguity", mitigation: "Require revocation" }]),
      maxSpecialists: 1,
    });
    assert.deepEqual(plan.selected.map(({ role }) => role), ["correctness", "security", "frontend"]);
    assert.ok(plan.selected.slice(1).every(({ required }) => required));
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

  it("adaptively escalates concrete specialist evidence beyond the initial soft budget", () => {
    const initial = planReviewPanel({ changedPaths: ["src/worker.ts"], diff: "", packet: packet(), maxSpecialists: 1 });
    assert.deepEqual(initial.selected.map(({ role }) => role), ["correctness"]);
    const escalated = escalateReviewPlan(initial, [{
      role: "correctness",
      findings: [{
        id: "race-1", severity: "high", confidence: "high", title: "Unfenced lease permits stale writer",
        evidence: "A stale worker can commit after lease reassignment", location: "src/worker.ts:42",
        remediation: "Fence the commit with the current lease epoch",
      }],
    }]);
    assert.deepEqual(escalated.selected.map(({ role }) => role), ["correctness", "concurrency"]);
    assert.equal(escalated.selected[1]?.required, true);
    assert.match(escalated.selected[1]?.reasons[0] ?? "", /race-1/);
  });

  it("rejects an unauditable role decision before any reviewer is launched", () => {
    const plan = planReviewPanel({ changedPaths: ["src/a.ts"], diff: "", packet: packet() });
    assert.doesNotThrow(() => assertReviewPlan(plan));
    assert.throws(() => assertReviewPlan({ ...plan, skipped: plan.skipped.slice(1) }), /account for every specialist/);
  });

  it("size-bounds the initial diff across files while preserving workspace follow-up authority", () => {
    const diff = [
      "diff --git a/src/first.ts b/src/first.ts", `+${"a".repeat(120_000)}`,
      "diff --git a/src/last.ts b/src/last.ts", `+${"b".repeat(120_000)}`,
    ].join("\n");
    const plan = planReviewPanel({ changedPaths: ["src/first.ts", "src/last.ts"], diff, packet: packet() });
    const bounded = scopedReviewDiff(plan, "correctness", diff);
    assert.ok(bounded.length <= 160_000);
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
});
