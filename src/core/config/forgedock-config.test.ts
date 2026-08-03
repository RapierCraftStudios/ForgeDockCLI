// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { modelWithThinking, readForgeDockConfig, updateForgeDockConfig } from "./forgedock-config.js";

describe("ForgeDock Next project configuration", () => {
  it("updates a managed forge.yaml section without replacing legacy configuration", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-config-"));
    try {
      writeFileSync(join(cwd, "forge.yaml"), "project:\n  owner: Example\n  repo: App\n");
      updateForgeDockConfig(cwd, {
        workerModel: "openai-codex/gpt-5.6-sol",
        workerThinking: "max",
        reviewerThinking: "high",
        maxParallel: 3,
      });
      const raw = readFileSync(join(cwd, "forge.yaml"), "utf8");
      assert.match(raw, /owner: Example/);
      assert.match(raw, /FORGEDOCK:NEXT-CONFIG:START/);
      assert.deepEqual(readForgeDockConfig(cwd), {
        workerModel: "openai-codex/gpt-5.6-sol",
        workerThinking: "max",
        reviewerThinking: "high",
        maxParallel: 3,
      });
      updateForgeDockConfig(cwd, { autoMerge: false });
      assert.equal((readFileSync(join(cwd, "forge.yaml"), "utf8").match(/FORGEDOCK:NEXT-CONFIG:START/g) ?? []).length, 1);
      assert.equal(readForgeDockConfig(cwd).autoMerge, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies a configured thinking suffix idempotently", () => {
    assert.equal(modelWithThinking("openai-codex/gpt-5.6-sol", "max"), "openai-codex/gpt-5.6-sol:max");
    assert.equal(modelWithThinking("openai-codex/gpt-5.6-sol:high", "max"), "openai-codex/gpt-5.6-sol:max");
  });
});
