// SPDX-License-Identifier: AGPL-3.0-or-later

import { Type, type Static } from "typebox";
import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import type { VerificationCommand, VerificationRunner } from "../../core/ports/verification.js";
import { transition, type RunState } from "../../core/state/machine.js";
import { scopeManifestForBuildPacket, type AgentEventSink, type AgentRuntime, type ScopeHints } from "../../runtime/agent-runtime.js";
import { WorkflowExecutionError } from "./investigate.js";

export const BuilderSubmissionSchema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  changedPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  criterionCoverage: Type.Array(Type.Object({
    criterionId: Type.Optional(Type.String({ pattern: "^criterion-[1-9][0-9]*$" })),
    criterion: Type.String({ minLength: 1 }),
    implementation: Type.String({ minLength: 1 }),
  })),
  decisions: Type.Array(Type.String()),
  residualRisks: Type.Array(Type.String()),
});
export type BuilderSubmission = Static<typeof BuilderSubmissionSchema>;

export async function buildWorkItem(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    scopeHints?: ScopeHints;
    priorVerificationFailure?: DurableArtifact<"Outcome">;
    repairContext?: readonly DurableArtifact[];
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
        "Turn the Build Packet into a criterion-by-criterion implementation checklist before making changes. For every criterion, identify the invariant, all relevant callers/implementations/adapters, and the regression scenario that must remain true.",
        ...(input.priorVerificationFailure ? [
          "This is a bounded repair of the retained implementation. Use the controller-recorded failed checks as evidence and change only frozen Build Packet paths.",
        ] : []),
        "Do not expand scope or perform unrelated cleanup. If the packet omits a required integration path, report the packet gap instead of silently widening the change.",
        "Prefer the smallest complete integration change: preserve existing public shapes, serialization, error/cancellation, concurrency, and repository conventions unless the frozen criteria explicitly require changing them.",
        ...(input.verification?.length ? [
          `Typed verification feedback is available only for these frozen command IDs: ${input.verification.map((command) => `${command.id}=${command.command} ${command.args.join(" ")}`).join("; ")}.`,
        ] : []),
        "Use the pure compute tool when a criterion requires hashes, canonical JSON, base64url, or an Ed25519 test vector; never invent cryptographic fixture values.",
        "Do not invoke GitHub, alter workflow state, commit, push, merge, or close issues.",
        "Use the typed verify tool for implementation feedback when a frozen command is relevant. The controller independently reruns every verification command and owns git publication; your check result is feedback, not controller evidence.",
        "For criterionCoverage, assign stable IDs criterion-1, criterion-2, and so on in the exact order of the Build Packet acceptanceCriteria; copy every criterion verbatim into the criterion field, preserving punctuation and wording exactly; do not paraphrase, rename, split, or merge criteria. Include exactly one coverage entry for each criterion and use implementation only for the concrete evidence.",
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
        scope: scopeManifestForBuildPacket(input.packet.payload.expectedPaths),
      },
      tools: ["read", "grep", "find", "ls", "compute", ...(input.verification?.length && (input.verificationRunner ?? dependencies.verifier) ? ["verify" as const] : []), "edit", "write"],
      ...(input.verification?.length && (input.verificationRunner ?? dependencies.verifier) ? {
        verification: { commands: input.verification, runner: input.verificationRunner ?? dependencies.verifier! },
      } : {}),
      outputSchema: BuilderSubmissionSchema,
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
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}
