// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { summarizeControllerTiming, summarizeTelemetry, type TelemetryRepository } from "../../core/ports/telemetry.js";
import type { BatchMemberContract } from "../orchestrate/batching.js";
import { renderTrajectoryComment, trajectoryCommentMarker, trajectoryReceiptFromArtifacts } from "./trajectory.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import { WorkflowExecutionError } from "./investigate.js";
import { assertRunTargetsBranch } from "./lane.js";

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
  },
  dependencies: { host: ForgeHost; artifacts: ArtifactRepository },
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
  try {
    const reason = `ForgeDock investigation ${input.investigation.id} proved this issue invalid: ${input.outcome.payload.reason} (evidence artifact ${input.investigation.id}).`;
    await dependencies.host.closeIssue(input.run.subject.repo, issue, reason);
    await assertClosedIssue(dependencies.host, input.run.subject.repo, issue);
    const durableFinal = (await dependencies.artifacts.list(input.run.subject, "Outcome"))
      .filter((artifact): artifact is DurableArtifact<"Outcome"> => artifact.kind === "Outcome" && artifact.runId === input.run.runId)
      .reverse()
      .find((artifact) => artifact.payload.status === "invalid" && artifact.payload.issueClosure?.status === "completed");
    if (durableFinal) return { run: input.run, outcome: durableFinal };
    if (closure?.status === "completed") return { run: input.run, outcome: input.outcome };
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
        reason: `${reason} Authoritative GitHub state is CLOSED.`,
        issueClosure: {
          status: "completed",
          repo: input.run.subject.repo,
          issue,
          verifiedAt: new Date().toISOString(),
        },
      },
    });
    await dependencies.artifacts.append(finalized);
    return { run: input.run, outcome: finalized };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkflowExecutionError(reason, input.run, { cause: error });
  }
}

export async function completeWorkItem(
  input: {
    run: RunState;
    pullRequest: PullRequestSnapshot;
    verdict: DurableArtifact<"ReviewVerdict">;
    autoMerge: boolean;
    childIssues?: readonly number[];
    memberContracts?: readonly BatchMemberContract[];
  },
  dependencies: { host: ForgeHost; artifacts: ArtifactRepository; runs: RunRepository; telemetry?: TelemetryRepository },
): Promise<{ run: RunState; awaitingHuman: boolean; outcome?: DurableArtifact<"Outcome"> }> {
  if (input.run.state !== "merging") throw new Error(`Completion requires merging state, found ${input.run.state}`);
  if (input.verdict.payload.disposition !== "approve") throw new Error("Cannot complete without an approving Review Verdict");
  let run = input.run;
  try {
    assertRunTargetsBranch(run, input.pullRequest.baseBranch);
    let pullRequest = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
    assertRunTargetsBranch(run, pullRequest.baseBranch);
    if (pullRequest.headSha !== input.verdict.payload.headSha) {
      throw new Error(`Approved SHA ${input.verdict.payload.headSha} is stale; current PR head is ${pullRequest.headSha}`);
    }
    if (pullRequest.state !== "MERGED") {
      if (!input.autoMerge) return { run, awaitingHuman: true };
      const mergeGate = await readMergeGate(dependencies.host, pullRequest, input.verdict.payload.headSha, run.targetBranch!);
      const mergeGateReason = mergeGateFailure(mergeGate);
      if (mergeGateReason) {
        return blockMergeAdmission(run, pullRequest, mergeGate, mergeGateReason, dependencies);
      }
      await dependencies.host.mergePullRequest(
        pullRequest.repo,
        pullRequest.number,
        input.verdict.payload.headSha,
        run.targetBranch!,
      );
      pullRequest = await dependencies.host.getPullRequest(pullRequest.repo, pullRequest.number);
      assertRunTargetsBranch(run, pullRequest.baseBranch);
      if (pullRequest.state !== "MERGED") throw new Error("Merge command completed but the pull request is not merged");
    }

    const merged = transition(run, "MERGE_COMPLETED", { headSha: pullRequest.headSha });
    await dependencies.runs.commit(run.version, merged.state, merged.record);
    run = merged.state;
    const issue = run.subject.issue;
    if (!issue) throw new Error("work-on completion requires an issue subject");
    const childIssues = [...new Set(input.childIssues ?? [])]
      .filter((child) => Number.isSafeInteger(child) && child > 0 && child !== issue);
    const outcome = createArtifact({
      kind: "Outcome",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        status: "merged",
        reason: `Merged PR #${pullRequest.number} after independent review of ${pullRequest.headSha}.`,
        ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
        ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
        ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
        finalSha: pullRequest.headSha,
        prUrl: pullRequest.url,
        childIssues: childIssues.map((child) => `issue-${child}`),
      },
    });
    const childOutcomes: Array<{ issue: number; artifact: DurableArtifact<"Outcome"> }> = [];
    for (const childIssue of childIssues) {
      const childOutcome = createArtifact({
        kind: "Outcome",
        runId: run.runId,
        subject: { repo: run.subject.repo, issue: childIssue },
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
      });
      childOutcomes.push({ issue: childIssue, artifact: childOutcome });
    }

    const parentArtifacts = await dependencies.artifacts.list({ repo: run.subject.repo, issue });
    const contracts = new Map((input.memberContracts ?? []).map((contract) => [contract.issue, contract]));
    const trajectoryArtifacts = [...parentArtifacts, outcome, input.verdict];
    const telemetry = dependencies.telemetry ? summarizeTelemetry(dependencies.telemetry.listTelemetry(run.runId)) : undefined;
    const controllerTiming = summarizeControllerTiming(run.createdAt, await dependencies.runs.history(run.runId), Date.parse(run.updatedAt));
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
      childIssues,
      childOutcomeIds: childOutcomes.map(({ artifact }) => artifact.id),
      ...(telemetry !== undefined ? { telemetry } : {}),
      controllerTiming,
    });
    await publishTrajectory(dependencies.host, {
      repo: run.subject.repo,
      issue,
      marker: trajectoryCommentMarker(parentReceipt),
      body: renderTrajectoryComment(parentReceipt),
    });
    for (const childIssue of childIssues) {
      await dependencies.host.closeIssue(
        run.subject.repo,
        childIssue,
        `Completed by batch issue #${issue} via ${pullRequest.url} at ${pullRequest.headSha}.`,
      );
      await assertClosedIssue(dependencies.host, run.subject.repo, childIssue);
    }
    await dependencies.host.closeIssue(
      run.subject.repo,
      issue,
      `Completed by ${pullRequest.url} at ${pullRequest.headSha}.`,
    );
    await assertClosedIssue(dependencies.host, run.subject.repo, issue);
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
    const reason = error instanceof Error ? error.message : String(error);
    if (run.state === "merging" && /merge admission|required GitHub checks|pull request .*not mergeable/i.test(reason)) {
      const gate = await readMergeGate(dependencies.host, input.pullRequest, input.verdict.payload.headSha, run.targetBranch ?? input.pullRequest.baseBranch);
      return blockMergeAdmission(run, input.pullRequest, gate, reason, dependencies);
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
    requiredChecks: [{ name: "merge-admission-query", state: "unavailable", detailsUrl: detail.slice(0, 500) }],
    observedAt: new Date().toISOString(),
  });
  if (!host.getPullRequestMergeGate) return unavailable("ForgeHost does not implement authoritative pull-request merge admission");
  try {
    return await host.getPullRequestMergeGate(pullRequest.repo, pullRequest.number, expectedHeadSha, expectedBaseBranch);
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : String(error));
  }
}

