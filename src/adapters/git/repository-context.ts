// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CheckoutContextSource =
  | "current-checkout"
  | "matching-child-checkout"
  | "only-child-checkout"
  | "launch-directory";

export interface CheckoutContext {
  launchCwd: string;
  checkoutRoot: string;
  repository?: string;
  targetRepository?: string;
  source: CheckoutContextSource;
}

export interface ResolveCheckoutContextOptions {
  /** Read-only GitHub clients may operate against an explicit remote without a local checkout. */
  allowUnresolvedTarget?: boolean;
  /** Preserve a launch-directory fallback for non-mutating callers when discovery is ambiguous. */
  allowAmbiguous?: boolean;
}

export class CheckoutContextError extends Error {
  readonly code = "FORGEDOCK_CHECKOUT_CONTEXT_UNRESOLVED" as const;

  constructor(message: string) {
    super(message);
    this.name = "CheckoutContextError";
  }
}

/**
 * Resolve the local checkout that owns a ForgeDock target repository.
 *
 * Git can discover a repository above the launch directory, but it cannot
 * discover one below it. When the process starts in a workspace parent, use
 * the target repository's origin remote to select exactly one immediate child
 * checkout. Ambiguous or cross-repository matches fail closed unless the
 * caller explicitly opts into a read-only unresolved-target fallback.
 */
export function resolveCheckoutContext(
  cwd: string,
  targetRepository?: string,
  options: ResolveCheckoutContextOptions = {},
): CheckoutContext {
  const launchCwd = canonicalPath(cwd);
  const target = normalizeRepository(targetRepository);
  const currentRoot = gitRootAt(launchCwd);

  if (currentRoot) {
    const currentRepository = originRepository(currentRoot);
    if (!target || repositoriesEqual(currentRepository, target)) {
      return {
        launchCwd,
        checkoutRoot: currentRoot,
        ...(currentRepository ? { repository: currentRepository } : {}),
        ...(target ? { targetRepository: targetRepository!.trim() } : {}),
        source: "current-checkout",
      };
    }

    const candidates = discoverCheckouts(dirname(currentRoot));
    const selected = selectMatchingCheckout(candidates, target, launchCwd, targetRepository!.trim());
    if (selected) return selected;
  } else {
    const candidates = discoverCheckouts(launchCwd);
    if (target) {
      const selected = selectMatchingCheckout(candidates, target, launchCwd, targetRepository!.trim());
      if (selected) return selected;
    } else if (candidates.length === 1) {
      const candidate = candidates[0]!;
      return {
        launchCwd,
        checkoutRoot: candidate.checkoutRoot,
        ...(candidate.repository ? { repository: candidate.repository } : {}),
        source: "only-child-checkout",
      };
    } else if (candidates.length > 1 && !options.allowAmbiguous) {
      throw new CheckoutContextError(ambiguousCheckoutMessage(launchCwd, candidates));
    }
  }

  if (target && options.allowUnresolvedTarget) {
    return {
      launchCwd,
      checkoutRoot: launchCwd,
      targetRepository: targetRepository!.trim(),
      source: "launch-directory",
    };
  }

  if (target) {
    throw new CheckoutContextError(missingTargetCheckoutMessage(launchCwd, targetRepository!.trim()));
  }

  if (options.allowAmbiguous) {
    return { launchCwd, checkoutRoot: launchCwd, source: "launch-directory" };
  }

  throw new CheckoutContextError(`ForgeDock could not resolve a local Git checkout from launch directory ${launchCwd}. Start from a checkout or provide an explicit repository target.`);
}

export function repositoryFromRemote(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\/+$/, "");
  let hostname: string;
  let pathname: string;
  const scp = /^[^/\s@]+@([^/\s:]+):(.+)$/.exec(trimmed);
  if (scp?.[1] && scp[2]) {
    hostname = scp[1];
    pathname = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    } catch {
      return undefined;
    }
    if (url.username || url.password || url.search || url.hash) return undefined;
    hostname = url.hostname;
    pathname = url.pathname;
  }
  if (hostname.toLowerCase() !== "github.com") return undefined;
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length !== 2) return undefined;
  const owner = segments[0];
  const repository = segments[1]?.replace(/\.git$/i, "");
  if (!owner || !repository || !/^[^\s/:]+$/.test(owner) || !/^[^\s/:]+$/.test(repository)) return undefined;
  return `${owner}/${repository}`;
}

interface CheckoutCandidate {
  checkoutRoot: string;
  repository?: string;
}

function selectMatchingCheckout(
  candidates: readonly CheckoutCandidate[],
  target: string,
  launchCwd: string,
  targetDisplay: string,
): CheckoutContext | undefined {
  const matches = candidates.filter((candidate) => repositoriesEqual(candidate.repository, target));
  if (matches.length > 1) {
    throw new CheckoutContextError(ambiguousTargetMessage(launchCwd, targetDisplay, matches));
  }
  const candidate = matches[0];
  if (!candidate) return undefined;
  return {
    launchCwd,
    checkoutRoot: candidate.checkoutRoot,
    ...(candidate.repository ? { repository: candidate.repository } : {}),
    targetRepository: targetDisplay,
    source: "matching-child-checkout",
  };
}

function discoverCheckouts(parent: string): CheckoutCandidate[] {
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: CheckoutCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".git") continue;
    const candidatePath = join(parent, entry.name);
    const checkoutRoot = gitRootAt(candidatePath);
    if (!checkoutRoot || candidates.some((candidate) => candidate.checkoutRoot === checkoutRoot)) continue;
    const repository = originRepository(checkoutRoot);
    candidates.push({ checkoutRoot, ...(repository ? { repository } : {}) });
  }
  return candidates.sort((left, right) => left.checkoutRoot.localeCompare(right.checkoutRoot));
}

function gitRootAt(cwd: string): string | undefined {
  try {
    const result = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    return result ? canonicalPath(result) : undefined;
  } catch {
    return undefined;
  }
}

function originRepository(checkoutRoot: string): string | undefined {
  try {
    return repositoryFromRemote(execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }));
  } catch {
    return undefined;
  }
}

function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function normalizeRepository(repository: string | undefined): string | undefined {
  const value = repository?.trim();
  return value ? value.toLowerCase() : undefined;
}

function repositoriesEqual(left: string | undefined, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function formatCandidates(candidates: readonly CheckoutCandidate[]): string {
  if (!candidates.length) return "  (none)";
  return candidates.map((candidate) => `  ${candidate.checkoutRoot}${candidate.repository ? ` (${candidate.repository})` : ""}`).join("\n");
}

function ambiguousCheckoutMessage(launchCwd: string, candidates: readonly CheckoutCandidate[]): string {
  return [
    `ForgeDock found multiple local checkouts below ${launchCwd}, but no repository target was supplied.`,
    "Resolve the target repository before dispatching:",
    formatCandidates(candidates),
  ].join("\n");
}

function ambiguousTargetMessage(launchCwd: string, target: string, candidates: readonly CheckoutCandidate[]): string {
  return [
    `ForgeDock found multiple local checkouts for target repository ${target} from launch directory ${launchCwd}.`,
    "Dispatch is denied until the checkout is unambiguous:",
    formatCandidates(candidates),
  ].join("\n");
}

function missingTargetCheckoutMessage(launchCwd: string, target: string): string {
  return [
    `ForgeDock could not find a local checkout for target repository ${target}.`,
    `Launch directory: ${launchCwd}`,
    "Start the CLI from the target checkout, or place that checkout directly below the launch directory before dispatching.",
  ].join("\n");
}
