// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { GitWorkspace, GitWorkspaceManager } from "../../core/ports/git-workspace.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { CheckResult, VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
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
    allowUnexpectedPaths?: boolean;
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
  try {
    const uncoveredPlan = uncoveredVerificationCommands(input.packet.payload.verificationPlan, input.commands);
    const observedChecks = uncoveredPlan.length ? [] : await dependencies.verifier.run(input.commands, input.signal);
    const checks = observedChecks.map((check, index) => compareWithBaseline(check, input.baselineChecks?.[index]));
    const changedPaths = await dependencies.git.changedPaths(input.workspace);
    const unexpected = changedPaths.filter((path) => !input.packet.payload.expectedPaths.includes(path));
    const requiredFailure = input.commands.some((command, index) => command.required && checks[index]?.status !== "passed");
    const failure = !changedPaths.length
      ? "Builder produced no repository changes"
      : uncoveredPlan.length
        ? `Frozen verification plan is not covered by controller-approved commands: ${uncoveredPlan.join(", ")}`
        : !input.commands.some((command) => command.required)
          ? "No required verification commands were configured"
          : requiredFailure
            ? "Required verification failed"
            : unexpected.length && !input.allowUnexpectedPaths
              ? `Diff contains paths outside the Build Packet: ${unexpected.join(", ")}`
              : undefined;

    if (failure) {
      const failedChecks = checks.filter((check) => check.status === "failed");
      const detailedFailure = failedChecks.length
        ? `${failure}: ${failedChecks.map((check) => `${check.command}${check.exitCode !== undefined ? ` (exit ${check.exitCode})` : ""}${check.summary ? ` — ${check.summary}` : ""}`).join("; ")}`
        : failure;
      const outcome = createArtifact({
        kind: "Outcome",
        runId: run.runId,
        subject: run.subject,
        producer: { role: "controller", runtime: "forgedock" },
        payload: {
          status: "blocked",
          reason: detailedFailure,
          childIssues: [],
          failureEvidence: {
            branch: input.workspace.branch,
            workspacePath: input.workspace.path,
            ...(input.workspace.baseSha ? { baseSha: input.workspace.baseSha } : {}),
            builderSummary: input.submission.summary,
            changedPaths,
            checks,
          },
        },
      });
      await dependencies.artifacts.append(outcome);
      run = attachArtifact(run, "Outcome", outcome.id);
      const blocked = transition(run, "VERIFICATION_FAILED", { reason: detailedFailure });
      await dependencies.runs.commit(run.version, blocked.state, blocked.record);
      return { run: blocked.state, checks, outcome };
    }

    const headSha = await dependencies.git.commit(input.workspace, `forge: implement issue ${run.subject.issue ?? "work item"}`);
    const revisionChangedPaths = dependencies.git.revisionChangedPaths
      ? [...new Set([...(await dependencies.git.revisionChangedPaths(input.workspace)), ...changedPaths])].sort()
      : changedPaths;
    const evidenceSummary = checks.length
      ? `Required verification passed: ${checks.map((check) => check.command).join(", ")}`
      : "No executable verification commands were configured";
    const buildResult = createArtifact({
      kind: "BuildResult",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        branch: input.workspace.branch,
        headSha,
        ...(input.workspace.baseSha ? { baseSha: input.workspace.baseSha } : {}),
        changedPaths: revisionChangedPaths,
        summary: input.submission.summary,
        acceptanceEvidence: input.packet.payload.acceptanceCriteria.map((criterion) => {
          const implementation = input.submission.criterionCoverage.find((item) => item.criterion === criterion)?.implementation ?? evidenceSummary;
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
  commands: readonly Pick<VerificationCommand, "id">[],
): string[] {
  const commandIds = new Set(commands.map((command) => command.id));
  const uncovered = new Set<string>();
  for (const step of plan) {
    const fenced = [...step.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim());
    const candidates = fenced.length ? fenced : [step.replace(/^\s*(?:run|execute)\s+/i, "").replace(/[.!]\s*$/, "").trim()];
    for (const candidate of candidates) {
      if (/^git\s+diff\s+--check(?:\s|$)/i.test(candidate)) {
        if (!commandIds.has("diff-check")) uncovered.add(candidate);
        continue;
      }
      const npmScript = /^npm(?:\.cmd)?\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s|$)/i.exec(candidate)?.[1];
      if (npmScript) {
        if (!commandIds.has(npmScript)) uncovered.add(candidate);
        continue;
      }
      // Read-only diff inspection remains semantic reviewer evidence. Other
      // explicitly requested executable tools are unsupported rather than
      // silently represented as having run.
      if (/^(?:node|npx|pnpm|yarn|python|python3|pytest|cargo|go|make)\b/i.test(candidate)
        && /^\s*(?:run|execute)/i.test(step)) {
        uncovered.add(candidate);
      }
    }
  }
  return [...uncovered];
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
