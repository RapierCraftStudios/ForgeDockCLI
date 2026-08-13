import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createArtifact, type BuildPacketPayload, type InvestigationPayload } from "../../core/artifacts/schema.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { investigateWorkItem } from "./investigate.js";
import { prepareBuildPacket } from "./prepare.js";

const investigation: InvestigationPayload = {
  outcome: "confirmed", confidence: "high", summary: "Confirmed",
  evidence: [{ claim: "Broken", source: "src/a.ts", detail: "Missing guard" }],
  rootCause: "Missing guard", affectedSurfaces: ["src/a.ts"], risks: [], recommendation: "Add guard",
};
const packet: BuildPacketPayload = {
  scope: ["Guard the update path"],
  acceptanceCriteria: ["Concurrent update preserves state"],
  context: [{ source: "src/a.ts", relevance: "Update path" }],
  implementationPlan: ["Add guard", "Add regression test"],
  expectedPaths: ["src/a.ts", "test/a.test.ts"],
  verificationPlan: ["npm test"],
  risks: [{ risk: "Deadlock", mitigation: "Keep lock scope minimal" }],
  outOfScope: ["Unrelated refactor"],
};

describe("Build Packet preparation", () => {
  it("combines intent, investigation, context and plan into one durable barrier", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_packet", subject: { repo: "a/b", issue: 1 }, producer: { role: "controller" },
      payload: { title: "Guard updates", problem: "Updates race", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const scopeHints = { affectedFiles: ["src/**/*.ts"], claims: ["src/widget"], metadataRoots: ["package.json"] } as const;
    const investigated = await investigateWorkItem({
      intent, cwd: process.cwd(), scopeHints,
      planningProvider: "anthropic", planningModel: "claude-sonnet", planningThinking: "high",
    }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({
      run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), scopeHints,
      planningProvider: "anthropic", planningModel: "claude-sonnet", planningThinking: "high",
    }, { runtime, artifacts, runs });

    assert.equal(prepared.run.state, "building");
    assert.deepEqual(prepared.packet.payload.expectedPaths, ["src/a.ts", "test/a.test.ts"]);
    assert.equal(prepared.run.scopeManifest?.source, "build-packet");
    assert.deepEqual(prepared.run.scopeManifest?.writeRoots, []);
    assert.deepEqual(prepared.run.scopeManifest?.writePaths, ["src/a.ts", "test/a.test.ts"]);
    assert.ok(prepared.run.scopeManifest?.readRoots.includes("src"));
    assert.ok(prepared.run.scopeManifest?.readRoots.includes("test"));
    assert.deepEqual(runtime.tasks[1]?.context.map((item) => item.kind), ["Intent", "Investigation"]);
    assert.equal(runtime.tasks[1]?.workspace.mode, "read-only");
    assert.deepEqual(runtime.tasks[1]?.modelPolicy, {
      planningProvider: "anthropic",
      planningModel: "claude-sonnet",
      planningThinking: "high",
    });
    assert.ok(runtime.tasks[0]?.workspace.scope.readRoots.includes("src"));
    assert.ok(runtime.tasks[1]?.workspace.scope.readRoots.includes("src"));
    assert.deepEqual((await runs.history(intent.runId)).map((record) => record.event), [
      "START_INVESTIGATION", "INVESTIGATION_CONFIRMED", "BUILD_PACKET_READY",
    ]);
  });

  it("retries one packet-author session that ended before submit_artifact", async () => {
    const runtime = new FakeAgentRuntime([
      investigation,
      new Error("Agent run_packet_recovery:build-packet:1 ended without calling submit_artifact"),
      packet,
    ]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_packet_recovery", subject: { repo: "a/b", issue: 3 }, producer: { role: "controller" },
      payload: { title: "Guard updates", problem: "Updates race", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({
      run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(),
    }, { runtime, artifacts, runs });

    assert.equal(prepared.run.state, "building");
    assert.equal(runtime.tasks.length, 3);
    assert.equal(runtime.tasks[2]?.id, "run_packet_recovery:build-packet:1:submit-retry");
    assert.match(runtime.tasks[2]?.instructions ?? "", /one bounded recovery attempt/);
  });

  it("grants bounded source discovery when the issue has no concrete affected-file hints", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_packet_discovery", subject: { repo: "a/b", issue: 130 }, producer: { role: "controller" },
      payload: { title: "Discover shared contract", problem: "Affected files to be confirmed by investigation", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const scopeHints = { affectedFiles: [], metadataRoots: ["package.json"] } as const;
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd(), scopeHints }, { runtime, artifacts, runs });
    await prepareBuildPacket({
      run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), scopeHints,
    }, { runtime, artifacts, runs });
    for (const task of runtime.tasks) {
      assert.ok(task.workspace.scope.readRoots.includes("src"));
      assert.ok(task.workspace.scope.readRoots.includes("bin"));
      assert.deepEqual(task.workspace.scope.writeRoots, []);
    }
  });

  it("canonicalizes packet paths and retains every concrete issue-declared path", async () => {
    const runtime = new FakeAgentRuntime([investigation, { ...packet, expectedPaths: ["src\\a.ts"] }]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_packet_paths", subject: { repo: "a/b", issue: 2 }, producer: { role: "controller" },
      payload: { title: "Guard updates", problem: "Updates race", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const scopeHints = { affectedFiles: ["src/a.ts", "test/a.test.ts"], metadataRoots: ["package.json"] } as const;
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd(), scopeHints }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({
      run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), scopeHints,
    }, { runtime, artifacts, runs });

    assert.deepEqual(prepared.packet.payload.expectedPaths, ["src/a.ts", "test/a.test.ts"]);
    assert.ok(runtime.tasks[1]?.workspace.scope.readRoots.includes("src"));
    assert.ok(runtime.tasks[1]?.workspace.scope.readRoots.includes("test"));
  });
});
