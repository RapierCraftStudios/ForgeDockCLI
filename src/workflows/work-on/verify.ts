// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createArtifact, type ControllerVerificationGate, type DurableArtifact, type CriterionEvidenceAnchors, type VerificationEvidenceDiagnostic } from "../../core/artifacts/schema.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationCommand, VerificationCommandProgress, VerificationRunner } from "../../core/ports/verification.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import { canonicalizeConcreteScopePaths } from "../../runtime/agent-runtime.js";
import type { BuilderSubmission } from "./build.js";
import { WorkflowExecutionError } from "./investigate.js";
import { expandInvariantMatrix } from "./invariant-matrix.js";
import { validateEvidenceContract } from "./evidence-contract.js";

export interface VerificationResult {
  run: RunState;
  checks: CheckResult[];
  buildResult?: DurableArtifact<"BuildResult">;
  outcome?: DurableArtifact<"Outcome">;
}

class DeliveryContentLinkError extends Error {
  constructor(path: string) {
    super(`Delivery path is a symbolic link and cannot be verified: ${path}`);
    this.name = "DeliveryContentLinkError";
  }
}

export interface CommittedRepairVerification {
  checks: CheckResult[];
  changedPaths: string[];
  verifiedContentDigest: string;
}

/**
 * Re-verifies a controller-published repair without treating the repair agent
 * as a builder. The proof is intentionally narrower than verifyAndCommit: the
 * repair may only produce a non-merge child of the reviewed head, within the
 * frozen packet scope, whose exact committed blobs and frozen checks pass.
 */
export async function verifyCommittedRepair(
  input: {
    packet: DurableArtifact<"BuildPacket">;
    workspace: GitWorkspace;
    expectedHeadSha: string;
    parentHeadSha: string;
    commands: readonly VerificationCommand[];
    verifier: VerificationRunner;
    signal?: AbortSignal;
  },
  git: GitWorkspaceManager,
): Promise<CommittedRepairVerification> {
  const headSha = await git.head(input.workspace);
  if (headSha.toLowerCase() !== input.expectedHeadSha.toLowerCase()) {
    throw new Error(`CI repair workspace head ${headSha} does not match expected published head ${input.expectedHeadSha}`);
  }
  if (headSha.toLowerCase() === input.parentHeadSha.toLowerCase()) {
    throw new Error("CI repair published no committed child revision");
  }
  if (!git.commitParents) {
    throw new Error("CI repair verification requires exact committed parent proof");
  }
  const parents = await git.commitParents(input.workspace);
  if (parents.length !== 1 || parents[0]?.toLowerCase() !== input.parentHeadSha.toLowerCase()) {
    throw new Error(`CI repair revision ${headSha} is not the exact non-merge child of ${input.parentHeadSha}`);
  }
  const changedPaths = canonicalizeConcreteScopePaths(await git.revisionChangedPaths(input.workspace)).sort();
  if (!changedPaths.length) throw new Error("CI repair published an empty revision");
  const expectedPaths = new Set(canonicalizeConcreteScopePaths(input.packet.payload.expectedPaths));
  const outside = changedPaths.filter((path) => !expectedPaths.has(path));
  if (outside.length) throw new Error(`CI repair changed paths outside the Build Packet: ${outside.join(", ")}`);
  const before = await deliveryContentDigest(input.workspace.path, changedPaths);
  const checks = await input.verifier.run(input.commands, input.signal);
  const after = await deliveryContentDigest(input.workspace.path, changedPaths);
  if (before !== after) throw new Error("CI repair verification commands changed controller-approved delivery content");
  const failed = checks.filter((check) => check.status !== "passed");
  if (failed.length) throw new Error(`CI repair packet verification failed: ${failed.map((check) => `${check.command}=${check.status}`).join(", ")}`);
  if (!await git.committedContentMatches(input.workspace, changedPaths, after, headSha)) {
    throw new Error("CI repair committed blobs do not match the controller-verified delivery content");
  }
  return { checks, changedPaths, verifiedContentDigest: after };
}


