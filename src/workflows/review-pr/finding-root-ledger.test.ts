import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import { openLedgerFindings, reconcileFindingRootLedger } from "./finding-root-ledger.js";

const runId = "run-root-ledger";
const subject = { repo: "a/b", issue: 364 };
const head1 = "a".repeat(40);
const head2 = "b".repeat(40);
const packet = createArtifact({
  kind: "BuildPacket", runId, subject, producer: { role: "packet-author" }, payload: {
    scope: ["Preserve sensitive observation invariants"],
    acceptanceCriteria: ["Redaction, adapter identity, terminal metadata, and ordering remain fail-closed."],
    context: [], implementationPlan: ["Harden observation normalization"], expectedPaths: ["src/observability/contracts.ts"],
    verificationPlan: ["npm test"], risks: [{ risk: "security credential exposure", mitigation: "matrix regressions" }], outOfScope: [],
  },
});

type Finding = DurableArtifact<"ReviewVerdict">["payload"]["findings"][number];
function finding(id: string, family: "marker" | "identity" | "terminal", paraphrase = false): Finding {
  const variants = {
    marker: paraphrase ? {
      title: "Credential masking delimiter accepts a secret continuation",
      causalRoot: "redaction grammar does not consume marker-adjacent suffix",
      evidence: "redactObservationValue() preserves a suffix after a quoted marker fragment boundary.",
      trigger: "A quoted marker and credential continuation cross a chunk boundary.",
      invariant: "Redaction grammar must quarantine every credential chunk.",
    } : {
      title: "Quoted redaction marker suffix leaks credentials",
      causalRoot: "marker suffix escapes the redaction grammar",
      evidence: "redactObservationValue() leaves the secret after a split marker chunk.",
      trigger: "A credential follows a redaction marker split across chunks.",
      invariant: "Credential redaction grammar is fail-closed.",
    },
    identity: paraphrase ? {
      title: "Session refresh aliases independent adapter owners",
      causalRoot: "adapter lifecycle identity collision",
      evidence: "ControllerObservationAdapter.emit() reuses state across node and session identity.",
      trigger: "Interleaved producers differ only by piSessionRef.",
      invariant: "Adapter lifecycle and identity streams remain isolated.",
    } : {
      title: "Controller adapter streams collide after producer recreation",
      causalRoot: "adapter identity isolation omits session owner",
      evidence: "ControllerObservationAdapter.emit() shares continuation state after lifecycle recreation.",
      trigger: "Two interleaved node identities use the default producer.",
      invariant: "Adapter identity isolation survives lifecycle refresh.",
    },
    terminal: paraphrase ? {
      title: "Cancellation cleanup drops terminal observation fields",
      causalRoot: "terminal metadata retention failure",
      evidence: "observeAgentEvent() changes cancelled event metadata ordering.",
      trigger: "A cancelled terminal event follows buffered output.",
      invariant: "Terminal metadata and ordering are retained.",
    } : {
      title: "Terminal event reorders completion metadata",
      causalRoot: "terminal metadata ordering regression",
      evidence: "observeAgentEvent() emits failed terminal metadata after cleanup.",
      trigger: "A failed terminal event drains pending output.",
      invariant: "Successful, failed, and cancelled metadata ordering remains stable.",
    },
  } as const;
  const value = variants[family];
  return {
    id, severity: "high", confidence: "high", blocking: true, mustFix: true,
    title: value.title, causalRoot: value.causalRoot, evidence: value.evidence,
    location: "src/observability/contracts.ts:normalizeObservationDraft()",
    intentRelevance: value.invariant, remediation: `Fix ${family} invariant in normalizeObservationDraft().`,
    impact: { category: "security", trigger: value.trigger, affectedInvariant: value.invariant, consequence: "Sensitive observation state can cross an authority boundary." },
    evidenceAnchor: { kind: "repository-location", reference: "src/observability/contracts.ts" },
    reviewerRoles: [family === "identity" ? "concurrency" : "correctness"],
    scopeDisposition: "in_scope", scopeRationale: "Matches the frozen criterion.",
    matchedAcceptanceCriteria: [packet.payload.acceptanceCriteria[0]!], matchedPriorFindingIds: [], introducedByRemediation: false,
  };
}

