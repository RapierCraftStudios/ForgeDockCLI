// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";

const MAX_PATH = 512;
const MAX_DIAGNOSTIC = 1_000;
const MAX_HUNK = 200;
const MAX_RANGE = 100;
const MAX_LINE = 10_000_000;
const SHA_PATTERN = "^[0-9a-fA-F]{40,64}$";

export const FindingAnchorVersion = 1 as const;
export const RepositoryFindingAnchorSchema = Type.Object({
  version: Type.Literal(1),
  kind: Type.Literal("repository-location"),
  path: Type.String({ minLength: 1, maxLength: MAX_PATH }),
  blobSha: Type.String({ pattern: SHA_PATTERN }),
  side: Type.Union([Type.Literal("old"), Type.Literal("new")]),
  range: Type.Object({ start: Type.Integer({ minimum: 1, maximum: MAX_LINE }), end: Type.Integer({ minimum: 1, maximum: MAX_LINE }) }),
  snippetHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  hunk: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_HUNK })),
});
export const ControllerReferenceAnchorSchema = Type.Object({
  version: Type.Literal(1),
  kind: Type.Union([Type.Literal("delivery-authority"), Type.Literal("deterministic-check")]),
  reference: Type.String({ minLength: 1, maxLength: MAX_DIAGNOSTIC }),
});
export const TypedFindingAnchorSchema = Type.Union([RepositoryFindingAnchorSchema, ControllerReferenceAnchorSchema]);

export type RepositoryFindingAnchor = Static<typeof RepositoryFindingAnchorSchema>;
export type ControllerReferenceAnchor = Static<typeof ControllerReferenceAnchorSchema>;
export type TypedFindingAnchor = Static<typeof TypedFindingAnchorSchema>;

export type AnchorResolutionStatus =
  | "accepted" | "malformed" | "traversal" | "missing" | "stale" | "wrong-sha"
  | "impossible" | "out-of-diff" | "rename" | "deletion" | "binary" | "generated"
  | "omitted-patch" | "concurrent-head";

export interface AnchorResolution {
  status: AnchorResolutionStatus;
  diagnostic: string;
  manifestIdentity?: string;
  path?: string;
  side?: "old" | "new";
  range?: { start: number; end: number };
  hunk?: string;
}

export interface DiffManifestHunk {
  id: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  oldChanged: Array<{ start: number; end: number }>;
  newChanged: Array<{ start: number; end: number }>;
}

export type DiffChangeStatus = "modified" | "added" | "deleted" | "renamed" | "typechange" | "unknown";
export interface DiffManifestEntry {
  path: string;
  oldPath?: string;
  oldBlobSha?: string;
  newBlobSha?: string;
  status: DiffChangeStatus;
  sides: { old?: { min: number; max: number }; new?: { min: number; max: number } };
  ranges: { old: Array<{ start: number; end: number }>; new: Array<{ start: number; end: number }> };
  hunks: DiffManifestHunk[];
  patchComplete: boolean;
  binary: boolean;
  generated: boolean;
}

export interface DiffManifestLimits {
  maxFiles: number;
  maxPatchBytes: number;
  maxRangesPerFile: number;
  maxDiagnosticBytes: number;
}
export const DEFAULT_DIFF_MANIFEST_LIMITS: Readonly<DiffManifestLimits> = Object.freeze({
  maxFiles: 1_000,
  maxPatchBytes: 2_000_000,
  maxRangesPerFile: 256,
  maxDiagnosticBytes: MAX_DIAGNOSTIC,
});
export interface DiffManifest {
  version: 1;
  headSha?: string;
  entries: DiffManifestEntry[];
  identity: string;
  limits: DiffManifestLimits;
  truncated: boolean;
}

export function normalizeRepositoryPath(value: string): string {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path.includes("\0") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`repository path is not canonical: ${boundedDiagnostic(value)}`);
  }
  if (path.length > MAX_PATH || /^[A-Za-z]:\//.test(path)) throw new Error("repository path exceeds canonical bounds");
  return path;
}

export function computeSnippetHash(snippet: string): string {
  return createHash("sha256").update(snippet.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

export const snippetHashFor = computeSnippetHash;

export function normalizeBlobSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("blob SHA must contain 40-64 hexadecimal characters");
  return sha;
}

export function normalizeAnchorRange(range: { start: number; end: number }): { start: number; end: number } {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 1 || range.start > MAX_LINE || range.end > MAX_LINE || range.end < range.start || range.end - range.start + 1 > MAX_RANGE) {
    throw new Error("anchor range must be a bounded positive inclusive range");
  }
  return { start: range.start, end: range.end };
}

