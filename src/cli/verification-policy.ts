// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VerificationCommand } from "../core/ports/verification.js";

export const VERIFICATION_POLICY_VERSION = "forgedock.verification/v2";

export function discoverLegacyVerificationCommands(
  cwd: string,
  baseRef?: string,
): Array<Omit<VerificationCommand, "cwd">> {
  const manifest = readPackageManifest(cwd, baseRef);
  const scripts = manifest.scripts ?? {};
  const npm = npmInvocation();
  const commands: Array<Omit<VerificationCommand, "cwd">> = [
    { id: "diff-check", command: "git", args: ["diff", "--check"], timeoutMs: 2 * 60_000, required: true, selection: "always", evidenceCapability: "generic" },
  ];
  for (const script of ["lint", "typecheck", "check", "build", "docs:build", "test"] as const) {
    if (!scripts[script]) continue;
    commands.push({
      id: script,
      command: npm.command,
      args: script === "test" ? [...npm.prefix, "test"] : [...npm.prefix, "run", script],
      timeoutMs: script === "test" ? 20 * 60_000 : 10 * 60_000,
      required: true,
    });
  }
  if (commands.length === 1) throw new Error("Legacy durable verification plan has no compatible package command");
  const planId = createVerificationPlanId(baseRef, scripts, commands, "forgedock.verification/v1");
  return commands.map((command) => ({ ...command, planId }));
}

/**
 * Discover a bounded controller catalog. The catalog is deliberately not the
 * executable plan: a Build Packet selects packet-scoped checks later.
 */
export function discoverVerificationCommands(
  cwd: string,
  baseRef?: string,
): Array<Omit<VerificationCommand, "cwd">> {
  const manifest = readPackageManifest(cwd, baseRef);
  const scripts = manifest.scripts ?? {};
  const commands: Array<Omit<VerificationCommand, "cwd">> = [{
    id: "diff-check",
    command: "git",
    args: ["diff", "--check"],
    timeoutMs: 2 * 60_000,
    required: true,
    policyVersion: VERIFICATION_POLICY_VERSION,
    selection: "always",
    lockScope: "workspace",
    evidenceCapability: "generic",
  }];

  // This repository needs compile/type integrity, but ordinary issue delivery
  // must not inherit docs, lint, or full-suite scripts merely because they
  // exist in package.json. Prefer one bounded compile gate.
  const compile = discoverTypeIntegrityCommand(scripts);
  const typescriptLayout = compile ? discoverTypeScriptLayout(cwd, baseRef, compile.args) : undefined;
  if (compile) {
    commands.push({
      id: compile.id,
      command: process.execPath,
      args: [
        "node_modules/typescript/bin/tsc",
        ...compile.args,
        ...(typescriptLayout ? ["--outDir", typescriptLayout.outputRoot] : []),
      ],
      timeoutMs: 10 * 60_000,
      required: true,
      policyVersion: VERIFICATION_POLICY_VERSION,
      selection: "always",
      lockScope: "workspace",
      ...(typescriptLayout ? { typescriptLayout, cleanOutputRoot: typescriptLayout.outputRoot } : {}),
      evidenceCapability: "generic",
    });
  }

  // Targeting is controller-owned. Never use `npm test`, whose pretest/full
  // baseline behavior can broaden an ordinary issue into the whole repository.
  if (typescriptLayout && Object.values(scripts).some(isNodeTestScript)) {
    commands.push({
      id: "test",
      command: process.execPath,
      args: ["--test", "--test-concurrency=4"],
      timeoutMs: 10 * 60_000,
      required: true,
      policyVersion: VERIFICATION_POLICY_VERSION,
      selection: "packet",
      targeting: "expected-test-paths",
      lockScope: "workspace",
      typescriptLayout,
      evidenceCapability: "targeted-test",
    });
  }

  const catalogId = createVerificationPlanId(baseRef, scripts, commands);
  return commands.map((command) => ({ ...command, planId: catalogId }));
}

