// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { DurableArtifact, FindingRootLedgerPayload } from "../../core/artifacts/schema.js";

export type LedgerFinding = DurableArtifact<"ReviewVerdict">["payload"]["findings"][number];
export type FindingRoot = FindingRootLedgerPayload["roots"][number];

export interface RootAssessment {
  rootId: string;
  status: "open" | "fixed" | "rejected";
  evidence: string;
}

const OPEN_STATES = new Set<FindingRoot["state"]>(["open", "fix-attempted", "regressed"]);

/**
 * Reconcile every historical root, not only the immediately preceding prose.
 * Omission is deliberately not closure: a root changes to fixed/rejected only
 * through an explicit closure assessment bound to its durable root ID.
 */
export function reconcileFindingRootLedger(input: {
  previous?: DurableArtifact<"FindingRootLedger">;
  packet: DurableArtifact<"BuildPacket">;
  findings: readonly LedgerFinding[];
  assessments?: readonly RootAssessment[];
  headSha: string;
}): FindingRootLedgerPayload["roots"] {
  const prior = new Map((input.previous?.payload.roots ?? []).map((root) => [root.rootId, cloneRoot(root)]));
  const aliases = new Map<string, FindingRoot>();
  const currentAcceptedRoots = new Set<string>();
  for (const root of prior.values()) for (const alias of root.aliases) aliases.set(alias, root);

  for (const finding of input.findings) {
    const structural = structuralFindingRoot(finding, input.packet);
    const root = prior.get(structural.rootId)
      ?? aliases.get(structural.structuralKey)
      ?? [...prior.values()].find((candidate) => structurallyEquivalent(candidate, structural));
    const state = finding.scopeDisposition === "rejected" ? "rejected"
      : finding.scopeDisposition === "follow_up" ? "follow-up"
        : root?.state === "fixed" ? "regressed" : "open";
    if (root) {
      root.aliases = unique([...root.aliases, root.structuralKey, structural.structuralKey, finding.causalRoot].filter(isString));
      root.findingIds = unique([...root.findingIds, finding.id, ...(finding.sourceFindingIds ?? [])]);
      root.ownerRoles = unique([...root.ownerRoles, ...(finding.reviewerRoles ?? [])]);
      root.lastSeenHeadSha = input.headSha;
      root.state = state;
      root.epochsOpen = OPEN_STATES.has(state) ? root.epochsOpen + 1 : 0;
      const mustFix = finding.mustFix ?? root.representative.mustFix;
      root.representative = { ...finding, rootId: root.rootId, ...(mustFix !== undefined ? { mustFix } : {}) };
      if (OPEN_STATES.has(state)) currentAcceptedRoots.add(root.rootId);
      continue;
    }
    prior.set(structural.rootId, {
      ...structural,
      aliases: unique([structural.structuralKey, finding.causalRoot].filter(isString)),
      state,
      firstSeenHeadSha: input.headSha,
      lastSeenHeadSha: input.headSha,
      epochsOpen: OPEN_STATES.has(state) ? 1 : 0,
      findingIds: unique([finding.id, ...(finding.sourceFindingIds ?? [])]),
      ownerRoles: unique(finding.reviewerRoles?.length ? finding.reviewerRoles : ["correctness"]),
      representative: { ...finding, rootId: structural.rootId },
    });
    if (OPEN_STATES.has(state)) currentAcceptedRoots.add(structural.rootId);
  }

  const assessmentsByRoot = new Map<string, RootAssessment[]>();
  for (const assessment of input.assessments ?? []) {
    const grouped = assessmentsByRoot.get(assessment.rootId) ?? [];
    grouped.push(assessment);
    assessmentsByRoot.set(assessment.rootId, grouped);
  }
  for (const root of prior.values()) {
    const assessments = assessmentsByRoot.get(root.rootId) ?? [];
    if (currentAcceptedRoots.has(root.rootId)) continue;
    if (assessments.length > 0 && assessments.every((assessment) => assessment.status === "fixed")) {
      root.state = "fixed";
      root.epochsOpen = 0;
    } else if (assessments.length > 0 && assessments.every((assessment) => assessment.status === "rejected")) {
      root.state = "rejected";
      root.epochsOpen = 0;
    } else if (assessments.length > 0) {
      root.state = root.lastSeenHeadSha === input.headSha ? root.state : "fix-attempted";
      root.epochsOpen += root.lastSeenHeadSha === input.headSha ? 0 : 1;
    } else if (OPEN_STATES.has(root.state) && root.lastSeenHeadSha !== input.headSha) {
      root.state = "fix-attempted";
      root.epochsOpen += 1;
    }
  }
  return [...prior.values()].sort((left, right) => left.rootId.localeCompare(right.rootId));
}

export function openLedgerFindings(roots: readonly FindingRoot[]): LedgerFinding[] {
  return roots.filter((root) => OPEN_STATES.has(root.state)).map((root) => ({
    ...root.representative,
    rootId: root.rootId,
    normalizedRoot: root.structuralKey,
    mustFix: root.representative.mustFix ?? true,
    // Blocking remains a separate policy bit. The caller uses mustFix/open roots
    // for remediation and final admission even when medium severity is not blocking.
    blocking: root.representative.blocking,
  }));
}