export function canonicalRepositoryAnchor(input: Omit<RepositoryFindingAnchor, "version" | "kind"> | RepositoryFindingAnchor): RepositoryFindingAnchor {
  const candidate = input as RepositoryFindingAnchor;
  const path = normalizeRepositoryPath(candidate.path);
  const blobSha = normalizeBlobSha(candidate.blobSha);
  if (candidate.side !== "old" && candidate.side !== "new") throw new Error("anchor side must be old or new");
  const range = normalizeAnchorRange(candidate.range);
  if (!/^[0-9a-f]{64}$/i.test(candidate.snippetHash)) throw new Error("snippet hash must be a SHA-256 hex digest");
  const hunk = candidate.hunk?.trim();
  if (hunk !== undefined && (!hunk || hunk.length > MAX_HUNK || /[\r\n]/.test(hunk))) throw new Error("diff hunk identity is unbounded or malformed");
  return { version: 1, kind: "repository-location", path, blobSha, side: candidate.side, range, snippetHash: candidate.snippetHash.toLowerCase(), ...(hunk ? { hunk } : {}) };
}

export function canonicalControllerAnchor(input: ControllerReferenceAnchor): ControllerReferenceAnchor {
  if (input.version !== 1 || (input.kind !== "delivery-authority" && input.kind !== "deterministic-check")) throw new Error("unsupported controller anchor");
  const reference = input.reference.trim();
  if (!reference || reference.length > MAX_DIAGNOSTIC || /[\r\n]/.test(reference)) throw new Error("controller reference is empty or unbounded");
  return { version: 1, kind: input.kind, reference };
}

