// SPDX-License-Identifier: AGPL-3.0-or-later

import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryVerificationReceiptCache, verificationCommandCacheIdentity } from "./verification-receipt-cache.js";

const command = { id: "unit", command: "node", args: ["--test", "x.js"], planId: "plan-1", policyVersion: "policy-1", targets: ["x.js"] } as const;
const key = verificationCommandCacheIdentity(command, {
  repository: "owner/repo", baseSha: "a".repeat(40), revisionSha: "b".repeat(40), targetRoute: "main",
  contentDigest: "c".repeat(64), environmentFingerprint: "env", toolchainFingerprint: "tool", lockfileFingerprint: "lock",
})!;
const passed = { command: "node --test x.js", commandId: "unit", planId: "plan-1", policyVersion: "policy-1", commandTargets: ["x.js"], status: "passed" as const, durationMs: 12 };

test("verification receipt cache stores and clones only passed bound results", async () => {
  const cache = new InMemoryVerificationReceiptCache();
  assert.equal(await cache.put(key, { ...passed, status: "failed" }), false);
  assert.equal(await cache.put(key, passed), true);
  const hit = await cache.get(key);
  assert.deepEqual(hit?.check, passed);
  hit!.check.durationMs = 99;
  assert.equal((await cache.get(key))?.check.durationMs, 12);
});

test("verification receipt identity changes with ordered args and targets", () => {
  const reordered = verificationCommandCacheIdentity({ ...command, args: ["x.js", "--test"] }, key);
  const retargeted = verificationCommandCacheIdentity({ ...command, targets: ["y.js"] }, key);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(key));
  assert.notEqual(JSON.stringify(retargeted), JSON.stringify(key));
});
