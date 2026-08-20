// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import {
  ArtifactPayloadSchemas,
  createArtifact,
  type DurableArtifact,
  type RetryCheckpointPayload,
  type TargetAdvanceCheckpointPayload,
} from "../artifacts/schema.js";
import { encodeArtifactMarker, decodeArtifactMarker, renderArtifactMarkdown } from "../artifacts/codec.js";
import { decideSubjectAdmission } from "./admission.js";
import { reconcileArtifacts } from "./reconcile.js";
import { createRun, transition } from "./machine.js";

const subject = { repo: "acme/repo", issue: 9 };
const producer = { role: "controller" };
const sha = "a".repeat(40);
const digest = "b".repeat(64);
const now = "2026-08-20T00:00:00.000Z";

function retryPayload(status: RetryCheckpointPayload["status"] = "waiting"): RetryCheckpointPayload {
  return {
    checkpoint: "retry", version: "forgedock.retry/v1", domain: "transport", code: "eagain",
    phase: "read", operationKey: "op-1", semanticKey: "subject-1", artifactIds: [],
    attempt: { number: 1, max: 3, firstAt: now, nextAt: "2026-08-20T00:01:00.000Z" },
    reconciliation: "pending", status,
    cause: { class: "transient", message: "temporarily unavailable" }, createdAt: now, updatedAt: now,
  };
}

function retryArtifact(id: string, createdAt: string, status: RetryCheckpointPayload["status"] = "waiting") {
  return createArtifact({ kind: "RetryCheckpoint", runId: "run-1", subject, producer, payload: retryPayload(status) }, { id, createdAt });
}

function targetArtifact(id: string, createdAt: string): DurableArtifact<"TargetAdvanceCheckpoint"> {
  const payload: TargetAdvanceCheckpointPayload = {
    checkpoint: "target-advance", version: "forgedock.target-advance/v1", repository: "acme/repo",
    targetBranch: "main", routeClaimKey: "acme/repo:main", packetArtifactId: "packet-1",
    sourceBuildResultId: "build-1", sourceVerdictId: "verdict-1", sourceBaseSha: sha, sourceHeadSha: sha,
    observedTargetSha: sha, phase: "target-read", expectedPaths: ["src/a.ts"], verifiedContentDigest: digest,
    verificationPlanId: "plan-1", attempt: { number: 1, max: 2 },
    workspace: { path: "/tmp/work", branch: "work", baseRef: "main" }, createdAt: now, updatedAt: now,
  };
  return createArtifact({ kind: "TargetAdvanceCheckpoint", runId: "run-1", subject, producer, payload }, { id, createdAt });
}

test("decodes old orchestration JSON records with omitted additive fields", () => {
  const old = JSON.parse(JSON.stringify({ schema: "forgedock.orchestration/v1", orchestrationId: "dag-1", repository: "acme/repo", issueNumbers: [9], maxParallel: 1, autoMerge: false, status: "running", createdAt: now, updatedAt: now, nodes: [{ id: "n-1", issue: 9, priority: 1, dependencies: [], claims: [], status: "queued", childRunIds: [] }] }));
  assert.equal(old.nodes[0].retryCheckpointId, undefined);
  assert.equal(old.nodes[0].status, "queued");
});

test("validates checkpoint schemas deterministically and rejects digest mutation", () => {
  const artifact = retryArtifact("retry-1", now);
  assert.equal(Check(ArtifactPayloadSchemas.RetryCheckpoint, artifact.payload), true);
  const invalid = structuredClone(artifact.payload);
  invalid.attempt.number = 0;
  assert.equal(Check(ArtifactPayloadSchemas.RetryCheckpoint, invalid), false);
});

test("checkpoint order keeps retry and target recovery nonterminal", () => {
  const intent = createArtifact({ kind: "Intent", runId: "run-1", subject, producer, payload: {
    title: "retry", problem: "transient", constraints: [], acceptanceHints: [], dependencies: [],
  } }, { id: "intent-1", createdAt: now });
  const outcome = createArtifact({ kind: "Outcome", runId: "run-1", subject, producer, payload: {
    status: "blocked", reason: "transient", childIssues: [],
  } }, { id: "outcome-1", createdAt: now });
  const retry = retryArtifact("retry-1", "2026-08-20T00:00:01.000Z");
  const target = targetArtifact("target-1", "2026-08-20T00:00:02.000Z");
  assert.equal(reconcileArtifacts([outcome, retry]).state, "retry_wait");
  assert.equal(reconcileArtifacts([outcome, target]).state, "target_recovery");
  assert.equal(decideSubjectAdmission([intent, outcome, retry]).action, "resume");
  assert.equal(decideSubjectAdmission([intent, outcome, target]).action, "resume");
});

test("checkpoint markers round-trip and render without terminal outcome wording", () => {
  const artifact = retryArtifact("retry-1", now);
  const decoded = decodeArtifactMarker(encodeArtifactMarker(artifact));
  assert.equal(decoded.kind, "RetryCheckpoint");
  assert.match(renderArtifactMarkdown(decoded), /retry_wait|waiting/);
});

test("target and retry state transitions advance version and only resume advances attempt", () => {
  const run = createRun({ workflow: "work-on", subject, runId: "run-1", now });
  const started = transition(run, "START_INVESTIGATION", { now });
  const target = transition({ ...started.state, state: "publishing" }, "TARGET_ADVANCE_DETECTED", { now });
  assert.equal(target.state.state, "target_recovery");
  assert.equal(target.state.attempt, run.attempt);
  const resumed = transition(target.state, "RESUME_TARGET_ADVANCE", { now });
  assert.equal(resumed.state.state, "target_recovery");
  assert.equal(resumed.state.attempt, run.attempt + 1);
  const waiting = transition(resumed.state, "RETRY_WAIT_STARTED", { now });
  assert.equal(waiting.state.state, "retry_wait");
  const due = transition(waiting.state, "RETRY_DUE", { now });
  assert.equal(due.state.state, "target_recovery");
  assert.equal(due.state.version, waiting.state.version + 1);
  assert.equal(due.state.attempt, resumed.state.attempt + 1);
});
