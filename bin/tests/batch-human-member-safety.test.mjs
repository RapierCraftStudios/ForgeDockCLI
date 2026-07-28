import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

describe("batch human-member safety", () => {
  it("excludes human-gated findings in every batch discovery path", () => {
    for (const path of [
      "commands/orchestrate/phase-1-resolve.md",
      "commands/orchestrate/phase-4-execution.md",
      "commands/cleanup.md",
    ]) {
      const spec = read(path);
      assert.match(spec, /needs-human/);
      assert.match(spec, /operator-only/);
      assert.match(spec, /manual action required/);
    }
  });

  it("keeps human-gated batch members open and references them non-closingly", () => {
    const workOn = read("commands/work-on.md");
    const review = read("commands/work-on/review.md");

    assert.match(workOn, /MEMBER_SNAPSHOT=.*--json state,labels/);
    assert.match(workOn, /MEMBER_GATED=/);
    assert.match(workOn, /SPLIT OUTCOME:.*remains open because it requires a human or operator action/);
    assert.match(review, /BATCH_MEMBER_REFS/);
    assert.match(review, /Refs #%s/);
    assert.match(review, /Batch member disposition/);
  });
});
