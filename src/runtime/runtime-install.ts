// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME_PACKAGE = "@earendil-works/pi-coding-agent";
const UNDICI_PACKAGE = "undici";

export interface RuntimeInstallSnapshot {
  runtimeEntry: string;
  dispatcherEntry: string;
  undiciEntry: string;
  undiciPackageRoot: string;
  undiciVersion?: string;
}

/**
 * A controller may load the Pi fork lazily (for example, when the first
 * reviewer starts).  Do not let a broken npm tree surface as an issue/build
 * failure after a Build Packet has already been committed.
 *
 * This check is deliberately read-only.  Repairing a live checkout with npm
 * would delete node_modules while another controller can still be importing
 * it.  The launcher and every Pi runtime preflight call this invariant before
 * semantic work is dispatched.
 */
export function assertRuntimeInstall(): RuntimeInstallSnapshot {
  const runtimeEntry = resolvePackageEntry(RUNTIME_PACKAGE, "ForgeDock Pi runtime");
  assertFile(runtimeEntry, "ForgeDock Pi runtime entry");

  const runtimeRoot = dirname(dirname(runtimeEntry));
  const dispatcherEntry = join(runtimeRoot, "dist", "core", "http-dispatcher.js");
  assertFile(dispatcherEntry, "ForgeDock HTTP dispatcher");

  const undiciEntry = resolvePackageEntry(UNDICI_PACKAGE, "Pi HTTP dependency", pathToFileURL(dispatcherEntry).href);
  assertFile(undiciEntry, "undici package entry");
  const undiciPackageRoot = findPackageRoot(undiciEntry);
  const manifestPath = join(undiciPackageRoot, "package.json");
  assertFile(manifestPath, "undici package manifest");

  let manifest: { name?: unknown; version?: unknown; main?: unknown };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
  } catch (error) {
    throw incompleteInstall(`cannot read ${manifestPath}`, error);
  }
  if (manifest.name !== UNDICI_PACKAGE) {
    throw incompleteInstall(`resolved ${UNDICI_PACKAGE} to a package named ${String(manifest.name ?? "unknown")} at ${undiciPackageRoot}`);
  }
  if (typeof manifest.main === "string") {
    assertFile(join(undiciPackageRoot, manifest.main), `undici main entry (${manifest.main})`);
  }
  assertBundleMetadata();

  return {
    runtimeEntry,
    dispatcherEntry,
    undiciEntry,
    undiciPackageRoot,
    ...(typeof manifest.version === "string" ? { undiciVersion: manifest.version } : {}),
  };
}

/** Load the dispatcher once during controller preflight so truncated files and
 * broken transitive imports fail before any semantic workflow phase starts. */
export async function assertRuntimeInstallAsync(): Promise<RuntimeInstallSnapshot> {
  const snapshot = assertRuntimeInstall();
  await assertRuntimeDispatcherLoad(snapshot.dispatcherEntry);
  return snapshot;
}

/** Smoke-load a resolved dispatcher path. Exported so tests can exercise the
 * same failure boundary with an isolated, truncated dependency fixture. */
export async function assertRuntimeDispatcherLoad(dispatcherEntry: string): Promise<void> {
  try {
    await import(pathToFileURL(dispatcherEntry).href);
  } catch (error) {
    throw incompleteInstall(`the staged HTTP dispatcher or one of its imports cannot be loaded from ${dispatcherEntry}`, error);
  }
}

function resolvePackageEntry(specifier: string, label: string, parent = import.meta.url): string {
  try {
    return fileURLToPath(import.meta.resolve(specifier, parent));
  } catch (error) {
    throw incompleteInstall(`cannot resolve ${label} package '${specifier}' from ${parent}`, error);
  }
}

function findPackageRoot(entry: string): string {
  let current = dirname(entry);
  for (;;) {
    const manifest = join(current, "package.json");
    if (existsSync(manifest)) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw incompleteInstall(`cannot find a package.json above resolved undici entry ${entry}`);
    }
    current = parent;
  }
}

function assertBundleMetadata(): void {
  const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const lockPath = join(projectRoot, "package-lock.json");
  if (!existsSync(lockPath)) return;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
      packages?: Record<string, { bundleDependencies?: unknown; dependencies?: Record<string, unknown>; inBundle?: unknown }>;
    };
    const root = lock.packages?.[""];
    const bundled = Array.isArray(root?.bundleDependencies) ? root.bundleDependencies : [];
    const undici = lock.packages?.["node_modules/undici"];
    if (root?.dependencies?.undici !== undefined && (!bundled.includes(UNDICI_PACKAGE) || undici?.inBundle !== true)) {
      throw incompleteInstall(`package-lock.json does not mark ${UNDICI_PACKAGE} as bundled; regenerate the lockfile from package.json`);
    }
  } catch (error) {
    if (error instanceof RuntimeInstallError) throw error;
    throw incompleteInstall(`cannot inspect ${lockPath}`, error);
  }
}

function assertFile(path: string, label: string): void {
  try {
    if (!statSync(path).isFile()) throw new Error("is not a regular file");
  } catch (error) {
    throw incompleteInstall(`${label} is missing or unusable at ${path}`, error);
  }
}

function incompleteInstall(detail: string, cause?: unknown): RuntimeInstallError {
  return new RuntimeInstallError(
    `ForgeDock runtime installation is incomplete: ${detail}. `
      + "Stop active ForgeDock controllers, repair the checkout with "
      + "'npm ci --ignore-scripts --no-audit --no-fund' and 'npm run build', then restart. "
      + "Do not run npm ci in a live controller checkout.",
    cause === undefined ? undefined : { cause },
  );
}

export class RuntimeInstallError extends Error {
  readonly code = "FORGEDOCK_RUNTIME_INSTALL_INCOMPLETE";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RuntimeInstallError";
  }
}
