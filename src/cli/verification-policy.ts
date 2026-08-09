// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { VerificationCommand } from "../core/ports/verification.js";

export function discoverVerificationCommands(
  cwd: string,
  baseRef?: string,
): Array<Omit<VerificationCommand, "cwd">> {
  const manifest = readPackageManifest(cwd, baseRef);
  const scripts = manifest.scripts ?? {};
  const npm = npmInvocation();
  const commands: Array<Omit<VerificationCommand, "cwd">> = [
    { id: "diff-check", command: "git", args: ["diff", "--check"], timeoutMs: 2 * 60_000, required: true },
  ];
  const scriptOrder = ["lint", "typecheck", "check", "build", "docs:build", "test"] as const;
  for (const script of scriptOrder) {
    if (!scripts[script]) continue;
    commands.push({
      id: script,
      command: npm.command,
      args: script === "test" ? [...npm.prefix, "test"] : [...npm.prefix, "run", script],
      timeoutMs: script === "test" ? 20 * 60_000 : 10 * 60_000,
      required: true,
    });
  }
  if (commands.length === 1) {
    throw new Error("No required package verification commands detected; define a lint, typecheck, check, build, docs:build, or test script");
  }
  const planId = createVerificationPlanId(baseRef, scripts, commands);
  // Every frozen command executes independently. Inferring nested coverage from
  // shell text is unsafe: an echo/comment can mention a command without running it.
  return commands.map((command) => ({ ...command, planId }));
}

function createVerificationPlanId(baseRef: string | undefined, scripts: Record<string, string>, commands: readonly Pick<VerificationCommand, "id" | "command" | "args" | "timeoutMs" | "required">[]): string {
  return createHash("sha256")
    .update(JSON.stringify({
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
      ? execFileSync("git", ["show", `${baseRef}:package.json`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      : readFileSync(join(cwd, "package.json"), "utf8");
  } catch (error) {
    const location = baseRef ? `${baseRef}:package.json` : join(cwd, "package.json");
    throw new Error(`No verification policy found at ${location}. The initial CLI auto-detects package.json build/test scripts only.`, { cause: error });
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
