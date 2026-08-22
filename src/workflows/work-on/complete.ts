// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import { pullRequestMergeability, type ForgeHost, type PullRequestMergeGate, type PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { summarizeControllerTiming, summarizeQuality, summarizeTelemetry, type TelemetryRepository } from "../../core/ports/telemetry.js";
import type { BatchMemberContract } from "../orchestrate/batching.js";
import {
  abortablePollDelay,
  controllerPollDelay,
  controllerPollInterval,
  pollingAbortError,
  throwIfPollingAborted,
} from "../review-pr/polling.js";
import { renderTrajectoryComment, trajectoryCommentMarker, trajectoryReceiptFromArtifacts } from "./trajectory.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import { deterministicOutcomeId, WorkflowExecutionError, retryableExternalWorkflowError } from "./investigate.js";
import { resolveReviewCiConfig, type EffectiveReviewCiConfig } from "../../core/config/forgedock-config.js";
import { assertRunTargetsBranch } from "./lane.js";
import { assessMergeAdmission, formatPullRequestCiBlock, requiredChecksMode } from "../review-pr/ci-policy.js";

export interface MergeGatePollProgress {
  attempt: number;
  reason: "required-checks-pending" | "mergeability-unknown";
  gate: PullRequestMergeGate;
  nextPollInMs: number;
}

const mergeGatePollInterval = controllerPollInterval;
const mergeGatePollDelay = controllerPollDelay;

function abortError(signal: AbortSignal): Error {
  return pollingAbortError(signal, "Merge-gate polling aborted");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  throwIfPollingAborted(signal, "Merge-gate polling aborted");
}

function waitForMergeGatePoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  return abortablePollDelay(delayMs, signal, abortError);
}

/**
 * Finalize an investigation that proved the issue invalid. The invalid
 * Outcome written by investigation is a durable, provisional checkpoint; the
 * terminal projection is appended only after the typed host has closed the
 * exact issue and an authoritative re-read proves CLOSED.
 */
export async function completeInvalidWorkItem(
  input: {
    run: RunState;
    investigation: DurableArtifact<"Investigation">;
    outcome: DurableArtifact<"Outcome">;
    /** Original issue members represented by a synthetic batch subject. */
    childIssues?: readonly number[];
    /** Durable batch contracts are accepted as a typed fallback for member identity. */
    memberContracts?: readonly BatchMemberContract[];
  },
  dependencies: { host: ForgeHost; artifacts: ArtifactRepository; signal?: AbortSignal; assertActive?: () => void },
): Promise<{ run: RunState; outcome: DurableArtifact<"Outcome"> }> {
  if (input.run.state !== "invalid") throw new Error(`Invalid closure requires invalid state, found ${input.run.state}`);
  if (input.investigation.payload.outcome !== "invalid") throw new Error("Invalid closure requires an invalid Investigation artifact");
  if (input.outcome.payload.status !== "invalid") throw new Error("Invalid closure requires an invalid Outcome artifact");
  const issue = input.run.subject.issue;
  if (!issue) throw new Error("Invalid closure requires an issue subject");
  const closure = input.outcome.payload.issueClosure;
  if (closure && (closure.repo.toLowerCase() !== input.run.subject.repo.toLowerCase() || closure.issue !== issue)) {
    throw new Error(`Invalid closure proof targets ${closure.repo}#${closure.issue}, expected ${input.run.subject.repo}#${issue}`);
  }
  if (!dependencies.host.closeIssue) throw new Error("Invalid closure requires typed host closeIssue support");
  const reportedChildIssues = normalizeInvalidBatchMembers(input.childIssues, issue);
  const contractedChildIssues = input.memberContracts === undefined
    ? undefined
    : normalizeInvalidBatchMembers(input.memberContracts.map((contract) => contract.issue), issue);
  if (contractedChildIssues !== undefined && input.childIssues !== undefined
    && !sameIssueSet(reportedChildIssues, contractedChildIssues)) {
    throw new Error("Invalid batch closure member scope does not match the durable batch contracts");
  }
  const childIssues = contractedChildIssues ?? reportedChildIssues;
  const isBatch = childIssues.length > 0;
  const terminalOutcomeId = deterministicOutcomeId(input.run.runId, input.run.subject, "invalid:closure-completed");
  const assertActive = (): void => {
    if (dependencies.signal?.aborted) throw dependencies.signal.reason ?? new Error("Invalid settlement cancelled");
    dependencies.assertActive?.();
  };
  assertActive();
  try {
    const reason = `ForgeDock investigation ${input.investigation.id} proved this issue invalid: ${input.outcome.payload.reason} (evidence artifact ${input.investigation.id}).`;
    const durableFinal = (await dependencies.artifacts.list(input.run.subject, "Outcome"))
      .find((artifact): artifact is DurableArtifact<"Outcome"> => artifact.kind === "Outcome" && artifact.id === terminalOutcomeId);
    if (durableFinal) {
      const projection = assertMatchingInvalidOutcome(durableFinal, input.run, childIssues);
      if (isBatch) {
        assertActive();
        await assertDurableInvalidBatchProjection(
          dependencies.host,
          input.run.subject.repo,
          childIssues,
          projection.completed,
        );
        await ensureIssueClosed(dependencies.host, input.run.subject.repo, issue, reason, dependencies.signal, dependencies.assertActive);
      } else {
        // Keep the single-issue closure behavior: the close command remains
        // idempotent at the typed host boundary even for an already-closed issue.
        assertActive();
        await dependencies.host.closeIssue(input.run.subject.repo, issue, reason);
        assertActive();
        await assertClosedIssue(dependencies.host, input.run.subject.repo, issue);
      }
      return { run: input.run, outcome: durableFinal };
    }

    let batchProjection: InvalidBatchProjection | undefined;
    if (isBatch) {
      assertActive();
      batchProjection = await projectInvalidBatchMembers({
        run: input.run,
        investigation: input.investigation,
        aggregateReason: reason,
        childIssues,
        artifacts: dependencies.artifacts,
        host: dependencies.host,
        ...(dependencies.signal !== undefined ? { signal: dependencies.signal } : {}),
        ...(dependencies.assertActive !== undefined ? { assertActive: dependencies.assertActive } : {}),
      });
      // Batch members and the aggregate must be rechecked after projection.
      assertActive();
      await ensureIssueClosed(dependencies.host, input.run.subject.repo, issue, reason, dependencies.signal, dependencies.assertActive);
    } else {
      assertActive();
      await dependencies.host.closeIssue(input.run.subject.repo, issue, reason);
      assertActive();
      await assertClosedIssue(dependencies.host, input.run.subject.repo, issue);
    }
    if (closure?.status === "completed" && !isBatch) return { run: input.run, outcome: input.outcome };
    const preservedReason = batchProjection?.preserved.length
      ? ` Batch members ${batchProjection.preserved.map((child) => `#${child.issue} (${child.labels.join(", ")})`).join(", ")} remain open for human or operator action.`
      : "";
    const finalized = createArtifact({
      kind: "Outcome",
      runId: input.run.runId,
      subject: input.run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        ...input.outcome.payload,
        ...(input.run.targetBranch ? { targetBranch: input.run.targetBranch } : {}),
        ...(input.run.promotionTarget ? { promotionTarget: input.run.promotionTarget } : {}),
        ...(input.run.productionTarget ? { productionTarget: input.run.productionTarget } : {}),
        reason: `${reason} Authoritative GitHub state is CLOSED.${preservedReason}`,
        ...(isBatch ? {
          childIssues: (batchProjection?.completed ?? []).map((childIssue) => `issue-${childIssue}`),
          preservedChildIssues: (batchProjection?.preserved ?? []).map((child) => `issue-${child.issue}`),
        } : {}),
        issueClosure: {
          status: "completed",
          repo: input.run.subject.repo,
          issue,
          verifiedAt: new Date().toISOString(),
        },
      },
    }, {
      id: terminalOutcomeId,
    });
    assertActive();
    await dependencies.artifacts.append(finalized);
    assertActive();
    return { run: input.run, outcome: finalized };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const externalRetry = retryableExternalWorkflowError(error, input.run);
    if (externalRetry) throw externalRetry;
    throw new WorkflowExecutionError(reason, input.run, { cause: error });
  }
}

