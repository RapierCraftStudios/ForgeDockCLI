// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  InvestigationAdmissionRecord,
  InvestigationSettlementRecord,
  InvestigationWaveRecord,
  OrchestrationIssueIdentity,
  OrchestrationRecord,
  OrchestrationRepository,
} from "../../core/ports/orchestration.js";
import { normalizeOrchestrationRepository, orchestrationIssueIdentityKey } from "../../core/ports/orchestration.js";
import type { ScheduledWorkItem } from "./scheduler.js";

export type InvestigationBarrierOutcome = "confirmed" | "invalid" | "decomposed";

export interface InvestigationSnapshotAdmission {
  baseSha: string;
  targetBranch: string;
  routeIdentity: string;
}

export interface InvestigationBarrierResult {
  outcome: InvestigationBarrierOutcome;
  baseSha?: string;
  artifactId?: string;
  checkpointId?: string;
  childIssues?: readonly number[];
}

export interface InvestigationBarrierExpansion {
  childIssues: readonly number[];
  items: readonly ScheduledWorkItem[];
}

export interface InvestigationBarrierDependencies {
  /** Resolve and freeze the exact read-only snapshot before investigation starts. */
  admit(input: { orchestration: Readonly<OrchestrationRecord>; item: ScheduledWorkItem; signal?: AbortSignal }): Promise<InvestigationSnapshotAdmission>;
  /** Run semantic investigation against the already-admitted snapshot. */
  investigate(input: {
    orchestration: Readonly<OrchestrationRecord>;
    item: ScheduledWorkItem;
    admission: Readonly<InvestigationAdmissionRecord>;
    signal?: AbortSignal;
  }): Promise<InvestigationBarrierResult>;
  /** Materialize authoritative children only after the parent is settled. */
  expand?(input: {
    orchestration: Readonly<OrchestrationRecord>;
    item: ScheduledWorkItem;
    admission: Readonly<InvestigationAdmissionRecord>;
    result: Readonly<InvestigationBarrierResult>;
    signal?: AbortSignal;
  }): Promise<InvestigationBarrierExpansion>;
  /** Existing fenced orchestration save boundary. */
  persist(record: OrchestrationRecord): Promise<void>;
  repository?: OrchestrationRepository;
  maxAttempts?: number;
  now?: () => string;
  signal?: AbortSignal;
}

export interface InvestigationBarrierDispatch {
  record: OrchestrationRecord;
  items: ScheduledWorkItem[];
}

/**
 * Controller-owned admission wave. No caller can observe dispatch items until
 * every issue in the current wave has a durable terminal settlement.
 */
export class InvestigationBarrier {
  private readonly now: () => string;
  private readonly maxAttempts: number;
  private persistence?: (record: OrchestrationRecord) => Promise<void>;

  constructor(private readonly dependencies: InvestigationBarrierDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.maxAttempts = dependencies.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("Investigation maxAttempts must be a positive integer");
  }

  /** Bind the active controller claim for every barrier checkpoint. */
  setPersistence(persist: (record: OrchestrationRecord) => Promise<void>): void {
    this.persistence = persist;
  }

