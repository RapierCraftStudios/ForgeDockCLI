// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExecutionPlanCertificate, compileExecutionDag, runPacketWave, type PacketWaveIdentity, type PacketWaveState, type PacketWaveItem, type PacketWaveStore } from "./packet-wave.js";
import type { OrchestrationExecutionPlanNodeProjection } from "../../core/ports/orchestration.js";
import type { ScheduledWorkItem } from "./scheduler.js";

function item(id: string, issue: number, claims = ["component:repository"]): ScheduledWorkItem {
  return { id, issue, priority: issue, dependencies: [], claims };
}

function packetIdentity(id: string, baseRef = "origin/staging"): PacketWaveIdentity {
  return {
    nodeId: id,
    runId: `run-${id}`,
    subject: { repo: "acme/repository", issue: Number(id.slice(1)) },
    baseRef,
    investigationId: `investigation-${id}`,
  };
}

function packet(id: string, path: string, baseRef = "origin/staging"): PacketWaveItem {
  return {
    id,
    issue: Number(id.slice(1)),
    expectedPaths: [path],
    baseRef,
    identity: packetIdentity(id, baseRef),
    semanticDependencies: [],
  };
}

function identityFor(candidate: ScheduledWorkItem, baseRef = "origin/staging"): PacketWaveIdentity {
  return packetIdentity(candidate.id, baseRef);
}

