// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { ensureForgeDockConfig, modelWithThinking, readForgeDockConfig, resolveAutoMerge, resolveOrchestrationConfig, resolveReviewCiConfig, updateForgeDockConfig } from "./forgedock-config.js";

describe("ForgeDock Next project configuration", () => {
  it("bootstraps a valid minimal forge.yaml exactly once", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-config-"));
    try {
      const first = ensureForgeDockConfig(cwd);
      assert.equal(first.created, true);
      const raw = readFileSync(first.path, "utf8");
      assert.match(raw, /^# forge\.yaml — ForgeDock project configuration/m);
      assert.match(raw, /agents: \{\}/);
      assert.match(raw, /orchestration: \{\}/);
      assert.match(raw, /review: \{\}/);
      assert.deepEqual(readForgeDockConfig(cwd), {});

      writeFileSync(first.path, `${raw}# user content\n`);
      const second = ensureForgeDockConfig(cwd);
      assert.equal(second.created, false);
      assert.match(readFileSync(second.path, "utf8"), /# user content/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("updates a managed forge.yaml section without replacing legacy configuration", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-config-"));
    try {
      writeFileSync(join(cwd, "forge.yaml"), "project:\n  owner: Example\n  repo: App\n");
      updateForgeDockConfig(cwd, {
        workerModel: "openai-codex/gpt-5.6-sol",
        workerThinking: "max",
        reviewerThinking: "high",
        planningModel: "anthropic/claude-sonnet",
        planningThinking: "high",
        maxReviewSpecialists: 3,
        maxParallel: 3,
      });
      const raw = readFileSync(join(cwd, "forge.yaml"), "utf8");
      assert.match(raw, /owner: Example/);
      assert.match(raw, /FORGEDOCK:NEXT-CONFIG:START/);
      assert.deepEqual(readForgeDockConfig(cwd), {
        workerModel: "openai-codex/gpt-5.6-sol",
        workerThinking: "max",
        reviewerThinking: "high",
        planningModel: "anthropic/claude-sonnet",
        planningThinking: "high",
        maxReviewSpecialists: 3,
        maxParallel: 3,
      });
      updateForgeDockConfig(cwd, { autoMerge: false });
      assert.equal((readFileSync(join(cwd, "forge.yaml"), "utf8").match(/FORGEDOCK:NEXT-CONFIG:START/g) ?? []).length, 1);
      assert.equal(readForgeDockConfig(cwd).autoMerge, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects an unbounded specialist fleet", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-config-"));
    try {
      assert.throws(() => updateForgeDockConfig(cwd, { maxReviewSpecialists: 7 }), /1 to 6/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("validates planning model and thinking settings like other agent roles", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-config-"));
    try {
      assert.throws(
        () => updateForgeDockConfig(cwd, { planningModel: "planner" }),
        /provider\/model/,
      );
      assert.throws(
        () => updateForgeDockConfig(cwd, { planningThinking: "turbo" as any }),
        /Unsupported thinking level/,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("enables automatic merge by default while preserving explicit opt-out precedence", () => {
    assert.equal(resolveAutoMerge(undefined, undefined), true);
    assert.equal(resolveAutoMerge(undefined, false), false);
    assert.equal(resolveAutoMerge(false, true), false);
    assert.equal(resolveAutoMerge(true, false), true);
  });

  it("defaults orchestration to no batching while preserving configured and invocation policy", () => {
    assert.equal(resolveOrchestrationConfig().batchingPolicy, "none");
    assert.equal(resolveOrchestrationConfig({ batchingPolicy: "aggressive" }).batchingPolicy, "aggressive");
    assert.equal(resolveOrchestrationConfig(
      { batchingPolicy: "aggressive" },
      { batchingPolicy: "conservative" },
    ).batchingPolicy, "conservative");
  });

  it("round-trips nested orchestration policy and applies invocation precedence", () => {
    const cwd = mkdtempSync(join(tmpdir(), "forgedock-config-"));
    try {
      updateForgeDockConfig(cwd, {
        orchestration: {
          batching: { policy: "conservative", maxBatchSize: 6, maxSensitiveBatchSize: 2 },
          scopeExpansion: "recursive", maxRemediationCycles: 3, maxRemediationDepth: 2, maxRemediationChildren: 5, maxParallel: 2, fastLaneTarget: "staging", featurePromotionTarget: "staging", productionTarget: "main", dispatchMode: "preview",
        },
      });
      const raw = readFileSync(join(cwd, "forge.yaml"), "utf8");
      assert.match(raw, /batching:/);
      assert.match(raw, /policy: "conservative"/);
      assert.match(raw, /fast_lane_target: "staging"/);
      const config = readForgeDockConfig(cwd);
      assert.equal(config.batchingPolicy, "conservative");
      assert.equal(config.scopeExpansion, "recursive");
      assert.deepEqual(resolveOrchestrationConfig(config, { batchingPolicy: "none", maxParallel: 1 }), {
        batchingPolicy: "none", maxBatchSize: 6, maxSensitiveBatchSize: 2, scopeExpansion: "recursive",
        maxRemediationCycles: 3, maxRemediationDepth: 2, maxRemediationChildren: 5, maxParallel: 1, autoMerge: true, fastLaneTarget: "staging", featurePromotionTarget: "staging", productionTarget: "main", dispatchMode: "preview",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("applies a configured thinking suffix idempotently", () => {
    assert.equal(modelWithThinking("openai-codex/gpt-5.6-sol", "max"), "openai-codex/gpt-5.6-sol:max");
    assert.equal(modelWithThinking("openai-codex/gpt-5.6-sol:high", "max"), "openai-codex/gpt-5.6-sol:max");
  });
  it("round-trips repository-owned review CI policy", () => { const cwd = mkdtempSync(join(tmpdir(), "forgedock-config-")); try { assert.deepEqual(resolveReviewCiConfig(), { failureAction: "ask", maxFixAttempts: 2, deliveryChecks: ["*"], promotionChecks: ["*"], deploymentChecks: ["*"], repairPaths: [], requiredChecksDefault: "require", requiredChecksTargets: {} }); updateForgeDockConfig(cwd, { review: { ci: { failureAction: "auto-fix", maxFixAttempts: 3, deliveryChecks: ["build"], repairPaths: [".github/workflows"], requiredChecks: { default: "require", targets: { staging: "if-present" } } } } }); assert.equal(resolveReviewCiConfig(readForgeDockConfig(cwd)).failureAction, "auto-fix"); assert.equal(resolveReviewCiConfig(readForgeDockConfig(cwd)).requiredChecksTargets.staging, "if-present"); assert.match(readFileSync(join(cwd, "forge.yaml"), "utf8"), /failure_action: "auto-fix"/); } finally { rmSync(cwd, { recursive: true, force: true }); } });
  it("rejects unsafe CI repair policy", () => { const cwd = mkdtempSync(join(tmpdir(), "forgedock-config-")); try { assert.throws(() => updateForgeDockConfig(cwd, { reviewCiMaxFixAttempts: 6 }), /1 to 5/); assert.throws(() => updateForgeDockConfig(cwd, { reviewCiRepairPaths: ["../outside"] }), /repository-relative/); } finally { rmSync(cwd, { recursive: true, force: true }); } });
});
