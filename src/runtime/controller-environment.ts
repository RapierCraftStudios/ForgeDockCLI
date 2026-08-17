// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

const AGENT_TRANSPORT_PREFIXES = ["PI_SUBAGENT_", "PI_SUBAGENTS_"] as const;
export const FORGEDOCK_VERIFICATION_PATH = "FORGEDOCK_VERIFICATION_PATH";
const FORGEDOCK_VERIFICATION_HOME = "FORGEDOCK_VERIFICATION_HOME_V1";
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
  for (const name of Object.keys(clean)) {
    if (isSensitiveVerificationVariable(name, clean[name])) delete clean[name];
  }
  if (process.platform !== "win32") return isolateVerificationHome(clean);

  const gitRoot = discoverGitForWindowsRoot(clean);
  const userHome = environmentValue(clean, "USERPROFILE") ?? homedir();
  const programFiles = environmentValue(clean, "ProgramFiles");
  const programData = environmentValue(clean, "ProgramData") ?? environmentValue(clean, "ALLUSERSPROFILE");
  const localAppData = environmentValue(clean, "LOCALAPPDATA");
  const sealedEntries = pathEntries(environmentValue(clean, FORGEDOCK_VERIFICATION_PATH));
  const discoveredCandidates = [
    gitRoot && join(gitRoot, "usr", "bin"),
    gitRoot && join(gitRoot, "mingw64", "bin"),
    join(userHome, "bin"),
    join(userHome, "scoop", "shims"),
    programFiles && join(programFiles, "GitHub CLI"),
    programData && join(programData, "chocolatey", "bin"),
    localAppData && join(localAppData, "Microsoft", "WinGet", "Links"),
  ].filter((value): value is string => typeof value === "string" && existsSync(value));
  const candidates = [...sealedEntries, ...discoveredCandidates];

  const inheritedEntries = pathEntries(environmentValue(clean, "PATH"));
  setEnvironmentValue(clean, "PATH", uniquePathEntries([...candidates, ...inheritedEntries]).join(delimiter));
  if (gitRoot) {
    clean.FORGEDOCK_GIT_BASH = join(gitRoot, "usr", "bin", "bash.exe");
    // Git for Windows' bash.exe does not populate MSYSTEM when started directly
    // from cmd/PowerShell. Mark the verified 64-bit Git toolchain explicitly so
    // headed and Git-Bash-launched verification descendants observe one contract.
    if (!environmentValue(clean, "MSYSTEM")) clean.MSYSTEM = "MINGW64";
  }
  if (!environmentValue(clean, "USERPROFILE")) clean.USERPROFILE = userHome;
  return isolateVerificationHome(clean);
}

/**
 * Freeze the dynamically discovered verification toolchain before entering Pi.
 * Descendants may replace PATH for a probe, but their verifier can always
 * reconstruct the same package-safe prefix from this inherited manifest.
 */
export function sealVerificationEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scoped = { ...environment };
  for (const name of Object.keys(scoped)) {
    if (name.toUpperCase() === FORGEDOCK_VERIFICATION_HOME) delete scoped[name];
  }
  scoped[FORGEDOCK_VERIFICATION_HOME] = mkdtempSync(join(tmpdir(), "forgedock-verification-home-"));
  const sealed = verificationEnvironment(scoped);
  const path = environmentValue(sealed, "PATH");
  if (path) sealed[FORGEDOCK_VERIFICATION_PATH] = path;
  return sealed;
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

function pathEntries(value: string | undefined): string[] {
  return (value ?? "").split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function uniquePathEntries(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const entry of entries) {
    const key = process.platform === "win32" ? entry.replace(/[\\/]+$/, "").toLowerCase() : entry.replace(/\/+$/, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique;
}

function isolateVerificationHome(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const root = environmentValue(environment, FORGEDOCK_VERIFICATION_HOME)
    ?? mkdtempSync(join(tmpdir(), "forgedock-verification-home-"));
  environment[FORGEDOCK_VERIFICATION_HOME] = root;
  mkdirSync(root, { recursive: true });
  const config = join(root, ".config");
  const appData = join(root, "AppData", "Roaming");
  const localAppData = join(root, "AppData", "Local");
  for (const path of [config, appData, localAppData]) mkdirSync(path, { recursive: true });
  setEnvironmentValue(environment, "HOME", root);
  setEnvironmentValue(environment, "USERPROFILE", root);
  setEnvironmentValue(environment, "XDG_CONFIG_HOME", config);
  setEnvironmentValue(environment, "APPDATA", appData);
  setEnvironmentValue(environment, "LOCALAPPDATA", localAppData);
  setEnvironmentValue(environment, "GH_CONFIG_DIR", join(config, "gh"));
  setEnvironmentValue(environment, "DOCKER_CONFIG", join(config, "docker"));
  setEnvironmentValue(environment, "AZURE_CONFIG_DIR", join(config, "azure"));
  setEnvironmentValue(environment, "GNUPGHOME", join(config, "gnupg"));
  setEnvironmentValue(environment, "NPM_CONFIG_USERCONFIG", join(root, ".npmrc"));
  const gitConfig = join(root, ".gitconfig");
  writeFileSync(gitConfig, [
    "[user]",
    "\tname = ForgeDock Verification",
    "\temail = verification@forgedock.invalid",
    "[commit]",
    "\tgpgSign = false",
    "[tag]",
    "\tgpgSign = false",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  setEnvironmentValue(environment, "GIT_CONFIG_GLOBAL", gitConfig);
  return environment;
}

function isSensitiveVerificationVariable(name: string, value: string | undefined): boolean {
  const upperName = name.toUpperCase();
  const normalized = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const segments = upperName.split(/[^A-Z0-9]+/).filter(Boolean);
  const credentialConfigVariables = new Set([
    "DOCKER_CONFIG", "KUBECONFIG", "NETRC", "PIP_CONFIG_FILE",
    "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "GOOGLE_APPLICATION_CREDENTIALS",
    "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH_COMMAND",
  ]);
  const executableLoaderVariables = new Set([
    "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV", "ZDOTDIR",
    "PYTHONHOME", "PYTHONPATH", "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB",
    "LUA_PATH", "LUA_CPATH", "GIT_EXEC_PATH",
  ]);
  return credentialConfigVariables.has(upperName)
    || executableLoaderVariables.has(upperName)
    || upperName.startsWith("GIT_CONFIG_")
    || upperName.startsWith("NPM_CONFIG_")
    || [
    "TOKEN", "SECRET", "PASSWORD", "PASSWD", "APIKEY", "PRIVATEKEY",
    "ACCESSKEY", "CREDENTIAL", "AUTH", "COOKIE", "JWT",
  ].some((marker) => normalized.includes(marker))
    || segments.includes("PAT")
    || (value !== undefined && /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(value));
}

function setEnvironmentValue(environment: NodeJS.ProcessEnv, name: string, value: string): void {
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === name.toLowerCase()) delete environment[key];
  }
  environment[name] = value;
}

export function isAgentTransportVariable(name: string): boolean {
  const normalized = name.toUpperCase();
  return AGENT_TRANSPORT_KEYS.has(normalized)
    || AGENT_TRANSPORT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