export async function verifyAndCommit(
  input: {
    run: RunState;
    packet: DurableArtifact<"BuildPacket">;
    submission: BuilderSubmission;
    workspace: GitWorkspace;
    commands: readonly VerificationCommand[];
    baselineChecks?: readonly CheckResult[];
    subjectEvidence?: readonly string[];
    signal?: AbortSignal;
  },
  dependencies: {
    verifier: VerificationRunner;
    git: GitWorkspaceManager;
    artifacts: ArtifactRepository;
    runs: RunRepository;
  },
): Promise<VerificationResult> {
  if (input.run.state !== "verifying") throw new Error(`Verification requires verifying state, found ${input.run.state}`);
  let run = input.run;
  const blockVerification = async (
    reason: string,
    checks: CheckResult[],
    changedPaths: string[],
    failureKind?: "builder-semantic-evidence" | "builder-report" | "required-check" | "scope" | "verification-mutation" | "packet-contract",
    diagnostics?: readonly VerificationEvidenceDiagnostic[],
  ): Promise<VerificationResult> => {
    const outcome = createArtifact({
      kind: "Outcome",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        status: "blocked",
        reason,
        childIssues: [],
        failureEvidence: {
          branch: input.workspace.branch,
          workspacePath: input.workspace.path,
          baseRef: input.workspace.baseRef,
          ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
          ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
          ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
          ...(input.workspace.baseSha ? { baseSha: input.workspace.baseSha } : {}),
          builderSummary: input.submission.summary,
          ...(failureKind !== undefined ? { failureKind } : {}),
          changedPaths,
          criterionCoverage: input.submission.criterionCoverage,
          decisions: input.submission.decisions,
          residualRisks: input.submission.residualRisks,
          checks,
          ...(diagnostics?.length ? { diagnostics: [...diagnostics] } : {}),
        },
      },
    });
    await dependencies.artifacts.append(outcome);
    run = attachArtifact(run, "Outcome", outcome.id);
    const blocked = transition(run, "VERIFICATION_FAILED", { reason });
    await dependencies.runs.commit(run.version, blocked.state, blocked.record);
    run = blocked.state;
    return { run, checks, outcome };
  };
  try {
    const uncoveredPlan = input.packet.payload.verificationRequirements?.length
      ? input.packet.payload.verificationRequirements
        .filter((requirement) => requirement.kind === "command")
        .map((requirement) => requirement.id)
        .filter((id) => !input.commands.some((command) => command.id === id))
      : uncoveredVerificationCommands(
        input.packet.payload.verificationPlan,
        input.commands,
        input.packet.payload.controllerGates,
      );
    const changedPaths = canonicalizeConcreteScopePaths(await dependencies.git.changedPaths(input.workspace));
    const priorRevisionChangedPaths = canonicalizeConcreteScopePaths(
      await dependencies.git.revisionChangedPaths(input.workspace),
    );
    const deliveryChangedPaths = canonicalizeConcreteScopePaths([
      ...priorRevisionChangedPaths,
      ...changedPaths,
    ]).sort();
    const expectedPaths = new Set(canonicalizeConcreteScopePaths(input.packet.payload.expectedPaths));
    const unexpected = deliveryChangedPaths.filter((path) => !expectedPaths.has(path));

    let reportedPaths: string[] = [];
    let invalidChangeReport: string | undefined;
    try {
      reportedPaths = canonicalizeConcreteScopePaths(input.submission.changedPaths);
    } catch (error) {
      invalidChangeReport = error instanceof Error ? error.message : String(error);
    }
    const observedPathSet = new Set(deliveryChangedPaths);
    const reportedPathSet = new Set(reportedPaths);
    const omittedFromReport = deliveryChangedPaths.filter((path) => !reportedPathSet.has(path));
    const notObserved = reportedPaths.filter((path) => !observedPathSet.has(path));
    const changeReportFailure = invalidChangeReport
      ? `Builder change report does not match the controller-observed delivery revision: ${invalidChangeReport}`
      : omittedFromReport.length || notObserved.length
        ? `Builder change report does not match the controller-observed delivery revision:${omittedFromReport.length ? ` omitted ${omittedFromReport.join(", ")}` : ""}${notObserved.length ? ` reported unchanged ${notObserved.join(", ")}` : ""}`
        : undefined;

    const frozenCriteria = input.packet.payload.acceptanceCriteria;
    const criterionIds = frozenCriteria.map((_, index) => `criterion-${index + 1}`);
    const criterionById = new Map<string, string>(
      frozenCriteria.map((criterion, index) => [criterionIds[index]!, criterion] as const),
    );
    // Stable IDs are authoritative whenever present. Omitted IDs are retained
    // only for old builder packets, and can be resolved by exact text when that
    // text identifies one (and only one) frozen criterion. In particular, a
    // duplicate acceptance string must never silently select the first entry.
    const resolvedCoverage = input.submission.criterionCoverage.map((coverage) => {
      if (coverage.criterionId !== undefined) {
        const criterion = criterionById.get(coverage.criterionId);
        return { coverage: { ...coverage }, criterionId: coverage.criterionId, criterion };
      }
      const matches = criterionIds.filter((id) => criterionById.get(id) === coverage.criterion);
      if (matches.length !== 1) return { coverage: { ...coverage }, criterionId: undefined, criterion: coverage.criterion };
      const criterionId = matches[0]!;
      return {
        coverage: { ...coverage, criterionId },
        criterionId,
        criterion: criterionById.get(criterionId),
      };
    });
    const coverageCounts = new Map<string, number>();
    for (const resolved of resolvedCoverage) {
      if (resolved.criterionId !== undefined && criterionById.has(resolved.criterionId)) {
        coverageCounts.set(resolved.criterionId, (coverageCounts.get(resolved.criterionId) ?? 0) + 1);
      }
    }
    const missingCoverage = criterionIds.filter((criterionId) => !coverageCounts.has(criterionId));
    const duplicateCoverage = criterionIds.filter((criterionId) => (coverageCounts.get(criterionId) ?? 0) > 1);
    const unknownCoverage = resolvedCoverage
      .filter((resolved) => resolved.criterionId === undefined || !criterionById.has(resolved.criterionId)
        || criterionById.get(resolved.criterionId) !== resolved.coverage.criterion)
      .map(({ coverage }) => coverage.criterionId ? `${coverage.criterionId} (${coverage.criterion})` : coverage.criterion);
    const coverageFailure = missingCoverage.length || duplicateCoverage.length || unknownCoverage.length
      ? `Builder criterion coverage is incomplete:${missingCoverage.length ? ` missing ${missingCoverage.map((id) => `${id} (${criterionById.get(id)})`).join(" | ")}` : ""}${duplicateCoverage.length ? ` duplicated ${duplicateCoverage.map((id) => `${id} (${criterionById.get(id)})`).join(" | ")}` : ""}${unknownCoverage.length ? ` unknown ${unknownCoverage.join(" | ")}` : ""}`
      : undefined;
    const strictSemanticEvidence = usesStrictSemanticEvidence(input.packet);
    const hasEvidenceContract = input.packet.payload.evidenceContract?.version === "forgedock.evidence/v1";
    const contractValidationDiagnostics = hasEvidenceContract
      ? validateEvidenceContract(input.packet.payload.evidenceContract!, {
        acceptanceCriteria: input.packet.payload.acceptanceCriteria,
        ...(input.packet.payload.verificationRequirements ? { verificationRequirements: input.packet.payload.verificationRequirements } : {}),
        ...(input.packet.payload.controllerGates ? { controllerGates: input.packet.payload.controllerGates } : {}),
        expectedPaths: input.packet.payload.expectedPaths,
        ...(input.packet.payload.evidencePaths ? { evidencePaths: input.packet.payload.evidencePaths } : {}),
        ...(input.packet.payload.invariantMatrices ? { invariantMatrices: input.packet.payload.invariantMatrices } : {}),
        commands: input.commands,
      })
      : [];
    const contractBuilderDiagnostics = hasEvidenceContract
      ? collectContractStructuralDiagnostics({ packet: input.packet, coverage: resolvedCoverage.map(({ coverage }) => coverage), commands: input.commands })
      : [];
    const contractDiagnostics = [...contractValidationDiagnostics, ...contractBuilderDiagnostics];
    const contractFailure = contractDiagnostics.length
      ? `Builder evidence contract preflight failed: ${contractDiagnostics.map((item) => `[${item.code}${item.criterionId ? ` ${item.criterionId}` : ""}] ${item.message}`).join("; ")}`
      : undefined;
    const anchorPreflightFailure = coverageFailure || !strictSemanticEvidence || hasEvidenceContract ? undefined : criterionAnchorPreflightFailure({
      packet: input.packet,
      coverage: resolvedCoverage.map(({ coverage, criterionId }) => ({ ...coverage, criterionId: criterionId! })),
      commands: input.commands,
      allowedPaths: [...expectedPaths],
    });

    const preflightFailure = contractFailure
      ?? (unexpected.length
        ? `Delivery revision contains paths outside the Build Packet: ${unexpected.join(", ")}`
        : !changedPaths.length
          ? "Builder produced no repository changes"
          : uncoveredPlan.length
            ? `Frozen verification plan is not covered by controller-approved commands: ${uncoveredPlan.join(", ")}`
            : !input.commands.some((command) => command.required)
              ? "No required verification commands were configured"
              : changeReportFailure ?? coverageFailure);
    let contentDigestBefore: string | undefined;
    if (!preflightFailure) {
      try {
        contentDigestBefore = await deliveryContentDigest(input.workspace.path, deliveryChangedPaths);
      } catch (error) {
        if (error instanceof DeliveryContentLinkError) {
          return blockVerification(error.message, [], deliveryChangedPaths);
        }
        throw error;
      }
    }
    if (!preflightFailure) await dependencies.git.prepareWorkspaceDependencies(input.workspace);
    const observedChecks = preflightFailure ? [] : await dependencies.verifier.run(
      input.commands,
      input.signal,
      verificationProgressRecorder(run.runId, "changed", dependencies.runs),
    );
    const baselineByIdentity = new Map(
      (input.baselineChecks ?? []).map((check, index) => [checkIdentity(check, index), check] as const),
    );
    const checks = observedChecks.map((check, index) => compareWithBaseline(
      check,
      baselineByIdentity.get(checkIdentity(check, index)),
    ));
    let contentDigestAfter: string | undefined;
    if (contentDigestBefore !== undefined) {
      try {
        contentDigestAfter = await deliveryContentDigest(input.workspace.path, deliveryChangedPaths);
      } catch (error) {
        if (error instanceof DeliveryContentLinkError) {
          return blockVerification(error.message, checks, deliveryChangedPaths);
        }
        throw error;
      }
    }
    const checkByIdentity = new Map(checks.map((check, index) => [checkIdentity(check, index), check] as const));
    const requiredFailures = input.commands.flatMap((command, index) => {
      if (!command.required) return [];
      const identity = command.id ? `id:${command.id}` : `position:${index}`;
      const observed = checkByIdentity.get(identity) ?? checks[index];
      return observed?.status === "passed" ? [] : [{ commandId: command.id, status: observed?.status ?? "missing", check: observed }];
    });
    const requiredFailure = requiredFailures.length > 0;
    const verificationMutation = contentDigestBefore !== undefined && contentDigestAfter !== contentDigestBefore
      ? "Verification commands changed controller-approved delivery content; refusing to commit untested results"
      : undefined;
    const semanticEvidenceFailure = preflightFailure || requiredFailure || (!strictSemanticEvidence && !hasEvidenceContract)
      ? undefined
      : hasEvidenceContract
        ? contractSemanticEvidenceFailure(input.packet, resolvedCoverage.map(({ coverage, criterionId }) => ({ ...coverage, criterionId: criterionId! })), checks, input.commands)
        : anchorPreflightFailure ?? await criterionSemanticEvidenceFailure(
          resolvedCoverage.map(({ coverage, criterionId }) => ({ ...coverage, criterionId: criterionId! })),
          checks,
          input.commands,
        );
    const failure = preflightFailure ?? verificationMutation ?? (requiredFailure ? "Required verification failed" : semanticEvidenceFailure);

    if (failure) {
      const failedChecks = checks.filter((check) => check.status === "failed" || check.status === "skipped");
      const checkDetails = failedChecks.map((check) => `${check.command}${check.commandId ? ` [${check.commandId}]` : ""}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""}${check.summary ? ` — ${check.summary}` : ""}${check.status === "skipped" ? " [skipped]" : ""}`);
      const detailedFailure = checkDetails.length
        ? `${failure}: ${checkDetails.join("; ")}`
        : failure;
      const contractBuilderFailure = contractBuilderDiagnostics.length > 0;
      const contractBuilderReportFailure = contractBuilderDiagnostics.some(({ code }) => ["missing-criterion-id", "unknown-criterion", "missing-criterion", "duplicate-criterion", "criterion-mismatch"].includes(code));
      const failureKind = contractValidationDiagnostics.length
        ? "packet-contract" as const
        : contractBuilderFailure
          ? (contractBuilderReportFailure ? "builder-report" as const : "builder-semantic-evidence" as const)
          : semanticEvidenceFailure
          ? "builder-semantic-evidence" as const
          : requiredFailure
          ? "required-check" as const
          : verificationMutation
            ? "verification-mutation" as const
            : changeReportFailure || coverageFailure
              ? "builder-report" as const
              : unexpected.length
                ? "scope" as const
                : undefined;
      return blockVerification(detailedFailure, checks, deliveryChangedPaths, failureKind, contractDiagnostics);
    }

    if (!run.targetBranch) throw new Error("Verified run is missing its frozen target branch");
    if (!input.workspace.baseSha) throw new Error("Verified commit checkpoint requires a frozen workspace base SHA");
    const acceptanceEvidence = input.packet.payload.acceptanceCriteria.map((criterion, index) => {
      const criterionId = `criterion-${index + 1}`;
      const coverage = resolvedCoverage.find((item) => item.criterionId === criterionId)!.coverage;
      const controllerEvidence = input.subjectEvidence?.length
        ? ` Controller-observed subject evidence: ${input.subjectEvidence.join(" | ")}`
        : "";
      return {
        criterionId,
        criterion,
        status: "passed" as const,
        evidence: `${coverage.implementation}${controllerEvidence}`,
        ...(coverage.anchors ? {
          anchors: normalizeAcceptanceAnchors(input.packet, criterionId, coverage.anchors),
        } : {}),
      };
    });
    const parentHeadSha = await dependencies.git.head(input.workspace);
    const commitMessage = `forge: implement issue ${run.subject.issue ?? "work item"}`;
    const checkpointId = `art_verification_${createHash("sha256").update(JSON.stringify({
      runId: run.runId,
      branch: input.workspace.branch,
      baseSha: input.workspace.baseSha,
      parentHeadSha,
      changedPaths: deliveryChangedPaths,
      pendingChangedPaths: changedPaths,
      verifiedContentDigest: contentDigestAfter,
      checks,
    })).digest("hex").slice(0, 32)}`;
    const checkpoint = createArtifact({
      kind: "VerificationCheckpoint",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        checkpoint: "verified-commit",
        branch: input.workspace.branch,
        targetBranch: run.targetBranch,
        ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
        ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
        baseSha: input.workspace.baseSha,
        parentHeadSha,
        changedPaths: deliveryChangedPaths,
        pendingChangedPaths: changedPaths,
        verifiedContentDigest: contentDigestAfter!,
        commitMessage,
        summary: input.submission.summary,
        acceptanceEvidence,
        checks,
        decisions: input.submission.decisions,
        residualRisks: input.submission.residualRisks,
      },
    }, { id: checkpointId });
    await dependencies.artifacts.append(checkpoint);
    run = attachArtifact(run, "VerificationCheckpoint", checkpoint.id);
    const [preCommitHead, preCommitPaths, preCommitDigest] = await Promise.all([
      dependencies.git.head(input.workspace),
      dependencies.git.changedPaths(input.workspace).then(canonicalizeConcreteScopePaths),
      deliveryContentDigest(input.workspace.path, deliveryChangedPaths),
    ]);
    if (preCommitHead.toLowerCase() !== parentHeadSha.toLowerCase()
      || JSON.stringify(preCommitPaths.sort()) !== JSON.stringify(changedPaths.sort())
      || preCommitDigest !== contentDigestAfter) {
      throw new Error("Workspace changed after the durable verification checkpoint; refusing to commit");
    }

    const headSha = await dependencies.git.commit(input.workspace, commitMessage);
    if (dependencies.git.commitParents) {
      const committedParents = await dependencies.git.commitParents(input.workspace);
      if (committedParents.length !== 1 || committedParents[0]?.toLowerCase() !== parentHeadSha.toLowerCase()) {
        throw new Error(`Committed verification revision ${headSha} is not the exact non-merge child of ${parentHeadSha}`);
      }
    }
    const revisionChangedPaths = canonicalizeConcreteScopePaths(
      await dependencies.git.revisionChangedPaths(input.workspace),
    ).sort();
    const committedUnexpected = revisionChangedPaths.filter((path) => !expectedPaths.has(path));
    const committedPathSet = new Set(revisionChangedPaths);
    const committedOmittedFromReport = revisionChangedPaths.filter((path) => !reportedPathSet.has(path));
    const committedNotObserved = reportedPaths.filter((path) => !committedPathSet.has(path));
    let committedWorktreeDigest: string;
    try {
      committedWorktreeDigest = await deliveryContentDigest(input.workspace.path, revisionChangedPaths);
    } catch (error) {
      if (error instanceof DeliveryContentLinkError) {
        return blockVerification(error.message, checks, revisionChangedPaths);
      }
      throw error;
    }
    const committedBlobsMatch = contentDigestAfter === undefined
      ? false
      : await dependencies.git.committedContentMatches(
        input.workspace, revisionChangedPaths, contentDigestAfter, headSha,
      );
    const committedRevisionFailure = committedUnexpected.length
      ? `Committed delivery revision contains paths outside the Build Packet: ${committedUnexpected.join(", ")}`
      : committedOmittedFromReport.length || committedNotObserved.length
        ? `Committed delivery revision does not match the controller-approved builder report:${committedOmittedFromReport.length ? ` omitted ${committedOmittedFromReport.join(", ")}` : ""}${committedNotObserved.length ? ` reported absent ${committedNotObserved.join(", ")}` : ""}`
        : contentDigestAfter !== committedWorktreeDigest
          ? "Post-commit workspace content does not match the controller-verified delivery content"
          : !committedBlobsMatch
            ? "Raw committed blobs do not match the controller-verified delivery content"
            : undefined;
    if (committedRevisionFailure) {
      return blockVerification(committedRevisionFailure, checks, revisionChangedPaths);
    }
    const buildResult = createArtifact({
      kind: "BuildResult",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        branch: input.workspace.branch,
        targetBranch: checkpoint.payload.targetBranch,
        ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
        ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
        headSha,
        ...(input.workspace.baseSha ? { baseSha: input.workspace.baseSha } : {}),
        changedPaths: revisionChangedPaths,
        summary: input.submission.summary,
        acceptanceEvidence,
        checks,
        decisions: input.submission.decisions,
        residualRisks: input.submission.residualRisks,
      },
    }, { id: deterministicBuildResultId(checkpoint.id, headSha) });
    await dependencies.artifacts.append(buildResult);
    run = attachArtifact(run, "BuildResult", buildResult.id);
    const passed = transition(run, "VERIFICATION_PASSED", { headSha });
    await dependencies.runs.commit(run.version, passed.state, passed.record);
    return { run: passed.state, checks, buildResult };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}