/** Parse a bounded unified diff into a controller-owned, deterministic manifest. */
export function buildDiffManifest(input: {
  diff: string;
  headSha?: string;
  changedPaths?: readonly string[];
  limits?: Partial<DiffManifestLimits>;
  generatedPath?: (path: string) => boolean;
}): DiffManifest {
  const limits: DiffManifestLimits = { ...DEFAULT_DIFF_MANIFEST_LIMITS, ...(input.limits ?? {}) };
  if (!Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 1 || !Number.isSafeInteger(limits.maxPatchBytes) || limits.maxPatchBytes < 1 || !Number.isSafeInteger(limits.maxRangesPerFile) || limits.maxRangesPerFile < 1 || !Number.isSafeInteger(limits.maxDiagnosticBytes) || limits.maxDiagnosticBytes < 1) throw new Error("diff manifest limits are invalid");
  if (Buffer.byteLength(input.diff, "utf8") > limits.maxPatchBytes) throw new Error(`diff exceeds bounded manifest patch limit (${limits.maxPatchBytes} bytes)`);
  const starts = [...input.diff.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  const entries: DiffManifestEntry[] = [];
  for (let index = 0; index < starts.length && entries.length < limits.maxFiles; index++) {
    const match = starts[index]!;
    const section = input.diff.slice(match.index ?? 0, starts[index + 1]?.index ?? input.diff.length);
    let path: string;
    let oldPath: string | undefined;
    try { path = normalizeRepositoryPath(match[2] ?? match[1] ?? ""); oldPath = normalizeRepositoryPath(match[1] ?? ""); } catch { continue; }
    const indexLine = section.match(/^index\s+([0-9a-fA-F]{7,64})\.\.([0-9a-fA-F]{7,64})/m);
    const oldBlobSha = indexLine?.[1] ? normalizeLooseSha(indexLine[1]) : undefined;
    const newBlobSha = indexLine?.[2] ? normalizeLooseSha(indexLine[2]) : undefined;
    const binary = /^Binary files /m.test(section) || /\bbinary\b/i.test(section.slice(0, 300));
    const deleted = /^deleted file mode/m.test(section) || /^--- a\/[^\n]+\n\+\+\+ \/dev\/null/m.test(section);
    const added = /^new file mode/m.test(section) || /^--- \/dev\/null/m.test(section);
    const renamed = /^similarity index/m.test(section) || /^rename from /m.test(section) || (oldPath !== path && oldPath !== undefined);
    const hunks: DiffManifestHunk[] = [];
    const ranges = { old: [] as Array<{ start: number; end: number }>, new: [] as Array<{ start: number; end: number }> };
    for (const hunkMatch of section.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm)) {
      const oldStart = Number(hunkMatch[1]); const oldCount = Number(hunkMatch[2] ?? 1);
      const newStart = Number(hunkMatch[3]); const newCount = Number(hunkMatch[4] ?? 1);
      if (![oldStart, oldCount, newStart, newCount].every((n) => Number.isSafeInteger(n) && n >= 0)) continue;
      const bodyStart = (hunkMatch.index ?? 0) + hunkMatch[0].length;
      const next = section.slice(bodyStart).search(/^@@ /m);
      const body = section.slice(bodyStart, next < 0 ? section.length : bodyStart + next).split(/\r?\n/);
      let oldLine = oldStart; let newLine = newStart;
      const oldChanged: Array<{ start: number; end: number }> = []; const newChanged: Array<{ start: number; end: number }> = [];
      for (const line of body) {
        if (line.startsWith("-") && !line.startsWith("---")) { addRange(oldChanged, oldLine); oldLine++; }
        else if (line.startsWith("+") && !line.startsWith("+++")) { addRange(newChanged, newLine); newLine++; }
        else if (line.startsWith(" ") || line === "") { oldLine++; newLine++; }
      }
      const id = `-${oldStart},${oldCount} +${newStart},${newCount}`;
      hunks.push({ id, oldStart, oldEnd: Math.max(oldStart, oldStart + oldCount - 1), newStart, newEnd: Math.max(newStart, newStart + newCount - 1), oldChanged, newChanged });
      ranges.old.push(...oldChanged); ranges.new.push(...newChanged);
    }
    const patchComplete = hunks.length > 0 && !section.includes("Initial diff was size-bounded") && !/truncated/i.test(section.slice(-300));
    const status: DiffChangeStatus = renamed ? "renamed" : deleted ? "deleted" : added ? "added" : binary ? "typechange" : "modified";
    const sides: DiffManifestEntry["sides"] = {};
    const oldBounds = rangeBounds(ranges.old); if (oldBounds) sides.old = oldBounds;
    const newBounds = rangeBounds(ranges.new); if (newBounds) sides.new = newBounds;
    entries.push({ path, ...(oldPath && oldPath !== path ? { oldPath } : {}), ...(oldBlobSha ? { oldBlobSha } : {}), ...(newBlobSha ? { newBlobSha } : {}), status, sides, ranges, hunks, patchComplete, binary, generated: input.generatedPath?.(path) ?? generatedPath(path) });
  }
  const present = new Set(entries.map((entry) => entry.path));
  for (const raw of input.changedPaths ?? []) {
    let path: string; try { path = normalizeRepositoryPath(raw); } catch { continue; }
    if (present.has(path) || entries.length >= limits.maxFiles) continue;
    entries.push({ path, status: "unknown", sides: {}, ranges: { old: [], new: [] }, hunks: [], patchComplete: false, binary: false, generated: generatedPath(path) });
  }
  const truncated = starts.length > limits.maxFiles;
  const normalizedEntries = entries.map((entry) => ({ ...entry, ranges: { old: entry.ranges.old.slice(0, limits.maxRangesPerFile), new: entry.ranges.new.slice(0, limits.maxRangesPerFile) }, hunks: entry.hunks.slice(0, limits.maxRangesPerFile) })).sort((a, b) => a.path.localeCompare(b.path));
  const frozenHead = input.headSha === undefined ? undefined : normalizeBlobSha(input.headSha);
  const identity = createHash("sha256").update(JSON.stringify({ version: 1, headSha: frozenHead, entries: normalizedEntries, limits })).digest("hex");
  return { version: 1, ...(frozenHead ? { headSha: frozenHead } : {}), entries: normalizedEntries, identity, limits, truncated };
}

export const createDiffManifest = buildDiffManifest;

