import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createArtifact, type BuildPacketPayload, type InvestigationPayload } from "../../core/artifacts/schema.js";
import { InMemoryArtifactRepository, InMemoryRunRepository } from "../../core/ports/repositories.js";
import { FakeAgentRuntime } from "../../runtime/fake-runtime.js";
import { investigateWorkItem } from "./investigate.js";
import { prepareBuildPacket, selectPacketVerificationCommands, canonicalizePacketVerification } from "./prepare.js";
import { deriveEvidenceContract } from "./evidence-contract.js";
import { discoverVerificationCommands } from "../../cli/verification-policy.js";

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
  it("materializes when malformed investigation test hints are optional", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-malformed-hint-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "src/fix.ts"), "export const fixed = true;\n");
      const malformedInvestigation: InvestigationPayload = {
        ...investigation,
        affectedSurfaces: ["src/tui/forgedock-extension.test.ts and src/workflows/orchestrate/controller.test.ts"],
      };
      const gatedPacket: BuildPacketPayload = {
        ...packet,
        expectedPaths: ["src/fix.ts"],
        verificationPlan: ["controller-gate:staging-review"],
        verificationRequirements: [{ kind: "controller-gate", id: "staging-review", criterionIds: ["criterion-1"], rationale: "Controller-owned completion." }],
      };
      const runtime = new FakeAgentRuntime([malformedInvestigation, gatedPacket]);
      const artifacts = new InMemoryArtifactRepository();
      const runs = new InMemoryRunRepository();
      const intent = createArtifact({
        kind: "Intent", runId: "run_malformed_hint", subject: { repo: "a/b", issue: 421 }, producer: { role: "controller" },
        payload: { title: "Optional hint", problem: "Ignore malformed read-only hint", constraints: [], acceptanceHints: [], dependencies: [] },
      });
      const investigated = await investigateWorkItem({ intent, cwd }, { runtime, artifacts, runs });
      const prepared = await prepareBuildPacket({
        run: investigated.run, intent, investigation: investigated.investigation, cwd,
        verificationCatalog: {
          commands: [{
            id: "targeted", command: "node", args: ["--test"], required: true, selection: "always",
            targeting: "expected-test-paths", evidenceCapability: "targeted-test", policyVersion: "forgedock.verification/v2",
            typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest" },
          }],
          controllerGates: [{ id: "staging-review", description: "Validate staging" }],
        },
      }, { runtime, artifacts, runs });
      assert.equal(prepared.run.state, "building");
      assert.deepEqual(prepared.packet.payload.expectedPaths, ["src/fix.ts"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("combines intent, investigation, context and plan into one durable barrier", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_packet", subject: { repo: "a/b", issue: 1 }, producer: { role: "controller" },
      payload: { title: "Guard updates", problem: "Updates race", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const scopeHints = { affectedFiles: ["src/a.ts", "test/a.test.ts"], claims: ["src/widget"], metadataRoots: ["package.json"] } as const;
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
    assert.match(runtime.tasks[1]?.instructions ?? "", /implementationPlan name the relevant symbols\/files/);
    assert.match(runtime.tasks[1]?.instructions ?? "", /Map verificationPlan to the acceptance criteria/);
    assert.match(runtime.tasks[1]?.instructions ?? "", /latest prior review, verification/);
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

  it("accepts a broad cross-cutting packet from zero hints", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-architecture-scope-"));
    try {
      await mkdir(join(cwd, "src/component"), { recursive: true });
      await mkdir(join(cwd, "test/component"), { recursive: true });
      await writeFile(join(cwd, "src/component/anchor.ts"), "export const anchor = true;\n");
      await writeFile(join(cwd, "src/component/related.ts"), "import { anchor } from './anchor.js'; export { anchor };\n");
      await writeFile(join(cwd, "test/component/anchor.test.ts"), "import '../anchor.js';\n");
      execFileSync("git", ["init", "-q"], { cwd });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
      execFileSync("git", ["config", "user.name", "Test"], { cwd });
      execFileSync("git", ["add", "."], { cwd });
      execFileSync("git", ["commit", "-qm", "base"], { cwd });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
      const architectureInvestigation: InvestigationPayload = {
        ...investigation,
        evidence: [{ claim: "Component anchor", source: "src/component/anchor.ts:1", detail: "Existing architecture" }],
        affectedSurfaces: ["src/component/related.ts", "test/component/anchor.test.ts"],
      };
      const architecturePacket: BuildPacketPayload = {
        ...packet,
        expectedPaths: [
          "src/adapters/sqlite/sqlite-repositories.test.ts",
          "src/adapters/sqlite/sqlite-repositories.ts",
          "src/cli/main.ts",
          "src/core/artifacts/schema.ts",
          "src/core/packet/investigation-scope.ts",
          "src/core/ports/orchestration.test.ts",
          "src/core/ports/orchestration.ts",
          "src/core/state/machine.test.ts",
          "src/core/state/machine.ts",
          "src/tui/forgedock-tools.ts",
          "src/workflows/orchestrate/controller.test.ts",
          "src/workflows/orchestrate/controller.ts",
          "src/workflows/orchestrate/materialize.test.ts",
          "src/workflows/orchestrate/materialize.ts",
          "src/workflows/work-on/investigate.test.ts",
          "src/workflows/work-on/investigate.ts",
        ],
      };
      const runtime = new FakeAgentRuntime([architectureInvestigation, architecturePacket]);
      const artifacts = new InMemoryArtifactRepository();
      const runs = new InMemoryRunRepository();
      const intent = createArtifact({
        kind: "Intent", runId: "run_architecture_scope", subject: { repo: "a/b", issue: 458 }, producer: { role: "controller" },
        payload: { title: "Architecture scope", problem: "Build new architecture", constraints: [], acceptanceHints: [], dependencies: [] },
      });
      const investigated = await investigateWorkItem({ intent, cwd }, { runtime, artifacts, runs });
      const prepared = await prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd, baseSha }, { runtime, artifacts, runs });
      assert.equal(prepared.packet.payload.investigationScopeReceipt, undefined);
      assert.deepEqual(prepared.packet.payload.expectedPaths, architecturePacket.expectedPaths);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });


  it("accepts generated-source Investigation evidence as read-only without changing expected paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-generated-evidence-"));
    try {
      await mkdir(join(cwd, "scripts"), { recursive: true });
      await writeFile(join(cwd, "scripts/runner.mjs"), "export const generated = true;\n");
      const evidenceInvestigation: InvestigationPayload = {
        ...investigation,
        affectedSurfaces: [],
        evidence: [{ claim: "Generated runner", source: "No concrete repository location", detail: "Generated source" }],
      };
      const evidencePacket: BuildPacketPayload = {
        ...packet,
        expectedPaths: ["src/fix.ts"],
        evidencePaths: [{ path: "scripts/runner.mjs", criterionIds: ["criterion-1"], role: "generated" }],
      };
      const runtime = new FakeAgentRuntime([evidenceInvestigation, evidencePacket]);
      const artifacts = new InMemoryArtifactRepository();
      const runs = new InMemoryRunRepository();
      const intent = createArtifact({
        kind: "Intent", runId: "run_generated_evidence", subject: { repo: "arbitrary/repository", issue: 403 }, producer: { role: "controller" },
        payload: { title: "Generated evidence", problem: "Read generated source", constraints: [], acceptanceHints: [], dependencies: [] },
      });
      const investigated = await investigateWorkItem({ intent, cwd }, { runtime, artifacts, runs });
      const prepared = await prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd }, { runtime, artifacts, runs });
      assert.deepEqual(prepared.packet.payload.expectedPaths, ["src/fix.ts"]);
      assert.deepEqual(prepared.packet.payload.evidencePaths, [{ path: "scripts/runner.mjs", criterionIds: ["criterion-1"], role: "generated" }]);
      assert.deepEqual(prepared.run.scopeManifest?.writePaths, ["src/fix.ts"]);
      assert.ok(runtime.tasks[1]?.workspace.scope.readRoots.includes("scripts"));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drops packet evidence unrelated to validated Investigation sources", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-unrelated-evidence-"));
    try {
      await mkdir(join(cwd, "scripts"), { recursive: true });
      await mkdir(join(cwd, "other"), { recursive: true });
      await writeFile(join(cwd, "scripts/runner.mjs"), "export const generated = true;\n");
      await writeFile(join(cwd, "other/unrelated.mjs"), "export const unrelated = true;\n");
      await symlink(join(cwd, "other/unrelated.mjs"), join(cwd, "scripts/link.mjs"));
      const evidenceInvestigation: InvestigationPayload = {
        ...investigation,
        affectedSurfaces: [],
        evidence: [{ claim: "Generated runner", source: "No concrete repository location", detail: "Generated source" }],
      };
      const evidencePacket: BuildPacketPayload = {
        ...packet,
        expectedPaths: ["src/fix.ts"],
        evidencePaths: [
          { path: "other/unrelated.mjs", criterionIds: ["criterion-1"], role: "generated" },
          { path: "scripts/link.mjs", criterionIds: ["criterion-1"], role: "generated" },
          { path: "scripts/missing.mjs", criterionIds: ["criterion-1"], role: "generated" },
        ],
      };
      const runtime = new FakeAgentRuntime([evidenceInvestigation, evidencePacket, evidencePacket]);
      const artifacts = new InMemoryArtifactRepository();
      const runs = new InMemoryRunRepository();
      const intent = createArtifact({
        kind: "Intent", runId: "run_unrelated_evidence", subject: { repo: "arbitrary/repository", issue: 404 }, producer: { role: "controller" },
        payload: { title: "Unrelated evidence", problem: "Reject scope escape", constraints: [], acceptanceHints: [], dependencies: [] },
      });
      const investigated = await investigateWorkItem({ intent, cwd }, { runtime, artifacts, runs });
      const prepared = await prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd }, { runtime, artifacts, runs });
      assert.deepEqual(prepared.packet.payload.expectedPaths, ["src/fix.ts"]);
      assert.equal(prepared.packet.payload.evidencePaths, undefined);
      assert.equal((await artifacts.list(intent.subject, "BuildPacket")).length, 1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("bounds aggregate evidence by retaining only files within the byte limit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-evidence-byte-bound-"));
    try {
      await mkdir(join(cwd, "scripts"), { recursive: true });
      const names = ["one.mjs", "two.mjs", "three.mjs", "four.mjs", "five.mjs"];
      for (const name of names) await writeFile(join(cwd, "scripts", name), "x".repeat(1_000_000));
      const evidenceInvestigation: InvestigationPayload = {
        ...investigation,
        affectedSurfaces: [],
        evidence: [{ claim: "Generated sources", source: "No concrete repository location", detail: "Generated source" }],
      };
      const evidencePacket: BuildPacketPayload = {
        ...packet,
        expectedPaths: ["src/fix.ts"],
        evidencePaths: names.map((name) => ({ path: `scripts/${name}`, criterionIds: ["criterion-1"], role: "generated" as const })),
      };
      const runtime = new FakeAgentRuntime([evidenceInvestigation, evidencePacket, evidencePacket]);
      const artifacts = new InMemoryArtifactRepository();
      const runs = new InMemoryRunRepository();
      const intent = createArtifact({
        kind: "Intent", runId: "run_evidence_byte_bound", subject: { repo: "arbitrary/repository", issue: 405 }, producer: { role: "controller" },
        payload: { title: "Evidence bytes", problem: "Bound read authority", constraints: [], acceptanceHints: [], dependencies: [] },
      });
      const investigated = await investigateWorkItem({ intent, cwd }, { runtime, artifacts, runs });
      const prepared = await prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd }, { runtime, artifacts, runs });
      assert.deepEqual(prepared.packet.payload.expectedPaths, ["src/fix.ts"]);
      assert.deepEqual(prepared.packet.payload.evidencePaths?.map(({ path }) => path), names.slice(0, 4).map((name) => `scripts/${name}`));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("binds production packet relation authority to the exact frozen workspace base", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-packet-base-"));
    const baseSha = "f".repeat(40);
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await mkdir(join(cwd, "test"), { recursive: true });
      await writeFile(join(cwd, "src/a.ts"), "export const a = true;\n");
      await writeFile(join(cwd, "test/a.test.ts"), "import '../src/a.js';\n");
      const runtime = new FakeAgentRuntime([investigation, packet]);
      const artifacts = new InMemoryArtifactRepository();
      const runs = new InMemoryRunRepository();
      const intent = createArtifact({
        kind: "Intent", runId: "run_packet_exact_base", subject: { repo: "a/b", issue: 101 }, producer: { role: "controller" },
        payload: { title: "Exact base", problem: "Freeze relation authority", constraints: [], acceptanceHints: [], dependencies: [] },
      });
      const scopeHints = { affectedFiles: ["src/a.ts", "test/a.test.ts"], writePaths: ["src/a.ts", "test/a.test.ts"] } as const;
      const investigated = await investigateWorkItem({ intent, cwd, scopeHints }, { runtime, artifacts, runs });
      const prepared = await prepareBuildPacket({
        run: investigated.run, intent, investigation: investigated.investigation, cwd, baseSha, scopeHints,
      }, { runtime, artifacts, runs });
      assert.equal(prepared.packet.payload.relationGraph?.baseSha, baseSha);
      const checkpoint = artifacts.artifacts.find((artifact) => artifact.kind === "RelationGraphCheckpoint");
      assert.equal(checkpoint?.kind === "RelationGraphCheckpoint" ? checkpoint.payload.baseSha : undefined, baseSha);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps unobserved relation evidence advisory during rollout", async () => {
    const advisoryInvestigation: InvestigationPayload = {
      ...investigation,
      affectedSurfaces: ["src/adapters/sqlite/sqlite-repositories.ts", "FORGE.md"],
      evidence: [{ claim: "Contract", source: "FORGE.md", detail: "Read-only repository guidance" }],
    };
    const advisoryPacket: BuildPacketPayload = {
      ...packet,
      expectedPaths: ["src/adapters/sqlite/sqlite-repositories.ts"],
      evidencePaths: [{ path: "FORGE.md", criterionIds: ["criterion-1"], role: "source" }],
    };
    const runtime = new FakeAgentRuntime([advisoryInvestigation, advisoryPacket]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_relation_advisory", subject: { repo: "a/b", issue: 102 }, producer: { role: "controller" },
      payload: { title: "Advisory graph", problem: "Graph scan is bounded", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const scopeHints = { affectedFiles: ["src/adapters/sqlite/sqlite-repositories.ts"], writePaths: ["src/adapters/sqlite/sqlite-repositories.ts"] } as const;
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd(), scopeHints }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({
      run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), baseSha: "f".repeat(40), scopeHints,
    }, { runtime, artifacts, runs });
    assert.equal(prepared.run.state, "building");
    assert.deepEqual(prepared.packet.payload.evidencePaths?.map(({ path }) => path), ["FORGE.md"]);
  });

  it("canonicalizes typed verification requirements against the controller catalog", async () => {
    const runtime = new FakeAgentRuntime([
      investigation,
      {
        ...packet,
        verificationPlan: ["free-form lifecycle prose"],
        controllerGates: [{ id: "staging-review", description: "Validate staging" }],
        verificationRequirements: [{ kind: "controller-gate", id: "staging-review", criterionIds: ["criterion-1"], rationale: "The controller owns staging validation." }],
        verificationPolicyVersion: "forged-policy",
        verificationCommandTargets: [{ id: "forged", targets: ["everything"] }],
      },
    ]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_packet_typed_valid", subject: { repo: "a/b", issue: 5 }, producer: { role: "controller" },
      payload: { title: "Guard updates", problem: "Updates race", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({
      run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(),
      verificationCatalog: {
        commands: [{
          id: "diff-check", command: "git", args: ["diff", "--check"], timeoutMs: 1_000, required: true,
          selection: "always", evidenceCapability: "generic", policyVersion: "forgedock.verification/v2", lockScope: "workspace",
        }],
        controllerGates: [{ id: "staging-review", description: "Validate staging" }],
      },
      scopeHints: { writePaths: ["src/a.ts", "test/a.test.ts"] },
    }, { runtime, artifacts, runs });
    assert.deepEqual(prepared.packet.payload.verificationPlan, ["controller-gate:staging-review"]);
    assert.deepEqual(prepared.packet.payload.verificationRequirements?.map((requirement) => requirement.id), ["staging-review"]);
    assert.equal(prepared.packet.payload.verificationPolicyVersion, "forgedock.verification/v2");
    assert.deepEqual(prepared.packet.payload.verificationCommandTargets, [{ id: "diff-check", targets: [] }]);
  });

  it("persists branch-frozen command identities and revalidates them against the exact base SHA", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-canonical-packet-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { build: "tsc -p tsconfig.json", test: "node --test" } }));
      await writeFile(join(cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" }, include: ["src/**/*.ts"] }));
      await mkdir(join(cwd, "node_modules/typescript/bin"), { recursive: true });
      await writeFile(join(cwd, "node_modules/typescript/bin/tsc"), "// test compiler\n");
      await writeFile(join(cwd, "src/a.ts"), "export {};\n");
      await writeFile(join(cwd, "src/a.test.ts"), "import 'node:test';\n");
      execFileSync("git", ["init", cwd], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.name", "ForgeDock Test"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "config", "user.email", "forgedock@example.invalid"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "add", "."], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "commit", "-m", "freeze packet"], { stdio: "ignore" });
      execFileSync("git", ["-C", cwd, "branch", "origin/staging"], { stdio: "ignore" });
      const baseSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const branchCatalog = discoverVerificationCommands(cwd, "origin/staging");
      const exactCatalog = discoverVerificationCommands(cwd, baseSha);
      assert.deepEqual(exactCatalog, branchCatalog);

      const runtime = new FakeAgentRuntime([
        { ...investigation, evidence: [{ claim: "Source", source: "src/a.ts", detail: "Source" }], affectedSurfaces: ["src/a.ts"] },
        {
          ...packet,
          expectedPaths: ["src/a.ts", "src/a.test.ts"],
          verificationPlan: ["build", "test"],
          verificationRequirements: [
            { kind: "command", id: "build", criterionIds: ["criterion-1"], rationale: "Compile" },
            { kind: "command", id: "test", criterionIds: ["criterion-1"], rationale: "Targeted test" },
          ],
        },
      ]);
      const artifacts = new InMemoryArtifactRepository();
      const runs = new InMemoryRunRepository();
      const intent = createArtifact({
        kind: "Intent", runId: "run_canonical_packet", subject: { repo: "arbitrary/repository", issue: 25 }, producer: { role: "controller" },
        payload: { title: "Canonical packet", problem: "Freeze exact verification", constraints: [], acceptanceHints: [], dependencies: [] },
      });
      const investigated = await investigateWorkItem({ intent, cwd }, { runtime, artifacts, runs });
      const prepared = await prepareBuildPacket({
        run: investigated.run, intent, investigation: investigated.investigation, cwd, baseSha,
        scopeHints: { affectedFiles: ["src/a.ts", "src/a.test.ts"], writePaths: ["src/a.ts", "src/a.test.ts"] },
        verificationCatalog: { commands: branchCatalog, controllerGates: [] },
      }, { runtime, artifacts, runs });
      const frozen = prepared.packet.payload;
      assert.ok(frozen.verificationCommandIdentities?.length);
      assert.ok(frozen.verificationCommandTargets?.some(({ id }) => id === "test"));
      const branchPlan = selectPacketVerificationCommands(frozen, branchCatalog, baseSha);
      const exactPlan = selectPacketVerificationCommands(frozen, exactCatalog, baseSha);
      assert.deepEqual(exactPlan, branchPlan);
      assert.equal(frozen.verificationCommandIdentities?.find(({ id }) => id === "test")?.args.at(-1), "--test-concurrency=4");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects controller-owned verification prose before the builder can start", async () => {
    const runtime = new FakeAgentRuntime([
      investigation,
      {
        ...packet,
        verificationPlan: ["Confirm no targeted test bypasses the durable admission by checking that the tests still pass"],
        controllerGates: [{ id: "staging-review", description: "Validate staging" }],
      },
      {
        ...packet,
        verificationPlan: ["Confirm no targeted test bypasses the durable admission by checking that the tests still pass"],
        controllerGates: [{ id: "staging-review", description: "Validate staging" }],
      },
    ]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_packet_typed", subject: { repo: "a/b", issue: 4 }, producer: { role: "controller" },
      payload: { title: "Guard updates", problem: "Updates race", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    await assert.rejects(() => prepareBuildPacket({
      run: investigated.run,
      intent,
      investigation: investigated.investigation,
      cwd: process.cwd(),
      scopeHints: { writePaths: ["src/a.ts", "test/a.test.ts"] },
      verificationCatalog: {
        commands: [{ id: "test", command: "npm", args: ["test"] }],
        controllerGates: [{ id: "staging-review", description: "Validate staging" }],
      },
    }, { runtime, artifacts, runs }), /unsupported or unfenced controller prose/);
    assert.equal((await artifacts.list(intent.subject, "BuildPacket")).length, 0);
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
      scopeHints: { writePaths: ["src/a.ts", "test/a.test.ts"] },
    }, { runtime, artifacts, runs });

    assert.equal(prepared.run.state, "building");
    assert.equal(runtime.tasks.length, 3);
    assert.equal(runtime.tasks[2]?.id, "run_packet_recovery:build-packet:1:submit-retry");
    assert.match(runtime.tasks[2]?.instructions ?? "", /one bounded recovery attempt/);
  });

  it("repairs one targeted verification capability mismatch and derives compiled targets centrally", async () => {
    const catalog = {
      commands: [{
        id: "typescript-tests", command: "npm", args: ["test"], timeoutMs: 1_000, required: true,
        selection: "packet" as const, targeting: "expected-test-paths" as const, evidenceCapability: "targeted-test" as const,
        policyVersion: "forgedock.verification/v2", typescriptLayout: {
          sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest",
        },
      }],
      controllerGates: [],
    };
    const invalid = {
      ...packet,
      expectedPaths: ["src/a.test.js"],
      verificationPlan: ["npm test"],
      verificationRequirements: [{ kind: "command" as const, id: "typescript-tests", criterionIds: ["criterion-1"], rationale: "Regression" }],
    };
    const repaired = { ...invalid, expectedPaths: ["src/a.test.ts"] };
    const runtime = new FakeAgentRuntime([investigation, invalid, repaired]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_capability_repair", subject: { repo: "a/b", issue: 6 }, producer: { role: "controller" },
      payload: { title: "Target tests", problem: "Unsafe target", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({
      run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), verificationCatalog: catalog, scopeHints: { writePaths: ["src/a.test.ts"] },
    }, { runtime, artifacts, runs });

    assert.equal(prepared.run.state, "building");
    assert.deepEqual(prepared.packet.payload.verificationCommandTargets, [{ id: "typescript-tests", targets: ["dist/a.test.js"] }]);
    assert.equal(runtime.tasks[2]?.id, "run_capability_repair:build-packet:1:capability-repair");
    assert.match(runtime.tasks[2]?.instructions ?? "", /one bounded :capability-repair attempt/);
  });

  it("blocks after the single capability repair is exhausted without creating a packet", async () => {
    const catalog = {
      commands: [{
        id: "typescript-tests", command: "npm", args: ["test"], timeoutMs: 1_000, required: true,
        selection: "packet" as const, targeting: "expected-test-paths" as const, evidenceCapability: "targeted-test" as const,
        policyVersion: "forgedock.verification/v2", typescriptLayout: {
          sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest",
        },
      }],
      controllerGates: [],
    };
    const invalid = {
      ...packet,
      expectedPaths: ["src/a.test.js"],
      verificationPlan: ["npm test"],
      verificationRequirements: [{ kind: "command" as const, id: "typescript-tests", criterionIds: ["criterion-1"], rationale: "Regression" }],
    };
    const runtime = new FakeAgentRuntime([investigation, invalid, invalid]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_capability_block", subject: { repo: "a/b", issue: 7 }, producer: { role: "controller" },
      payload: { title: "Target tests", problem: "Unsafe target", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    await assert.rejects(() => prepareBuildPacket({
      run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), verificationCatalog: catalog, scopeHints: { writePaths: ["src/a.test.ts"] },
    }, { runtime, artifacts, runs }), /Verification capability mismatch exhausted after bounded repair/);
    assert.equal((await artifacts.list(intent.subject, "BuildPacket")).length, 0);
    assert.equal((await artifacts.list(intent.subject, "Outcome")).filter((artifact) => artifact.runId === intent.runId && artifact.kind === "Outcome" && artifact.payload.status === "blocked").length, 1);
    const blocked = await runs.load(intent.runId);
    assert.equal(blocked?.state, "blocked");
    assert.equal(runtime.tasks.length, 3);
  });

  it("grants bounded source discovery when the issue has no concrete affected-file hints", async () => {
    const runtime = new FakeAgentRuntime([investigation, packet]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({
      kind: "Intent", runId: "run_packet_discovery", subject: { repo: "a/b", issue: 130 }, producer: { role: "controller" },
      payload: { title: "Discover shared contract", problem: "Affected files to be confirmed by investigation", constraints: [], acceptanceHints: [], dependencies: [] },
    });
    const scopeHints = { affectedFiles: [], writePaths: ["src/a.ts", "test/a.test.ts"], metadataRoots: ["package.json"] } as const;
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

  it("persists targeted evidence contract while keeping package metadata read-only", async () => {
    const catalog = {
      commands: [{ id: "targeted-tests", command: "npm", args: ["test"], required: true, selection: "packet" as const, targeting: "expected-test-paths" as const, evidenceCapability: "targeted-test" as const, policyVersion: "forgedock.verification/v2", typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest" } }],
      controllerGates: [],
    };
    const output = { ...packet, expectedPaths: ["src/a.test.ts"], verificationPlan: ["npm test"], verificationRequirements: [{ kind: "command" as const, id: "targeted-tests", criterionIds: ["criterion-1"], rationale: "Regression" }], evidencePaths: [{ path: "package.json", criterionIds: ["criterion-1"], role: "artifact" as const }, { path: "src/tui/generated-tools.test.ts", criterionIds: ["criterion-1"], role: "test" as const }], evidenceContract: { version: "forgedock.evidence/v1" as const, criteria: [{ criterionId: "criterion-1", requiredCommandIds: [], semanticCommandIds: [], controllerGateIds: [], allowedWritePaths: [], allowedEvidencePaths: [], invariantRowIds: [], invariantTestIds: [], invariantCaseIds: [] }] }, invariantMatrices: [{ id: "forged", criterionId: "criterion-1", capability: "terminal-metadata" as const, dimensions: [{ name: "x", values: ["y"] }], testId: "invariant:forged" }], verificationCommandTargets: [{ id: "forged", targets: ["all"] }] };
    const runtime = new FakeAgentRuntime([investigation, output]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({ kind: "Intent", runId: "run_contract", subject: { repo: "a/b", issue: 140 }, producer: { role: "controller" }, payload: { title: "Contract", problem: "Bound evidence", constraints: [], acceptanceHints: [], dependencies: [] } });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), verificationCatalog: catalog, scopeHints: { writePaths: ["src/a.test.ts"] } }, { runtime, artifacts, runs });
    assert.deepEqual(prepared.packet.payload.evidencePaths, [{ path: "package.json", criterionIds: ["criterion-1"], role: "artifact" }]);
    assert.equal(prepared.packet.payload.evidenceContract?.version, "forgedock.evidence/v1");
    assert.deepEqual(prepared.packet.payload.verificationCommandTargets, [{ id: "targeted-tests", targets: ["dist/a.test.js"] }]);
    assert.equal(prepared.packet.payload.invariantMatrices, undefined);
  });

  it("repairs generic-only selection when the catalog has semantic capability", async () => {
    const catalog = { commands: [
      { id: "generic", command: "npm", args: ["test"], required: true, selection: "packet" as const, evidenceCapability: "generic" as const, policyVersion: "forgedock.verification/v2" },
      { id: "targeted", command: "npm", args: ["test"], required: true, selection: "packet" as const, targeting: "expected-test-paths" as const, evidenceCapability: "targeted-test" as const, policyVersion: "forgedock.verification/v2", typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest" } },
    ], controllerGates: [] };
    const generic = { ...packet, verificationPlan: ["npm test"], verificationRequirements: [{ kind: "command" as const, id: "generic", criterionIds: ["criterion-1"], rationale: "Check" }] };
    const repaired = { ...packet, expectedPaths: ["src/a.test.ts"], verificationPlan: ["npm test"], verificationRequirements: [{ kind: "command" as const, id: "targeted", criterionIds: ["criterion-1"], rationale: "Regression" }] };
    const runtime = new FakeAgentRuntime([investigation, generic, repaired]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({ kind: "Intent", runId: "run_generic_repair", subject: { repo: "a/b", issue: 141 }, producer: { role: "controller" }, payload: { title: "Repair", problem: "Semantic proof", constraints: [], acceptanceHints: [], dependencies: [] } });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), verificationCatalog: catalog, scopeHints: { writePaths: ["src/a.test.ts"] } }, { runtime, artifacts, runs });
    assert.equal(prepared.run.state, "building");
    assert.equal(runtime.tasks.length, 3);
    assert.deepEqual(prepared.packet.payload.verificationCommandTargets, [{ id: "targeted", targets: ["dist/a.test.js"] }]);
  });

  it("blocks generic-only catalogs on the controller pass and does not create packets", async () => {
    const genericCatalog = { commands: [{ id: "generic", command: "npm", args: ["test"], required: true, selection: "packet" as const, evidenceCapability: "generic" as const, policyVersion: "forgedock.verification/v2" }], controllerGates: [] };
    const generic = { ...packet, verificationPlan: ["npm test"], verificationRequirements: [{ kind: "command" as const, id: "generic", criterionIds: ["criterion-1"], rationale: "Check" }] };
    const runtime = new FakeAgentRuntime([investigation, generic]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({ kind: "Intent", runId: "run_generic_direct", subject: { repo: "a/b", issue: 142 }, producer: { role: "controller" }, payload: { title: "Block", problem: "No semantic catalog", constraints: [], acceptanceHints: [], dependencies: [] } });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    await assert.rejects(() => prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), verificationCatalog: genericCatalog, scopeHints: { writePaths: ["src/a.ts", "test/a.test.ts"] } }, { runtime, artifacts, runs }), /generic-only-command/);
    assert.equal(runtime.tasks.length, 2);
    assert.equal((await artifacts.list(intent.subject, "BuildPacket")).length, 0);
  });

  it("accepts gate-only criteria", async () => {
    const runtime = new FakeAgentRuntime([investigation, { ...packet, verificationPlan: ["controller-gate:staging-review"], verificationRequirements: [{ kind: "controller-gate" as const, id: "staging-review", criterionIds: ["criterion-1"], rationale: "Controller evidence" }] }]);
    const artifacts = new InMemoryArtifactRepository();
    const runs = new InMemoryRunRepository();
    const intent = createArtifact({ kind: "Intent", runId: "run_gate", subject: { repo: "a/b", issue: 144 }, producer: { role: "controller" }, payload: { title: "Gate", problem: "Controller validates", constraints: [], acceptanceHints: [], dependencies: [] } });
    const investigated = await investigateWorkItem({ intent, cwd: process.cwd() }, { runtime, artifacts, runs });
    const prepared = await prepareBuildPacket({ run: investigated.run, intent, investigation: investigated.investigation, cwd: process.cwd(), verificationCatalog: { commands: [], controllerGates: [{ id: "staging-review", description: "Validate" }] }, scopeHints: { writePaths: ["src/a.ts", "test/a.test.ts"] } }, { runtime, artifacts, runs });
    assert.equal(prepared.run.state, "building");
    assert.equal(prepared.packet.payload.evidenceContract, undefined);
  });
  it("augments a generic criterion from a frozen read-only investigation test target", () => {
    const output = { ...packet, expectedPaths: ["vendor/pi-runtime/dist/core/tools/ls.js"], verificationPlan: ["npm test"], verificationRequirements: [{ kind: "command" as const, id: "generic", criterionIds: ["criterion-1"], rationale: "Generic baseline" }] };
    const catalog = {
      commands: [
        { id: "generic", command: "npm", args: ["test"], required: true, selection: "packet" as const, evidenceCapability: "generic" as const, policyVersion: "forgedock.verification/v2" },
        { id: "targeted", command: "node", args: ["--test"], required: true, selection: "packet" as const, targeting: "expected-test-paths" as const, evidenceCapability: "targeted-test" as const, policyVersion: "forgedock.verification/v2", typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest" } },
      ], controllerGates: [],
    };
    const canonical = canonicalizePacketVerification(output, catalog, output.expectedPaths, [], ["src/pi-runtime-tool-renderers.test.ts"]);
    assert.deepEqual(canonical.expectedPaths, ["vendor/pi-runtime/dist/core/tools/ls.js"]);
    assert.deepEqual(canonical.verificationRequirements?.map(({ id }) => id), ["generic", "targeted"]);
  });
  it("revalidates exact-base evidence contracts and binds capability identity into the plan", () => {
    const catalog = [{
      id: "targeted", command: "node", args: ["test.mjs"], timeoutMs: 1_000, required: true,
      selection: "packet" as const, targeting: "expected-test-paths" as const,
      evidenceCapability: "targeted-test" as const, policyVersion: "forgedock.verification/v2",
      typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "test" },
    }];
    const requirements = [{ kind: "command" as const, id: "targeted", criterionIds: ["criterion-1"], rationale: "Regression" }];
    const targets = ["dist/a.test.js"];
    const sourceTargets = ["src/a.test.ts"];
    const targetDigest = createHash("sha256").update(JSON.stringify({ sourceTargets, targets })).digest("hex");
    const contract = deriveEvidenceContract({
      acceptanceCriteria: ["Regression"], verificationRequirements: requirements, controllerGates: [],
      commands: [{ id: "targeted", evidenceCapability: "targeted-test", targets }], invariantMatrices: [],
      expectedPaths: ["src/a.test.ts"], evidencePaths: [{ path: "package.json", criterionIds: ["criterion-1"], role: "artifact" }],
    }).contract;
    const packet = {
      acceptanceCriteria: ["Regression"], expectedPaths: ["src/a.test.ts"], verificationRequirements: requirements,
      verificationPolicyVersion: "forgedock.verification/v2", verificationCommandTargets: [{ id: "targeted", sourceTargets, targets, targetDigest }],
      controllerGates: [], invariantMatrices: [], evidencePaths: [{ path: "package.json", criterionIds: ["criterion-1"], role: "artifact" as const }],
      evidenceContract: contract,
    };
    const exact = selectPacketVerificationCommands(packet, catalog, "a".repeat(40));
    assert.equal(exact[0]?.planId, selectPacketVerificationCommands(packet, catalog, "a".repeat(40))[0]?.planId);

    for (const changed of [
      { ...packet, evidenceContract: { ...contract, criteria: contract.criteria.map((criterion) => ({ ...criterion, semanticCommandIds: [] })) } },
      { ...packet, verificationCommandTargets: [{ id: "targeted", targets: ["dist/other.test.js"] }] },
      { ...packet, verificationCommandTargets: [{ id: "targeted", sourceTargets, targets, targetDigest: "0".repeat(64) }] },
      { ...packet, verificationRequirements: [{ ...requirements[0]!, id: "other" }] },
      { ...packet, evidencePaths: [{ path: "README.md", criterionIds: ["criterion-1"], role: "artifact" as const }] },
      { ...packet, invariantMatrices: [{ id: "matrix-1", criterionId: "criterion-1", capability: "terminal-metadata" as const, dimensions: [{ name: "mode", values: ["safe"] }], testId: "invariant:matrix-1" }] },
    ]) {
      assert.throws(() => selectPacketVerificationCommands(changed, catalog, "a".repeat(40)), /Evidence contract revalidation failed|unavailable verification command|target drift/i);
    }

    const regressionCatalog = [{ ...catalog[0]!, evidenceCapability: "regression" as const }];
    const regressionContract = deriveEvidenceContract({
      acceptanceCriteria: packet.acceptanceCriteria, verificationRequirements: requirements, controllerGates: [],
      commands: [{ id: "targeted", evidenceCapability: "regression", targets }], expectedPaths: packet.expectedPaths,
      evidencePaths: packet.evidencePaths, invariantMatrices: [],
    }).contract;
    const regressionPacket = { ...packet, evidenceContract: regressionContract };
    assert.notEqual(exact[0]?.planId, selectPacketVerificationCommands(regressionPacket, regressionCatalog, "a".repeat(40))[0]?.planId);
    assert.throws(() => selectPacketVerificationCommands({ ...packet, evidencePaths: [{ path: "../secret", criterionIds: ["criterion-1"], role: "artifact" as const }] }, catalog, "a".repeat(40)), /invalid-evidence-path|repository-relative/);
  });
});
