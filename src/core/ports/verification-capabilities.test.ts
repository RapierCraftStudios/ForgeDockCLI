// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectVerificationCapabilities, resolveReadOnlyVerificationSources } from "./verification-capabilities.js";
import type { VerificationCommand } from "./verification.js";

describe("verification capability projection", () => {
  it("projects explicit semantic metadata without executable command details", () => {
    const command: VerificationCommand = {
      id: "test", required: true, selection: "packet", evidenceCapability: "targeted-test",
      command: "node", args: ["--test", "secret.test.js"], cwd: "/private/work",
      timeoutMs: 1000, targeting: "expected-test-paths",
      typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest" },
    };
    const projected = projectVerificationCapabilities([command]);
    assert.deepEqual(projected[0], {
      id: "test", required: true, selection: "packet", evidenceCapability: "targeted-test",
      targeting: "expected-test-paths", allowedSourceRoot: "src",
      allowedTestExtensions: [".ts", ".tsx", ".mts", ".cts"],
      targetPattern: "**/*.test.{ts,tsx,mts,cts}", maxTargets: 32,
    });
    assert.equal(JSON.stringify(projected).includes("secret.test.js"), false);
    assert.equal(JSON.stringify(projected).includes("/private/work"), false);
  });
  it("resolves a unique bare read-only test surface without granting write scope", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-target-"));
    await mkdir(join(cwd, "src", "nested"), { recursive: true });
    await writeFile(join(cwd, "src", "nested", "pi-runtime-tool-renderers.test.ts"), "export {};\n");
    const command = { id: "targeted", typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest" } };
    assert.deepEqual(await resolveReadOnlyVerificationSources(["pi-runtime-tool-renderers.test.ts"], [command], cwd), ["src/nested/pi-runtime-tool-renderers.test.ts"]);
  });

  it("drops malformed optional investigation hints without fuzzy splitting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-optional-target-"));
    await mkdir(join(cwd, "src", "nested"), { recursive: true });
    await writeFile(join(cwd, "src", "nested", "one.test.ts"), "export {};\n");
    const command = { id: "targeted", typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest" } };
    assert.deepEqual(await resolveReadOnlyVerificationSources(
      [], [command], cwd,
      { optionalCandidates: ["src/nested/one.test.ts and src/other.test.ts"] },
    ), []);
  });

  it("keeps explicit missing read-only evidence strict and typed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "forgedock-explicit-target-"));
    await mkdir(join(cwd, "src"), { recursive: true });
    const command = { id: "targeted", typescriptLayout: { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "digest" } };
    await assert.rejects(
      () => resolveReadOnlyVerificationSources(["src/missing.test.ts"], [command], cwd),
      (error: unknown) => error instanceof Error && "code" in error && (error as { code?: string }).code === "missing-target",
    );
  });
});
