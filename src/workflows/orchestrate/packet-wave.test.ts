// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileExecutionDag, runPacketWave, type PacketWaveState, type PacketWaveItem, type PacketWaveStore } from "./packet-wave.js";
import type { ScheduledWorkItem } from "./scheduler.js";

function item(id: string, issue: number, claims = ["component:repository"]): ScheduledWorkItem {
  return { id, issue, priority: issue, dependencies: [], claims };
}

function packet(id: string, path: string, baseRef = "origin/staging"): PacketWaveItem {
  return { id, issue: Number(id.slice(1)), expectedPaths: [path], baseRef, semanticDependencies: [] };
}

describe("packet DAG compilation", () => {
  it("replaces preview component claims with exact packet paths", () => {
    const result = compileExecutionDag({
      items: [item("i1", 1), item("i2", 2)],
      packets: [packet("i1", "src/a.ts"), packet("i2", "src/b.ts")],
      baseRef: "origin/staging",
    });
    assert.deepEqual(result.items.map((candidate) => candidate.claims), [["src/a.ts"], ["src/b.ts"]]);
    assert.equal(result.edges.length, 0);
    assert.equal(result.observability.semanticFrontier, 2);
  });

  it("serializes exact same-file packets and records provenance", () => {
    const result = compileExecutionDag({
      items: [item("i1", 1), item("i2", 2)],
      packets: [packet("i1", "src/shared.ts"), packet("i2", "src/shared.ts")],
      baseRef: "origin/staging",
    });
    assert.equal(result.edges.length, 1);
    assert.equal(result.observability.claimComponents, 1);
    assert.deepEqual(result.items[0]?.plan?.claimProvenance, {
      source: "build-packet", packetId: "i1", expectedPaths: ["src/shared.ts"], baseRef: "origin/staging",
    });
  });

  it("fails closed on missing packets and base drift", () => {
    assert.throws(() => compileExecutionDag({ items: [item("i1", 1)], packets: [], baseRef: "origin/staging" }), /missing packet/);
    assert.throws(() => compileExecutionDag({ items: [item("i1", 1)], packets: [packet("i1", "src/a.ts", "origin/main")], baseRef: "origin/staging" }), /base drift/);
  });
});

describe("durable packet wave", () => {
  it("launches disjoint packet reads concurrently and reuses completed packets", async () => {
    let state: PacketWaveState | undefined;
    const store: PacketWaveStore = { load: async () => state, save: async (next) => { state = structuredClone(next); } };
    let active = 0;
    let peak = 0;
    let calls = 0;
    const items = Array.from({ length: 25 }, (_, index) => item(`i${index + 1}`, index + 1));
    const first = await runPacketWave(items, store, {
      baseRef: "origin/staging", concurrency: 30,
      materialize: async (candidate) => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--; return packet(candidate.id, `src/${candidate.id}.ts`);
      },
    });
    assert.equal(first.length, 25);
    assert.equal(peak, 25);
    assert.equal(calls, 25);
    await runPacketWave(items, store, { baseRef: "origin/staging", concurrency: 30, materialize: async () => { throw new Error("must reuse"); } });
    assert.equal(calls, 25);
  });
});
