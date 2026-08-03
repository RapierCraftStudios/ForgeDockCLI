// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DurableArtifact } from "../../core/artifacts/schema.js";
import type { RunRepository } from "../../core/ports/repositories.js";
import { transition, type RunState } from "../../core/state/machine.js";
import type { AgentEventSink, AgentRuntime } from "../../runtime/agent-runtime.js";
import { BuilderSubmissionSchema, type BuilderSubmission } from "./build.js";
import { WorkflowExecutionError } from "./investigate.js";

export async function remediateReview(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    packet: DurableArtifact<"BuildPacket">;
    buildResult: DurableArtifact<"BuildResult">;
    verdict: DurableArtifact<"ReviewVerdict">;
    worktree: string;
    provider?: string;
    model?: string;
    signal?: AbortSignal;
  },
  dependencies: { runtime: AgentRuntime; runs: RunRepository; onAgentEvent?: AgentEventSink },
): Promise<{ run: RunState; submission: BuilderSubmission; sessionRef: string }> {
  if (input.run.state !== "remediating") throw new Error(`Remediation requires remediating state, found ${input.run.state}`);
  const findings = input.verdict.payload.findings.filter((finding) => finding.blocking);
  if (!findings.length) throw new Error("Remediation requires at least one controller-accepted blocking finding");
  let run = input.run;
  try {
    const result = await dependencies.runtime.run<BuilderSubmission>({
      id: `${run.runId}:remediate:${input.verdict.payload.headSha}:${run.attempt}`,
      role: "remediator",
      objective: `Fix only the accepted blocking findings from review of ${input.verdict.payload.headSha}:\n${JSON.stringify(findings, null, 2)}`,
      instructions: [
        "Do not address rejected, non-blocking, speculative, or unrelated cleanup.",
        "Do not invoke GitHub, commit, push, merge, or alter workflow state.",
        "The controller will re-run all required verification and start a fresh review at the new SHA.",
      ].join("\n"),
      context: [input.intent, input.investigation, input.packet, input.buildResult, input.verdict],
      workspace: { cwd: input.worktree, mode: "write" },
      tools: ["read", "grep", "find", "ls", "edit", "write"],
      outputSchema: BuilderSubmissionSchema,
      modelPolicy: {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      },
    }, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(dependencies.onAgentEvent !== undefined ? { onEvent: dependencies.onAgentEvent } : {}),
    });
    const advanced = transition(run, "REMEDIATION_COMPLETED");
    await dependencies.runs.commit(run.version, advanced.state, advanced.record);
    return { run: advanced.state, submission: result.output, sessionRef: result.sessionRef };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}
