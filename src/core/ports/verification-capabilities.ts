// SPDX-License-Identifier: AGPL-3.0-or-later

import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { VerificationCommand, VerificationEvidenceCapability } from "./verification.js";

export const MAX_VERIFICATION_TARGETS = 32;
export const VERIFICATION_TEST_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

export interface VerificationCapability {
  id: string;
  required: boolean;
  selection: "always" | "packet" | "available";
  targeting?: "expected-test-paths";
  allowedSourceRoot?: string;
  allowedTestExtensions?: readonly string[];
  targetPattern?: "**/*.test.{ts,tsx,mts,cts}";
  maxTargets?: number;
  /** Safe semantic classification; command, args, cwd, and layout are never projected. */
  evidenceCapability?: VerificationEvidenceCapability;
}

export class VerificationCapabilityMismatchError extends Error {
  readonly code: "outside-source-root" | "unsupported-extension" | "target-limit" | "missing-target";
  readonly path?: string;

  constructor(
    code: VerificationCapabilityMismatchError["code"],
    message: string,
    path?: string,
  ) {
    super(message);
    this.name = "VerificationCapabilityMismatchError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export function isVerificationCapabilityMismatchError(error: unknown): error is VerificationCapabilityMismatchError {
  return error instanceof VerificationCapabilityMismatchError;
}

/** Project only safe selection facts; executable arguments remain controller-private. */
export function projectVerificationCapabilities(
  commands: readonly (Pick<VerificationCommand, "id"> & Partial<Pick<VerificationCommand, "required" | "selection" | "targeting" | "typescriptLayout" | "evidenceCapability">>)[],
): VerificationCapability[] {
  return commands.map((command) => ({
    id: command.id,
    required: command.required ?? false,
    selection: command.selection ?? "available",
    ...(command.evidenceCapability !== undefined ? { evidenceCapability: command.evidenceCapability } : {}),
    ...(command.targeting === "expected-test-paths" ? {
      targeting: command.targeting,
      ...(command.typescriptLayout?.sourceRoot !== undefined ? { allowedSourceRoot: command.typescriptLayout.sourceRoot } : {}),
      allowedTestExtensions: [...VERIFICATION_TEST_EXTENSIONS],
      targetPattern: "**/*.test.{ts,tsx,mts,cts}" as const,
      maxTargets: MAX_VERIFICATION_TARGETS,
    } : {}),
  }));
}

export function isExpectedTestPath(path: string): boolean {
  return /(?:^|\/)\S+\.test\.(?:[cm]?[jt]sx?)$/i.test(path.replaceAll("\\", "/"));
}

export function resolveVerificationTargets(
  expectedPaths: readonly string[],
  targetedCommands: readonly Pick<VerificationCommand, "id" | "typescriptLayout">[],
  readOnlyPaths: readonly string[] = [],
): string[] {
  const sourcePaths = [...new Set([...expectedPaths, ...readOnlyPaths].filter(isExpectedTestPath))];
  if (!targetedCommands.length || !sourcePaths.length) return [];
  const layouts = targetedCommands.map((command) => command.typescriptLayout).filter((layout): layout is NonNullable<typeof layout> => Boolean(layout));
  if (layouts.length !== targetedCommands.length) {
    throw new Error("Targeted verification command has no controller-proven source/output layout");
  }
  const layout = layouts[0]!;
  if (layouts.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(layout))) {
    throw new Error("Targeted verification commands disagree on source/output layout");
  }
  if (sourcePaths.length > MAX_VERIFICATION_TARGETS) {
    throw new VerificationCapabilityMismatchError(
      "target-limit",
      `Build Packet selects ${sourcePaths.length} test paths; targeted verification is bounded to ${MAX_VERIFICATION_TARGETS}`,
    );
  }
  return sourcePaths.map((path) => compiledTestTarget(path, layout));
}

export function validateVerificationTargetPaths(
  expectedPaths: readonly string[],
  targetedCommands: readonly Pick<VerificationCommand, "id" | "typescriptLayout">[],
): void {
  const sourcePaths = expectedPaths.filter(isExpectedTestPath);
  if (!targetedCommands.length || !sourcePaths.length) return;
  const layouts = targetedCommands.map((command) => command.typescriptLayout).filter((layout): layout is NonNullable<typeof layout> => Boolean(layout));
  if (layouts.length !== targetedCommands.length) {
    throw new Error("Targeted verification command has no controller-proven source/output layout");
  }
  const layout = layouts[0]!;
  if (layouts.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(layout))) {
    throw new Error("Targeted verification commands disagree on source/output layout");
  }
  const sourcePrefix = `${layout.sourceRoot.replace(/\/$/, "")}/`;
  for (const path of sourcePaths) {
    const normalized = path.replaceAll("\\", "/");
    const extension = /\.(tsx?|mts|cts|m?jsx?)$/i.exec(normalized)?.[1]?.toLowerCase();
    if (!normalized.startsWith(sourcePrefix) || normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "..")) {
      throw new VerificationCapabilityMismatchError(
        "outside-source-root",
        `Targeted test '${path}' is outside the frozen TypeScript source root ${layout.sourceRoot}`,
        path,
      );
    }
    if (!extension || !VERIFICATION_TEST_EXTENSIONS.includes(`.${extension}` as typeof VERIFICATION_TEST_EXTENSIONS[number])) {
      throw new VerificationCapabilityMismatchError(
        "unsupported-extension",
        `Targeted test '${path}' must use one of ${VERIFICATION_TEST_EXTENSIONS.join(", ")}; JavaScript tests require a compatible legacy command`,
        path,
      );
    }
  }
  if (sourcePaths.length > MAX_VERIFICATION_TARGETS) {
    throw new VerificationCapabilityMismatchError(
      "target-limit",
      `Build Packet selects ${sourcePaths.length} test paths; targeted verification is bounded to ${MAX_VERIFICATION_TARGETS}`,
    );
  }
}

