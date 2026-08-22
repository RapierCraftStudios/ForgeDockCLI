// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash, randomUUID } from "node:crypto";
import { classifyRetryableError, retryBackoffMs } from "../../core/retry.js";
import type { InvestigationPayload } from "../../core/artifacts/schema.js";
import type { DecompositionChild, ForgeHost, IssueSnapshot } from "../../core/ports/forge-host.js";
import type {
  InvestigationReleaseReceipt,
  InvestigationSettlementRecord,
  InvestigationWaveRecord,
  InvestigationWaveRepository,
} from "../../core/ports/orchestration.js";

export interface InvestigationAdmissionIssue {
  repository: string;
  issue: number;
  targetBranch: string;
  /** Optional lineage for a bounded decomposition follow-up wave. */
  lineage?: { parentIssue: number; depth: number };
}

export interface InvestigationAdmissionResult {
  outcome: InvestigationPayload["outcome"] | "confirmed" | "decomposed";
  artifactIds?: readonly string[];
  replacementIssueNumbers?: readonly number[];
  decomposition?: readonly DecompositionChild[];
  error?: string;
}

export interface ReadOnlyInvestigatorInput {
  issue: IssueSnapshot;
  repository: string;
  targetBranch: string;
  baseSha: string;
  attempt: number;
  signal?: AbortSignal;
}

export type ReadOnlyInvestigator = (input: ReadOnlyInvestigatorInput) => Promise<InvestigationAdmissionResult>;

export interface InvestigationAdmissionDependencies {
  repository: InvestigationWaveRepository;
  host: Pick<ForgeHost, "getIssue" | "getBranchHead" | "materializeDecomposition">;
  investigate: ReadOnlyInvestigator;
  owner?: string;
  maxAttempts?: number;
  now?: () => string;
  signal?: AbortSignal;
}

export interface InvestigationAdmissionInput {
  repository: string;
  issues: readonly InvestigationAdmissionIssue[];
  waveId?: string;
  /** A recovery call may adopt a durable wave owned by a dead controller. */
  recover?: boolean;
}

export interface InvestigationAdmissionResultSet {
  wave: InvestigationWaveRecord;
  releaseReceipt?: InvestigationReleaseReceipt;
}

/**
 * Controller-owned, read-only admission barrier. The service deliberately has
 * no batch or builder dependency: its only write boundary is the typed
 * decomposition host callback, and release is possible only after exact ref
 * revalidation and durable terminal settlement for every selected issue.
 */
export class InvestigationAdmissionService {
  private readonly owner: string;
  private readonly maxAttempts: number;
  private readonly now: () => string;

  constructor(private readonly dependencies: InvestigationAdmissionDependencies) {
    this.owner = dependencies.owner ?? `investigation-controller-${randomUUID()}`;
    this.maxAttempts = dependencies.maxAttempts ?? 3;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error("Investigation maxAttempts must be positive");
    if (!dependencies.host.getIssue || !dependencies.host.getBranchHead) throw new Error("Investigation admission requires read-only issue and branch-head ports");
  }

