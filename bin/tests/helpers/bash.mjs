// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";

/**
 * Resolve the Bash implementation expected by ForgeDock's legacy shell tests.
 * Bare `bash` is unsafe on Windows because a PowerShell/cmd launch can resolve
 * System32/bash.exe (WSL) while a Git Bash launch resolves Git's bash.exe.
 * The tests pass native Windows paths and therefore require Git Bash.
 */
export function resolveTestBash(environment = process.env) {
  if (process.platform !== "win32") return environment.FORGEDOCK_TEST_BASH || "bash";

  const explicit = environment.FORGEDOCK_TEST_BASH;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`FORGEDOCK_TEST_BASH does not exist: ${explicit}`);
    return explicit;
  }

  const candidates = [];
  const programFiles = environmentValue(environment, "ProgramFiles");
  const programFilesX86 = environmentValue(environment, "ProgramFiles(x86)");
  const localAppData = environmentValue(environment, "LOCALAPPDATA");
  for (const root of [
    programFiles && join(programFiles, "Git"),
    programFilesX86 && join(programFilesX86, "Git"),
    localAppData && join(localAppData, "Programs", "Git"),
  ].filter(Boolean)) {
    candidates.push(join(root, "usr", "bin", "bash.exe"), join(root, "bin", "bash.exe"));
  }

  try {
    const gitPaths = execFileSync("where.exe", ["git"], { encoding: "utf8", windowsHide: true, env: environment })
      .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    for (const gitPath of gitPaths) {
      let ancestor = dirname(gitPath);
      for (let depth = 0; depth < 4; depth++) {
        candidates.push(join(ancestor, "usr", "bin", "bash.exe"), join(ancestor, "bin", "bash.exe"));
        ancestor = dirname(ancestor);
      }
    }
  } catch {
    // PATH discovery is optional; environment-derived roots remain available.
  }

  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (resolved) return resolved;
  throw new Error("ForgeDock shell tests require Git Bash on Windows. Install Git for Windows or set FORGEDOCK_TEST_BASH to its bash.exe path.");
}

function environmentValue(environment, requestedName) {
  const key = Object.keys(environment).find((name) => name.toLowerCase() === requestedName.toLowerCase());
  return key ? environment[key] : undefined;
}

export function testBashEnvironment(environment = process.env, bash = resolveTestBash(environment)) {
  if (process.platform !== "win32") return { ...environment };
  const bashDirectory = dirname(bash);
  const parent = dirname(bashDirectory);
  const gitRoot = basename(parent).toLowerCase() === "usr" ? dirname(parent) : parent;
  const path = [bashDirectory, join(gitRoot, "mingw64", "bin"), environment.PATH].filter(Boolean).join(delimiter);
  return { ...environment, PATH: path };
}