export async function completeWorkItem(
  input: {
    run: RunState;
    pullRequest: PullRequestSnapshot;
    verdict: DurableArtifact<"ReviewVerdict">;
    autoMerge: boolean;
    ciPolicy?: EffectiveReviewCiConfig;
    childIssues?: readonly number[];
    memberContracts?: readonly BatchMemberContract[];
    /** Abort controller shutdown or ownership cancellation without publishing a blocker. */
    signal?: AbortSignal;
    /** Poll cadence is clamped to a safe range; production polling has no attempt limit. */
    mergeGatePollIntervalMs?: number;
    /** Optional live evidence sink for UI/heartbeat integrations. */
    onMergeGatePoll?: (progress: MergeGatePollProgress) => void | Promise<void>;
  },
  dependencies: {
    host: ForgeHost;
    artifacts: ArtifactRepository;
    runs: RunRepository;
    telemetry?: TelemetryRepository;
    /** Controller fencing witness, checked before each live query and mutation. */
    leaseGuard?: { assertValid(): void };
  },
): Promise<{ run: RunState; awaitingHuman: boolean; outcome?: DurableArtifact<"Outcome"> }> {
  if (input.run.state !== "merging" && input.run.state !== "closing") throw new Error(`Completion requires merging or closing state, found ${input.run.state}`);
  if (input.verdict.payload.disposition !== "approve") throw new Error("Cannot complete without an approving Review Verdict");
  let run = input.run;
  const alreadyMergedCheckpoint = run.state === "closing";
  let mergedExactHead = alreadyMergedCheckpoint;
  try {
    assertRunTargetsBranch(run, input.pullRequest.baseBranch);
    let pullRequest = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
    assertRunTargetsBranch(run, pullRequest.baseBranch);
    if (pullRequest.headSha !== input.verdict.payload.headSha) {
      throw new Error(`Approved SHA ${input.verdict.payload.headSha} is stale; current PR head is ${pullRequest.headSha}`);
    }
    const ciPolicy = input.ciPolicy ?? resolveReviewCiConfig();
    if (!alreadyMergedCheckpoint && pullRequest.state !== "MERGED" && !input.autoMerge) return { run, awaitingHuman: true };
    if (alreadyMergedCheckpoint || pullRequest.state === "MERGED" || input.autoMerge) {
      let admissionAttempt = 0;
      while (true) {
        const admission = await waitForAuthoritativeMergeGate({
          host: dependencies.host,
          runs: dependencies.runs,
          run,
          pullRequest,
          expectedHeadSha: input.verdict.payload.headSha,
          expectedBaseBranch: run.targetBranch!,
          policy: ciPolicy,
          pollIntervalMs: mergeGatePollInterval(input.mergeGatePollIntervalMs),
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onMergeGatePoll ? { onPoll: input.onMergeGatePoll } : {}),
          ...(dependencies.leaseGuard ? { leaseGuard: dependencies.leaseGuard } : {}),
        });
        if (admission.terminalReason) {
          return blockMergeAdmission(
            run,
            admission.pullRequest,
            admission.gate,
            admission.terminalReason,
            dependencies,
            awaitingHumanForMergeGate(admission.gate),
          );
        }
        pullRequest = admission.pullRequest;
        if (admission.alreadyMerged) break;
        throwIfAborted(input.signal);
        dependencies.leaseGuard?.assertValid();
        try {
          await dependencies.host.mergePullRequest(
            pullRequest.repo,
            pullRequest.number,
            input.verdict.payload.headSha,
            run.targetBranch!,
            { requiredChecksMode: requiredChecksMode(ciPolicy, run.targetBranch!) },
          );
          break;
        } catch (error) {
          let afterCommand: PullRequestSnapshot;
          try {
            afterCommand = await dependencies.host.getPullRequest(pullRequest.repo, pullRequest.number);
          } catch (confirmationError) {
            if (isRecoverableCompletionTransportFailure(confirmationError)) {
              throw new WorkflowExecutionError(
                `Merge command response was ambiguous for PR #${pullRequest.number}; exact merged identity requires resume`,
                run,
                { cause: confirmationError, recoverable: true },
              );
            }
            throw confirmationError;
          }
          if (afterCommand.state === "MERGED") {
            assertMergedPullRequestIdentity(
              afterCommand,
              input.pullRequest.repo,
              input.pullRequest.number,
              input.verdict.payload.headSha,
              run.targetBranch!,
            );
            pullRequest = afterCommand;
            break;
          }
          assertOpenPullRequestIdentity(
            afterCommand,
            input.pullRequest.repo,
            input.pullRequest.number,
            input.verdict.payload.headSha,
            run.targetBranch!,
          );
          pullRequest = afterCommand;
          const transientReason = transientMergeAdmissionError(error);
          if (!transientReason) throw error;
          admissionAttempt += 1;
          const pollIntervalMs = mergeGatePollDelay(
            mergeGatePollInterval(input.mergeGatePollIntervalMs),
            admissionAttempt,
          );
          dependencies.leaseGuard?.assertValid();
          await dependencies.runs.recordProgress({
            runId: run.runId,
            phase: "merge-gate.poll",
            message: `Merge-time authority became transient for PR #${pullRequest.number}; re-querying live gate (attempt ${admissionAttempt})`,
            occurredAt: new Date().toISOString(),
          });
          await input.onMergeGatePoll?.({
            attempt: admissionAttempt,
            reason: transientReason,
            gate: admission.gate,
            nextPollInMs: pollIntervalMs,
          });
          await waitForMergeGatePoll(pollIntervalMs, input.signal);
        }
      }
      try {
        pullRequest = await dependencies.host.getPullRequest(pullRequest.repo, pullRequest.number);
      } catch (confirmationError) {
        if (isRecoverableCompletionTransportFailure(confirmationError)) {
          throw new WorkflowExecutionError(
            `Merge command response was ambiguous for PR #${pullRequest.number}; exact merged identity requires resume`,
            run,
            { cause: confirmationError, recoverable: true },
          );
        }
        throw confirmationError;
      }
      assertMergedPullRequestIdentity(
        pullRequest,
        input.pullRequest.repo,
        input.pullRequest.number,
        input.verdict.payload.headSha,
        run.targetBranch!,
      );
      mergedExactHead = true;
    }

    if (!mergedExactHead) {
      assertMergedPullRequestIdentity(
        pullRequest,
        input.pullRequest.repo,
        input.pullRequest.number,
        input.verdict.payload.headSha,
        run.targetBranch!,
      );
      mergedExactHead = true;
    }

    if (!alreadyMergedCheckpoint) {
      const merged = transition(run, "MERGE_COMPLETED", { headSha: pullRequest.headSha });
      await dependencies.runs.commit(run.version, merged.state, merged.record);
      run = merged.state;
    } else {
      // A prior merge was durably committed; resume only the idempotent
      // closure/projection side effects after revalidating exact identity.
      assertMergedPullRequestIdentity(
        pullRequest,
        input.pullRequest.repo,
        input.pullRequest.number,
        input.verdict.payload.headSha,
        run.targetBranch!,
      );
    }
    const issue = run.subject.issue;
    if (!issue) throw new Error("work-on completion requires an issue subject");
    const childIssues = [...new Set(input.childIssues ?? [])]
      .filter((child) => Number.isSafeInteger(child) && child > 0 && child !== issue);
    const terminalOutcomeId = deterministicOutcomeId(
      run.runId,
      run.subject,
      `merged:pr:${pullRequest.number}:sha:${pullRequest.headSha}`,
    );
    const durableTerminal = (await dependencies.artifacts.list(run.subject, "Outcome"))
      .find((artifact): artifact is DurableArtifact<"Outcome"> => artifact.kind === "Outcome" && artifact.id === terminalOutcomeId);
    if (durableTerminal) {
      assertMatchingMergedOutcome(durableTerminal, run, pullRequest, childIssues);
      const completedChildren = new Set(durableTerminal.payload.childIssues.map(parseChildIssueReference));
      for (const childIssue of childIssues) {
        const observed = await readIssue(dependencies.host, run.subject.repo, childIssue);
        if (completedChildren.has(childIssue) && observed.state !== "CLOSED") {
          throw new Error(`Durable batch Outcome ${durableTerminal.id} names reopened issue #${childIssue}; refusing to re-close it automatically`);
        }
      }
      await assertClosedIssue(dependencies.host, run.subject.repo, issue);
      run = attachArtifact(run, "Outcome", durableTerminal.id);
      const closed = transition(run, "CLOSE_COMPLETED");
      await dependencies.runs.commit(run.version, closed.state, closed.record);
      return { run: closed.state, awaitingHuman: false, outcome: durableTerminal };
    }
    const childOutcomes: Array<{ issue: number; artifact: DurableArtifact<"Outcome"> }> = [];
    const preservedChildren: Array<{ issue: number; labels: string[] }> = [];
    for (const childIssue of childIssues) {
      const observed = await readIssue(dependencies.host, run.subject.repo, childIssue);
      const protectedLabels = protectedClosureLabels(observed.labels ?? []);
      if (protectedLabels.length) {
        preservedChildren.push({ issue: childIssue, labels: protectedLabels });
        continue;
      }
      if (observed.state === "OPEN") {
        await dependencies.host.closeIssue(
          run.subject.repo,
          childIssue,
          `Completed by batch issue #${issue} via ${pullRequest.url} at ${pullRequest.headSha}.`,
        );
        await assertClosedIssue(dependencies.host, run.subject.repo, childIssue);
      }
      const childSubject = { repo: run.subject.repo, issue: childIssue };
      const childOutcome = createArtifact({
        kind: "Outcome",
        runId: run.runId,
        subject: childSubject,
        producer: { role: "controller", runtime: "forgedock" },
        payload: {
          status: "merged",
          reason: `Completed as member of batch issue #${issue} by PR #${pullRequest.number}.`,
          ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
          ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
          ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
          finalSha: pullRequest.headSha,
          prUrl: pullRequest.url,
          childIssues: [],
          batchParent: issue,
        },
      }, {
        id: deterministicOutcomeId(
          run.runId,
          childSubject,
          `merged:batch:${issue}:pr:${pullRequest.number}:sha:${pullRequest.headSha}`,
        ),
      });
      childOutcomes.push({ issue: childIssue, artifact: childOutcome });
    }

    await dependencies.host.closeIssue(
      run.subject.repo,
      issue,
      `Completed by ${pullRequest.url} at ${pullRequest.headSha}.`,
    );
    await assertClosedIssue(dependencies.host, run.subject.repo, issue);

    const completedChildIssues = childOutcomes.map(({ issue: childIssue }) => childIssue);
    const preservedReason = preservedChildren.length
      ? ` Batch members ${preservedChildren.map((child) => `#${child.issue} (${child.labels.join(", ")})`).join(", ")} remain open for human or operator action.`
      : "";
    const outcome = createArtifact({
      kind: "Outcome",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        status: "merged",
        reason: `Merged PR #${pullRequest.number} after independent review of ${pullRequest.headSha}.${preservedReason}`,
        ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
        ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
        ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
        finalSha: pullRequest.headSha,
        prUrl: pullRequest.url,
        childIssues: completedChildIssues.map((child) => `issue-${child}`),
      },
    }, { id: terminalOutcomeId });

    const parentArtifacts = await dependencies.artifacts.list({ repo: run.subject.repo, issue });
    const contracts = new Map((input.memberContracts ?? []).map((contract) => [contract.issue, contract]));
    const trajectoryArtifacts = [...parentArtifacts, outcome, input.verdict];
    const telemetry = dependencies.telemetry ? summarizeTelemetry(dependencies.telemetry.listTelemetry(run.runId)) : undefined;
    const history = await dependencies.runs.history(run.runId);
    const progress = await dependencies.runs.listProgress(run.runId);
    const controllerTiming = summarizeControllerTiming(
      run.createdAt,
      history,
      Date.parse(run.updatedAt),
      progress,
    );
    const qualitySummary = summarizeQuality({
      run,
      transitions: history,
      progress,
      artifacts: trajectoryArtifacts,
      ...(dependencies.telemetry ? { agentReceipts: dependencies.telemetry.listTelemetry(run.runId) } : {}),
      now: Date.parse(run.updatedAt),
    });
    for (const child of childOutcomes) {
      const contract = contracts.get(child.issue);
      const receipt = trajectoryReceiptFromArtifacts({
        memberIssue: child.issue,
        batchParent: issue,
        ...(contract ? { contract } : {}),
        artifacts: [...trajectoryArtifacts, child.artifact],
        pullRequest: { url: pullRequest.url, number: pullRequest.number, finalSha: pullRequest.headSha, targetBranch: pullRequest.baseBranch },
        childIssues: [],
        childOutcomeIds: [child.artifact.id],
        ...(telemetry !== undefined ? { telemetry } : {}),
        qualitySummary,
        controllerTiming,
      });
      await publishTrajectory(dependencies.host, {
        repo: run.subject.repo,
        issue: child.issue,
        marker: trajectoryCommentMarker(receipt),
        body: renderTrajectoryComment(receipt),
      });
    }
    const parentReceipt = trajectoryReceiptFromArtifacts({
      memberIssue: issue,
      artifacts: trajectoryArtifacts,
      pullRequest: { url: pullRequest.url, number: pullRequest.number, finalSha: pullRequest.headSha, targetBranch: pullRequest.baseBranch },
      disposition: childIssues.length ? "recursive-remediation" : "direct-merge",
      childIssues: completedChildIssues,
      childOutcomeIds: childOutcomes.map(({ artifact }) => artifact.id),
      ...(telemetry !== undefined ? { telemetry } : {}),
      qualitySummary,
      controllerTiming,
    });
    await publishTrajectory(dependencies.host, {
      repo: run.subject.repo,
      issue,
      marker: trajectoryCommentMarker(parentReceipt),
      body: renderTrajectoryComment(parentReceipt),
    });
    // A merged Outcome is the durable terminal projection. Publish it only
    // after every idempotent trajectory and closure side effect succeeds, so
    // an interruption remains recoverable from the approving verdict.
    for (const child of childOutcomes) await dependencies.artifacts.append(child.artifact);
    await dependencies.artifacts.append(outcome);
    run = attachArtifact(run, "Outcome", outcome.id);
    const closed = transition(run, "CLOSE_COMPLETED");
    await dependencies.runs.commit(run.version, closed.state, closed.record);
    return { run: closed.state, awaitingHuman: false, outcome };
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const externalRetry = retryableExternalWorkflowError(error, run);
    if (externalRetry) throw externalRetry;
    // MERGE_COMPLETED is already durable and the exact approved head was
    // proved authoritative. Transport exhaustion during comment/closure
    // projection must retain that closing checkpoint for resume, not strand
    // the delivery as an ordinary FAIL.
    if (mergedExactHead && isRecoverableCompletionTransportFailure(error)) {
      throw new WorkflowExecutionError(reason, run, { cause: error, recoverable: true });
    }
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}

