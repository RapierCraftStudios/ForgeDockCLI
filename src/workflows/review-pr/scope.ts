// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";

export type ReviewFinding = DurableArtifact<"ReviewVerdict">["payload"]["findings"][number];

/** Projection mode used by the native review controller. */
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
      if (finding.introducedByRemediation === true && finding.evidenceAnchor?.kind !== "delivery-authority"
        && (introduction === undefined
          || introduction.hunkReferences.length === 0
          || (controllerEvidence.remediationDeltaHunks ?? []).length === 0
          || !hunkEvidence)) {
        throw new Error(`Post-remediation finding ${finding.id} claims introduction without exact current-head hunk authority`);
      }
      // A touched path is inventory, not causation. Introduction requires an
      // exact changed hunk and symbol plus a prior/current reproducer, or an
      // exact changed authority fact with the same comparative evidence.
      const controllerProvesIntroduced = finding.introducedByRemediation === true
        && reproducerEvidence && ((changedPathEvidence && hunkEvidence && symbolEvidence) || authorityEvidence);
      if (!continuesAcceptedFinding && !controllerProvesIntroduced) {
        accepted = false;
        controllerReasons.push(finding.introducedByRemediation
          ? "reviewer claimed a remediation-introduced regression without an exact prior-SHA remediation delta or changed delivery-authority fact"
          : "new post-remediation concern neither traces to an accepted prior finding nor identifies a controller-proven remediation-introduced regression");
      }
    }

    const scopeDisposition = accepted
      ? "in_scope" as const
      : finding.scopeDisposition === "rejected"
        ? "rejected" as const
        : "follow_up" as const;
    const rationale = [finding.scopeRationale, ...controllerReasons.map((reason) => `Controller downgrade: ${reason}.`)]
      .filter((part): part is string => Boolean(part?.trim()))
      .join(" ");
    const introductionDisposition = priorVerdict?.payload.disposition === "request_changes"
      ? (finding.matchedPriorFindingIds ?? []).some((id) => priorFindingIds.has(id))
        ? "continuation" as const
        : accepted && finding.introducedByRemediation
          ? "introduced" as const
          : "newly-discovered-preexisting" as const
      : finding.introductionDisposition;
    return {
      ...finding,
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
  if (mode === "all") return undefined;
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

function pathMatchesExpectation(path: string, expected: string): boolean {
  if (expected.endsWith("/**")) return path.startsWith(expected.slice(0, -3));
  return path === expected || path.startsWith(`${expected}/`);
}
