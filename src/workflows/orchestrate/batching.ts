// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BatchMemberContractPayload } from "../../core/artifacts/schema.js";
import type { ScheduledWorkItem } from "./scheduler.js";

export type BatchRiskClass = BatchMemberContractPayload["riskClass"];
export type BatchMemberContract = BatchMemberContractPayload;

export interface BatchableWorkItem extends ScheduledWorkItem {
  title: string;
  summary: string;
  labels: readonly string[];
  affectedFiles: readonly string[];
  acceptanceCriteria?: readonly string[];
  repository?: string;
  /** Alias accepted at the boundary when an issue plan calls it `repo`. */
  repo?: string;
  targetBranch?: string;
  lane?: "fast" | "feature";
  promotionTarget?: string;
  productionTarget?: string;
  urgencyTier?: "urgent" | "normal";
  milestone?: string | { number?: number; title: string };
  sourcePullRequest?: number;
  sourceIssueUrl?: string;
  defectClass?: string;
  riskClass?: BatchRiskClass;
  /** Explicit semantic compatibility evidence for security/auth batching. */
  causalFamily?: string;
  riskCapabilities?: readonly string[];
  primaryDomain?: string;
  sharedSymbols?: readonly string[];
  memberIssues?: readonly number[];
  memberContract?: BatchMemberContract;
}

export interface IssueBatchGroup {
  id: string;
  kind: "same-file" | "source-pr" | "defect-class" | "leaf-directory";
  key: string;
  riskClass: BatchRiskClass;
  members: BatchableWorkItem[];
}

export interface IssueBatchPlan {
  groups: IssueBatchGroup[];
  ungrouped: BatchableWorkItem[];
  excluded: Array<{ item: BatchableWorkItem; reason: string }>;
}

export interface MaterializedBatchIssue {
  groupId: string;
  issue: number;
  title: string;
  summary: string;
}

export interface SensitiveBatchMemberEvidence {
  riskClass?: BatchRiskClass;
  causalFamily?: string;
  riskCapabilities?: readonly string[];
  primaryDomain?: string;
  sharedSymbols?: readonly string[];
  acceptanceCriteria?: readonly string[];
  affectedFiles: readonly string[];
  summary?: string;
}

const HIGH_BLAST_RADIUS = /(?:^|\/)(?:\.env\.example|docker-compose[^/]*|compose[^/]*|index\.[^/]+|main\.[^/]+)$/i;
const MAX_ROUTINE_MEMBERS = 8;
export const MAX_SENSITIVE_MEMBERS = 2;
const MAX_SENSITIVE_PRODUCTION_PATHS = 4;
const MAX_SENSITIVE_ATOMIC_CRITERIA = 3;
const BATCH_CONTRACT_VERSION = 2;

/**
 * Sensitive batching is deny-by-default: a shared path or source PR is only a
 * grouping hint, never semantic compatibility evidence.
 */
export function isSensitiveBatchCompatible(items: readonly SensitiveBatchMemberEvidence[]): boolean {
  if (items.length < 2 || items.length > MAX_SENSITIVE_MEMBERS) return false;
  if (items.some((item) => !isSensitiveRisk(item.riskClass ?? "routine"))) return false;

  const causalFamilies = items.map((item) => normalizedEvidence(item.causalFamily));
  if (!causalFamilies[0] || causalFamilies.some((family) => family !== causalFamilies[0])) return false;

  const sharesRiskCapability = hasCommonEvidence(items.map((item) => item.riskCapabilities));
  const primaryDomains = items.map((item) => normalizedEvidence(item.primaryDomain));
  const sharesPrimaryDomain = Boolean(primaryDomains[0]) && primaryDomains.every((domain) => domain === primaryDomains[0]);
  const sharesSymbol = hasCommonEvidence(items.map((item) => item.sharedSymbols));
  if (!sharesRiskCapability && !sharesPrimaryDomain && !sharesSymbol) return false;

  const productionPaths = unique(items.flatMap((item) => item.affectedFiles)
    .map(normalizeAffectedPath)
    .filter((path): path is string => path !== undefined && isProductionPath(path)));
  if (productionPaths.length > MAX_SENSITIVE_PRODUCTION_PATHS) return false;

  const criteria = items.flatMap((item) => item.acceptanceCriteria ?? (item.summary ? [item.summary] : []));
  return criteria.length > 0
    && criteria.length <= MAX_SENSITIVE_ATOMIC_CRITERIA
    && criteria.every((criterion) => criterion.trim().length > 0);
}

