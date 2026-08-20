// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { canonicalizeConcreteScopePaths, isConcreteScopePath } from "../../runtime/agent-runtime.js";

const COLLATERAL_LIMIT = 16;
const MAX_RELATION_READS = 32;
const MAX_RELATION_BYTES = 128 * 1024;
const TEST_SUFFIX = /(?:\.test|\.spec|\.fixture)$/i;

export interface ScopeClosureInput {
  /** Concrete paths declared by the issue/controller and therefore direct authority. */
  issueWriteHints?: readonly string[];
  /** Concrete paths proven by the investigation. */
  investigationWriteHints?: readonly string[];
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
  const relationHints = directHints;
  const directSet = new Set(directHints);
  const collateral: string[] = [];
  const accepted = new Set(issueHints);
  const contents = new Map<string, string | undefined>();
  let relationReads = 0;

  for (const raw of proposed) {
    const path = canonicalConcrete([raw], diagnostics)[0];
    if (!path) {
      rejectedPaths.push(raw);
      continue;
    }
    if (directSet.has(path)) {
      accepted.add(path);
      continue;
    }
    const basenameRelation = isBasenameCompanion(path, relationHints);
    const contentRelation = !basenameRelation && input.cwd !== undefined
      ? await hasFrozenContentRelation(path, relationHints, input.cwd, contents, () => {
        relationReads += 1;
        return relationReads <= MAX_RELATION_READS;
      })
      : false;
    if (!basenameRelation && !contentRelation) {
      rejectedPaths.push(path);
      continue;
    }
    if (collateral.length >= maxCollateralPaths) {
      rejectedPaths.push(path);
      continue;
    }
    collateral.push(path);
    accepted.add(path);
  }

  if (rejectedPaths.length) {
    diagnostics.push(`[write-scope] Expected paths are not directly hinted or a bounded companion of a write hint: ${[...new Set(rejectedPaths)].sort().join(", ")}`);
  }
  if (proposed.length > maxCollateralPaths + directHints.length) {
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
  return Boolean(candidateKey && hints.some((hint) => logicalBasename(hint) === candidateKey));
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
    for (const hint of hints) {
      if (hint === candidate) continue;
      if (containsLiteralPathReference(content, hint)) return true;
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

function containsLiteralPathReference(content: string, referencedPath: string): boolean {
  const forms = new Set([referencedPath, `./${referencedPath}`, `/${referencedPath}`]);
  for (const quote of ["\"", "'", "`"] as const) {
    let cursor = 0;
    while (cursor < content.length) {
      const start = content.indexOf(quote, cursor);
      if (start < 0) break;
      const end = content.indexOf(quote, start + 1);
      if (end < 0) break;
      const literal = content.slice(start + 1, end);
      if (forms.has(literal) || literal.endsWith(`/${referencedPath}`)) return true;
      cursor = end + 1;
    }
  }
  return false;
}

function logicalBasename(path: string): string {
  const basename = path.split("/").at(-1) ?? "";
  const withoutExtension = basename.replace(/\.[^.]+$/, "");
  return withoutExtension.replace(TEST_SUFFIX, "").toLowerCase();
}
