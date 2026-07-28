import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const spec = readFileSync(
  new URL("../../commands/work-on/decompose.md", import.meta.url),
  "utf8",
);

describe("decomposition idempotency", () => {
  it("returns an existing exact parent-linked child set before creating another", () => {
    assert.match(spec, /## Phase D2\.5: Equivalent Set Check/);
    assert.match(spec, /--state all/);
    assert.match(spec, /\*\*Parent\*\*: #\{NUMBER\}/);
    assert.match(spec, /group_by\(\.title\) \| map\(\.\[0\]\)/);
    assert.match(spec, /\$actual == \$expected/);
    assert.match(spec, /Do \*\*not\*\* create issues, edit the parent body, or post another decomposition comment/);
    assert.match(spec, /status: ALREADY_DONE/);
  });
});
