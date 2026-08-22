// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BuildPacketPayloadSchema, createArtifact, type BuildPacketPayload, type BuildContextPackage, type BuildComplexitySignal, type ControllerVerificationGate, type DurableArtifact, type VerificationRequirement, type InvestigationScopeReceipt } from "../../core/artifacts/schema.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type { VerificationCommand } from "../../core/ports/verification.js";
import {
  isVerificationCapabilityMismatchError,
  isExpectedTestPath,
  projectVerificationCapabilities,
  resolveReadOnlyVerificationSources,
  resolveVerificationTargets,
  validateVerificationTargetPaths,
} from "../../core/ports/verification-capabilities.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import {
  canonicalizeConcreteScopePaths,
  isRecoverableAgentExecutionError,
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
import { latestPriorLearningArtifacts, WorkflowExecutionError, retryableExternalWorkflowError, deterministicOutcomeId } from "./investigate.js";
import { deriveSecurityInvariantMatrices } from "./invariant-matrix.js";
import { deriveEvidenceContract, canonicalEvidencePath, validateEvidenceContract, type EvidenceContractInput } from "./evidence-contract.js";
import { closeExpectedWriteScope, INVESTIGATION_EVIDENCE_LIMITS, resolveInvestigationEvidenceSources, validateFrozenReadOnlyFile } from "./scope-closure.js";
import type { EvidencePathDeclaration, InvariantMatrixRow, VerificationEvidenceDiagnostic, RelationGraphCheckpointPayload } from "../../core/artifacts/schema.js";
import { buildRelationGraph, closeRelationGraph, digestRelation, graphCommandPlanDigest, graphConfigDigest, graphEvidenceContractDigest, relationGraphCheckpointPayload, relationGraphCheckpointId, type RelationGraph } from "../../core/packet/relation-graph.js";
import { detectRepositoryLanguages, repositoryAdaptersFor } from "../../adapters/repository/index.js";

type VerificationCatalogEntry = Pick<VerificationCommand, "id" | "command" | "args">
  & Partial<Omit<VerificationCommand, "cwd" | "id" | "command" | "args">>;

const execFileAsync = promisify(execFile);
const CONTEXT_PACKAGE_LIMITS = {
  maxEntries: 32,
  maxBytes: 200_000,
  maxExcerptBytes: 1_200,
} as const;

