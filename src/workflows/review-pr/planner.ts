// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { DurableArtifact } from "../../core/artifacts/schema.js";

export type ReviewerRole = "correctness" | "security" | "data" | "api-compatibility" | "frontend" | "infrastructure" | "concurrency";
export type SpecialistReviewerRole = Exclude<ReviewerRole, "correctness">;
export type ReviewRiskTier = "low" | "medium" | "high" | "critical";
export type ReviewCapabilityId = "acceptance-correctness" | "security" | "data-integrity" | "api-compatibility" | "frontend" | "release" | "concurrency";

export interface ReviewCapability {
  id: ReviewCapabilityId;
  score: number;
  reasons: string[];
  scope: string[];
  required: boolean;
}

export interface ReviewSelection {
  /** Compatibility projection: this is an execution-group role, not a capability. */
  role: ReviewerRole;
  score: number;
  reasons: string[];
  scope: string[];
  required: boolean;
}

export interface ReviewExecutionGroup extends ReviewSelection {
  id: string;
  capabilities: ReviewCapabilityId[];
}

export interface ReviewSkip {
  role: SpecialistReviewerRole;
  score: number;
  reason: "below-threshold" | "panel-budget" | "overlapping-coverage" | "grouped-coverage";
  evidence: string[];
}

export interface ReviewBudget {
  maxSpecialistExecutionGroups: number;
  maxLogicalReviewerSessions: number;
  maxParallelSessions: number;
  maxAttemptsPerExecutionGroup: 2;
  maxReviewerAttempts: number;
  maxScopeAdjudicationAttempts: number;
  maxModelCalls: number;
}

export interface ReviewPlanContext {
  runId: string;
  repo: string;
  issue?: number;
  pullRequest: number;
  packetId: string;
  packetDigest: string;
  deliveryRunId: string;
  buildResultBranch: string;
  targetBranch: string;
  baseSha?: string;
}

export interface ReviewPlan {
  /** Stable canonical identity over every authority-bearing plan field. */
  planId: string;
  schemaVersion: 2;
  context: ReviewPlanContext;
  generation: number;
  frozen: true;
  riskTier: ReviewRiskTier;
  budget: ReviewBudget;
  capabilities: ReviewCapability[];
  executionGroups: ReviewExecutionGroup[];
  /** Compatibility fields retained for older ReviewVerdict readers. */
  specialistBudget: number;
  selected: ReviewSelection[];
  skipped: ReviewSkip[];
}

interface Candidate {
  role: SpecialistReviewerRole;
  score: number;
  reasons: string[];
  scope: Set<string>;
  concrete: boolean;
  policyRequired: boolean;
  overlap?: SpecialistReviewerRole;
}

interface DiffSection {
  path: string;
  text: string;
  added: string;
}

const ROLE_ORDER: ReviewerRole[] = [
  "correctness", "security", "data", "api-compatibility", "frontend", "infrastructure", "concurrency",
];
const SPECIALISTS = ROLE_ORDER.filter((role): role is SpecialistReviewerRole => role !== "correctness");
const CAPABILITY_BY_ROLE: Record<ReviewerRole, ReviewCapabilityId> = {
  correctness: "acceptance-correctness",
  security: "security",
  data: "data-integrity",
  "api-compatibility": "api-compatibility",
  frontend: "frontend",
  infrastructure: "release",
  concurrency: "concurrency",
};
const SELECTION_THRESHOLD = 60;
const DEFAULT_SPECIALIST_BUDGET = 3;
const MAX_INITIAL_REVIEW_DIFF_CHARS = 160_000;
export const DEPLOYMENT_MAX_INITIAL_REVIEW_DIFF_CHARS = 60_000;

