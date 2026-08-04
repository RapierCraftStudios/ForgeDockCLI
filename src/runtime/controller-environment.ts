// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

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

/** Normalize headed verification so bare `bash` cannot resolve WSL in one
 * launcher and Git Bash in another. Missing Git Bash remains the project's
 * responsibility; ForgeDock does not silently install or emulate it. */
export function verificationEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean = withoutAgentTransportEnvironment(environment);
  if (process.platform !== "win32") return clean;
  const programFiles = environmentValue(clean, "ProgramFiles");
  const programFilesX86 = environmentValue(clean, "ProgramFiles(x86)");
  const localAppData = environmentValue(clean, "LOCALAPPDATA");
  const roots = [
    programFiles && join(programFiles, "Git"),
    programFilesX86 && join(programFilesX86, "Git"),
    localAppData && join(localAppData, "Programs", "Git"),
  ].filter((value): value is string => Boolean(value));
  const gitRoot = roots.find((root) => existsSync(join(root, "usr", "bin", "bash.exe")));
  if (!gitRoot) return clean;
  clean.PATH = [join(gitRoot, "usr", "bin"), join(gitRoot, "mingw64", "bin"), clean.PATH]
    .filter(Boolean).join(delimiter);
  return clean;
}

function environmentValue(environment: NodeJS.ProcessEnv, requestedName: string): string | undefined {
  const key = Object.keys(environment).find((name) => name.toLowerCase() === requestedName.toLowerCase());
  return key ? environment[key] : undefined;
}

export function isAgentTransportVariable(name: string): boolean {
  return AGENT_TRANSPORT_KEYS.has(name)
    || AGENT_TRANSPORT_PREFIXES.some((prefix) => name.startsWith(prefix));
}
