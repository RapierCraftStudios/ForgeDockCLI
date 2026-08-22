// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstat, readFile, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, resolve, join } from "node:path";
import { canonicalizeConcreteScopePaths, isConcreteScopePath } from "../../runtime/agent-runtime.js";
import type { DurableArtifact, InvestigationScopeReceipt, Subject } from "../artifacts/schema.js";
import { digestRelation } from "./relation-graph.js";

const execFileAsync = promisify(execFile);

export interface InvestigationScopeLimits {
  maxComponentRoots: number;
  maxTotalPaths: number;
  maxNewPaths: number;
  maxRelationReads: number;
  maxEvidenceBytes: number;
}

export const INVESTIGATION_SCOPE_LIMITS: Readonly<InvestigationScopeLimits> = Object.freeze({
  maxComponentRoots: 8,
  maxTotalPaths: 32,
  maxNewPaths: 4,
  maxRelationReads: 32,
  maxEvidenceBytes: 4_000_000,
});

export interface InvestigationScopeDecision {
  proposalPaths: string[];
  approvedPaths: string[];
  newPaths: string[];
  componentRoots: string[];
  evidencePaths: string[];
  evidenceDigests: Array<{ path: string; digest: string; bytes: number }>;
  evidenceBytes: number;
  relationReads: number;
}

export interface DeriveInvestigationScopeInput {
  runId: string;
  subject: Subject;
  intent: DurableArtifact<"Intent">;
  investigation: DurableArtifact<"Investigation">;
  baseSha: string;
  proposedPaths: readonly string[];
  cwd: string;
  limits?: Partial<InvestigationScopeLimits>;
  /** Safe controller-resolved evidence; callers may omit it to resolve sources here. */
  evidencePaths?: readonly string[];
}

/**
 * Derive write authority for an investigation that found a real issue without
 * issue-owned file hints. This function is controller-only: its inputs are
 * frozen artifacts and a read-only checkout, never packet-author prose.
 */
export async function deriveInvestigationScopeDecision(input: DeriveInvestigationScopeInput): Promise<InvestigationScopeDecision> {
  const limits = boundedLimits(input.limits);
  if (input.investigation.payload.outcome !== "confirmed" || input.investigation.payload.confidence !== "high") {
    throw new Error("[investigation-scope] Receipt requires a confirmed high-confidence investigation");
  }
  if (!/^[0-9a-f]{40}$/i.test(input.baseSha)) throw new Error("[investigation-scope] Receipt requires the exact 40-character base SHA");

  const proposalPaths = canonicalProposal(input.proposedPaths, limits.maxTotalPaths);
  const evidenceCandidates = canonicalProposal(canonicalizeConcreteScopePaths([
    ...(input.evidencePaths ?? []),
    ...input.investigation.payload.affectedSurfaces.filter(isConcreteScopePath),
  ]), limits.maxTotalPaths);
  const evidence = await safeBaseFiles(evidenceCandidates, input.cwd, input.baseSha, limits.maxEvidenceBytes);
  const evidenceBacked = evidence.paths;
  if (!evidenceBacked.length) throw new Error("[investigation-scope] Investigation has no safe evidence-backed files");

  const componentRoots = [...new Set(evidenceBacked.map(componentRoot).filter(Boolean))].sort();
  if (!componentRoots.length || componentRoots.length > limits.maxComponentRoots) {
    throw new Error(`[investigation-scope] Evidence exceeds the ${limits.maxComponentRoots}-root component bound`);
  }

  const existing: string[] = [];
  const newPaths: string[] = [];
  let relationReads = 0;
  for (const path of proposalPaths) {
    const status = await pathStatus(path, input.cwd);
    if (status === "unsafe") throw new Error(`[investigation-scope] Unsafe path rejected: ${path}`);
    if (status === "existing") existing.push(path);
    else newPaths.push(path);
  }
  if (newPaths.length > limits.maxNewPaths) throw new Error(`[investigation-scope] New-path bound ${limits.maxNewPaths} exceeded`);

  const approvedExisting: string[] = [];
  for (const path of existing) {
    if (evidenceBacked.includes(path) || underRoot(path, componentRoots)) {
      approvedExisting.push(path);
      continue;
    }
    const readsNeeded = 1 + evidenceBacked.length;
    if (relationReads + readsNeeded > limits.maxRelationReads) throw new Error("[investigation-scope] Relation-read bound exceeded");
    relationReads += readsNeeded;
    if (await hasEvidenceRelation(path, evidenceBacked, input.cwd)) {
      approvedExisting.push(path);
    } else {
      throw new Error(`[investigation-scope] Existing candidate is unrelated to frozen evidence: ${path}`);
    }
  }
  for (const path of newPaths) {
    if (!underRoot(path, componentRoots)) throw new Error(`[investigation-scope] New candidate is outside an evidence-backed component: ${path}`);
  }
  const approvedPaths = [...new Set([...approvedExisting, ...newPaths])].sort();
  if (!approvedPaths.length || approvedPaths.length > limits.maxTotalPaths) throw new Error("[investigation-scope] Approved path bound exceeded");
  return {
    proposalPaths,
    approvedPaths,
    newPaths: [...new Set(newPaths)].sort(),
    componentRoots,
    evidencePaths: evidence.paths,
    evidenceDigests: evidence.digests.sort((left, right) => left.path.localeCompare(right.path)),
    evidenceBytes: evidence.bytes,
    relationReads,
  };
}