const SECURITY = /\b(?:auth(?:entication|orization)?|capabilit(?:y|ies)|crypt(?:o|ographic|ography)|signature|trust root|permission|privilege|secret|credential|token|replay|tamper|revocation)\b/i;
const DATA = /\b(?:database|migration|sql|storage|persist(?:ed|ence|ent)?|canonical(?:ization| bytes?)?|schema registry|payload schema|encoding|portable bundle|manifest|digest format)\b/i;
const API = /\b(?:api compatibility|public api|public interface|wire protocol|backward compatibility|openapi|graphql|versioned protocol|request schema|response schema)\b/i;
const CONCURRENCY = /\b(?:concurr(?:ency|ent)?|race|lease|fencing|compare[- ]and[- ]swap|\bcas\b|atomic(?:ity|ally)?|transaction|split[- ]brain|event ordering|sequence allocator|distributed coordination|idempotenc(?:y|t))\b/i;
const INFRA_RISK = /\b(?:deployment configuration|deploy pipeline|continuous integration|ci pipeline|container image|kubernetes|terraform|github actions)\b/i;

const PATH_SECURITY = /(?:^|\/)(?:auth(?:entication|orization)?|security|crypto(?:graphy)?|permissions?|secrets?)(?:[._-][^/]*)?(?:\/|$)|(?:^|\/)(?:oauth|jwt)(?:[./_-]|$)/i;
const PATH_DATA = /(?:^|\/)(?:db|database|migrations?|storage|persistence|schemas?)(?:[._-][^/]*)?(?:\/|$)|\.(?:sql|prisma)$/i;
const PATH_API = /(?:^|\/)(?:api|routes?|openapi|graphql|protocol)(?:[._-][^/]*)?(?:\/|$)|(?:openapi|swagger)\.(?:ya?ml|json)$/i;
const PATH_FRONTEND = /(?:^|\/)(?:web\/src|frontend|client|ui\/components?)(?:\/|$)|\.(?:tsx|jsx|css|scss|sass|vue|svelte)$/i;
const PATH_INFRA = /(?:^|\/)(?:\.github\/workflows|infra|deploy|deployment|k8s|kubernetes|helm|terraform)(?:\/|$)|(?:^|\/)(?:Dockerfile[^/]*|docker-compose[^/]*\.ya?ml)$/i;
const PATH_CONCURRENCY = /(?:^|\/)(?:scheduler|leases?|locks?|queues?|concurrency)(?:\/|$)|(?:^|\/)[^/]*(?:lease|lock|atomic|transaction)[^/]*\.[^/]+$/i;

