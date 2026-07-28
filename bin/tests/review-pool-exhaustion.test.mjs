import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const review = readFileSync(new URL("../../commands/review-pr.md", import.meta.url), "utf8");
const stagingReview = readFileSync(
  new URL("../../commands/review-pr-staging.md", import.meta.url),
  "utf8",
);
const execution = readFileSync(
  new URL("../../commands/orchestrate/phase-4-execution.md", import.meta.url),
  "utf8",
);
const report = readFileSync(
  new URL("../../commands/orchestrate/phase-6-report.md", import.meta.url),
  "utf8",
);
const labels = readFileSync(new URL("../labels.json", import.meta.url), "utf8");

describe("review pool exhaustion", () => {
  it("fails closed rather than substituting an inline or partial review", () => {
    for (const spec of [review, stagingReview]) {
      assert.match(spec, /Dispatch pool exhausted or dispatch call fails/);
      assert.match(spec, /FORGE:REVIEW_BLOCKED reason=dispatch-pool-exhausted/);
      assert.match(spec, /review-degraded/);
      assert.match(spec, /ACTUAL_AGENT_COUNT/);
      assert.match(spec, /SELECTED_AGENT_COUNT/);
    }
  });

  it("blocks staging deployment and reports degraded panels in orchestration", () => {
    assert.match(stagingReview, /DEGRADED_REVIEWS/);
    assert.match(execution, /review panel degraded/);
    assert.match(report, /### Degraded Review Panels/);
    assert.match(labels, /"name": "review-degraded"/);
  });
});
