// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { ReviewerRole, ReviewerSubmission } from "./review.js";

export type Finding = ReviewerSubmission["findings"][number];

export type ConsolidatedFinding = Finding & {
  sourceFindingIds: string[];
  sourceSessionRefs?: string[];
  reviewerRoles: ReviewerRole[];
  normalizedRoot: string;
};

export interface FindingPolicyContext {
  reviewedPaths: readonly string[];
  expectedPaths: readonly string[];
  /** Exact controller-observed authority references that may anchor a locationless finding. */
  verifiedAuthorityReferences?: readonly string[];
  /** Exact controller-observed deterministic check references. */
  verifiedCheckReferences?: readonly string[];
}

interface SourceFinding {
  role: ReviewerRole;
  executionGroupId?: string;
  scope?: readonly string[];
  sessionRefs: readonly string[];
  finding: Finding;
}
interface FindingCluster { sources: SourceFinding[] }

const SEVERITY = { low: 0, medium: 1, high: 2, critical: 3 } as const;
const CONFIDENCE = { low: 0, medium: 1, high: 2 } as const;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "does", "for", "from", "has", "have", "in", "is",
  "it", "its", "no", "not", "of", "on", "or", "the", "their", "to", "without", "with", "require", "requires",
  "finding", "issue", "problem", "fails", "failure", "missing", "incorrect", "broken",
]);

/** Normalize/deduplicate proposals by causal root before any blocking or scope policy. */
export function consolidateReviewerFindings(
  results: readonly { role: ReviewerRole; executionGroupId?: string; scope?: readonly string[]; output: ReviewerSubmission; sessionRef?: string; sessionLineage?: readonly string[] }[],
  blockingSeverities: ReadonlySet<Finding["severity"]>,
  policy: FindingPolicyContext = { reviewedPaths: [], expectedPaths: [] },
): ConsolidatedFinding[] {
  const clusters: FindingCluster[] = [];
  for (const result of results) {
    for (const finding of result.output.findings) {
      const source: SourceFinding = {
        role: result.role,
        ...(result.executionGroupId !== undefined ? { executionGroupId: result.executionGroupId } : {}),
        ...(result.scope !== undefined ? { scope: result.scope } : {}),
        sessionRefs: result.sessionLineage ?? (result.sessionRef ? [result.sessionRef] : []),
        finding,
      };
      const cluster = clusters.find((candidate) => candidate.sources.some((existing) => duplicateFinding(existing.finding, source.finding)));
      if (cluster) cluster.sources.push(source);
      else clusters.push({ sources: [source] });
    }
  }
  return clusters.map((cluster) => consolidateCluster(cluster, blockingSeverities, policy))
    .sort((left, right) => SEVERITY[right.severity] - SEVERITY[left.severity]
      || (left.location ?? "").localeCompare(right.location ?? "")
      || left.title.localeCompare(right.title));
}

/** Central policy: reviewer blocking booleans and severity alone are never authoritative. */
export function evaluateFindingBlockingPolicy(
  finding: Pick<ConsolidatedFinding, "severity" | "confidence" | "location" | "evidenceAnchor" | "reviewerRoles" | "scopeDisposition">,
  blockingSeverities: ReadonlySet<Finding["severity"]>,
  policy: FindingPolicyContext,
): boolean {
  if (!blockingSeverities.has(finding.severity) || finding.severity === "low" || finding.confidence !== "high") return false;
  if (finding.scopeDisposition === "rejected" || finding.scopeDisposition === "follow_up") return false;
  const anchor = validatedAnchor(finding, policy);
  if (!anchor) return false;
  if (finding.severity === "critical" || finding.severity === "high") return true;
  return finding.severity === "medium"
    && (finding.reviewerRoles.length >= 2 || anchor === "deterministic-check");
}

