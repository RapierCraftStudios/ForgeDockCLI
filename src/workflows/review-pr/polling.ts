// SPDX-License-Identifier: AGPL-3.0-or-later

import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 10;
const MAX_POLL_INTERVAL_MS = 30_000;

/** Clamp controller polling to a bounded cadence shared by merge workflows. */
export function controllerPollInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.trunc(value)));
}

/** Exponential retry delay with the same upper bound as the base cadence. */
export function controllerPollDelay(baseIntervalMs: number, attempt: number): number {
  const exponent = Math.max(0, Math.min(30, attempt - 1));
  return Math.min(MAX_POLL_INTERVAL_MS, baseIntervalMs * 2 ** exponent);
}

/** Preserve an AbortSignal's typed reason while giving unreasoned aborts context. */
export function pollingAbortError(signal: AbortSignal, fallback = "Polling aborted"): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === "string" && signal.reason ? signal.reason : fallback,
    "AbortError",
  );
}

export function throwIfPollingAborted(signal: AbortSignal | undefined, fallback?: string): void {
  if (signal?.aborted) throw pollingAbortError(signal, fallback);
}

/** Wait for a polling interval while making the caller's cancellation reason observable. */
export async function abortablePollDelay(
  delayMs: number,
  signal?: AbortSignal,
  abortReason: (signal: AbortSignal) => unknown = (aborted) => aborted.reason ?? new DOMException("Polling aborted", "AbortError"),
): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);
  try {
    await delay(delayMs, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  }
}
