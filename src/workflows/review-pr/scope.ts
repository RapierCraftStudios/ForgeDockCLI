// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { isRetainedReviewFindingRouteForFinding, type DurableArtifact } from "../../core/artifacts/schema.js";

export type ReviewFinding = DurableArtifact<"ReviewVerdict">["payload"]["findings"][number];

export interface ExactSourceBlob {
  content: string;
  mode: string;
}

/** Validate reviewer source identity against the immutable reviewed revision. */
export async function verifyFindingSourceAnchors<T extends ReviewFinding>(
  findings: readonly T[],
  input: {
    reviewedHeadSha: string;
    changedPaths: readonly string[];
    expectedPaths: readonly string[];
    readBlob?: (revision: string, path: string) => Promise<ExactSourceBlob | undefined>;
    verifiedAuthorityReferences: readonly string[];
  },
): Promise<T[]> {
  const changed = input.changedPaths.map(normalizeRepoPath);
  const expected = input.expectedPaths.map(normalizeRepoPath);
  const authority = new Set(input.verifiedAuthorityReferences);
  return Promise.all(findings.map(async (finding) => {
    if (!(finding.mustFix ?? finding.blocking)) return finding;
    const anchor = finding.evidenceAnchor;
    if ((anchor?.kind === "delivery-authority" || anchor?.kind === "deterministic-check")
      && authority.has(anchor.reference)) return finding;
    const snapshot = finding.sourceSnapshot;
    const path = snapshot?.path ? normalizeRepoPath(snapshot.path) : undefined;
    const pathAllowed = Boolean(path)
      && (changed.some((candidate) => pathMatchesExpectation(path!, candidate))
        || expected.some((candidate) => pathMatchesExpectation(path!, candidate)));
    let verified = Boolean(snapshot
      && input.readBlob
      && snapshot.reviewedHeadSha.toLowerCase() === input.reviewedHeadSha.toLowerCase()
      && pathAllowed
      && (snapshot.excerpt !== undefined || snapshot.digest !== undefined));
    if (verified) {
      try {
        const blob = await input.readBlob!(input.reviewedHeadSha, path!);
        if (!blob || !isRegularBlobMode(blob.mode)) verified = false;
        else {
          if (snapshot!.excerpt !== undefined && !blob.content.includes(snapshot!.excerpt)) verified = false;
          if (snapshot!.digest !== undefined
            && createHash("sha256").update(blob.content).digest("hex") !== snapshot!.digest.toLowerCase()) verified = false;
          if (snapshot!.symbol !== undefined && !blob.content.includes(snapshot!.symbol)) verified = false;
        }
      } catch { verified = false; }
    }
    if (verified) return finding;
    return {
      ...finding,
      blocking: false,
      mustFix: false,
      scopeDisposition: "follow_up",
      scopeRationale: [finding.scopeRationale, "Controller could not verify an exact reviewed-head source anchor; retained as advisory."].filter(Boolean).join(" "),
    };
  }));
}

export function findingAuthorityEligible(
  finding: ReviewFinding,
  verifiedAuthorityReferences: readonly string[],
): boolean {
  if (finding.scopeDisposition !== undefined && finding.scopeDisposition !== "in_scope") return false;
  if (!(finding.mustFix ?? finding.blocking)) return false;
  // Legacy findings remain decodable and useful as advisory evidence, but
  // cannot authorize a retained-revision mutation without the strict route.
  if (!isRetainedReviewFindingRouteForFinding(finding.retainedRoute, finding)) return false;
  const anchor = finding.evidenceAnchor;
  if ((anchor?.kind === "delivery-authority" || anchor?.kind === "deterministic-check")
    && verifiedAuthorityReferences.includes(anchor.reference)) return true;
  return finding.sourceSnapshot !== undefined;
}

export function isUnverifiedSourceFinding(finding: ReviewFinding): boolean {
  return finding.scopeDisposition === "follow_up"
    && finding.scopeRationale?.includes("Controller could not verify an exact reviewed-head source anchor") === true;
}

