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
    const legacyStructural = legacyStructuralFindingRoot(finding, input.packet);
    const candidates = [structural, legacyStructural];
    const root = candidates.map((candidate) => prior.get(candidate.rootId)).find(isFindingRoot)
      ?? candidates.map((candidate) => aliases.get(candidate.structuralKey)).find(isFindingRoot)
      ?? [...prior.values()].find((candidate) => candidates.some((alternative) => structurallyEquivalent(candidate, alternative)));
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
  return structuralFindingRootWithFamily(finding, packet, (value, dimension) => semanticFamily(value, dimension));
}

/** Reconstruct the pre-61 identity only for matching historical roots. */
function legacyStructuralFindingRoot(
  finding: LedgerFinding,
  packet: DurableArtifact<"BuildPacket">,
): ReturnType<typeof structuralFindingRoot> {
  return structuralFindingRootWithFamily(finding, packet, (value) => legacySemanticFamily(value));
}

function structuralFindingRootWithFamily(
  finding: LedgerFinding,
  packet: DurableArtifact<"BuildPacket">,
  family: (value: string, dimension: SemanticDimension) => string,
): ReturnType<typeof structuralFindingRoot> {
  const criterionIds = criterionIdsForFinding(finding, packet);
  const component = componentForFinding(finding);
  const symbols = symbolsForFinding(finding);
  const invariantSource = finding.impact?.affectedInvariant?.trim()
    ? finding.impact.affectedInvariant
    : `${finding.intentRelevance}\n${finding.matchedAcceptanceCriteria?.join("\n") ?? ""}`;
  const invariantFamily = family(invariantSource, "invariant");
  const failureFamily = family(`${finding.causalRoot ?? ""}\n${finding.title}\n${finding.remediation}`, "failure");
  const triggerFamily = family(`${finding.impact?.trigger ?? ""}\n${finding.evidence}`, "trigger");
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

/**
 * Explicit vocabulary for the three independent semantic dimensions. Keep this
 * matrix deliberately small: words such as "stream" and "terminal" often
 * describe incidental context, not another causal family. A family is added
 * only when its vocabulary is explicit, and the complete family set remains
 * part of identity (adapter+terminal is not terminal alone).
 */
type SemanticDimension = "invariant" | "failure" | "trigger";
interface VocabularyEntry { name: string; pattern: RegExp; }
const NORMALIZATION_VOCABULARY: Record<SemanticDimension, readonly VocabularyEntry[]> = {
  invariant: [
    { name: "redaction-grammar", pattern: /\b(?:redact|redacts|redacted|redacting|redaction|credential|credentials|secret|secrets|token|tokens|tokenized|tokenization|password|passwords|marker|markers|userinfo)\b/ },
    { name: "identity-isolation", pattern: /\b(?:identity|identities|session|sessions|nodeid|nodeids|pisession|pisessions|collision|collisions|interleav|interleaved|interleaving|isolation|isolated)\b/ },
    { name: "terminal-metadata", pattern: /\b(?:terminal|terminals|completed|complete|completes|failed|failure|cancelled|canceled|metadata|ordering|ordered)\b/ },
    { name: "adapter-lifecycle", pattern: /\b(?:adapter|adapters|lifecycle|lifecycles|recreate|recreates|recreated|recreating|recreation|recreations|producer|producers)\b/ },
    { name: "chunk-boundary", pattern: /\b(?:chunk|chunks|split|splits|splitter|fragment|fragments|continuation|continuations)\b/ },
    { name: "backpressure", pattern: /\b(?:backpressure|queue|queues|queued|queuing)\b/ },
    { name: "authority-binding", pattern: /\b(?:authority|authorities|head sha|revision|revisions|route|routes|routed|routing|binding|bindings)\b/ },
    { name: "criterion-evidence", pattern: /\b(?:criterion|criteria|acceptance evidence|verification command|check id)\b/ },
  ],
  failure: [
    { name: "redaction-grammar", pattern: /\b(?:redact|redacts|redacted|redacting|redaction|credential|credentials|secret|secrets|token|tokens|tokenized|tokenization|password|passwords|marker|markers|userinfo)\b/ },
    { name: "identity-isolation", pattern: /\b(?:identity|identities|session|sessions|nodeid|nodeids|pisession|pisessions|collision|collisions|interleav|interleaved|interleaving|isolation|isolated)\b/ },
    { name: "terminal-metadata", pattern: /\b(?:terminal|terminals|completed|complete|completes|failed|failure|cancelled|canceled|metadata|ordering|ordered)\b/ },
    { name: "adapter-lifecycle", pattern: /\b(?:adapter|adapters|lifecycle|lifecycles|recreate|recreates|recreated|recreating|recreation|recreations|producer|producers)\b/ },
    { name: "chunk-boundary", pattern: /\b(?:chunk|chunks|split|splits|splitter|fragment|fragments|continuation|continuations)\b/ },
    { name: "backpressure", pattern: /\b(?:backpressure|queue|queues|queued|queuing)\b/ },
    { name: "authority-binding", pattern: /\b(?:authority|authorities|head sha|revision|revisions|route|routes|routed|routing|binding|bindings)\b/ },
    { name: "criterion-evidence", pattern: /\b(?:criterion|criteria|acceptance evidence|verification command|check id)\b/ },
  ],
  trigger: [
    { name: "redaction-grammar", pattern: /\b(?:redact|redacts|redacted|redacting|redaction|credential|credentials|secret|secrets|token|tokens|tokenized|tokenization|password|passwords|marker|markers|userinfo)\b/ },
    { name: "chunk-boundary", pattern: /\b(?:chunk|chunks|split|splits|splitter|fragment|fragments|continuation|continuations)\b/ },
    { name: "identity-isolation", pattern: /\b(?:identity|identities|session|sessions|nodeid|nodeids|pisession|pisessions|collision|collisions|interleav|interleaved|interleaving|isolation|isolated)\b/ },
    { name: "terminal-metadata", pattern: /\b(?:terminal|terminals|completed|complete|completes|failed|failure|cancelled|canceled|metadata|ordering|ordered)\b/ },
    { name: "adapter-lifecycle", pattern: /\b(?:adapter|adapters|lifecycle|lifecycles|recreate|recreates|recreated|recreating|recreation|recreations|producer|producers)\b/ },
    { name: "backpressure", pattern: /\b(?:backpressure|queue|queues|queued|queuing)\b/ },
    { name: "authority-binding", pattern: /\b(?:authority|authorities|head sha|revision|revisions|route|routes|routed|routing|binding|bindings)\b/ },
    { name: "criterion-evidence", pattern: /\b(?:criterion|criteria|acceptance evidence|verification command|check id)\b/ },
  ],
};

function semanticFamily(value: string, dimension: SemanticDimension): string {
  const text = value.toLowerCase();
  const matched = NORMALIZATION_VOCABULARY[dimension]
    .filter(({ pattern }) => pattern.test(text))
    .map(({ name }) => name);
  // Boundary words in prose commonly qualify a domain family ("credential
  // chunk", "identity stream"). Treat them as an independent trigger only
  // in the trigger dimension, where that distinction is causal.
  const hasExplicitBoundary = /\b(?:chunk|chunks|split|splits|splitter|fragment|fragments|continuation|continuations)\b/.test(text);
  const normalized = matched.length <= 1 || (dimension === "trigger" && hasExplicitBoundary)
    ? matched
    : matched.filter((family) => family !== "chunk-boundary");
  if (normalized.length) return normalized.join("+");
  const tokens = text.replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((token) => token.length > 2 || /^\d+$/.test(token)).sort();
  if (tokens.length === 0) return "unspecified";
  // Keep the fallback bounded without making tokens after an arbitrary prefix
  // invisible to identity. The digest makes every discarded suffix relevant.
  return `${tokens.slice(0, 16).join("-")}-${createHash("sha256").update(tokens.join("\n")).digest("hex").slice(0, 16)}`;
}

/** Exact pre-61 vocabulary, used only as a compatibility candidate. */
function legacySemanticFamily(value: string): string {
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
  return text.replace(/[^a-z0-9]+/g, " ").split(" ")
    .filter((token) => token.length > 2 || /^\d+$/.test(token)).sort().slice(0, 8).join("-") || "unspecified";
}

function structurallyEquivalent(left: FindingRoot, right: ReturnType<typeof structuralFindingRoot>): boolean {
  return left.component === right.component
    && intersects(left.criterionIds, right.criterionIds)
    && intersects(left.symbols, right.symbols)
    && familyEquivalent(left.invariantFamily, right.invariantFamily)
    && familyEquivalent(left.failureFamily, right.failureFamily)
    && familyEquivalent(left.triggerFamily, right.triggerFamily);
}

/** Compare complete canonical family sets; partial overlap collapses triggers. */
function familyEquivalent(left: string, right: string): boolean {
  if (left === right) return true;
  const canonical = new Set(NORMALIZATION_VOCABULARY.invariant.map(({ name }) => name));
  const leftFamilies = left.split("+").filter((family) => canonical.has(family));
  const rightFamilies = right.split("+").filter((family) => canonical.has(family));
  if (leftFamilies.length === 0 || rightFamilies.length === 0) return false;
  return leftFamilies.length === rightFamilies.length
    && leftFamilies.every((family) => rightFamilies.includes(family));
}

function cloneRoot(root: FindingRoot): FindingRoot {
  return { ...root, aliases: [...root.aliases], criterionIds: [...root.criterionIds], symbols: [...root.symbols], findingIds: [...root.findingIds], ownerRoles: [...root.ownerRoles], representative: { ...root.representative } };
}
function intersects(left: readonly string[], right: readonly string[]): boolean { return left.some((value) => right.includes(value)); }
function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }
function isFindingRoot(value: FindingRoot | undefined): value is FindingRoot { return value !== undefined; }
function isString(value: string | undefined): value is string { return typeof value === "string" && value.trim().length > 0; }