export async function recoverVerificationCheckpoint(
  input: {
    run: RunState;
    checkpoint: DurableArtifact<"VerificationCheckpoint">;
    workspace: GitWorkspace;
    packet?: DurableArtifact<"BuildPacket">;
    /** Frozen packet-selected commands and runner used for crash recovery. */
    commands?: readonly VerificationCommand[];
    verifier?: VerificationRunner;
  },
  dependencies: {
    git: GitWorkspaceManager;
    artifacts: ArtifactRepository;
    runs: RunRepository;
  },
): Promise<VerificationResult> {
  const { checkpoint, workspace } = input;
  let run = input.run;
  if (run.state === "building") {
    const verifying = transition(run, "BUILD_COMPLETED");
    await dependencies.runs.commit(run.version, verifying.state, verifying.record);
    run = verifying.state;
  }
  if (run.state !== "verifying") throw new Error(`Verified commit recovery requires building or verifying state, found ${run.state}`);
  if (checkpoint.runId !== run.runId
    || checkpoint.subject.repo.toLowerCase() !== run.subject.repo.toLowerCase()
    || checkpoint.subject.issue !== run.subject.issue) {
    throw new Error("Verified commit checkpoint does not belong to the retained run");
  }
  if (workspace.branch !== checkpoint.payload.branch
    || workspace.baseSha?.toLowerCase() !== checkpoint.payload.baseSha.toLowerCase()
    || run.targetBranch !== checkpoint.payload.targetBranch
    || run.promotionTarget !== checkpoint.payload.promotionTarget
    || run.productionTarget !== checkpoint.payload.productionTarget) {
    throw new Error("Verified commit checkpoint does not match the retained workspace delivery identity");
  }

  const expectedPaths = canonicalizeConcreteScopePaths(checkpoint.payload.changedPaths).sort();
  if (!input.commands || !input.verifier) {
    throw new Error("Retained verification checkpoint lacks a frozen executable plan; refusing to trust stale checks");
  }
  if (!input.commands.length || input.commands.some((command) => !command.planId)) {
    throw new Error("Retained verification checkpoint recovery requires plan-bound verification commands");
  }
  if (input.packet?.payload.evidenceContract) {
    const evidenceDiagnostics = validateEvidenceContract(input.packet.payload.evidenceContract, {
      acceptanceCriteria: input.packet.payload.acceptanceCriteria,
      ...(input.packet.payload.verificationRequirements ? { verificationRequirements: input.packet.payload.verificationRequirements } : {}),
      ...(input.packet.payload.controllerGates ? { controllerGates: input.packet.payload.controllerGates } : {}),
      commands: input.commands.map((command) => ({
        id: command.id,
        ...(command.evidenceCapability !== undefined ? { evidenceCapability: command.evidenceCapability } : {}),
        ...(command.targets !== undefined ? { targets: command.targets } : {}),
      })),
      ...(input.packet.payload.invariantMatrices ? { invariantMatrices: input.packet.payload.invariantMatrices } : {}),
      expectedPaths: input.packet.payload.expectedPaths,
      ...(input.packet.payload.evidencePaths ? { evidencePaths: input.packet.payload.evidencePaths } : {}),
    });
    if (evidenceDiagnostics.length) {
      throw new Error(`Recovery evidence contract validation failed: ${evidenceDiagnostics.map((diagnostic) => `[${diagnostic.code}${diagnostic.criterionId ? ` ${diagnostic.criterionId}` : ""}] ${diagnostic.message}`).join("; ")}`);
    }
  }
  const beforeVerificationDigest = await deliveryContentDigest(workspace.path, expectedPaths);
  const recoveredChecks = await input.verifier.run(input.commands);
  const afterVerificationDigest = await deliveryContentDigest(workspace.path, expectedPaths);
  if (beforeVerificationDigest !== afterVerificationDigest) {
    throw new Error("Recovery verification commands changed controller-approved delivery content");
  }
  const requiredRecoveryFailures = input.commands.flatMap((command, index) => {
    if (!command.required) return [];
    const check = recoveredChecks.find((candidate) => candidate.commandId === command.id) ?? recoveredChecks[index];
    if (!check || check.status !== "passed" || check.planId !== command.planId
      || check.policyVersion !== command.policyVersion
      || JSON.stringify(check.commandTargets ?? []) !== JSON.stringify(command.targets ?? [])) {
      return [command.id];
    }
    return [];
  });
  if (requiredRecoveryFailures.length) {
    throw new Error(`Recovery verification failed or drifted for required command(s): ${requiredRecoveryFailures.join(", ")}`);
  }
  let recoveryChecks = recoveredChecks;
  let headSha = await dependencies.git.head(workspace);
  if (headSha.toLowerCase() === checkpoint.payload.parentHeadSha.toLowerCase()) {
    const changed = canonicalizeConcreteScopePaths(await dependencies.git.changedPaths(workspace)).sort();
    const expectedPendingPaths = canonicalizeConcreteScopePaths(checkpoint.payload.pendingChangedPaths).sort();
    const digest = await deliveryContentDigest(workspace.path, expectedPaths);
    if (JSON.stringify(changed) !== JSON.stringify(expectedPendingPaths)
      || digest !== checkpoint.payload.verifiedContentDigest) {
      throw new Error("Retained pre-commit workspace no longer matches the durable verification checkpoint");
    }
    headSha = await dependencies.git.commit(workspace, checkpoint.payload.commitMessage);
  } else {
    const dirty = await dependencies.git.changedPaths(workspace);
    if (dirty.length) throw new Error(`Retained committed workspace is dirty: ${dirty.join(", ")}`);
  }

  if (headSha.toLowerCase() === checkpoint.payload.parentHeadSha.toLowerCase()) {
    throw new Error("Retained verification checkpoint has no committed child revision");
  }
  if (dependencies.git.assertPristineAtHead) await dependencies.git.assertPristineAtHead(workspace, headSha);
  if (!dependencies.git.commitParents) {
    throw new Error("Git workspace manager cannot prove exact retained commit parents");
  }
  const parents = await dependencies.git.commitParents(workspace);
  if (parents.length !== 1 || parents[0]?.toLowerCase() !== checkpoint.payload.parentHeadSha.toLowerCase()) {
    throw new Error(`Retained HEAD ${headSha} is not the exact non-merge child of verified parent ${checkpoint.payload.parentHeadSha}`);
  }
  const revisionChangedPaths = canonicalizeConcreteScopePaths(
    await dependencies.git.revisionChangedPaths(workspace),
  ).sort();
  if (JSON.stringify(revisionChangedPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error("Retained committed HEAD does not carry the exact verified delivery paths");
  }
  if (!await dependencies.git.committedContentMatches(
    workspace,
    expectedPaths,
    checkpoint.payload.verifiedContentDigest,
    headSha,
  )) {
    throw new Error("Retained committed HEAD blobs do not match the durable verified tree");
  }

  const buildResult = createArtifact({
    kind: "BuildResult",
    runId: run.runId,
    subject: run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      branch: checkpoint.payload.branch,
      targetBranch: checkpoint.payload.targetBranch,
      ...(checkpoint.payload.promotionTarget ? { promotionTarget: checkpoint.payload.promotionTarget } : {}),
      ...(checkpoint.payload.productionTarget ? { productionTarget: checkpoint.payload.productionTarget } : {}),
      headSha,
      baseSha: checkpoint.payload.baseSha,
      changedPaths: expectedPaths,
      summary: checkpoint.payload.summary,
      acceptanceEvidence: checkpoint.payload.acceptanceEvidence,
      checks: recoveryChecks,
      decisions: checkpoint.payload.decisions,
      residualRisks: checkpoint.payload.residualRisks,
    },
  }, { id: deterministicBuildResultId(checkpoint.id, headSha) });
  await dependencies.artifacts.append(buildResult);
  run = attachArtifact(run, "BuildResult", buildResult.id);
  const passed = transition(run, "VERIFICATION_PASSED", { headSha });
  await dependencies.runs.commit(run.version, passed.state, passed.record);
  return { run: passed.state, checks: [...recoveryChecks], buildResult };
}

