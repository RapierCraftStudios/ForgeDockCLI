// SPDX-License-Identifier: AGPL-3.0-or-later

import { Type, type Static } from "typebox";
import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import { transition, type RunState } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime } from "../../runtime/agent-runtime.js";
import { WorkflowExecutionError } from "./investigate.js";

export const BuilderSubmissionSchema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  changedPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  criterionCoverage: Type.Array(Type.Object({
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
    worktree: string;
    provider?: string;
    model?: string;
    signal?: AbortSignal;
  },
  dependencies: { runtime: AgentRuntime; runs: RunRepository; onAgentEvent?: AgentEventSink },
): Promise<{ run: RunState; submission: BuilderSubmission; sessionRef: string }> {
  if (input.run.state !== "building") throw new Error(`Build requires building state, found ${input.run.state}`);
  let run = input.run;
  try {
    const result = await dependencies.runtime.run<BuilderSubmission>({
      id: `${run.runId}:build:${run.attempt}`,
      role: "builder",
      objective: "Implement exactly the accepted Build Packet in the assigned worktree.",
      instructions: [
        "Read the affected code before editing.",
        "Do not expand scope or perform unrelated cleanup.",
        "Use the pure compute tool when a criterion requires hashes, canonical JSON, base64url, or an Ed25519 test vector; never invent cryptographic fixture values.",
        "Do not invoke GitHub, alter workflow state, commit, push, merge, or close issues.",
        "The controller runs verification and owns git publication after your edits.",
        "Report paths and criterion coverage accurately; the controller will independently inspect the diff.",
      ].join("\n"),
      context: [input.intent, input.investigation, input.packet],
      workspace: { cwd: input.worktree, mode: "write" },
      tools: ["read", "grep", "find", "ls", "compute", "edit", "write"],
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