export function resolveRepositoryAnchor(anchor: unknown, manifest: DiffManifest, options: { currentHeadSha?: string } = {}): AnchorResolution {
  if (options.currentHeadSha && manifest.headSha && options.currentHeadSha.toLowerCase() !== manifest.headSha.toLowerCase()) return result("concurrent-head", "the PR head no longer matches the frozen manifest", manifest);
  let normalized: RepositoryFindingAnchor;
  try { normalized = canonicalRepositoryAnchor(anchor as RepositoryFindingAnchor); } catch (error) { const message = error instanceof Error ? error.message : "malformed repository anchor"; return result(message.includes("path") ? "traversal" : "malformed", message, manifest); }
  const entry = manifest.entries.find((candidate) => candidate.path === normalized.path);
  if (!entry) return result("out-of-diff", `path '${normalized.path}' is not present in the frozen diff`, manifest, normalized);
  if (entry.generated) return result("generated", `path '${normalized.path}' is classified as generated`, manifest, normalized);
  if (entry.binary) return result("binary", `path '${normalized.path}' is binary and has no line evidence`, manifest, normalized);
  if (entry.status === "renamed") return result("rename", `path '${normalized.path}' is a rename; ordinary line evidence is not stable`, manifest, normalized);
  if (entry.status === "deleted") return result("deletion", `path '${normalized.path}' was deleted and has no stable line evidence`, manifest, normalized);
  if (!entry.patchComplete) return result("omitted-patch", `patch for '${normalized.path}' is omitted or truncated`, manifest, normalized);
  const actualSha = normalized.side === "old" ? entry.oldBlobSha : entry.newBlobSha;
  if (!actualSha) return result(entry.status === "deleted" ? "deletion" : entry.status === "added" && normalized.side === "old" ? "impossible" : "wrong-sha", `no ${normalized.side}-side blob identity exists for '${normalized.path}'`, manifest, normalized);
  if (actualSha !== normalized.blobSha) return result("wrong-sha", `${normalized.side}-side blob SHA does not match the frozen manifest`, manifest, normalized);
  const ranges = normalized.side === "old" ? entry.ranges.old : entry.ranges.new;
  const hunk = entry.hunks.find((candidate) => (normalized.side === "old" ? candidate.oldChanged : candidate.newChanged).some((range) => overlaps(range, normalized.range)));
  if (!hunk || !ranges.some((range) => contains(range, normalized.range))) return result(ranges.length ? "out-of-diff" : "impossible", `line range ${normalized.range.start}-${normalized.range.end} is not changed evidence in the frozen diff`, manifest, normalized);
  if (normalized.hunk !== undefined && normalized.hunk !== hunk.id) return result("out-of-diff", "anchor hunk identity does not match the frozen diff", manifest, normalized);
  return { status: "accepted", diagnostic: "repository anchor matches the frozen head, blob, changed range, and hunk", manifestIdentity: manifest.identity, path: normalized.path, side: normalized.side, range: normalized.range, ...(hunk ? { hunk: hunk.id } : {}) };
}

export const resolveFindingAnchor = resolveRepositoryAnchor;

function result(status: AnchorResolutionStatus, diagnostic: string, manifest: DiffManifest, anchor?: RepositoryFindingAnchor): AnchorResolution {
  return { status, diagnostic: boundedDiagnostic(diagnostic, manifest.limits.maxDiagnosticBytes), manifestIdentity: manifest.identity, ...(anchor ? { path: anchor.path, side: anchor.side, range: anchor.range, ...(anchor.hunk ? { hunk: anchor.hunk } : {}) } : {}) };
}
function normalizeLooseSha(value: string): string | undefined {
  const sha = value.toLowerCase();
  return /^0+$/.test(sha) ? undefined : sha;
}
function rangeBounds(ranges: Array<{ start: number; end: number }>): { min: number; max: number } | undefined {
  if (!ranges.length) return undefined;
  return { min: Math.min(...ranges.map((range) => range.start)), max: Math.max(...ranges.map((range) => range.end)) };
}
function addRange(ranges: Array<{ start: number; end: number }>, line: number): void {
  const previous = ranges.at(-1); if (previous && previous.end + 1 === line) previous.end = line; else ranges.push({ start: line, end: line });
}
function contains(outer: { start: number; end: number }, inner: { start: number; end: number }): boolean { return inner.start >= outer.start && inner.end <= outer.end; }
function overlaps(left: { start: number; end: number }, right: { start: number; end: number }): boolean { return left.start <= right.end && right.start <= left.end; }
function generatedPath(path: string): boolean { return /(?:^|\/)(?:dist|build|coverage|generated|vendor)(?:\/|$)|\.(?:map|min\.(?:js|css))$/i.test(path); }
function boundedDiagnostic(value: string, maximum = MAX_DIAGNOSTIC): string { const safe = value.replace(/[\r\n\0]/g, " ").trim(); return safe.length <= maximum ? safe : `${safe.slice(0, Math.max(0, maximum - 1))}…`; }