export function createInvestigationScopeReceipt(
  input: {
    runId: string;
    subject: Subject;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    baseSha: string;
    decision: InvestigationScopeDecision;
    relationCheckpointId: string;
    relationCheckpointDigest: string;
    limits?: Partial<InvestigationScopeLimits>;
  },
): InvestigationScopeReceipt {
  const limits = boundedLimits(input.limits);
  const proposalDigest = digestRelation(input.decision.proposalPaths);
  const decisionDigest = digestRelation({
    proposalDigest,
    componentRoots: input.decision.componentRoots,
    approvedPaths: input.decision.approvedPaths,
    newPaths: input.decision.newPaths,
    evidencePaths: input.decision.evidencePaths,
    evidenceDigests: input.decision.evidenceDigests,
    evidenceBytes: input.decision.evidenceBytes,
    relationReads: input.decision.relationReads,
    limits,
  });
  return {
    version: "forgedock.investigation-scope/v1",
    runId: input.runId,
    subject: input.subject,
    intentId: input.intent.id,
    intentDigest: digestRelation(input.intent.payload),
    investigationId: input.investigation.id,
    investigationDigest: digestRelation(input.investigation.payload),
    baseSha: input.baseSha.toLowerCase(),
    proposalDigest,
    decisionDigest,
    componentRoots: [...input.decision.componentRoots],
    approvedPaths: [...input.decision.approvedPaths],
    newPaths: [...input.decision.newPaths],
    evidencePaths: [...input.decision.evidencePaths],
    evidenceDigests: [...input.decision.evidenceDigests],
    evidenceBytes: input.decision.evidenceBytes,
    relationReads: input.decision.relationReads,
    limits,
    relationCheckpointId: input.relationCheckpointId,
    relationCheckpointDigest: input.relationCheckpointDigest,
  };
}

