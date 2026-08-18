// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  MAX_ORCHESTRATION_PAGE_SIZE,
  type OrchestrationExecutionAdmission,
  type OrchestrationExecutionClaim,
  type OrchestrationExecutionLeaseStatus,
  type OrchestrationListCursor,
  type OrchestrationNodeRecord,
  type OrchestrationRecord,
  type OrchestrationRepository,
  type OrchestrationWorkerAttemptRecord,
} from "../../core/ports/orchestration.js";
export interface StaleOrchestrationReaperDependencies {
  repository: OrchestrationRepository;
  executionAdmission: OrchestrationExecutionAdmission;
  now?: () => string;
  staleAfterMs?: number;
}

export interface ReapedOrchestration {
  orchestrationId: string;
  previousExecutionAttempt: number;
  executionAttempt: number;
  lease?: OrchestrationExecutionLeaseStatus;
  record: OrchestrationRecord;
}

export interface StaleOrchestrationReapResult {
  scanned: number;
  candidates: number;
  skippedLive: number;
  skippedTerminal: number;
  skippedUnstarted: number;
  reaped: ReapedOrchestration[];
}

/**
 * Reconcile durable DAGs whose controller lease has expired. This operation
 * only changes a running record after winning the same fenced execution
 * admission used by live controllers; it never invokes a worker or resumes a
 * DAG implicitly.
 */
export class StaleOrchestrationReaper {
  private readonly now: () => string;
  private readonly staleAfterMs: number;

  constructor(private readonly dependencies: StaleOrchestrationReaperDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.staleAfterMs = dependencies.staleAfterMs ?? 60_000;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs < 0) throw new Error("Stale orchestration age must be non-negative");
  }

  async run(): Promise<StaleOrchestrationReapResult> {
    const result: StaleOrchestrationReapResult = {
      scanned: 0,
      candidates: 0,
      skippedLive: 0,
      skippedTerminal: 0,
      skippedUnstarted: 0,
      reaped: [],
    };

    let cursor: OrchestrationListCursor | undefined;
    while (true) {
      const records = await this.dependencies.repository.listRunningOrchestrations(MAX_ORCHESTRATION_PAGE_SIZE, cursor);
      if (!records.length) break;
      result.scanned += records.length;
      for (const record of records) {
        const timestamp = this.now();
        if (!hasStartedExecution(record) && !isStaleUnstarted(record, timestamp, this.staleAfterMs)) {
          result.skippedUnstarted++;
          continue;
        }
        result.candidates++;

        let leaseStatus: OrchestrationExecutionLeaseStatus | undefined;
        if (this.dependencies.executionAdmission.describe) {
          try {
            leaseStatus = await this.dependencies.executionAdmission.describe(record.orchestrationId);
          } catch {
            leaseStatus = undefined;
          }
        }
        const claim = await this.dependencies.executionAdmission.acquire(record.orchestrationId);
        if (!claim) {
          result.skippedLive++;
          continue;
        }

        try {
          claim.assertValid();
          const latest = await this.dependencies.repository.loadOrchestration(record.orchestrationId);
          if (!latest || latest.status !== "running") {
            result.skippedTerminal++;
            continue;
          }
          const latestTimestamp = this.now();
          if (!hasStartedExecution(latest) && !isStaleUnstarted(latest, latestTimestamp, this.staleAfterMs)) {
            result.skippedUnstarted++;
            continue;
          }

          const recovered = recoverRecord(latest, claim, latestTimestamp);
          if (claim.persist) await claim.persist(this.dependencies.repository, recovered);
          else {
            claim.assertValid();
            await this.dependencies.repository.saveOrchestration(recovered);
            claim.assertValid();
          }
          result.reaped.push({
            orchestrationId: recovered.orchestrationId,
            previousExecutionAttempt: latest.executionAttempt ?? 0,
            executionAttempt: recovered.executionAttempt ?? 0,
            ...(leaseStatus !== undefined ? { lease: leaseStatus } : {}),
            record: structuredClone(recovered),
          });
        } finally {
          await claim.release();
        }
      }
      const last = records.at(-1)!;
      cursor = { updatedAt: last.updatedAt, orchestrationId: last.orchestrationId };
      if (records.length < MAX_ORCHESTRATION_PAGE_SIZE) break;
    }
    return result;
  }
}