async function readMergeGate(
  host: ForgeHost,
  pullRequest: PullRequestSnapshot,
  expectedHeadSha: string,
  expectedBaseBranch: string,
): Promise<PullRequestMergeGate> {
  const unavailable = (detail: string): PullRequestMergeGate => ({
    repo: pullRequest.repo,
    pullRequest: pullRequest.number,
    headSha: expectedHeadSha,
    baseBranch: expectedBaseBranch,
    mergeable: false,
    mergeability: "unavailable",
    mergeabilityReason: detail.slice(0, 500),
    requiredChecksProvenance: "unavailable",
    requiredChecks: [{ name: "merge-admission-query", state: "unavailable", detailsUrl: detail.slice(0, 500) }],
    observedAt: new Date().toISOString(),
  });
  if (!host.getPullRequestMergeGate) return unavailable("ForgeHost does not implement authoritative pull-request merge admission");
  try {
    return await host.getPullRequestMergeGate(
      pullRequest.repo,
      pullRequest.number,
      expectedHeadSha,
      expectedBaseBranch,
    );
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

interface MergeGateAdmission {
  gate: PullRequestMergeGate;
  pullRequest: PullRequestSnapshot;
  terminalReason?: string;
  alreadyMerged?: true;
}

async function waitForAuthoritativeMergeGate(input: {
  host: ForgeHost;
  runs: RunRepository;
  run: RunState;
  pullRequest: PullRequestSnapshot;
  expectedHeadSha: string;
  expectedBaseBranch: string;
  policy: EffectiveReviewCiConfig;
  pollIntervalMs: number;
  signal?: AbortSignal;
  onPoll?: (progress: MergeGatePollProgress) => void | Promise<void>;
  leaseGuard?: { assertValid(): void };
}): Promise<MergeGateAdmission> {
  let pullRequest = input.pullRequest;
  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(input.signal);
    input.leaseGuard?.assertValid();
    const gate = await readMergeGate(input.host, pullRequest, input.expectedHeadSha, input.expectedBaseBranch);
    assertMergeGateIdentity(gate, pullRequest.repo, pullRequest.number, input.expectedHeadSha, input.expectedBaseBranch);

    // Re-read after every checks query, including unavailable responses, so no
    // PR-scoped observation can be attached to a changed head/base/state.
    const revalidated = await input.host.getPullRequest(pullRequest.repo, pullRequest.number);
    if (revalidated.state === "MERGED") {
      assertMergedPullRequestIdentity(
        revalidated,
        pullRequest.repo,
        pullRequest.number,
        input.expectedHeadSha,
        input.expectedBaseBranch,
      );
      const mergedAssessment = assessMergeAdmission(revalidated, gate, input.policy);
      return {
        gate,
        pullRequest: revalidated,
        ...(mergedAssessment.ready ? { alreadyMerged: true as const } : {
          terminalReason: `Merge admission is blocked: ${formatPullRequestCiBlock(mergedAssessment, input.policy.failureAction, "after")}`,
        }),
      };
    }
    assertOpenPullRequestIdentity(revalidated, pullRequest.repo, pullRequest.number, input.expectedHeadSha, input.expectedBaseBranch);
    pullRequest = revalidated;

    const terminalReason = terminalMergeGateFailure(gate, pullRequest, input.policy);
    if (terminalReason) return { gate, pullRequest, terminalReason };
    const transientReason = transientMergeGateReason(gate);
    if (!transientReason) return { gate, pullRequest };

    const nextPollInMs = mergeGatePollDelay(input.pollIntervalMs, attempt);
    const progress: MergeGatePollProgress = {
      attempt,
      reason: transientReason,
      gate,
      nextPollInMs,
    };
    input.leaseGuard?.assertValid();
    await input.runs.recordProgress({
      runId: input.run.runId,
      phase: "merge-gate.poll",
      message: transientReason === "required-checks-pending"
        ? `Required checks pending for PR #${gate.pullRequest}; polling authoritative GitHub state (attempt ${attempt})`
        : `GitHub mergeability unknown for PR #${gate.pullRequest}; polling authoritative state (attempt ${attempt})`,
      occurredAt: new Date().toISOString(),
    });
    await input.onPoll?.(progress);
    await waitForMergeGatePoll(nextPollInMs, input.signal);
  }
}

function assertMergeGateIdentity(
  gate: PullRequestMergeGate,
  expectedRepo: string,
  expectedNumber: number,
  expectedHeadSha: string,
  expectedBaseBranch: string,
): void {
  if (gate.repo.toLowerCase() !== expectedRepo.toLowerCase() || gate.pullRequest !== expectedNumber) {
    throw new Error(`Merge admission identified ${gate.repo}#${gate.pullRequest}, expected ${expectedRepo}#${expectedNumber}`);
  }
  if (gate.headSha !== expectedHeadSha) {
    throw new Error(`Merge admission is stale: reviewed ${expectedHeadSha}, gate observed ${gate.headSha}`);
  }
  if (gate.baseBranch !== expectedBaseBranch) {
    throw new Error(`Merge admission target is stale: expected ${expectedBaseBranch}, gate observed ${gate.baseBranch}`);
  }
}

function assertOpenPullRequestIdentity(
  pullRequest: PullRequestSnapshot,
  expectedRepo: string,
  expectedNumber: number,
  expectedHeadSha: string,
  expectedBaseBranch: string,
): void {
  if (pullRequest.repo.toLowerCase() !== expectedRepo.toLowerCase() || pullRequest.number !== expectedNumber) {
    throw new Error(`Pull request revalidation identified ${pullRequest.repo}#${pullRequest.number}, expected ${expectedRepo}#${expectedNumber}`);
  }
  if (pullRequest.headSha !== expectedHeadSha) {
    throw new Error(`Approved SHA ${expectedHeadSha} is stale; current PR head is ${pullRequest.headSha}`);
  }
  if (pullRequest.baseBranch !== expectedBaseBranch) {
    throw new Error(`Pull request target changed: expected ${expectedBaseBranch}, current ${pullRequest.baseBranch}`);
  }
  if (pullRequest.state !== "OPEN") {
    throw new Error(`Pull request #${expectedNumber} changed state while reading merge admission: ${pullRequest.state}`);
  }
}

function assertMergedPullRequestIdentity(
  pullRequest: PullRequestSnapshot,
  expectedRepo: string,
  expectedNumber: number,
  expectedHeadSha: string,
  expectedBaseBranch: string,
): void {
  if (pullRequest.repo.toLowerCase() !== expectedRepo.toLowerCase()
    || pullRequest.number !== expectedNumber
    || pullRequest.headSha !== expectedHeadSha
    || pullRequest.baseBranch !== expectedBaseBranch
    || pullRequest.state !== "MERGED") {
    throw new Error(
      `Merge command completed without exact merged identity ${expectedRepo}#${expectedNumber} ${expectedHeadSha} -> ${expectedBaseBranch}`,
    );
  }
}

function terminalMergeGateFailure(gate: PullRequestMergeGate, pullRequest: PullRequestSnapshot, policy: EffectiveReviewCiConfig): string | undefined {
  const assessment = assessMergeAdmission(pullRequest, gate, policy, { productionTarget: pullRequest.baseBranch });
  if (assessment.pending.length || pullRequestMergeability(gate) === "unknown") return undefined;
  if (assessment.ready) return undefined;
  return `Merge admission blocked: ${formatPullRequestCiBlock(assessment, policy.failureAction, "after")}`;
}

function transientMergeGateReason(gate: PullRequestMergeGate): MergeGatePollProgress["reason"] | undefined {
  if (gate.requiredChecks.some((check) => check.state === "pending")) return "required-checks-pending";
  if (pullRequestMergeability(gate) === "unknown") return "mergeability-unknown";
  return undefined;
}

function isRecoverableCompletionTransportFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /marker remains unresolved|HTTP (?:429|5\d{2})\b/i.test(message)
    || /(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|socket hang up|network timeout|TLS handshake timeout|temporarily unavailable|no server is currently available)/i.test(message);
}

