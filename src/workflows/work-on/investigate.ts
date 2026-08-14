// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import {
  createArtifact,
  InvestigationPayloadSchema,
  type DurableArtifact,
  type InvestigationPayload,
  type Subject,
} from "../../core/artifacts/schema.js";
import type { ForgeHost } from "../../core/ports/forge-host.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, createRun, transition, type RunState, type RunTarget, type TransitionEvent } from "../../core/state/machine.js";
import {
  scopeDiscoveryRoots,
  scopeManifestFor,
  STANDARD_SCOPE_DISCOVERY_ROOTS,
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
  planningProvider?: string;
  planningModel?: string;
  planningThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  target?: RunTarget;
  scopeHints?: ScopeHints;
  signal?: AbortSignal;
}

export interface ResumeInvestigateInput extends InvestigateInput {
  run: RunState;
  /** A durable Investigation proves the agent phase completed before a crash. */
  investigation?: DurableArtifact<"Investigation">;
}

const PRIOR_LEARNING_KINDS = new Set<DurableArtifact["kind"]>([
  "Investigation", "BuildPacket", "BuildResult", "ReviewVerdict", "Outcome", "RemediationBlocked", "VerificationAdjudication",
]);

/**
 * Keep the investigator's historical feedback focused on the newest durable
 * evidence for each phase. The full artifact ledger remains authoritative;
 * this projection prevents old repair waves from crowding out current code.
 */
export function latestPriorLearningArtifacts(artifacts: readonly DurableArtifact[]): DurableArtifact[] {
  const latest = new Map<DurableArtifact["kind"], { artifact: DurableArtifact; index: number }>();
  for (const [index, artifact] of artifacts.entries()) {
    if (PRIOR_LEARNING_KINDS.has(artifact.kind)) latest.set(artifact.kind, { artifact, index });
  }
  return [...latest.values()].sort((left, right) => left.index - right.index).map(({ artifact }) => artifact);
}

export interface InvestigateResult {
  run: RunState;
  investigation: DurableArtifact<"Investigation">;
  outcome?: DurableArtifact<"Outcome">;
  sessionRef: string;
}

/**
 * Terminal controller artifacts keep the same identity when a durable host
 * write succeeds but the caller loses the response. The semantic checkpoint
 * deliberately excludes clocks and attempt numbers.
 */
