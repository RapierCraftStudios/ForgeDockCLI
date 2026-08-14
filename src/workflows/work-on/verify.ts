// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createArtifact, type ControllerVerificationGate, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import { canonicalizeConcreteScopePaths } from "../../runtime/agent-runtime.js";
import type { BuilderSubmission } from "./build.js";
import { WorkflowExecutionError } from "./investigate.js";

export interface VerificationResult {
  run: RunState;
  checks: CheckResult[];
  buildResult?: DurableArtifact<"BuildResult">;
  outcome?: DurableArtifact<"Outcome">;
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
    const uncoveredPlan = uncoveredVerificationCommands(
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

    const preflightFailure = unexpected.length
      ? `Delivery revision contains paths outside the Build Packet: ${unexpected.join(", ")}`
      : !changedPaths.length
        ? "Builder produced no repository changes"
        : uncoveredPlan.length
          ? `Frozen verification plan is not covered by controller-approved commands: ${uncoveredPlan.join(", ")}`
          : !input.commands.some((command) => command.required)
            ? "No required verification commands were configured"
            : changeReportFailure ?? coverageFailure;
    const contentDigestBefore = preflightFailure
      ? undefined
      : await deliveryContentDigest(input.workspace.path, deliveryChangedPaths);
    if (!preflightFailure) await dependencies.git.prepareWorkspaceDependencies(input.workspace);
    const observedChecks = preflightFailure ? [] : await dependencies.verifier.run(input.commands, input.signal);
    const contentDigestAfter = contentDigestBefore === undefined
      ? undefined
      : await deliveryContentDigest(input.workspace.path, deliveryChangedPaths);
    const checks = observedChecks.map((check, index) => compareWithBaseline(check, input.baselineChecks?.[index]));
    const requiredFailure = input.commands.some((command, index) => command.required && checks[index]?.status !== "passed");
    const verificationMutation = contentDigestBefore !== undefined && contentDigestAfter !== contentDigestBefore
      ? "Verification commands changed controller-approved delivery content; refusing to commit untested results"
      : undefined;
    const failure = preflightFailure ?? verificationMutation ?? (requiredFailure ? "Required verification failed" : undefined);

    if (failure) {
      const failedChecks = checks.filter((check) => check.status === "failed");
      const detailedFailure = failedChecks.length
        ? `${failure}: ${failedChecks.map((check) => `${check.command}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""}${check.summary ? ` — ${check.summary}` : ""}`).join("; ")}`
        : failure;
      return blockVerification(detailedFailure, checks, deliveryChangedPaths);
    }

    const headSha = await dependencies.git.commit(input.workspace, `forge: implement issue ${run.subject.issue ?? "work item"}`);
    const revisionChangedPaths = canonicalizeConcreteScopePaths(
      await dependencies.git.revisionChangedPaths(input.workspace),
    ).sort();
    const committedUnexpected = revisionChangedPaths.filter((path) => !expectedPaths.has(path));
    const committedPathSet = new Set(revisionChangedPaths);
    const committedOmittedFromReport = revisionChangedPaths.filter((path) => !reportedPathSet.has(path));
    const committedNotObserved = reportedPaths.filter((path) => !committedPathSet.has(path));
    const committedWorktreeDigest = await deliveryContentDigest(input.workspace.path, revisionChangedPaths);
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
    if (!run.targetBranch) throw new Error("Verified run is missing its frozen target branch");
    const buildResult = createArtifact({
      kind: "BuildResult",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        branch: input.workspace.branch,
        targetBranch: run.targetBranch,
        ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
        ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
        headSha,
        ...(input.workspace.baseSha ? { baseSha: input.workspace.baseSha } : {}),
        changedPaths: revisionChangedPaths,
        summary: input.submission.summary,
        acceptanceEvidence: input.packet.payload.acceptanceCriteria.map((criterion) => {
          const implementation = resolvedCoverage.find((item) => item.criterion === criterion)!.coverage.implementation;
          const controllerEvidence = input.subjectEvidence?.length
            ? ` Controller-observed subject evidence: ${input.subjectEvidence.join(" | ")}`
            : "";
          return { criterion, status: "passed" as const, evidence: `${implementation}${controllerEvidence}` };
        }),
        checks,
        decisions: input.submission.decisions,
        residualRisks: input.submission.residualRisks,
      },
    });
    await dependencies.artifacts.append(buildResult);
    run = attachArtifact(run, "BuildResult", buildResult.id);
    const passed = transition(run, "VERIFICATION_PASSED", { headSha });
    await dependencies.runs.commit(run.version, passed.state, passed.record);
    return { run: passed.state, checks, buildResult };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
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
      hash.update(stat.mode & 0o111 ? "1" : "0").update("\0");
      if (stat.isSymbolicLink()) {
        hash.update("symlink\0").update(await readlink(absolute)).update("\0");
      } else if (stat.isFile()) {
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