function transientMergeAdmissionError(error: unknown): MergeGatePollProgress["reason"] | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (/required GitHub checks.*(?:pending|queued|in_progress|requested|waiting)/i.test(message)) {
    return "required-checks-pending";
  }
  if (/mergeability.*unknown/i.test(message)) return "mergeability-unknown";
  return undefined;
}

function awaitingHumanForMergeGate(gate: PullRequestMergeGate): boolean {
  // Conflicts and terminal check failures can require operator action. Missing
  // authority and unavailable observations are evidence failures, not claims
  // that a human should manually merge around the controller.
  if (gate.requiredChecksProvenance !== "github-required"
    || gate.requiredChecksHeadSha?.toLowerCase() !== gate.headSha.toLowerCase()) return false;
  if (gate.requiredChecks.some((check) => check.state === "unavailable")) return false;
  const mergeability = pullRequestMergeability(gate);
  return mergeability !== "unknown" && mergeability !== "unavailable";
}

async function blockMergeAdmission(
  run: RunState,
  pullRequest: PullRequestSnapshot,
  gate: PullRequestMergeGate,
  reason: string,
  dependencies: { artifacts: ArtifactRepository; runs: RunRepository },
  awaitingHuman: boolean,
): Promise<{ run: RunState; awaitingHuman: boolean; outcome: DurableArtifact<"Outcome"> }> {
  const outcome = createArtifact({
    kind: "Outcome",
    runId: run.runId,
    subject: run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      status: "blocked",
      reason,
      childIssues: [],
      ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
      ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
      ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
      prUrl: pullRequest.url,
      mergeGate: {
        repo: gate.repo,
        pullRequest: gate.pullRequest,
        headSha: gate.headSha,
        baseBranch: gate.baseBranch,
        mergeable: gate.mergeable,
        ...(gate.mergeability ? { mergeability: gate.mergeability } : {}),
        ...(gate.mergeabilityReason ? { mergeabilityReason: gate.mergeabilityReason } : {}),
        ...(gate.requiredChecksProvenance ? { requiredChecksProvenance: gate.requiredChecksProvenance } : {}),
        ...(gate.requiredChecksHeadSha ? { requiredChecksHeadSha: gate.requiredChecksHeadSha } : {}),
        observedAt: gate.observedAt,
        requiredChecks: gate.requiredChecks.map((check) => ({
          name: check.name,
          state: check.state,
          ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
        })),
      },
    },
  }, {
    id: deterministicOutcomeId(
      run.runId,
      run.subject,
      [
        "blocked:merge-admission",
        gate.pullRequest,
        gate.headSha,
        gate.baseBranch,
        gate.requiredChecksProvenance ?? "missing-provenance",
        gate.requiredChecksHeadSha ?? "missing-check-head",
        pullRequestMergeability(gate),
        gate.mergeabilityReason ?? "",
        ...gate.requiredChecks
          .map((check) => `${check.name}:${check.state}`)
          .sort(),
      ].join(":"),
    ),
  });
  await dependencies.artifacts.append(outcome);
  const blocked = transition(run, "BLOCK", { reason });
  await dependencies.runs.commit(run.version, blocked.state, blocked.record);
  return { run: attachArtifact(blocked.state, "Outcome", outcome.id), awaitingHuman, outcome };
}

