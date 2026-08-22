// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  normalizeOrchestrationRepository,
  orchestrationIssueIdentityKey,
  type InvestigationSettlementState,
  type OrchestrationAdmissionProof,
  type OrchestrationExecutionClaim,
  type OrchestrationInvestigationSettlement,
  type OrchestrationInvestigationWave,
  type OrchestrationIssueIdentity,
  type OrchestrationRecord,
  type OrchestrationRepository,
} from "../../core/ports/orchestration.js";

export const MAX_INVESTIGATION_ATTEMPTS = 3;

export interface InvestigationAdmissionSelection extends OrchestrationIssueIdentity {
  targetBranch: string;
  baseSha: string;
}

export interface InvestigationAdmissionResult {
  state: Exclude<InvestigationSettlementState, "retrying">;
  investigationArtifactId?: string;
  outcomeArtifactId?: string;
  decompositionChildren?: readonly OrchestrationIssueIdentity[];
  error?: string;
}

export interface InvestigationAdmissionWorkerContext {
  waveId: string;
  executionAttempt: number;
  selection: InvestigationAdmissionSelection;
  attempt: number;
  signal: AbortSignal;
}

export type InvestigationAdmissionWorker = (
  context: InvestigationAdmissionWorkerContext,
) => Promise<InvestigationAdmissionResult>;

export interface InvestigationAdmissionInput {
  waveId: string;
  parentWaveId?: string;
  repository: string;
  targetBranch: string;
  selected: readonly InvestigationAdmissionSelection[];
  executionAttempt: number;
  executionClaimId: string;
  maxAttempts?: number;
  now?: () => string;
  signal?: AbortSignal;
}

export interface InvestigationAdmissionDependencies {
  repository: OrchestrationRepository;
  claim: OrchestrationExecutionClaim;
  worker: InvestigationAdmissionWorker;
  load: () => Promise<OrchestrationRecord>;
  save: (record: OrchestrationRecord) => Promise<void>;
}

/**
 * Run one bounded, controller-fenced investigation wave. This function does
 * not know how to close, decompose, materialize, claim, or build issues: its
 * only side effect is the durable orchestration checkpoint supplied by the
 * controller. A completed settlement is always reused on restart.
 */
export async function runInvestigationAdmission(
  input: InvestigationAdmissionInput,
  dependencies: InvestigationAdmissionDependencies,
): Promise<OrchestrationAdmissionProof> {
  const now = input.now ?? (() => new Date().toISOString());
  const maxAttempts = input.maxAttempts ?? MAX_INVESTIGATION_ATTEMPTS;
  assertWaveInput(input, maxAttempts);
  const record = await dependencies.load();
  dependencies.claim.assertValid();
  const existing = record.investigationWave;
  const wave = existing && existing.waveId === input.waveId
    ? normalizeWave(existing, input, maxAttempts)
    : createWave(input, now(), maxAttempts);
  const checkpoint = (next: OrchestrationInvestigationWave): Promise<void> => {
    dependencies.claim.assertValid();
    record.investigationWave = structuredClone(next);
    record.updatedAt = now();
    return dependencies.save(record);
  };

  wave.state = "running";
  wave.executionAttempt = input.executionAttempt;
  wave.executionClaimId = input.executionClaimId;
  wave.updatedAt = now();
  await checkpoint(wave);

  for (const selection of input.selected) {
    dependencies.claim.assertValid();
    if (input.signal?.aborted) {
      cancelUnsettled(wave, now(), input.signal.reason);
      await checkpoint(wave);
      throw cancellationError(input.waveId, input.signal.reason);
    }
    const settled = wave.settlements.find((candidate) =>
      orchestrationIssueIdentityKey(candidate) === orchestrationIssueIdentityKey(selection)
      && candidate.waveId === input.waveId);
    if (settled && isTerminal(settled.state)) continue;
    let final: OrchestrationInvestigationSettlement | undefined;
    for (let attempt = Math.max(1, settled?.attempt ?? 1); attempt <= maxAttempts; attempt += 1) {
      dependencies.claim.assertValid();
      if (input.signal?.aborted) {
        cancelUnsettled(wave, now(), input.signal.reason);
        await checkpoint(wave);
        throw cancellationError(input.waveId, input.signal.reason);
      }
      if (settled) settled.state = "retrying";
      const retrying: OrchestrationInvestigationSettlement = {
        ...selection,
        repository: normalizeOrchestrationRepository(selection.repository),
        waveId: input.waveId,
        state: "retrying",
        attempt,
        maxAttempts,
        updatedAt: now(),
      };
      upsertSettlement(wave, retrying);
      await checkpoint(wave);
      try {
        const result = await dependencies.worker({
          waveId: input.waveId,
          executionAttempt: input.executionAttempt,
          selection: { ...selection, repository: normalizeOrchestrationRepository(selection.repository) },
          attempt,
          signal: input.signal ?? new AbortController().signal,
        });
        dependencies.claim.assertValid();
        final = {
          ...retrying,
          state: result.state,
          ...(result.investigationArtifactId ? { investigationArtifactId: result.investigationArtifactId } : {}),
          ...(result.outcomeArtifactId ? { outcomeArtifactId: result.outcomeArtifactId } : {}),
          ...(result.decompositionChildren ? { decompositionChildren: result.decompositionChildren.map(normalizeIdentity) } : {}),
          ...(result.error ? { error: result.error } : {}),
          updatedAt: now(),
        };
        upsertSettlement(wave, final);
        await checkpoint(wave);
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (input.signal?.aborted) {
          cancelUnsettled(wave, now(), input.signal.reason);
          await checkpoint(wave);
          throw cancellationError(input.waveId, input.signal.reason);
        }
        final = {
          ...retrying,
          state: attempt >= maxAttempts ? "failed" : "retrying",
          error: message,
          updatedAt: now(),
        };
        upsertSettlement(wave, final);
        await checkpoint(wave);
        if (attempt >= maxAttempts) break;
      }
    }
    if (!final || !isTerminal(final.state)) throw new Error(`Investigation ${selection.repository}#${selection.issue} did not settle`);
  }

  wave.state = wave.settlements.every((settlement) => settlement.state === "confirmed")
    ? "confirmed"
    : wave.settlements.some((settlement) => settlement.state === "cancelled")
      ? "cancelled"
      : wave.settlements.some((settlement) => settlement.state === "failed")
        ? "failed"
        : "settled";
  wave.updatedAt = now();
  await checkpoint(wave);
  if (wave.state !== "confirmed") throw new Error(`Investigation wave ${wave.waveId} is ${wave.state}; delivery admission is refused`);
  return {
    waveId: wave.waveId,
    repository: wave.repository,
    targetBranch: wave.targetBranch,
    selected: structuredClone(wave.settlements),
    settledAt: wave.updatedAt,
  };
}

