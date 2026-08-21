// SPDX-License-Identifier: AGPL-3.0-or-later

import { deterministicOperationKey } from "./retry.js";

export interface AuthoritativeMutation<T> {
  operation: string;
  input: unknown;
  /** Read remote truth by deterministic identity, never by title alone. */
  reconcile(operationKey: string): Promise<T | undefined>;
  mutate(operationKey: string): Promise<T>;
}

/**
 * Execute a non-atomic remote mutation exactly once from the caller's point of
 * view. A lost response is reconciled before any replay, so retries cannot
 * create duplicate PRs, issues, comments, labels, refs, merges, or closes.
 */
export async function reconcileBeforeReplay<T>(mutation: AuthoritativeMutation<T>): Promise<T> {
  const operationKey = deterministicOperationKey(mutation.operation, mutation.input);
  const existing = await mutation.reconcile(operationKey);
  if (existing !== undefined) return existing;
  try {
    return await mutation.mutate(operationKey);
  } catch (error) {
    const committed = await mutation.reconcile(operationKey);
    if (committed !== undefined) return committed;
    throw error;
  }
}

export { deterministicOperationKey };