/**
 * Repair only factual source proof at the frozen head. Reviewer prose and all
 * other finding fields remain untouched; an unsafe claim is left unchanged so
 * the existing diagnostics and anchor validator can fail it closed.
 *
 * A source location is not proof. Normalization therefore requires an existing
 * authorized snapshot and at least one supplied proof field. Every supplied
 * proof field must match the exact frozen blob before the head is corrected or
 * a digest is added; invalid claims are deliberately left untouched.
 */
export async function normalizeReviewerSourceSnapshots<T extends ReviewFinding>(
  findings: readonly T[],
  input: {
    reviewedHeadSha: string;
    assignedPaths: readonly string[];
    reviewedPaths: readonly string[];
    expectedPaths: readonly string[];
    readBlob?: (revision: string, path: string) => Promise<ExactSourceBlob | undefined>;
    verifiedAuthorityReferences: readonly string[];
  },
): Promise<T[]> {
  const allowed = [...input.assignedPaths, ...input.reviewedPaths, ...input.expectedPaths]
    .map(normalizeRepoPath)
    .filter(Boolean);
  const authority = new Set(input.verifiedAuthorityReferences);
  return Promise.all(findings.map(async (finding) => {
    if (!(finding.mustFix ?? finding.blocking)) return finding;
    const anchor = finding.evidenceAnchor;
    if ((anchor?.kind === "delivery-authority" || anchor?.kind === "deterministic-check")
      && authority.has(anchor.reference)) return finding;

    const suppliedSnapshot = finding.sourceSnapshot;
    // A location alone is not source proof. Missing snapshots remain available
    // to the existing diagnostics/retry/fail-closed path.
    if (suppliedSnapshot === undefined) return finding;
    const path = normalizeRepoPath(suppliedSnapshot.path);
    // A supplied path is an assertion of identity, not a hint. Never replace an
    // invalid/out-of-scope assertion with a path inferred from prose.
    if (!isAllowedSourcePath(path, allowed) || !input.readBlob) return finding;

    let blob: ExactSourceBlob | undefined;
    try {
      blob = await input.readBlob(input.reviewedHeadSha, path);
    } catch {
      return finding;
    }
    if (!blob || !isRegularBlobMode(blob.mode)) return finding;

    const digest = createHash("sha256").update(blob.content).digest("hex");
    const hasProof = suppliedSnapshot.excerpt !== undefined
      || suppliedSnapshot.digest !== undefined
      || suppliedSnapshot.symbol !== undefined;
    if (!hasProof) return finding;
    const excerptValid = suppliedSnapshot.excerpt === undefined
      || (typeof suppliedSnapshot.excerpt === "string"
        && suppliedSnapshot.excerpt.length > 0
        && blob.content.includes(suppliedSnapshot.excerpt));
    const digestValid = suppliedSnapshot.digest === undefined
      || (typeof suppliedSnapshot.digest === "string"
        && suppliedSnapshot.digest.length > 0
        && digest === suppliedSnapshot.digest.toLowerCase());
    const symbolValid = suppliedSnapshot.symbol === undefined
      || (typeof suppliedSnapshot.symbol === "string"
        && suppliedSnapshot.symbol.length > 0
        && blob.content.includes(suppliedSnapshot.symbol));
    if (!excerptValid || !digestValid || !symbolValid) return finding;

    const snapshot: NonNullable<ReviewFinding["sourceSnapshot"]> = {
      reviewedHeadSha: input.reviewedHeadSha,
      path,
      ...(suppliedSnapshot.excerpt !== undefined ? { excerpt: suppliedSnapshot.excerpt } : {}),
      digest,
      ...(suppliedSnapshot.symbol !== undefined ? { symbol: suppliedSnapshot.symbol } : {}),
    };
    return { ...finding, sourceSnapshot: snapshot };
  }));
}

