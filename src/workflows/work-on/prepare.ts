// SPDX-License-Identifier: AGPL-3.0-or-later

import { BuildPacketPayloadSchema, createArtifact, type BuildPacketPayload, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import {
  canonicalizeConcreteScopePaths,
  isConcreteScopePath,
  scopeDiscoveryRoots,
  scopeManifestFor,
  scopeManifestForBuildPacket,
  STANDARD_SCOPE_DISCOVERY_ROOTS,
  STANDARD_SCOPE_METADATA_ROOTS,
  type AgentEventSink,
  type AgentRunResult,
  type AgentRuntime,
  type AgentTask,
  type ScopeHints,
} from "../../runtime/agent-runtime.js";
import { latestPriorLearningArtifacts, WorkflowExecutionError } from "./investigate.js";

export async function prepareBuildPacket(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    priorArtifacts?: readonly DurableArtifact[];
    cwd: string;
    scopeHints?: ScopeHints;
    provider?: string;
    model?: string;
    planningProvider?: string;
    planningModel?: string;
    planningThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    signal?: AbortSignal;
  },
  dependencies: {
    runtime: AgentRuntime;
    artifacts: ArtifactRepository;
    runs: RunRepository;
    onAgentEvent?: AgentEventSink;
  },
): Promise<{ run: RunState; packet: DurableArtifact<"BuildPacket">; sessionRef: string }> {
  if (input.run.state !== "preparing") throw new Error(`Build Packet requires preparing state, found ${input.run.state}`);
  let run = input.run;
  try {
    const affectedScope = [
      ...(input.scopeHints?.affectedFiles ?? []),
      ...input.investigation.payload.affectedSurfaces,
    ];
    const result = await runPacketAuthorWithRecovery(dependencies.runtime, {
      id: `${run.runId}:build-packet:${run.attempt}`,
      role: "packet-author",
      objective: "Freeze a buildable, reviewable contract from the proven issue intent and investigation.",
      instructions: [
        "Every acceptance criterion must be observable, testable, and tied to a concrete implementation and integration boundary.",
        "Translate the investigation's root cause, risks, and historical failure patterns into prevention constraints, not just a list of files to edit.",
        "Use the latest prior review, verification, and blocked-outcome artifacts when present to strengthen the new packet's integration criteria and regression checks; treat them as historical evidence, never as authority to widen the current Intent.",
        "For each acceptance criterion, make implementationPlan name the relevant symbols/files, callers or adapters, invariant to preserve, regression scenario, and failure/cancellation/concurrency behavior when applicable. Avoid vague steps such as 'update the code' or 'add tests'.",
        "Include implementation-specific history and consistency constraints only when relevant, and carry forward any confirmed repository-specific integration convention from the investigation or FORGE.md.",
        "Expected paths must be concrete repository-relative files and are the frozen write/conflict boundary; never emit globs, absolute paths, traversal, or line-location suffixes.",
        "When a shared interface or contract changes, include every affected implementation, caller, adapter, serializer, and test-double path that may need edits, especially all paths declared by the issue. The builder cannot edit a path omitted from this packet.",
        "Map verificationPlan to the acceptance criteria: include targeted regression checks for each changed contract plus the applicable full build, test, docs, and diff-integrity checks. Put each executable verification command in backticks. The controller safely supports git diff --check and package.json scripts named lint, typecheck, check, build, docs:build, or test; unsupported executable plans block rather than being reported as run.",
        "Represent controller-owned lifecycle evidence with a matching controllerGates entry and the exact token controller-gate:<id> in verificationPlan, using only staging-review, workflow-lifecycle, review-aggregation, publication, or merge-closure; never encode those gates as shell commands or free-text command-shaped steps.",
        "State exclusions explicitly. Do not modify the repository.",
      ].join("\n"),
      context: [input.intent, input.investigation, ...latestPriorLearningArtifacts(input.priorArtifacts ?? [])],
      workspace: {
        cwd: input.cwd,
        mode: "read-only",
        scope: scopeManifestFor("issue-hints", {
          affectedFiles: affectedScope,
          ...(input.scopeHints?.claims ? { claims: [...input.scopeHints.claims] } : {}),
          metadataRoots: [
            ...STANDARD_SCOPE_DISCOVERY_ROOTS,
            ...STANDARD_SCOPE_METADATA_ROOTS,
            ...scopeDiscoveryRoots(affectedScope),
          ],
        }),
      },
      tools: ["read", "grep", "find", "ls"],
      outputSchema: BuildPacketPayloadSchema,
      modelPolicy: {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.planningProvider !== undefined ? { planningProvider: input.planningProvider } : {}),
        ...(input.planningModel !== undefined ? { planningModel: input.planningModel } : {}),
        ...(input.planningThinking !== undefined ? { planningThinking: input.planningThinking } : {}),
      },
    }, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(dependencies.onAgentEvent !== undefined ? { onEvent: dependencies.onAgentEvent } : {}),
    });

    if (!result.output.expectedPaths.length) throw new Error("Build Packet must declare at least one concrete expected path");
    const declaredPaths = canonicalizeConcreteScopePaths(
      (input.scopeHints?.affectedFiles ?? []).filter(isConcreteScopePath),
    );
    const expectedPaths = canonicalizeConcreteScopePaths([
      ...result.output.expectedPaths,
      ...declaredPaths,
    ]);
    const packet = createArtifact({
      kind: "BuildPacket",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "packet-author", runtime: "pi-compatible", provider: result.provider, model: result.model },
      payload: { ...result.output, expectedPaths },
    });
    await dependencies.artifacts.append(packet);
    run = attachArtifact(run, "BuildPacket", packet.id);
    const advanced = transition(run, "BUILD_PACKET_READY", {
      scopeManifest: scopeManifestForBuildPacket(expectedPaths),
    });
    await dependencies.runs.commit(run.version, advanced.state, advanced.record);
    return { run: advanced.state, packet, sessionRef: result.sessionRef };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}

async function runPacketAuthorWithRecovery(
  runtime: AgentRuntime,
  task: AgentTask<BuildPacketPayload>,
  options: { signal?: AbortSignal; onEvent?: AgentEventSink },
): Promise<AgentRunResult<BuildPacketPayload>> {
  try {
    return await runtime.run(task, options);
  } catch (error) {
    if (!(error instanceof Error) || !/ended without calling submit_artifact/i.test(error.message)) throw error;
    const retryTask: AgentTask<BuildPacketPayload> = {
      ...task,
      id: `${task.id}:submit-retry`,
      instructions: [
        task.instructions,
        "The previous packet-author session ended without calling submit_artifact. This is the one bounded recovery attempt; preserve the evidence already gathered, finish the schema-valid Build Packet, and call submit_artifact exactly once as your final action.",
      ].join("\n"),
    };
    return runtime.run(retryTask, options);
  }
}