export function admissionProofFromWave(wave: OrchestrationInvestigationWave): OrchestrationAdmissionProof {
  if (wave.state !== "confirmed" || wave.settlements.some((settlement) => settlement.state !== "confirmed")) {
    throw new Error(`Investigation wave ${wave.waveId} is not a confirmed admission`);
  }
  return { waveId: wave.waveId, repository: wave.repository, targetBranch: wave.targetBranch, selected: structuredClone(wave.settlements), settledAt: wave.updatedAt };
}

function assertWaveInput(input: InvestigationAdmissionInput, maxAttempts: number): void {
  if (!input.waveId.trim()) throw new Error("Investigation wave id is required");
  if (!input.repository.trim() || !input.targetBranch.trim()) throw new Error("Investigation wave route is required");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_INVESTIGATION_ATTEMPTS) throw new Error(`Investigation retry limit must be between 1 and ${MAX_INVESTIGATION_ATTEMPTS}`);
  const seen = new Set<string>();
  for (const selection of input.selected) {
    if (!Number.isSafeInteger(selection.issue) || selection.issue < 1) throw new Error("Investigation issue must be positive");
    if (!/^[0-9a-f]{7,64}$/i.test(selection.baseSha)) throw new Error(`Missing or invalid exact base SHA for ${selection.repository}#${selection.issue}`);
    const key = orchestrationIssueIdentityKey(selection);
    if (seen.has(key)) throw new Error(`Duplicate investigation selection ${selection.repository}#${selection.issue}`);
    seen.add(key);
  }
  if (!seen.size) throw new Error("Investigation wave requires at least one selected issue");
}

