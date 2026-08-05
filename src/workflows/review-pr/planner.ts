// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";

export type ReviewerRole = "correctness" | "security" | "data" | "api-compatibility" | "frontend" | "infrastructure" | "concurrency";
export type SpecialistReviewerRole = Exclude<ReviewerRole, "correctness">;
export type ReviewRiskTier = "low" | "medium" | "high" | "critical";

export interface ReviewSelection {
  role: ReviewerRole;
  score: number;
  reasons: string[];
  scope: string[];
  required: boolean;
}

export interface ReviewSkip {
  role: SpecialistReviewerRole;
  score: number;
  reason: "below-threshold" | "panel-budget" | "overlapping-coverage";
  evidence: string[];
}

export interface ReviewPlan {
  riskTier: ReviewRiskTier;
  specialistBudget: number;
  selected: ReviewSelection[];
  skipped: ReviewSkip[];
}

export interface ReviewEscalationReport {
  role: ReviewerRole;
  findings: readonly {
    id: string;
    severity: "critical" | "high" | "medium" | "low";
    confidence: "high" | "medium" | "low";
    title: string;
    evidence: string;
    location?: string;
    remediation: string;
  }[];
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
const SELECTION_THRESHOLD = 60;
const DEFAULT_SPECIALIST_BUDGET = 3;
const MAX_INITIAL_REVIEW_DIFF_CHARS = 160_000;

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
  repositoryPolicy?: readonly { path: string; content: string }[];
  maxSpecialists?: number;
}): ReviewPlan {
  const sections = parseDiffSections(input.diff);
  const allPaths = unique([...input.changedPaths, ...sections.map((section) => section.path)].map(normalizePath).filter(Boolean));
  const riskText = input.packet.payload.risks.flatMap((risk) => [risk.risk, risk.mitigation]).join("\n");
  const addedText = sections.map((section) => section.added).join("\n");
  const budget = clampBudget(input.maxSpecialists ?? DEFAULT_SPECIALIST_BUDGET);
  const candidates = new Map<SpecialistReviewerRole, Candidate>(SPECIALISTS.map((role) => [role, {
    role, score: 0, reasons: [], scope: new Set<string>(), concrete: false, policyRequired: false,
  }]));

  for (const candidate of candidates.values()) {
    addRepositoryPolicyEvidence(candidate, input.repositoryPolicy ?? []);
  }

  addPathEvidence(candidates.get("security")!, allPaths, PATH_SECURITY, 120, "security-sensitive path");
  addTextEvidence(candidates.get("security")!, riskText, SECURITY, 75, "Build Packet declares a security/trust risk");
  addSectionEvidence(candidates.get("security")!, sections, SECURITY, 35, "diff changes security/trust semantics");

  addPathEvidence(candidates.get("data")!, allPaths, PATH_DATA, 120, "database, persistence, or schema path");
  addTextEvidence(candidates.get("data")!, riskText, DATA, 65, "Build Packet declares persistence/encoding/schema risk");
  addSectionEvidence(candidates.get("data")!, sections, DATA, 35, "diff changes persisted or interoperable data semantics");

  addPathEvidence(candidates.get("api-compatibility")!, allPaths, PATH_API, 120, "public API or protocol path");
  addTextEvidence(candidates.get("api-compatibility")!, riskText, API, 65, "Build Packet declares public compatibility risk");
  addSectionEvidence(candidates.get("api-compatibility")!, sections, API, 30, "diff changes a public API/protocol contract");

  // Frontend review requires an actual product UI surface. Documentation HTML is
  // intentionally excluded; prose mentioning accessibility or CSS is insufficient.
  addPathEvidence(candidates.get("frontend")!, allPaths.filter((path) => !isDocumentationPath(path)), PATH_FRONTEND, 120, "product frontend path");

  // Infrastructure review requires a concrete operational surface. The word
  // "workflow" is ubiquitous in ForgeDock's domain and is never a signal by itself.
  addPathEvidence(candidates.get("infrastructure")!, allPaths, PATH_INFRA, 120, "deployment, CI, or infrastructure path");
  if (candidates.get("infrastructure")!.concrete) {
    addTextEvidence(candidates.get("infrastructure")!, `${riskText}\n${addedText}`, INFRA_RISK, 30, "operational deployment semantics changed");
  }

  addPathEvidence(candidates.get("concurrency")!, allPaths, PATH_CONCURRENCY, 120, "scheduler, lease, lock, or queue path");
  addTextEvidence(candidates.get("concurrency")!, riskText, CONCURRENCY, 75, "Build Packet declares concurrency/distributed-coordination risk");
  addSectionEvidence(candidates.get("concurrency")!, sections, CONCURRENCY, 35, "diff changes concurrency or coordination semantics");

  // Data-format and API-compatibility specialists overlap heavily when only
  // prose/protocol semantics are present. Keep both only when concrete changed
  // paths independently justify both surfaces.
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
    .filter((candidate) => candidate.score >= SELECTION_THRESHOLD && !candidate.overlap)
    .sort(compareCandidates);
  const required = eligible.filter((candidate) => candidate.concrete || candidate.policyRequired || candidate.role === "security");
  const selectedRoles = new Set<SpecialistReviewerRole>(required.map((candidate) => candidate.role));
  for (const candidate of eligible) {
    if (selectedRoles.has(candidate.role)) continue;
    if (selectedRoles.size >= Math.max(budget, required.length)) continue;
    selectedRoles.add(candidate.role);
  }

  const selected: ReviewSelection[] = [{
    role: "correctness",
    score: 1_000,
    reasons: ["mandatory intent/correctness review"],
    scope: allPaths,
    required: true,
  }];
  for (const role of ROLE_ORDER) {
    if (role === "correctness" || !selectedRoles.has(role)) continue;
    const candidate = candidates.get(role)!;
    selected.push({
      role,
      score: candidate.score,
      reasons: unique(candidate.reasons),
      scope: candidate.scope.size ? [...candidate.scope].sort() : allPaths,
      required: candidate.concrete || candidate.policyRequired || role === "security",
    });
  }

  const skipped: ReviewSkip[] = SPECIALISTS.filter((role) => !selectedRoles.has(role)).map((role) => {
    const candidate = candidates.get(role)!;
    return {
      role,
      score: candidate.score,
      reason: candidate.overlap ? "overlapping-coverage" as const
        : candidate.score < SELECTION_THRESHOLD ? "below-threshold" as const
          : "panel-budget" as const,
      evidence: candidate.overlap
        ? [`covered by ${candidate.overlap}`]
        : unique(candidate.reasons),
    };
  });

  return {
    riskTier: riskTier(selected.slice(1)),
    specialistBudget: budget,
    selected,
    skipped,
  };
}