export function deterministicOutcomeId(
  runId: string,
  subject: Subject,
  checkpoint: string,
): string {
  const identity = [
    "forgedock.outcome/v1",
    runId,
    subject.repo.toLowerCase(),
    subject.issue?.toString() ?? "",
    subject.pr?.toString() ?? "",
    checkpoint,
  ].join("\0");
  return `art_outcome_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

export async function investigateWorkItem(
  input: InvestigateInput,
  dependencies: InvestigateDependencies,
): Promise<InvestigateResult> {
  const scopeManifest = investigationScopeManifest(input.scopeHints);
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
  return continueInvestigation(input, dependencies, run, scopeManifest);
}

/**
 * Continue an early work-on checkpoint without replaying completed semantic
 * work. Intent-only recovery dispatches the investigator once. When a durable
 * Investigation is supplied, the agent is skipped and only controller-side
 * materialization and the state transition are completed.
 */
export async function resumeInvestigationWorkItem(
  input: ResumeInvestigateInput,
  dependencies: InvestigateDependencies,
): Promise<InvestigateResult> {
  if (input.run.workflow !== "work-on") {
    throw new Error(`Investigation recovery requires a work-on run, found ${input.run.workflow}`);
  }
  if (input.run.runId !== input.intent.runId) {
    throw new Error(`Investigation recovery run ${input.run.runId} does not match Intent ${input.intent.runId}`);
  }
  if (!sameSubject(input.run.subject, input.intent.subject)) {
    throw new Error("Investigation recovery Intent does not match the durable run subject");
  }
  if (input.run.state !== "investigating") {
    throw new Error(`Investigation recovery requires investigating state, found ${input.run.state}`);
  }
  if (input.investigation) {
    assertInvestigationMatches(input.run, input.investigation);
    enforceInvestigationSemantics(input.investigation.payload);
  }

  const scopeManifest = input.run.scopeManifest ?? investigationScopeManifest(input.scopeHints);
  const run = attachArtifact({ ...input.run, scopeManifest }, "Intent", input.intent.id);
  return continueInvestigation(input, dependencies, run, scopeManifest, input.investigation);
}

async function continueInvestigation(
  input: InvestigateInput,
  dependencies: InvestigateDependencies,
  initialRun: RunState,
  scopeManifest: NonNullable<RunState["scopeManifest"]>,
  durableInvestigation?: DurableArtifact<"Investigation">,
): Promise<InvestigateResult> {
  let run = initialRun;
  try {
    let investigation = durableInvestigation;
    let sessionRef = durableInvestigation ? `durable:${durableInvestigation.id}` : undefined;
    if (!investigation) {
      const modelPolicy = {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(input.planningProvider !== undefined ? { planningProvider: input.planningProvider } : {}),
        ...(input.planningModel !== undefined ? { planningModel: input.planningModel } : {}),
        ...(input.planningThinking !== undefined ? { planningThinking: input.planningThinking } : {}),
      };
      const agentResult = await dependencies.runtime.run<InvestigationPayload>({
        id: `${run.runId}:investigation:${run.attempt}`,
        role: "investigator",
        objective: "Determine whether the issue is confirmed, invalid, or must be decomposed. Prove the result from repository evidence before any code is changed.",
        instructions: [
          "Inspect the relevant implementation, integration boundaries, and tests before deciding.",
          "Trace the reported behavior through its callers, implementations, adapters, persistence/serialization, error and cancellation paths, and existing regression tests; do not stop at the first matching function.",
          "Every evidence item must identify a concrete repository source such as a path, symbol, test, or command result.",
          "State the observable contract, the failure mode that violates it, and the smallest repository surfaces that must change to restore it.",
          "When prior durable artifacts are present, mine prior ReviewVerdict findings, verification failures, and blocked Outcomes for repeated mechanical or integration failure patterns. Treat them as historical evidence only, distinguish stale or foreign evidence, and turn confirmed patterns into explicit risks and prevention constraints for the Build Packet.",
          "For each confirmed outcome, identify the regression scenario and the integration checks that would prove both the happy path and the relevant failure/concurrency path.",
          "Choose invalid only when positive repository or issue evidence proves the claim is already fixed, superseded, unreproducible, or contradicted; an enhancement/refactor with missing implementation is confirmed, not invalid.",
          "Absence of a matching implementation or test is evidence that a requested change may be needed, never sufficient evidence that the issue is invalid. Describe the missing contract as the root cause when the request is confirmed.",
          "Choose decompose only when independently deliverable outcomes need separate acceptance and review.",
          "Do not modify files or perform GitHub writes.",
        ].join("\n"),
        context: [input.intent, ...latestPriorLearningArtifacts(input.priorArtifacts ?? [])],
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
      investigation = createArtifact({
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
      sessionRef = agentResult.sessionRef;
    }

    return await finishInvestigation(
      dependencies,
      run,
      investigation,
      sessionRef ?? `durable:${investigation.id}`,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    run = await applyTransition(dependencies.runs, run, "FAIL", reason);
    throw new WorkflowExecutionError(reason, run, { cause: error });
  }
}

async function finishInvestigation(
  dependencies: InvestigateDependencies,
  initialRun: RunState,
  investigation: DurableArtifact<"Investigation">,
  sessionRef: string,
): Promise<InvestigateResult> {
  let run = attachArtifact(initialRun, "Investigation", investigation.id);
  let outcome: DurableArtifact<"Outcome"> | undefined;
  if (investigation.payload.outcome !== "confirmed") {
    if (investigation.payload.outcome === "decompose" && !dependencies.decomposer) {
      throw new Error("Decomposition requires a controller issue materializer");
    }
    const childIssues = investigation.payload.outcome === "decompose"
      ? (await dependencies.decomposer!.materializeDecomposition({
        repo: run.subject.repo,
        parentIssue: run.subject.issue ?? (() => { throw new Error("Decomposition requires an issue subject"); })(),
        children: investigation.payload.decomposition ?? [],
      })).map((issue) => `#${issue.number} — ${issue.title} (${issue.url})`)
      : [];
    const status = investigation.payload.outcome === "invalid" ? "invalid" : "decomposed";
    outcome = createArtifact({
      kind: "Outcome",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        status,
        reason: investigation.payload.summary,
        ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
        ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
        ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
        ...(investigation.payload.outcome === "invalid" ? {
          issueClosure: {
            status: "pending" as const,
            repo: run.subject.repo,
            issue: run.subject.issue ?? (() => { throw new Error("Invalid investigation requires an issue subject"); })(),
          },
        } : {}),
        childIssues,
      },
    }, {
      id: deterministicOutcomeId(run.runId, run.subject, `${status}:investigation`),
    });
    await dependencies.artifacts.append(outcome);
    run = attachArtifact(run, "Outcome", outcome.id);
  }

  const event: TransitionEvent = investigation.payload.outcome === "confirmed"
    ? "INVESTIGATION_CONFIRMED"
    : investigation.payload.outcome === "invalid"
      ? "INVESTIGATION_INVALID"
      : "INVESTIGATION_DECOMPOSED";
  run = await applyTransition(dependencies.runs, run, event, investigation.payload.summary);
  return {
    run,
    investigation,
    ...(outcome !== undefined ? { outcome } : {}),
    sessionRef,
  };
}

function investigationScopeManifest(scopeHints: ScopeHints | undefined): NonNullable<RunState["scopeManifest"]> {
  const hints = scopeHints ?? {};
  const affectedFiles = hints.affectedFiles ?? [];
  const manifest = scopeManifestFor("issue-hints", {
    ...hints,
    metadataRoots: [
      ...STANDARD_SCOPE_DISCOVERY_ROOTS,
      ...STANDARD_SCOPE_METADATA_ROOTS,
      ...(hints.metadataRoots ?? []),
      ...scopeDiscoveryRoots(affectedFiles),
    ],
  });
  return { ...manifest, source: "issue-hints" };
}

function assertInvestigationMatches(run: RunState, investigation: DurableArtifact<"Investigation">): void {
  if (investigation.runId !== run.runId || !sameSubject(investigation.subject, run.subject)) {
    throw new Error(`Investigation ${investigation.id} does not belong to run ${run.runId}`);
  }
}

function sameSubject(left: Subject, right: Subject): boolean {
  return left.repo.toLowerCase() === right.repo.toLowerCase()
    && left.issue === right.issue
    && left.pr === right.pr;
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