async function assertClosedIssue(host: ForgeHost, expectedRepo: string, expectedNumber: number): Promise<void> {
  const issue = await readIssue(host, expectedRepo, expectedNumber);
  if (issue.state !== "CLOSED") {
    throw new Error(`Issue #${expectedNumber} close command completed but authoritative host state is ${issue.state}`);
  }
}

function assertMatchingMergedOutcome(
  outcome: DurableArtifact<"Outcome">,
  run: RunState,
  pullRequest: PullRequestSnapshot,
  childIssues: readonly number[],
): void {
  if (outcome.runId !== run.runId
    || outcome.subject.repo.toLowerCase() !== run.subject.repo.toLowerCase()
    || outcome.subject.issue !== run.subject.issue
    || outcome.subject.pr !== run.subject.pr
    || outcome.payload.status !== "merged") {
    throw new Error(`Durable terminal artifact ${outcome.id} is not a merged Outcome for run ${run.runId}`);
  }
  if (outcome.payload.finalSha?.toLowerCase() !== pullRequest.headSha.toLowerCase()
    || outcome.payload.prUrl !== pullRequest.url) {
    throw new Error(`Durable terminal Outcome ${outcome.id} does not match PR #${pullRequest.number} at ${pullRequest.headSha}`);
  }
  const expectedChildren = new Set(childIssues);
  for (const reference of outcome.payload.childIssues) {
    const childIssue = parseChildIssueReference(reference);
    if (!expectedChildren.has(childIssue)) {
      throw new Error(`Durable terminal Outcome ${outcome.id} names unexpected batch member ${reference}`);
    }
  }
}

