import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertExecutionPlanIntegrity,
  ExecutionMaterializationCertificationError,
  materializeExecutionPlan,
} from "./execution-materializer.js";
import type { OrchestrationRecord } from "../ports/orchestration.js";
import type { ScheduledWorkItem } from "../../workflows/orchestrate/scheduler.js";

const baseSha = "a".repeat(40);
const item = (id: string, issue: number, dependencies: readonly string[] = []): ScheduledWorkItem => ({
  id,
  issue,
  priority: issue,
  dependencies: [...dependencies],
  claims: [`src/${id}.ts`],
  repository: "Owner/Repo",
  targetBranch: "staging",
  lane: "fast",
});
const record = { orchestrationId: "dag-test", repository: "Owner/Repo", plan: { batching: { policy: "none", maxBatchSize: 8, maxSensitiveBatchSize: 2 } } } as unknown as OrchestrationRecord;
const packet = (nodeId: string, issue: number, dependencies: readonly string[] = [], certified = false) => ({
  nodeId,
  wave: 1,
  status: "completed" as const,
  attemptCount: 1,
  packetId: `packet-${nodeId}`,
  expectedPaths: [`src/${nodeId}.ts`],
  semanticDependencies: [...dependencies],
  baseSha,
  ...(certified ? {
    certification: {
      expectedPaths: [`src/${nodeId}.ts`],
      symbols: [`${nodeId}.run`],
      relationPaths: [`src/${nodeId}.ts`],
      generatedPaths: [], sourcePaths: [`src/${nodeId}.ts`], testPaths: [], configPaths: [],
      relationDigest: "b".repeat(64), verificationPolicyVersion: "policy-v1",
      verificationCommandIdentities: [{ id: "test", identityDigest: "c".repeat(64), targets: [] }],
      riskPolicyDigest: "d".repeat(64), claimDigest: "e".repeat(64),
    },
  } : {}),
});

describe("validated immutable execution materializer", () => {
  it("preserves identity isolation matrix matrix-identity-isolation-2e4495f6c1b1 and deterministic frontier projections", () => {
    const input = {
      orchestration: record,
      items: [item("one", 1), item("two", 2, ["one"])],
      packets: [packet("one", 1), packet("two", 2, ["one"])],
      baseSha,
      requireCompleteEvidence: false,
    } as const;
    const first = materializeExecutionPlan(input);
    const second = materializeExecutionPlan(structuredClone(input));
    assert.deepEqual(first.plan, second.plan);
    assert.deepEqual(first.builderFrontier.map((entry) => entry.nodeId), ["one"]);
    assert.equal(first.plan.digest.length, 64);
  });

  it("rejects missing settled certification before plan creation matrix-identity-isolation-33c404dde8f8", () => {
    assert.throws(
      () => materializeExecutionPlan({
        orchestration: record,
        items: [item("one", 1)],
        packets: [packet("one", 1)],
        baseSha,
        requireCompleteEvidence: true,
      }),
      (error: unknown) => error instanceof ExecutionMaterializationCertificationError && error.code === "relation",
    );
  });

  it("retains immutable digest tamper detection and review evidence matrix-identity-isolation-dacfbaf9f28f matrix-identity-isolation-8c5c6e3c8bc6", () => {
    const result = materializeExecutionPlan({
      orchestration: record,
      items: [item("one", 1)],
      packets: [packet("one", 1, [], true)],
      baseSha,
      requireCompleteEvidence: true,
    });
    assertExecutionPlanIntegrity(result.plan);
    const tampered = structuredClone(result.plan);
    tampered.builderFrontier[0]!.issue = 999;
    assert.throws(() => assertExecutionPlanIntegrity(tampered), /digest/);
  });
});