  async settle(
    record: OrchestrationRecord,
    items: readonly ScheduledWorkItem[],
    options: { signal?: AbortSignal } = {},
  ): Promise<InvestigationBarrierDispatch> {
    const signal = options.signal ?? this.dependencies.signal;
    const admitted = structuredClone(record);
    const state = admitted.investigationBarrier ?? { admissions: [], waves: [], settlements: [] };
    admitted.investigationBarrier = state;
    const selected = uniqueItems(items);
    const priorWave = state.waves.at(-1);
    if (priorWave?.status === "settled") {
      const priorSettlements = selected.map((item) => {
        const admission = state.admissions.find((candidate) => candidate.repository === normalizeOrchestrationRepository(item.repository ?? admitted.repository) && candidate.issue === item.issue);
        return admission === undefined ? undefined : state.settlements.find((candidate) => candidate.key === settlementKey(admitted.orchestrationId, admission, priorWave.wave));
      });
      if (priorSettlements.every((settlement) => settlement !== undefined && terminalSettlement(settlement.status))) {
        return {
          record: admitted,
          items: selected.filter((item) => priorSettlements.find((settlement) => settlement?.issue === item.issue)?.status === "confirmed"),
        };
      }
    }
    const waveNumber = state.waves.length;
    const existingWave = state.waves.find((wave) => wave.wave === waveNumber);
    const wave: InvestigationWaveRecord = existingWave ?? {
      wave: waveNumber,
      issueKeys: selected.map((item) => identityKey(admitted, item)),
      status: "running",
      startedAt: this.now(),
    };
    if (!existingWave) state.waves.push(wave);
    await this.persist(admitted);

    const outcomes = await Promise.all(selected.map(async (item) => {
      const issueIdentity = identityForItem(admitted, item);
      let admission = state.admissions.find((candidate) => candidate.repository === issueIdentity.repository && candidate.issue === issueIdentity.issue);
      if (!admission) {
        const frozen = await this.dependencies.admit({ orchestration: admitted, item, ...(signal !== undefined ? { signal } : {}) });
        assertExactBaseSha(frozen.baseSha);
        admission = {
          repository: issueIdentity.repository,
          issue: issueIdentity.issue,
          baseSha: frozen.baseSha,
          targetBranch: frozen.targetBranch,
          routeIdentity: frozen.routeIdentity,
          admittedAt: this.now(),
        };
        state.admissions.push(admission);
        await this.persist(admitted);
      }
      const key = settlementKey(admitted.orchestrationId, admission, wave.wave);
      let settlement = state.settlements.find((candidate) => candidate.key === key);
      if (settlement && terminalSettlement(settlement.status)) return { item, admission, settlement };
      const maxAttempts = this.maxAttempts;
      for (;;) {
        if (signal?.aborted) {
          settlement = writeSettlement(state.settlements, {
            key, orchestrationId: admitted.orchestrationId, repository: admission.repository, issue: admission.issue,
            wave: wave.wave, baseSha: admission.baseSha, status: "cancelled", attempt: settlement?.attempt ?? 0,
            maxAttempts, updatedAt: this.now(), cancellationReason: abortReason(signal),
          });
          await this.persist(admitted);
          throw signal.reason ?? new Error("Investigation wave cancelled");
        }
        const attempt = (settlement?.attempt ?? 0) + 1;
        settlement = writeSettlement(state.settlements, {
          key, orchestrationId: admitted.orchestrationId, repository: admission.repository, issue: admission.issue,
          wave: wave.wave, baseSha: admission.baseSha, status: "retrying", attempt, maxAttempts, updatedAt: this.now(),
        });
        await this.persist(admitted);
        let callbackComplete = false;
        try {
          const result = await this.dependencies.investigate({ orchestration: admitted, item, admission, ...(signal !== undefined ? { signal } : {}) });
          if (result.artifactId === undefined && result.outcome !== "confirmed" && result.outcome !== "invalid" && result.outcome !== "decomposed") {
            throw new Error("Investigation callback returned no terminal outcome");
          }
          assertResultBaseSha(admission.baseSha, result);
          callbackComplete = true;
          settlement = writeSettlement(state.settlements, {
            ...settlement,
            status: result.outcome === "decomposed" ? "decomposed" : result.outcome,
            updatedAt: this.now(),
            ...(result.artifactId !== undefined ? { artifactId: result.artifactId } : {}),
            ...(result.checkpointId !== undefined ? { checkpointId: result.checkpointId } : {}),
            ...(result.childIssues !== undefined ? { childIssues: [...result.childIssues] } : {}),
          });
          await this.persist(admitted);
          return { item, admission, settlement, result };
        } catch (error) {
          // Once the provider has returned a validated result, persistence
          // failure must not replay the provider call: the durable write may
          // have committed before the response was lost.
          if (callbackComplete) throw error;
          if (signal?.aborted) {
            settlement = writeSettlement(state.settlements, {
              ...settlement, status: "cancelled", updatedAt: this.now(), cancellationReason: abortReason(signal), error: errorMessage(error),
            });
            await this.persist(admitted);
            throw error;
          }
          if (error instanceof Error && /base SHA.*match|base SHA.*expected/i.test(error.message)) {
            settlement = writeSettlement(state.settlements, {
              ...settlement, status: "failed", updatedAt: this.now(), error: errorMessage(error),
            });
            await this.persist(admitted);
            throw error;
          }
          const retryable = isRetryable(error);
          if (!retryable || attempt >= maxAttempts) {
            settlement = writeSettlement(state.settlements, {
              ...settlement, status: "failed", updatedAt: this.now(), error: errorMessage(error),
            });
            await this.persist(admitted);
            return { item, admission, settlement };
          }
          settlement = writeSettlement(state.settlements, { ...settlement, status: "retrying", error: errorMessage(error), updatedAt: this.now() });
          await this.persist(admitted);
        }
      }
    }));

    wave.status = "settled";
    wave.settledAt = this.now();
    await this.persist(admitted);
    const children: ScheduledWorkItem[] = [];
    for (const outcome of outcomes) {
      const settlement = outcome.settlement;
      if (!settlement || settlement.status !== "decomposed") continue;
      if (!this.dependencies.expand) throw new Error(`Decomposition of ${outcome.item.id} requires a barrier expansion callback`);
      const expansion = await this.dependencies.expand({
        orchestration: admitted,
        item: outcome.item,
        admission: outcome.admission,
        result: outcome.result ?? { outcome: "decomposed", childIssues: settlement.childIssues ?? [] },
        ...(signal !== undefined ? { signal } : {}),
      });
      if (settlement.childIssues !== undefined && !sameNumbers(expansion.childIssues, settlement.childIssues)) throw new Error(`Decomposition children changed after durable settlement for ${outcome.item.id}`);
      if (settlement.childIssues === undefined) {
        settlement.childIssues = [...expansion.childIssues];
        settlement.updatedAt = this.now();
        await this.persist(admitted);
      }
      children.push(...expansion.items);
    }
    if (children.length) {
      const next = await this.settle(admitted, children, options);
      return { record: next.record, items: next.items };
    }
    return {
      record: admitted,
      items: outcomes.filter(({ settlement }) => settlement?.status === "confirmed").map(({ item }) => item),
    };
  }