function duplicateFinding(left: Finding, right: Finding): boolean {
  if (exactIdentity(left) === exactIdentity(right)) return true;
  const leftBoundary = authorityBoundary(left);
  const rightBoundary = authorityBoundary(right);
  if (leftBoundary && rightBoundary && leftBoundary !== rightBoundary) return false;
  const leftCriteria = new Set(left.matchedAcceptanceCriteria.map(normalize));
  const rightCriteria = new Set(right.matchedAcceptanceCriteria.map(normalize));
  if (leftCriteria.size && rightCriteria.size && intersection(leftCriteria, rightCriteria).length === 0) return false;
  const explicitLeft = normalize(left.causalRoot ?? "");
  const explicitRight = normalize(right.causalRoot ?? "");
  if (explicitLeft && explicitRight) {
    if (explicitLeft === explicitRight) return true;
    // Reviewers often describe the same concrete failure mode with different
    // causalRoot prose. Permit that paraphrase only when the frozen criterion,
    // repository surface, and at least two domain tags agree; otherwise keep
    // distinct roots separate even when their titles share broad vocabulary.
    const sameCriterion = leftCriteria.size > 0 && intersection(leftCriteria, rightCriteria).length > 0;
    const sameSurface = findingPaths(left).some((leftPath) => findingPaths(right)
      .some((rightPath) => pathMatches(leftPath, rightPath) || pathMatches(rightPath, leftPath)));
    const leftTags = conceptTags(left);
    const rightTags = conceptTags(right);
    const sharedTags = intersection(leftTags, rightTags);
    const rootSimilarity = overlapCoefficient(failureModeTokens(explicitLeft), failureModeTokens(explicitRight));
    const titleSimilarity = overlapCoefficient(failureModeTokens(left.title), failureModeTokens(right.title));
    const evidenceSimilarity = overlapCoefficient(failureModeTokens(left.evidence), failureModeTokens(right.evidence));
    if (sameCriterion && sameSurface && sharedTags.length >= 1
      && rootSimilarity >= 0.45 && titleSimilarity >= 0.2 && evidenceSimilarity >= 0.2) return true;
    return false;
  }

  const leftTags = conceptTags(left);
  const rightTags = conceptTags(right);
  const sharedTags = intersection(leftTags, rightTags);
  const titleSimilarity = overlapCoefficient(failureModeTokens(left.title), failureModeTokens(right.title));
  const evidenceSimilarity = overlapCoefficient(
    failureModeTokens(left.evidence),
    failureModeTokens(right.evidence),
  );
  if (sharedTags.length >= 2) return true;
  if (sharedTags.length === 1 && titleSimilarity >= 0.4 && evidenceSimilarity >= 0.35) return true;
  return titleSimilarity >= 0.78 && evidenceSimilarity >= 0.5;
}

function consolidateCluster(
  cluster: FindingCluster,
  blockingSeverities: ReadonlySet<Finding["severity"]>,
  policy: FindingPolicyContext,
): ConsolidatedFinding {
  const ranked = [...cluster.sources].sort(compareSourceStrength);
  const qualifying = ranked.filter((source) => sourceAttestationQualifies(source, blockingSeverities, policy));
  const representative = qualifying[0] ?? ranked[0]!;
  // Every authority-bearing provenance field comes from one coherent strongest
  // attestation. Other independently qualifying sources may corroborate prose
  // and blocking confidence, but may not donate anchors, criteria, prior IDs,
  // or remediation-introduction claims to the representative.
  const attestations = qualifying.length ? qualifying : [representative];
  const severity = representative.finding.severity;
  const confidence = representative.finding.confidence;
  const attestationSet = new Set(attestations);
  const orderedAttestations = cluster.sources.filter((source) => attestationSet.has(source));
  const reviewerRoles = unique(orderedAttestations.map((source) => source.role));
  const sourceFindingIds = unique(orderedAttestations.map((source) => source.executionGroupId?.includes("-part-")
    ? `${source.role}:${source.executionGroupId}:${source.finding.id}`
    : `${source.role}:${source.finding.id}`));
  const sourceSessionRefs = unique(orderedAttestations.flatMap((source) => source.sessionRefs));
  const matchedAcceptanceCriteria = unique(representative.finding.matchedAcceptanceCriteria);
  const matchedPriorFindingIds = unique(representative.finding.matchedPriorFindingIds);
  const scopeDisposition = representative.finding.scopeDisposition;
  const normalizedRoot = normalizedCausalRoot(representative.finding, matchedAcceptanceCriteria);
  const result: ConsolidatedFinding = {
    ...representative.finding,
    id: `review-${createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 16)}`,
    normalizedRoot,
    severity,
    confidence,
    blocking: false,
    mustFix: qualifying.length > 0 && scopeDisposition === "in_scope",
    evidence: combineSourceText(attestations, (source) => source.finding.evidence, 12_000),
    intentRelevance: combineSourceText(attestations, (source) => source.finding.intentRelevance, 8_000),
    remediation: combineSourceText(attestations, (source) => source.finding.remediation, 8_000),
    scopeDisposition,
    scopeRationale: combineSourceText(attestations, (source) => source.finding.scopeRationale, 8_000),
    matchedAcceptanceCriteria,
    matchedPriorFindingIds,
    introducedByRemediation: representative.finding.introducedByRemediation,
    sourceFindingIds,
    ...(sourceSessionRefs.length ? { sourceSessionRefs } : {}),
    reviewerRoles,
  };
  result.blocking = qualifying.length > 0 && evaluateFindingBlockingPolicy(result, blockingSeverities, policy);
  return result;
}

