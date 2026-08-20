// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact, type OutcomePayload } from "../../core/artifacts/schema.js";
import type { ForgeHost, PullRequestMergeGate, PullRequestSnapshot } from "../../core/ports/forge-host.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import { canonicalizeConcreteScopePaths, scopeManifestFor, scopeDiscoveryRoots, STANDARD_SCOPE_METADATA_ROOTS, type AgentEventSink, type AgentRuntime } from "../../runtime/agent-runtime.js";
import { BuilderSubmissionSchema, type BuilderSubmission } from "./build.js";
import { deterministicOutcomeId, WorkflowExecutionError } from "./investigate.js";
import { publishRemediationRevision } from "./publish-revision.js";
import { uncoveredVerificationCommands } from "./verify.js";
import { WORK_ON_EXECUTION_BUDGETS } from "./execution-budgets.js";
import { persistTargetAdvanceCheckpoint as persistTargetAdvanceCheckpointShared } from "./target-recovery.js";

/** The old approval is evidence for admission only; it is never reused for the new SHA. */
export interface ConflictRecoveryInput {
  run: RunState;
  intent: DurableArtifact<"Intent">;
  investigation: DurableArtifact<"Investigation">;
  packet: DurableArtifact<"BuildPacket">;
  buildResult: DurableArtifact<"BuildResult">;
  verdict: DurableArtifact<"ReviewVerdict">;
  pullRequest: PullRequestSnapshot;
  workspace: GitWorkspace;
  commands: readonly VerificationCommand[];
  mergeGate: NonNullable<OutcomePayload["mergeGate"]>;
  provider?: string;
  model?: string;
  subjectEvidence?: readonly string[];
  signal?: AbortSignal;
}

export interface ConflictRecoveryDependencies {
  runtime: AgentRuntime;
  artifacts: ArtifactRepository;
  runs: RunRepository;
  git: GitWorkspaceManager;
  verifier: VerificationRunner;
  host: ForgeHost;
  onAgentEvent?: AgentEventSink;
}

export interface ConflictRecoveryResult {
  run: RunState;
  buildResult?: DurableArtifact<"BuildResult">;
  pullRequest?: PullRequestSnapshot;
}

/**
 * Adapter-owned merge checkpoint state. The Git adapter verifies this state
 * from exact merge parents; the workflow only decides whether a second local
 * commit would be a duplicate.
 */
type RemoteBaseIntegrationResult = {
  workspace: GitWorkspace;
  conflictPaths: string[];
  /** True when the exact target merge commit is already present in the retained workspace. */
  mergeCommitExists: boolean;
};

/**
 * Synchronize an approved delivery branch with the exact current target SHA,
 * resolve only packet-owned conflicts, controller-verify the resulting merge,
 * and publish it as a normal descendant revision. The caller must run a fresh
 * review after this function returns a reviewing run.
 */