export function planIssueBatches(items: readonly BatchableWorkItem[]): IssueBatchPlan {
  const remaining = new Map<string, BatchableWorkItem>();
  const excluded: IssueBatchPlan["excluded"] = [];
  for (const item of items) {
    const reason = batchExclusionReason(item);
    if (reason) excluded.push({ item, reason });
    else remaining.set(item.id, item);
  }

  const groups: IssueBatchGroup[] = [];
  const claim = (
    kind: IssueBatchGroup["kind"],
    keyOf: (item: BatchableWorkItem) => string | undefined,
    minimum: number,
  ) => {
    const keyed = new Map<string, BatchableWorkItem[]>();
    for (const item of remaining.values()) {
      const key = keyOf(item);
      if (!key) continue;
      const risk = item.riskClass ?? "routine";
      const compound = `${risk}:${key}`;
      keyed.set(compound, [...(keyed.get(compound) ?? []), item]);
    }
    for (const [compound, candidates] of [...keyed].sort(([left], [right]) => left.localeCompare(right))) {
      candidates.sort((left, right) => left.priority - right.priority || left.issue - right.issue);
      const riskClass = (candidates[0]?.riskClass ?? "routine") as BatchRiskClass;
      const candidateGroups = isSensitiveRisk(riskClass)
        ? pairSensitiveBatchCandidates(candidates)
        : chunkBatchCandidates(candidates, MAX_ROUTINE_MEMBERS).filter((members) => members.length >= minimum);
      for (const members of candidateGroups) {
        if (members.length < minimum) continue;
        const key = compound.slice(compound.indexOf(":") + 1);
        const id = `batch:${kind}:${key}:${members.map((member) => member.issue).join("-")}`;
        groups.push({ id, kind, key, riskClass, members });
        for (const member of members) remaining.delete(member.id);
      }
    }
  };

  claim("same-file", (item) => item.affectedFiles[0], 2);
  claim("source-pr", (item) => item.sourcePullRequest ? String(item.sourcePullRequest) : undefined, 2);
  claim("defect-class", (item) => item.defectClass, 2);
  claim("leaf-directory", (item) => leafDirectory(item.affectedFiles[0]), 3);

  return { groups, ungrouped: [...remaining.values()], excluded };
}