function parseChildIssueReference(reference: string): number {
  const match = /^issue-(\d+)$/.exec(reference);
  const issue = Number(match?.[1]);
  if (!Number.isSafeInteger(issue) || issue < 1) {
    throw new Error(`Invalid batch member reference '${reference}' in durable terminal Outcome`);
  }
  return issue;
}

const CLOSURE_PROTECTED_LABELS = new Set(["blocked", "needs-human", "operator-only"]);

function protectedClosureLabels(labels: readonly string[]): string[] {
  return labels
    .map((label) => label.trim().toLowerCase())
    .filter((label) => CLOSURE_PROTECTED_LABELS.has(label));
}

function normalizeInvalidBatchMembers(
  childIssues: readonly number[] | undefined,
  parentIssue: number,
): number[] {
  return [...new Set(childIssues ?? [])]
    .filter((childIssue) => Number.isSafeInteger(childIssue) && childIssue > 0 && childIssue !== parentIssue);
}

function sameIssueSet(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((issue) => right.includes(issue));
}

interface InvalidBatchProjection {
  completed: number[];
  preserved: Array<{ issue: number; labels: string[] }>;
}

async function projectInvalidBatchMembers(input: {
  run: RunState;
  investigation: DurableArtifact<"Investigation">;
  aggregateReason: string;
  childIssues: readonly number[];
  artifacts: ArtifactRepository;
  host: ForgeHost;
  signal?: AbortSignal;
  assertActive?: () => void;
}): Promise<InvalidBatchProjection> {
  const parentIssue = input.run.subject.issue;
  if (!parentIssue) throw new Error("Invalid batch closure requires an aggregate issue subject");
  const completed: number[] = [];
  const preserved: Array<{ issue: number; labels: string[] }> = [];
  for (const childIssue of input.childIssues) {
    const assertActive = (): void => {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error("Invalid batch member settlement cancelled");
      input.assertActive?.();
    };
    assertActive();
    const childSubject = { repo: input.run.subject.repo, issue: childIssue };
    const childReason = `ForgeDock batch issue #${parentIssue} was authoritatively classified invalid for member #${childIssue}: ${input.aggregateReason}`;
    const childOutcomeId = deterministicOutcomeId(input.run.runId, childSubject, `invalid:batch:${parentIssue}`);
    const durableChild = (await input.artifacts.list(childSubject, "Outcome"))
      .find((artifact): artifact is DurableArtifact<"Outcome"> => artifact.kind === "Outcome" && artifact.id === childOutcomeId);
    assertActive();
    const observed = await readIssue(input.host, childSubject.repo, childIssue);
    if (durableChild) {
      assertMatchingInvalidBatchMemberOutcome(durableChild, input.run, childIssue, parentIssue);
      if (observed.state !== "CLOSED") {
        throw new Error(`Durable invalid batch Outcome ${durableChild.id} names reopened issue #${childIssue}; refusing to re-close it automatically`);
      }
      completed.push(childIssue);
      continue;
    }
    const protectedLabels = protectedClosureLabels(observed.labels ?? []);
    if (observed.state === "OPEN" && protectedLabels.length) {
      preserved.push({ issue: childIssue, labels: protectedLabels });
      continue;
    }
    if (observed.state === "OPEN") {
      assertActive();
      await input.host.closeIssue?.(childSubject.repo, childIssue, childReason);
      assertActive();
    }
    await assertClosedIssue(input.host, childSubject.repo, childIssue);
    assertActive();
    const childOutcome = createArtifact({
      kind: "Outcome",
      runId: input.run.runId,
      subject: childSubject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        status: "invalid",
        reason: `${childReason} Authoritative GitHub state is CLOSED.`,
        ...(input.run.targetBranch ? { targetBranch: input.run.targetBranch } : {}),
        ...(input.run.promotionTarget ? { promotionTarget: input.run.promotionTarget } : {}),
        ...(input.run.productionTarget ? { productionTarget: input.run.productionTarget } : {}),
        issueClosure: {
          status: "completed",
          repo: childSubject.repo,
          issue: childIssue,
          verifiedAt: new Date().toISOString(),
        },
        childIssues: [],
        batchParent: parentIssue,
      },
    }, { id: childOutcomeId });
    assertActive();
    await input.artifacts.append(childOutcome);
    assertActive();
    completed.push(childIssue);
  }
  return { completed, preserved };
}

