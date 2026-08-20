// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalizePacketVerification } from "./prepare.js";
import type { BuildPacketPayload } from "../../core/artifacts/schema.js";

const layout = { sourceRoot: "src", outputRoot: "dist", project: "tsconfig.json", configDigest: "a".repeat(64) };
const catalog = {
  commands: [
    { id: "generic", command: "npm", args: ["test"], required: true, selection: "packet" as const, evidenceCapability: "generic" as const },
    { id: "targeted-tests", command: "node", args: ["--test"], required: true, selection: "packet" as const, targeting: "expected-test-paths" as const, typescriptLayout: layout, evidenceCapability: "targeted-test" as const },
  ],
  controllerGates: [],
};

function packet(): BuildPacketPayload {
  return {
    scope: ["src"], acceptanceCriteria: ["criterion one", "criterion two", "criterion three regression"], context: [],
    implementationPlan: ["implement"], expectedPaths: ["src/foo.test.ts"], verificationPlan: ["generic"],
    verificationRequirements: [{ kind: "command" as const, id: "generic", criterionIds: ["criterion-1", "criterion-2"], rationale: "supplemental" }],
    risks: [], outOfScope: [],
  };
}

describe("controller semantic completion regressions #393 #394 #399 #400", () => {
  it("#400 auto-selects a proven targeted test for missing criterion 3", () => {
    const result = canonicalizePacketVerification(packet(), catalog, ["src/foo.test.ts"], []);
    const requirement = result.verificationRequirements?.find(({ criterionIds }) => criterionIds.includes("criterion-3"));
    assert.deepEqual(requirement, {
      kind: "command", id: "targeted-tests", criterionIds: ["criterion-3"],
      rationale: "Controller auto-completed semantic evidence from validated relation closure and catalog capability.",
    });
  });

  it("#393/#394/#399 fail once with one controller diagnostic when semantic proof is unavailable", () => {
    assert.throws(() => canonicalizePacketVerification(packet(), {
      commands: [{ id: "generic", command: "npm", args: ["test"], required: true, selection: "packet" as const, evidenceCapability: "generic" as const }],
      controllerGates: [],
    }, ["src/foo.test.ts"], []), (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /semantic-completion/);
      assert.equal((error as { directBlock?: boolean }).directBlock, true);
      return true;
    });
  });
});