export function planReviewPanel(input: {
  changedPaths: readonly string[];
  diff: string;
  packet: DurableArtifact<"BuildPacket">;
  context?: Omit<ReviewPlanContext, "packetId" | "packetDigest">;
  repositoryPolicy?: readonly { path: string; content: string }[];
  maxSpecialists?: number;
}): ReviewPlan {
  const sections = parseDiffSections(input.diff);
  const allPaths = unique([...input.changedPaths, ...sections.map((section) => section.path)].map(normalizePath).filter(Boolean));
  const riskText = input.packet.payload.risks.flatMap((risk) => [risk.risk, risk.mitigation]).join("\n");
  const addedText = sections.map((section) => section.added).join("\n");
  const specialistBudget = clampBudget(input.maxSpecialists ?? DEFAULT_SPECIALIST_BUDGET);
  const candidates = new Map<SpecialistReviewerRole, Candidate>(SPECIALISTS.map((role) => [role, {
    role, score: 0, reasons: [], scope: new Set<string>(), concrete: false, policyRequired: false,
  }]));

  for (const candidate of candidates.values()) addRepositoryPolicyEvidence(candidate, input.repositoryPolicy ?? []);

  addPathEvidence(candidates.get("security")!, allPaths, PATH_SECURITY, 120, "security-sensitive path");
  addTextEvidence(candidates.get("security")!, riskText, SECURITY, 75, "Build Packet declares a security/trust risk");
  addSectionEvidence(candidates.get("security")!, sections, SECURITY, 35, "diff changes security/trust semantics");

  addPathEvidence(candidates.get("data")!, allPaths, PATH_DATA, 120, "database, persistence, or schema path");
  addTextEvidence(candidates.get("data")!, riskText, DATA, 65, "Build Packet declares persistence/encoding/schema risk");
  addSectionEvidence(candidates.get("data")!, sections, DATA, 35, "diff changes persisted or interoperable data semantics");

  addPathEvidence(candidates.get("api-compatibility")!, allPaths, PATH_API, 120, "public API or protocol path");
  addTextEvidence(candidates.get("api-compatibility")!, riskText, API, 65, "Build Packet declares public compatibility risk");
  addSectionEvidence(candidates.get("api-compatibility")!, sections, API, 30, "diff changes a public API/protocol contract");

  addPathEvidence(candidates.get("frontend")!, allPaths.filter((path) => !isDocumentationPath(path)), PATH_FRONTEND, 120, "product frontend path");
  addPathEvidence(candidates.get("infrastructure")!, allPaths, PATH_INFRA, 120, "deployment, CI, or infrastructure path");
  if (candidates.get("infrastructure")!.concrete) {
    addTextEvidence(candidates.get("infrastructure")!, `${riskText}\n${addedText}`, INFRA_RISK, 30, "operational deployment semantics changed");
  }
  addPathEvidence(candidates.get("concurrency")!, allPaths, PATH_CONCURRENCY, 120, "scheduler, lease, lock, or queue path");
  addTextEvidence(candidates.get("concurrency")!, riskText, CONCURRENCY, 75, "Build Packet declares concurrency/distributed-coordination risk");
  addSectionEvidence(candidates.get("concurrency")!, sections, CONCURRENCY, 35, "diff changes concurrency or coordination semantics");

  const data = candidates.get("data")!;
  const api = candidates.get("api-compatibility")!;
  if (data.score >= SELECTION_THRESHOLD && api.score >= SELECTION_THRESHOLD
    && !(data.concrete && api.concrete) && !(data.policyRequired && api.policyRequired)) {
    const loser = data.policyRequired !== api.policyRequired
      ? data.policyRequired ? api : data
      : data.score >= api.score ? api : data;
    loser.overlap = loser === api ? "data" : "api-compatibility";
  }

  const eligible = [...candidates.values()]
    .filter((candidate) => candidate.score >= SELECTION_THRESHOLD)
    .sort(compareCandidates);
  const executionCandidates = eligible.filter((candidate) => !candidate.overlap);
  const capabilities: ReviewCapability[] = [{
    id: "acceptance-correctness",
    score: 1_000,
    reasons: ["mandatory intent, acceptance, target-authority, and correctness review"],
    scope: allPaths,
    required: true,
  }, ...eligible.map((candidate) => ({
    id: CAPABILITY_BY_ROLE[candidate.role],
    score: candidate.score,
    reasons: unique(candidate.reasons),
    scope: candidate.scope.size ? [...candidate.scope].sort() : allPaths,
    required: candidate.concrete || candidate.policyRequired || candidate.role === "security",
  }))];

  const specialistGroups = buildSpecialistExecutionGroups(executionCandidates, specialistBudget, allPaths);
  for (const candidate of eligible.filter(({ overlap }) => overlap !== undefined)) {
    const target = specialistGroups.find(({ role, capabilities: covered }) => role === candidate.overlap
      || covered.includes(CAPABILITY_BY_ROLE[candidate.overlap!]));
    if (!target) throw new Error(`Overlapping review capability ${CAPABILITY_BY_ROLE[candidate.role]} has no execution group`);
    attachCapabilityToGroup(target, candidate, allPaths);
  }
  const correctnessGroup: ReviewExecutionGroup = {
    id: "review-correctness",
    role: "correctness",
    capabilities: ["acceptance-correctness"],
    score: 1_000,
    reasons: ["mandatory intent, acceptance, target-authority, and correctness review"],
    scope: allPaths,
    required: true,
  };
  const executionGroups: ReviewExecutionGroup[] = [correctnessGroup, ...specialistGroups]
    .sort((left, right) => ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role));
  const selected = executionGroups.map(({ role, score, reasons, scope, required }) => ({ role, score, reasons, scope, required }));
  const executionRoles = new Set(specialistGroups.map(({ role }) => role));
  const coveredCapabilities = new Set(specialistGroups.flatMap(({ capabilities: covered }) => covered));
  const skipped: ReviewSkip[] = SPECIALISTS.filter((role) => !executionRoles.has(role)).map((role) => {
    const candidate = candidates.get(role)!;
    const capability = CAPABILITY_BY_ROLE[role];
    return {
      role,
      score: candidate.score,
      reason: candidate.overlap ? "overlapping-coverage" as const
        : coveredCapabilities.has(capability) ? "grouped-coverage" as const
          : "below-threshold" as const,
      evidence: candidate.overlap
        ? [`covered by ${candidate.overlap}`]
        : coveredCapabilities.has(capability)
          ? [`${capability} is covered by ${specialistGroups.find((group) => group.capabilities.includes(capability))?.id}`]
          : unique(candidate.reasons),
    };
  });
  const maxLogicalReviewerSessions = executionGroups.length;
  const budget: ReviewBudget = {
    maxSpecialistExecutionGroups: specialistBudget,
    maxLogicalReviewerSessions,
    maxParallelSessions: maxLogicalReviewerSessions,
    maxAttemptsPerExecutionGroup: 2,
    maxReviewerAttempts: 2 * maxLogicalReviewerSessions,
    maxScopeAdjudicationAttempts: 2,
    maxModelCalls: 2 * maxLogicalReviewerSessions + 2,
  };
  const context: ReviewPlanContext = {
    ...(input.context ?? {
      runId: input.packet.runId,
      repo: input.packet.subject.repo,
      ...(input.packet.subject.issue !== undefined ? { issue: input.packet.subject.issue } : {}),
      pullRequest: 0,
      deliveryRunId: input.packet.runId,
      buildResultBranch: "selection-only",
      targetBranch: "selection-only",
    }),
    packetId: input.packet.id,
    packetDigest: canonicalReviewDigest(input.packet.payload),
  };
  const identity: Omit<ReviewPlan, "planId"> = {
    schemaVersion: 2,
    context,
    generation: 1,
    frozen: true,
    riskTier: riskTier(capabilities.slice(1)),
    budget,
    capabilities,
    executionGroups,
    specialistBudget,
    selected,
    skipped,
  };
  const plan: ReviewPlan = {
    planId: computeReviewPlanId(identity),
    ...identity,
  };
  return deepFreeze(plan);
}