function mergeGateFailure(gate: PullRequestMergeGate): string | undefined {
  if (!gate.mergeable) {
    return `Merge admission is blocked for PR #${gate.pullRequest}: GitHub does not report the reviewed SHA as mergeable on ${gate.baseBranch}`;
  }
  const nonPassing = gate.requiredChecks.filter((check) => check.state !== "passed");
  if (!nonPassing.length) return undefined;
  const pending = nonPassing.some((check) => check.state === "pending");
  return `${pending ? "Awaiting" : "Required"} GitHub checks before merge for PR #${gate.pullRequest}: ${nonPassing.map((check) => `${check.name}=${check.state}`).join(", ")}`;
}

async function blockMergeAdmission(
  run: RunState,
  pullRequest: PullRequestSnapshot,
  gate: PullRequestMergeGate,
  reason: string,
  dependencies: { artifacts: ArtifactRepository; runs: RunRepository },
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
        pullRequest: gate.pullRequest,
        headSha: gate.headSha,
        baseBranch: gate.baseBranch,
        mergeable: gate.mergeable,
        observedAt: gate.observedAt,
        requiredChecks: gate.requiredChecks.map((check) => ({
          name: check.name,
          state: check.state,
          ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
        })),
      },
    },
  });
  await dependencies.artifacts.append(outcome);
  const blocked = transition(run, "BLOCK", { reason });
  await dependencies.runs.commit(run.version, blocked.state, blocked.record);
  return { run: attachArtifact(blocked.state, "Outcome", outcome.id), awaitingHuman: true, outcome };
}

async function assertClosedIssue(host: ForgeHost, expectedRepo: string, expectedNumber: number): Promise<void> {
  if (!host.getIssue) throw new Error("Issue closure confirmation requires authoritative getIssue support");
  const issue = await host.getIssue(expectedNumber, expectedRepo);
  if (issue.repo.toLowerCase() !== expectedRepo.toLowerCase() || issue.number !== expectedNumber) {
    throw new Error(`Issue closure proof identified ${issue.repo}#${issue.number}, expected ${expectedRepo}#${expectedNumber}`);
  }
  if (issue.state !== "CLOSED") {
    throw new Error(`Issue #${expectedNumber} close command completed but authoritative host state is ${issue.state}`);
  }
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