export async function reapStaleOrchestrations(
  dependencies: StaleOrchestrationReaperDependencies,
): Promise<StaleOrchestrationReapResult> {
  return new StaleOrchestrationReaper(dependencies).run();
}

function recoverRecord(
  record: OrchestrationRecord,
  claim: OrchestrationExecutionClaim,
  now: string,
): OrchestrationRecord {
  const previousAttempt = record.executionAttempt ?? 0;
  const reason = staleRecoveryReason(record.orchestrationId, claim.claimId, now);
  return {
    ...structuredClone(record),
    executionAttempt: previousAttempt + 1,
    executionClaimId: claim.claimId,
    status: "failed",
    updatedAt: now,
    nodes: record.nodes.map((node) => recoverNode(node, reason, now)),
  };
}

function recoverNode(node: OrchestrationNodeRecord, reason: string, now: string): OrchestrationNodeRecord {
  const activeAttemptId = node.activeAttemptId;
  const activeAttemptEvidence = activeAttemptId
    ? node.attempts?.find((attempt) => attempt.attemptId === activeAttemptId)
    : [...(node.attempts ?? [])].reverse().find((attempt) => attempt.status === "launching" || attempt.status === "running" || attempt.status === "suspended");
  const active = node.status === "running" || activeAttemptEvidence !== undefined;
  if (!active) return structuredClone(node);

  const attempts = (node.attempts ?? []).map((attempt) => {
    if (attempt.status !== "launching" && attempt.status !== "running" && attempt.status !== "suspended") return attempt;
    return interruptedAttempt(attempt, reason, now);
  });
  const { activeAttemptId: _activeAttemptId, error: _error, waitReason: _waitReason, ...rest } = node;
  return {
    ...rest,
    status: "suspended",
    attempts,
    error: reason,
    lastRecovery: {
      mode: "relaunch",
      reconciledAt: now,
      ...(activeAttemptEvidence !== undefined ? { attemptId: activeAttemptEvidence.attemptId } : {}),
      ...(activeAttemptEvidence?.taskId !== undefined ? { taskId: activeAttemptEvidence.taskId } : {}),
      reason,
    },
  };
}

function interruptedAttempt(
  attempt: OrchestrationWorkerAttemptRecord,
  reason: string,
  now: string,
): OrchestrationWorkerAttemptRecord {
  return {
    ...attempt,
    status: "interrupted",
    updatedAt: now,
    completedAt: now,
    error: reason,
  };
}

function hasStartedExecution(record: OrchestrationRecord): boolean {
  return (record.executionAttempt ?? 0) > 0
    || record.nodes.some((node) => node.status !== "queued"
      || node.activeAttemptId !== undefined
      || (node.attempts?.length ?? 0) > 0);
}

function isStaleUnstarted(record: OrchestrationRecord, now: string, staleAfterMs: number): boolean {
  if (record.executionAttempt !== 0 || record.nodes.some((node) => node.status !== "queued" || (node.attempts?.length ?? 0) > 0)) return false;
  const updatedAt = Date.parse(record.updatedAt);
  const nowAt = Date.parse(now);
  return Number.isFinite(updatedAt) && Number.isFinite(nowAt) && nowAt - updatedAt >= staleAfterMs;
}

function staleRecoveryReason(orchestrationId: string, claimId: string, now: string): string {
  return `Orchestration controller lease expired; DAG ${orchestrationId} was interrupted during recovery at ${now} under fenced claim ${claimId}. Resume the durable orchestration explicitly; no worker was dispatched automatically.`;
}
