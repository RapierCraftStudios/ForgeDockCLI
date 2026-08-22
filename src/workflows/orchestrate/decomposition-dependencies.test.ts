// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decompositionQualifiedNodeId, mapDecompositionDependencies } from "./decomposition-dependencies.js";

const nodes = [
  { id: "batch-100", repository: "owner/repo", issue: 100, memberIssues: [1, 2] },
  { id: "issue-31", repository: "owner/repo", issue: 31, memberIssues: [31] },
  { id: "issue-32", repository: "owner/repo", issue: 32, memberIssues: [32] },
];

describe("decomposition prerequisites", () => {
  it("maps batch members to their aggregate node and sibling children normally", () => {
    assert.deepEqual(mapDecompositionDependencies(
      32,
      "## Dependencies\n- #1\n- #31\n",
      nodes,
      "owner/repo",
    ), ["batch-100", "issue-31"]);
  });

  it("rejects prerequisites outside the frozen orchestration DAG", () => {
    assert.throws(
      () => mapDecompositionDependencies(31, "## Blocked by\n- #999\n", nodes, "owner/repo"),
      /child #31.*outside.*#999/i,
    );
  });

  it("rejects ambiguous issue identities", () => {
    assert.throws(
      () => mapDecompositionDependencies(31, "## Dependencies\n- #1\n", [
        ...nodes,
        { id: "issue-1", repository: "owner/repo", issue: 1 },
      ], "owner/repo"),
      /#1.*both batch-100 and issue-1/i,
    );
  });

  it("rejects self-dependencies after issue-to-node mapping", () => {
    assert.throws(
      () => mapDecompositionDependencies(31, "## Prerequisites\n- #31\n", nodes, "owner/repo"),
      /cannot depend on itself/i,
    );
  });

  it("isolates equal issue numbers by normalized repository", () => {
    assert.deepEqual(mapDecompositionDependencies(
      8,
      "## Dependencies\n- #7\n",
      [
        { id: "root-7", repository: "OWNER/root", issue: 7, memberIssues: [7] },
        { id: "child-7", repository: "owner/parent", issue: 7, memberIssues: [7] },
      ],
      " owner/parent ",
    ), ["child-7"]);
  });

  it("uses collision-free repository-qualified node IDs", () => {
    const hyphen = decompositionQualifiedNodeId("owner/a-b", 7);
    const underscore = decompositionQualifiedNodeId("owner/a_b", 7);
    assert.notEqual(hyphen, underscore);
    assert.equal(hyphen, "issue-owner%2Fa-b-7");
    assert.equal(underscore, "issue-owner%2Fa_b-7");
  });
});
