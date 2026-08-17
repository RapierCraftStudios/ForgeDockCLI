import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseOrchestrationIssueNumbers,
  parseResetIssueArgument,
  parseReviewPullRequestArgument,
  parseWorkOnIssueArgument,
} from "./argument-parser.js";

describe("orchestrate argument parsing", () => {
  it("does not treat numeric option values as issue numbers", () => {
    assert.deepEqual(parseOrchestrationIssueNumbers([
      "7", "--confirm", "--rerun", "--no-auto-merge", "--batching", "none",
      "--max-parallel", "1", "--max-remediation-cycles", "2", "--max-remediation-depth", "1",
      "--max-remediation-children", "3", "--milestone", "1",
      "--provider", "openai-codex", "--model", "gpt-5.6-luna",
    ]), [7]);
  });

  it("accepts positional issues on either side of switches and deduplicates them", () => {
    assert.deepEqual(parseOrchestrationIssueNumbers(["7", "8", "--scope-expansion", "scope-locked", "7"]), [7, 8]);
  });

  it("does not treat resume identifiers or model policy values as issues", () => {
    assert.deepEqual(parseOrchestrationIssueNumbers([
      "--resume", "123", "--thinking", "max", "--planning-model", "openai/gpt-plan",
    ]), []);
  });
});

describe("workflow subject parsing", () => {
  it("selects a work-on issue after reordered value options", () => {
    assert.equal(parseWorkOnIssueArgument([
      "--repo", "owner/repo", "--model", "42", "--thinking", "max", "73",
    ]), "73");
  });

  it("selects a review PR after option values", () => {
    assert.equal(parseReviewPullRequestArgument([
      "--issue", "12", "--repo", "owner/repo", "--provider", "openai", "91",
    ]), "91");
  });

  it("selects a reset issue after a numeric-looking reason", () => {
    assert.equal(parseResetIssueArgument(["--reason", "123", "--repo", "owner/repo", "44"]), "44");
  });
});