function deterministicBuildResultId(checkpointId: string, headSha: string): string {
  return `art_build_${createHash("sha256").update(`${checkpointId}\0${headSha.toLowerCase()}`).digest("hex").slice(0, 32)}`;
}

export function uncoveredVerificationCommands(
  plan: readonly string[],
  commands: readonly Pick<VerificationCommand, "id" | "command" | "args">[],
  controllerGates: readonly ControllerVerificationGate[] = [],
): string[] {
  const uncovered = new Set<string>();
  const configuredGates = new Set(controllerGates.map((gate) => gate.id));
  for (const step of plan) {
    const controllerGate = /^controller-gate:([a-z-]+)$/i.exec(step.trim().replace(/[.!]+$/, ""));
    if (controllerGate) {
      const token = `controller-gate:${controllerGate[1]}`;
      if (!configuredGates.has(controllerGate[1] as ControllerVerificationGate["id"])) uncovered.add(token);
      continue;
    }
    const fenced = [...step.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim());
    const hasExecutableVerb = /^\s*(?:run|execute)\s+/i.test(step);
    const hasControllerLifecycleEvidence = /^\s*(?:(?:confirm|ensure|verify|check)\s+(?:the\s+)?controller\s+lifecycle\s+gates?\b|(?:the\s+)?controller\s+(?:verifies?|checks?|confirms?|owns?)\b)/i.test(step);
    const hasManualEvidenceVerb = (/^\s*(?:inspect|review)\b/i.test(step)
      || /^\s*(?:confirm|ensure|verify|check)\s+(?:that|the|whether)\b/i.test(step)
      || hasControllerLifecycleEvidence)
      && !hasExecutableVerb;
    const hasExecutionOutcome = /\b(?:exits?\s+(?:with\s+)?(?:zero|0)|returns?\s+(?:zero|0)|passes?|succeeds?|completes?(?:\s+successfully)?|runs?|works?|is\s+green)\b/i.test(step);
    const hasEmbeddedExecutable = /\b(?:git|npm(?:\.cmd)?|node|npx|pnpm|yarn|bun|deno|python|python3|pytest|cargo|go|make|bash|sh|zsh|pwsh|powershell|dotnet|java|mvn|gradle|ruby|bundle|php|composer|swift|cmake|ctest|meson|ninja|eslint|biome|ruff|tsc|vitest|jest)\b/i.test(step)
      || /(?:^|[\s`])(?:\.\/)?(?:scripts|bin)[\\/][A-Za-z0-9_.\\/-]+/i.test(step)
      || /\b[A-Za-z0-9_.]+-[A-Za-z0-9_.-]+\s+--?[A-Za-z0-9_-]+/i.test(step);
    const normalizedStep = step.trim().replace(/[.!]\s*$/, "");
    const candidates = fenced.length
      ? fenced.map((candidate) => ({ candidate, fenced: true }))
      : [{
        candidate: step.replace(/^\s*(?:run|execute)\s+/i, "").replace(/[.!]\s*$/, "").trim(),
        fenced: false,
      }];
    for (const { candidate, fenced: isFenced } of candidates) {
      if (!candidate) continue;
      if (commands.some((command) => candidate === [command.command, ...command.args].join(" ").trim())) {
        continue;
      }
      if (/^git\s+diff\s+--check$/i.test(candidate)) {
        if (!commands.some(isConfiguredDiffCheck)) uncovered.add(candidate);
        continue;
      }
      const npmScript = /^npm(?:\.cmd)?\s+(?:run\s+)?([A-Za-z0-9:_-]+)$/i.exec(candidate)?.[1];
      if (npmScript) {
        const covered = commands.some((command) =>
          command.id === npmScript && configuredNpmScript(command) === npmScript);
        if (!covered) uncovered.add(candidate);
        continue;
      }
      // Semantic/manual evidence may remain prose, but every command-shaped
      // step fails closed unless it exactly matches a controller-owned check.
      const bareFencedCommand = isFenced && normalizedStep === `\`${candidate}\``;
      if (hasExecutableVerb
        || hasExecutionOutcome
        || (hasEmbeddedExecutable && !hasManualEvidenceVerb)
        || bareFencedCommand
        || looksLikeExecutableCandidate(candidate, isFenced)
        || (!isFenced && !hasManualEvidenceVerb)) {
        uncovered.add(candidate);
      }
    }
  }
  return [...uncovered];
}

function isConfiguredDiffCheck(command: Pick<VerificationCommand, "id" | "command" | "args">): boolean {
  const executable = executableName(command.command);
  return command.id === "diff-check"
    && (executable === "git" || executable === "git.exe")
    && command.args.length === 2
    && command.args[0] === "diff"
    && command.args[1] === "--check";
}

function configuredNpmScript(
  command: Pick<VerificationCommand, "id" | "command" | "args">,
): string | undefined {
  const executable = executableName(command.command);
  let args = [...command.args];
  if (executable === "node" || executable === "node.exe") {
    if (!/\/(?:npm-cli\.js)$/i.test(args[0]?.replaceAll("\\", "/") ?? "")) return undefined;
    args = args.slice(1);
  } else if (executable !== "npm" && executable !== "npm.cmd" && executable !== "npm.exe") {
    return undefined;
  }
  if (args[0] === "run" && args.length === 2) return args[1];
  return args.length === 1 ? args[0] : undefined;
}

function executableName(command: string): string {
  return command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function looksLikeExecutableCandidate(candidate: string, fenced: boolean): boolean {
  if (/^(?:git|npm(?:\.cmd)?|node|npx|pnpm|yarn|bun|deno|python|python3|pytest|cargo|go|make|bash|sh|zsh|pwsh|powershell|dotnet|java|mvn|gradle|ruby|bundle|php|composer|swift|cmake|ctest|meson|ninja|eslint|biome|ruff|tsc|vitest|jest)\b/i.test(candidate)) {
    return true;
  }
  if (/^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/]).+\.(?:sh|ps1|cmd|bat|js|mjs|cjs|py|rb)$/i.test(candidate)) {
    return true;
  }
  if (/^[A-Za-z0-9_.-]+\s+--?[A-Za-z0-9_-]/.test(candidate)) return true;
  if (!fenced) return false;
  if (/^[^\s]+[\\/][^\s]+$/.test(candidate) && !/^(?:\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(candidate)) {
    return false;
  }
  return !/^(?:(?:Dockerfile|Makefile|README|LICENSE|CHANGELOG|SECURITY)(?:\.[^\s]+)?|[^\s]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|mdx|toml|rs|go|py|java|cs|cpp|h))(?::\d+)?$/i.test(candidate);
}