export function canonicalReviewDigest(value: unknown): string {
  return createHash("sha256").update(canonicalReviewJson(value)).digest("hex");
}

export function computeReviewPlanId(plan: ReviewPlan | Omit<ReviewPlan, "planId">): string {
  const { planId: _planId, ...authority } = plan as ReviewPlan;
  return `review-plan-${canonicalReviewDigest(authority).slice(0, 20)}`;
}

export function freezeReviewPlan(plan: ReviewPlan): ReviewPlan {
  assertReviewPlan(plan);
  return deepFreeze(plan);
}

export function assertReviewPlan(plan: ReviewPlan): void {
  if (!plan.frozen || plan.schemaVersion !== 2 || !Number.isSafeInteger(plan.generation) || plan.generation < 1
    || !/^review-plan-[a-f0-9]{20}$/.test(plan.planId)) {
    throw new Error("Review Plan must have current immutable identity, context, generation, and frozen status");
  }
  if (!plan.context?.runId || !plan.context.repo || !Number.isSafeInteger(plan.context.pullRequest)
    || plan.context.pullRequest < 0 || !plan.context.packetId || !/^[a-f0-9]{64}$/.test(plan.context.packetDigest)
    || !plan.context.deliveryRunId || !plan.context.buildResultBranch || !plan.context.targetBranch) {
    throw new Error("Review Plan authority context is incomplete");
  }
  const budget = plan.budget as Partial<ReviewBudget> | undefined;
  const budgetValues = budget && [
    budget.maxSpecialistExecutionGroups,
    budget.maxLogicalReviewerSessions,
    budget.maxParallelSessions,
    budget.maxAttemptsPerExecutionGroup,
    budget.maxReviewerAttempts,
    budget.maxScopeAdjudicationAttempts,
    budget.maxModelCalls,
  ];
  if (!budget || !budgetValues?.every((value) => Number.isSafeInteger(value))) {
    throw new Error("Review Plan absolute budget fields must all be present safe integers");
  }
  if (!Array.isArray(plan.executionGroups) || !Array.isArray(plan.selected) || !Array.isArray(plan.capabilities)) {
    throw new Error("Review Plan execution topology is incomplete");
  }
  if (computeReviewPlanId(plan) !== plan.planId) {
    throw new Error("Review Plan canonical identity does not match its authority-bearing fields");
  }
  if (plan.executionGroups[0]?.role !== "correctness"
    || !plan.executionGroups[0].capabilities.includes("acceptance-correctness")
    || !plan.executionGroups[0].required) {
    throw new Error("Review Plan must begin with mandatory acceptance/correctness review");
  }
  const specialistGroups = plan.executionGroups.filter(({ role }) => role !== "correctness");
  if (!Number.isSafeInteger(plan.specialistBudget) || plan.specialistBudget < 1 || plan.specialistBudget > SPECIALISTS.length
    || budget.maxSpecialistExecutionGroups! < 1
    || budget.maxSpecialistExecutionGroups! > SPECIALISTS.length
    || budget.maxSpecialistExecutionGroups !== plan.specialistBudget
    || specialistGroups.length > budget.maxSpecialistExecutionGroups!
    || budget.maxLogicalReviewerSessions! < 1
    || budget.maxLogicalReviewerSessions! > SPECIALISTS.length + 1
    || plan.executionGroups.length !== budget.maxLogicalReviewerSessions
    || budget.maxParallelSessions! < 1
    || budget.maxParallelSessions! > budget.maxLogicalReviewerSessions!
    || budget.maxAttemptsPerExecutionGroup !== 2
    || budget.maxReviewerAttempts! < budget.maxLogicalReviewerSessions!
    || budget.maxReviewerAttempts! > budget.maxLogicalReviewerSessions! * budget.maxAttemptsPerExecutionGroup
    || budget.maxScopeAdjudicationAttempts! < 1
    || budget.maxScopeAdjudicationAttempts! > 2
    || budget.maxModelCalls! < budget.maxLogicalReviewerSessions!
    || budget.maxModelCalls! > budget.maxReviewerAttempts! + budget.maxScopeAdjudicationAttempts!) {
    throw new Error("Review Plan absolute budget is invalid or exceeded");
  }
  const groupIds = plan.executionGroups.map(({ id }) => id);
  const selectedRoles = plan.selected.map(({ role }) => role);
  if (new Set(groupIds).size !== groupIds.length || new Set(selectedRoles).size !== selectedRoles.length) {
    throw new Error("Review Plan contains duplicate execution-group decisions");
  }
  const requiredCapabilities = new Set(plan.capabilities.map(({ id }) => id));
  const coveredCapabilities = new Set(plan.executionGroups.flatMap(({ capabilities }) => capabilities));
  const missing = [...requiredCapabilities].filter((capability) => !coveredCapabilities.has(capability));
  if (missing.length) throw new Error(`Review Plan does not cover required capabilities: ${missing.join(", ")}`);
  if (plan.selected.length !== plan.executionGroups.length
    || plan.selected.some((selection, index) => selection.role !== plan.executionGroups[index]?.role)) {
    throw new Error("Review Plan compatibility selection diverges from execution groups");
  }
  for (const group of plan.executionGroups) {
    if (!Number.isSafeInteger(group.score) || group.score < 0 || !group.reasons.length || !group.capabilities.length) {
      throw new Error(`Review Plan execution group ${group.id} lacks scored capability evidence`);
    }
  }
}

