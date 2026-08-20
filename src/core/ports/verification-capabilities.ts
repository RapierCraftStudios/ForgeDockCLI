// SPDX-License-Identifier: AGPL-3.0-or-later

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
): string[] {
  const sourcePaths = expectedPaths.filter(isExpectedTestPath);
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
