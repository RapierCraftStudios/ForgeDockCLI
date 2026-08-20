import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { closeExpectedWriteScope } from "./scope-closure.js";

// Frozen-workspace relation fixture: this literal is intentionally read by the
// scope-closure test below, just as a config regression test would reference it.
const configLiteral = "docs/CONFIG.md";

describe("scope closure", () => {
  it("admits deterministic source/test companions but not arbitrary root siblings", async () => {
    const result = await closeExpectedWriteScope(["src/widget.ts", "test/widget.test.ts", "src/unrelated.test.ts"], {
      issueWriteHints: ["src/widget.ts"],
      investigationWriteHints: ["src/widget.ts"],
    });
    assert.deepEqual(result.expectedPaths, ["src/widget.ts", "test/widget.test.ts"]);
    assert.deepEqual(result.rejectedPaths, ["src/unrelated.test.ts"]);
    assert.match(result.diagnostics[0] ?? "", /bounded companion/);
  });

  it("keeps investigation surfaces read-only and accepts controller write hints", async () => {
    const result = await closeExpectedWriteScope(["src/consumer.ts", "src/contract.ts"], {
      issueWriteHints: ["src/consumer.ts"],
      investigationWriteHints: ["src/contract.ts"],
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
      investigationWriteHints: ["docs/CONFIG.md"],
    });
    assert.deepEqual(exact.expectedPaths, []);
    assert.deepEqual(exact.rejectedPaths, ["docs/CONFIG.md"]);

    const companion = await closeExpectedWriteScope(["tests/forgedock-config.test.ts"], {
      investigationWriteHints: ["docs/forgedock-config.ts"],
    });
    assert.deepEqual(companion.expectedPaths, []);
    assert.deepEqual(companion.rejectedPaths, ["tests/forgedock-config.test.ts"]);
  });

  it("admits an investigation path only when explicitly repeated by controller write hints", async () => {
    const result = await closeExpectedWriteScope(["docs/CONFIG.md"], {
      investigationWriteHints: ["docs/CONFIG.md"],
      controllerWriteHints: ["docs/CONFIG.md"],
    });
    assert.deepEqual(result.expectedPaths, ["docs/CONFIG.md"]);
    assert.deepEqual(result.rejectedPaths, []);
  });

  it("bounds collateral admission", async () => {
    const result = await closeExpectedWriteScope([
      "src/a.ts", "test/a.test.ts", "tests/a.spec.ts", "fixtures/a.fixture.ts",
    ], { issueWriteHints: ["src/a.ts"], maxCollateralPaths: 1 });
    assert.equal(result.collateralPaths.length, 1);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.includes("write-scope-limit")));
  });
});
