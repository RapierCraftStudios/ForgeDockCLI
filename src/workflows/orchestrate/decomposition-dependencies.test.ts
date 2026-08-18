// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapDecompositionDependencies } from "./decomposition-dependencies.js";

const nodes = [
  { id: "batch-100", issue: 100, memberIssues: [1, 2] },
  { id: "issue-31", issue: 31, memberIssues: [31] },
  { id: "issue-32", issue: 32, memberIssues: [32] },
];

describe("decomposition prerequisites", () => {
  it("maps batch members to their aggregate node and sibling children normally", () => {
    assert.deepEqual(mapDecompositionDependencies(
      32,
      "## Dependencies\n- #1\n- #31\n",
      nodes,
    ), ["batch-100", "issue-31"]);
  });

  it("rejects prerequisites outside the frozen orchestration DAG", () => {
    assert.throws(
      () => mapDecompositionDependencies(31, "## Blocked by\n- #999\n", nodes),
      /child #31.*outside.*#999/i,
    );
  });

  it("rejects ambiguous issue identities", () => {
    assert.throws(
      () => mapDecompositionDependencies(31, "## Dependencies\n- #1\n", [
        ...nodes,
        { id: "issue-1", issue: 1 },
      ]),
      /#1.*both batch-100 and issue-1/i,
    );
  });

  it("rejects self-dependencies after issue-to-node mapping", () => {
    assert.throws(
      () => mapDecompositionDependencies(31, "## Prerequisites\n- #31\n", nodes),
      /cannot depend on itself/i,
    );
  });
});
