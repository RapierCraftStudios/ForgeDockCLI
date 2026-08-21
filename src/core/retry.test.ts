// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { classifyRetryableError, deterministicOperationKey, retryBackoffMs } from "./retry.js";
import { ExternalOperationRetryError } from "./external-operation-retry.js";
import { reconcileBeforeReplay } from "./retry-operations.js";

test("classifies GitHub retry status and Retry-After", () => {
  const error = Object.assign(new Error("HTTP 429"), { status: 429, headers: { "retry-after": "2" } });
  const result = classifyRetryableError(error, { domain: "github" });
  assert.equal(result.retryable, true);
  assert.equal(result.status, 429);
  assert.equal(result.retryAfterMs, 2_000);
});

test("keeps validation and permission failures permanent while allowing refreshable 401", () => {
  assert.equal(classifyRetryableError(Object.assign(new Error("permission denied"), { status: 403 })).retryable, false);
  assert.equal(classifyRetryableError(Object.assign(new Error("unauthorized"), { status: 401 })).retryable, false);
  assert.equal(classifyRetryableError(Object.assign(new Error("unauthorized"), { status: 401 }), { authenticationRefreshAvailable: true }).retryable, true);
});


test("typed transient exhaustion stays retryable despite permanent wording", () => {
  const cause = Object.assign(new Error("permission denied while network unavailable"), { code: "ECONNRESET" });
  const exhausted = new ExternalOperationRetryError("external operation exhausted", {
    attempts: 3,
    failures: [cause, cause, cause],
    classification: { kind: "network", code: "ECONNRESET" },
    cause,
  });
  assert.equal(classifyRetryableError(exhausted).retryable, true);
  assert.equal(classifyRetryableError(new Error("permission denied")).retryable, false);
});

test("retains resumable provider session lineage", () => {
  const result = classifyRetryableError(Object.assign(new Error("provider disconnected"), { sessionRef: "session-1", resumable: true }), { domain: "provider" });
  assert.equal(result.retryable, true);
  assert.equal(result.sessionRef, "session-1");
  assert.equal(result.resumableSession, true);
});

test("honors long Retry-After without the exponential ceiling", () => {
  const delay = retryBackoffMs(1, { retryAfterMs: 120_000, maxMs: 60_000, jitterRatio: 0 });
  assert.equal(delay, 120_000);
  assert.equal(retryBackoffMs(1, { retryAfterMs: Number.MAX_SAFE_INTEGER, maxMs: 60_000, jitterRatio: 0 }), 900_000);
});

test("backoff is bounded, honors Retry-After, and is deterministic", () => {
  const first = retryBackoffMs(1, { retryAfterMs: 2_000, operationKey: "op" });
  assert.equal(first, retryBackoffMs(1, { retryAfterMs: 2_000, operationKey: "op" }));
  assert.equal(retryBackoffMs(99, { maxMs: 5_000, operationKey: "op" }) <= 5_000, true);
});

test("operation keys canonicalize input and reconcile before replay", async () => {
  assert.equal(deterministicOperationKey("op", { b: 1, a: 2 }), deterministicOperationKey("op", { a: 2, b: 1 }));
  let writes = 0;
  let visible = false;
  const result = await reconcileBeforeReplay({
    operation: "remote.create",
    input: { id: "one" },
    reconcile: async () => visible ? { id: "one" } : undefined,
    mutate: async () => {
      writes += 1;
      visible = true;
      throw new Error("response lost after commit");
    },
  });
  assert.deepEqual(result, { id: "one" });
  assert.equal(writes, 1);
});