export function scopedReviewDiff(
  plan: ReviewPlan,
  role: ReviewerRole,
  diff: string,
  options: { maxInitialDiffChars?: number } = {},
): string {
  const sections = parseDiffSections(diff);
  const maximumChars = options.maxInitialDiffChars ?? MAX_INITIAL_REVIEW_DIFF_CHARS;
  if (role === "correctness" || role === "security") return boundInitialDiff(diff, sections, maximumChars);
  const selection = plan.executionGroups.find((item) => item.role === role);
  if (!selection?.scope.length || !sections.length) return boundInitialDiff(diff, sections, maximumChars);
  const wanted = new Set(selection.scope.map(normalizePath));
  const scoped = sections.filter((section) => wanted.has(normalizePath(section.path)));
  if (!scoped.length || scoped.length === sections.length) return boundInitialDiff(diff, sections, maximumChars);
  return boundInitialDiff([
    `# Reviewer-scoped diff (${scoped.length}/${sections.length} changed files)`,
    ...scoped.map((section) => section.text),
    "# Other changed files were omitted from the initial slice; follow evidence into them with read/grep when required.",
  ].join("\n"), scoped, maximumChars);
}

function buildSpecialistExecutionGroups(
  candidates: readonly Candidate[],
  budget: number,
  allPaths: readonly string[],
): ReviewExecutionGroup[] {
  if (!candidates.length) return [];
  const groups = candidates.slice(0, budget).map((candidate): ReviewExecutionGroup => ({
    id: `review-${candidate.role}`,
    role: candidate.role,
    capabilities: [CAPABILITY_BY_ROLE[candidate.role]],
    score: candidate.score,
    reasons: unique(candidate.reasons),
    scope: candidate.scope.size ? [...candidate.scope].sort() : [...allPaths],
    required: candidate.concrete || candidate.policyRequired || candidate.role === "security",
  }));
  for (const candidate of candidates.slice(groups.length)) {
    const target = [...groups].sort((left, right) => left.capabilities.length - right.capabilities.length
      || groupAffinity(right.capabilities, CAPABILITY_BY_ROLE[candidate.role]) - groupAffinity(left.capabilities, CAPABILITY_BY_ROLE[candidate.role])
      || ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role))[0]!;
    attachCapabilityToGroup(target, candidate, allPaths);
  }
  return groups;
}

