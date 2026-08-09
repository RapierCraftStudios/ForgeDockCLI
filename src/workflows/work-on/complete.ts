// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import { summarizeControllerTiming, summarizeTelemetry, type TelemetryRepository } from "../../core/ports/telemetry.js";
import type { BatchMemberContract } from "../orchestrate/batching.js";
import { renderTrajectoryComment, trajectoryCommentMarker, trajectoryReceiptFromArtifacts } from "./trajectory.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import { WorkflowExecutionError } from "./investigate.js";
import { assertRunTargetsBranch } from "./lane.js";

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
      await dependencies.host.closeIssue(run.subject.repo, childIssue, `Completed by batch issue #${issue} via ${pullRequest.url} at ${pullRequest.headSha}.`);
    }
    await dependencies.host.closeIssue(run.subject.repo, issue, `Completed by ${pullRequest.url} at ${pullRequest.headSha}.`);
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
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
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