/** Deterministic, controller-only advisory context from exact-base evidence. */
export async function deriveBuildContextPackage(input: {
  investigation: DurableArtifact<"Investigation">;
  acceptanceCriteria: readonly string[];
  evidencePaths: readonly EvidencePathDeclaration[];
  /** Controller-frozen write candidates are included only when present at base. */
  expectedPaths?: readonly string[];
  /** Exact controller verification targets and criterion test paths. */
  verificationTargets?: readonly string[];
  readRoots: readonly string[];
  cwd: string;
  baseSha: string;
}): Promise<BuildContextPackage | undefined> {
  if (!/^[0-9a-f]{7,64}$/i.test(input.baseSha)) return undefined;
  const investigationDigest = createHash("sha256").update(JSON.stringify(input.investigation.payload)).digest("hex");
  const sources = input.investigation.payload.evidence;
  const declarations = new Map(input.evidencePaths.map((declaration) => [declaration.path, declaration]));
  const candidatePaths = [...new Set([
    ...(input.expectedPaths ?? []),
    ...(input.verificationTargets ?? []),
    ...input.evidencePaths.map(({ path }) => path),
    ...sources.map(({ source }) => source).flatMap((source) => {
      const match = /(?:^|[\s`(])((?:src|test|tests|packages|bin|lib|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)(?::\d+(?::\d+)?)?(?:\b|$)/.exec(source);
      return match?.[1] ? [match[1]] : [];
    }),
  ])].sort();
  const entries: BuildContextPackage["entries"] = [];
  let totalBytes = 0;
  for (const path of candidatePaths) {
    if (entries.length >= CONTEXT_PACKAGE_LIMITS.maxEntries || totalBytes >= CONTEXT_PACKAGE_LIMITS.maxBytes) break;
    const size = await validateFrozenReadOnlyFile(path, input.cwd, input.readRoots.length ? input.readRoots : ["."]);
    if (size === undefined) continue;
    let content: Buffer;
    try {
      const result = await execFileAsync("git", ["show", `${input.baseSha}:${path}`], {
        cwd: input.cwd,
        maxBuffer: Math.min(96 * 1024, CONTEXT_PACKAGE_LIMITS.maxBytes),
        encoding: "buffer",
      });
      content = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout));
    } catch {
      // A missing path at the exact base is not useful context and must not
      // fall back to mutable worktree content.
      continue;
    }
    if (!content.length || content.length > 96 * 1024 || totalBytes + content.length > CONTEXT_PACKAGE_LIMITS.maxBytes) continue;
    totalBytes += content.length;
    const related = sources.filter(({ source }) => source.includes(path));
    const markerText = related.map(({ claim, detail, source }) => `${claim} ${detail} ${source}`).join(" ");
    const explicitCriteria = [...markerText.matchAll(/criterion-[1-9][0-9]*/g)].map((match) => match[0]);
    const criterionIds = [...new Set(explicitCriteria.filter((id) => input.acceptanceCriteria[Number(id.slice("criterion-".length)) - 1] !== undefined))];
    const linked = criterionIds.length ? criterionIds : input.acceptanceCriteria.map((_, index) => `criterion-${index + 1}`);
    const locators = [...new Set([
      ...(declarations.get(path)?.role ? [`evidence-role:${declarations.get(path)!.role}`] : []),
      ...related.flatMap(({ source, detail }) => [source, ...locatorCandidates(detail)]),
    ])].filter(Boolean).slice(0, 8);
    const testEntrypoints = [...new Set([
      ...(isTestPath(path) ? [path] : []),
      ...related.flatMap(({ detail }) => pathCandidates(detail).filter(isTestPath)),
    ])].slice(0, 8);
    entries.push({
      path,
      contentDigest: createHash("sha256").update(content).digest("hex"),
      bytes: content.length,
      criterionIds: linked,
      locators,
      testEntrypoints,
      excerpt: redactContextExcerpt(content.toString("utf8")),
    });
  }
  if (!entries.length) return undefined;
  const packageDigest = createHash("sha256").update(JSON.stringify({ version: "forgedock.context-package/v1", baseSha: input.baseSha.toLowerCase(), investigationDigest, entries })).digest("hex");
  return { version: "forgedock.context-package/v1", baseSha: input.baseSha.toLowerCase(), investigationDigest, packageDigest, entries };
}

function pathCandidates(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s`(])((?:src|test|tests|packages|bin|lib|docs)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_-]+)(?::\d+(?::\d+)?)?(?:\b|$)/g)].map((match) => match[1]!).filter(Boolean);
}
function locatorCandidates(text: string): string[] {
  return [...text.matchAll(/(?:[A-Za-z_$][\w$]*\.)?[A-Za-z_$][\w$]*(?:#[A-Za-z_$][\w$]*)?/g)].map((match) => match[0]!).filter((value) => value.length > 2).slice(0, 8);
}
function isTestPath(path: string): boolean { return /(?:^|\/)\S+\.test\.[cm]?[jt]sx?$/i.test(path); }
function redactContextExcerpt(content: string): string {
  const redacted = content.split(/\r?\n/).map((line) => /(?:password|secret|token|api[_-]?key|private[_-]?key)\s*[:=]/i.test(line) || /(?:gh[pousr]_|sk-[A-Za-z0-9])/.test(line) ? "[REDACTED]" : line).join("\n");
  return redacted.slice(0, CONTEXT_PACKAGE_LIMITS.maxExcerptBytes);
}

export function deriveBuildComplexitySignal(input: {
  acceptanceCriteria: readonly string[];
  expectedPaths: readonly string[];
  relationCount: number;
  risks: readonly { risk: string; mitigation: string }[];
}): BuildComplexitySignal {
  const criterionCount = input.acceptanceCriteria.length;
  const pathCount = input.expectedPaths.length;
  const riskCount = input.risks.length;
  const score = criterionCount * 2 + pathCount + Math.min(input.relationCount, 16) + riskCount * 2;
  const level = score >= 18 ? "high" : score >= 8 ? "medium" : "low";
  const dimensions = [
    criterionCount > 3 ? "multiple-criteria" : "single-criterion",
    pathCount > 6 ? "wide-path-surface" : "focused-path-surface",
    input.relationCount > 0 ? "related-contracts" : "no-relation-closure",
    riskCount > 0 ? "explicit-risks" : "no-explicit-risks",
  ];
  return { version: "forgedock.complexity-signal/v1", level, score, criterionCount, pathCount, relationCount: input.relationCount, riskCount, dimensions };
}

export interface VerificationCatalog {
  commands: readonly VerificationCatalogEntry[];
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
    /** Exact frozen workspace base; required by production work-on callers. */
    baseSha?: string;
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
  let authorCorrectableAttempted = false;
  const investigationEvidencePaths = await resolveInvestigationEvidenceSources(
    input.investigation.payload.evidence.map(({ source }) => source),
    input.cwd,
  );
  try {
    const affectedScope = [
      ...(input.scopeHints?.affectedFiles ?? []),
      ...(input.scopeHints?.writePaths ?? []),
      ...input.investigation.payload.affectedSurfaces,
      // Investigation evidence is an independent read-only discovery surface;
      // it must never enter the write-scope closure below.
      ...investigationEvidencePaths,
    ];
    const packetAuthorScope = scopeManifestFor("issue-hints", {
      affectedFiles: affectedScope,
      ...(input.scopeHints?.claims ? { claims: [...input.scopeHints.claims] } : {}),
      metadataRoots: [
        ...STANDARD_SCOPE_DISCOVERY_ROOTS,
        ...STANDARD_SCOPE_METADATA_ROOTS,
        ...scopeDiscoveryRoots(affectedScope),
      ],
    });
    const packetTask: AgentTask<BuildPacketPayload> = {
      id: `${run.runId}:build-packet:${run.attempt}`,
      role: "packet-author",
      objective: "Freeze a buildable, reviewable contract from the proven issue intent and investigation.",
      instructions: [
        "Every acceptance criterion must be observable, testable, and tied to a concrete implementation and integration boundary.",
        "This packet-authoring pass is execution-bounded. Freeze the smallest complete Build Packet from the evidence and submit it before the ceiling; do not perform open-ended repository exploration.",
        "Translate the investigation's root cause, risks, and historical failure patterns into prevention constraints, not just a list of files to edit.",
        "Use the latest prior review, verification, and blocked-outcome artifacts when present to strengthen the new packet's integration criteria and regression checks; treat them as historical evidence, never as authority to widen the current Intent.",
        "For each acceptance criterion, make implementationPlan name the relevant symbols/files, callers or adapters, invariant to preserve, regression scenario, and failure/cancellation/concurrency behavior when applicable. Avoid vague steps such as 'update the code' or 'add tests'.",
        "Include implementation-specific history and consistency constraints only when relevant, and carry forward any confirmed repository-specific integration convention from the investigation or FORGE.md.",
        "Expected paths must be concrete repository-relative files and are the frozen write/conflict boundary; never emit globs, absolute paths, traversal, or line-location suffixes.",
        "When a shared interface or contract changes, include every affected implementation, caller, adapter, serializer, and test-double path that may need edits, especially all paths declared by the issue. The builder cannot edit a path omitted from this packet.",
        "Map verificationPlan to the acceptance criteria through typed verificationRequirements. Each requirement must use exactly one allowed command ID or controller-gate ID from the supplied catalog, include one or more criterion-N IDs, and explain its rationale. Do not invent command IDs or shell strings.",
        "The legacy verificationPlan field is retained only for compatibility; emit one exact controller-gate:<id> token or one fenced executable command per typed requirement. Never encode controller-owned lifecycle evidence as prose.",
        "Allowed command IDs and controller gate IDs are supplied below. Unknown IDs, unfenced executable prose, and requirements that do not cover every acceptance criterion are rejected before the builder starts.",
        `Verification capabilities: ${JSON.stringify(projectVerificationCapabilities(input.verificationCatalog?.commands ?? []))}`,
        "Select only command IDs from the capability list. For targeted tests, expected paths must remain repository-relative TypeScript test files under the stated source root and extension set; the controller derives compiled output paths. Do not propose JavaScript/MJS paths for the TypeScript command, and do not invent a legacy command.",
        ...(input.verificationCatalog ? [
          `Frozen command requirements must use these exact IDs from the supplied catalog: ${input.verificationCatalog.commands.map(({ id }) => id).join(", ") || "(none)"}.`,
        ] : []),
        "expectedPaths are write authority only. evidencePaths are criterion-scoped read-only evidence declarations and never expand expectedPaths.",
        "Use exact roles (implementation, source, test, invariant, artifact, generated, fixture, unchanged-boundary) and exact criterion IDs criterion-1, criterion-2, etc.; declare only paths visible through the approved read surfaces.",
        "Use only safe command capabilities and exact catalog IDs; do not expose arbitrary executable authority beyond legacy fenced-plan compatibility.",
      ].join("\n"),
      context: [input.intent, input.investigation, ...latestPriorLearningArtifacts(input.priorArtifacts ?? [])],
      workspace: {
        cwd: input.cwd,
        mode: "read-only",
        scope: packetAuthorScope,
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
    };
    let result!: AgentRunResult<BuildPacketPayload>;
    let materialized: Awaited<ReturnType<typeof materializePacketOutput>>;
    let repairDiagnostics: string[] = [];
    for (let session = 0; session < 2; session += 1) {
      const task = session === 0 ? packetTask : {
        ...packetTask,
        id: `${packetTask.id}:${repairDiagnostics.some((diagnostic) => diagnostic.includes("capability-mismatch")) ? "capability-repair" : repairDiagnostics.some((diagnostic) => diagnostic.includes("submit_artifact")) ? "submit-retry" : "repair"}`,
        instructions: [
          packetTask.instructions,
          `The shared retry budget permits one fresh repair session${repairDiagnostics.some((diagnostic) => diagnostic.includes("capability-mismatch")) ? " (one bounded :capability-repair attempt)" : ""}. This is the one bounded recovery attempt.`,
          `COMPLETE diagnostics from the controller:\n${repairDiagnostics.join("\\n")}`,
          `Safe capability contract:\n${JSON.stringify(projectVerificationCapabilities(input.verificationCatalog?.commands ?? []))}`,
        ].join("\n"),
      };
      try {
        result = await dependencies.runtime.run(task, {
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(dependencies.onAgentEvent !== undefined ? { onEvent: dependencies.onAgentEvent } : {}),
        });
        materialized = await materializePacketOutput(
          result.output,
          input.verificationCatalog,
          input.scopeHints?.affectedFiles ?? [],
          input.investigation.payload.affectedSurfaces,
          input.investigation.payload.evidence.map(({ source }) => source),
          packetAuthorScope.readRoots,
          input.scopeHints?.metadataRoots ?? [],
          input.scopeHints?.writePaths ?? [],
          input.cwd,
          input.scopeHints !== undefined,
          input.baseSha ?? input.run.headSha ?? "0000000",
          input.run.runId,
          input.run.subject,
          input.intent,
          input.investigation,
        );
        break;
      } catch (error) {
        if (isVerificationCapabilityMismatchError(error)) {
          error = new PacketAuthorCorrectableError([`[capability-mismatch] ${error.message}`]);
        } else if (!(error instanceof PacketAuthorCorrectableError)
          && error instanceof Error
          && /ended without calling submit_artifact/i.test(error.message)) {
          error = new PacketAuthorCorrectableError([`[submit_artifact] ${error.message}`]);
        }
        if (!isAuthorCorrectablePacketError(error)) throw error;
        authorCorrectableAttempted = true;
        repairDiagnostics = error.diagnostics;
        if (session === 1) {
          const grouped = repairDiagnostics.some((diagnostic) => diagnostic.includes("capability-mismatch"))
            ? `Verification capability mismatch exhausted after bounded repair. Complete diagnostics:\n${repairDiagnostics.join("\\n")}`
            : `Build Packet authoring exhausted after two sessions. Correctable diagnostics:\n${repairDiagnostics.join("\\n")}`;
          const blockedState = await appendPreparationBlockedOutcome(run, grouped, dependencies);
          throw new WorkflowExecutionError(grouped, blockedState, { cause: error });
        }
        if (error.directBlock) {
          const blockedState = await appendPreparationBlockedOutcome(run, error.diagnostics.join("\\n"), dependencies);
          throw new WorkflowExecutionError(error.diagnostics.join("\\n"), blockedState, { cause: error });
        }
      }
    }
    const { expectedPaths, controllerVerifiedOutput, policyMetadata, invariantMatrices, evidenceContract, evidencePaths, relationGraph, relationGraphCheckpoint, investigationScopeReceipt, contextPackage, complexitySignal } = materialized!;
    const packet = createArtifact({
      kind: "BuildPacket",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "packet-author", runtime: "pi-compatible", provider: result.provider, model: result.model },
      payload: {
        ...controllerVerifiedOutput,
        expectedPaths,
        ...policyMetadata,
        ...(invariantMatrices.length ? { invariantMatrices } : {}),
        ...(evidencePaths.length ? { evidencePaths } : {}),
        ...(evidenceContract ? { evidenceContract } : {}),
        ...(relationGraph ? { relationGraph } : {}),
        ...(investigationScopeReceipt ? { investigationScopeReceipt } : {}),
        ...(contextPackage ? { contextPackage } : {}),
        ...(complexitySignal ? { complexitySignal } : {}),
      },
    });
    await dependencies.artifacts.append(packet);
    if (relationGraphCheckpoint) {
      const checkpoint = createArtifact({
        kind: "RelationGraphCheckpoint",
        runId: run.runId,
        subject: run.subject,
        producer: { role: "controller", runtime: "forgedock" },
        payload: relationGraphCheckpoint,
      }, { ...(relationGraphCheckpoint.checkpointId ? { id: relationGraphCheckpoint.checkpointId } : {}) });
      await dependencies.artifacts.append(checkpoint);
      run = attachArtifact(run, "RelationGraphCheckpoint", checkpoint.id);
    }
    run = attachArtifact(run, "BuildPacket", packet.id);
    const packetScopeManifest = scopeManifestForBuildPacket(expectedPaths, evidencePaths.map(({ path }) => path));
    const advanced = transition(run, "BUILD_PACKET_READY", {
      scopeManifest: packetScopeManifest,
    });
    // This compare-and-swap is the handoff barrier: callers adopt the
    // returned version only after the packet and its frozen scope are durable.
    await dependencies.runs.commit(run.version, advanced.state, advanced.record);
    return { run: advanced.state, packet, sessionRef: result.sessionRef };
  } catch (error) {
    const externalRetry = retryableExternalWorkflowError(error, run);
    if (externalRetry) throw externalRetry;
    if (error instanceof WorkflowExecutionError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    if (authorCorrectableAttempted && isAuthorCorrectablePacketError(error)) {
      const blockedReason = `Build Packet authoring exhausted after bounded repair: ${error.message}`;
      const blockedState = await appendPreparationBlockedOutcome(run, blockedReason, dependencies);
      throw new WorkflowExecutionError(blockedReason, blockedState, { cause: error });
    }
    if (isRecoverableAgentExecutionError(error)) {
      const checkpoint = transition(run, "RESUME_PREPARATION", { reason });
      await dependencies.runs.commit(run.version, checkpoint.state, checkpoint.record);
      throw new WorkflowExecutionError(reason, checkpoint.state, { cause: error, recoverable: true });
    }
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}

class PacketAuthorCorrectableError extends Error {
  readonly diagnostics: string[];
  readonly directBlock: boolean;

  constructor(diagnostics: string[], directBlock = false) {
    super(diagnostics.join("\\n"));
    this.name = "PacketAuthorCorrectableError";
    this.diagnostics = diagnostics;
    this.directBlock = directBlock;
  }
}

function isAuthorCorrectablePacketError(error: unknown): error is PacketAuthorCorrectableError {
  return error instanceof PacketAuthorCorrectableError;
}

async function appendPreparationBlockedOutcome(
  run: RunState,
  reason: string,
  dependencies: { artifacts: ArtifactRepository; runs: RunRepository },
): Promise<RunState> {
  const outcome = createArtifact({
    kind: "Outcome",
    runId: run.runId,
    subject: run.subject,
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      status: "blocked",
      reason,
      ...(run.targetBranch ? { targetBranch: run.targetBranch } : {}),
      ...(run.promotionTarget ? { promotionTarget: run.promotionTarget } : {}),
      ...(run.productionTarget ? { productionTarget: run.productionTarget } : {}),
      childIssues: [],
    },
  }, { id: deterministicOutcomeId(run.runId, run.subject, `blocked:preparation:${reason}`) });
  await dependencies.artifacts.append(outcome);
  const attached = attachArtifact(run, "Outcome", outcome.id);
  const blocked = transition(attached, "BLOCK", { reason });
  await dependencies.runs.commit(run.version, blocked.state, blocked.record);
  return blocked.state;
}

function diagnosticText(diagnostic: VerificationEvidenceDiagnostic): string {
  return `[${diagnostic.code}${diagnostic.criterionId ? ` ${diagnostic.criterionId}` : ""}] ${diagnostic.message}`;
}

function approvedEvidencePath(path: string, approved: ReadonlySet<string>): boolean {
  return approved.has(path) || [...approved].some((root) =>
    root !== "." && !root.includes(".") && path.startsWith(`${root}/`));
}

function canonicalizeEvidenceDeclarations(
  declarations: readonly EvidencePathDeclaration[] | undefined,
  criterionCount: number,
  approved: ReadonlySet<string>,
): { declarations: EvidencePathDeclaration[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const result: EvidencePathDeclaration[] = [];
  const criterionIds = new Set(Array.from({ length: criterionCount }, (_, index) => `criterion-${index + 1}`));
  if ((declarations?.length ?? 0) > 64) diagnostics.push("[evidence-path-limit] Evidence paths are bounded to 64 declarations");
  for (const declaration of (declarations ?? []).slice(0, 64)) {
    let path: string;
    try {
      path = canonicalEvidencePath(declaration.path);
    } catch (error) {
      diagnostics.push(`[invalid-evidence-path] ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const unknown = declaration.criterionIds.filter((id) => !criterionIds.has(id));
    if (unknown.length) diagnostics.push(`[unknown-criterion] Evidence path '${path}' references unknown criterion(s): ${unknown.join(", ")}`);
    if (!approvedEvidencePath(path, approved)) {
      diagnostics.push(`[evidence-scope] Evidence path '${path}' is outside controller-approved read surfaces`);
      continue;
    }
    const ids = [...new Set(declaration.criterionIds)].filter((id) => criterionIds.has(id));
    if (!ids.length) continue;
    result.push({ path, criterionIds: ids, role: declaration.role });
  }
  return { declarations: result, diagnostics };
}

async function materializePacketOutput(
  output: BuildPacketPayload,
  catalog: VerificationCatalog | undefined,
  affectedFiles: readonly string[],
  investigationSurfaces: readonly string[] = [],
  investigationEvidenceSources: readonly string[] = [],
  packetAuthorReadRoots: readonly string[] = [],
  metadataPaths: readonly string[] = [],
  controllerWriteHints: readonly string[] = [],
  cwd = process.cwd(),
  enforceScopeClosure = true,
  baseSha = "0000000",
  runId = "",
  subject?: DurableArtifact<"Intent">["subject"],
  intent?: DurableArtifact<"Intent">,
  investigation?: DurableArtifact<"Investigation">,
): Promise<{
  expectedPaths: string[];
  evidencePaths: EvidencePathDeclaration[];
  evidenceContract?: import("../../core/artifacts/schema.js").VerificationEvidenceContract;
  controllerVerifiedOutput: Omit<BuildPacketPayload, "verificationPolicyVersion" | "verificationCommandTargets" | "verificationCommandIdentities" | "invariantMatrices" | "evidenceContract" | "evidencePaths" | "contextPackage" | "complexitySignal">;
  policyMetadata: Pick<BuildPacketPayload, "verificationPolicyVersion" | "verificationCommandTargets" | "verificationCommandIdentities"> | Record<string, never>;
  invariantMatrices: ReturnType<typeof deriveSecurityInvariantMatrices>;
  relationGraph?: BuildPacketPayload["relationGraph"];
  relationGraphCheckpoint?: RelationGraphCheckpointPayload;
  investigationScopeReceipt?: InvestigationScopeReceipt;
  contextPackage?: BuildContextPackage;
  complexitySignal?: BuildComplexitySignal;
}> {
  if (!output.expectedPaths.length) throw new PacketAuthorCorrectableError(["[write-scope] Build Packet must declare at least one concrete expected path"]);
  const criterionDuplicates = [...new Set(output.acceptanceCriteria.filter((criterion, index, criteria) => criteria.indexOf(criterion) !== index))];
  if (criterionDuplicates.length) {
    throw new PacketAuthorCorrectableError([
      `[duplicate-acceptance-criteria] Build Packet acceptanceCriteria contains duplicate value(s): ${criterionDuplicates.join(", ")}`,
    ]);
  }
  const declaredPaths = canonicalizeConcreteScopePaths(affectedFiles.filter(isConcreteScopePath));
  const investigatedPaths = canonicalizeConcreteScopePaths(investigationSurfaces.filter(isConcreteScopePath));
  const investigationEvidencePaths = await resolveInvestigationEvidenceSources(investigationEvidenceSources, cwd);
  const controllerPaths = canonicalizeConcreteScopePaths(controllerWriteHints.filter(isConcreteScopePath));
  const effectiveControllerPaths = controllerPaths;
  // Concrete packet paths are the exact builder grant after canonical path
  // validation. Investigation/controller hints remain provenance and read-scope
  // inputs; they do not gate a cross-cutting packet's proposed write set.
  const closure = await closeExpectedWriteScope(output.expectedPaths, {
    issueWriteHints: declaredPaths,
    controllerWriteHints: effectiveControllerPaths,
    cwd,
  });
  // Packets authored before durable scope hints were introduced have no
  // relation surface at all. Preserve their decode/prepare compatibility, but
  // keep the strict closure whenever any investigation or controller surface
  // is present (those surfaces must never silently authorize writes).
  const legacyUnhinted = !enforceScopeClosure;
  if (closure.diagnostics.length && !legacyUnhinted) {
    throw new PacketAuthorCorrectableError(closure.diagnostics);
  }
  const expectedPaths = legacyUnhinted
    ? canonicalizeConcreteScopePaths(output.expectedPaths)
    : closure.expectedPaths;
  if (catalog) {
    const modelTargeted = catalog.commands.filter((command) => command.targeting === "expected-test-paths");
    if (modelTargeted.length && output.expectedPaths.some((path) => /(?:^|\/)\S+\.test\.(?:[cm]?[jt]sx?)$/i.test(path))) {
      // Validate model targets only as a bounded correction signal; they never
      // become write authority (expectedPaths above came from graph closure).
      validateVerificationTargetPaths(output.expectedPaths, modelTargeted);
    }
  }
  const approved = new Set<string>([
    ...expectedPaths,
    ...investigatedPaths,
    ...declaredPaths,
    ...effectiveControllerPaths,
    ...investigationEvidencePaths,
    ...packetAuthorReadRoots,
    ...scopeDiscoveryRoots([...expectedPaths, ...investigatedPaths, ...declaredPaths, ...effectiveControllerPaths]),
    ...STANDARD_SCOPE_METADATA_ROOTS,
    ...metadataPaths.filter(isConcreteScopePath),
  ]);
  const canonicalEvidence = canonicalizeEvidenceDeclarations(output.evidencePaths, output.acceptanceCriteria.length, approved);
  const validEvidence: EvidencePathDeclaration[] = [];
  const evidenceDiagnostics = [...canonicalEvidence.diagnostics];
  const validatedEvidencePaths = new Set<string>();
  let evidenceBytes = 0;
  for (const declaration of canonicalEvidence.declarations) {
    if (!validatedEvidencePaths.has(declaration.path) && validatedEvidencePaths.size >= INVESTIGATION_EVIDENCE_LIMITS.maxFiles) {
      evidenceDiagnostics.push(`[evidence-file-limit] Evidence paths are bounded to ${INVESTIGATION_EVIDENCE_LIMITS.maxFiles} files`);
      continue;
    }
    const size = await validateFrozenReadOnlyFile(declaration.path, cwd, packetAuthorReadRoots);
    if (size === undefined) {
      evidenceDiagnostics.push(`[evidence-file] Evidence path '${declaration.path}' is not a safe regular file inside the frozen packet-author read scope`);
      continue;
    }
    if (evidenceBytes + (validatedEvidencePaths.has(declaration.path) ? 0 : size) > INVESTIGATION_EVIDENCE_LIMITS.maxTotalBytes) {
      evidenceDiagnostics.push(`[evidence-byte-limit] Evidence paths exceed the ${INVESTIGATION_EVIDENCE_LIMITS.maxTotalBytes}-byte frozen read bound at '${declaration.path}'`);
      continue;
    }
    if (!validatedEvidencePaths.has(declaration.path)) {
      evidenceBytes += size;
      validatedEvidencePaths.add(declaration.path);
    }
    validEvidence.push(declaration);
  }
  const evidence = { declarations: validEvidence, diagnostics: evidenceDiagnostics };
  const provisionalInvariantMatrices = deriveSecurityInvariantMatrices(output);
  const semanticReadOnlySources = catalog
    ? await resolveReadOnlyVerificationSources(
      evidence.declarations.map(({ path }) => path),
      selectedCatalogCommands(output, catalog.commands).filter((command) => command.targeting === "expected-test-paths"),
      cwd,
      { optionalCandidates: investigationSurfaces },
    )
    : [];
  const verifiedOutput = catalog && (catalog.commands.length > 0 || Boolean(output.verificationRequirements?.length))
    ? canonicalizePacketVerification(output, catalog, expectedPaths, provisionalInvariantMatrices, semanticReadOnlySources)
    : output;
  const {
    verificationPolicyVersion: _untrustedPolicyVersion,
    verificationCommandTargets: _untrustedCommandTargets,
    verificationCommandIdentities: _untrustedCommandIdentities,
    invariantMatrices: _untrustedInvariantMatrices,
    evidenceContract: _untrustedEvidenceContract,
    evidencePaths: _modelEvidencePaths,
    relationGraph: _untrustedRelationGraph,
    investigationScopeReceipt: _untrustedInvestigationScopeReceipt,
    contextPackage: _modelContextPackage,
    complexitySignal: _modelComplexitySignal,
    ...controllerVerifiedOutput
  } = verifiedOutput;
  const policyMetadata = catalog
    ? await packetVerificationPolicyMetadata({ ...controllerVerifiedOutput, expectedPaths }, catalog.commands, evidence.declarations.map(({ path }) => path), cwd, investigationSurfaces)
    : {};
  const invariantMatrices = deriveSecurityInvariantMatrices(controllerVerifiedOutput);
  const contextPackage = investigation
    ? await deriveBuildContextPackage({
      investigation,
      acceptanceCriteria: controllerVerifiedOutput.acceptanceCriteria,
      evidencePaths: evidence.declarations,
      expectedPaths,
      verificationTargets: policyMetadata.verificationCommandTargets?.flatMap(({ targets, sourceTargets }) => [...targets, ...(sourceTargets ?? [])]) ?? [],
      readRoots: packetAuthorReadRoots,
      cwd,
      baseSha,
    })
    : undefined;
  if (!catalog) {
    const graphAuthority = await deriveRelationGraphMetadataShadow(expectedPaths, declaredPaths, effectiveControllerPaths, cwd, policyMetadata, undefined, baseSha, expectedPaths, evidence.declarations.map(({ path }) => path));
    const relationCount = graphAuthority.metadata ? graphAuthority.metadata.invariantIds.length + graphAuthority.metadata.commandIds.length : 0;
    const complexitySignal = deriveBuildComplexitySignal({ acceptanceCriteria: controllerVerifiedOutput.acceptanceCriteria, expectedPaths, relationCount, risks: controllerVerifiedOutput.risks });
    return { expectedPaths, evidencePaths: evidence.declarations, controllerVerifiedOutput, policyMetadata, invariantMatrices, ...(contextPackage ? { contextPackage } : {}), complexitySignal, ...(graphAuthority.metadata ? { relationGraph: graphAuthority.metadata } : {}), ...(graphAuthority.checkpoint ? { relationGraphCheckpoint: graphAuthority.checkpoint } : {}) };
  }
  // A policy-v2 packet is newly materialized controller authority. Missing
  // capability metadata on any command that will execute is a catalog defect,
  // not author input to repair; fail closed before persistence.
  if (policyMetadata.verificationPolicyVersion === "forgedock.verification/v2") {
    const missingCapabilities = selectedCatalogCommands(controllerVerifiedOutput, catalog.commands)
      .filter((command) => command.evidenceCapability === undefined)
      .map((command) => command.id);
    if (missingCapabilities.length) {
      throw new PacketAuthorCorrectableError([
        `[missing-capability] Selected policy-v2 command(s) lack evidenceCapability metadata: ${missingCapabilities.join(", ")}`,
      ], true);
    }
  }
  // Evidence contracts are a v2 policy feature. Legacy and custom catalogs must
  // retain their historical packet behavior rather than acquiring new semantic
  // requirements merely because a catalog was supplied.
  const selectedCommands = selectedCatalogCommands(controllerVerifiedOutput, catalog.commands);
  const hasExplicitEvidenceCapabilities = selectedCommands.every((command) => command.evidenceCapability !== undefined);
  if (policyMetadata.verificationPolicyVersion !== "forgedock.verification/v2" || !hasExplicitEvidenceCapabilities) {
    return { expectedPaths, evidencePaths: evidence.declarations, controllerVerifiedOutput, policyMetadata, invariantMatrices };
  }
  const targetById = new Map((policyMetadata.verificationCommandTargets ?? []).map(({ id, targets }) => [id, targets]));
  const projectedCommands = projectVerificationCapabilities(catalog.commands).map((capability) => ({
    ...capability,
    // Projection is controller-owned: every command has explicit semantic metadata and exact derived targets.
    evidenceCapability: catalog.commands.find(({ id }) => id === capability.id)?.evidenceCapability ?? "generic",
    targets: targetById.get(capability.id) ?? [],
  }));
  const derivationInput: EvidenceContractInput = {
    acceptanceCriteria: controllerVerifiedOutput.acceptanceCriteria,
    ...(controllerVerifiedOutput.verificationRequirements ? { verificationRequirements: controllerVerifiedOutput.verificationRequirements } : {}),
    controllerGates: catalog.controllerGates,
    commands: projectedCommands,
    invariantMatrices,
    expectedPaths,
    evidencePaths: evidence.declarations,
  };
  const derivation = deriveEvidenceContract(derivationInput);
  const derivationDiagnostics = derivation.diagnostics.map(diagnosticText);
  if (derivationDiagnostics.length) {
    const semanticAvailable = catalog.commands.some((command) => command.evidenceCapability !== undefined && command.evidenceCapability !== "generic");
    const semanticNeeded = derivation.diagnostics.some(({ code }) => code === "generic-only-command" || code === "invariant-command-missing" || code === "unusable-semantic-command");
    throw new PacketAuthorCorrectableError(derivationDiagnostics, semanticNeeded && !semanticAvailable);
  }
  const graphAuthority = await deriveRelationGraphMetadataShadow(expectedPaths, declaredPaths, effectiveControllerPaths, cwd, policyMetadata, derivation.contract, baseSha, expectedPaths, evidence.declarations.map(({ path }) => path));
  const complexitySignal = deriveBuildComplexitySignal({
    acceptanceCriteria: controllerVerifiedOutput.acceptanceCriteria,
    expectedPaths,
    relationCount: graphAuthority.metadata ? graphAuthority.metadata.invariantIds.length + graphAuthority.metadata.commandIds.length : 0,
    risks: controllerVerifiedOutput.risks,
  });
  return {
    expectedPaths,
    evidencePaths: evidence.declarations,
    evidenceContract: derivation.contract,
    controllerVerifiedOutput,
    policyMetadata,
    invariantMatrices,
    ...(contextPackage ? { contextPackage } : {}),
    complexitySignal,
    ...(graphAuthority.metadata ? { relationGraph: graphAuthority.metadata } : {}),
    ...(graphAuthority.checkpoint ? { relationGraphCheckpoint: graphAuthority.checkpoint } : {}),
  };
}

async function deriveRelationGraphMetadataShadow(
  expectedPaths: readonly string[],
  issuePaths: readonly string[],
  controllerPaths: readonly string[],
  cwd: string,
  policyMetadata: Pick<BuildPacketPayload, "verificationPolicyVersion" | "verificationCommandTargets" | "verificationCommandIdentities"> | Record<string, never>,
  evidenceContract: BuildPacketPayload["evidenceContract"] | undefined,
  baseSha: string,
  finalExpectedPaths?: readonly string[],
  finalEvidencePaths: readonly string[] = [],
): Promise<{ metadata?: BuildPacketPayload["relationGraph"]; checkpoint?: RelationGraphCheckpointPayload }> {
  try {
    return await deriveRelationGraphMetadata(expectedPaths, issuePaths, controllerPaths, cwd, policyMetadata, evidenceContract, baseSha, finalExpectedPaths, finalEvidencePaths);
  } catch (error) {
    if (process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT === "1") throw error;
    return {};
  }
}

async function deriveRelationGraphMetadata(
  expectedPaths: readonly string[],
  issuePaths: readonly string[],
  controllerPaths: readonly string[],
  cwd: string,
  policyMetadata: Pick<BuildPacketPayload, "verificationPolicyVersion" | "verificationCommandTargets" | "verificationCommandIdentities"> | Record<string, never>,
  evidenceContract: BuildPacketPayload["evidenceContract"] | undefined,
  baseSha: string,
  finalExpectedPaths?: readonly string[],
  finalEvidencePaths: readonly string[] = [],
): Promise<{ metadata?: BuildPacketPayload["relationGraph"]; checkpoint?: RelationGraphCheckpointPayload }> {
  const seeds = [...new Set([...issuePaths, ...controllerPaths])].map((path) => ({
    path,
    provenance: issuePaths.includes(path) ? "issue" as const : "controller" as const,
  }));
  if (!seeds.length) return {};
  const adapters = repositoryAdaptersFor(await detectRepositoryLanguages(cwd));
  const limits = { maxNodes: 10_000, maxEdges: 25_000, maxDepth: 8, maxFiles: 2_000, maxBytes: 4_000_000, maxCollateralPaths: 512 };
  const facts = [];
  for (const adapter of adapters) facts.push(await adapter.inspect({ cwd, limits }));
  const availableFiles = new Set(facts.flatMap((fact) => fact.nodes
    .filter((node) => node.kind === "file" || node.kind === "generated" || node.kind === "test" || node.kind === "config")
    .map((node) => node.identity)));
  if (seeds.some(({ path }) => !availableFiles.has(path))) return {};
  const nodeDigestByPath = new Map(facts.flatMap((fact) => fact.nodes
    .filter((node) => node.kind === "file" || node.kind === "generated" || node.kind === "test" || node.kind === "config")
    .map((node) => [node.identity, node.digest] as const)));
  const authoritativeSeeds = seeds.map((seed) => ({
    ...seed,
    contentDigest: nodeDigestByPath.get(seed.path)!,
  }));
  const configSeeds = facts.flatMap((fact) => fact.nodes
    .filter((node): node is typeof node & { digest: string } => node.kind === "config" && node.identity.includes("/") && Boolean(node.digest))
    .map((node) => ({ path: node.identity, provenance: "config" as const, contentDigest: node.digest })));
  const allSeeds = [...authoritativeSeeds, ...configSeeds];
  const graph = buildRelationGraph({ baseSha, seeds: allSeeds, facts, limits });
  const closure = closeRelationGraph(graph);
  if (closure.diagnostics.length) throw new PacketAuthorCorrectableError(closure.diagnostics);
  const writablePaths = finalExpectedPaths
    ? [...new Set(finalExpectedPaths)].sort()
    : [...new Set([...closure.writablePaths, ...expectedPaths.filter((path) => issuePaths.includes(path) || controllerPaths.includes(path))])].sort();
  if (writablePaths.some((path) => !closure.writablePaths.includes(path))) {
    throw new PacketAuthorCorrectableError(["[graph-closure] Packet writable paths exceed the authoritative relation closure"]);
  }
  // RelationGraph is shadow authority during rollout. Evidence declarations
  // already passed controller read-scope validation above; an adapter reaching
  // its bounded scan limit must not turn an existing read-only evidence path
  // into a packet-author failure. Include only graph-observed evidence here and
  // retain the complete packet evidence contract independently.
  const graphObservedEvidence = finalEvidencePaths.filter((path) => availableFiles.has(path));
  const evidencePaths = [...new Set([...closure.evidencePaths, ...graphObservedEvidence])].sort();
  const commandIds = policyMetadata.verificationCommandIdentities?.map(({ id }) => id).sort() ?? closure.commandIds;
  const invariantIds = closure.invariantIds;
  const configDigest = graphConfigDigest({ adapters: graph.adapterIds, limits: graph.limits });
  const commandPlanDigest = graphCommandPlanDigest(policyMetadata);
  const evidenceContractDigest = graphEvidenceContractDigest(evidenceContract);
  const closureDigest = digestRelation({ graphDigest: graph.graphDigest, writablePaths, evidencePaths, invariantIds, commandIds });
  const checkpoint = relationGraphCheckpointPayload({ graph, closure: { ...closure, writablePaths, evidencePaths, invariantIds, commandIds, closureDigest }, configDigest, commandPlanDigest, evidenceContractDigest });
  const checkpointId = checkpoint.checkpointId ?? relationGraphCheckpointId(checkpoint.checkpointDigest ?? "");
  const checkpointDigest = checkpoint.checkpointDigest ?? "";
  const metadata = {
    version: "forgedock.relation-graph/v1" as const,
    baseSha: graph.baseSha,
    graphDigest: graph.graphDigest,
    configDigest,
    closureDigest,
    commandPlanDigest,
    evidenceContractDigest,
    checkpointId,
    checkpointDigest,
    writablePaths,
    evidencePaths,
    invariantIds,
    commandIds,
  };
  return { metadata, checkpoint };
}

export function canonicalizePacketVerification(
  output: BuildPacketPayload,
  catalog: VerificationCatalog,
  expectedPaths: readonly string[],
  invariantMatrices: readonly InvariantMatrixRow[],
  semanticReadOnlySources: readonly string[] = [],
): BuildPacketPayload {
  const commandById = new Map(catalog.commands.map((command) => [command.id, command]));
  const gateById = new Map(catalog.controllerGates.map((gate) => [gate.id, gate]));
  const criterionIds = output.acceptanceCriteria.map((_, index) => `criterion-${index + 1}`);
  const semanticPaths = [...new Set([...expectedPaths, ...semanticReadOnlySources])];
  const requirements: VerificationRequirement[] = output.verificationRequirements?.length
    ? output.verificationRequirements.map((requirement) => {
      if (!requirement.criterionIds.every((id) => criterionIds.includes(id))) {
        throw new PacketAuthorCorrectableError([`[unknown-criterion] Build Packet verification requirement ${requirement.id} references an unknown acceptance criterion`]);
      }
      if (requirement.kind === "command" && !commandById.has(requirement.id)) {
        throw new PacketAuthorCorrectableError([`[unknown-command] Build Packet verification requirement references unknown command ID '${requirement.id}'`]);
      }
      if (requirement.kind === "controller-gate") {
        const gateId = requirement.id as ControllerVerificationGate["id"];
        if (!gateById.has(gateId)) {
          throw new PacketAuthorCorrectableError([`[unknown-controller-gate] Build Packet verification requirement references unknown controller gate ID '${requirement.id}'`]);
        }
      }
      return {
        kind: requirement.kind,
        id: requirement.id,
        criterionIds: [...new Set(requirement.criterionIds)],
        rationale: requirement.rationale,
        ...(requirement.evidenceKind !== undefined ? { evidenceKind: requirement.evidenceKind } : {}),
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
        throw new PacketAuthorCorrectableError([`[unsupported-verification] Build Packet verification plan contains unsupported or unfenced controller prose: ${entry}`]);
      }
      return { kind: "command" as const, id: command.id, criterionIds, rationale: "Legacy executable requirement canonicalized before dispatch." };
    });

  const completionDiagnostics: string[] = [];
  for (const criterionId of criterionIds) {
    const rows = invariantMatrices.filter((row) => row.criterionId === criterionId);
    const hasGateRequirement = requirements.some((requirement) => requirement.kind === "controller-gate" && requirement.criterionIds.includes(criterionId));
    if (hasGateRequirement && rows.length === 0) continue;
    const hasGenericRequirement = requirements.some((requirement) => requirement.kind === "command"
      && requirement.criterionIds.includes(criterionId)
      && commandById.get(requirement.id)?.evidenceCapability === "generic");
    const hasSemanticRequirement = requirements.some((requirement) => requirement.kind === "command"
      && requirement.criterionIds.includes(criterionId)
      && isProvenSemanticCommand(commandById.get(requirement.id), rows, semanticPaths));
    if (hasSemanticRequirement) continue;
    const candidates = catalog.commands
      .filter((command) => command.evidenceCapability !== undefined && command.evidenceCapability !== "generic")
      .filter((command) => isProvenSemanticCommand(command, rows, semanticPaths))
      .sort((left, right) => semanticCommandRank(left, rows) - semanticCommandRank(right, rows) || left.id.localeCompare(right.id));
    const selected = candidates[0];
    if (!selected) {
      if (hasGenericRequirement) {
        completionDiagnostics.push(`${criterionId}: generic-only-command; no controller-proven semantic verification target is available`);
        continue;
      }
      completionDiagnostics.push(`${criterionId}: no controller-proven targeted/path-bound/invariant command is available`);
      continue;
    }
    requirements.push({
      kind: "command",
      id: selected.id,
      criterionIds: [criterionId],
      rationale: "Controller auto-completed semantic evidence from validated relation closure and catalog capability.",
    });
  }
  if (completionDiagnostics.length) {
    throw new PacketAuthorCorrectableError([`[semantic-completion] ${completionDiagnostics.join("; ")}`], true);
  }

  const covered = new Set(requirements.flatMap((requirement) => requirement.criterionIds));
  const missing = criterionIds.filter((id) => !covered.has(id));
  if (missing.length) throw new PacketAuthorCorrectableError([`[missing-requirement] Build Packet verification requirements do not cover ${missing.join(", ")}`]);
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

function isProvenSemanticCommand(
  command: VerificationCatalogEntry | undefined,
  rows: readonly InvariantMatrixRow[],
  expectedPaths: readonly string[],
): boolean {
  if (!command?.evidenceCapability || command.evidenceCapability === "generic") return false;
  if (command.evidenceCapability === "invariant" && rows.length === 0) return false;
  if ((command.evidenceCapability === "targeted-test" || command.evidenceCapability === "path-bound") && expectedPaths.length === 0) return false;
  if (command.targeting === "expected-test-paths") {
    if (!command.typescriptLayout || !expectedPaths.some((path) => /(?:^|\/)\S+\.test\.(?:[cm]?[jt]sx?)$/i.test(path))) return false;
    try { return resolveVerificationTargets(expectedPaths, [command]).length > 0; } catch { return false; }
  }
  return command.evidenceCapability === "invariant" ? rows.length > 0 : expectedPaths.length > 0;
}

function semanticCommandRank(command: VerificationCatalogEntry, rows: readonly InvariantMatrixRow[]): number {
  if (rows.length > 0 && command.evidenceCapability === "invariant") return 0;
  if (command.evidenceCapability === "targeted-test") return 1;
  if (command.evidenceCapability === "path-bound") return 2;
  if (command.evidenceCapability === "regression") return 3;
  return 4;
}

function matchLegacyCommand(
  entry: string,
  commands: VerificationCatalog["commands"],
): VerificationCatalogEntry | undefined {
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

function selectedCommandIds(
  packet: Pick<BuildPacketPayload, "verificationRequirements">,
  catalog: readonly VerificationCatalogEntry[],
): Set<string> {
  const ids = packet.verificationRequirements?.length
    ? new Set(packet.verificationRequirements.filter((requirement) => requirement.kind === "command").map((requirement) => requirement.id))
    : new Set(catalog.map((command) => command.id));
  for (const command of catalog) {
    if (command.selection === "always" || command.id === "diff-check") ids.add(command.id);
  }
  return ids;
}

function selectedCatalogCommands(
  packet: Pick<BuildPacketPayload, "verificationRequirements">,
  catalog: readonly VerificationCatalogEntry[],
): VerificationCatalogEntry[] {
  const ids = selectedCommandIds(packet, catalog);
  return catalog.filter((command) => ids.has(command.id));
}

async function packetVerificationPolicyMetadata(
  packet: Pick<BuildPacketPayload, "expectedPaths" | "verificationRequirements">,
  catalog: readonly VerificationCatalogEntry[],
  readOnlyCandidates: readonly string[] = [],
  cwd = process.cwd(),
  optionalReadOnlyCandidates: readonly string[] = [],
): Promise<Pick<BuildPacketPayload, "verificationPolicyVersion" | "verificationCommandTargets" | "verificationCommandIdentities">> {
  const selected = selectedCatalogCommands(packet, catalog);
  if (!selected.length) return {};
  const policyVersions = [...new Set(selected.map((command) => command.policyVersion).filter((value): value is string => Boolean(value)))];
  const [policyVersion, ...additionalPolicyVersions] = policyVersions;
  if (additionalPolicyVersions.length) throw new Error("Selected verification catalog mixes incompatible policy versions");
  const targeted = selected.filter((command) => command.targeting === "expected-test-paths");
  if (targeted.length) validateVerificationTargetPaths(packet.expectedPaths, targeted);
  const readOnlySourcePaths = targeted.length
    ? await resolveReadOnlyVerificationSources(readOnlyCandidates, targeted, cwd, { optionalCandidates: optionalReadOnlyCandidates })
    : [];
  const sourceTestPaths = [...new Set([...packet.expectedPaths.filter(isExpectedTestPath), ...readOnlySourcePaths])];
  const expectedTestPaths = targeted.length ? resolveVerificationTargets(packet.expectedPaths, targeted, readOnlySourcePaths) : [];
  return {
    ...(policyVersion !== undefined ? { verificationPolicyVersion: policyVersion } : {}),
    verificationCommandTargets: selected.map((command) => {
      const targets = command.targeting === "expected-test-paths" ? expectedTestPaths : [];
      return {
        id: command.id,
        targets,
        ...(targets.length && readOnlySourcePaths.length ? { sourceTargets: sourceTestPaths, targetDigest: createHash("sha256").update(JSON.stringify({ sourceTargets: sourceTestPaths, targets })).digest("hex") } : {}),
      };
    }),
    verificationCommandIdentities: selected.map((command) => ({
      id: command.id,
      command: command.command,
      args: [...command.args],
      ...(command.evidenceCapability !== undefined ? { evidenceCapability: command.evidenceCapability } : {}),
      ...(command.targeting !== undefined ? { targeting: command.targeting } : {}),
      identityDigest: verificationCommandIdentityDigest(command),
    })),
  };
}

function verificationCommandIdentityDigest(command: Pick<VerificationCommand, "command" | "args" | "evidenceCapability" | "targeting" | "policyVersion">): string {
  return createHash("sha256").update(JSON.stringify({
    command: command.command,
    args: [...command.args],
    evidenceCapability: command.evidenceCapability,
    targeting: command.targeting,
    policyVersion: command.policyVersion,
  })).digest("hex");
}
/** Materialize the exact bounded command plan selected by one frozen packet. */
export function selectPacketVerificationCommands(
  packet: Pick<BuildPacketPayload, "expectedPaths" | "verificationRequirements" | "verificationPolicyVersion" | "verificationCommandTargets" | "verificationCommandIdentities"> & Partial<Pick<BuildPacketPayload, "acceptanceCriteria" | "controllerGates" | "invariantMatrices" | "evidencePaths" | "evidenceContract" | "relationGraph">>,
  catalog: readonly Omit<VerificationCommand, "cwd">[],
  baseSha: string,
): Array<Omit<VerificationCommand, "cwd">> {
  if (!/^[0-9a-f]{7,64}$/i.test(baseSha)) throw new Error(`Cannot freeze verification plan for invalid base SHA ${baseSha}`);
  if (packet.relationGraph && process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT === "1") {
    if (!packet.relationGraph.checkpointId || !packet.relationGraph.checkpointDigest) throw new Error("[graph-authority] Frozen relation graph is missing its checkpoint identity");
    if (packet.relationGraph.baseSha.toLowerCase() !== baseSha.toLowerCase()) throw new Error("[graph-drift] Frozen relation graph base SHA differs from selected revision");
    const closureDigest = digestRelation({
      graphDigest: packet.relationGraph.graphDigest,
      writablePaths: [...packet.relationGraph.writablePaths].sort(),
      evidencePaths: [...packet.relationGraph.evidencePaths].sort(),
      invariantIds: [...packet.relationGraph.invariantIds].sort(),
      commandIds: [...packet.relationGraph.commandIds].sort(),
    });
    if (closureDigest !== packet.relationGraph.closureDigest) throw new Error("[graph-drift] Frozen relation graph closure digest does not match its paths");
    if (JSON.stringify([...packet.expectedPaths].sort()) !== JSON.stringify([...packet.relationGraph.writablePaths].sort())) throw new Error("[graph-drift] Relation graph writable closure does not match packet expectedPaths");
    const declaredEvidence = (packet.evidencePaths ?? []).map(({ path }) => path).sort();
    if (declaredEvidence.some((path) => !packet.relationGraph?.evidencePaths.includes(path))) throw new Error("[graph-drift] Packet evidence path is outside frozen relation graph evidence closure");
    const currentCommandPlanDigest = graphCommandPlanDigest({
      verificationPolicyVersion: packet.verificationPolicyVersion,
      verificationCommandTargets: packet.verificationCommandTargets,
      verificationCommandIdentities: packet.verificationCommandIdentities,
    });
    if (currentCommandPlanDigest !== packet.relationGraph.commandPlanDigest) throw new Error("[graph-drift] Frozen relation graph command-plan digest differs from packet metadata");
    if (graphEvidenceContractDigest(packet.evidenceContract) !== packet.relationGraph.evidenceContractDigest) throw new Error("[graph-drift] Frozen relation graph evidence-contract digest differs from packet metadata");
  }
  const commandById = new Map<string, Omit<VerificationCommand, "cwd">>();
  for (const command of catalog) {
    if (commandById.has(command.id)) throw new Error(`Verification catalog contains duplicate command ID '${command.id}'`);
    commandById.set(command.id, command);
  }

  for (const identity of packet.verificationCommandIdentities ?? []) {
    const command = commandById.get(identity.id);
    if (!command) throw new Error(`Frozen Build Packet references unavailable verification command '${identity.id}'`);
    const expectedDigest = verificationCommandIdentityDigest(command);
    if (identity.identityDigest !== expectedDigest
      || identity.command !== command.command
      || JSON.stringify(identity.args) !== JSON.stringify([...command.args])
      || identity.evidenceCapability !== command.evidenceCapability
      || identity.targeting !== command.targeting) {
      throw new Error(`[command-drift] Frozen verification command '${identity.id}' executable identity or capability metadata differs from the current catalog`);
    }
  }

  for (const requirement of packet.verificationRequirements ?? []) {
    if (requirement.kind === "command" && !commandById.has(requirement.id)) {
      throw new Error(`Frozen Build Packet references unavailable verification command '${requirement.id}'`);
    }
  }

  const typedRequirements = packet.verificationRequirements;
  const selectedIds = selectedCommandIds(packet, catalog);
  for (const id of selectedIds) {
    if (!commandById.has(id)) throw new Error(`Frozen Build Packet references unavailable verification command '${id}'`);
  }

  if (packet.relationGraph && process.env.FORGEDOCK_STRICT_RELATION_CHECKPOINT === "1") {
    const frozenCommandIds = [...packet.relationGraph.commandIds].sort();
    const selectedCommandIds = [...selectedIds].sort();
    if (JSON.stringify(frozenCommandIds) !== JSON.stringify(selectedCommandIds)) throw new Error("[graph-drift] Frozen relation graph command IDs do not match packet-selected commands");
  }

  const frozenTargetById = new Map((packet.verificationCommandTargets ?? []).map((entry) => [entry.id, entry]));
  const targetedCommands = catalog.filter((command) => selectedIds.has(command.id) && command.targeting === "expected-test-paths");
  const hasFrozenEvidenceContract = packet.evidenceContract?.version === "forgedock.evidence/v1";
  const selectionDiagnostics: string[] = [];
  let expectedTestPaths: string[] = [];
  try {
    if (targetedCommands.length && !packet.verificationCommandTargets) validateVerificationTargetPaths(packet.expectedPaths, targetedCommands);
    expectedTestPaths = targetedCommands.length
      ? packet.verificationCommandTargets
        ? [...new Set(targetedCommands.flatMap((command) => frozenTargetById.get(command.id)?.targets ?? []))]
        : resolveVerificationTargets(packet.expectedPaths, targetedCommands)
      : [];
    for (const command of targetedCommands) {
      const frozen = frozenTargetById.get(command.id);
      if (!frozen && hasFrozenEvidenceContract) selectionDiagnostics.push(`[target-drift] Missing frozen targets for verification command '${command.id}'`);
      if (frozen && !frozen.sourceTargets) {
        const legacyTargets = resolveVerificationTargets(packet.expectedPaths, [command]);
        if (JSON.stringify(legacyTargets) !== JSON.stringify(frozen.targets)) selectionDiagnostics.push(`[target-drift] Frozen verification command '${command.id}' targets differ from its legacy source paths`);
      }
      if (frozen?.targetDigest) {
        const sourceTargets = frozen.sourceTargets ?? [];
        const digest = createHash("sha256").update(JSON.stringify({ sourceTargets, targets: frozen.targets })).digest("hex");
        if (digest !== frozen.targetDigest) selectionDiagnostics.push(`[target-drift] Frozen targets for '${command.id}' have an invalid digest`);
      }
    }
  } catch (error) {
    if (!hasFrozenEvidenceContract) throw error;
    selectionDiagnostics.push(`[target-drift] ${error instanceof Error ? error.message : String(error)}`);
  }
  const targetedSelected = catalog.some((command) => selectedIds.has(command.id) && command.targeting === "expected-test-paths");
  if (typedRequirements?.length && expectedTestPaths.length && !targetedSelected) {
    selectionDiagnostics.push("[target-drift] Build Packet declares expected test paths without selecting the targeted test command");
  }

  const selected = catalog.filter((command) => selectedIds.has(command.id)).map((command) => {
    if (command.targeting === undefined) return { ...command };
    if (command.targeting !== "expected-test-paths") {
      throw new Error(`Verification command '${command.id}' has unsupported targeting policy`);
    }
    if (!expectedTestPaths.length && typedRequirements?.length) {
      if (!hasFrozenEvidenceContract) {
        throw new Error(`Verification command '${command.id}' requires at least one expected test path`);
      }
      selectionDiagnostics.push(`[target-drift] Verification command '${command.id}' requires at least one expected test path`);
    }
    return {
      ...command,
      args: [...command.args, ...expectedTestPaths],
      targets: expectedTestPaths,
    };
  });
  const policyDiagnostics: string[] = [];
  if (packet.verificationPolicyVersion) {
    const mismatched = selected.filter((command) => command.policyVersion !== packet.verificationPolicyVersion);
    if (mismatched.length) {
      policyDiagnostics.push(`[policy-mismatch] Frozen verification policy ${packet.verificationPolicyVersion} does not match command(s): ${mismatched.map((command) => command.id).join(", ")}`);
    }
  }
  const actualTargets = selected.map((command) => ({ id: command.id, targets: [...(command.targets ?? [])] }));
  const frozenExecutableTargets = packet.verificationCommandTargets?.map(({ id, targets }) => ({ id, targets: [...targets] }));
  if (frozenExecutableTargets
    && JSON.stringify(actualTargets) !== JSON.stringify(frozenExecutableTargets)) {
    policyDiagnostics.push("[target-drift] Frozen verification command targets do not match the executable packet-selected plan");
  }
  if (!hasFrozenEvidenceContract) {
    if (selectionDiagnostics.length) throw new Error(selectionDiagnostics.join("\\n"));
    if (policyDiagnostics.length) throw new Error(policyDiagnostics.join("\\n"));
  }
  if (selected.length && !selected.some((command) => command.required)) throw new Error("Selected verification plan has no required command");

  let evidenceContractDigest: string | undefined;
  if (hasFrozenEvidenceContract) {
    const evidenceDiagnostics = [...selectionDiagnostics, ...policyDiagnostics];
    for (const declaration of packet.evidencePaths ?? []) {
      try {
        canonicalEvidencePath(declaration.path);
      } catch (error) {
        evidenceDiagnostics.push(`[invalid-evidence-path] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const command of selected) {
      if (command.evidenceCapability === undefined) {
        evidenceDiagnostics.push(`[missing-capability] Selected command '${command.id}' has no evidenceCapability metadata`);
      }
    }
    const actualContractInput: EvidenceContractInput = {
      acceptanceCriteria: packet.acceptanceCriteria ?? [],
      ...(packet.verificationRequirements ? { verificationRequirements: packet.verificationRequirements } : {}),
      ...(packet.controllerGates ? { controllerGates: packet.controllerGates } : {}),
      commands: selected.map(({ id, evidenceCapability, targets }) => ({
        id,
        ...(evidenceCapability !== undefined ? { evidenceCapability } : {}),
        ...(targets !== undefined ? { targets } : {}),
      })),
      ...(packet.invariantMatrices ? { invariantMatrices: packet.invariantMatrices } : {}),
      expectedPaths: packet.expectedPaths,
      ...(packet.evidencePaths ? { evidencePaths: packet.evidencePaths } : {}),
    };
    const contractDiagnostics = validateEvidenceContract(packet.evidenceContract!, actualContractInput);
    evidenceDiagnostics.push(...contractDiagnostics.map(diagnosticText));
    evidenceContractDigest = createHash("sha256").update(JSON.stringify(packet.evidenceContract)).digest("hex");
    if (evidenceDiagnostics.length) {
      throw new Error([
        "Evidence contract revalidation failed; executable verification plan was not authorized:",
        ...evidenceDiagnostics.map((diagnostic) => `- ${diagnostic}`),
        "Evidence-path existence at the requested base SHA cannot be validated here without workspace/cwd; integration must perform that read-only check.",
      ].join("\\n"));
    }
  }
  const planId = createHash("sha256").update(JSON.stringify({
    baseSha: baseSha.toLowerCase(),
    evidenceContractIdentity: packet.evidenceContract?.version,
    evidenceContractDigest,
    commands: selected.map(({ id, command, args, timeoutMs, required, policyVersion, targets, lockScope, typescriptLayout, cleanOutputRoot, evidenceCapability }) => ({
      id, command, args, timeoutMs, required, policyVersion, targets, lockScope, typescriptLayout, cleanOutputRoot, evidenceCapability,
    })),
  })).digest("hex").slice(0, 16);
  return selected.map((command) => ({ ...command, planId }));
}
