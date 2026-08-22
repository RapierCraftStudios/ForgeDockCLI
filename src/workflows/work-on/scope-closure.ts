// SPDX-License-Identifier: AGPL-3.0-or-later

import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, posix, join } from "node:path";
import { repositoryPathFromLocation } from "../review-pr/scope.js";
import { canonicalizeConcreteScopePaths, isConcreteScopePath } from "../../runtime/agent-runtime.js";

const COLLATERAL_LIMIT = 16;
const MAX_RELATION_READS = 32;
const MAX_RELATION_BYTES = 128 * 1024;
const TEST_SUFFIX = /(?:\.test|\.spec|\.fixture)$/i;

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
  /** Concrete paths declared by the issue/controller and therefore direct authority. */
  issueWriteHints?: readonly string[];
  /** Concrete paths supplied by the controller outside the model output. */
  controllerWriteHints?: readonly string[];
  /** Frozen checkout used to prove literal/import relations for collateral files. */
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
 * Close a proposed packet write scope without turning a read/discovery root into
 * write authority. Direct hints are retained; a model-proposed collateral path
 * is admitted only when it is a bounded companion (same logical basename, with
 * test/spec/fixture suffixes ignored) of a concrete hint. This deliberately
 * admits source/test pairs such as src/foo.ts + test/foo.test.ts while rejecting
 * arbitrary siblings in src or an unbounded directory proposal.
 */