function createWave(input: InvestigationAdmissionInput, timestamp: string, maxAttempts: number): OrchestrationInvestigationWave {
  return {
    schema: "forgedock.investigation-wave/v1",
    waveId: input.waveId,
    ...(input.parentWaveId ? { parentWaveId: input.parentWaveId } : {}),
    repository: normalizeOrchestrationRepository(input.repository),
    targetBranch: input.targetBranch,
    selected: input.selected.map(normalizeIdentity),
    frozenBases: input.selected.map((selection) => ({ repository: normalizeOrchestrationRepository(selection.repository), issue: selection.issue, targetBranch: selection.targetBranch, baseSha: selection.baseSha })),
    settlements: [],
    state: "pending",
    executionAttempt: input.executionAttempt,
    executionClaimId: input.executionClaimId,
    maxAttempts,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeWave(existing: OrchestrationInvestigationWave, input: InvestigationAdmissionInput, maxAttempts: number): OrchestrationInvestigationWave {
  if (existing.repository !== normalizeOrchestrationRepository(input.repository) || existing.targetBranch !== input.targetBranch) throw new Error(`Investigation wave ${input.waveId} route changed`);
  const expected = input.selected.map((selection) => orchestrationIssueIdentityKey(selection)).sort().join("\0");
  const actual = existing.selected.map(orchestrationIssueIdentityKey).sort().join("\0");
  if (expected !== actual) throw new Error(`Investigation wave ${input.waveId} selected issue set changed`);
  const frozenBases = existing.frozenBases ?? [];
  if (frozenBases.length !== input.selected.length) throw new Error(`Investigation wave ${input.waveId} is missing frozen base evidence`);
  for (const frozen of frozenBases) {
    const selection = input.selected.find((candidate) => orchestrationIssueIdentityKey(candidate) === orchestrationIssueIdentityKey(frozen));
    if (!selection || selection.baseSha.toLowerCase() !== frozen.baseSha.toLowerCase() || selection.targetBranch !== frozen.targetBranch) throw new Error(`Investigation wave ${input.waveId} base or route evidence changed`);
  }
  for (const settlement of existing.settlements) {
    if (!/^[0-9a-f]{7,64}$/i.test(settlement.baseSha)) throw new Error(`Investigation wave ${input.waveId} contains missing base SHA evidence`);
    const selection = input.selected.find((candidate) => orchestrationIssueIdentityKey(candidate) === orchestrationIssueIdentityKey(settlement));
    if (!selection || selection.baseSha.toLowerCase() !== settlement.baseSha.toLowerCase() || selection.targetBranch !== settlement.targetBranch) {
      throw new Error(`Investigation wave ${input.waveId} base or route evidence changed`);
    }
  }
  return { ...structuredClone(existing), maxAttempts, settlements: existing.settlements.map((settlement) => ({ ...settlement, maxAttempts })) };
}

function normalizeIdentity(identity: OrchestrationIssueIdentity): OrchestrationIssueIdentity {
  return { repository: normalizeOrchestrationRepository(identity.repository), issue: identity.issue };
}

function upsertSettlement(wave: OrchestrationInvestigationWave, settlement: OrchestrationInvestigationSettlement): void {
  const key = orchestrationIssueIdentityKey(settlement);
  const index = wave.settlements.findIndex((candidate) => orchestrationIssueIdentityKey(candidate) === key);
  if (index === -1) wave.settlements.push(structuredClone(settlement));
  else {
    const previous = wave.settlements[index]!;
    if (isTerminal(previous.state) && !isTerminal(settlement.state)) return;
    wave.settlements[index] = structuredClone(settlement);
  }
  wave.settlements.sort((left, right) => orchestrationIssueIdentityKey(left).localeCompare(orchestrationIssueIdentityKey(right)));
}

function isTerminal(state: InvestigationSettlementState): boolean {
  return state === "confirmed" || state === "invalid" || state === "decomposed" || state === "failed" || state === "cancelled";
}

function cancelUnsettled(wave: OrchestrationInvestigationWave, timestamp: string, reason: unknown): void {
  for (const selection of wave.selected) {
    const current = wave.settlements.find((candidate) => orchestrationIssueIdentityKey(candidate) === orchestrationIssueIdentityKey(selection));
    if (current && isTerminal(current.state)) continue;
    const message = reason === undefined ? undefined : reason instanceof Error ? reason.message : String(reason);
    const frozen = (wave.frozenBases ?? []).find((candidate) => orchestrationIssueIdentityKey(candidate) === orchestrationIssueIdentityKey(selection));
    const settlement: OrchestrationInvestigationSettlement = {
      repository: selection.repository,
      issue: selection.issue,
      waveId: wave.waveId,
      targetBranch: wave.targetBranch,
      baseSha: current?.baseSha ?? frozen?.baseSha ?? "",
      state: "cancelled",
      attempt: current?.attempt ?? 0,
      maxAttempts: wave.maxAttempts,
      updatedAt: timestamp,
    };
    if (message !== undefined) settlement.error = message;
    upsertSettlement(wave, settlement);
  }
  wave.state = "cancelled";
}

function cancellationError(waveId: string, reason: unknown): Error {
  return new Error(`Investigation wave ${waveId} cancelled${reason ? `: ${reason instanceof Error ? reason.message : String(reason)}` : ""}`);
}