export function escalateReviewPlan(plan: ReviewPlan, reports: readonly ReviewEscalationReport[]): ReviewPlan {
  const alreadySelected = new Set(plan.selected.map(({ role }) => role));
  const assignments = new Map<SpecialistReviewerRole, Array<{ reportRole: ReviewerRole; finding: ReviewEscalationReport["findings"][number]; score: number }>>();
  for (const report of reports) {
    for (const finding of report.findings) {
      if (finding.severity === "low" || finding.confidence === "low") continue;
      // One source finding can justify one adaptive specialist. This prevents a
      // single cross-domain phrase from creating a second fixed fanout; distinct
      // findings can still exceed the soft budget independently.
      const candidates = SPECIALISTS
        .filter((role) => !alreadySelected.has(role))
        .map((role) => ({ role, score: findingRoleScore(role, finding) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role));
      const winner = candidates[0];
      if (!winner) continue;
      assignments.set(winner.role, [...(assignments.get(winner.role) ?? []), { reportRole: report.role, finding, score: winner.score }]);
    }
  }
  const additions: ReviewSelection[] = [];
  for (const role of SPECIALISTS) {
    const matches = assignments.get(role) ?? [];
    if (!matches.length) continue;
    const scope = unique(matches.map(({ finding }) => findingLocationPath(finding.location)).filter((path): path is string => Boolean(path)));
    additions.push({
      role,
      score: Math.max(...matches.map(({ score }) => score)),
      reasons: unique(matches.map(({ reportRole, finding }) => `adaptive escalation from ${reportRole} finding ${finding.id}`)),
      scope: scope.length ? scope : plan.selected[0]?.scope ?? [],
      required: true,
    });
  }
  if (!additions.length) return plan;
  const addedRoles = new Set(additions.map(({ role }) => role));
  const selected = [...plan.selected, ...additions]
    .sort((left, right) => ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role));
  return {
    ...plan,
    riskTier: riskTier(selected.slice(1)),
    selected,
    skipped: plan.skipped.filter(({ role }) => !addedRoles.has(role)),
  };
}

