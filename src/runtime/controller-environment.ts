// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

const AGENT_TRANSPORT_PREFIXES = ["PI_SUBAGENT_", "PI_SUBAGENTS_"] as const;
const AGENT_TRANSPORT_KEYS = new Set([
  "PI_INTERCOM_SESSION_ID",
]);

/**
 * Child-agent routing belongs only to the Pi worker process that received it.
 * Controllers and their verification descendants must not inherit that role,
 * otherwise application tests observe ForgeDock's orchestration transport.
 */
export function controllerEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return withoutAgentTransportEnvironment({ ...base, ...overrides });
}

export function withoutAgentTransportEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || isAgentTransportVariable(name)) continue;
    clean[name] = value;
  }
  return clean;
}

/**
 * Normalize headed verification so `bash` cannot resolve WSL in one launcher
 * and Git Bash in another. Discovery is installation-neutral: explicit env,
 * inherited PATH, Git for Windows registry metadata, and environment-derived
 * user/tool roots. ForgeDock does not install or emulate missing tools.
 */
export function verificationEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = withoutAgentTransportEnvironment(environment);
  if (process.platform !== "win32") return clean;

  const gitRoot = discoverGitForWindowsRoot(clean);
  const userHome = environmentValue(clean, "USERPROFILE") ?? homedir();
  const programFiles = environmentValue(clean, "ProgramFiles");
  const programData = environmentValue(clean, "ProgramData") ?? environmentValue(clean, "ALLUSERSPROFILE");
  const localAppData = environmentValue(clean, "LOCALAPPDATA");
  const candidates = [
    gitRoot && join(gitRoot, "usr", "bin"),
    gitRoot && join(gitRoot, "mingw64", "bin"),
    join(userHome, "bin"),
    join(userHome, "scoop", "shims"),
    programFiles && join(programFiles, "GitHub CLI"),
    programData && join(programData, "chocolatey", "bin"),
    localAppData && join(localAppData, "Microsoft", "WinGet", "Links"),
  ].filter((value): value is string => typeof value === "string" && existsSync(value));

  const inheritedPath = environmentValue(clean, "PATH");
  clean.PATH = [...new Set([...candidates, ...(inheritedPath ? [inheritedPath] : [])])].join(delimiter);
  if (gitRoot) clean.FORGEDOCK_GIT_BASH = join(gitRoot, "usr", "bin", "bash.exe");
  return clean;
}

function discoverGitForWindowsRoot(environment: NodeJS.ProcessEnv): string | undefined {
  const explicitBash = environmentValue(environment, "FORGEDOCK_GIT_BASH");
  if (explicitBash && existsSync(explicitBash)) {
    const root = gitRootFromBash(explicitBash);
    if (root) return root;
  }

  const candidateRoots: string[] = [];
  const programFiles = environmentValue(environment, "ProgramFiles");
  const programFilesX86 = environmentValue(environment, "ProgramFiles(x86)");
  const localAppData = environmentValue(environment, "LOCALAPPDATA");
  if (programFiles) candidateRoots.push(join(programFiles, "Git"));
  if (programFilesX86) candidateRoots.push(join(programFilesX86, "Git"));
  if (localAppData) candidateRoots.push(join(localAppData, "Programs", "Git"));

  for (const gitPath of whereExecutables("git", environment)) {
    candidateRoots.push(...ancestorDirectories(gitPath, 6));
  }
  candidateRoots.push(...gitRootsFromRegistry(environment));
  return [...new Set(candidateRoots)].find((root) => existsSync(join(root, "usr", "bin", "bash.exe")));
}

function whereExecutables(name: string, environment: NodeJS.ProcessEnv): string[] {
  const systemRoot = environmentValue(environment, "SystemRoot");
  const where = systemRoot ? join(systemRoot, "System32", "where.exe") : "where.exe";
  try {
    const result = spawnSync(where, [name], { encoding: "utf8", windowsHide: true, env: environment, timeout: 5_000 });
    if (result.status !== 0) return [];
    return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function gitRootsFromRegistry(environment: NodeJS.ProcessEnv): string[] {
  const systemRoot = environmentValue(environment, "SystemRoot");
  const registry = systemRoot ? join(systemRoot, "System32", "reg.exe") : "reg.exe";
  const roots: string[] = [];
  for (const key of ["HKCU\\SOFTWARE\\GitForWindows", "HKLM\\SOFTWARE\\GitForWindows"]) {
    try {
      const result = spawnSync(registry, ["query", key, "/v", "InstallPath"], {
        encoding: "utf8", windowsHide: true, env: environment, timeout: 5_000,
      });
      if (result.status !== 0) continue;
      const match = result.stdout.match(/InstallPath\s+REG_\w+\s+([^\r\n]+)/i);
      if (match?.[1]) roots.push(match[1].trim());
    } catch {
      // Registry discovery is one optional source; continue with the others.
    }
  }
  return roots;
}

function ancestorDirectories(path: string, limit: number): string[] {
  const values: string[] = [];
  let current = dirname(path);
  for (let depth = 0; depth < limit; depth++) {
    values.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return values;
}

function gitRootFromBash(bash: string): string | undefined {
  const directory = dirname(bash);
  const parent = dirname(directory);
  if (basename(parent).toLowerCase() === "usr") return dirname(parent);
  if (basename(directory).toLowerCase() === "bin") return parent;
  return ancestorDirectories(bash, 5).find((root) => existsSync(join(root, "usr", "bin", "bash.exe")));
}

function environmentValue(environment: NodeJS.ProcessEnv, requestedName: string): string | undefined {
  const key = Object.keys(environment).find((name) => name.toLowerCase() === requestedName.toLowerCase());
  return key ? environment[key] : undefined;
}

export function isAgentTransportVariable(name: string): boolean {
  return AGENT_TRANSPORT_KEYS.has(name)
    || AGENT_TRANSPORT_PREFIXES.some((prefix) => name.startsWith(prefix));
}
