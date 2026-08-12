// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";

export type ReviewFinding = DurableArtifact<"ReviewVerdict">["payload"]["findings"][number];

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
    /** Explicit authority facts whose prior-verdict value changed. */
    changedRemediationAuthorityReferences?: readonly string[];
  } = {},
): T[] {
  const criteria = new Set(packet.payload.acceptanceCriteria);
  const priorFindingIds = new Set(priorVerdict?.payload.findings
    .filter((finding) => finding.blocking)
    .flatMap((finding) => [finding.id, ...(finding.sourceFindingIds ?? [])]) ?? []);

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
      const authorityEvidence = finding.evidenceAnchor?.kind === "delivery-authority"
        && (controllerEvidence.changedRemediationAuthorityReferences ?? []).includes(finding.evidenceAnchor.reference);
      const controllerProvesIntroduced = finding.introducedByRemediation === true && (changedPathEvidence || authorityEvidence);
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
    return {
      ...finding,
      blocking: finding.blocking && accepted,
      scopeDisposition,
      ...(rationale ? { scopeRationale: rationale } : {}),
      matchedAcceptanceCriteria: exactCriteria,
    };
  });
}

/** Only unresolved blockers and independently corroborated high-risk follow-ups become issues. */
export function shouldMaterializeFinding(finding: ReviewFinding): boolean {
  if (finding.scopeDisposition === "rejected") return false;
  if (finding.blocking) return true;
  return finding.scopeDisposition === "follow_up"
    && (finding.severity === "critical" || finding.severity === "high")
    && finding.confidence === "high"
    && (finding.reviewerRoles?.length ?? 0) >= 2;
}

const EXCLUDED_TOPICS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "runtime/controller", pattern: /\b(?:runtime|controller|adapter|agent[- ]runtime|pi[- ]adapter)\b/i },
  { name: "lease/coordination", pattern: /\b(?:lease|heartbeat|fencing|takeover|coordination[- ]key)\b/i },
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
