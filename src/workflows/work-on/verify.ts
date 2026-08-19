// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createArtifact, type ControllerVerificationGate, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationCommand, VerificationCommandProgress, VerificationRunner } from "../../core/ports/verification.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import { canonicalizeConcreteScopePaths } from "../../runtime/agent-runtime.js";
import type { BuilderSubmission } from "./build.js";
import { WorkflowExecutionError } from "./investigate.js";
import { expandInvariantMatrix } from "./invariant-matrix.js";

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
    failureKind?: "builder-semantic-evidence" | "builder-report" | "required-check" | "scope" | "verification-mutation",
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
    const criterionById = new Map<string, string>(
      frozenCriteria.map((criterion, index) => [`criterion-${index + 1}`, criterion] as const),
    );
    const resolvedCoverage = input.submission.criterionCoverage.map((coverage) => ({
      coverage,
      criterion: coverage.criterionId === undefined
        ? coverage.criterion
        : criterionById.get(coverage.criterionId),
    }));
    const coverageCounts = new Map<string, number>();
    for (const resolved of resolvedCoverage) {
      if (resolved.criterion !== undefined) {
        coverageCounts.set(resolved.criterion, (coverageCounts.get(resolved.criterion) ?? 0) + 1);
      }
    }
    const missingCoverage = frozenCriteria.filter((criterion) => !coverageCounts.has(criterion));
    const duplicateCoverage = frozenCriteria.filter((criterion) => (coverageCounts.get(criterion) ?? 0) > 1);
    const unknownCoverage = resolvedCoverage
      .filter((resolved) => resolved.criterion === undefined || !frozenCriteria.includes(resolved.criterion))
      .map(({ coverage }) => coverage.criterionId ? `${coverage.criterionId} (${coverage.criterion})` : coverage.criterion);
    const coverageFailure = missingCoverage.length || duplicateCoverage.length || unknownCoverage.length
      ? `Builder criterion coverage is incomplete:${missingCoverage.length ? ` missing ${missingCoverage.join(" | ")}` : ""}${duplicateCoverage.length ? ` duplicated ${duplicateCoverage.join(" | ")}` : ""}${unknownCoverage.length ? ` unknown ${unknownCoverage.join(" | ")}` : ""}`
      : undefined;
    const strictSemanticEvidence = usesStrictSemanticEvidence(input.packet);
    const anchorPreflightFailure = coverageFailure || !strictSemanticEvidence ? undefined : criterionAnchorPreflightFailure({
      packet: input.packet,
      coverage: resolvedCoverage.map(({ coverage }, index) => ({ ...coverage, criterionId: coverage.criterionId ?? `criterion-${index + 1}` })),
      commands: input.commands,
      allowedPaths: [...expectedPaths],
    });

    const preflightFailure = unexpected.length
      ? `Delivery revision contains paths outside the Build Packet: ${unexpected.join(", ")}`
      : !changedPaths.length
        ? "Builder produced no repository changes"
        : uncoveredPlan.length
          ? `Frozen verification plan is not covered by controller-approved commands: ${uncoveredPlan.join(", ")}`
          : !input.commands.some((command) => command.required)
            ? "No required verification commands were configured"
            : changeReportFailure ?? coverageFailure;
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
    const requiredFailure = input.commands.some((command, index) => {
      const identity = command.id ? `id:${command.id}` : `position:${index}`;
      const observed = checkByIdentity.get(identity) ?? checks[index];
      return command.required && observed?.status !== "passed";
    });
    const verificationMutation = contentDigestBefore !== undefined && contentDigestAfter !== contentDigestBefore
      ? "Verification commands changed controller-approved delivery content; refusing to commit untested results"
      : undefined;
    const semanticEvidenceFailure = preflightFailure || requiredFailure || !strictSemanticEvidence
      ? undefined
      : anchorPreflightFailure ?? await criterionSemanticEvidenceFailure(
        resolvedCoverage.map(({ coverage }, index) => ({ ...coverage, criterionId: coverage.criterionId ?? `criterion-${index + 1}` })),
        checks,
      );
    const failure = preflightFailure ?? verificationMutation ?? (requiredFailure ? "Required verification failed" : semanticEvidenceFailure);

    if (failure) {
      const failedChecks = checks.filter((check) => check.status === "failed");
      const detailedFailure = failedChecks.length
        ? `${failure}: ${failedChecks.map((check) => `${check.command}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""}${check.summary ? ` — ${check.summary}` : ""}`).join("; ")}`
        : failure;
      const failureKind = semanticEvidenceFailure
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
      return blockVerification(detailedFailure, checks, deliveryChangedPaths, failureKind);
    }

    if (!run.targetBranch) throw new Error("Verified run is missing its frozen target branch");
    if (!input.workspace.baseSha) throw new Error("Verified commit checkpoint requires a frozen workspace base SHA");
    const acceptanceEvidence = input.packet.payload.acceptanceCriteria.map((criterion, index) => {
      const coverage = resolvedCoverage.find((item) => item.criterion === criterion)!.coverage;
      const controllerEvidence = input.subjectEvidence?.length
        ? ` Controller-observed subject evidence: ${input.subjectEvidence.join(" | ")}`
        : "";
      return {
        criterionId: coverage.criterionId ?? `criterion-${index + 1}`,
        criterion,
        status: "passed" as const,
        evidence: `${coverage.implementation}${controllerEvidence}`,
        ...(coverage.anchors ? { anchors: coverage.anchors } : {}),
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
      checks: checkpoint.payload.checks,
      decisions: checkpoint.payload.decisions,
      residualRisks: checkpoint.payload.residualRisks,
    },
  }, { id: deterministicBuildResultId(checkpoint.id, headSha) });
  await dependencies.artifacts.append(buildResult);
  run = attachArtifact(run, "BuildResult", buildResult.id);
  const passed = transition(run, "VERIFICATION_PASSED", { headSha });
  await dependencies.runs.commit(run.version, passed.state, passed.record);
  return { run: passed.state, checks: [...checkpoint.payload.checks], buildResult };
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

async function deliveryContentDigest(workspacePath: string, paths: readonly string[]): Promise<string> {
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
): Promise<string | undefined> {
  const passed = new Set(checks.filter(({ status }) => status === "passed").flatMap((check) => check.commandId ? [check.commandId] : []));
  for (const item of coverage) {
    const id = item.criterionId!;
    const anchors = item.anchors!;
    const failedIds = anchors.verificationCommandIds.filter((commandId) => !passed.has(commandId));
    if (failedIds.length) return `Criterion ${id} cannot pass because its anchored controller checks did not pass: ${failedIds.join(", ")}`;
  }
  return undefined;
}

function checkIdentity(check: CheckResult, index: number): string {
  return check.commandId ? `id:${check.commandId}` : `position:${index}`;
}

function compareWithBaseline(check: CheckResult, baseline: CheckResult | undefined): CheckResult {
  if (!baseline) return check;
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