export function assertReviewPlan(plan: ReviewPlan): void {
  if (plan.selected[0]?.role !== "correctness" || !plan.selected[0].required) {
    throw new Error("Review Plan must begin with mandatory correctness review");
  }
  if (!Number.isInteger(plan.specialistBudget) || plan.specialistBudget < 1 || plan.specialistBudget > SPECIALISTS.length) {
    throw new Error("Review Plan specialist budget is invalid");
  }
  const selectedRoles = plan.selected.map(({ role }) => role);
  const skippedRoles = plan.skipped.map(({ role }) => role);
  if (new Set(selectedRoles).size !== selectedRoles.length || new Set(skippedRoles).size !== skippedRoles.length) {
    throw new Error("Review Plan contains duplicate role decisions");
  }
  if (selectedRoles.slice(1).some((role) => skippedRoles.includes(role as SpecialistReviewerRole))) {
    throw new Error("Review Plan both selected and skipped a specialist");
  }
  const accounted = new Set([...selectedRoles.slice(1), ...skippedRoles]);
  if (SPECIALISTS.some((role) => !accounted.has(role)) || accounted.size !== SPECIALISTS.length) {
    throw new Error("Review Plan must account for every specialist role");
  }
  for (const selection of plan.selected) {
    if (!Number.isFinite(selection.score) || selection.score < 0 || !selection.reasons.length) {
      throw new Error(`Review Plan selection ${selection.role} lacks scored evidence`);
    }
  }
}

export function scopedReviewDiff(plan: ReviewPlan, role: ReviewerRole, diff: string): string {
  const sections = parseDiffSections(diff);
  if (role === "correctness" || role === "security") return boundInitialDiff(diff, sections);
  const selection = plan.selected.find((item) => item.role === role);
  if (!selection?.scope.length || !sections.length) return boundInitialDiff(diff, sections);
  const wanted = new Set(selection.scope.map(normalizePath));
  const scoped = sections.filter((section) => wanted.has(normalizePath(section.path)));
  if (!scoped.length || scoped.length === sections.length) return boundInitialDiff(diff, sections);
  return boundInitialDiff([
    `# Reviewer-scoped diff (${scoped.length}/${sections.length} changed files)`,
    ...scoped.map((section) => section.text),
    "# Other changed files were omitted from the initial slice; follow evidence into them with read/grep when required.",
  ].join("\n"), scoped);
}