export function validateInvestigationScopeReceipt(input: {
  receipt: InvestigationScopeReceipt;
  runId: string;
  subject: Subject;
  intent: DurableArtifact<"Intent">;
  investigation: DurableArtifact<"Investigation">;
  baseSha: string;
  proposalPaths: readonly string[];
  expectedPaths: readonly string[];
  relationGraph?: { checkpointId: string; checkpointDigest: string; baseSha: string };
}): void {
  const { receipt } = input;
  if (receipt.version !== "forgedock.investigation-scope/v1") throw new Error("[investigation-scope] Unsupported receipt version");
  if (receipt.runId !== input.runId || JSON.stringify(receipt.subject) !== JSON.stringify(input.subject)) throw new Error("[investigation-scope] Receipt run or subject binding is stale");
  if (Object.entries(INVESTIGATION_SCOPE_LIMITS).some(([key, maximum]) => receipt.limits[key as keyof InvestigationScopeLimits] > maximum)) throw new Error("[investigation-scope] Receipt limits exceed controller limits");
  if (input.intent.runId !== input.runId || input.investigation.runId !== input.runId || JSON.stringify(input.intent.subject) !== JSON.stringify(input.subject) || JSON.stringify(input.investigation.subject) !== JSON.stringify(input.subject)) throw new Error("[investigation-scope] Receipt artifact run or subject binding is stale");
  if (receipt.intentId !== input.intent.id || receipt.intentDigest !== digestRelation(input.intent.payload)) throw new Error("[investigation-scope] Receipt intent binding is stale or tampered");
  if (receipt.investigationId !== input.investigation.id || receipt.investigationDigest !== digestRelation(input.investigation.payload)) throw new Error("[investigation-scope] Receipt investigation binding is stale or tampered");
  if (!/^[0-9a-f]{40}$/i.test(input.baseSha) || !/^[0-9a-f]{40}$/i.test(receipt.baseSha)) throw new Error("[investigation-scope] Receipt requires the exact 40-character base SHA");
  if (receipt.baseSha.toLowerCase() !== input.baseSha.toLowerCase()) throw new Error("[investigation-scope] Receipt base SHA is stale");
  const proposal = canonicalProposal(input.proposalPaths, receipt.limits.maxTotalPaths);
  if (receipt.proposalDigest !== digestRelation(proposal)) throw new Error("[investigation-scope] Receipt proposal digest does not match");
  const roots = receipt.componentRoots.map((root) => root.replaceAll("\\", "/").replace(/\/$/, ""));
  if (roots.some((root) => !isConcreteScopePath(root)) || new Set(roots).size !== roots.length || roots.length > receipt.limits.maxComponentRoots) throw new Error("[investigation-scope] Receipt component roots are malformed");
  const receiptEvidence = canonicalProposal(receipt.evidencePaths, receipt.limits.maxTotalPaths);
  if (new Set(receipt.evidencePaths).size !== receipt.evidencePaths.length || receipt.evidenceDigests.length !== receiptEvidence.length) throw new Error("[investigation-scope] Receipt evidence paths are malformed");
  if (receipt.evidenceBytes < 0 || receipt.evidenceBytes > receipt.limits.maxEvidenceBytes || receipt.relationReads < 0 || receipt.relationReads > receipt.limits.maxRelationReads) throw new Error("[investigation-scope] Receipt evidence limits are malformed");
  if (receipt.newPaths.some((path) => !isConcreteScopePath(path) || !underRoot(path, roots))) throw new Error("[investigation-scope] Receipt planned paths escape component roots");
  const evidenceDigestPaths = receipt.evidenceDigests.map(({ path }) => path);
  if (JSON.stringify([...evidenceDigestPaths].sort()) !== JSON.stringify([...receiptEvidence].sort())) throw new Error("[investigation-scope] Receipt evidence digest paths differ");
  const approved = canonicalProposal(receipt.approvedPaths, receipt.limits.maxTotalPaths);
  const expected = canonicalProposal(input.expectedPaths, receipt.limits.maxTotalPaths);
  if (approved.some((path) => !expected.includes(path)) || expected.some((path) => !approved.includes(path))) throw new Error("[investigation-scope] Packet expected paths do not exactly match the approved decision");
  if (approved.some((path) => !proposal.includes(path)) || proposal.some((path) => !approved.includes(path))) throw new Error("[investigation-scope] Receipt proposal and approved path sets differ");
  if (receipt.newPaths.length > receipt.limits.maxNewPaths || receipt.newPaths.some((path) => !approved.includes(path))) throw new Error("[investigation-scope] Receipt new-path set is not an approved subset");
  const expectedDecision = digestRelation({ proposalDigest: receipt.proposalDigest, componentRoots: receipt.componentRoots, approvedPaths: receipt.approvedPaths, newPaths: receipt.newPaths, evidencePaths: receipt.evidencePaths, evidenceDigests: receipt.evidenceDigests, evidenceBytes: receipt.evidenceBytes, relationReads: receipt.relationReads, limits: receipt.limits });
  if (receipt.decisionDigest !== expectedDecision) throw new Error("[investigation-scope] Receipt decision digest does not match");
  if (!input.relationGraph || receipt.relationCheckpointId !== input.relationGraph.checkpointId || receipt.relationCheckpointDigest !== input.relationGraph.checkpointDigest) throw new Error("[investigation-scope] Receipt relation checkpoint binding is stale");
  if (input.relationGraph && input.relationGraph.baseSha.toLowerCase() !== input.baseSha.toLowerCase()) throw new Error("[investigation-scope] Receipt relation checkpoint SHA is stale");
}

