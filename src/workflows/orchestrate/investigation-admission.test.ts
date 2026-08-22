import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OrchestrationExecutionClaim, OrchestrationRecord } from "../../core/ports/orchestration.js";
import { InMemoryOrchestrationRepository } from "../../core/ports/repositories.js";
import { runInvestigationAdmission, type InvestigationAdmissionSelection } from "./investigation-admission.js";

const selection = (issue: number, repository = "Owner/Repo"): InvestigationAdmissionSelection => ({
  repository, issue, targetBranch: "staging", baseSha: "a".repeat(40),
});

function claim(): OrchestrationExecutionClaim {
  return { claimId: "claim-wave", assertValid() {}, release() {} };
}

function record(): OrchestrationRecord {
  return {
    schema: "forgedock.orchestration/v1", orchestrationId: "dag-wave", repository: "owner/repo",
    requestedIssueNumbers: [1, 2], issueNumbers: [1, 2], maxParallel: 2, autoMerge: false,
    status: "running", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", nodes: [],
  };
}

describe("controller-owned investigation admission", () => {
  it("settles every selected identity and is idempotent after a durable checkpoint", async () => {
    const repository = new InMemoryOrchestrationRepository();
    await repository.createOrchestration(record());
    let launches = 0;
    const worker = async ({ selection: current }: { selection: InvestigationAdmissionSelection }) => {
      launches++;
      return { state: "confirmed" as const, investigationArtifactId: `investigation:${current.repository}:${current.issue}` };
    };
    const input = { waveId: "wave-1", repository: "owner/repo", targetBranch: "staging", selected: [selection(1), selection(2)], executionAttempt: 1, executionClaimId: "claim-wave", now: () => "2026-01-01T00:00:01.000Z" };
    const deps = {
      repository, claim: claim(), worker,
      load: () => repository.loadOrchestration("dag-wave").then((value) => value!),
      save: (value: OrchestrationRecord) => repository.saveOrchestration(value),
    };
    const first = await runInvestigationAdmission(input, deps);
    assert.equal(first.selected.length, 2);
    assert.equal(launches, 2);
    const second = await runInvestigationAdmission(input, deps);
    assert.equal(second.waveId, "wave-1");
    assert.equal(launches, 2);
  });

  it("preserves repository-qualified identity and cancellation behind the barrier", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const current = record();
    await repository.createOrchestration(current);
    const abort = new AbortController();
    abort.abort(new Error("operator stop"));
    await assert.rejects(() => runInvestigationAdmission({
      waveId: "wave-cancelled", repository: "owner/repo", targetBranch: "staging", selected: [selection(1), selection(1, "other/repo")], executionAttempt: 1, executionClaimId: "claim-wave", signal: abort.signal,
    }, { repository, claim: claim(), worker: async () => { throw new Error("must not launch"); }, load: () => repository.loadOrchestration(current.orchestrationId).then((value) => value!), save: (value) => repository.saveOrchestration(value) }), /cancelled/);
    const persisted = await repository.loadOrchestration(current.orchestrationId);
    assert.equal(persisted?.investigationWave?.state, "cancelled");
    assert.equal(persisted?.investigationWave?.settlements.length, 2);
  });

  it("fails closed for missing base evidence and settles retry exhaustion", async () => {
    const repository = new InMemoryOrchestrationRepository();
    const current = record();
    await repository.createOrchestration(current);
    await assert.rejects(() => runInvestigationAdmission({
      waveId: "wave-invalid", repository: "owner/repo", targetBranch: "staging", selected: [{ ...selection(1), baseSha: "" }], executionAttempt: 1, executionClaimId: "claim-wave",
    }, { repository, claim: claim(), worker: async () => ({ state: "confirmed" as const }), load: () => repository.loadOrchestration(current.orchestrationId).then((value) => value!), save: (value) => repository.saveOrchestration(value) }), /base SHA/);

    let attempts = 0;
    await assert.rejects(() => runInvestigationAdmission({
      waveId: "wave-failed", repository: "owner/repo", targetBranch: "staging", selected: [selection(1)], executionAttempt: 1, executionClaimId: "claim-wave", maxAttempts: 2,
    }, { repository, claim: claim(), worker: async () => { attempts++; throw new Error("provider down"); }, load: () => repository.loadOrchestration(current.orchestrationId).then((value) => value!), save: (value) => repository.saveOrchestration(value) }), /failed/);
    assert.equal(attempts, 2);
  });
});
