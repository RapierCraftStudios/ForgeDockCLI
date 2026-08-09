// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact, InvestigationPayloadSchema, type DurableArtifact, type InvestigationPayload } from "../../core/artifacts/schema.js";
import type { ForgeHost } from "../../core/ports/forge-host.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, createRun, transition, type RunState, type RunTarget, type TransitionEvent } from "../../core/state/machine.js";
import {
  scopeDiscoveryRoots,
  scopeManifestFor,
  STANDARD_SCOPE_METADATA_ROOTS,
  type AgentEventSink,
  type AgentRuntime,
  type ScopeHints,
} from "../../runtime/agent-runtime.js";

export interface InvestigateDependencies {
  runtime: AgentRuntime;
  artifacts: ArtifactRepository;
  runs: RunRepository;
  decomposer?: Pick<ForgeHost, "materializeDecomposition">;
  onAgentEvent?: AgentEventSink;
}

export interface InvestigateInput {
  intent: DurableArtifact<"Intent">;
  priorArtifacts?: readonly DurableArtifact[];
  cwd: string;
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  target?: RunTarget;
  scopeHints?: ScopeHints;
  signal?: AbortSignal;
}

export interface InvestigateResult {
  run: RunState;
  investigation: DurableArtifact<"Investigation">;
  outcome?: DurableArtifact<"Outcome">;
  sessionRef: string;
}

export async function investigateWorkItem(
  input: InvestigateInput,
  dependencies: InvestigateDependencies,
): Promise<InvestigateResult> {
  const scopeHints = input.scopeHints ?? {};
  const affectedFiles = scopeHints.affectedFiles ?? [];
  const scopeManifest = scopeManifestFor("issue-hints", {
    ...scopeHints,
    metadataRoots: [
      ...STANDARD_SCOPE_METADATA_ROOTS,
      ...(scopeHints.metadataRoots ?? []),
      ...scopeDiscoveryRoots(affectedFiles),
    ],
  });
  let run = createRun({
    workflow: "work-on",
    subject: input.intent.subject,
    runId: input.intent.runId,
    ...(input.target ? { target: input.target } : {}),
    scopeManifest,
  });
  run = attachArtifact(run, "Intent", input.intent.id);
  await dependencies.artifacts.append(input.intent);
  await dependencies.runs.create(run);
  run = await applyTransition(dependencies.runs, run, "START_INVESTIGATION");

  try {
    const modelPolicy = {
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
    };
    const agentResult = await dependencies.runtime.run<InvestigationPayload>({
      id: `${run.runId}:investigation:${run.attempt}`,
      role: "investigator",
      objective: "Determine whether the issue is confirmed, invalid, or must be decomposed. Prove the result from repository evidence before any code is changed.",
      instructions: [
        "Inspect the relevant implementation and tests before deciding.",
        "Every evidence item must identify a concrete repository source such as a path, symbol, test, or command result.",
        "Choose invalid only when positive repository or issue evidence proves the claim is already fixed, superseded, unreproducible, or contradicted; an enhancement/refactor with missing implementation is confirmed, not invalid.",
        "Absence of a matching implementation or test is evidence that a requested change may be needed, never sufficient evidence that the issue is invalid. Describe the missing contract as the root cause when the request is confirmed.",
        "Choose decompose only when independently deliverable outcomes need separate acceptance and review.",
        "Do not modify files or perform GitHub writes.",
      ].join("\n"),
      context: [input.intent, ...(input.priorArtifacts ?? [])],
      workspace: {
        cwd: input.cwd,
        mode: "read-only",
        scope: scopeManifest,
      },
      tools: ["read", "grep", "find", "ls"],
      outputSchema: InvestigationPayloadSchema,
      modelPolicy,
    }, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(dependencies.onAgentEvent !== undefined ? { onEvent: dependencies.onAgentEvent } : {}),
    });

    enforceInvestigationSemantics(agentResult.output);
    const investigation = createArtifact({
      kind: "Investigation",
      runId: run.runId,
      subject: run.subject,
      producer: {
        role: "investigator",
        runtime: "pi-compatible",
        provider: agentResult.provider,
        model: agentResult.model,
      },
      payload: agentResult.output,
    });
    await dependencies.artifacts.append(investigation);
    run = attachArtifact(run, "Investigation", investigation.id);

    let outcome: DurableArtifact<"Outcome"> | undefined;
    if (agentResult.output.outcome !== "confirmed") {
      if (agentResult.output.outcome === "decompose" && !dependencies.decomposer) {
        throw new Error("Decomposition requires a controller issue materializer");
      }
      const childIssues = agentResult.output.outcome === "decompose"
        ? (await dependencies.decomposer!.materializeDecomposition({
          repo: run.subject.repo,
          parentIssue: run.subject.issue ?? (() => { throw new Error("Decomposition requires an issue subject"); })(),
          children: agentResult.output.decomposition ?? [],
        })).map((issue) => `#${issue.number} — ${issue.title} (${issue.url})`)
        : [];
      outcome = createArtifact({
        kind: "Outcome",
        runId: run.runId,
        subject: run.subject,
        producer: { role: "controller", runtime: "forgedock" },
        payload: {
          status: agentResult.output.outcome === "invalid" ? "invalid" : "decomposed",
          reason: agentResult.output.summary,
          childIssues,
        },
      });
      await dependencies.artifacts.append(outcome);
      run = attachArtifact(run, "Outcome", outcome.id);
    }

    const event: TransitionEvent = agentResult.output.outcome === "confirmed"
      ? "INVESTIGATION_CONFIRMED"
      : agentResult.output.outcome === "invalid"
        ? "INVESTIGATION_INVALID"
        : "INVESTIGATION_DECOMPOSED";
    run = await applyTransition(dependencies.runs, run, event, agentResult.output.summary);
    return {
      run,
      investigation,
      ...(outcome !== undefined ? { outcome } : {}),
      sessionRef: agentResult.sessionRef,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    run = await applyTransition(dependencies.runs, run, "FAIL", reason);
    throw new WorkflowExecutionError(reason, run, { cause: error });
  }
}

async function applyTransition(
  repository: RunRepository,
  current: RunState,
  event: TransitionEvent,
  reason?: string,
): Promise<RunState> {
  const result = transition(current, event, reason !== undefined ? { reason } : {});
  await repository.commit(current.version, result.state, result.record);
  return result.state;
}

function enforceInvestigationSemantics(payload: InvestigationPayload): void {
  if (payload.outcome === "decompose" && (!payload.decomposition || payload.decomposition.length < 2)) {
    throw new Error("A decomposed investigation must propose at least two child intents");
  }
  if (payload.outcome === "confirmed" && !payload.rootCause) {
    throw new Error("A confirmed investigation must state a root cause");
  }
}

export class WorkflowExecutionError extends Error {
  constructor(message: string, readonly run: RunState, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkflowExecutionError";
  }
}