async function assertDurableInvalidBatchProjection(
  host: ForgeHost,
  repo: string,
  expectedChildren: readonly number[],
  completedChildren: ReadonlySet<number>,
): Promise<void> {
  for (const childIssue of expectedChildren) {
    const observed = await readIssue(host, repo, childIssue);
    if (completedChildren.has(childIssue)) {
      if (observed.state !== "CLOSED") {
        throw new Error(`Durable invalid batch Outcome names reopened issue #${childIssue}; refusing to re-close it automatically`);
      }
      continue;
    }
    if (observed.state === "CLOSED") continue;
    const protectedLabels = protectedClosureLabels(observed.labels ?? []);
    if (!protectedLabels.length) {
      throw new Error(`Durable invalid batch Outcome omits issue #${childIssue}, but it no longer has a closure-protected label`);
    }
  }
}

function assertMatchingInvalidBatchMemberOutcome(
  outcome: DurableArtifact<"Outcome">,
  run: RunState,
  childIssue: number,
  parentIssue: number,
): void {
  if (outcome.runId !== run.runId
    || outcome.subject.repo.toLowerCase() !== run.subject.repo.toLowerCase()
    || outcome.subject.issue !== childIssue
    || outcome.payload.status !== "invalid"
    || outcome.payload.batchParent !== parentIssue
    || outcome.payload.issueClosure?.status !== "completed"
    || outcome.payload.issueClosure.issue !== childIssue) {
    throw new Error(`Durable artifact ${outcome.id} is not an invalid batch Outcome for issue #${childIssue}`);
  }
}

