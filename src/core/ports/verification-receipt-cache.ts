// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { CheckResult, VerificationCommand } from "./verification.js";

/** The complete, immutable identity of a controller verification receipt. */
export interface VerificationReceiptCacheKey {
  repository: string;
  baseSha: string;
  revisionSha: string;
  targetRoute: string;
  targetDigest: string;
  commandId: string;
  command: string;
  args: readonly string[];
  planId: string;
  policyVersion: string;
  commandTargets: readonly string[];
  contentDigest: string;
  environmentFingerprint: string;
  toolchainFingerprint: string;
  lockfileFingerprint: string;
}

export interface VerificationReceiptCacheEntry {
  key: VerificationReceiptCacheKey;
  check: CheckResult;
  savedDurationMs: number;
  storedAt: string;
}

export interface VerificationReceiptCache {
  get(key: VerificationReceiptCacheKey): Promise<VerificationReceiptCacheEntry | undefined>;
  /** Stores only a passed, fully bound controller result. */
  put(key: VerificationReceiptCacheKey, check: CheckResult): Promise<boolean>;
}

export function verificationReceiptCacheKey(key: VerificationReceiptCacheKey): string {
  return createHash("sha256").update(canonicalVerificationReceiptKey(key)).digest("hex");
}

export function canonicalVerificationReceiptKey(key: VerificationReceiptCacheKey): string {
  return JSON.stringify({
    ...key,
    repository: key.repository.toLowerCase(),
    baseSha: key.baseSha.toLowerCase(),
    revisionSha: key.revisionSha.toLowerCase(),
    targetRoute: key.targetRoute.toLowerCase(),
    targetDigest: key.targetDigest.toLowerCase(),
    command: key.command,
    args: [...key.args],
    commandTargets: [...key.commandTargets],
  });
}

export function verificationCommandCacheIdentity(
  command: Pick<VerificationCommand, "id" | "command" | "args" | "planId" | "policyVersion" | "targets">,
  input: Omit<VerificationReceiptCacheKey, "commandId" | "command" | "args" | "planId" | "policyVersion" | "commandTargets" | "targetDigest"> & { targetDigest?: string },
): VerificationReceiptCacheKey | undefined {
  if (!command.id.trim() || !command.planId?.trim() || !command.policyVersion?.trim()) return undefined;
  const commandTargets = [...(command.targets ?? [])];
  return {
    ...input,
    commandId: command.id,
    command: command.command,
    args: [...command.args],
    planId: command.planId,
    policyVersion: command.policyVersion,
    commandTargets,
    targetDigest: input.targetDigest ?? digestJson(commandTargets),
  };
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class InMemoryVerificationReceiptCache implements VerificationReceiptCache {
  readonly entries = new Map<string, VerificationReceiptCacheEntry>();

  async get(key: VerificationReceiptCacheKey): Promise<VerificationReceiptCacheEntry | undefined> {
    const entry = this.entries.get(verificationReceiptCacheKey(key));
    return entry && isCacheableVerificationResult(key, entry.check) ? structuredClone(entry) : undefined;
  }

  async put(key: VerificationReceiptCacheKey, check: CheckResult): Promise<boolean> {
    if (!isCacheableVerificationResult(key, check)) return false;
    const entry: VerificationReceiptCacheEntry = {
      key: structuredClone(key),
      check: structuredClone(check),
      savedDurationMs: check.durationMs,
      storedAt: new Date().toISOString(),
    };
    this.entries.set(verificationReceiptCacheKey(key), entry);
    return true;
  }
}

export function isCacheableVerificationResult(key: VerificationReceiptCacheKey, check: CheckResult): boolean {
  return Boolean(key.commandId.trim() && key.planId.trim() && key.policyVersion.trim()
    && key.repository.trim() && key.baseSha.trim() && key.revisionSha.trim()
    && key.targetRoute.trim() && key.targetDigest.trim() && key.contentDigest.trim() && key.environmentFingerprint.trim()
    && key.toolchainFingerprint.trim() && key.lockfileFingerprint.trim()
    && key.targetDigest === digestJson(key.commandTargets)
    && check.status === "passed"
    && check.commandId === key.commandId
    && check.command === [key.command, ...key.args].join(" ")
    && check.planId === key.planId
    && check.policyVersion === key.policyVersion
    && JSON.stringify(check.commandTargets ?? []) === JSON.stringify(key.commandTargets));
}
