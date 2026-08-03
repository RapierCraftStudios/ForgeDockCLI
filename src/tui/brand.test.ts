import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { colorMode, COMPACT_MARK, ember, renderHeader, renderMark } from "./brand.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

describe("ForgeDock Chrome & Ember brand", () => {
  it("preserves the compact Cinematic Installer mark", () => {
    assert.equal(COMPACT_MARK.length, 4);
    assert.deepEqual(renderMark("compact", "none"), [...COMPACT_MARK]);
  });

  it("degrades to deterministic plain output for pipes and NO_COLOR", () => {
    assert.equal(colorMode({ COLORTERM: "truecolor" }, pipe), "none");
    assert.equal(colorMode({ NO_COLOR: "1" }, tty), "none");
    assert.doesNotMatch(renderHeader({ mode: "none" }), /\x1b/);
  });

  it("supports truecolor and 256-color terminals", () => {
    assert.match(ember("FORGE", "truecolor"), /38;2/);
    assert.match(ember("FORGE", "256"), /38;5/);
    assert.doesNotMatch(ember("FORGE", "256"), /38;2/);
  });
});