describe("packet DAG compilation", () => {
  it("retains a canonical identity-isolated certificate (invariant:matrix-identity-isolation-60b0a854ec54)", () => {
    const node: OrchestrationExecutionPlanNodeProjection = {
      nodeId: "i1", issue: 1, repository: "Acme/Repository", dependencies: ["i0"], claims: ["src/a.ts"],
      expectedPaths: ["src/a.ts"], semanticDependencies: ["i0"],
      investigation: { wave: 1, runId: "run-1", artifactId: "artifact-1", outcome: "confirmed", baseSha: "base" },
    };
    const base = buildExecutionPlanCertificate({
      nodes: [node], serializationEdges: [], builderFrontier: [],
      batchCandidates: [{ nodeId: "i1", issue: 1, repository: "Acme/Repository", expectedPaths: ["src/a.ts"], dependencies: ["i0"], claims: ["src/a.ts"] }],
      barrier: { investigationWave: 1, investigationNodeIds: ["i1"], packetNodeIds: [], investigationExpected: 1, investigationCompleted: 1 },
    });
    const altered = buildExecutionPlanCertificate({
      nodes: [{ ...node, issue: 2 }], serializationEdges: [], builderFrontier: [],
      batchCandidates: [{ nodeId: "i1", issue: 2, repository: "Acme/Repository", expectedPaths: ["src/a.ts"], dependencies: ["i0"], claims: ["src/a.ts"] }],
      barrier: base.barrier,
    });
    assert.notEqual(base.digest, altered.digest);
    assert.equal(base.digest.length, 64);
    const reordered = buildExecutionPlanCertificate({
      nodes: [{ ...node, dependencies: ["i0"] }], serializationEdges: [], builderFrontier: [],
      batchCandidates: [{ nodeId: "i1", issue: 1, repository: "acme/repository", expectedPaths: ["src/a.ts"], dependencies: ["i0"], claims: ["src/a.ts"] }],
      barrier: { ...base.barrier, investigationNodeIds: ["i1"] },
    });
    assert.equal(base.digest, reordered.digest);
  });

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
      source: "build-packet", packetId: "i1", expectedPaths: ["src/shared.ts"], baseRef: "origin/staging", repository: "acme/repository",
    });
  });

  it("fails closed on missing packets and allows distinct route/base groups", () => {
    assert.throws(() => compileExecutionDag({ items: [item("i1", 1)], packets: [], baseRef: "origin/staging" }), /missing packet/);
    const result = compileExecutionDag({ items: [item("i1", 1), item("i2", 2)], packets: [packet("i1", "src/a.ts", "origin/staging"), packet("i2", "src/b.ts", "origin/main")], baseRef: "origin/staging" });
    assert.equal(result.packetBarrier.groups.length, 2);
    assert.deepEqual(result.packetBarrier.groups.map((group) => group.baseRef).sort(), ["origin/main", "origin/staging"]);
  });

  it("preserves identity-isolation matrix invariant:matrix-identity-isolation-31307d598639 across packet groups", () => {
    const result = compileExecutionDag({
      items: [item("i1", 1), item("i2", 2)],
      packets: [packet("i1", "src/a.ts", "base-a"), packet("i2", "src/b.ts", "base-b")],
      baseRef: "base-a",
    });
    assert.equal(new Set(result.packetBarrier.groups.map((group) => group.identity)).size, 2);
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
      baseRef: "origin/staging", concurrency: 30, identityFor,
      materialize: async (candidate) => {
        calls++; active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--; return packet(candidate.id, `src/${candidate.id}.ts`);
      },
    });
    assert.equal(first.length, 25);
    assert.equal(peak, 25);
    assert.equal(calls, 25);
    await runPacketWave(items, store, { baseRef: "origin/staging", concurrency: 30, identityFor, materialize: async () => { throw new Error("must reuse"); } });
    assert.equal(calls, 25);
  });

  it("rejects completed packet reuse when its exact base identity drifts", async () => {
    let state: PacketWaveState | undefined;
    const store: PacketWaveStore = { load: async () => state, save: async (next) => { state = structuredClone(next); } };
    const candidate = item("i1", 1);
    await runPacketWave([candidate], store, {
      baseRef: "origin/staging", concurrency: 1, identityFor,
      materialize: async () => packet("i1", "src/a.ts"),
    });
    state!.packets!.i1!.baseRef = "origin/main";
    state!.packets!.i1!.identity!.baseRef = "origin/main";
    await assert.rejects(
      () => runPacketWave([candidate], store, { baseRef: "origin/staging", concurrency: 1, identityFor, materialize: async () => packet("i1", "src/a.ts") }),
      /base identity drift/,
    );
  });

  it("keeps attempt identities monotonic through a third restart", async () => {
    let state: PacketWaveState | undefined;
    const store: PacketWaveStore = { load: async () => state, save: async (next) => { state = structuredClone(next); } };
    const candidate = item("i1", 1);
    let failures = 2;
    const options = {
      baseRef: "origin/staging", concurrency: 1, identityFor,
      materialize: async () => {
        if (failures-- > 0) throw new Error("transient");
        return packet("i1", "src/a.ts");
      },
    };
    await assert.rejects(() => runPacketWave([candidate], store, options), /transient/);
    assert.equal(state!.attempts.i1!.id, "i1:1");
    await assert.rejects(() => runPacketWave([candidate], store, options), /transient/);
    assert.equal(state!.attempts.i1!.id, "i1:2");
    await runPacketWave([candidate], store, options);
    assert.equal(state!.attempts.i1!.id, "i1:3");
    assert.equal(state!.attempts.i1!.attempt, 3);
  });

  it("canonicalizes path aliases for overlap and rejects traversal or absolute paths", () => {
    const result = compileExecutionDag({
      items: [item("i1", 1), item("i2", 2)],
      packets: [packet("i1", "src/./shared.ts"), packet("i2", "src\\\\shared.ts")],
      baseRef: "origin/staging",
    });
    assert.deepEqual(result.items.map((candidate) => candidate.claims), [["src/shared.ts"], ["src/shared.ts"]]);
    assert.equal(result.edges.length, 1);
    for (const path of ["src/../outside.ts", "/tmp/outside.ts", "C:\\\\tmp\\\\outside.ts"]) {
      assert.throws(() => compileExecutionDag({ items: [item("i1", 1)], packets: [packet("i1", path)], baseRef: "origin/staging" }), /Unsafe packet expected path/);
    }
  });
});
