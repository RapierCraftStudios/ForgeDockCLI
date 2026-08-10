#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REQUIRED = [22, 19, 0];

if (!isSupported(process.versions.node)) {
  const replacement = findCompatibleNode();
  if (replacement && process.env.FORGEDOCK_NODE_REEXEC !== "1") {
    const child = spawnSync(replacement, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, FORGEDOCK_NODE_REEXEC: "1" },
      windowsHide: false,
    });
    if (child.error) throw child.error;
    if (child.signal) {
      console.error(`ForgeDock runtime terminated by ${child.signal}`);
      process.exitCode = 1;
    } else {
      process.exitCode = child.status ?? 1;
    }
  } else {
    console.error(`ForgeDock requires Node >=${REQUIRED.join(".")}; current Node is ${process.versions.node}.`);
    console.error("Install a current Node 22 release or set FORGEDOCK_NODE to a compatible executable.");
    process.exitCode = 1;
  }
} else {
  let runtimeError;
  try {
    const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const dispatcherEntry = join(dirname(packageEntry), "core", "http-dispatcher.js");
    if (!existsSync(dispatcherEntry)) throw new Error(`ForgeDock runtime installation is incomplete: HTTP dispatcher is missing at ${dispatcherEntry}. Stop active ForgeDock controllers, repair the checkout with 'npm ci --ignore-scripts --no-audit --no-fund' and 'npm run build', then restart. Do not run npm ci in a live controller checkout.`);
    const undiciEntry = fileURLToPath(import.meta.resolve("undici", pathToFileURL(dispatcherEntry).href));
    if (!existsSync(undiciEntry)) throw new Error(`ForgeDock runtime installation is incomplete: undici resolves to a missing file ${undiciEntry}. Stop active ForgeDock controllers, repair the checkout with 'npm ci --ignore-scripts --no-audit --no-fund' and 'npm run build', then restart. Do not run npm ci in a live controller checkout.`);
    await import(pathToFileURL(dispatcherEntry).href);
  } catch (error) {
    runtimeError = error;
  }
  if (runtimeError) {
    console.error(runtimeError instanceof Error ? runtimeError.message : String(runtimeError));
    process.exitCode = 1;
  } else try {
    await import("../dist/cli/main.js");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes("dist/cli/main.js")) {
      console.error("ForgeDock Next has not been built. Run `npm run build` first.");
      process.exitCode = 1;
    } else {
      throw error;
    }
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