export async function reviewerSourceSnapshotDiagnostics(
  findings: readonly ReviewFinding[],
  input: {
    reviewedHeadSha: string;
    assignedPaths: readonly string[];
    reviewedPaths: readonly string[];
    expectedPaths: readonly string[];
    readBlob?: (revision: string, path: string) => Promise<ExactSourceBlob | undefined>;
    verifiedAuthorityReferences: readonly string[];
  },
): Promise<string[]> {
  const allowed = [...input.assignedPaths, ...input.reviewedPaths, ...input.expectedPaths].map(normalizeRepoPath);
  const authority = new Set(input.verifiedAuthorityReferences);
  const diagnostics: string[] = [];
  for (const finding of findings) {
    if (!(finding.mustFix ?? finding.blocking)) continue;
    const anchor = finding.evidenceAnchor;
    if ((anchor?.kind === "delivery-authority" || anchor?.kind === "deterministic-check") && authority.has(anchor.reference)) continue;
    const snapshot = finding.sourceSnapshot;
    if (!snapshot) { diagnostics.push(`${finding.id}: missing sourceSnapshot for blocking repository finding`); continue; }
    if (snapshot.reviewedHeadSha.toLowerCase() !== input.reviewedHeadSha.toLowerCase()) { diagnostics.push(`${finding.id}: sourceSnapshot.reviewedHeadSha does not match frozen head ${input.reviewedHeadSha}`); continue; }
    const path = normalizeRepoPath(snapshot.path);
    if (!path || path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..") || !allowed.some((candidate) => pathMatchesExpectation(path, candidate))) { diagnostics.push(`${finding.id}: sourceSnapshot.path must be repo-relative and under assigned/reviewed scope`); continue; }
    if (!snapshot.excerpt && !snapshot.digest) { diagnostics.push(`${finding.id}: sourceSnapshot requires a bounded excerpt or SHA-256 digest`); continue; }
    if (!input.readBlob) { diagnostics.push(`${finding.id}: controller cannot verify sourceSnapshot without readExactBlob`); continue; }
    try {
      const blob = await input.readBlob(input.reviewedHeadSha, path);
      if (!blob || !isRegularBlobMode(blob.mode)) { diagnostics.push(`${finding.id}: sourceSnapshot path is not a regular file at frozen head`); continue; }
      if (snapshot.excerpt && !blob.content.includes(snapshot.excerpt)) { diagnostics.push(`${finding.id}: sourceSnapshot excerpt is absent from exact file ${path}`); continue; }
      if (snapshot.digest && createHash("sha256").update(blob.content).digest("hex") !== snapshot.digest.toLowerCase()) { diagnostics.push(`${finding.id}: sourceSnapshot digest mismatches exact file ${path}`); continue; }
      if (snapshot.symbol && !blob.content.includes(snapshot.symbol)) diagnostics.push(`${finding.id}: sourceSnapshot symbol is absent from exact file ${path}`);
    } catch (error) { diagnostics.push(`${finding.id}: exact source read failed (${error instanceof Error ? error.message : String(error)})`); }
  }
  return diagnostics;
}


export type FindingProjectionMode = "all" | "impact-gated";

/**
 * Apply the controller-owned semantic scope gate after independent reviewers
 * report evidence. New reviewer submissions must name an exact frozen
 * acceptance criterion. After remediation, a concern must also trace to a
 * previously accepted finding or identify a remediation-introduced regression.
 * Older durable verdicts predate these fields and remain readable.
 */
export function applyFindingScopePolicy<T extends ReviewFinding>(
  findings: readonly T[],
  packet: DurableArtifact<"BuildPacket">,
  priorVerdict?: DurableArtifact<"ReviewVerdict">,
  controllerEvidence: {
    /** Exact controller-observed diff from the prior reviewed SHA to current head. */
    remediationDeltaPaths?: readonly string[];
    /** Exact prior->current hunk references (for example path:L10-L20 or path:symbol). */
    remediationDeltaHunks?: readonly string[];
    /** Explicit authority facts whose prior-verdict value changed. */
    changedRemediationAuthorityReferences?: readonly string[];
  } = {},
): T[] {
  const criteria = new Set(packet.payload.acceptanceCriteria);
  const priorFindingIds = new Set(priorVerdict?.payload.findings
    .filter((finding) => finding.mustFix ?? finding.blocking)
    .flatMap((finding) => [
      finding.id,
      ...(finding.sourceFindingIds ?? []),
      ...(finding.rootId ? [finding.rootId] : []),
    ]) ?? []);

  return findings.map((finding) => {
    // Compatibility: artifacts produced before scope adjudication existed keep
    // their historical controller disposition when being resumed.
    if (finding.scopeDisposition === undefined) return finding;

    const controllerReasons: string[] = [];
    const exactCriteria = (finding.matchedAcceptanceCriteria ?? []).filter((criterion) => criteria.has(criterion));
    let accepted = finding.scopeDisposition === "in_scope";
    if (accepted && exactCriteria.length === 0) {
      accepted = false;
      controllerReasons.push("no exact frozen acceptance criterion was identified");
    }

    const excludedTopic = accepted ? findingExcludedTopic(finding, packet) : undefined;
    if (excludedTopic) {
      accepted = false;
      controllerReasons.push(`the concern expands into the packet's excluded ${excludedTopic} behavior`);
    }

    const locationPath = finding.location ? repositoryPathFromLocation(finding.location) : undefined;
    if (accepted && locationPath && !packet.payload.expectedPaths.some((expected) => pathMatchesExpectation(locationPath, normalizeRepoPath(expected)))) {
      accepted = false;
      controllerReasons.push(`reported location ${locationPath} is outside the frozen expected paths`);
    }

    let unsupportedIntroductionClaim = false;
    let unsupportedIntroduction = false;
    if (accepted && priorVerdict?.payload.disposition === "request_changes") {
      const continuesAcceptedFinding = (finding.matchedPriorFindingIds ?? []).some((id) => priorFindingIds.has(id));
      const changedPathEvidence = locationPath !== undefined
        && (controllerEvidence.remediationDeltaPaths ?? []).some((path) => pathMatchesExpectation(locationPath, normalizeRepoPath(path)));
      const introduction = finding.introductionEvidence;
      const hunkEvidence = introduction !== undefined
        && introduction.hunkReferences.some((reference) => (controllerEvidence.remediationDeltaHunks ?? []).includes(reference));
      const symbolEvidence = introduction !== undefined
        && introduction.causalSymbols.some((symbol) => introduction.hunkReferences.some((reference) => reference.includes(symbol)));
      const reproducerEvidence = introduction !== undefined
        && introduction.priorReproducer.trim() !== introduction.currentReproducer.trim();
      const authorityEvidence = finding.evidenceAnchor?.kind === "delivery-authority"
        && (controllerEvidence.changedRemediationAuthorityReferences ?? []).includes(finding.evidenceAnchor.reference)
        && introduction?.authorityReferences?.includes(finding.evidenceAnchor.reference) === true;
      // An introducedByRemediation bit is only an assertion until the
      // controller can bind it to the exact current-head hunk/delivery fact.
      // Keep the review evidence, but never let an unsupported assertion abort
      // a sibling finding or become new remediation authority.
      unsupportedIntroductionClaim = finding.introducedByRemediation === true
        && !((introduction !== undefined
          && introduction.hunkReferences.length > 0
          && (controllerEvidence.remediationDeltaHunks ?? []).length > 0
          && hunkEvidence
          && reproducerEvidence
          && changedPathEvidence
          && symbolEvidence)
          || authorityEvidence);
      unsupportedIntroduction = unsupportedIntroductionClaim && !continuesAcceptedFinding;
      if (unsupportedIntroduction) {
        accepted = false;
        controllerReasons.push("introducedByRemediation was not supported by an exact current-head hunk or changed delivery-authority fact");
      }
      // A touched path is inventory, not causation. Introduction requires an
      // exact changed hunk and symbol plus a prior/current reproducer, or an
      // exact changed authority fact with the same comparative evidence.
      const controllerProvesIntroduced = finding.introducedByRemediation === true
        && reproducerEvidence && ((changedPathEvidence && hunkEvidence && symbolEvidence) || authorityEvidence);
      if (!continuesAcceptedFinding && !controllerProvesIntroduced && !unsupportedIntroduction) {
        accepted = false;
        controllerReasons.push(finding.introducedByRemediation
          ? "reviewer claimed a remediation-introduced regression without an exact prior-SHA remediation delta or changed delivery-authority fact"
          : "new post-remediation concern neither traces to an accepted prior finding nor identifies a controller-proven remediation-introduced regression");
      }
    }

    const scopeDisposition = unsupportedIntroduction
      ? "follow_up" as const
      : accepted
        ? "in_scope" as const
        : finding.scopeDisposition === "rejected"
          ? "rejected" as const
          : "follow_up" as const;
    const rationale = [finding.scopeRationale, ...controllerReasons.map((reason) => `Controller downgrade: ${reason}.`)]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(" ");
    const introductionDisposition = unsupportedIntroduction
      ? "newly-discovered-preexisting" as const
      : priorVerdict?.payload.disposition === "request_changes"
        ? (finding.matchedPriorFindingIds ?? []).some((id) => priorFindingIds.has(id))
          ? "continuation" as const
          : accepted && finding.introducedByRemediation
            ? "introduced" as const
            : "newly-discovered-preexisting" as const
        : finding.introductionDisposition;
    return {
      ...finding,
      ...(unsupportedIntroductionClaim ? { introducedByRemediation: false } : {}),
      blocking: finding.blocking && accepted,
      mustFix: (finding.mustFix ?? finding.blocking) && accepted,
      scopeDisposition,
      ...(introductionDisposition ? { introductionDisposition } : {}),
      ...(rationale ? { scopeRationale: rationale } : {}),
      matchedAcceptanceCriteria: exactCriteria,
    };
  });
}

/**
 * Explain why a finding is excluded from the opt-in impact-gated issue lane.
 * The default lane intentionally preserves the historical contract: every
 * accepted (non-rejected) finding is materialized. The impact lane is stricter
 * and only creates work when the reviewer supplied high-confidence, in-scope,
 * anchored evidence of a concrete consequence. Missing or malformed impact
 * evidence is advisory review data, never an automatic work item.
 */
export function findingMaterializationReason(
  finding: ReviewFinding,
  mode: FindingProjectionMode = "all",
): string | undefined {
  if (finding.scopeDisposition === "rejected") return "controller rejected the finding scope";
  if (mode === "all") {
    if ((finding.mustFix ?? finding.blocking) && finding.scopeDisposition === "in_scope"
      && !isRetainedReviewFindingRouteForFinding(finding.retainedRoute, finding)) {
      return "finding has no validated retained-revision route authority";
    }
    return undefined;
  }
  if (finding.scopeDisposition !== "in_scope") return "finding is not in the frozen Build Packet scope";
  if (finding.confidence !== "high") return "impact lane requires high-confidence evidence";
  if (!finding.causalRoot?.trim()) return "impact lane requires a causal root";
  const hasAnchor = Boolean(finding.location?.trim() || finding.evidenceAnchor?.reference?.trim());
  if (!hasAnchor) return "impact lane requires a repository or typed evidence anchor";
  const impact = finding.impact;
  if (!impact) return "reviewer did not provide structured impact evidence";
  if (!impact.trigger.trim() || !impact.affectedInvariant.trim() || !impact.consequence.trim()) {
    return "structured impact evidence is incomplete";
  }
  if (impact.category === "advisory") return "reviewer classified the concern as advisory";
  // Low-severity test, performance, compatibility, and operational gaps stay
  // in the verdict as advisory evidence unless the reviewer promotes them to
  // a higher severity after proving a concrete delivery consequence. Low
  // correctness/security/data/availability defects remain eligible because a
  // small blast radius does not make a safety defect frivolous.
  if (finding.severity === "low"
    && (impact.category === "test-gap"
      || impact.category === "performance"
      || impact.category === "compatibility"
      || impact.category === "operability")) {
    return `low-severity ${impact.category} concern remains advisory`;
  }
  return undefined;
}

/** Every controller-accepted finding becomes durable work in the legacy lane. */
export function shouldMaterializeFinding(
  finding: ReviewFinding,
  mode: FindingProjectionMode = "all",
): boolean {
  return findingMaterializationReason(finding, mode) === undefined;
}

const EXCLUDED_TOPICS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // Match the excluded protocol/authority expansion, not generic words such
  // as "lease" or "controller" that are often the subject of the packet.
  { name: "runtime/controller", pattern: /\b(?:agent[- ]runtime|pi[- ]adapter|runtime\s*\/\s*controller\s+behavior|runtime\s+(?:or\s+)?controller|controller\s+(?:protocol|state[- ]machine)|runtime\s+(?:protocol|state[- ]machine))\b/i },
  { name: "cross-machine lease/coordination service", pattern: /\b(?:github-backed|cross-machine)\b[\s\S]{0,80}\b(?:lease|coordination)\s+(?:service|protocol)\b/i },
  { name: "event", pattern: /\b(?:event envelope|event schema|event stream|event ordering)\b/i },
  { name: "bundle", pattern: /\b(?:portable bundle|bundle profile|bundle member|manifest|archive)\b/i },
  { name: "identity/trust", pattern: /\b(?:host authority|hostAuthorityId|authority id|identity|trust root|trustRoot|endpoint namespace|presenter)\b/i },
  { name: "canonicalization", pattern: /\b(?:canonicalization|canonical encoding|canonical bytes|unicode normalization)\b/i },
];