describe("durable finding root ledger", () => {
  it("retains structural roots across marker, identity, metadata, and terminal paraphrases", () => {
    const initial = reconcileFindingRootLedger({ packet, findings: [finding("m1", "marker"), finding("i1", "identity"), finding("t1", "terminal")], headSha: head1 });
    const previous = createArtifact({
      kind: "FindingRootLedger", runId, subject: { ...subject, pr: 369 }, producer: { role: "controller" },
      payload: { checkpoint: "finding-root-ledger", pullRequest: 369, headSha: head1, epoch: 1, roots: initial },
    });
    const next = reconcileFindingRootLedger({
      previous, packet,
      findings: [finding("m2", "marker", true), finding("i2", "identity", true), finding("t2", "terminal", true)],
      headSha: head2,
    });
    assert.deepEqual(next.map(({ rootId }) => rootId), initial.map(({ rootId }) => rootId));
    assert.ok(next.every((root) => root.aliases.length >= 2));
  });

  it("carries omitted open roots until explicit closure evidence exists", () => {
    const initial = reconcileFindingRootLedger({ packet, findings: [finding("m1", "marker"), finding("t1", "terminal")], headSha: head1 });
    const previous = createArtifact({
      kind: "FindingRootLedger", runId, subject: { ...subject, pr: 369 }, producer: { role: "controller" },
      payload: { checkpoint: "finding-root-ledger", pullRequest: 369, headSha: head1, epoch: 1, roots: initial },
    });
    const next = reconcileFindingRootLedger({ previous, packet, findings: [finding("m2", "marker", true)], headSha: head2 });
    assert.equal(next.length, 2);
    assert.equal(next.find((root) => root.representative.id === "t1")?.state, "fix-attempted");
    assert.equal(openLedgerFindings(next).length, 2);
  });

  it("keeps a same-epoch accepted regression open despite fixed or rejected assessments", () => {
    const initial = reconcileFindingRootLedger({ packet, findings: [finding("m1", "marker")], headSha: head1 });
    const rootId = initial[0]!.rootId;
    for (const status of ["fixed", "rejected"] as const) {
      const previous = createArtifact({
        kind: "FindingRootLedger", runId, subject: { ...subject, pr: 369 }, producer: { role: "controller" },
        payload: {
          checkpoint: "finding-root-ledger", pullRequest: 369, headSha: head1, epoch: 1,
          roots: initial.map((root) => ({ ...root, state: "fixed" as const, epochsOpen: 0 })),
        },
      });
      const next = reconcileFindingRootLedger({
        previous,
        packet,
        findings: [finding(`m2-${status}`, "marker", true)],
        assessments: [{ rootId, status, evidence: `${status} assessment from stale evidence` }],
        headSha: head2,
      });
      assert.equal(next[0]?.state, "regressed");
      assert.equal(next[0]?.epochsOpen, 1);
      assert.equal(openLedgerFindings(next)[0]?.id, `m2-${status}`);
    }
  });

  it("treats contradictory closure assessments as open regardless of order", () => {
    const initial = reconcileFindingRootLedger({ packet, findings: [finding("m1", "marker")], headSha: head1 });
    const rootId = initial[0]!.rootId;
    const previous = createArtifact({
      kind: "FindingRootLedger", runId, subject: { ...subject, pr: 369 }, producer: { role: "controller" },
      payload: { checkpoint: "finding-root-ledger", pullRequest: 369, headSha: head1, epoch: 1, roots: initial },
    });
    const statuses = ["fixed", "rejected"] as const;
    for (const ordered of [statuses, [...statuses].reverse()]) {
      const next = reconcileFindingRootLedger({
        previous,
        packet,
        findings: [],
        assessments: ordered.map((status) => ({ rootId, status, evidence: `${status} reviewer assessment` })),
        headSha: head2,
      });
      assert.equal(next[0]?.state, "fix-attempted");
      assert.equal(next[0]?.epochsOpen, 2);
      assert.equal(openLedgerFindings(next).length, 1);
    }
  });

  it("ignores reviewer-supplied root IDs when selecting structural roots", () => {
    const initial = reconcileFindingRootLedger({ packet, findings: [finding("m1", "marker"), finding("i1", "identity")], headSha: head1 });
    const markerRoot = initial.find((root) => root.representative.id === "m1")!;
    const identityRoot = initial.find((root) => root.representative.id === "i1")!;
    const previous = createArtifact({
      kind: "FindingRootLedger", runId, subject: { ...subject, pr: 369 }, producer: { role: "controller" },
      payload: { checkpoint: "finding-root-ledger", pullRequest: 369, headSha: head1, epoch: 1, roots: initial },
    });
    const forged = {
      ...finding("m2", "marker", true),
      rootId: identityRoot.rootId,
      normalizedRoot: identityRoot.structuralKey,
    };
    const next = reconcileFindingRootLedger({ previous, packet, findings: [forged], headSha: head2 });
    assert.equal(next.find((root) => root.rootId === markerRoot.rootId)?.representative.id, "m2");
    assert.equal(next.find((root) => root.rootId === identityRoot.rootId)?.representative.id, "i1");
    assert.equal(next.find((root) => root.rootId === identityRoot.rootId)?.state, "fix-attempted");
  });
});