async function ensureIssueClosed(
  host: ForgeHost,
  repo: string,
  issue: number,
  reason: string,
  signal?: AbortSignal,
  assertActive?: () => void,
): Promise<void> {
  const assertClosureActive = (): void => {
    if (signal?.aborted) throw signal.reason ?? new Error("Invalid issue closure cancelled");
    assertActive?.();
  };
  assertClosureActive();
  const observed = await readIssue(host, repo, issue);
  assertClosureActive();
  if (observed.state === "OPEN") {
    assertClosureActive();
    await host.closeIssue?.(repo, issue, reason);
    assertClosureActive();
  }
  await assertClosedIssue(host, repo, issue);
  assertClosureActive();
}

function assertMatchingInvalidOutcome(
  outcome: DurableArtifact<"Outcome">,
  run: RunState,
  childIssues: readonly number[],
): { completed: ReadonlySet<number>; preserved: ReadonlySet<number> } {
  if (outcome.runId !== run.runId
    || outcome.subject.repo.toLowerCase() !== run.subject.repo.toLowerCase()
    || outcome.subject.issue !== run.subject.issue
    || outcome.subject.pr !== run.subject.pr
    || outcome.payload.status !== "invalid"
    || outcome.payload.issueClosure?.status !== "completed"
    || outcome.payload.issueClosure.repo.toLowerCase() !== run.subject.repo.toLowerCase()
    || outcome.payload.issueClosure.issue !== run.subject.issue) {
    throw new Error(`Durable terminal artifact ${outcome.id} is not a completed invalid Outcome for run ${run.runId}`);
  }
  const expectedChildren = new Set(childIssues);
  const completedReferences = outcome.payload.childIssues.map(parseChildIssueReference);
  const preservedReferences = (outcome.payload.preservedChildIssues ?? []).map(parseChildIssueReference);
  const completed = new Set(completedReferences);
  const preserved = new Set(preservedReferences);
  const projected = new Set([...completed, ...preserved]);
  if (completed.size !== completedReferences.length
    || preserved.size !== preservedReferences.length
    || [...completed].some((childIssue) => preserved.has(childIssue))
    || projected.size !== expectedChildren.size
    || [...expectedChildren].some((childIssue) => !projected.has(childIssue))) {
    throw new Error(`Durable invalid Outcome ${outcome.id} does not match the complete expected batch membership`);
  }
  return { completed, preserved };
}

async function readIssue(host: ForgeHost, expectedRepo: string, expectedNumber: number) {
  if (!host.getIssue) throw new Error("Issue closure confirmation requires authoritative getIssue support");
  const issue = await host.getIssue(expectedNumber, expectedRepo);
  if (issue.repo.toLowerCase() !== expectedRepo.toLowerCase() || issue.number !== expectedNumber) {
    throw new Error(`Issue closure proof identified ${issue.repo}#${issue.number}, expected ${expectedRepo}#${expectedNumber}`);
  }
  return issue;
}

async function publishTrajectory(
  host: ForgeHost,
  input: { repo: string; issue: number; marker: string; body: string },
): Promise<void> {
  // Every production ForgeHost implements this port. Test/dry-run hosts that
  // predate trajectory transport may omit it and still exercise merge gates.
  if (!host.publishIssueComment) return;
  await host.publishIssueComment(input);
}
