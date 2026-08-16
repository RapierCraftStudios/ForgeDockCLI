// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaimPromotionConflictError } from "../workflows/orchestrate/scheduler.js";
import { resolveClaimPromotionConflictAtBoundary } from "./orchestration-claim-conflict.js";

describe("orchestration claim conflict boundaries", () => {
  it("retains standalone work-on ownership of its user-facing suspension", () => {
    const conflict = new ClaimPromotionConflictError("issue-189", ["issue-190"]);
    const resolution = resolveClaimPromotionConflictAtBoundary(conflict, "standalone-work-on");
    assert.equal(resolution.kind, "standalone");
    assert.equal(resolution.conflict, conflict);
  });

  it("propagates a nested work-on conflict to its orchestration parent", () => {
    const conflict = new ClaimPromotionConflictError("issue-189", ["issue-190"]);
    assert.throws(
      () => resolveClaimPromotionConflictAtBoundary(conflict, "nested-work-on"),
      (error) => error === conflict,
    );
  });

  it("converts the propagated conflict to a scheduler suspension at the parent", () => {
    const conflict = new ClaimPromotionConflictError("issue-189", ["issue-190"]);
    const resolution = resolveClaimPromotionConflictAtBoundary(conflict, "orchestration-parent");
    assert.equal(resolution.kind, "suspended");
    assert.equal(resolution.conflict, conflict);
    assert.deepEqual(resolution.result, { status: "suspended", error: conflict });
  });

  it("never disguises an unrelated failure as a claim suspension", () => {
    const failure = new Error("boom");
    assert.throws(
      () => resolveClaimPromotionConflictAtBoundary(failure, "orchestration-parent"),
      (error) => error === failure,
    );
  });
});
