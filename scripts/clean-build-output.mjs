#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Remove only the root TypeScript build output.
 *
 * Keeping the root explicit prevents a build cleanup from reaching into
 * vendor/pi or any other generated tree owned by a nested package.
 */
export function cleanBuildOutput(root = repositoryRoot) {
  rmSync(resolve(root, "dist"), { recursive: true, force: true });
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  cleanBuildOutput();
}
