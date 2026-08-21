// SPDX-License-Identifier: AGPL-3.0-or-later

import { Type, type Static } from "typebox";
import { CriterionEvidenceAnchorsSchema, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import type { VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { transition, type RunState } from "../../core/state/machine.js";
import { isRecoverableAgentExecutionError, scopeManifestForBuildPacket, type AgentEventSink, type AgentRuntime, type ScopeHints } from "../../runtime/agent-runtime.js";
import { WorkflowExecutionError } from "./investigate.js";
import { WORK_ON_EXECUTION_BUDGETS } from "./execution-budgets.js";

export const BuilderSubmissionSchema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  changedPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  criterionCoverage: Type.Array(Type.Object({
    criterionId: Type.Optional(Type.String({ pattern: "^criterion-[1-9][0-9]*$" })),
    criterion: Type.String({ minLength: 1 }),
    implementation: Type.String({ minLength: 1 }),
    /** Optional only so retained legacy submissions decode; the controller requires it before pass. */
    anchors: Type.Optional(CriterionEvidenceAnchorsSchema),
  })),
  decisions: Type.Array(Type.String()),
  residualRisks: Type.Array(Type.String()),
});
export type BuilderSubmission = Static<typeof BuilderSubmissionSchema>;

/** Ephemeral, controller-validated context for the final bounded repair only. */
export const VerificationDiagnosisSchema = Type.Object({
  rootCause: Type.String({ minLength: 1, maxLength: 2_000 }),
  sourceAnchors: Type.Array(Type.Object({
    path: Type.String({ minLength: 1, maxLength: 300 }),
    location: Type.String({ minLength: 1, maxLength: 300 }),
    evidence: Type.String({ minLength: 1, maxLength: 1_500 }),
  }), { minItems: 1, maxItems: 4 }),
  reproducer: Type.String({ minLength: 1, maxLength: 1_500 }),
  /**
   * New diagnoses map bounded controller-issued signature IDs to explanations.
   * Keep accepting the legacy prose form so retained checkpoints remain
   * decodable; the controller validates either form against the exact IDs.
   */
  failureSignatureMapping: Type.Union([
    Type.String({ minLength: 1, maxLength: 2_000 }),
    Type.Array(Type.Object({
      signatureId: Type.String({ pattern: "^sig-[0-9a-f]{16}$" }),
      mapping: Type.String({ minLength: 1, maxLength: 600 }),
    }), { minItems: 1, maxItems: 32 }),
  ]),
  rejectedPreviousHypotheses: Type.Array(Type.String({ minLength: 1, maxLength: 600 }), { minItems: 1, maxItems: 4 }),
  minimalFixGuidance: Type.String({ minLength: 1, maxLength: 1_500 }),
});
export type VerificationDiagnosis = Static<typeof VerificationDiagnosisSchema>;