function discoverTypeIntegrityCommand(
  scripts: Record<string, string>,
): { id: "typecheck" | "check" | "build"; args: string[] } | undefined {
  for (const id of ["typecheck", "check", "build"] as const) {
    const tokens = scripts[id]?.trim().split(/\s+/) ?? [];
    if (tokens[0] !== "tsc") continue;
    const args = tokens.slice(1);
    if (args.every((argument) => /^[-A-Za-z0-9_./:@]+$/.test(argument))) return { id, args };
  }
  return undefined;
}

function discoverTypeScriptLayout(
  cwd: string,
  baseRef: string | undefined,
  compileArgs: readonly string[],
): { sourceRoot: string; outputRoot: string; project: string; configDigest: string } | undefined {
  if (compileArgs.includes("--noEmit") || compileArgs.includes("--no-emit")) return undefined;
  const projectIndex = compileArgs.findIndex((argument) => argument === "-p" || argument === "--project");
  const project = projectIndex >= 0 ? compileArgs[projectIndex + 1] : "tsconfig.json";
  if (!project || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_./-]+\.json$/.test(project)) return undefined;
  let config: { extends?: unknown; compilerOptions?: { rootDir?: unknown; outDir?: unknown; noEmit?: unknown } };
  let source: string;
  try {
    source = readRepositoryFile(cwd, project, baseRef);
    config = JSON.parse(source) as typeof config;
  } catch {
    return undefined;
  }
  if (config.extends !== undefined || config.compilerOptions?.noEmit === true) return undefined;
  const sourceRoot = normalizedLayoutRoot(config.compilerOptions?.rootDir);
  const configuredOutput = normalizedLayoutRoot(config.compilerOptions?.outDir);
  if (!sourceRoot || !configuredOutput) return undefined;
  return {
    sourceRoot,
    outputRoot: ".forgedock/verification-dist",
    project,
    configDigest: createHash("sha256").update(source).digest("hex").slice(0, 16),
  };
}

function normalizedLayoutRoot(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return normalized;
}

function readRepositoryFile(cwd: string, path: string, baseRef?: string): string {
  return baseRef
    ? execFileSync("git", ["show", `${baseRef}:${path}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    : readFileSync(join(cwd, path), "utf8");
}

function isNodeTestScript(source: string): boolean {
  return /(?:^|&&|\|\|)\s*node(?:\.exe)?\s+--test(?:\s|$)/.test(source);
}

function createVerificationPlanId(
  baseRef: string | undefined,
  scripts: Record<string, string>,
  commands: readonly Pick<VerificationCommand, "id" | "command" | "args" | "timeoutMs" | "required">[],
  policyVersion = VERIFICATION_POLICY_VERSION,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      policyVersion,
      baseRef: baseRef ?? "working-tree",
      scripts: Object.fromEntries(Object.keys(scripts).sort().map((key) => [key, scripts[key]])),
      commands,
    }))
    .digest("hex")
    .slice(0, 16);
}

function readPackageManifest(cwd: string, baseRef?: string): { scripts?: Record<string, string> } {
  let source: string;
  try {
    source = baseRef
      ? execFileSync("git", ["show", `${baseRef}:package.json`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      : readFileSync(join(cwd, "package.json"), "utf8");
  } catch (error) {
    const location = baseRef ? `${baseRef}:package.json` : join(cwd, "package.json");
    throw new Error(`No verification policy found at ${location}. The initial CLI auto-detects bounded package build/test capabilities only.`, { cause: error });
  }
  try {
    return JSON.parse(source) as { scripts?: Record<string, string> };
  } catch (error) {
    throw new Error(`Invalid package.json verification policy${baseRef ? ` at ${baseRef}` : ""}`, { cause: error });
  }
}

function npmInvocation(): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command: "npm", prefix: [] };
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((value): value is string => Boolean(value));
  const cli = candidates.find(existsSync);
  if (!cli) throw new Error("Unable to locate npm-cli.js for shell-free verification on Windows");
  return { command: process.execPath, prefix: [cli] };
}
