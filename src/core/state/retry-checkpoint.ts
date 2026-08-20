// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createArtifact, type DurableArtifact, type RetryCheckpointPayload, type Subject } from "../artifacts/schema.js";
import type { ArtifactRepository } from "../ports/repositories.js";

/**
 * Persist retry authority before returning a retryable result.  The artifact
 * identity is deterministic for one run/operation/attempt/supersession, while
 * each progression receipt supersedes the previous receipt instead of
 * overwriting it.
 */
export async function persistRetryCheckpoint(input: {
  artifacts: ArtifactRepository;
  runId: string;
  subject: Subject;
  domain: RetryCheckpointPayload["domain"];
  code: string;
  phase: string;
  operationKey: string;
  semanticKey: string;
  nodeId?: string;
  attemptId?: string;
  sessionRef?: string;
  artifactIds?: readonly string[];
  attempt: number;
  maxAttempts: number;
  retryAfterMs?: number;
  nextAttemptAt?: string;
  deadlineAt?: string;
  reconciliation?: RetryCheckpointPayload["reconciliation"];
  status?: RetryCheckpointPayload["status"];
  cause: unknown;
}): Promise<DurableArtifact<"RetryCheckpoint">> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1
    || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1
    || (input.retryAfterMs !== undefined && (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0))) {
    throw new Error("Retry checkpoint attempt and delay bounds are invalid");
  }
  const prior = (await input.artifacts.list(input.subject, "RetryCheckpoint"))
    .filter((artifact): artifact is DurableArtifact<"RetryCheckpoint"> => artifact.kind === "RetryCheckpoint"
      && artifact.runId === input.runId
      && artifact.payload.operationKey === input.operationKey
      && artifact.payload.semanticKey === input.semanticKey)
    .sort((left, right) => left.payload.updatedAt.localeCompare(right.payload.updatedAt) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .at(-1);
  const now = new Date().toISOString();
  const firstAt = prior?.payload.attempt.firstAt ?? now;
  const nextAttemptAt = input.nextAttemptAt
    ?? new Date(Date.now() + (input.retryAfterMs ?? 0)).toISOString();
  const status = input.status ?? (input.attempt >= input.maxAttempts ? "exhausted" : "waiting");
  const cause = input.cause instanceof Error ? input.cause : new Error(String(input.cause));
  const payload: RetryCheckpointPayload = {
    checkpoint: "retry",
    version: "forgedock.retry/v1",
    domain: input.domain,
    code: input.code,
    phase: input.phase,
    operationKey: input.operationKey,
    semanticKey: input.semanticKey,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    ...(input.sessionRef !== undefined ? { sessionRef: input.sessionRef } : {}),
    artifactIds: [...new Set(input.artifactIds ?? [])],
    attempt: {
      number: input.attempt,
      max: input.maxAttempts,
      firstAt,
      nextAt: nextAttemptAt,
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    },
    ...(input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {}),
    ...(prior ? { supersedes: prior.id } : {}),
    reconciliation: input.reconciliation ?? "pending",
    status,
    cause: { class: cause.name || "Error", message: cause.message || String(cause) },
    createdAt: now,
    updatedAt: now,
  };
  const identity = [input.runId, input.operationKey, input.phase, input.attempt, prior?.id ?? "root"].join("\n");
  const artifact = createArtifact({
    kind: "RetryCheckpoint",
    runId: input.runId,
    subject: input.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload,
  }, { id: `retry_${createHash("sha256").update(identity).digest("hex").slice(0, 40)}` });
  await input.artifacts.append(artifact);
  return artifact;
}
