// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectVerificationCapabilities } from "./verification-capabilities.js";
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
});