export function batchExclusionReason(item: BatchableWorkItem, options: { allowOrdinary?: boolean } = {}): string | undefined {
  if (item.memberIssues?.length && item.memberIssues.length > 1) return "already-batched";
  const priority = priorityFromLabels(item.labels);
  if (!options.allowOrdinary && !item.labels.includes("review-finding")) return "not-review-finding";
  if (!options.allowOrdinary && priority !== "P2" && priority !== "P3") return "urgency";
  if (item.labels.some((label) => ["needs-human", "blocked", "operator-only", "batch"].includes(label))) return "human-or-batch-state";
  if (!item.affectedFiles.length) return "no-affected-file";
  const risk = item.riskClass ?? "routine";
  if (risk === "billing") return "billing";
  if (item.affectedFiles.some((file) => /\/migrations?\//i.test(file) || HIGH_BLAST_RADIUS.test(file))) return "high-blast-radius";
  return undefined;
}

export function contractBatchGroups(
  items: readonly BatchableWorkItem[],
  groups: readonly IssueBatchGroup[],
  materialized: readonly MaterializedBatchIssue[],
): BatchableWorkItem[] {
  const byGroup = new Map(materialized.map((batch) => [batch.groupId, batch]));
  const memberToBatch = new Map<string, string>();
  const replacements: BatchableWorkItem[] = [];

  for (const group of groups) {
    const issue = byGroup.get(group.id);
    if (!issue) throw new Error(`Batch group ${group.id} was not materialized`);
    const memberIds = new Set(group.members.map((member) => member.id));
    const dependencies = unique(group.members.flatMap((member) => member.dependencies).filter((dependency) => !memberIds.has(dependency)));
    const claims = unique(group.members.flatMap((member) => member.claims));
    const labels = unique(group.members.flatMap((member) => member.labels));
    const affectedFiles = unique(group.members.flatMap((member) => member.affectedFiles));
    const memberIssues = group.members.flatMap((member) => member.memberIssues?.length ? [...member.memberIssues] : [member.issue]);
    const repository = group.members[0]?.repository ?? group.members[0]?.repo;
    const id = `issue-${issue.issue}`;
    for (const member of group.members) memberToBatch.set(member.id, id);
    replacements.push({
      id,
      issue: issue.issue,
      title: issue.title,
      summary: issue.summary,
      ...(repository !== undefined ? { repository } : {}),
      priority: Math.min(...group.members.map((member) => member.priority)),
      dependencies,
      claims,
      labels,
      affectedFiles,
      riskClass: group.riskClass,
      ...(group.members[0]?.targetBranch !== undefined ? { targetBranch: group.members[0].targetBranch } : {}),
      ...(group.members[0]?.lane !== undefined ? { lane: group.members[0].lane } : {}),
      ...(group.members[0]?.promotionTarget !== undefined ? { promotionTarget: group.members[0].promotionTarget } : {}),
      ...(group.members[0]?.productionTarget !== undefined ? { productionTarget: group.members[0].productionTarget } : {}),
      ...(group.members[0]?.milestone !== undefined ? { milestone: group.members[0].milestone } : {}),
      memberIssues: uniqueNumbers(memberIssues),
    });
  }

  const groupedIds = new Set(memberToBatch.keys());
  const retained = items.filter((item) => !groupedIds.has(item.id)).map((item) => ({
    ...item,
    dependencies: unique(item.dependencies.map((dependency) => memberToBatch.get(dependency) ?? dependency)),
  }));
  const contracted = [...retained, ...replacements].map((item) => ({
    ...item,
    dependencies: unique(item.dependencies.map((dependency) => memberToBatch.get(dependency) ?? dependency)).filter((dependency) => dependency !== item.id),
  }));
  return contracted.sort((left, right) => left.priority - right.priority || left.issue - right.issue);
}

export function renderBatchIssueBody(group: IssueBatchGroup): string {
  const members = group.members.flatMap((member) => member.memberIssues?.length ? [...member.memberIssues] : [member.issue]);
  const contracts = group.members.map(memberContract).map((contract) => JSON.stringify(contract));
  const contractJson = JSON.stringify({ members: contracts.map((value) => JSON.parse(value)) });
  return [
    "## Problem",
    "",
    `Deliver ${members.length} compatible work items as one verified work unit to reduce repeated investigation, build, verification, and review overhead.`,
    "",
    "## Member Findings",
    "",
    "<!-- FORGE:BATCH_MEMBERS -->",
    ...group.members.flatMap((member) => [
      `- [ ] #${member.issue}: ${escapeText(member.title, 500)}`,
      `  - Scope: ${escapeText(member.summary)}`,
      `  - Affected files: ${member.affectedFiles.map((file) => `\`${escapeCode(file)}\``).join(", ") || "not declared"}`,
    ]),
    "<!-- /FORGE:BATCH_MEMBERS -->",
    "",
    `<!-- FORGEDOCK:BATCH_CONTRACT:v${BATCH_CONTRACT_VERSION} -->`,
    contractJson,
    `<!-- /FORGEDOCK:BATCH_CONTRACT:v${BATCH_CONTRACT_VERSION} -->`,
    "",
    "## Affected Surface",
    "",
    `- Grouping: ${group.kind}`,
    `- Key: \`${escapeCode(group.key)}\``,
    `- Risk class: ${group.riskClass}`,
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] Every member finding is addressed or rejected with evidence.",
    "- [ ] The combined change passes the frozen verification policy and independent review.",
    "- [ ] Successful completion records the batch Outcome on every member and closes every member issue.",
    "",
    `<!-- FORGEDOCK:BATCH ${batchMarker(members)} -->`,
  ].join("\n");
}

export function parseBatchContract(body: string): BatchMemberContract[] {
  const matches = [1, 2].flatMap((version) => [...body.matchAll(new RegExp(
    `<!-- FORGEDOCK:BATCH_CONTRACT:v${version} -->([\\s\\S]*?)<!-- \\/FORGEDOCK:BATCH_CONTRACT:v${version} -->`,
    "g",
  ))].map((match) => ({ version, match })));
  if (matches.length !== 1) throw new Error("Batch body must contain exactly one supported FORGEDOCK:BATCH_CONTRACT block");
  const { version, match } = matches[0]!;
  let parsed: unknown;
  try { parsed = JSON.parse(match[1]?.trim() ?? ""); }
  catch (error) { throw new Error("Batch contract contains invalid JSON", { cause: error }); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { members?: unknown }).members)) {
    throw new Error("Batch contract must contain a members array");
  }
  const members: BatchMemberContract[] = [];
  const seen = new Set<number>();
  for (const value of (parsed as { members: unknown[] }).members) {
    if (!value || typeof value !== "object") throw new Error("Batch contract member must be an object");
    const member = value as Record<string, unknown>;
    const issue = member.issue;
    if (typeof issue !== "number" || !Number.isSafeInteger(issue) || issue < 1 || seen.has(issue)) {
      throw new Error(`Batch contract contains a duplicated or invalid issue: ${String(issue)}`);
    }
    const arrays = ["acceptanceCriteria", "affectedFiles", "claims"] as const;
    for (const key of arrays) {
      if (!Array.isArray(member[key]) || member[key].some((item) => typeof item !== "string" || !item.trim())) {
        throw new Error(`Batch contract member #${issue} has invalid ${key}`);
      }
    }
    for (const key of ["riskCapabilities", "sharedSymbols"] as const) {
      if (member[key] !== undefined && (!Array.isArray(member[key]) || member[key].length === 0 || member[key].some((item) => typeof item !== "string" || !item.trim()))) {
        throw new Error(`Batch contract member #${issue} has invalid ${key}`);
      }
    }
    for (const key of ["causalFamily", "primaryDomain"] as const) {
      if (member[key] !== undefined && (typeof member[key] !== "string" || !member[key].trim())) {
        throw new Error(`Batch contract member #${issue} has invalid ${key}`);
      }
    }
    if (typeof member.title !== "string" || !member.title.trim()) throw new Error(`Batch contract member #${issue} has no title`);
    if (!["routine", "security", "auth", "billing"].includes(String(member.riskClass))) throw new Error(`Batch contract member #${issue} has invalid riskClass`);
    const allowed = new Set(version === 2
      ? ["issue", "repository", "title", "acceptanceCriteria", "affectedFiles", "claims", "riskClass", "causalFamily", "riskCapabilities", "primaryDomain", "sharedSymbols", "sourceIssueUrl"]
      : ["issue", "repository", "title", "acceptanceCriteria", "affectedFiles", "claims", "riskClass", "sourceIssueUrl"]);
    if (Object.keys(member).some((key) => !allowed.has(key))) throw new Error(`Batch contract member #${issue} contains unsupported fields`);
    seen.add(issue);
    members.push({
      issue,
      ...(typeof member.repository === "string" ? { repository: member.repository } : {}),
      title: member.title,
      acceptanceCriteria: member.acceptanceCriteria as string[],
      affectedFiles: member.affectedFiles as string[],
      claims: member.claims as string[],
      riskClass: member.riskClass as BatchRiskClass,
      ...(typeof member.causalFamily === "string" ? { causalFamily: member.causalFamily } : {}),
      ...(Array.isArray(member.riskCapabilities) ? { riskCapabilities: member.riskCapabilities as string[] } : {}),
      ...(typeof member.primaryDomain === "string" ? { primaryDomain: member.primaryDomain } : {}),
      ...(Array.isArray(member.sharedSymbols) ? { sharedSymbols: member.sharedSymbols as string[] } : {}),
      ...(typeof member.sourceIssueUrl === "string" ? { sourceIssueUrl: member.sourceIssueUrl } : {}),
    });
  }
  if (members.length < 2) throw new Error("Batch contract must contain at least two unique members");
  if (version === 2 && members.some((member) => isSensitiveRisk(member.riskClass)) && !isSensitiveBatchCompatible(members)) {
    throw new Error("Sensitive batch contract lacks explicit compatible cause, risk/domain/symbol evidence, or bounded scope");
  }
  if (body.includes("<!-- FORGE:BATCH_MEMBERS -->")) {
    const declared = parseBatchMemberIssues(body);
    const contracted = members.map((member) => member.issue).sort((left, right) => left - right);
    if (declared.join(",") !== contracted.join(",")) throw new Error("Batch member checklist and machine contract disagree");
  }
  return members;
}