export async function recoverConflictingRevision(
  input: ConflictRecoveryInput,
  dependencies: ConflictRecoveryDependencies,
): Promise<ConflictRecoveryResult> {
  if (input.run.state !== "blocked") throw new Error(`Conflict recovery requires blocked state, found ${input.run.state}`);
  if (input.verdict.payload.disposition !== "approve") throw new Error("Conflict recovery requires the approving verdict retained by the conflict checkpoint");
  if (input.mergeGate.mergeability !== "conflicting") throw new Error("Conflict recovery requires confirmed conflicting mergeability");
  const reviewedHead = input.buildResult.payload.headSha;
  if (input.verdict.payload.headSha !== reviewedHead
    || input.pullRequest.headSha !== reviewedHead
    || input.mergeGate.headSha !== reviewedHead) {
    throw new Error("Conflict recovery requires one exact approved PR, Build Result, and merge-gate head SHA");
  }
  if (input.run.subject.repo.toLowerCase() !== input.pullRequest.repo.toLowerCase()
    || input.mergeGate.pullRequest !== input.pullRequest.number
    || input.mergeGate.baseBranch !== input.pullRequest.baseBranch
    || (input.mergeGate.repo !== undefined && input.mergeGate.repo.toLowerCase() !== input.pullRequest.repo.toLowerCase())
    || (input.verdict.subject.pr !== undefined && input.verdict.subject.pr !== input.pullRequest.number)
    || (input.verdict.payload.baseBranch !== undefined && input.verdict.payload.baseBranch !== input.pullRequest.baseBranch)) {
    throw new Error("Conflict recovery requires one matching merge-gate, PR, verdict, repository, and base branch identity");
  }
  let run = input.run;
  let workspace = input.workspace;
  const expectedPaths = new Set(canonicalizeConcreteScopePaths(input.packet.payload.expectedPaths));
  const block = async (reason: string, checks: readonly CheckResult[] = [], changedPaths: readonly string[] = []): Promise<ConflictRecoveryResult> => {
    const normalizedChangedPaths = canonicalizeConcreteScopePaths(changedPaths);
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
        prUrl: input.pullRequest.url,
        mergeGate: input.mergeGate,
        failureEvidence: {
          branch: workspace.branch,
          workspacePath: workspace.path,
          baseRef: workspace.baseRef,
          ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
          ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
          ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
          ...(workspace.baseSha ? { baseSha: workspace.baseSha } : {}),
          builderSummary: input.buildResult.payload.summary,
          changedPaths: normalizedChangedPaths,
          checks: [...checks],
        },
      },
    }, {
      id: deterministicOutcomeId(run.runId, run.subject, `blocked:conflict-recovery:${reason}:${reviewedHead}`),
    });
    await dependencies.artifacts.append(outcome);
    run = attachArtifact(run, "Outcome", outcome.id);
    if (run.state !== "blocked") {
      // Verification failures are expected while the synchronized workspace
      // is in `verifying`; once publication has begun, only the generic BLOCK
      // event is legal. This keeps a late publication/read failure from being
      // relabeled as verification or throwing an illegal transition.
      const event = run.state === "verifying" ? "VERIFICATION_FAILED" : "BLOCK";
      const blocked = transition(run, event, { reason });
      await dependencies.runs.commit(run.version, blocked.state, blocked.record);
      run = blocked.state;
    }
    return { run };
  };

  try {
    const current = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
    assertCurrentPullRequest(current, input, reviewedHead);
    if (!dependencies.host.getBranchHead) throw new Error("Conflict recovery requires an authoritative target branch head reader");
    const targetSha = await dependencies.host.getBranchHead(current.repo, current.baseBranch);
    assertSha(targetSha, "authoritative target branch head");
    if (input.buildResult.payload.baseSha?.toLowerCase() === targetSha.toLowerCase()) {
      throw new Error(`Target branch ${current.baseBranch} did not advance beyond the reviewed base ${targetSha}`);
    }

    const resumed = transition(run, "RESUME_CONFLICT_RECOVERY", {
      reason: `Synchronizing approved head ${reviewedHead} with exact target ${targetSha}; old approval will not be reused`,
      headSha: reviewedHead,
    });
    await dependencies.runs.commit(run.version, resumed.state, resumed.record);
    run = resumed.state;

    if (!dependencies.git.integrateRemoteBase) {
      throw new Error("Conflict recovery requires GitWorkspaceManager.integrateRemoteBase support");
    }
    const integrated = await dependencies.git.integrateRemoteBase(workspace, {
      expectedHeadSha: reviewedHead,
      expectedBaseSha: targetSha,
    }) as RemoteBaseIntegrationResult;
    workspace = integrated.workspace;
    const mergeAlreadyCommitted = integrated.mergeCommitExists;
    const conflictPaths = canonicalizeConcreteScopePaths(integrated.conflictPaths).sort();
    if (mergeAlreadyCommitted && conflictPaths.length) {
      throw new Error("Git adapter reported an already-committed merge with unresolved conflict paths");
    }
    const outOfPacketConflicts = conflictPaths.filter((path) => !expectedPaths.has(path));
    if (outOfPacketConflicts.length) {
      return block(
        `Target synchronization conflicts outside the frozen Build Packet: ${outOfPacketConflicts.join(", ")}`,
        [],
        conflictPaths,
      );
    }

    if (conflictPaths.length) {
      const resolution = await resolvePacketConflicts({
        input,
        workspace,
        conflictPaths,
        dependencies,
      });
      if (canonicalPathSet(resolution.changedPaths) !== canonicalPathSet(conflictPaths)) {
        return block("Conflict resolver did not report exactly the controller-authorized unmerged paths", [], resolution.changedPaths);
      }
      if (!dependencies.git.stageConflictResolutions) {
        return block("Conflict resolver completion cannot be proven because the Git adapter cannot stage authorized conflict paths", [], resolution.changedPaths);
      }
      await dependencies.git.stageConflictResolutions(workspace, conflictPaths);
      const unmergedPaths = (dependencies.git as GitWorkspaceManager & {
        unmergedPaths?: (workspace: GitWorkspace) => Promise<string[]>;
      }).unmergedPaths;
      if (!unmergedPaths) {
        return block("Conflict resolver completion cannot be proven because the Git adapter does not expose unmerged paths", [], resolution.changedPaths);
      }
      const unresolved = canonicalizeConcreteScopePaths(await unmergedPaths.call(dependencies.git, workspace)).sort();
      if (unresolved.length) {
        return block(
          `Conflict resolver left unmerged paths: ${unresolved.join(", ")}`,
          [],
          unresolved,
        );
      }
    }

    // The adapter deliberately leaves even a clean --no-commit merge at the
    // same controller-owned checkpoint as a conflicted merge. Always create
    // the descendant merge commit here; otherwise a clean synchronization can
    // pass the path checks while still publishing the old PR head.
    if (!mergeAlreadyCommitted) {
      await dependencies.git.commit(workspace, `forge: synchronize issue ${run.subject.issue ?? "work item"} with ${current.baseBranch}`);
    }

    // The target SHA is now the new delivery baseline. This assignment is
    // deliberately after integration/commit so unrelated target changes can
    // never be mistaken for issue delivery in revisionChangedPaths().
    workspace.baseSha = targetSha;
    const newHead = await dependencies.git.head(workspace);
    assertSha(newHead, "synchronized delivery head");
    if (newHead.toLowerCase() === reviewedHead.toLowerCase()
      || !await dependencies.git.isAncestor(workspace, reviewedHead, newHead)) {
      throw new Error(`Synchronized delivery head ${newHead} is not a descendant of approved head ${reviewedHead}`);
    }
    const revisionChangedPaths = canonicalizeConcreteScopePaths(
      await dependencies.git.revisionChangedPaths(workspace),
    ).sort();
    const unexpectedRevision = revisionChangedPaths.filter((path) => !expectedPaths.has(path));
    if (unexpectedRevision.length) {
      return block(
        `Synchronized delivery revision contains paths outside the frozen Build Packet: ${unexpectedRevision.join(", ")}`,
        [],
        revisionChangedPaths,
      );
    }
    const uncoveredPlan = uncoveredVerificationCommands(
      input.packet.payload.verificationPlan,
      input.commands,
      input.packet.payload.controllerGates,
    );
    if (uncoveredPlan.length) return block(`Frozen verification plan is not covered by controller-approved commands: ${uncoveredPlan.join(", ")}`, [], revisionChangedPaths);
    if (!input.commands.some((command) => command.required)) return block("Conflict recovery requires at least one controller-approved required verification command", [], revisionChangedPaths);

    const latestBeforeVerify = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
    assertCurrentPullRequest(latestBeforeVerify, input, reviewedHead);
    const targetBeforeVerify = await dependencies.host.getBranchHead(latestBeforeVerify.repo, latestBeforeVerify.baseBranch);
    if (targetBeforeVerify.toLowerCase() !== targetSha.toLowerCase()) {
      throw new Error(`Target branch changed before synchronized verification: expected ${targetSha}, observed ${targetBeforeVerify}`);
    }
    await dependencies.git.prepareWorkspaceDependencies(workspace);
    const checks = await dependencies.verifier.run(input.commands, input.signal);
    const failed = input.commands.some((command, index) => command.required && checks[index]?.status !== "passed");
    const postHead = await dependencies.git.head(workspace);
    const postChangedPaths = canonicalizeConcreteScopePaths(await dependencies.git.changedPaths(workspace));
    const latestAfterVerify = await dependencies.host.getPullRequest(input.pullRequest.repo, input.pullRequest.number);
    const targetAfterVerify = await dependencies.host.getBranchHead(latestAfterVerify.repo, latestAfterVerify.baseBranch);
    if (postHead.toLowerCase() !== newHead.toLowerCase()
      || postChangedPaths.length
      || latestAfterVerify.headSha.toLowerCase() !== reviewedHead.toLowerCase()
      || latestAfterVerify.baseBranch !== current.baseBranch
      || targetAfterVerify.toLowerCase() !== targetSha.toLowerCase()) {
      throw new Error(`PR, target, or retained workspace changed while synchronized verification ran; refusing publication at ${newHead}`);
    }
    if (failed) {
      const failedChecks = checks.filter((check) => check.status === "failed");
      return block(
        `Required verification failed after target synchronization${failedChecks.length ? `: ${failedChecks.map((check) => check.command).join(", ")}` : ""}`,
        checks,
        revisionChangedPaths,
      );
    }

    const buildResult = createArtifact({
      kind: "BuildResult",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        ...input.buildResult.payload,
        branch: workspace.branch,
        targetBranch: current.baseBranch,
        headSha: newHead,
        baseSha: targetSha,
        changedPaths: revisionChangedPaths,
        summary: `Controller-verified synchronized revision ${newHead} descended from approved ${reviewedHead}.`,
        acceptanceEvidence: input.packet.payload.acceptanceCriteria.map((criterion) => ({
          criterion,
          status: "passed" as const,
          evidence: `Controller verification passed after synchronizing target ${current.baseBranch} at ${targetSha}.`,
        })),
        checks,
        decisions: [
          ...input.buildResult.payload.decisions,
          `Target synchronization: ${current.baseBranch}@${targetSha}; prior approval ${reviewedHead} superseded by fresh review requirement.`,
        ],
      },
    });
    await dependencies.artifacts.append(buildResult);
    run = attachArtifact(run, "BuildResult", buildResult.id);
    const publishing = transition(run, "VERIFICATION_PASSED", { headSha: newHead });
    await dependencies.runs.commit(run.version, publishing.state, publishing.record);
    run = publishing.state;
    const published = await publishRemediationRevision({
      run,
      pullRequest: latestAfterVerify,
      buildResult,
      workspace,
      expectedTargetHeadSha: targetSha,
    }, { git: dependencies.git, host: dependencies.host, runs: dependencies.runs, artifacts: dependencies.artifacts });
    return { run: published.run, buildResult, pullRequest: published.pullRequest };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const targetMovement = /Target branch changed[^:]*: expected [^,]+, observed ([0-9a-f]{7,64})/i.exec(reason)
      ?? /target[^\n]*expected [^\s,]+[,: ]+observed[ =]([0-9a-f]{7,64})/i.exec(reason);
    if (targetMovement && run.state !== "blocked") {
      await persistTargetAdvanceCheckpointShared({
        run,
        packet: input.packet,
        buildResult: input.buildResult,
        workspace,
        targetBranch: input.run.targetBranch ?? input.pullRequest.baseBranch,
        observedTargetSha: targetMovement[1]!,
        phase: "target-read",
        verdict: input.verdict,
        artifacts: dependencies.artifacts,
      });
      const next = transition(run, "TARGET_ADVANCE_DETECTED", { reason });
      await dependencies.runs.commit(run.version, next.state, next.record);
      return { run: next.state };
    }
    // Publication owns its transition to `failed` when a push succeeds but
    // the subsequent PR projection/read fails. Adopt and preserve that typed
    // state; attempting VERIFICATION_FAILED from the stale `publishing`
    // local state would both throw an illegal-transition error and hide the
    // original publication failure.
    if (error instanceof WorkflowExecutionError) {
      run = error.run;
      throw error;
    }
    if (run.state === "blocked") throw error;
    return block(`Conflict recovery stopped before fresh review: ${reason}`);
  }
}