function boundInitialDiff(diff: string, sections: readonly DiffSection[]): string {
  if (diff.length <= MAX_INITIAL_REVIEW_DIFF_CHARS) return diff;
  if (!sections.length) {
    return `${diff.slice(0, MAX_INITIAL_REVIEW_DIFF_CHARS - 160)}\n\n# Initial diff truncated; inspect the frozen workspace with read/grep for complete evidence.`;
  }
  const overhead = 8_000;
  const perSection = Math.max(24, Math.floor((MAX_INITIAL_REVIEW_DIFF_CHARS - overhead) / sections.length));
  const chunks = sections.map((section) => {
    if (section.text.length <= perSection) return section.text;
    const marker = `\n# … ${section.path} truncated; read frozen file.`;
    const prefixLength = Math.max(0, perSection - marker.length);
    return `${section.text.slice(0, prefixLength)}${marker}`.slice(0, perSection);
  });
  const note = "# Initial diff was size-bounded across all changed files; inspect the frozen workspace with read/grep before concluding on omitted hunks.";
  const result = [...chunks, note].join("\n");
  return result.length <= MAX_INITIAL_REVIEW_DIFF_CHARS
    ? result
    : `${result.slice(0, MAX_INITIAL_REVIEW_DIFF_CHARS - note.length - 2)}\n${note}`;
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
    const added = text.split(/\r?\n/)
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
    return { path, text, added };
  }).filter((section) => section.path);
}

function findingRoleScore(role: SpecialistReviewerRole, finding: ReviewEscalationReport["findings"][number]): number {
  const path = findingLocationPath(finding.location) ?? "";
  const text = `${finding.title}\n${finding.evidence}\n${finding.remediation}`;
  if (role === "security") return PATH_SECURITY.test(path) ? 190 : SECURITY.test(text) ? 170 : 0;
  if (role === "data") return PATH_DATA.test(path) ? 190 : DATA.test(text) ? 150 : 0;
  if (role === "api-compatibility") return PATH_API.test(path) ? 190 : API.test(text) ? 150 : 0;
  if (role === "frontend") return PATH_FRONTEND.test(path) && !isDocumentationPath(path) ? 190 : 0;
  if (role === "infrastructure") return PATH_INFRA.test(path) ? 190 : 0;
  return PATH_CONCURRENCY.test(path) ? 190 : CONCURRENCY.test(text) ? 170 : 0;
}

function findingLocationPath(location: string | undefined): string | undefined {
  if (!location) return undefined;
  const normalized = normalizePath(location).replace(/:(?:\d+)(?::\d+)?$/, "");
  if (!normalized || /^(?:n\/?a|none|unknown)$/i.test(normalized) || !/[./]/.test(normalized)) return undefined;
  return normalized;
}

function addRepositoryPolicyEvidence(candidate: Candidate, policies: readonly { path: string; content: string }[]): void {
  const rolePattern: Record<SpecialistReviewerRole, string> = {
    security: "security|trust|threat",
    data: "data|database|persistence|storage|schema",
    "api-compatibility": "api(?:[- ]compatibility)?|protocol|backward[- ]compatibility",
    frontend: "frontend|user[- ]interface|ui|accessibility",
    infrastructure: "infrastructure|deployment|devops|ci(?:\/cd)?",
    concurrency: "concurrency|distributed[- ]systems?|race|lease",
  };
  const specialty = rolePattern[candidate.role];
  const mandate = new RegExp(
    `(?:\\b(?:must|required|mandatory|always)\\b[^\\r\\n.]{0,100}\\b(?:${specialty})\\b[^\\r\\n.]{0,40}\\breview(?:er)?\\b|\\b(?:${specialty})\\b[^\\r\\n.]{0,40}\\breview(?:er)?\\b[^\\r\\n.]{0,100}\\b(?:must|required|mandatory|always)\\b)`,
    "i",
  );
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
  if (left.concrete !== right.concrete) return left.concrete ? -1 : 1;
  return right.score - left.score || ROLE_ORDER.indexOf(left.role) - ROLE_ORDER.indexOf(right.role);
}

function riskTier(specialists: readonly ReviewSelection[]): ReviewRiskTier {
  if (specialists.some((selection) => selection.role === "security" && selection.score >= 150)
    || specialists.filter((selection) => selection.required).length >= 3) return "critical";
  if (specialists.length >= 2 || specialists.some((selection) => selection.score >= 120)) return "high";
  if (specialists.length === 1) return "medium";
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
