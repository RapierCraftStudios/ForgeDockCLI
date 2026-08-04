#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED = [22, 19, 0];
const self = fileURLToPath(import.meta.url);

if (!isSupported(process.versions.node)) {
  const replacement = findCompatibleNode();
  if (replacement && process.env.FORGEDOCK_NODE_REEXEC !== "1") {
    const child = spawnSync(replacement, [self, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, FORGEDOCK_NODE_REEXEC: "1" },
      windowsHide: false,
    });
    if (child.error) throw child.error;
    process.exitCode = child.signal ? 1 : child.status ?? 1;
  } else {
    console.error(`ForgeDock requires Node >=${REQUIRED.join(".")}; current Node is ${process.versions.node}.`);
    process.exitCode = 1;
  }
} else {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const terminalEntry = join(dirname(packageEntry), "cli.js");
  const subagentsEntry = fileURLToPath(import.meta.resolve("pi-subagents"));
  const controllerEntry = resolve(dirname(self), "forgedock-next.mjs");
  const packageRoot = resolve(dirname(self), "..");
  const extensionEntry = resolve(packageRoot, "dist", "tui", "forgedock-extension.js");
  const workerAgentModule = resolve(packageRoot, "dist", "tui", "worker-agent.js");
  const configModule = resolve(packageRoot, "dist", "core", "config", "forgedock-config.js");
  const environmentModule = resolve(packageRoot, "dist", "runtime", "controller-environment.js");
  const workerAgentTemplate = resolve(packageRoot, "agents", "forgedock-issue-worker.md");
  const reviewerAgentTemplate = resolve(packageRoot, "agents", "forgedock-reviewer.md");
  if (!existsSync(terminalEntry) || !existsSync(extensionEntry) || !existsSync(workerAgentModule) || !existsSync(configModule) || !existsSync(environmentModule) || !existsSync(workerAgentTemplate) || !existsSync(reviewerAgentTemplate) || !existsSync(subagentsEntry)) {
    console.error("ForgeDock terminal has not been built. Run `npm run build:pi && npm run build` first.");
    process.exitCode = 1;
  } else {
    const cliArgs = process.argv.slice(2);
    if (shouldBootstrapProject(cliArgs)) {
      try {
        const { ensureForgeDockConfig } = await import(pathToFileURL(configModule).href);
        ensureForgeDockConfig(process.cwd());
      } catch (error) {
        console.error(`ForgeDock warning: could not create forge.yaml: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    refreshConfiguredGitHubApp(packageRoot, cliArgs);
    const { verificationEnvironment } = await import(pathToFileURL(environmentModule).href);
    const discoveredEnvironment = verificationEnvironment(process.env);
    if (discoveredEnvironment.PATH) process.env.PATH = discoveredEnvironment.PATH;
    if (discoveredEnvironment.FORGEDOCK_GIT_BASH) process.env.FORGEDOCK_GIT_BASH = discoveredEnvironment.FORGEDOCK_GIT_BASH;
    const { materializeWorkerAgent } = await import(pathToFileURL(workerAgentModule).href);
    const workerAgent = materializeWorkerAgent(workerAgentTemplate, extensionEntry, [reviewerAgentTemplate]);
    // Async issue workers and their nested reviewers may outlive a non-interactive
    // parent process. Keep this small materialized directory alive for inherited
    // PI_SUBAGENT_EXTRA_AGENT_DIRS; OS temp cleanup reclaims it later.
    process.env.FORGEDOCK_CONTROLLER_ENTRY = controllerEntry;
    process.env.FORGEDOCK_RUNTIME_ROOT = packageRoot;
    process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = [workerAgent.directory, process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS]
      .filter(Boolean)
      .join(delimiter);
    process.argv.splice(2, 0, "--extension", subagentsEntry, "--extension", extensionEntry);
    await import(pathToFileURL(terminalEntry).href);
  }
}

function shouldBootstrapProject(args) {
  return !args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v");
}

function refreshConfiguredGitHubApp(packageRoot, args) {
  const pem = process.env.FORGEDOCK_APP_PEM;
  const nonInteractive = args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-v") || args.includes("--mode") || args.includes("--print") || args.includes("-p");
  if (!pem || nonInteractive) return;
  const refreshScript = resolve(packageRoot, "scripts", "refresh-bot-token.mjs");
  if (!existsSync(pem) || !existsSync(refreshScript)) return;
  const refreshed = spawnSync(process.execPath, [refreshScript, "--pem", pem], {
    cwd: packageRoot,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  if (refreshed.status !== 0) {
    const detail = (refreshed.stderr || refreshed.stdout || "unknown error").trim();
    console.error(`ForgeDock warning: GitHub App credential refresh failed: ${detail}`);
  }
}

function isSupported(version) {
  const parts = version.split(".").map(Number);
  for (let index = 0; index < REQUIRED.length; index++) {
    const actual = parts[index] ?? 0;
    if (actual > REQUIRED[index]) return true;
    if (actual < REQUIRED[index]) return false;
  }
  return true;
}

function findCompatibleNode() {
  const candidates = [];
  if (process.env.FORGEDOCK_NODE) candidates.push(process.env.FORGEDOCK_NODE);
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const root = join(process.env.LOCALAPPDATA, "Programs", "nodejs");
    if (existsSync(root)) {
      const versions = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ entry, match: /^node-v(\d+\.\d+\.\d+)-win-x64$/.exec(entry.name) }))
        .filter((value) => value.match !== null)
        .map((value) => ({ name: value.entry.name, version: value.match[1] }))
        .filter((entry) => isSupported(entry.version))
        .sort((left, right) => compareVersions(right.version, left.version));
      for (const entry of versions) candidates.push(join(root, entry.name, "node.exe"));
    }
    candidates.push(join(process.env.LOCALAPPDATA, "pi-node", "current", "node.exe"));
  }
  return candidates.find((candidate) => existsSync(candidate) && resolve(candidate).toLowerCase() !== resolve(process.execPath).toLowerCase());
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}