export async function resolvePacketConflicts(input: {
  input: ConflictRecoveryInput;
  workspace: GitWorkspace;
  conflictPaths: readonly string[];
  dependencies: ConflictRecoveryDependencies;
}): Promise<BuilderSubmission> {
  const { input: recovery, workspace, conflictPaths, dependencies } = input;
  const result = await dependencies.runtime.run<BuilderSubmission>({
    id: `${recovery.run.runId}:conflict-resolver:${recovery.run.attempt}`,
    role: "remediator",
    objective: `Resolve only the target-branch merge conflicts in ${conflictPaths.join(", ")} while preserving the frozen Build Packet and approved delivery intent.`,
    instructions: [
      "The controller has an exact target merge in progress. Resolve only the listed unmerged paths; do not broaden scope.",
      `Authorized unmerged paths: ${conflictPaths.join(", ")}`,
      "Do not invoke GitHub, run git commands, commit, push, merge, or alter workflow state. The controller owns the merge commit and publication.",
      "Preserve the Build Packet acceptance criteria and the approved delivery behavior. Resolve conflicts using the target changes only where required for a coherent tested revision.",
      "Before submitting, inspect the complete diff and report exactly the authorized unmerged paths in changedPaths.",
    ].join("\n"),
    context: [recovery.intent, recovery.investigation, recovery.packet, recovery.buildResult, recovery.verdict],
    workspace: {
      cwd: workspace.path,
      mode: "write",
      scope: scopeManifestFor("remediation", {
        affectedFiles: conflictPaths,
        writePaths: conflictPaths,
        metadataRoots: [...STANDARD_SCOPE_METADATA_ROOTS, ...scopeDiscoveryRoots(conflictPaths)],
      }),
    },
    tools: ["read", "grep", "find", "ls", "edit", "write"],
    outputSchema: BuilderSubmissionSchema,
    executionBudget: WORK_ON_EXECUTION_BUDGETS.ciRepair,
    modelPolicy: {
      ...(recovery.provider !== undefined ? { provider: recovery.provider } : {}),
      ...(recovery.model !== undefined ? { model: recovery.model } : {}),
    },
  }, {
    ...(recovery.signal !== undefined ? { signal: recovery.signal } : {}),
    ...(dependencies.onAgentEvent !== undefined ? { onEvent: dependencies.onAgentEvent } : {}),
  });
  return result.output;
}

function assertCurrentPullRequest(
  current: PullRequestSnapshot,
  input: ConflictRecoveryInput,
  reviewedHead: string,
): void {
  if (current.state !== "OPEN") throw new Error(`Conflict recovery requires an open PR; authoritative state is ${current.state}`);
  if (current.repo.toLowerCase() !== input.pullRequest.repo.toLowerCase()
    || current.number !== input.pullRequest.number
    || current.headBranch !== input.pullRequest.headBranch
    || current.baseBranch !== input.pullRequest.baseBranch
    || current.headSha.toLowerCase() !== reviewedHead.toLowerCase()) {
    throw new Error(`Approved PR identity changed before conflict recovery: expected ${input.pullRequest.headBranch}@${reviewedHead} -> ${input.pullRequest.baseBranch}`);
  }
}

function assertSha(value: string, label: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(value)) throw new Error(`${label} is not a valid Git SHA`);
}

function canonicalPathSet(paths: readonly string[]): string {
  return JSON.stringify([...new Set(canonicalizeConcreteScopePaths(paths))].sort());
}
