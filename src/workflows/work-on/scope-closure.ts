// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { repositoryPathFromLocation } from "../review-pr/scope.js";
import { canonicalizeBuilderWritePaths, canonicalizeConcreteScopePaths, isConcreteScopePath } from "../../runtime/agent-runtime.js";


/**
 * Resolve only controller-observed Investigation evidence locations into
 * read-only packet paths. These bounds deliberately apply before any path can
 * enter packet evidence or an agent read scope.
 */
export interface InvestigationEvidenceLimits {
  maxSourceLocations: number;
  maxPathLength: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const INVESTIGATION_EVIDENCE_LIMITS: InvestigationEvidenceLimits = {
  maxSourceLocations: 64,
  maxPathLength: 512,
  maxFiles: 64,
  maxFileBytes: 1_048_576,
  maxTotalBytes: 4_000_000,
};

/** Validate a concrete path against one frozen read scope and checkout. */
export async function validateFrozenReadOnlyFile(
  path: string,
  cwd: string,
  allowedReadRoots: readonly string[],
  limits: InvestigationEvidenceLimits = INVESTIGATION_EVIDENCE_LIMITS,
): Promise<number | undefined> {
  let candidate: string;
  try {
    candidate = canonicalizeConcreteScopePaths([path])[0] ?? "";
  } catch {
    return undefined;
  }
  if (!candidate || candidate.length > limits.maxPathLength || !pathWithinReadRoots(candidate, allowedReadRoots)) return undefined;
  let root: string;
  try {
    root = await realpath(resolve(cwd));
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const absolute = resolve(root, candidate);
  const lexicalRelative = relative(root, absolute).replaceAll("\\", "/");
  if (!lexicalRelative || lexicalRelative.startsWith("../") || isAbsolute(lexicalRelative)) return undefined;
  try {
    let current = root;
    for (const segment of candidate.split("/")) {
      current = join(current, segment);
      const entry = await lstat(current);
      if (entry.isSymbolicLink()) return undefined;
    }
    const entry = await lstat(absolute);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limits.maxFileBytes) return undefined;
    const canonical = await realpath(absolute);
    const canonicalRelative = relative(root, canonical).replaceAll("\\", "/");
    if (!canonicalRelative || canonicalRelative.startsWith("../") || isAbsolute(canonicalRelative)) return undefined;
    return entry.size;
  } catch {
    return undefined;
  }
}

function pathWithinReadRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const normalized = root.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/$/, "") || ".";
    return normalized === "." || path === normalized || path.startsWith(`${normalized}/`);
  });
}

export async function resolveInvestigationEvidenceSources(
  sources: readonly string[],
  cwd: string,
  limits: InvestigationEvidenceLimits = INVESTIGATION_EVIDENCE_LIMITS,
): Promise<string[]> {
  const selected = new Set<string>();
  let totalBytes = 0;
  for (const source of sources.slice(0, limits.maxSourceLocations)) {
    const extracted = repositoryPathFromLocation(source);
    if (!extracted || !safeEvidenceLocation(source, extracted) || extracted.length > limits.maxPathLength) continue;
    let path: string;
    try {
      path = canonicalizeConcreteScopePaths([extracted])[0] ?? "";
    } catch {
      continue;
    }
    if (!path || path.length > limits.maxPathLength || selected.has(path)) continue;
    if (selected.size >= limits.maxFiles) break;
    const size = await validateFrozenReadOnlyFile(path, cwd, ["."], limits);
    if (size === undefined || totalBytes + size > limits.maxTotalBytes) continue;
    totalBytes += size;
    selected.add(path);
  }
  return [...selected].sort();
}

function safeEvidenceLocation(source: string, path: string): boolean {
  const normalized = source.replaceAll("\\", "/").trim();
  const index = normalized.indexOf(path);
  if (index < 0 || (index > 0 && !/[\s`(]/.test(normalized[index - 1]!))) return false;
  const suffix = normalized.slice(index + path.length).trimStart();
  if (suffix.startsWith(":")) return /^:\d+(?::\d+)?(?:-\d+)?(?:\b|$)/.test(suffix);
  if (suffix.startsWith("#")) return /^#L?\d+(?:-L?\d+)?(?:\b|$)/i.test(suffix);
  return suffix.length === 0 || /^[`),\s]/.test(suffix);
}

export interface ScopeClosureInput {
  /** Optional issue/controller claims retained as provenance metadata. */
  issueWriteHints?: readonly string[];
  controllerWriteHints?: readonly string[];
  /** Deprecated compatibility fields; path claims are no longer relation-closed. */
  cwd?: string;
  maxCollateralPaths?: number;
}

export interface ScopeClosureResult {
  expectedPaths: string[];
  collateralPaths: string[];
  rejectedPaths: string[];
  diagnostics: string[];
}

/**
 * Canonicalize a proposed packet scope. A packet-author proposal is accepted
 * as the exact builder grant after concrete-path validation; managed-worktree
 * containment, observed diff, verification, and review remain the authority
 * boundaries for what may actually be changed and delivered.
 */
export async function closeExpectedWriteScope(
  proposed: readonly string[],
  input: ScopeClosureInput = {},
): Promise<ScopeClosureResult> {
  const diagnostics: string[] = [];
  const issueHints = canonicalConcrete(input.issueWriteHints ?? [], diagnostics);
  const directHints = canonicalConcrete([
    ...issueHints,
    ...(input.controllerWriteHints ?? []),
  ], diagnostics);
  const proposedPaths = canonicalConcrete(proposed, diagnostics);
  const directSet = new Set(directHints);

  // A packet author runs read-only in a managed worktree. Its concrete path
  // list is therefore the exact builder grant after canonical validation; the
  // builder can still change only inside that grant. Observed diff, verification,
  // and review gates remain authoritative for what is actually delivered. Do
  // not require issue/controller hints to bless a claim: issues with
  // investigation-discovered cross-cutting scope have no reliable direct hint
  // to seed a basename/companion closure.
  return {
    expectedPaths: [...new Set([...directHints, ...proposedPaths])].sort(),
    collateralPaths: proposedPaths.filter((path) => !directSet.has(path)).sort(),
    rejectedPaths: [],
    diagnostics,
  };
}

function canonicalConcrete(paths: readonly string[], diagnostics: string[]): string[] {
  const concrete = paths.filter(isConcreteScopePath);
  if (concrete.length !== paths.length) {
    const invalid = paths.filter((path) => !isConcreteScopePath(path));
    diagnostics.push(`[invalid-write-path] Write hints/proposals must be concrete repository-relative files: ${invalid.join(", ")}`);
  }
  const allowed: string[] = [];
  for (const path of concrete) {
    try {
      allowed.push(...canonicalizeBuilderWritePaths([path]));
    } catch (error) {
      diagnostics.push(`[invalid-write-path] ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...new Set(allowed)];
}