  private async persist(record: OrchestrationRecord): Promise<void> {
    const persist = this.persistence ?? this.dependencies.persist;
    if (!persist) {
      if (!this.dependencies.repository) throw new Error("Investigation barrier requires a persistence boundary");
      await this.dependencies.repository.saveOrchestration(structuredClone(record));
      return;
    }
    await persist(structuredClone(record));
  }

  /** Deterministic identity used by restart/replay and response-loss recovery. */
  static settlementKey(orchestrationId: string, admission: Pick<InvestigationAdmissionRecord, "repository" | "issue" | "baseSha">, wave: number): string {
    return settlementKey(orchestrationId, admission, wave);
  }
}

function identityForItem(record: OrchestrationRecord, item: ScheduledWorkItem): OrchestrationIssueIdentity {
  return { repository: normalizeOrchestrationRepository(item.repository ?? record.repository), issue: item.issue };
}
function identityKey(record: OrchestrationRecord, item: ScheduledWorkItem): string { return orchestrationIssueIdentityKey(identityForItem(record, item)); }
function uniqueItems(items: readonly ScheduledWorkItem[]): ScheduledWorkItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}
function settlementKey(orchestrationId: string, admission: Pick<InvestigationAdmissionRecord, "repository" | "issue" | "baseSha">, wave: number): string {
  return `${orchestrationId}|${normalizeOrchestrationRepository(admission.repository)}#${admission.issue}|wave:${wave}|base:${admission.baseSha.toLowerCase()}`;
}
function terminalSettlement(status: InvestigationSettlementRecord["status"]): boolean {
  return status === "confirmed" || status === "invalid" || status === "decomposed" || status === "failed" || status === "cancelled";
}
function writeSettlement(settlements: InvestigationSettlementRecord[], next: InvestigationSettlementRecord): InvestigationSettlementRecord {
  const index = settlements.findIndex((candidate) => candidate.key === next.key);
  if (index < 0) settlements.push(next);
  else settlements[index] = next;
  return next;
}
function assertExactBaseSha(value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error(`Investigation admission requires an exact 40-character base SHA, found ${value}`);
}
function assertResultBaseSha(baseSha: string, result: InvestigationBarrierResult): void {
  if (result.checkpointId !== undefined && !result.checkpointId.trim()) throw new Error("Investigation checkpoint identity must not be empty");
  assertExactBaseSha(baseSha);
  if (result.baseSha !== undefined && result.baseSha.toLowerCase() !== baseSha.toLowerCase()) {
    throw new Error(`Investigation result base SHA ${result.baseSha} does not match admitted SHA ${baseSha}`);
  }
}
function isRetryable(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "retryable" in error && (error as { retryable?: unknown }).retryable === true)
    || (error instanceof Error && /retry|temporar|unavailable|timeout|transport/i.test(error.message));
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function abortReason(signal: AbortSignal): string { return errorMessage(signal.reason ?? new Error("Investigation cancelled")); }
function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return [...new Set(left)].sort((a, b) => a - b).join(",") === [...new Set(right)].sort((a, b) => a - b).join(",");
}
