// SPDX-License-Identifier: AGPL-3.0-or-later

import { BuildPacketPayloadSchema, createArtifact, type BuildPacketPayload, type ControllerVerificationGate, type DurableArtifact, type VerificationRequirement } from "../../core/artifacts/schema.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { VerificationCommand } from "../../core/ports/verification.js";
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

export interface VerificationCatalog {
  commands: readonly Pick<VerificationCommand, "id" | "command" | "args">[];
  controllerGates: readonly ControllerVerificationGate[];
}

export const CONTROLLER_VERIFICATION_GATES: readonly ControllerVerificationGate[] = [
  { id: "staging-review", description: "Controller validates the implementation and regression evidence on staging." },
  { id: "workflow-lifecycle", description: "Controller completes the independent workflow lifecycle and authoritative closure." },
  { id: "review-aggregation", description: "Controller aggregates independent review evidence." },
  { id: "publication", description: "Controller publishes the exact verified revision and pull request." },
  { id: "merge-closure", description: "Controller merges the reviewed SHA and verifies issue closure." },
];

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
    verificationCatalog?: VerificationCatalog;
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
        "Map verificationPlan to the acceptance criteria through typed verificationRequirements. Each requirement must use exactly one allowed command ID or controller-gate ID from the supplied catalog, include one or more criterion-N IDs, and explain its rationale. Do not invent command IDs or shell strings.",
        "The legacy verificationPlan field is retained only for compatibility; emit one exact controller-gate:<id> token or one fenced executable command per typed requirement. Never encode controller-owned lifecycle evidence as prose.",
        "Allowed command IDs and controller gate IDs are supplied below. Unknown IDs, unfenced executable prose, and requirements that do not cover every acceptance criterion are rejected before the builder starts.",
        `Verification catalog: ${JSON.stringify(input.verificationCatalog ?? { commands: [], controllerGates: CONTROLLER_VERIFICATION_GATES })}`,
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
    const verifiedOutput = input.verificationCatalog && (
      input.verificationCatalog.commands.length > 0
      || Boolean(result.output.verificationRequirements?.length)
    )
      ? canonicalizePacketVerification(result.output, input.verificationCatalog)
      : result.output;
    const packet = createArtifact({
      kind: "BuildPacket",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "packet-author", runtime: "pi-compatible", provider: result.provider, model: result.model },
      payload: { ...verifiedOutput, expectedPaths },
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

function canonicalizePacketVerification(
  output: BuildPacketPayload,
  catalog: VerificationCatalog,
): BuildPacketPayload {
  const commandById = new Map(catalog.commands.map((command) => [command.id, command]));
  const gateById = new Map(catalog.controllerGates.map((gate) => [gate.id, gate]));
  const criterionIds = output.acceptanceCriteria.map((_, index) => `criterion-${index + 1}`);
  const requirements: VerificationRequirement[] = output.verificationRequirements?.length
    ? output.verificationRequirements.map((requirement) => {
      if (!requirement.criterionIds.every((id) => criterionIds.includes(id))) {
        throw new Error(`Build Packet verification requirement ${requirement.id} references an unknown acceptance criterion`);
      }
      if (requirement.kind === "command" && !commandById.has(requirement.id)) {
        throw new Error(`Build Packet verification requirement references unknown command ID '${requirement.id}'`);
      }
      if (requirement.kind === "controller-gate") {
        const gateId = requirement.id as ControllerVerificationGate["id"];
        if (!gateById.has(gateId)) {
          throw new Error(`Build Packet verification requirement references unknown controller gate ID '${requirement.id}'`);
        }
      }
      return {
        kind: requirement.kind,
        id: requirement.id,
        criterionIds: [...new Set(requirement.criterionIds)],
        rationale: requirement.rationale,
      };
    })
    : output.verificationPlan.map((entry) => {
      const gate = /^controller-gate:([a-z0-9-]+)$/i.exec(entry.trim());
      const gateId = gate?.[1] as ControllerVerificationGate["id"] | undefined;
      if (gateId && gateById.has(gateId)) {
        return { kind: "controller-gate" as const, id: gateId, criterionIds, rationale: "Legacy controller gate canonicalized before dispatch." };
      }
      const command = matchLegacyCommand(entry, catalog.commands);
      if (!command) {
        throw new Error(`Build Packet verification plan contains unsupported or unfenced controller prose: ${entry}`);
      }
      return { kind: "command" as const, id: command.id, criterionIds, rationale: "Legacy executable requirement canonicalized before dispatch." };
    });

  const covered = new Set(requirements.flatMap((requirement) => requirement.criterionIds));
  const missing = criterionIds.filter((id) => !covered.has(id));
  if (missing.length) throw new Error(`Build Packet verification requirements do not cover ${missing.join(", ")}`);
  const canonicalGates = new Map((output.controllerGates ?? []).map((gate) => [gate.id, gate]));
  for (const requirement of requirements) {
    if (requirement.kind === "controller-gate") {
      const gateId = requirement.id as ControllerVerificationGate["id"];
      canonicalGates.set(gateId, gateById.get(gateId)!);
    }
  }
  return {
    ...output,
    verificationPlan: requirements.map((requirement) => {
      if (requirement.kind === "controller-gate") return `controller-gate:${requirement.id}`;
      const command = commandById.get(requirement.id)!;
      return `\`${[command.command, ...command.args].join(" ")}\``;
    }),
    verificationRequirements: requirements,
    ...(canonicalGates.size ? { controllerGates: [...canonicalGates.values()] } : {}),
  };
}

function matchLegacyCommand(
  entry: string,
  commands: VerificationCatalog["commands"],
): Pick<VerificationCommand, "id" | "command" | "args"> | undefined {
  const normalizedEntry = entry.trim().toLowerCase();
  const exactCommand = commands.find((command) => {
    const invocation = [command.command, ...command.args].join(" ").trim().toLowerCase();
    return normalizedEntry === command.id.toLowerCase() || normalizedEntry === invocation;
  });
  if (exactCommand) return exactCommand;
  const fenced = [...entry.matchAll(/`([^`]+)`/g)].map((match) => match[1]?.trim().toLowerCase()).filter((value): value is string => Boolean(value));
  if (!fenced.length) return undefined;
  return commands.find((command) => fenced.some((value) => {
    if (command.id === "diff-check") return value.includes("git diff --check");
    const script = command.args.at(-1)?.toLowerCase();
    return value.includes(command.id.toLowerCase()) || (script !== undefined && value.includes(script));
  }));
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