function attachCapabilityToGroup(group: ReviewExecutionGroup, candidate: Candidate, allPaths: readonly string[]): void {
  group.capabilities = unique([...group.capabilities, CAPABILITY_BY_ROLE[candidate.role]]);
  group.score = Math.max(group.score, candidate.score);
  group.reasons = unique([...group.reasons, ...candidate.reasons]);
  group.scope = unique([...group.scope, ...(candidate.scope.size ? [...candidate.scope] : allPaths)]).sort();
  group.required ||= candidate.concrete || candidate.policyRequired || candidate.role === "security";
}

function groupAffinity(existing: readonly ReviewCapabilityId[], incoming: ReviewCapabilityId): number {
  const compatibility: ReadonlyArray<ReadonlySet<ReviewCapabilityId>> = [
    new Set(["data-integrity", "api-compatibility", "concurrency"]),
    new Set(["security", "release"]),
    new Set(["frontend", "api-compatibility"]),
  ];
  return compatibility.some((set) => set.has(incoming) && existing.some((capability) => set.has(capability))) ? 1 : 0;
}

function boundInitialDiff(diff: string, sections: readonly DiffSection[], maximumChars: number): string {
  if (diff.length <= maximumChars) return diff;
  if (!sections.length) return `${diff.slice(0, maximumChars - 160)}\n\n# Initial diff truncated; inspect the frozen workspace with read/grep for complete evidence.`;
  const overhead = Math.min(8_000, Math.floor(maximumChars / 4));
  const perSection = Math.max(24, Math.floor((maximumChars - overhead) / sections.length));
  const chunks = sections.map((section) => {
    if (section.text.length <= perSection) return section.text;
    const marker = `\n# … ${section.path} truncated; read frozen file.`;
    return `${section.text.slice(0, Math.max(0, perSection - marker.length))}${marker}`.slice(0, perSection);
  });
  const note = "# Initial diff was size-bounded across all changed files; inspect the frozen workspace with read/grep before concluding on omitted hunks.";
  const result = [...chunks, note].join("\n");
  return result.length <= maximumChars ? result : `${result.slice(0, maximumChars - note.length - 2)}\n${note}`;
}