function findingExcludedTopic(finding: ReviewFinding, packet: DurableArtifact<"BuildPacket">): string | undefined {
  const findingText = [finding.title, finding.evidence, finding.remediation, finding.intentRelevance].join("\n");
  const excludedText = packet.payload.outOfScope.join("\n");
  return EXCLUDED_TOPICS.find(({ pattern }) => pattern.test(excludedText)
    && pattern.test(findingText))?.name;
}

export function repositoryPathFromLocation(location: string): string | undefined {
  const normalized = location.replaceAll("\\", "/").trim();
  const candidates = normalized.matchAll(/(?:^|[\s`(])(\.?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)(?=[:#\s`),]|$)/g);
  for (const match of candidates) {
    if (!match[1]) continue;
    const candidate = normalizeRepoPath(match[1]);
    const finalSegment = candidate.split("/").at(-1) ?? "";
    // Artifact/session field references are evidence locations, not repository
    // paths. False scope classification strands otherwise recoverable runs.
    if (/^(?:art|run|task)_/i.test(candidate)) continue;
    const pathLike = candidate.includes("/")
      || finalSegment.includes(".")
      || /^(?:Dockerfile(?:\.[A-Za-z0-9_.-]+)?|LICENSE|Makefile|Procfile|README)$/i.test(finalSegment);
    if (pathLike) return candidate;
  }
  return undefined;
}

function normalizeRepoPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function isAllowedSourcePath(path: string, allowed: readonly string[]): boolean {
  return Boolean(path)
    && !path.startsWith("/")
    && !path.split("/").some((part) => part === "." || part === "..")
    && allowed.some((candidate) => pathMatchesExpectation(path, candidate));
}

function isRegularBlobMode(mode: string): boolean {
  return /^100[0-7]{3}$/.test(mode);
}

function pathMatchesExpectation(path: string, expected: string): boolean {
  if (expected.endsWith("/**")) {
    const root = expected.slice(0, -3).replace(/\/$/, "");
    return path === root || path.startsWith(`${root}/`);
  }
  return path === expected || path.startsWith(`${expected}/`);
}
