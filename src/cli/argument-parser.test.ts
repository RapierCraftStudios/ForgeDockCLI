import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOrchestrationIssueNumbers } from "./argument-parser.js";

describe("orchestrate argument parsing", () => {
  it("does not treat numeric option values as issue numbers", () => {
    assert.deepEqual(parseOrchestrationIssueNumbers([
      "7", "--confirm", "--rerun", "--no-auto-merge", "--batching", "none",
      "--max-parallel", "1", "--max-remediation-cycles", "2", "--milestone", "1",
      "--provider", "openai-codex", "--model", "gpt-5.6-luna",
    ]), [7]);
  });

  it("accepts positional issues on either side of switches and deduplicates them", () => {
    assert.deepEqual(parseOrchestrationIssueNumbers(["7", "8", "--scope-expansion", "scope-locked", "7"]), [7, 8]);
  });
});
