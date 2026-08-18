// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryLeaseRepository } from "../../core/ports/lease.js";
import { acquireNodeLease, inspectNodeLease, waitForNodeLease } from "./node-lease.js";

describe("orchestration node lease recovery", () => {
  it("waits for a live heartbeat instead of stealing the node, then fences the expired predecessor", async () => {
    const leases = new InMemoryLeaseRepository();
    let now = 1_000;
    const old = leases.acquire("issue-7", "old-worker", 100, now, {
      binding: "orchestration:dag-1:attempt:1:item:issue-7",
      recovery: "initial",
    });
    assert.ok(old);

    const recovery = acquireNodeLease(leases, "issue-7", "recovery-worker", 100, {
      binding: "orchestration:dag-1:attempt:2:item:issue-7",
      recovery: "relaunch",
      waitForLive: true,
      now: () => now,
      pollMs: 2,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 8));
    assert.equal(inspectNodeLease(leases, "issue-7", now)?.state, "active");
    // The old worker's heartbeat keeps the lease live; recovery remains
    // blocked and cannot create a duplicate worker.
    now = 1_050;
    leases.heartbeat("issue-7", old.token, 100, now);
    await new Promise<void>((resolve) => setTimeout(resolve, 8));
    assert.equal(inspectNodeLease(leases, "issue-7", now)?.state, "active");

    now = 1_151;
    const replacement = await recovery;
    assert.ok(replacement);
    assert.equal(replacement.binding, "orchestration:dag-1:attempt:2:item:issue-7");
    assert.notEqual(replacement.token, old.token);
    assert.throws(() => leases.heartbeat("issue-7", old.token, 100, now), /another worker|stale/i);
    assert.equal(leases.release("issue-7", replacement.token), true);
  });

  it("can cancel a recovery wait while preserving the live predecessor", async () => {
    const leases = new InMemoryLeaseRepository();
    const old = leases.acquire("issue-8", "live-worker", 10_000, 2_000, {
      binding: "orchestration:dag-2:attempt:1:item:issue-8",
      recovery: "initial",
    });
    assert.ok(old);
    const abort = new AbortController();
    const waiting = waitForNodeLease(leases, "issue-8", { pollMs: 2, signal: abort.signal, now: () => 2_001 });
    abort.abort(new Error("operator cancelled stale-node recovery"));
    await assert.rejects(waiting, /operator cancelled stale-node recovery/);
    assert.equal(inspectNodeLease(leases, "issue-8", 2_001)?.state, "active");
    assert.equal(leases.release("issue-8", old.token), true);
  });
});