export async function deliveryContentDigest(workspacePath: string, paths: readonly string[]): Promise<string> {
  const root = resolve(workspacePath);
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) {
    const absolute = resolve(root, path);
    if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
      throw new Error(`Delivery digest path escapes the workspace: ${path}`);
    }
    hash.update(path).update("\0");
    try {
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new DeliveryContentLinkError(path);
      hash.update(stat.mode & 0o111 ? "1" : "0").update("\0");
      if (stat.isFile()) {
        hash.update("file\0").update(await readFile(absolute)).update("\0");
      } else {
        throw new Error(`Delivery path is not a file or symbolic link: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("deleted\0");
    }
  }
  return hash.digest("hex");
}

export function verificationProgressRecorder(
  runId: string,
  stage: "baseline" | "changed",
  runs: RunRepository,
): (progress: VerificationCommandProgress) => Promise<void> {
  return async (progress) => {
    const command = "commandId" in progress ? ` ${progress.commandId}` : "";
    const status = progress.phase === "command-completed" ? ` (${progress.status})` : "";
    await runs.recordProgress({
      runId,
      phase: `verification.${stage}.${progress.phase}`,
      message: `${stage === "baseline" ? "Baseline" : "Changed revision"} verification${command}: ${progress.phase}${status}`,
      occurredAt: new Date().toISOString(),
    });
  };
}

function collectContractStructuralDiagnostics(input: {
  packet: DurableArtifact<"BuildPacket">;
  coverage: readonly BuilderSubmission["criterionCoverage"][number][];
  commands: readonly VerificationCommand[];
}): VerificationEvidenceDiagnostic[] {
  const packet = input.packet.payload;
  const contract = packet.evidenceContract;
  if (contract?.version !== "forgedock.evidence/v1") return [];
  const diagnostics: VerificationEvidenceDiagnostic[] = [];
  const byId = new Map(contract.criteria.map((criterion) => [criterion.criterionId, criterion] as const));
  const seen = new Map<string, number>();
  const knownCriteria = new Set(packet.acceptanceCriteria.map((_, index) => `criterion-${index + 1}`));
  for (const item of input.coverage) {
    if (item.criterionId === undefined) {
      diagnostics.push({ code: "missing-criterion-id", message: "Contract packet coverage must name a stable criterion ID" });
      continue;
    }
    seen.set(item.criterionId, (seen.get(item.criterionId) ?? 0) + 1);
    if (!knownCriteria.has(item.criterionId) || !byId.has(item.criterionId)) {
      diagnostics.push({ code: "unknown-criterion", criterionId: item.criterionId, message: `Builder coverage references unknown criterion ${item.criterionId}` });
      continue;
    }
    const criterionText = packet.acceptanceCriteria[Number(item.criterionId.slice("criterion-".length)) - 1];
    if (criterionText !== item.criterion) {
      diagnostics.push({ code: "criterion-mismatch", criterionId: item.criterionId, message: `Builder criterion text does not exactly match frozen ${item.criterionId}` });
    }
  }
  for (const [criterionId, count] of seen) {
    if (count > 1) diagnostics.push({ code: "duplicate-criterion", criterionId, message: `Builder supplied ${count} coverage entries for ${criterionId}` });
  }
  for (const criterion of packet.acceptanceCriteria.map((_, index) => `criterion-${index + 1}`)) {
    if (!seen.has(criterion)) diagnostics.push({ code: "missing-criterion", criterionId: criterion, message: `Builder omitted coverage for ${criterion}` });
  }

  const commandById = new Map(input.commands.map((command) => [command.id, command] as const));
  for (const expected of contract.criteria) {
    const item = input.coverage.find((coverage) => coverage.criterionId === expected.criterionId);
    if (!item) continue;
    const anchors = item.anchors;
    if (!anchors) {
      if (expected.requiredCommandIds.length) {
        diagnostics.push({ code: "missing-anchors", criterionId: expected.criterionId, message: `${expected.criterionId} is command-backed but has no typed evidence anchors` });
      }
      continue; // gate-only criteria are intentionally allowed to remain prose-only.
    }
    let paths: string[] = [];
    try {
      paths = canonicalizeConcreteScopePaths(anchors.paths);
    } catch (error) {
      diagnostics.push({ code: "invalid-evidence-path", criterionId: expected.criterionId, message: error instanceof Error ? error.message : String(error) });
    }
    const allowedPaths = new Set([...expected.allowedWritePaths, ...expected.allowedEvidencePaths]);
    for (const path of paths) {
      if (!allowedPaths.has(path)) diagnostics.push({ code: "out-of-contract-path", criterionId: expected.criterionId, message: `${expected.criterionId} cites path outside its frozen evidence contract: ${path}`, details: { path } });
    }
    const required = new Set(expected.requiredCommandIds);
    const cited = new Set(anchors.verificationCommandIds);
    for (const id of anchors.verificationCommandIds) {
      if (!commandById.has(id)) diagnostics.push({ code: "unknown-command", criterionId: expected.criterionId, message: `${expected.criterionId} cites unknown command ID ${id}`, details: { commandId: id } });
      else if (!required.has(id)) diagnostics.push({ code: "out-of-contract-command", criterionId: expected.criterionId, message: `${expected.criterionId} cites command ID ${id}, which is not required for that criterion`, details: { commandId: id } });
    }
    for (const id of expected.requiredCommandIds) {
      if (!cited.has(id)) diagnostics.push({ code: "omitted-required-command", criterionId: expected.criterionId, message: `${expected.criterionId} omits required command ID ${id}`, details: { commandId: id } });
    }
    for (const id of expected.semanticCommandIds) {
      if (!cited.has(id)) diagnostics.push({ code: "omitted-semantic-command", criterionId: expected.criterionId, message: `${expected.criterionId} omits semantic command ID ${id}`, details: { commandId: id } });
    }
    if (expected.requiredCommandIds.length && !expected.semanticCommandIds.length) {
      diagnostics.push({ code: "generic-only-command", criterionId: expected.criterionId, message: `${expected.criterionId} is backed only by generic commands` });
    }
    for (const testId of expected.invariantTestIds) {
      if (!anchors.testIds.includes(testId)) diagnostics.push({ code: "missing-invariant-test-id", criterionId: expected.criterionId, message: `${expected.criterionId} omits invariant root test ID ${testId}`, details: { testId } });
    }
  }
  return diagnostics;
}

function normalizeAcceptanceAnchors(
  packet: DurableArtifact<"BuildPacket">,
  criterionId: string,
  anchors: CriterionEvidenceAnchors,
): CriterionEvidenceAnchors {
  const contractCriterion = packet.payload.evidenceContract?.criteria.find(({ criterionId: id }) => id === criterionId);
  if (!contractCriterion) return anchors;
  return {
    paths: [...new Set(anchors.paths)],
    symbols: [...new Set(anchors.symbols)],
    testIds: [...new Set([
      ...anchors.testIds,
      ...contractCriterion.invariantCaseIds,
    ])],
    verificationCommandIds: [...new Set(anchors.verificationCommandIds)],
  };
}
function usesStrictSemanticEvidence(packet: DurableArtifact<"BuildPacket">): boolean {
  return packet.payload.verificationPolicyVersion === "forgedock.verification/v2";
}

function criterionAnchorPreflightFailure(input: {
  packet: DurableArtifact<"BuildPacket">;
  coverage: readonly BuilderSubmission["criterionCoverage"][number][];
  commands: readonly VerificationCommand[];
  allowedPaths: readonly string[];
}): string | undefined {
  // Durable legacy packets remain readable under their historical evidence
  // contract. Every newly canonicalized packet carries typed requirements and
  // is held to semantic anchors below.
  if (!usesStrictSemanticEvidence(input.packet)) return undefined;
  const commandIds = new Set(input.commands.map(({ id }) => id));
  const allowedPaths = new Set(canonicalizeConcreteScopePaths(input.allowedPaths));
  for (const coverage of input.coverage) {
    const id = coverage.criterionId!;
    const anchors = coverage.anchors;
    if (!anchors) return `Criterion ${id} has prose-only builder evidence; typed path, symbol, test, and verification anchors are required`;
    let anchoredPaths: string[];
    try {
      anchoredPaths = canonicalizeConcreteScopePaths(anchors.paths);
    } catch (error) {
      return `Criterion ${id} has an invalid repository path anchor: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (anchoredPaths.some((path) => !allowedPaths.has(path))) {
      return `Criterion ${id} anchors evidence outside the frozen Build Packet: ${anchoredPaths.filter((path) => !allowedPaths.has(path)).join(", ")}`;
    }
    const unknownCommands = anchors.verificationCommandIds.filter((commandId) => !commandIds.has(commandId));
    if (unknownCommands.length) return `Criterion ${id} cites unknown frozen verification command IDs: ${unknownCommands.join(", ")}`;
    const requiredIds = input.packet.payload.verificationRequirements
      ?.filter((requirement) => requirement.kind === "command" && requirement.criterionIds.includes(id))
      .map(({ id: commandId }) => commandId) ?? [];
    const matrixTestIds = input.packet.payload.invariantMatrices
      ?.filter((row) => row.criterionId === id)
      .flatMap((row) => [row.testId, ...expandInvariantMatrix(row).map(({ id: caseId }) => caseId)]) ?? [];
    const missingMatrixTests = matrixTestIds.filter((testId) => !anchors.testIds.includes(testId));
    if (missingMatrixTests.length) {
      return `Criterion ${id} omits controller-derived invariant matrix test IDs: ${missingMatrixTests.join(", ")}`;
    }
    if (!requiredIds.length) {
      return `Criterion ${id} has no controller-frozen command requirement`;
    }
    if (requiredIds.some((commandId) => !anchors.verificationCommandIds.includes(commandId))) {
      return `Criterion ${id} omits controller-required verification anchors: ${requiredIds.filter((commandId) => !anchors.verificationCommandIds.includes(commandId)).join(", ")}`;
    }
    const hasSemanticCommand = anchors.verificationCommandIds.some((commandId) => {
      if (!requiredIds.includes(commandId)) return false;
      const command = input.commands.find(({ id: candidate }) => candidate === commandId);
      return command !== undefined && (
        command.targeting === "expected-test-paths" && Boolean(command.targets?.length)
        || command.targets?.some((target) => anchoredPaths.includes(target))
        || /(?:^|[-_:])(?:test|spec|regression|invariant)(?:$|[-_:])/i.test(command.id)
      );
    });
    if (!hasSemanticCommand) {
      return `Criterion ${id} is anchored only to generic checks; a targeted test, regression, invariant, or path-bound command is required`;
    }
  }
  return undefined;
}

async function criterionSemanticEvidenceFailure(
  coverage: readonly BuilderSubmission["criterionCoverage"][number][],
  checks: readonly CheckResult[],
  commands: readonly VerificationCommand[],
): Promise<string | undefined> {
  const failures: string[] = [];
  for (const item of coverage) {
    const id = item.criterionId!;
    const anchors = item.anchors!;
    const failedIds = anchors.verificationCommandIds.filter((commandId) => commandStatus(commandId, commands, checks) !== "passed");
    if (failedIds.length) failures.push(`${id}: ${failedIds.join(", ")}`);
  }
  return failures.length ? `Criteria cannot pass because anchored controller checks did not pass: ${failures.join("; ")}` : undefined;
}

function contractSemanticEvidenceFailure(
  packet: DurableArtifact<"BuildPacket">,
  coverage: readonly BuilderSubmission["criterionCoverage"][number][],
  checks: readonly CheckResult[],
  commands: readonly VerificationCommand[],
): string | undefined {
  const failures: string[] = [];
  for (const criterion of packet.payload.evidenceContract?.criteria ?? []) {
    const item = coverage.find((entry) => entry.criterionId === criterion.criterionId);
    if (!item?.anchors) continue; // structural preflight reports missing anchors.
    // Every command explicitly assigned to a criterion is an acceptance gate,
    // including commands whose catalog metadata says required=false. Semantic
    // command IDs are an additional authority requirement, not a substitute
    // for those generic command gates.
    const failedIds = [...new Set([
      ...criterion.requiredCommandIds,
      ...criterion.semanticCommandIds,
    ])].filter((id) => commandStatus(id, commands, checks) !== "passed");
    if (failedIds.length) failures.push(`${criterion.criterionId}: ${failedIds.join(", ")}`);
  }
  return failures.length ? `Criteria cannot pass because semantic controller checks did not pass: ${failures.join("; ")}` : undefined;
}

function commandStatus(
  commandId: string,
  commands: readonly VerificationCommand[],
  checks: readonly CheckResult[],
): CheckResult["status"] | "missing" {
  const byId = checks.find((check) => check.commandId === commandId);
  if (byId) return byId.status;
  const index = commands.findIndex((command) => command.id === commandId);
  return index >= 0 ? (checks[index]?.status ?? "missing") : "missing";
}

function checkIdentity(check: CheckResult, index: number): string {
  return check.commandId ? `id:${check.commandId}` : `position:${index}`;
}

function compareWithBaseline(check: CheckResult, baseline: CheckResult | undefined): CheckResult {
  if (!baseline) return check;
  // Baselines are evidence for one exact executable plan.  Never classify a
  // result against a check from another base SHA, policy, target expansion, or
  // command identity (planId is minted from the frozen base SHA and command
  // execution witness).
  const samePlan = check.command === baseline.command
    && check.commandId === baseline.commandId
    && check.planId !== undefined
    && check.planId === baseline.planId
    && check.policyVersion === baseline.policyVersion
    && JSON.stringify(check.commandTargets ?? []) === JSON.stringify(baseline.commandTargets ?? []);
  if (!samePlan) return check;
  const sameKnownFailures = check.status === "failed"
    && baseline.status === "failed"
    && Boolean(check.failureSignatures?.length)
    && JSON.stringify(check.failureSignatures) === JSON.stringify(baseline.failureSignatures);
  return {
    ...check,
    baselineStatus: baseline.status,
    ...(baseline.failureSignatures?.length ? { baselineFailureSignatures: baseline.failureSignatures } : {}),
    regression: check.status === "failed" ? !sameKnownFailures : false,
  };
}
