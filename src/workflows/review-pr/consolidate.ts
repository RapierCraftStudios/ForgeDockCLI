// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { ReviewerRole, ReviewerSubmission } from "./review.js";

type Finding = ReviewerSubmission["findings"][number];

export type ConsolidatedFinding = Finding & {
  sourceFindingIds: string[];
  sourceSessionRefs?: string[];
  reviewerRoles: ReviewerRole[];
};

interface SourceFinding {
  role: ReviewerRole;
  sessionRefs: readonly string[];
  finding: Finding;
}

interface FindingCluster {
  sources: SourceFinding[];
}

const SEVERITY = { low: 0, medium: 1, high: 2, critical: 3 } as const;
const CONFIDENCE = { low: 0, medium: 1, high: 2 } as const;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "does", "for", "from", "has", "have", "in", "is",
  "it", "its", "no", "not", "of", "on", "or", "the", "their", "to", "without", "with", "require", "requires",
]);

/**
 * Conservatively consolidate only cross-reviewer duplicates. Findings from one
 * reviewer remain distinct unless they are exact duplicates; related defects
 * are not silently collapsed merely because they share a file or broad domain.
 */
export function consolidateReviewerFindings(
  results: readonly { role: ReviewerRole; output: ReviewerSubmission; sessionRef?: string; sessionLineage?: readonly string[] }[],
  blockingSeverities: ReadonlySet<Finding["severity"]>,
): ConsolidatedFinding[] {
  const clusters: FindingCluster[] = [];
  for (const result of results) {
    for (const finding of result.output.findings) {
      const source = {
        role: result.role,
        sessionRefs: result.sessionLineage ?? (result.sessionRef ? [result.sessionRef] : []),
        finding,
      };
      const cluster = clusters.find((candidate) => candidate.sources.some((existing) => duplicateFinding(existing, source)));
      if (cluster) cluster.sources.push(source);
      else clusters.push({ sources: [source] });
    }
  }

  return clusters.map((cluster) => consolidateCluster(cluster, blockingSeverities))
    .sort((left, right) => SEVERITY[right.severity] - SEVERITY[left.severity]
      || (left.location ?? "").localeCompare(right.location ?? "")
      || left.title.localeCompare(right.title));
}

function duplicateFinding(left: SourceFinding, right: SourceFinding): boolean {
  const leftExact = exactIdentity(left.finding);
  const rightExact = exactIdentity(right.finding);
  if (leftExact === rightExact) return true;
  if (left.role === right.role) return false;

  const leftPaths = findingPaths(left.finding);
  const rightPaths = findingPaths(right.finding);
  const sharedPath = leftPaths.some((path) => rightPaths.includes(path));
  if (!sharedPath && leftPaths.length && rightPaths.length) return false;

  const leftTags = conceptTags(left.finding);
  const rightTags = conceptTags(right.finding);
  const sharedTags = intersection(leftTags, rightTags);
  const titleSimilarity = overlapCoefficient(titleTokens(left.finding.title), titleTokens(right.finding.title));
  if (sharedTags.length >= 2) return true;
  if (sharedTags.length === 1 && titleSimilarity >= 0.45) return true;
  return titleSimilarity >= 0.72;
}

function consolidateCluster(cluster: FindingCluster, blockingSeverities: ReadonlySet<Finding["severity"]>): ConsolidatedFinding {
  const ranked = [...cluster.sources].sort((left, right) =>
    SEVERITY[right.finding.severity] - SEVERITY[left.finding.severity]
    || CONFIDENCE[right.finding.confidence] - CONFIDENCE[left.finding.confidence]);
  const representative = ranked[0]!;
  const severity = ranked.reduce((highest, source) =>
    SEVERITY[source.finding.severity] > SEVERITY[highest] ? source.finding.severity : highest,
  representative.finding.severity);
  const confidence = ranked.reduce((highest, source) =>
    CONFIDENCE[source.finding.confidence] > CONFIDENCE[highest] ? source.finding.confidence : highest,
  representative.finding.confidence);
  const reviewerRoles = unique(cluster.sources.map((source) => source.role));
  const sourceFindingIds = unique(cluster.sources.map((source) => `${source.role}:${source.finding.id}`));
  const sourceSessionRefs = unique(cluster.sources.flatMap((source) => source.sessionRefs));
  const evidence = combineSourceText(cluster.sources, (source) => source.finding.evidence, 12_000);
  const remediation = combineSourceText(cluster.sources, (source) => source.finding.remediation, 8_000);
  const intentRelevance = combineSourceText(cluster.sources, (source) => source.finding.intentRelevance, 8_000);
  const stableIdentity = [
    findingPaths(representative.finding).sort().join(","),
    [...conceptTags(representative.finding)].sort().join(","),
    normalize(representative.finding.title),
    normalize(representative.finding.evidence),
  ].join("\n");
  return {
    ...representative.finding,
    id: `review-${createHash("sha256").update(stableIdentity).digest("hex").slice(0, 16)}`,
    severity,
    confidence,
    blocking: blockingSeverities.has(severity),
    evidence,
    intentRelevance,
    remediation,
    sourceFindingIds,
    ...(sourceSessionRefs.length ? { sourceSessionRefs } : {}),
    reviewerRoles,
  };
}

function combineSourceText(sources: readonly SourceFinding[], select: (source: SourceFinding) => string, maximum: number): string {
  const uniqueText = new Map<string, { role: ReviewerRole; id: string; text: string }>();
  for (const source of sources) {
    const text = select(source).trim();
    const key = normalize(text);
    if (!uniqueText.has(key)) uniqueText.set(key, { role: source.role, id: source.finding.id, text });
  }
  const combined = [...uniqueText.values()].map(({ role, id, text }) =>
    sources.length === 1 ? text : `[${role}:${id}] ${text}`).join("\n\n");
  return combined.length <= maximum ? combined : `${combined.slice(0, maximum - 1)}…`;
}

function conceptTags(finding: Finding): Set<string> {
  const text = `${finding.title}\n${finding.evidence}\n${finding.location ?? ""}`.toLowerCase();
  const tags = new Set<string>();
  const add = (tag: string, pattern: RegExp) => { if (pattern.test(text)) tags.add(tag); };
  add("capability", /capabilit(?:y|ies)|delegat(?:ion|ed)/);
  add("authenticity", /authenticat|signature|signed|integrity|cryptograph|trust root/);
  add("reviewed-sha", /reviewed.?sha|source.?sha|head sha|sha binding|non-sha|revision binding/);
  add("idempotency", /idempoten|operation id|request id|reus(?:e|able).*id/);
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
  const text = `${finding.location ?? ""}\n${finding.evidence}`.replaceAll("\\", "/");
  return unique([...text.matchAll(/(?:^|[\s`(])((?:\.?[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+)(?=[:`),;\s]|$)/gm)]
    .map((match) => match[1]!.replace(/^\.\//, "").toLowerCase()));
}

function titleTokens(title: string): Set<string> {
  return new Set(normalize(title).split(" ").filter((token) => token.length > 2 && !STOP_WORDS.has(token)));
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

function intersection<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): T[] {
  return [...left].filter((value) => right.has(value));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