  async admit(input: InvestigationAdmissionInput): Promise<InvestigationAdmissionResultSet> {
    const issues = normalizeIssues(input.repository, input.issues);
    if (!issues.length) throw new Error("Investigation admission requires at least one selected issue");
    const captured = await Promise.all(issues.map(async (issue) => {
      const snapshot = await this.dependencies.host.getIssue!(issue.issue, issue.repository);
      if (snapshot.state !== "OPEN") throw new Error(`${issue.repository}#${issue.issue} is ${snapshot.state.toLowerCase()}`);
      const baseSha = await this.dependencies.host.getBranchHead!(issue.repository, issue.targetBranch);
      if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new Error(`Exact base SHA is unavailable for ${issue.repository}#${issue.issue} on ${issue.targetBranch}`);
      return { issue, snapshot, baseSha: baseSha.toLowerCase() };
    }));
    const waveId = input.waveId ?? deterministicWaveId(input.repository, captured.map(({ issue, baseSha }) => ({ ...issue, baseSha })));
    let wave = await this.dependencies.repository.loadInvestigationWave(waveId);
    if (!wave) {
      const now = this.now();
      wave = {
        schema: "forgedock.investigation-wave/v1",
        waveId,
        repository: input.repository,
        selectedIssueNumbers: captured.map(({ issue }) => issue.issue).sort((a, b) => a - b),
        issues: captured.map(({ issue, baseSha }) => ({
          repository: issue.repository,
          issue: issue.issue,
          targetBranch: issue.targetBranch,
          baseSha,
          status: "pending",
          attempt: 0,
          maxAttempts: this.maxAttempts,
          updatedAt: now,
          artifactIds: [],
          replacementIssueNumbers: [],
          ...(issue.lineage ? { lineage: { ...issue.lineage } } : {}),
        })),
        status: "pending",
        owner: this.owner,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await this.dependencies.repository.createInvestigationWave(wave);
    } else {
      assertSameWaveSelection(wave, captured);
      if (wave.owner !== this.owner && !input.recover && wave.status === "running") {
        throw new Error(`Investigation wave ${waveId} is owned by another controller`);
      }
      if (wave.owner !== this.owner && input.recover) {
        const adopted: InvestigationWaveRecord = { ...structuredClone(wave), owner: this.owner, version: wave.version + 1, updatedAt: this.now() };
        if (!this.dependencies.repository.adoptInvestigationWave) throw new Error(`Investigation wave ${waveId} cannot be recovered without an owner-adoption fence`);
        await this.dependencies.repository.adoptInvestigationWave(wave.version, wave.owner, adopted);
        wave = adopted;
      }
    }

    if (wave.status === "settled" && wave.releaseReceipt) {
      await this.revalidateCapturedBases(captured);
      assertReleaseReceiptCurrent(wave.releaseReceipt, captured);
      return { wave: structuredClone(wave), releaseReceipt: structuredClone(wave.releaseReceipt) };
    }
    if (wave.status === "cancelled") return { wave: structuredClone(wave) };

    wave = await this.save(wave, { status: "running" });
    for (const capturedIssue of captured) {
      if (this.dependencies.signal?.aborted) {
        wave = await this.cancelPendingIssues(wave);
        return { wave: structuredClone(wave) };
      }
      const current = wave.issues.find((entry) => entry.issue === capturedIssue.issue.issue && entry.repository === capturedIssue.issue.repository);
      if (!current || isTerminal(current.status)) continue;
      // Re-admission never silently changes the captured authority.
      if (current.baseSha.toLowerCase() !== capturedIssue.baseSha.toLowerCase()) throw new Error(`Investigation base changed for ${current.repository}#${current.issue}`);
      const settled = await this.investigateOne(wave, current, capturedIssue.snapshot);
      wave = settled.wave;
      if (settled.blocked) {
        const cancelled = wave.issues.some((issue) => issue.status === "cancelled");
        wave = await this.save(wave, { status: cancelled ? "cancelled" : "blocked" });
        return { wave: structuredClone(wave) };
      }
    }

    const latest = await this.dependencies.repository.loadInvestigationWave(wave.waveId) ?? wave;
    if (latest.issues.some((issue) => issue.status !== "confirmed")) {
      wave = await this.save(latest, { status: "blocked" });
      return { wave: structuredClone(wave) };
    }
    await this.revalidateCapturedBases(captured);
    const receipt: InvestigationReleaseReceipt = {
      waveId: latest.waveId,
      repository: latest.repository,
      issueNumbers: [...latest.selectedIssueNumbers],
      bases: latest.issues.map(({ repository, issue, targetBranch, baseSha }) => ({ repository, issue, targetBranch, baseSha })),
      settledAt: this.now(),
    };
    assertReleaseReceiptCurrent(receipt, captured);
    wave = await this.save(latest, { status: "settled", releaseReceipt: receipt });
    return { wave: structuredClone(wave), releaseReceipt: structuredClone(receipt) };
  }

  private async investigateOne(
    wave: InvestigationWaveRecord,
    current: InvestigationSettlementRecord,
    snapshot: IssueSnapshot,
  ): Promise<{ wave: InvestigationWaveRecord; blocked: boolean }> {
    let working = wave;
    for (let attempt = current.attempt + 1; attempt <= current.maxAttempts; attempt += 1) {
      if (this.dependencies.signal?.aborted) {
        working = await this.save(working, { issues: replaceIssue(working.issues, current.issue, { status: "cancelled", attempt: Math.max(current.attempt, attempt - 1), updatedAt: this.now(), error: "Investigation wave cancelled" }) });
        return { wave: working, blocked: true };
      }
      working = await this.save(working, { issues: replaceIssue(working.issues, current.issue, { status: "running", attempt, updatedAt: this.now() }) });
      const active = working.issues.find((issue) => issue.issue === current.issue)!;
      try {
        const result = await this.dependencies.investigate({
          issue: snapshot,
          repository: active.repository,
          targetBranch: active.targetBranch,
          baseSha: active.baseSha,
          attempt,
          ...(this.dependencies.signal ? { signal: this.dependencies.signal } : {}),
        });
        const status = result.outcome === "decompose" ? "decomposed" : result.outcome;
        if (status === "decomposed") {
          const childNumbers = [...new Set(result.replacementIssueNumbers ?? [])].sort((a, b) => a - b);
          // This is the sole external mutation permitted by the admission
          // service, and it is a typed host operation, never a batch write.
          const childDefinitions = result.decomposition ?? [];
          if (childDefinitions.length < 2) throw new Error(`Decomposition for ${active.repository}#${active.issue} returned no child definitions`);
          const materialized = await this.dependencies.host.materializeDecomposition({
            repo: active.repository,
            parentIssue: active.issue,
            children: [...childDefinitions],
          });
          const materializedNumbers = materialized.map((child) => child.number);
          if (childNumbers.length && materializedNumbers.length && !sameNumbers(materializedNumbers, childNumbers)) throw new Error(`Decomposition host returned a different child set for ${active.repository}#${active.issue}`);
          working = await this.save(working, { issues: replaceIssue(working.issues, active.issue, {
            status: "decomposed", artifactIds: [...new Set([...active.artifactIds, ...(result.artifactIds ?? []), deterministicInvestigationSettlementId(working.waveId, active.repository, active.issue, attempt, "decomposed")])], replacementIssueNumbers: materializedNumbers.length ? materializedNumbers : childNumbers, attempt, updatedAt: this.now(),
          }) });
          return { wave: working, blocked: true };
        }
        if (status !== "confirmed" && status !== "invalid") throw new Error(`Unsupported investigation outcome: ${String(result.outcome)}`);
        const artifactIds = [...new Set([
          ...active.artifactIds,
          ...(result.artifactIds ?? []),
          deterministicInvestigationSettlementId(working.waveId, active.repository, active.issue, attempt, status),
        ])];
        working = await this.save(working, { issues: replaceIssue(working.issues, active.issue, {
          status, artifactIds, attempt, updatedAt: this.now(),
        }) });
        return { wave: working, blocked: status !== "confirmed" };
      } catch (error) {
        if (isAbort(this.dependencies.signal, error)) {
          working = await this.save(working, { issues: replaceIssue(working.issues, current.issue, { status: "cancelled", attempt, updatedAt: this.now(), error: errorMessage(error) }) });
          return { wave: working, blocked: true };
        }
        const classification = classifyRetryableError(error, { domain: "provider" });
        if (!classification.retryable || attempt >= current.maxAttempts) {
          working = await this.save(working, { issues: replaceIssue(working.issues, current.issue, { status: "failed", attempt, updatedAt: this.now(), error: errorMessage(error) }) });
          return { wave: working, blocked: true };
        }
        const nextAttemptAt = new Date(Date.parse(this.now()) + retryBackoffMs(attempt, {
          ...(classification.retryAfterMs !== undefined ? { retryAfterMs: classification.retryAfterMs } : {}),
          operationKey: `${working.waveId}:${current.issue}`,
        })).toISOString();
        working = await this.save(working, { issues: replaceIssue(working.issues, current.issue, {
          status: "retrying", attempt, updatedAt: this.now(), error: errorMessage(error),
          retryCheckpoint: { id: deterministicRetryId(working.waveId, current.issue, attempt), nextAttemptAt, domain: classification.domain, code: classification.code },
        }) });
      }
    }
    return { wave: working, blocked: true };
  }

  private async save(current: InvestigationWaveRecord, patch: Partial<InvestigationWaveRecord>): Promise<InvestigationWaveRecord> {
    const next: InvestigationWaveRecord = { ...structuredClone(current), ...structuredClone(patch), version: current.version + 1, updatedAt: this.now() };
    await this.dependencies.repository.saveInvestigationWave(current.version, next);
    return next;
  }

  private async cancelPendingIssues(wave: InvestigationWaveRecord): Promise<InvestigationWaveRecord> {
    let current = wave;
    for (const issue of wave.issues) {
      if (isTerminal(issue.status)) continue;
      current = await this.save(current, { issues: replaceIssue(current.issues, issue.issue, { status: "cancelled", updatedAt: this.now(), error: "Investigation wave cancelled" }) });
    }
    return this.save(current, { status: "cancelled" });
  }

  private async revalidateCapturedBases(captured: readonly { issue: InvestigationAdmissionIssue; baseSha: string }[]): Promise<void> {
    for (const entry of captured) {
      const current = await this.dependencies.host.getBranchHead!(entry.issue.repository, entry.issue.targetBranch);
      if (!/^[0-9a-f]{40}$/i.test(current) || current.toLowerCase() !== entry.baseSha.toLowerCase()) {
        throw new Error(`Investigation base SHA drifted for ${entry.issue.repository}#${entry.issue.issue}; refusing barrier release`);
      }
    }
  }

}

export function deterministicWaveId(repository: string, issues: readonly (InvestigationAdmissionIssue & { baseSha: string })[]): string {
  const identity = [repository.trim().toLowerCase(), ...issues.map((issue) => [issue.repository.trim().toLowerCase(), issue.issue, issue.targetBranch, issue.baseSha.toLowerCase()])];
  return `wave_${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
}

export function deterministicRetryId(waveId: string, issue: number, attempt: number): string {
  return `retry_${createHash("sha256").update(`${waveId}\0${issue}\0${attempt}`).digest("hex").slice(0, 32)}`;
}

export function deterministicInvestigationSettlementId(
  waveId: string,
  repository: string,
  issue: number,
  attempt: number,
  status: InvestigationSettlementRecord["status"],
): string {
  return `art_investigation_settlement_${createHash("sha256").update(`${waveId}\0${repository.toLowerCase()}\0${issue}\0${attempt}\0${status}`).digest("hex").slice(0, 32)}`;
}

function normalizeIssues(repository: string, issues: readonly InvestigationAdmissionIssue[]): InvestigationAdmissionIssue[] {
  const seen = new Set<string>();
  return issues.map((issue) => {
    if (!Number.isSafeInteger(issue.issue) || issue.issue < 1 || !issue.targetBranch.trim()) throw new Error("Investigation issue identity is malformed");
    const normalized = { ...issue, repository: (issue.repository || repository).trim().toLowerCase() };
    const key = `${normalized.repository}#${normalized.issue}`;
    if (seen.has(key)) throw new Error(`Duplicate selected issue ${key}`);
    seen.add(key);
    return normalized;
  }).sort((left, right) => left.repository.localeCompare(right.repository) || left.issue - right.issue);
}