export function structuralFindingRoot(
  finding: LedgerFinding,
  packet: DurableArtifact<"BuildPacket">,
): Pick<FindingRoot, "rootId" | "structuralKey" | "criterionIds" | "component" | "symbols" | "invariantFamily" | "failureFamily" | "triggerFamily"> {
  const criterionIds = criterionIdsForFinding(finding, packet);
  const component = componentForFinding(finding);
  const symbols = symbolsForFinding(finding);
  const invariantSource = finding.impact?.affectedInvariant?.trim()
    ? finding.impact.affectedInvariant
    : `${finding.intentRelevance}\n${finding.matchedAcceptanceCriteria?.join("\n") ?? ""}`;
  const invariantFamily = semanticFamily(invariantSource);
  const failureFamily = semanticFamily(`${finding.causalRoot ?? ""}\n${finding.title}\n${finding.remediation}`);
  const triggerFamily = semanticFamily(`${finding.impact?.trigger ?? ""}\n${finding.evidence}`);
  const structuralKey = [criterionIds.join("|"), component, symbols.join("|"), invariantFamily, failureFamily, triggerFamily].join("\n");
  return {
    rootId: `root-${createHash("sha256").update(structuralKey).digest("hex").slice(0, 20)}`,
    structuralKey,
    criterionIds,
    component,
    symbols,
    invariantFamily,
    failureFamily,
    triggerFamily,
  };
}

function criterionIdsForFinding(finding: LedgerFinding, packet: DurableArtifact<"BuildPacket">): string[] {
  const ids = new Set<string>();
  for (const value of finding.matchedAcceptanceCriteria ?? []) {
    const explicit = /\bcriterion-([1-9][0-9]*)\b/i.exec(value)?.[1];
    if (explicit) ids.add(`criterion-${explicit}`);
    const index = packet.payload.acceptanceCriteria.indexOf(value);
    if (index >= 0) ids.add(`criterion-${index + 1}`);
  }
  return [...ids].sort().length ? [...ids].sort() : ["criterion-1"];
}

function componentForFinding(finding: LedgerFinding): string {
  const value = finding.location ?? (finding.evidenceAnchor?.kind === "repository-location" ? finding.evidenceAnchor.reference : "unanchored");
  const normalized = value.replaceAll("\\", "/").trim();
  const path = /(?:^|[\s`(])([A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)+|[A-Za-z0-9_.@+-]+\.[A-Za-z0-9_.@+-]+)(?=[:#\s`),]|$)/.exec(normalized)?.[1];
  return (path ?? normalized.split(/[:#]/)[0] ?? "unanchored").toLowerCase();
}

function symbolsForFinding(finding: LedgerFinding): string[] {
  const corpus = `${finding.location ?? ""}\n${finding.evidenceAnchor?.reference ?? ""}\n${finding.evidence}\n${finding.remediation}`;
  const symbols = [...corpus.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*\(/g)]
    .map((match) => match[1]!)
    .filter((symbol) => symbol.length > 2);
  return unique(symbols.map((symbol) => symbol.toLowerCase())).slice(0, 4).sort().length
    ? unique(symbols.map((symbol) => symbol.toLowerCase())).slice(0, 4).sort()
    : [componentForFinding(finding).split("/").at(-1) ?? "component"];
}

/** Domain vocabulary collapses wording churn while preserving distinct triggers. */
function semanticFamily(value: string): string {
  const text = value.toLowerCase();
  const families: Array<[string, RegExp]> = [
    ["redaction-grammar", /redact|credential|secret|token|password|marker|userinfo/],
    ["chunk-boundary", /chunk|split|fragment|continuation|stream/],
    ["adapter-lifecycle", /adapter|lifecycle|recreat|producer|cleanup|terminal/],
    ["identity-isolation", /identity|session|nodeid|pisession|collision|interleav|isolation/],
    ["terminal-metadata", /terminal|completed|failed|cancelled|metadata|ordering/],
    ["backpressure", /backpressure|drop|queue|fail.closed/],
    ["authority-binding", /authority|head sha|revision|route|binding/],
    ["criterion-evidence", /criterion|acceptance evidence|verification command|check id/],
  ];
  const matched = families.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  if (matched.length) return matched.slice(0, 3).join("+");
  return text.replace(/[^a-z0-9]+/g, " ").split(" ").filter((token) => token.length > 2 || /^\d+$/.test(token)).sort().slice(0, 8).join("-") || "unspecified";
}

function structurallyEquivalent(left: FindingRoot, right: ReturnType<typeof structuralFindingRoot>): boolean {
  const familyMatches = [
    familyEquivalent(left.invariantFamily, right.invariantFamily),
    familyEquivalent(left.failureFamily, right.failureFamily),
    familyEquivalent(left.triggerFamily, right.triggerFamily),
  ].filter(Boolean).length;
  return left.component === right.component
    && intersects(left.criterionIds, right.criterionIds)
    && intersects(left.symbols, right.symbols)
    && familyMatches >= 2;
}

function familyEquivalent(left: string, right: string): boolean {
  if (left === right) return true;
  const canonical = new Set([
    "redaction-grammar", "chunk-boundary", "adapter-lifecycle", "identity-isolation",
    "terminal-metadata", "backpressure", "authority-binding", "criterion-evidence",
  ]);
  const leftFamilies = left.split("+").filter((family) => canonical.has(family));
  const rightFamilies = right.split("+").filter((family) => canonical.has(family));
  return leftFamilies.some((family) => rightFamilies.includes(family));
}

function cloneRoot(root: FindingRoot): FindingRoot {
  return { ...root, aliases: [...root.aliases], criterionIds: [...root.criterionIds], symbols: [...root.symbols], findingIds: [...root.findingIds], ownerRoles: [...root.ownerRoles], representative: { ...root.representative } };
}
function intersects(left: readonly string[], right: readonly string[]): boolean { return left.some((value) => right.includes(value)); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function isString(value: string | undefined): value is string { return typeof value === "string" && value.trim().length > 0; }