function compareSourceStrength(left: SourceFinding, right: SourceFinding): number {
  return SEVERITY[right.finding.severity] - SEVERITY[left.finding.severity]
    || CONFIDENCE[right.finding.confidence] - CONFIDENCE[left.finding.confidence]
    || left.role.localeCompare(right.role)
    || left.finding.id.localeCompare(right.finding.id);
}

function sourceAttestationQualifies(
  source: SourceFinding,
  blockingSeverities: ReadonlySet<Finding["severity"]>,
  policy: FindingPolicyContext,
): boolean {
  const finding = source.finding;
  const scopedPolicy = source.scope
    ? { ...policy, reviewedPaths: source.scope, expectedPaths: source.scope }
    : policy;
  return Boolean(finding.causalRoot?.trim())
    && finding.scopeDisposition === "in_scope"
    && finding.confidence === "high"
    && finding.severity !== "low"
    && blockingSeverities.has(finding.severity)
    && validatedAnchor(finding, scopedPolicy) !== undefined;
}

function validatedAnchor(
  finding: Pick<ConsolidatedFinding, "location" | "evidenceAnchor">,
  policy: FindingPolicyContext,
): NonNullable<Finding["evidenceAnchor"]>["kind"] | undefined {
  const allowed = unique([...policy.reviewedPaths, ...policy.expectedPaths].map(normalizeRepoPath));
  const locationPath = repositoryPath(finding.location);
  if (locationPath && allowed.some((path) => pathMatches(locationPath, path))) return "repository-location";
  const anchor = finding.evidenceAnchor;
  if (!anchor) return undefined;
  if (anchor.kind === "repository-location") {
    const referencePath = repositoryPath(anchor.reference);
    return referencePath && allowed.some((path) => pathMatches(referencePath, path)) ? anchor.kind : undefined;
  }
  if (anchor.kind === "delivery-authority") {
    return policy.verifiedAuthorityReferences?.includes(anchor.reference) ? anchor.kind : undefined;
  }
  return policy.verifiedCheckReferences?.includes(anchor.reference) ? anchor.kind : undefined;
}

function normalizedCausalRoot(finding: Finding, criteria: readonly string[]): string {
  const boundary = authorityBoundary(finding) || "unanchored";
  const inferredConcept = [
    ...conceptTags(finding),
    ...[...failureModeTokens(`${finding.title}\n${finding.evidence}`)].sort().slice(0, 12),
  ].sort().join(" ");
  const concept = normalize(finding.causalRoot ?? inferredConcept);
  return [criteria.map(normalize).sort().join("|"), boundary, concept].join("\n");
}
function authorityBoundary(finding: Finding): string {
  return findingPaths(finding).sort()[0]
    ?? (finding.evidenceAnchor ? `${finding.evidenceAnchor.kind}:${normalize(finding.evidenceAnchor.reference)}` : "");
}