export function parseDiffPaths(diff: string): string[] {
  return parseDiffSections(diff).map((section) => section.path);
}

function parseDiffSections(diff: string): DiffSection[] {
  const starts = [...diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  return starts.map((match, index) => {
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? diff.length;
    const text = diff.slice(start, end).trimEnd();
    const path = normalizePath(match[2] ?? match[1] ?? "");
    const added = text.split(/\r?\n/).filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)).join("\n");
    return { path, text, added };
  }).filter((section) => section.path);
}

function addRepositoryPolicyEvidence(candidate: Candidate, policies: readonly { path: string; content: string }[]): void {
  const rolePattern: Record<SpecialistReviewerRole, string> = {
    security: "security|trust|threat", data: "data|database|persistence|storage|schema",
    "api-compatibility": "api(?:[- ]compatibility)?|protocol|backward[- ]compatibility",
    frontend: "frontend|user[- ]interface|ui|accessibility", infrastructure: "infrastructure|deployment|devops|ci(?:\\/cd)?",
    concurrency: "concurrency|distributed[- ]systems?|race|lease",
  };
  const specialty = rolePattern[candidate.role];
  const mandate = new RegExp(`(?:\\b(?:must|required|mandatory|always)\\b[^\\r\\n.]{0,100}\\b(?:${specialty})\\b[^\\r\\n.]{0,40}\\breview(?:er)?\\b|\\b(?:${specialty})\\b[^\\r\\n.]{0,40}\\breview(?:er)?\\b[^\\r\\n.]{0,100}\\b(?:must|required|mandatory|always)\\b)`, "i");
  const matches = policies.filter((policy) => mandate.test(policy.content));
  if (!matches.length) return;
  candidate.score += 90;
  candidate.policyRequired = true;
  candidate.reasons.push(`repository policy requires ${candidate.role} review: ${matches.map((policy) => policy.path).join(", ")}`);
}

function addPathEvidence(candidate: Candidate, paths: readonly string[], pattern: RegExp, score: number, reason: string): void {
  const matches = paths.filter((path) => pattern.test(path));
  if (!matches.length) return;
  candidate.score += score;
  candidate.concrete = true;
  candidate.reasons.push(`${reason}: ${matches.join(", ")}`);
  for (const path of matches) candidate.scope.add(path);
}
function addTextEvidence(candidate: Candidate, text: string, pattern: RegExp, score: number, reason: string): void {
  if (!pattern.test(text)) return;
  candidate.score += score;
  candidate.reasons.push(reason);
}
function addSectionEvidence(candidate: Candidate, sections: readonly DiffSection[], pattern: RegExp, score: number, reason: string): void {
  const matches = sections.filter((section) => pattern.test(section.added));
  if (!matches.length) return;
  candidate.score += score;
  candidate.reasons.push(`${reason}: ${matches.map((section) => section.path).join(", ")}`);
  for (const section of matches) candidate.scope.add(section.path);
}
function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.policyRequired !== right.policyRequired) return left.policyRequired ? -1 : 1;
  if (left.concrete !== right.concrete) return left.concrete ? -1 : 1;
  return right.score - left.score || ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role);
}
function riskTier(capabilities: readonly ReviewCapability[]): ReviewRiskTier {
  if (capabilities.some((capability) => capability.id === "security" && capability.score >= 150)
    || capabilities.filter((capability) => capability.required).length >= 3) return "critical";
  if (capabilities.length >= 2 || capabilities.some((capability) => capability.score >= 120)) return "high";
  if (capabilities.length === 1) return "medium";
  return "low";
}
function clampBudget(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SPECIALIST_BUDGET;
  return Math.max(1, Math.min(SPECIALISTS.length, Math.floor(value)));
}
function isDocumentationPath(path: string): boolean {
  return /(?:^|\/)(?:docs?|documentation)(?:\/|$)|(?:^|\/)README(?:\.|$)/i.test(path);
}
function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}
function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
function canonicalReviewJson(value: unknown): string {
  const normalizeValue = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalizeValue);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeValue(child)]));
    }
    return item;
  };
  return JSON.stringify(normalizeValue(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