export function affectedFilesFromIssueBody(body: string): string[] {
  const section = /^#{2,3}\s+(?:Affected Files|Deliverables|Files to change)\s*$([\s\S]*?)(?=^#{1,3}\s+|(?![\s\S]))/im.exec(body)?.[1] ?? "";
  const backticked = [...section.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]!.trim());
  return unique(backticked.map(normalizeAffectedPath).filter((path): path is string => path !== undefined));
}

function normalizeAffectedPath(value: string): string | undefined {
  const path = value.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/:\d+(?::\d+)?$/, "").replace(/\/$/, "").trim();
  if (!path || path === "." || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes(":")) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  const globIndex = path.search(/[*?[{]/);
  if (globIndex >= 0 && !path.slice(0, globIndex).replace(/\/$/, "")) return undefined;
  return path;
}

export function inferBatchRiskClass(title: string, body: string, labels: readonly string[]): BatchRiskClass {
  const text = `${title}\n${body}\n${labels.join(" ")}`;
  if (/\bbilling|credit|pricing|stripe|charge|refund\b/i.test(text)) return "billing";
  if (/\bauth(?:entication|orization)?\b|\bauth[zn]_\w+|oauth|permission|session|jwt|login/i.test(text)) return "auth";
  if (/security|inject|xss|csrf|ssrf|bypass|credential|secret|token|password|traversal|deserializ|\brce\b|privilege/i.test(text)) return "security";
  return "routine";
}

export function parseBatchMemberIssues(body: string): number[] {
  const matches = [...body.matchAll(/<!-- FORGE:BATCH_MEMBERS -->([\s\S]*?)<!-- \/FORGE:BATCH_MEMBERS -->/g)];
  if (!matches.length) return [];
  if (matches.length !== 1) throw new Error("Batch body must contain exactly one FORGE:BATCH_MEMBERS block");
  const section = matches[0]?.[1] ?? "";
  const values = [...section.matchAll(/^\s*- \[[ xX]\] #(\d+)\b/gm)].map((match) => Number(match[1]));
  if (!values.length) throw new Error("Batch member block contains no issue numbers");
  if (values.some((number) => !Number.isSafeInteger(number) || number < 1)) throw new Error("Batch member block contains an invalid issue number");
  const unique = uniqueNumbers(values);
  if (unique.length !== values.length) throw new Error("Batch member block contains duplicate issue numbers");
  if (unique.length > MAX_ROUTINE_MEMBERS) throw new Error(`Batch member block exceeds ${MAX_ROUTINE_MEMBERS} members`);
  return unique;
}

export function batchMarker(members: readonly number[]): string {
  return uniqueNumbers(members).sort((left, right) => left - right).join("-");
}

function memberContract(member: BatchableWorkItem): BatchMemberContract {
  return {
    issue: member.issue,
    ...(member.repository ?? member.repo ? { repository: member.repository ?? member.repo } : {}),
    title: escapeText(member.title, 500),
    acceptanceCriteria: [...(member.acceptanceCriteria ?? [member.summary])].map((value) => escapeText(value, 1_000)).slice(0, 12),
    affectedFiles: [...member.affectedFiles].map((value) => escapeCode(value)).slice(0, 50),
    claims: [...member.claims].map((value) => escapeText(value, 300)).slice(0, 50),
    riskClass: member.riskClass ?? "routine",
    ...(member.causalFamily?.trim() ? { causalFamily: escapeText(member.causalFamily, 300) } : {}),
    ...(member.riskCapabilities?.length ? { riskCapabilities: unique(member.riskCapabilities.map((value) => escapeText(value, 300)).filter(Boolean)) } : {}),
    ...(member.primaryDomain?.trim() ? { primaryDomain: escapeText(member.primaryDomain, 300) } : {}),
    ...(member.sharedSymbols?.length ? { sharedSymbols: unique(member.sharedSymbols.map((value) => escapeText(value, 300)).filter(Boolean)) } : {}),
    ...(member.sourceIssueUrl ? { sourceIssueUrl: member.sourceIssueUrl.slice(0, 500) } : {}),
  };
}

function priorityFromLabels(labels: readonly string[]): string | undefined {
  return labels.find((label) => /^priority:P[0-3]$/.test(label))?.slice(-2)
    ?? labels.find((label) => /^P[0-3]$/.test(label));
}

type NormalizedSensitiveCandidate<T extends SensitiveBatchMemberEvidence> = {
  candidate: T;
  sensitiveRisk: boolean;
  causalFamily?: string;
  riskCapabilities: Set<string>;
  primaryDomain?: string;
  sharedSymbols: Set<string>;
  productionPaths: Set<string>;
  criteria: readonly string[];
  evidenceKeys: string[];
};

/** Greedily pair sensitive candidates in input order without mutating the input. */
export function pairSensitiveBatchCandidates<T extends SensitiveBatchMemberEvidence>(
  candidates: readonly T[],
  maximumPairs = Math.floor(candidates.length / MAX_SENSITIVE_MEMBERS),
): T[][] {
  if (!Number.isSafeInteger(maximumPairs) || maximumPairs < 0) {
    throw new Error("maximumPairs must be a non-negative integer");
  }
  if (!maximumPairs || candidates.length < MAX_SENSITIVE_MEMBERS) return [];

  const normalized = candidates.map(normalizeSensitiveCandidate);
  const evidenceIndex = new Map<string, number[]>();
  for (const [index, candidate] of normalized.entries()) {
    for (const key of candidate.evidenceKeys) appendCandidateIndex(evidenceIndex, key, index);
  }

  const claimed = new Set<number>();
  const pairs: T[][] = [];
  for (let firstIndex = 0; firstIndex < normalized.length && pairs.length < maximumPairs; firstIndex++) {
    if (claimed.has(firstIndex)) continue;
    const first = normalized[firstIndex]!;
    const partnerIndex = earliestCompatiblePartner(firstIndex, first, normalized, evidenceIndex, claimed);
    if (partnerIndex === undefined) continue;
    claimed.add(firstIndex);
    claimed.add(partnerIndex);
    pairs.push([first.candidate, normalized[partnerIndex]!.candidate]);
  }
  return pairs;
}

function normalizeSensitiveCandidate<T extends SensitiveBatchMemberEvidence>(
  candidate: T,
): NormalizedSensitiveCandidate<T> {
  const causalFamily = normalizedEvidence(candidate.causalFamily);
  const riskCapabilities = normalizedEvidenceSet(candidate.riskCapabilities);
  const primaryDomain = normalizedEvidence(candidate.primaryDomain);
  const sharedSymbols = normalizedEvidenceSet(candidate.sharedSymbols);
  const evidenceKeys = causalFamily ? [
    ...riskCapabilities].map((value) => sensitiveEvidenceKey(causalFamily, "capability", value)) : [];
  if (causalFamily && primaryDomain) evidenceKeys.push(sensitiveEvidenceKey(causalFamily, "domain", primaryDomain));
  if (causalFamily) {
    evidenceKeys.push(...[...sharedSymbols].map((value) => sensitiveEvidenceKey(causalFamily, "symbol", value)));
  }
  return {
    candidate,
    sensitiveRisk: isSensitiveRisk(candidate.riskClass ?? "routine"),
    ...(causalFamily ? { causalFamily } : {}),
    riskCapabilities,
    ...(primaryDomain ? { primaryDomain } : {}),
    sharedSymbols,
    productionPaths: new Set(candidate.affectedFiles
      .map(normalizeAffectedPath)
      .filter((path): path is string => path !== undefined && isProductionPath(path))),
    criteria: candidate.acceptanceCriteria ?? (candidate.summary ? [candidate.summary] : []),
    evidenceKeys: [...new Set(evidenceKeys)],
  };
}

function earliestCompatiblePartner<T extends SensitiveBatchMemberEvidence>(
  firstIndex: number,
  first: NormalizedSensitiveCandidate<T>,
  candidates: readonly NormalizedSensitiveCandidate<T>[],
  evidenceIndex: ReadonlyMap<string, readonly number[]>,
  claimed: ReadonlySet<number>,
): number | undefined {
  if (!first.sensitiveRisk || !first.causalFamily || !validSensitiveCandidateBounds(first)) return undefined;
  const cursors = first.evidenceKeys.map((key) => ({ values: evidenceIndex.get(key) ?? [], offset: 0 }));
  while (true) {
    let partnerIndex: number | undefined;
    for (const cursor of cursors) {
      while (cursor.offset < cursor.values.length) {
        const value = cursor.values[cursor.offset]!;
        if (value > firstIndex && !claimed.has(value)) break;
        cursor.offset++;
      }
      const value = cursor.values[cursor.offset];
      if (value !== undefined && (partnerIndex === undefined || value < partnerIndex)) partnerIndex = value;
    }
    if (partnerIndex === undefined) return undefined;
    for (const cursor of cursors) {
      if (cursor.values[cursor.offset] === partnerIndex) cursor.offset++;
    }
    const partner = candidates[partnerIndex]!;
    if (normalizedSensitivePairPotential(first, partner)
      && isSensitiveBatchCompatible([first.candidate, partner.candidate])) return partnerIndex;
  }
}

function normalizedSensitivePairPotential<T extends SensitiveBatchMemberEvidence>(
  left: NormalizedSensitiveCandidate<T>,
  right: NormalizedSensitiveCandidate<T>,
): boolean {
  if (!right.sensitiveRisk || left.causalFamily !== right.causalFamily || !validSensitiveCandidateBounds(right)) return false;
  const productionPaths = new Set([...left.productionPaths, ...right.productionPaths]);
  const criteriaCount = left.criteria.length + right.criteria.length;
  return productionPaths.size <= MAX_SENSITIVE_PRODUCTION_PATHS
    && criteriaCount > 0
    && criteriaCount <= MAX_SENSITIVE_ATOMIC_CRITERIA;
}

function validSensitiveCandidateBounds(candidate: NormalizedSensitiveCandidate<SensitiveBatchMemberEvidence>): boolean {
  return candidate.productionPaths.size <= MAX_SENSITIVE_PRODUCTION_PATHS
    && candidate.criteria.length <= MAX_SENSITIVE_ATOMIC_CRITERIA
    && candidate.criteria.every((criterion) => criterion.trim().length > 0);
}

function normalizedEvidenceSet(values: readonly string[] | undefined): Set<string> {
  return new Set((values ?? []).map(normalizedEvidence).filter((value): value is string => value !== undefined));
}

function sensitiveEvidenceKey(causalFamily: string, kind: string, value: string): string {
  return JSON.stringify([causalFamily, kind, value]);
}

function appendCandidateIndex(index: Map<string, number[]>, key: string, candidate: number): void {
  const values = index.get(key);
  if (values) values.push(candidate);
  else index.set(key, [candidate]);
}

function hasCommonEvidence(values: readonly (readonly string[] | undefined)[]): boolean {
  if (!values.length || values.some((value) => !value?.length)) return false;
  const first = new Set(values[0]!.map(normalizedEvidence).filter((value): value is string => value !== undefined));
  return [...first].some((candidate) => values.slice(1).every((value) =>
    value!.some((entry) => normalizedEvidence(entry) === candidate)));
}

function normalizedEvidence(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized || undefined;
}

function isSensitiveRisk(risk: BatchRiskClass): boolean {
  return risk === "security" || risk === "auth";
}

function isProductionPath(path: string): boolean {
  const normalized = path.toLocaleLowerCase();
  return !/(?:^|\/)(?:__tests__|tests?|specs?|fixtures?|mocks?|docs?)(?:\/|$)/.test(normalized)
    && !/\.(?:test|spec)\.[^/]+$/.test(normalized)
    && !/(?:^|\/)(?:test|spec)_[^/]+$/.test(normalized)
    && !/\.mdx?$/.test(normalized);
}

export function chunkBatchCandidates<T>(values: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("chunk size must be a positive integer");
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) chunks.push(values.slice(offset, offset + size));
  return chunks;
}

function leafDirectory(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : undefined;
}

function escapeCode(value: string): string {
  return value.replaceAll("`", "").replace(/[\r\n]/g, " ").slice(0, 500);
}

function escapeText(value: string, limit = 4_000): string {
  return value.replace(/<!--[\s\S]*?-->/g, "").replace(/[\r\n]+/g, " ").trim().slice(0, limit);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}