function combineSourceText(sources: readonly SourceFinding[], select: (source: SourceFinding) => string, maximum: number): string {
  const uniqueText = new Map<string, { role: ReviewerRole; id: string; text: string }>();
  for (const source of sources) {
    const text = select(source).trim();
    const key = normalize(text);
    if (!uniqueText.has(key)) uniqueText.set(key, { role: source.role, id: source.finding.id, text });
  }
  const combined = [...uniqueText.values()].map(({ role, id, text }) => sources.length === 1 ? text : `[${role}:${id}] ${text}`).join("\n\n");
  return combined.length <= maximum ? combined : `${combined.slice(0, maximum - 1)}…`;
}
function conceptTags(finding: Finding): Set<string> {
  const text = `${finding.title}\n${finding.causalRoot ?? ""}\n${finding.evidence}\n${finding.location ?? ""}`.toLowerCase();
  const tags = new Set<string>();
  const add = (tag: string, pattern: RegExp) => { if (pattern.test(text)) tags.add(tag); };
  add("capability", /capabilit(?:y|ies)|delegat(?:ion|ed)/);
  add("authenticity", /authenticat|signature|signed|integrity|cryptograph|trust root/);
  add("reviewed-sha", /reviewed.?sha|source.?sha|head sha|sha binding|non-sha|revision binding|gitlink/);
  add("idempotency", /idempoten|operation id|request id|reus(?:e|able).*id/);
  add("admission", /admission|claim|materiali[sz]ation|duplicate issue|duplicate child/);
  add("host-discovery", /host (?:capability )?discovery|adapter discovery|discovery proof/);
  add("freshness", /freshness|stale|replay|epoch|challenge/);
  add("artifact-registry", /artifact registry|protected registry|payload schema|artifact kind/);
  add("schema", /schema|closed profile|field registry|payload type/);
  add("event", /event envelope|event profile|event type|event ordering|sequence allocator/);
  add("bundle", /portable bundle|bundle profile|zip|manifest|offline verification/);
  add("determinism", /determin|canonical|member ordering|encoding/);
  add("lease-fencing", /lease|fencing|split-brain|heartbeat/);
  add("atomicity", /atomic|compare-and-swap|\bcas\b|transaction|outbox/);
  add("secret-handling", /secret|credential|private key|sensitive payload/);
  add("build-evidence", /buildresult|build result|changedpaths|verification evidence/);
  return tags;
}
function findingPaths(finding: Finding): string[] {
  return unique([repositoryPath(finding.location), repositoryPath(finding.evidenceAnchor?.kind === "repository-location" ? finding.evidenceAnchor.reference : undefined)]
    .filter((path): path is string => Boolean(path)));
}
function repositoryPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replaceAll("\\", "/").trim();
  const match = /(?:^|[\s`(])(\.?[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+|\.?[A-Za-z0-9_.@+-]+\.[A-Za-z0-9_.@+-]+)(?=[:#\s`),]|$)/.exec(normalized);
  return match?.[1] ? normalizeRepoPath(match[1]) : undefined;
}
function normalizeRepoPath(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "").toLowerCase(); }
function pathMatches(path: string, expected: string): boolean {
  return expected.endsWith("/**") ? path.startsWith(expected.slice(0, -3)) : path === expected || path.startsWith(`${expected}/`);
}
function failureModeTokens(value: string): Set<string> {
  return new Set(normalize(value).split(" ").filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
}
function exactIdentity(finding: Finding): string {
  return `${normalize(finding.location ?? "")}|${normalize(finding.title)}|${normalize(finding.evidence)}`;
}
function normalize(value: string): string {
  return value.toLowerCase()
    .replace(/authenticat(?:ed|es|ing|ion)?/g, "authenticity")
    .replace(/capabilities/g, "capability")
    .replace(/schemas/g, "schema")
    .replace(/signatures?/g, "signature")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function overlapCoefficient(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (!left.size || !right.size) return 0;
  return intersection(left, right).length / Math.min(left.size, right.size);
}
function intersection<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): T[] { return [...left].filter((value) => right.has(value)); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