function assertSameWaveSelection(wave: InvestigationWaveRecord, captured: readonly { issue: InvestigationAdmissionIssue; baseSha: string }[]): void {
  const expected = captured.map(({ issue, baseSha }) => `${issue.repository}#${issue.issue}@${issue.targetBranch}@${baseSha}`).sort();
  const actual = wave.issues.map((issue) => `${issue.repository}#${issue.issue}@${issue.targetBranch}@${issue.baseSha}`).sort();
  if (expected.join("|") !== actual.join("|")) throw new Error(`Investigation wave ${wave.waveId} does not match the selected exact-base issue set`);
}

function replaceIssue(issues: readonly InvestigationSettlementRecord[], issue: number, patch: Partial<InvestigationSettlementRecord>): InvestigationSettlementRecord[] {
  return issues.map((entry) => entry.issue === issue ? { ...entry, ...structuredClone(patch) } : entry);
}

function isTerminal(status: InvestigationSettlementRecord["status"]): boolean {
  return status === "confirmed" || status === "invalid" || status === "decomposed" || status === "failed" || status === "cancelled";
}

function assertReleaseReceiptCurrent(receipt: InvestigationReleaseReceipt, captured: readonly { issue: InvestigationAdmissionIssue; baseSha: string }[]): void {
  if (receipt.issueNumbers.length !== captured.length || receipt.bases.length !== captured.length) throw new Error("Investigation release is incomplete");
  for (const entry of captured) {
    const base = receipt.bases.find((candidate) => candidate.repository.toLowerCase() === entry.issue.repository.toLowerCase() && candidate.issue === entry.issue.issue);
    if (!base || base.targetBranch !== entry.issue.targetBranch || base.baseSha.toLowerCase() !== entry.baseSha.toLowerCase()) throw new Error(`Investigation release base is stale for #${entry.issue.issue}`);
  }
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return [...left].sort((a, b) => a - b).join(",") === [...right].sort((a, b) => a - b).join(",");
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isAbort(signal: AbortSignal | undefined, error: unknown): boolean { return signal?.aborted === true || error instanceof Error && /cancel|abort|interrupt/i.test(error.message); }