function boundedLimits(input: Partial<InvestigationScopeLimits> | undefined): InvestigationScopeLimits {
  const limits = { ...INVESTIGATION_SCOPE_LIMITS, ...(input ?? {}) } as InvestigationScopeLimits;
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 0) throw new Error("[investigation-scope] Limits must be non-negative integers");
  if (!limits.maxComponentRoots || !limits.maxTotalPaths || !limits.maxRelationReads || !limits.maxEvidenceBytes) throw new Error("[investigation-scope] Required limits must be positive");
  return limits;
}

function canonicalProposal(paths: readonly string[], max: number): string[] {
  if (paths.length > max) throw new Error(`[investigation-scope] Proposal exceeds ${max} paths`);
  if (paths.some((path) => !isConcreteScopePath(path))) throw new Error("[investigation-scope] Candidates must be exact safe repository paths");
  return canonicalizeConcreteScopePaths(paths).sort();
}

async function safeBaseFiles(paths: readonly string[], cwd: string, baseSha: string, remainingBytes: number): Promise<{ paths: string[]; digests: Array<{ path: string; digest: string; bytes: number }>; bytes: number }> {
  const result: string[] = [];
  const digests: Array<{ path: string; digest: string; bytes: number }> = [];
  let bytes = 0;
  for (const path of paths) {
    const blob = await readBaseBlob(cwd, baseSha, path, Math.min(1_048_576, remainingBytes));
    if (!blob || bytes + blob.bytes > remainingBytes) continue;
    bytes += blob.bytes;
    result.push(path);
    digests.push({ path, ...blob });
  }
  return { paths: result, digests, bytes };
}

async function pathStatus(path: string, cwd: string): Promise<"existing" | "missing" | "unsafe"> {
  if (!isConcreteScopePath(path)) return "unsafe";
  const root = resolve(cwd);
  const absolute = resolve(root, path);
  const lexical = relative(root, absolute).replaceAll("\\", "/");
  if (!lexical || lexical.startsWith("../") || isAbsolute(lexical)) return "unsafe";
  let realRoot: string;
  try { realRoot = await realpath(root); } catch { return "unsafe"; }
  try {
    let current = realRoot;
    const segments = lexical.split("/");
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) return "unsafe";
      if (index === segments.length - 1 && !entry.isFile()) return "unsafe";
    }
    return "existing";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unsafe";
    // A planned file may have a new nested parent, but every existing
    // ancestor must still be a real directory inside the frozen checkout.
    let parent = dirname(absolute);
    while (true) {
      try {
        const entry = await lstat(parent);
        if (entry.isSymbolicLink() || !entry.isDirectory()) return "unsafe";
        const realParent = await realpath(parent);
        const parentRelative = relative(realRoot, realParent).replaceAll("\\", "/");
        return parentRelative.startsWith("../") || isAbsolute(parentRelative) ? "unsafe" : "missing";
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") return "unsafe";
        const next = dirname(parent);
        if (next === parent) return "unsafe";
        parent = next;
      }
    }
  }
}

function componentRoot(path: string): string {
  const root = dirname(path).replaceAll("\\", "/");
  return root === "." ? "" : root;
}
function underRoot(path: string, roots: readonly string[]): boolean { return roots.some((root) => path === root || path.startsWith(`${root}/`)); }

async function hasEvidenceRelation(candidate: string, evidence: readonly string[], cwd: string): Promise<boolean> {
  const candidateText = await readBounded(candidate, cwd);
  const candidateName = candidate.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? candidate;
  for (const source of evidence) {
    const sourceText = await readBounded(source, cwd);
    const sourceName = source.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? source;
    if ((candidateText && (candidateText.includes(source) || candidateText.includes(sourceName)))
      || (sourceText && (sourceText.includes(candidate) || sourceText.includes(candidateName)))) return true;
  }
  return false;
}
async function readBounded(path: string, cwd: string): Promise<string | undefined> {
  try { return (await readFile(resolve(cwd, path), "utf8")).slice(0, 128 * 1024); } catch { return undefined; }
}