export interface ReadOnlyVerificationSourceOptions {
  /** Investigation surfaces are advisory read-only hints, unlike packet evidence. */
  readonly optionalCandidates?: readonly string[];
}

export async function resolveReadOnlyVerificationSources(
  candidates: readonly string[],
  targetedCommands: readonly Pick<VerificationCommand, "id" | "typescriptLayout">[],
  cwd: string,
  options: ReadOnlyVerificationSourceOptions = {},
): Promise<string[]> {
  if (!targetedCommands.length) return [];
  const layouts = targetedCommands.map((command) => command.typescriptLayout).filter((layout): layout is NonNullable<typeof layout> => Boolean(layout));
  if (layouts.length !== targetedCommands.length || layouts.some((candidate) => JSON.stringify(candidate) !== JSON.stringify(layouts[0]))) {
    throw new Error("Targeted verification commands disagree on source/output layout");
  }
  const layout = layouts[0]!;
  const sourceRoot = layout.sourceRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const files = await boundedTestFiles(join(cwd, sourceRoot), MAX_VERIFICATION_TARGETS * 8);
  const normalizedFiles = files.map((file) => `${sourceRoot}/${file}`.replace(/^\.\//, ""));
  const selected = new Set<string>();
  const allCandidates = [
    ...candidates.map((raw) => [raw, false] as const),
    ...(options.optionalCandidates ?? []).map((raw) => [raw, true] as const),
  ];
  for (const [raw, optional] of allCandidates) {
    const candidate = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!isExpectedTestPath(candidate)) continue;
    try {
      if (!candidate.includes("/")) {
        const matches = normalizedFiles.filter((file) => file.split("/").at(-1) === candidate);
        if (matches.length !== 1) {
          if (matches.length > 1) throw new VerificationCapabilityMismatchError("missing-target", `Ambiguous read-only verification target '${raw}'`, raw);
          if (matches.length === 0) throw new VerificationCapabilityMismatchError("missing-target", `Missing read-only verification target '${raw}'`, raw);
        }
        selected.add(matches[0]!);
      } else if (normalizedFiles.includes(candidate)) selected.add(candidate);
      else throw new VerificationCapabilityMismatchError("missing-target", `Missing read-only verification target '${raw}'`, raw);
    } catch (error) {
      if (optional && isVerificationCapabilityMismatchError(error) && error.code === "missing-target") continue;
      throw error;
    }
  }
  const sourcePaths = [...selected];
  validateVerificationTargetPaths(sourcePaths, targetedCommands);
  return sourcePaths;
}

export async function resolveReadOnlyVerificationTargets(
  candidates: readonly string[],
  targetedCommands: readonly Pick<VerificationCommand, "id" | "typescriptLayout">[],
  cwd: string,
): Promise<string[]> {
  const sources = await resolveReadOnlyVerificationSources(candidates, targetedCommands, cwd);
  return resolveVerificationTargets([], targetedCommands, sources);
}

async function boundedTestFiles(root: string, limit: number): Promise<string[]> {
  const result: string[] = [];
  let bytes = 0;
  const maxBytes = 4_000_000;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 12 || result.length >= limit || bytes >= maxBytes) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (result.length >= limit || entry.name.startsWith(".")) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(absolute, depth + 1); continue; }
      if (!entry.isFile() || !isExpectedTestPath(entry.name)) continue;
      try {
        const fileStat = await stat(absolute);
        if (fileStat.isFile() && fileStat.size <= maxBytes - bytes) {
          bytes += fileStat.size;
          result.push(relative(root, absolute).replaceAll("\\", "/"));
        }
      } catch { /* disappear during scan */ }
    }
  }
  await visit(root, 0);
  return result;
}

function compiledTestTarget(
  path: string,
  layout: NonNullable<VerificationCommand["typescriptLayout"]>,
): string {
  const normalized = path.replaceAll("\\", "/");
  const sourcePrefix = `${layout.sourceRoot.replace(/\/$/, "")}/`;
  validatePathShape(normalized, path, sourcePrefix, layout.sourceRoot);
  const extension = /\.(tsx?|mts|cts)$/i.exec(normalized)?.[1]?.toLowerCase();
  const compiledExtension = extension === "mts" ? "mjs" : extension === "cts" ? "cjs" : "js";
  return `${layout.outputRoot.replace(/\/$/, "")}/${normalized.slice(sourcePrefix.length).replace(/\.(?:tsx?|mts|cts)$/i, `.${compiledExtension}`)}`;
}

function validatePathShape(normalized: string, original: string, sourcePrefix: string, sourceRoot: string): void {
  if (!normalized.startsWith(sourcePrefix) || normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "..")) {
    throw new VerificationCapabilityMismatchError(
      "outside-source-root",
      `Targeted test '${original}' is outside the frozen TypeScript source root ${sourceRoot}`,
      original,
    );
  }
}