export async function closeExpectedWriteScope(
  proposed: readonly string[],
  input: ScopeClosureInput = {},
): Promise<ScopeClosureResult> {
  const diagnostics: string[] = [];
  const rejectedPaths: string[] = [];
  const maxCollateralPaths = Math.max(0, Math.min(COLLATERAL_LIMIT, input.maxCollateralPaths ?? COLLATERAL_LIMIT));
  const issueHints = canonicalConcrete(input.issueWriteHints ?? [], diagnostics);
  const directHints = canonicalConcrete([
    ...issueHints,
    ...(input.controllerWriteHints ?? []),
  ], diagnostics);
  const relationHints = [...directHints];
  const directSet = new Set(directHints);
  const collateral: string[] = [];
  const accepted = new Set(issueHints);
  const contents = new Map<string, string | undefined>();
  let relationReads = 0;
  const proposedPaths = canonicalConcrete(proposed, diagnostics);
  const pending = [...new Set(proposedPaths.filter((path) => !directSet.has(path)))];
  for (const path of proposedPaths) if (directSet.has(path)) accepted.add(path);

  // Resolve a bounded fixed point over real source/import relationships. This
  // lets a controller-authorized interface admit its direct implementation and
  // tests regardless of model output ordering, without trusting investigation
  // prose or unrelated same-root files as write authority.
  let advanced = true;
  while (advanced && pending.length && collateral.length < maxCollateralPaths) {
    advanced = false;
    for (let index = 0; index < pending.length && collateral.length < maxCollateralPaths;) {
      const path = pending[index]!;
      const basenameRelation = isBasenameCompanion(path, relationHints);
      const contentRelation = !basenameRelation && input.cwd !== undefined
        ? await hasFrozenContentRelation(path, relationHints, input.cwd, contents, () => {
          relationReads += 1;
          return relationReads <= MAX_RELATION_READS;
        })
        : false;
      if (!basenameRelation && !contentRelation) {
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      collateral.push(path);
      accepted.add(path);
      relationHints.push(path);
      advanced = true;
    }
  }
  rejectedPaths.push(...pending);

  if (rejectedPaths.length) {
    diagnostics.push(`[write-scope] Expected paths are not directly hinted or a bounded companion of a write hint: ${[...new Set(rejectedPaths)].sort().join(", ")}`);
  }
  if (proposedPaths.length > maxCollateralPaths + directHints.length) {
    diagnostics.push(`[write-scope-limit] At most ${maxCollateralPaths} collateral expected paths may be admitted before freeze`);
  }
  return {
    expectedPaths: [...accepted].sort(),
    collateralPaths: [...new Set(collateral)].sort(),
    rejectedPaths: [...new Set(rejectedPaths)].sort(),
    diagnostics,
  };
}

function canonicalConcrete(paths: readonly string[], diagnostics: string[]): string[] {
  const concrete = paths.filter(isConcreteScopePath);
  if (concrete.length !== paths.length) {
    const invalid = paths.filter((path) => !isConcreteScopePath(path));
    diagnostics.push(`[invalid-write-path] Write hints/proposals must be concrete repository-relative files: ${invalid.join(", ")}`);
  }
  try {
    return canonicalizeConcreteScopePaths(concrete);
  } catch (error) {
    diagnostics.push(`[invalid-write-path] ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function isBasenameCompanion(candidate: string, hints: readonly string[]): boolean {
  const candidateKey = logicalBasename(candidate);
  if (!candidateKey) return false;
  return hints.some((hint) => {
    const hintKey = logicalBasename(hint);
    if (hintKey === candidateKey) return true;
    // Documentation contracts commonly use a short product-neutral stem
    // (`CONFIG.md`) while their existing regression test carries a bounded
    // product prefix (`forgedock-config.test.ts`). Permit that suffix relation
    // only for test/spec/fixture candidates, never for production sources.
    return isTestLike(candidate) && ["-", "_", "."].some((separator) =>
      candidateKey.endsWith(`${separator}${hintKey}`) || hintKey.endsWith(`${separator}${candidateKey}`));
  });
}

function isTestLike(path: string): boolean {
  const basename = path.split("/").at(-1) ?? "";
  const withoutExtension = basename.replace(/\.d\.[^.]+$/i, "").replace(/\.[^.]+$/, "");
  return TEST_SUFFIX.test(withoutExtension);
}

async function hasFrozenContentRelation(
  candidate: string,
  hints: readonly string[],
  cwd: string,
  contents: Map<string, string | undefined>,
  canRead: () => boolean,
): Promise<boolean> {
  const paths = [...new Set([candidate, ...hints])];
  for (const path of paths) {
    const content = await readBoundedRepositoryFile(path, cwd, contents, canRead);
    if (content === undefined) continue;
    if (path === candidate) {
      for (const hint of hints) {
        if (containsLiteralPathReference(content, path, hint)) return true;
      }
    } else if (containsLiteralPathReference(content, path, candidate)) {
      return true;
    }
  }
  return false;
}

async function readBoundedRepositoryFile(
  path: string,
  cwd: string,
  contents: Map<string, string | undefined>,
  canRead: () => boolean,
): Promise<string | undefined> {
  if (contents.has(path)) return contents.get(path);
  if (!canRead()) return undefined;
  const root = resolve(cwd);
  const absolute = resolve(root, path);
  const relativePath = relative(root, absolute).replaceAll("\\", "/");
  if (!relativePath || relativePath.startsWith("../") || isAbsolute(relativePath)) {
    contents.set(path, undefined);
    return undefined;
  }
  try {
    const realRoot = await realpath(root);
    const realFile = await realpath(absolute);
    const realRelative = relative(realRoot, realFile).replaceAll("\\", "/");
    if (!realRelative || realRelative.startsWith("../") || isAbsolute(realRelative)) {
      contents.set(path, undefined);
      return undefined;
    }
    const value = await readFile(realFile, { encoding: "utf8" });
    const bounded = value.slice(0, MAX_RELATION_BYTES);
    contents.set(path, bounded);
    return bounded;
  } catch {
    contents.set(path, undefined);
    return undefined;
  }
}

function containsLiteralPathReference(content: string, sourcePath: string, referencedPath: string): boolean {
  const forms = new Set([referencedPath, `./${referencedPath}`, `/${referencedPath}`]);
  const referencedModule = stripModuleExtension(referencedPath);
  for (const quote of ["\"", "'", "`"] as const) {
    let cursor = 0;
    while (cursor < content.length) {
      const start = content.indexOf(quote, cursor);
      if (start < 0) break;
      const end = content.indexOf(quote, start + 1);
      if (end < 0) break;
      const literal = content.slice(start + 1, end).replaceAll("\\", "/");
      if (forms.has(literal) || literal.endsWith(`/${referencedPath}`)) return true;
      if (literal.startsWith(".")) {
        const resolvedImport = posix.normalize(posix.join(posix.dirname(sourcePath), literal));
        if (!resolvedImport.startsWith("../") && stripModuleExtension(resolvedImport) === referencedModule) return true;
      }
      cursor = end + 1;
    }
  }
  return false;
}

function stripModuleExtension(path: string): string {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/i, "");
}

function logicalBasename(path: string): string {
  const basename = path.split("/").at(-1) ?? "";
  const withoutExtension = basename.replace(/\.d\.[^.]+$/i, "").replace(/\.[^.]+$/, "");
  return withoutExtension.replace(TEST_SUFFIX, "").toLowerCase();
}