/** Revalidate evidence against immutable base blobs, never the dirty checkout. */
export async function revalidateInvestigationScopeEvidence(input: { receipt: InvestigationScopeReceipt; cwd: string; baseSha: string }): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(input.baseSha) || input.receipt.baseSha.toLowerCase() !== input.baseSha.toLowerCase()) throw new Error("[investigation-scope] Evidence base SHA is stale");
  const limits = boundedLimits(input.receipt.limits);
  if (input.receipt.evidencePaths.length !== input.receipt.evidenceDigests.length || input.receipt.evidencePaths.length > limits.maxTotalPaths) throw new Error("[investigation-scope] Receipt evidence set is malformed");
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const evidence of input.receipt.evidenceDigests) {
    const path = canonicalProposal([evidence.path], limits.maxTotalPaths)[0]!;
    if (seen.has(path)) throw new Error("[investigation-scope] Receipt evidence paths are not unique");
    seen.add(path);
    const blob = await readBaseBlob(input.cwd, input.baseSha, path, limits.maxEvidenceBytes);
    if (!blob || blob.digest !== evidence.digest || blob.bytes !== evidence.bytes) throw new Error(`[investigation-scope] Evidence blob differs at exact base SHA: ${path}`);
    totalBytes += blob.bytes;
    if (totalBytes > limits.maxEvidenceBytes) throw new Error("[investigation-scope] Receipt evidence bytes exceed controller limit");
  }
  const declaredEvidence = canonicalProposal(input.receipt.evidencePaths, limits.maxTotalPaths);
  if (declaredEvidence.length !== seen.size || declaredEvidence.some((path) => !seen.has(path))) throw new Error("[investigation-scope] Receipt evidence path set is inconsistent");
  if (totalBytes !== input.receipt.evidenceBytes) throw new Error("[investigation-scope] Receipt evidence byte total is inconsistent");
  if (input.receipt.relationReads > limits.maxRelationReads) throw new Error("[investigation-scope] Receipt relation reads exceed controller limit");
  for (const planned of input.receipt.newPaths) {
    if (await basePathExists(input.cwd, input.baseSha, planned)) throw new Error(`[investigation-scope] Planned path already exists at exact base SHA: ${planned}`);
    if (!underRoot(planned, input.receipt.componentRoots)) throw new Error(`[investigation-scope] Planned path is outside its component root: ${planned}`);
  }
}

async function basePathExists(cwd: string, baseSha: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["cat-file", "-e", `${baseSha}:${path}`], { cwd, encoding: "utf8", maxBuffer: 1024, windowsHide: true });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("[investigation-scope] Git executable is unavailable");
    return false;
  }
}

async function readBaseBlob(cwd: string, baseSha: string, path: string, maxBytes: number): Promise<{ digest: string; bytes: number } | undefined> {
  let tree: string;
  try {
    const result = await execFileAsync("git", ["ls-tree", "-z", baseSha, "--", path], { cwd, encoding: "utf8", maxBuffer: 4096, windowsHide: true });
    tree = result.stdout;
  } catch { return undefined; }
  const record = tree.split("\\0").find(Boolean);
  if (!record) return undefined;
  const mode = record.split(" ", 1)[0] ?? "";
  if (mode === "120000") throw new Error(`[investigation-scope] Evidence path is a symlink at exact base SHA: ${path}`);
  try {
    const result = await execFileAsync("git", ["show", `${baseSha}:${path}`], { cwd, encoding: "buffer" as const, maxBuffer: maxBytes + 1, windowsHide: true });
    const value = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
    if (value.byteLength > maxBytes) throw new Error(`[investigation-scope] Evidence file exceeds byte limit: ${path}`);
    return { digest: digestRelation([...value]), bytes: value.byteLength };
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeds byte limit")) throw error;
    return undefined;
  }
}