export async function buildWorkItem(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    scopeHints?: ScopeHints;
    priorVerificationFailure?: DurableArtifact<"Outcome">;
    repairContext?: readonly DurableArtifact[];
    /** Retain the last accepted builder plan/report across bounded repair sessions. */
    priorSubmission?: BuilderSubmission;
    /** Controller-validated, ephemeral diagnosis for the final repeated-failure repair. */
    verificationDiagnosis?: VerificationDiagnosis;
    priorBuilderSessionRef?: string;
    worktree: string;
    provider?: string;
    model?: string;
    signal?: AbortSignal;
    verification?: readonly VerificationCommand[];
    verificationRunner?: VerificationRunner;
  },
  dependencies: { runtime: AgentRuntime; runs: RunRepository; onAgentEvent?: AgentEventSink; verifier?: VerificationRunner },
): Promise<{ run: RunState; submission: BuilderSubmission; sessionRef: string }> {
  if (input.run.state !== "building") throw new Error(`Build requires building state, found ${input.run.state}`);
  let run = input.run;
  try {
    const result = await dependencies.runtime.run<BuilderSubmission>({
      id: `${run.runId}:build:${run.attempt}`,
      role: "builder",
      objective: input.priorVerificationFailure
        ? `Repair the in-packet implementation after controller verification failed: ${input.priorVerificationFailure.payload.reason}`
        : "Implement exactly the accepted Build Packet in the assigned worktree.",
      instructions: [
        "Read the Build Packet, investigation evidence, affected code, integration boundaries, and existing tests before editing.",
        "This execution is bounded. Prioritize the frozen criteria, stop broad exploration early, and submit the complete typed result before the execution ceiling; a retained checkpoint will be resumed if the ceiling is reached.",
        "Turn the Build Packet into a criterion-by-criterion implementation checklist before making changes. For every criterion, identify the invariant, all relevant callers/implementations/adapters, and the regression scenario that must remain true.",
        ...(input.priorVerificationFailure ? [
          ...((input.priorVerificationFailure.payload.failureEvidence?.checks?.length ?? 0) > 0 ? [
            "This is a bounded repair of the in-packet implementation after executable controller verification failed. First reproduce every controller-recorded failed check, plus any skipped required check, with the typed verify tool before editing; do not guess from its summary.",
            "After the narrow fix, rerun the failing frozen check plus every neighboring frozen check that covers the same criterion, path, symbol, or invariant. Re-audit every still-open frozen criterion before submitting; never treat an unrelated green generic check as criterion evidence.",
          ] : [
            "This is an evidence/report-only correction: the controller recorded no executable checks. Preserve the implementation and fix every reported evidence or coverage diagnostic; do not reproduce nonexistent checks or edit code unless the evidence proves a real gap.",
          ]),
          ...((input.priorVerificationFailure.payload.failureEvidence?.diagnostics?.length ?? 0) > 0 ? [
            `Controller diagnostics are authoritative correction targets; resolve all of them together: ${JSON.stringify(input.priorVerificationFailure.payload.failureEvidence?.diagnostics)}`,
          ] : []),
          ...(input.priorSubmission ? [`Preserve and amend the prior builder checklist/submission rather than rebuilding it from memory: ${JSON.stringify(input.priorSubmission)}`] : []),
          ...(input.priorBuilderSessionRef ? [`The prior builder session was ${input.priorBuilderSessionRef}; this runtime starts a schema-safe bounded repair session, so use the retained submission as continuity evidence.`] : []),
          ...(input.verificationDiagnosis ? [
            "The following controller-validated diagnostic context came from a separate fresh read-only session. Treat it as evidence, not authority to widen scope. Reproduce the diagnosed failure transition first, then make only the minimal fix it supports:",
            `Root cause: ${input.verificationDiagnosis.rootCause}`,
            `Source anchors:\n${input.verificationDiagnosis.sourceAnchors.map((anchor) => `${anchor.path} (${anchor.location}): ${anchor.evidence}`).join("\n")}`,
            `Reproducer: ${input.verificationDiagnosis.reproducer}`,
            `Failure signature mapping: ${typeof input.verificationDiagnosis.failureSignatureMapping === "string"
              ? input.verificationDiagnosis.failureSignatureMapping
              : input.verificationDiagnosis.failureSignatureMapping.map(({ signatureId, mapping }) => `${signatureId}: ${mapping}`).join("\n")}`,
            `Rejected previous hypotheses:\n${input.verificationDiagnosis.rejectedPreviousHypotheses.join("\n") || "(none)"}`,
            `Minimal fix guidance: ${input.verificationDiagnosis.minimalFixGuidance}`,
          ] : []),
        ] : []),
        "Do not expand scope or perform unrelated cleanup. If the packet omits a required integration path, report the packet gap instead of silently widening the change.",
        "Prefer the smallest complete integration change: preserve existing public shapes, serialization, error/cancellation, concurrency, and repository conventions unless the frozen criteria explicitly require changing them.",
        ...(input.verification?.length ? [
          `Typed verification feedback is available only for these frozen command IDs: ${input.verification.map((command) => `${command.id}=${command.command} ${command.args.join(" ")}`).join("; ")}.`,
        ] : []),
        "Use the pure compute tool when a criterion requires hashes, canonical JSON, base64url, or an Ed25519 test vector; never invent cryptographic fixture values.",
        "Do not invoke GitHub, alter workflow state, commit, push, merge, or close issues.",
        "Use the typed verify tool for implementation feedback when a frozen command is relevant. The controller independently reruns every verification command and owns git publication; your check result is feedback, not controller evidence.",
        "For criterionCoverage, assign stable IDs criterion-1, criterion-2, and so on in the exact order of the Build Packet acceptanceCriteria; copy every criterion verbatim into the criterion field, preserving punctuation and wording exactly; do not paraphrase, rename, split, or merge criteria. Include exactly one coverage entry for each criterion.",
        "Every criterionCoverage entry must include typed anchors: concrete repository paths, stable implementation symbols, stable test/invariant-matrix IDs, and the relevant frozen verification command IDs. Prose implementation notes remain readable but cannot authorize a pass. Use only command IDs actually relevant to that criterion; generic green checks cannot substitute for missing symbol/test evidence.",
        ...(input.packet.payload.evidenceContract?.version === "forgedock.evidence/v1" ? [
          `Evidence contract v1 (controller-frozen, compact): ${input.packet.payload.evidenceContract.criteria.map((criterion) => `${criterion.criterionId}{writePaths=${criterion.allowedWritePaths.join(",") || "none"}; evidenceOnlyPaths=${criterion.allowedEvidencePaths.join(",") || "none"}; commands=${criterion.requiredCommandIds.join(",") || "none"}; semantic=${criterion.semanticCommandIds.join(",") || "none"}; gates=${criterion.controllerGateIds.join(",") || "none"}; invariantRows=${criterion.invariantRowIds.join(",") || "none"}; invariantTests=${criterion.invariantTestIds.join(",") || "none"}}`).join(" | ")}`,
          "Evidence-only paths are read-only: inspect them for evidence, but never modify them and never report them as changed paths unless they are also frozen expected write paths.",
          "For invariant matrices, preserve each controller-frozen root test ID in anchors; row IDs are controller context only. Do not echo or invent expanded matrix case IDs; the controller adds those IDs only after the exact semantic command passes.",
          "Use only the exact required and semantic command IDs and controller gate IDs listed for each criterion; generic commands cannot prove command-backed criteria. Controller gates may supplement semantic command evidence but cannot replace it.",
        ] : []),
        ...(input.packet.payload.evidenceContract?.version !== "forgedock.evidence/v1" && input.packet.payload.invariantMatrices?.length ? [
          `Security-sensitive acceptance matrices are controller-derived and must be exercised where applicable: ${input.packet.payload.invariantMatrices.map((row) => `${row.id} (${row.criterionId}, testId=${row.testId})`).join("; ")}. Preserve their row/test IDs in focused tests and criterion anchors.`,
        ] : []),
        ...(input.packet.payload.evidenceContract?.version !== "forgedock.evidence/v1" && input.packet.payload.verificationRequirements?.length ? [
          `Use the exact frozen verification command IDs required by each criterion: ${input.packet.payload.verificationRequirements.filter((requirement) => requirement.kind === "command").map((requirement) => `${requirement.id}=>${requirement.criterionIds.join(",")}`).join("; ") || "(none)"}.`,
        ] : []),
        "Before submitting, self-review the complete diff against every criterion and integration boundary: check callers, implementations, adapters, serialization, error/cancellation/concurrency paths, tests, and docs/configuration that the packet identifies. Do not mark a criterion covered from intent alone; cite concrete code, test, or verification evidence.",
        "Run the narrowest relevant frozen verification commands after editing, then re-read changed files for malformed edits, whitespace damage, and accidental mechanical churn.",
        "Report the complete delivery revision relative to its frozen base, including retained committed paths from earlier build or remediation cycles; the controller rejects incomplete or mismatched path and criterion reports.",
      ].join("\n"),
      context: [
        input.intent,
        input.investigation,
        input.packet,
        ...(input.repairContext ?? []),
        ...(input.priorVerificationFailure ? [input.priorVerificationFailure] : []),
      ],
      workspace: {
        cwd: input.worktree,
        mode: "write",
        scope: scopeManifestForBuildPacket(
          input.packet.payload.expectedPaths,
          input.packet.payload.evidenceContract?.version === "forgedock.evidence/v1"
            ? (input.packet.payload.evidencePaths ?? []).map(({ path }) => path)
            : [],
        ),
      },
      tools: ["read", "grep", "find", "ls", "compute", ...(input.verification?.length && (input.verificationRunner ?? dependencies.verifier) ? ["verify" as const] : []), "edit", "write"],
      ...(input.verification?.length && (input.verificationRunner ?? dependencies.verifier) ? {
        verification: { commands: input.verification, runner: input.verificationRunner ?? dependencies.verifier! },
      } : {}),
      outputSchema: BuilderSubmissionSchema,
      executionBudget: WORK_ON_EXECUTION_BUDGETS.builder,
      modelPolicy: {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      },
    }, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(dependencies.onAgentEvent !== undefined ? { onEvent: dependencies.onAgentEvent } : {}),
    });
    const advanced = transition(run, "BUILD_COMPLETED");
    await dependencies.runs.commit(run.version, advanced.state, advanced.record);
    return { run: advanced.state, submission: result.output, sessionRef: result.sessionRef };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (isRecoverableAgentExecutionError(error)) {
      const checkpoint = transition(run, "RESUME_BUILD", { reason });
      await dependencies.runs.commit(run.version, checkpoint.state, checkpoint.record);
      throw new WorkflowExecutionError(reason, checkpoint.state, { cause: error, recoverable: true });
    }
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}
