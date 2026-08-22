import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { closeExpectedWriteScope, resolveInvestigationEvidenceSources } from "./scope-closure.js";

// Frozen-workspace relation fixture: this literal is intentionally read by the
// scope-closure test below, just as a config regression test would reference it.
const configLiteral = "docs/CONFIG.md";

describe("scope closure", () => {
  it("admits deterministic source/test companions but not arbitrary root siblings", async () => {
    const result = await closeExpectedWriteScope(["src/widget.ts", "test/widget.test.ts", "src/unrelated.test.ts"], {
      issueWriteHints: ["src/widget.ts"],
    });
    assert.deepEqual(result.expectedPaths, ["src/widget.ts", "test/widget.test.ts"]);
    assert.deepEqual(result.rejectedPaths, ["src/unrelated.test.ts"]);
    assert.match(result.diagnostics[0] ?? "", /bounded companion/);
  });

  it("keeps investigation surfaces read-only and accepts controller write hints", async () => {
    const result = await closeExpectedWriteScope(["src/consumer.ts", "src/contract.ts"], {
      issueWriteHints: ["src/consumer.ts"],
      controllerWriteHints: ["src/contract.ts"],
    });
    assert.deepEqual(result.expectedPaths, ["src/consumer.ts", "src/contract.ts"]);
    assert.deepEqual(result.collateralPaths, []);
  });

  it("admits a collateral test only when its frozen content references the hinted config", async () => {
    assert.equal(configLiteral, "docs/CONFIG.md");
    const result = await closeExpectedWriteScope(["src/workflows/work-on/scope-closure.test.ts"], {
      issueWriteHints: ["docs/CONFIG.md"],
      cwd: process.cwd(),
    });
    assert.deepEqual(result.expectedPaths, ["docs/CONFIG.md", "src/workflows/work-on/scope-closure.test.ts"]);
    assert.deepEqual(result.rejectedPaths, []);
  });

  it("admits a prefixed regression test for a short documentation contract stem", async () => {
    const result = await closeExpectedWriteScope(["src/core/config/forgedock-config.test.ts"], {
      issueWriteHints: ["docs/CONFIG.md"],
    });
    assert.deepEqual(result.expectedPaths, ["docs/CONFIG.md", "src/core/config/forgedock-config.test.ts"]);
    assert.deepEqual(result.rejectedPaths, []);
  });

  it("recognizes multi-extension declaration companions", async () => {
    const result = await closeExpectedWriteScope(["vendor/pi-runtime/dist/core/tools/ls.d.ts"], {
      issueWriteHints: ["vendor/pi-runtime/dist/core/tools/ls.js"],
    });
    assert.deepEqual(result.expectedPaths, ["vendor/pi-runtime/dist/core/tools/ls.d.ts", "vendor/pi-runtime/dist/core/tools/ls.js"]);
    assert.deepEqual(result.rejectedPaths, []);
  });

  it("proves collateral tests through normalized relative TypeScript imports", async () => {
    const result = await closeExpectedWriteScope([
      "src/workflows/orchestrate/scheduler.test.ts",
      "src/adapters/sqlite/sqlite-repositories.test.ts",
    ], {
      issueWriteHints: ["src/core/ports/lease.ts", "src/adapters/sqlite/sqlite-repositories.ts"],
      cwd: process.cwd(),
    });
    assert.deepEqual(result.expectedPaths, [
      "src/adapters/sqlite/sqlite-repositories.test.ts",
      "src/adapters/sqlite/sqlite-repositories.ts",
      "src/core/ports/lease.ts",
      "src/workflows/orchestrate/scheduler.test.ts",
    ]);
    assert.deepEqual(result.rejectedPaths, []);
  });

  it("admits a bounded transitive controller dependency set regardless of proposal order", async () => {
    const proposed = [
      "src/workflows/work-on/complete.test.ts",
      "src/workflows/review-pr/ci-policy.test.ts",
      "src/workflows/promotion/promotion.test.ts",
      "src/core/config/forgedock-config.test.ts",
      "src/core/config/forgedock-config.ts",
      "src/cli/main.ts",
      "src/workflows/review-pr/review-deployment.test.ts",
    ];
    const result = await closeExpectedWriteScope(proposed, {
      issueWriteHints: ["src/workflows/review-pr/review-existing.ts"],
      cwd: process.cwd(),
    });
    assert.deepEqual(result.rejectedPaths, []);
    assert.equal(proposed.every((path) => result.expectedPaths.includes(path)), true);
  });

  it("rejects investigation-only exact and basename-related writes", async () => {
    const exact = await closeExpectedWriteScope(["docs/CONFIG.md"], {
    });
    assert.deepEqual(exact.expectedPaths, []);
    assert.deepEqual(exact.rejectedPaths, ["docs/CONFIG.md"]);

    const companion = await closeExpectedWriteScope(["tests/forgedock-config.test.ts"], {
    });
    assert.deepEqual(companion.expectedPaths, []);
    assert.deepEqual(companion.rejectedPaths, ["tests/forgedock-config.test.ts"]);
  });

  it("admits an investigation path only when explicitly repeated by controller write hints", async () => {
    const result = await closeExpectedWriteScope(["docs/CONFIG.md"], {
      controllerWriteHints: ["docs/CONFIG.md"],
    });
    assert.deepEqual(result.expectedPaths, ["docs/CONFIG.md"]);
    assert.deepEqual(result.rejectedPaths, []);
  });

  it("resolves generated script/config evidence from path-and-line locations without write authority", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-evidence-"));
    try {
      await mkdir(join(cwd, "scripts"), { recursive: true });
      await mkdir(join(cwd, "config"), { recursive: true });
      await writeFile(join(cwd, "scripts/stage-generated.mjs"), "export default true;\n");
      await writeFile(join(cwd, "config/runtime.json"), "{}\n");
      const paths = await resolveInvestigationEvidenceSources([
        "scripts/stage-generated.mjs:9-21",
        "config/runtime.json:1-1",
      ], cwd);
      assert.deepEqual(paths, ["config/runtime.json", "scripts/stage-generated.mjs"]);
      const closure = await closeExpectedWriteScope(paths, {});
      assert.deepEqual(closure.expectedPaths, []);
      assert.deepEqual(closure.rejectedPaths, paths);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("rejects missing, outside-root, directory, and symlink evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-evidence-invalid-"));
    const outside = await mkdtemp(join(tmpdir(), "forgedock-evidence-outside-"));
    try {
      await mkdir(join(cwd, "nested"), { recursive: true });
      await writeFile(join(cwd, "nested/real.mjs"), "ok\n");
      await writeFile(join(outside, "outside.mjs"), "outside\n");
      await symlink(join(outside, "outside.mjs"), join(cwd, "nested/link.mjs"));
      const paths = await resolveInvestigationEvidenceSources([
        "nested/real.mjs:1",
        "nested/real.mjs:not-lines",
        "nested/missing.mjs:1",
        "nested:1",
        "nested/link.mjs:1",
        `${outside}/outside.mjs:1`,
        "BuildPacket art_deadbeef.payload.changedPaths:1",
      ], cwd);
      assert.deepEqual(paths, ["nested/real.mjs"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("bounds evidence source count and bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-evidence-bounds-"));
    try {
      await mkdir(join(cwd, "scripts"), { recursive: true });
      await writeFile(join(cwd, "scripts/large.mjs"), "x".repeat(32));
      await writeFile(join(cwd, "scripts/small.mjs"), "x\n");
      assert.deepEqual(await resolveInvestigationEvidenceSources(
        ["scripts/large.mjs:1", "scripts/small.mjs:1"], cwd,
        { maxSourceLocations: 64, maxPathLength: 512, maxFiles: 64, maxFileBytes: 16, maxTotalBytes: 16 },
      ), ["scripts/small.mjs"]);
      assert.deepEqual(await resolveInvestigationEvidenceSources(
        ["scripts/large.mjs:1", "scripts/small.mjs:2"], cwd,
        { maxSourceLocations: 1, maxPathLength: 512, maxFiles: 64, maxFileBytes: 16, maxTotalBytes: 16 },
      ), []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("bounds collateral admission", async () => {
    const result = await closeExpectedWriteScope([
      "src/a.ts", "test/a.test.ts", "tests/a.spec.ts", "fixtures/a.fixture.ts",
    ], { issueWriteHints: ["src/a.ts"], maxCollateralPaths: 1 });
    assert.equal(result.collateralPaths.length, 1);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("write-scope-limit")));
  });
});
