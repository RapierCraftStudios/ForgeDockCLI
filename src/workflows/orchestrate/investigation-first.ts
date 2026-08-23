// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { assertArtifact, createArtifact, type DurableArtifact, type Subject } from "../../core/artifacts/schema.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type {
  OrchestrationExecutionMaterializer,
  OrchestrationInvestigationWorker,
  OrchestrationPacketWorker,
} from "./controller.js";
import type { OrchestrationRecord, OrchestrationInvestigationRecord, OrchestrationPacketIdentity, OrchestrationSemanticAttempt } from "../../core/ports/orchestration.js";
import type { ScheduledWorkItem, ClaimSerializationEdge } from "./scheduler.js";
import { investigateWorkItem, resumeInvestigationWorkItem } from "../work-on/investigate.js";
import { prepareBuildPacket, type VerificationCatalog } from "../work-on/prepare.js";
import { STANDARD_SCOPE_METADATA_ROOTS, scopeManifestForBuildPacket, type AgentRuntime } from "../../runtime/agent-runtime.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import type { ThinkingLevel } from "../../core/config/forgedock-config.js";
import { materializeClaimDependencies } from "./scheduler.js";
import { compileExecutionDag, normalizePacketPaths, normalizeSemanticDependencies } from "./packet-wave.js";

const execFile = promisify(execFileCallback);

export interface InvestigationFirstIssue {
  title: string;
  body: string;
  url: string;
}

export interface InvestigationFirstRoute {
  issue: InvestigationFirstIssue;
  targetBranch: string;
  lane: "fast" | "feature";
  promotionTarget?: string;
  productionTarget?: string;
  /** Exact branch head observed during route resolution. */
  baseSha?: string;
}

export interface InvestigationFirstFactoryOptions {
  repository: string;
  checkoutRoot: string;
  runtime: AgentRuntime;
  artifacts: ArtifactRepository;
  runs: RunRepository;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  planning?: Record<string, unknown>;
  productionTarget?: string;
  resolveRoute(item: ScheduledWorkItem): Promise<InvestigationFirstRoute>;
  getBranchHead(repository: string, branch: string): Promise<string>;
  verificationCatalog?: VerificationCatalog;
  /** Initial frozen nodes, and the authoritative nodes when resuming. */
  sourceItems(orchestration: Readonly<OrchestrationRecord>, initialItems: readonly ScheduledWorkItem[]): readonly ScheduledWorkItem[];
  /** Resolve a decompose result into the bounded next investigation wave. */
  materializeDecomposition(input: {
    orchestration: Readonly<OrchestrationRecord>;
    item: ScheduledWorkItem;
    childIssues: readonly number[];
    signal?: AbortSignal;
    assertActive?: () => void;
  }): Promise<{ items: readonly ScheduledWorkItem[] } | undefined>;
  childIssuesFor?(entry: OrchestrationInvestigationRecord): Promise<readonly number[]>;
}

export interface InvestigationFirstWorkers {
  investigationWorker: OrchestrationInvestigationWorker;
  packetWorker: OrchestrationPacketWorker;
  materializeExecution: OrchestrationExecutionMaterializer;
}

/**
 * Shared controller-owned investigation phase wiring.  The caller supplies
 * route and decomposition authority; this module owns the read-only intent /
 * investigation contract and the phase-2 admission filter.  It is deliberately
 * independent of the CLI and Pi/TUI transports.
 */
export function createInvestigationFirstWorkers(
  options: InvestigationFirstFactoryOptions,
  initialItems: readonly ScheduledWorkItem[],
): InvestigationFirstWorkers {
  const investigationWorker: OrchestrationInvestigationWorker = async (item, context) => {
    const route = await options.resolveRoute(item);
    const reservation = context.semanticAttempt;
    if (reservation) assertSemanticReservation(reservation, context.orchestrationId, item, context.wave, route.baseSha, options.repository);
    const subject = { repo: item.repository ?? options.repository, issue: item.issue };
    const intent = createArtifact({
      kind: "Intent",
      runId: reservation?.runId ?? `run_${crypto.randomUUID()}`,
      subject,
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        title: route.issue.title,
        problem: route.issue.body || route.issue.title,
        constraints: [],
        acceptanceHints: [],
        dependencies: [...item.dependencies],
        sourceUrl: route.issue.url,
      },
    }, { ...(reservation ? { id: reservation.intentId } : {}) });
    await context.recordTask({ runId: intent.runId });
    const baseSha = reservation?.baseSha ?? await contextBaseSha(options, route, item);
    if (reservation?.baseSha !== undefined && reservation.baseSha && reservation.baseSha.toLowerCase() !== baseSha.toLowerCase()) {
      throw new Error(`Investigation ${item.id} exact base ${baseSha} does not match reserved base ${reservation.baseSha}`);
    }
    if (reservation) {
      const existing = (await options.artifacts.list(subject, "Investigation"))
        .filter((artifact): artifact is DurableArtifact<"Investigation"> => artifact.id === reservation.investigationId && artifact.runId === reservation.runId);
      if (existing.length > 1) throw new Error(`Investigation ${item.id} has duplicate reserved Investigation ${reservation.investigationId}`);
      if (existing.length === 1) {
        const investigation = existing[0]!;
        assertArtifact(investigation);
        const run = await options.runs.load(reservation.runId);
        if (!run) throw new Error(`Investigation ${item.id} reserved run ${reservation.runId} is missing while artifact exists`);
        return {
          outcome: investigation.payload.outcome,
          baseSha,
          evidence: { investigationId: investigation.id, runId: run.runId, baseSha, rootCause: investigation.payload.rootCause ?? null, summary: investigation.payload.summary, affectedSurfaces: investigation.payload.affectedSurfaces },
          ...(investigation.payload.decomposition !== undefined ? { childIssues: [] } : {}),
        };
      }
    }
    await assertExactCheckout(options.checkoutRoot, baseSha);
    const investigated = await investigateWorkItem({
      intent,
      cwd: options.checkoutRoot,
      target: {
        lane: route.lane,
        targetBranch: route.targetBranch,
        ...(route.promotionTarget !== undefined ? { promotionTarget: route.promotionTarget } : {}),
        ...(options.productionTarget !== undefined ? { productionTarget: options.productionTarget } : {}),
      },
      deferInterpretation: true,
      scopeHints: {
        affectedFiles: item.affectedFiles ?? [],
        claims: item.claims,
        metadataRoots: STANDARD_SCOPE_METADATA_ROOTS,
      },
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.thinking !== undefined ? { thinking: options.thinking } : {}),
      ...(options.planning ?? {}),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      ...(reservation ? { reservation, investigationId: reservation.investigationId } : {}),
    }, { runtime: options.runtime, artifacts: options.artifacts, runs: options.runs, ...(context.signal !== undefined ? { signal: context.signal } : {}), assertActive: context.assertActive });
    if (context.signal?.aborted) throw context.signal.reason ?? new Error("Investigation cancelled before interpretation");
    await assertExactCheckout(options.checkoutRoot, baseSha);
    const observedBaseSha = await options.getBranchHead(item.repository ?? options.repository, route.targetBranch);
    if (observedBaseSha !== baseSha) {
      const drift = new Error(`Investigation base drifted for ${item.id}: expected ${baseSha}, observed ${observedBaseSha}`);
      Object.assign(drift, { code: "base-drift", domain: "workflow" });
      throw drift;
    }
    const payload = investigated.investigation.payload;
    return {
      outcome: payload.outcome,
      baseSha,
      evidence: {
        investigationId: investigated.investigation.id,
        runId: intent.runId,
        baseSha,
        rootCause: payload.rootCause ?? null,
        summary: payload.summary,
        affectedSurfaces: payload.affectedSurfaces,
      },
      ...(payload.decomposition !== undefined ? { childIssues: [] } : {}),
    };
  };

  const packetWorker: OrchestrationPacketWorker = async (item, context) => {
    const route = await options.resolveRoute(item);
    const reservation = context.semanticAttempt ?? context.investigation.reservation;
    if (reservation) assertSemanticReservation(reservation, context.orchestrationId, item, context.wave, route.baseSha, options.repository);
    const checkpoint = await loadExactInvestigationCheckpoint(options, item, context.investigation);
    const baseSha = await resolveExactBaseSha(options, item, route, checkpoint.investigation, context.investigation);
    assertRouteMatchesCheckpoint(route, checkpoint.run, context.investigation, item.id);
    await assertExactCheckout(options.checkoutRoot, baseSha);

    let run = checkpoint.run;
    if (run.state === "investigating") {
      const resumed = await resumeInvestigationWorkItem({
        run,
        intent: checkpoint.intent,
        investigation: checkpoint.investigation,
        cwd: options.checkoutRoot,
        target: {
          lane: route.lane,
          targetBranch: route.targetBranch,
          ...(route.promotionTarget !== undefined ? { promotionTarget: route.promotionTarget } : {}),
          ...(options.productionTarget !== undefined ? { productionTarget: options.productionTarget } : {}),
        },
        scopeHints: {
          affectedFiles: item.affectedFiles ?? [],
          claims: item.claims,
          metadataRoots: STANDARD_SCOPE_METADATA_ROOTS,
        },
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
      }, {
        runtime: options.runtime,
        artifacts: options.artifacts,
        runs: options.runs,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        assertActive: context.assertActive,
      });
      run = resumed.run;
      if (run.state !== "preparing") {
        throw new Error(`Packet ${item.id} investigation recovery ended in ${run.state}, expected preparing`);
      }
    }

    if (run.state === "building") {
      const packet = reusableBuildPacket(checkpoint.artifacts, run, checkpoint.subject, baseSha, item.id, checkpoint.investigation, reservation);
      await assertExactCheckout(options.checkoutRoot, baseSha);
      const observed = await options.getBranchHead(item.repository ?? options.repository, route.targetBranch);
      assertExactSha(`Packet ${item.id} base`, baseSha, observed);
      await context.recordTask({ runId: run.runId });
      return {
        packetId: packet.id,
        identity: packetIdentity(item, packet.id, run, checkpoint.investigation, baseSha, reservation),
        expectedPaths: packet.payload.expectedPaths,
        semanticDependencies: item.dependencies,
        baseSha,
      };
    }

    if (run.state !== "preparing") {
      throw new Error(`Packet ${item.id} requires preparing or building state, found ${run.state}`);
    }
    const orphan = findReusableBuildPacket(checkpoint.artifacts, run, checkpoint.subject, baseSha, item.id, checkpoint.investigation, reservation);
    if (orphan) {
      const scopeManifest = scopeManifestForBuildPacket(
        normalizePacketPaths(orphan.payload.expectedPaths),
        (orphan.payload.evidencePaths ?? []).map(({ path }) => path),
      );
      context.assertActive();
      const advanced = transition(run, "BUILD_PACKET_READY", { scopeManifest });
      await options.runs.commit(run.version, advanced.state, advanced.record);
      context.assertActive();
      run = advanced.state;
      await context.recordTask({ runId: run.runId });
      return {
        packetId: orphan.id,
        identity: packetIdentity(item, orphan.id, run, checkpoint.investigation, baseSha, reservation),
        expectedPaths: orphan.payload.expectedPaths,
        semanticDependencies: item.dependencies,
        baseSha,
      };
    }

    const prepared = await prepareBuildPacket({
      run,
      intent: checkpoint.intent,
      investigation: checkpoint.investigation,
      cwd: options.checkoutRoot,
      baseSha,
      scopeHints: { affectedFiles: item.affectedFiles ?? [], claims: item.claims, metadataRoots: STANDARD_SCOPE_METADATA_ROOTS },
      ...(options.verificationCatalog !== undefined ? { verificationCatalog: options.verificationCatalog } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.thinking !== undefined ? { planningThinking: options.thinking } : {}),
      ...(options.planning ?? {}),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
      ...(reservation ? { reservation, packetId: reservation.packetId } : {}),
    }, { runtime: options.runtime, artifacts: options.artifacts, runs: options.runs, assertActive: context.assertActive });
    await assertExactCheckout(options.checkoutRoot, baseSha);
    const observed = await options.getBranchHead(item.repository ?? options.repository, route.targetBranch);
    assertExactSha(`Packet ${item.id} base`, baseSha, observed);
    await context.recordTask({ runId: prepared.run.runId });
    return {
      packetId: prepared.packet.id,
      identity: packetIdentity(item, prepared.packet.id, prepared.run, checkpoint.investigation, baseSha, reservation),
      expectedPaths: prepared.packet.payload.expectedPaths,
      semanticDependencies: item.dependencies,
      baseSha,
    };
  };

  const materializeExecution: OrchestrationExecutionMaterializer = async ({ orchestration, investigations, packets, signal, assertActive }) => {
    const assertMaterializationActive =(): void => {
      if (signal?.aborted) throw signal.reason ?? new Error("Investigation cancelled before materialization side effect");
      assertActive?.();
    };
    assertMaterializationActive();
    // Every completed wave is part of the frozen investigation history. The
    // execution handoff must therefore be a monotonic union, not the latest
    // wave's projection (the latter silently dropped wave-one work in live
    // DAGs). The source adapter returns the exact durable item contracts,
    // including claims, routes, dependencies, and plan metadata.
    const allInvestigations = [...(orchestration.investigations ?? [])];
    const confirmed = new Set(allInvestigations
      .filter((entry) => entry.status === "completed" && entry.outcome === "confirmed")
      .map((entry) => entry.nodeId));
    const sourceItems = options.sourceItems(orchestration, initialItems);
    const byId = new Map<string, ScheduledWorkItem>();
    const byIssue = new Map<string, ScheduledWorkItem>();
    for (const source of sourceItems) {
      if (byId.has(source.id)) continue;
      byId.set(source.id, structuredClone(source));
      const issueKey = `${(source.repository ?? options.repository).trim().toLowerCase()}#${source.issue}`;
      if (byIssue.has(issueKey)) throw new Error(`Investigation materialization returned duplicate issue ${issueKey}`);
      byIssue.set(issueKey, source);
    }
    const replacements = new Map<string, { childIssues: number[]; childNodeIds: string[] }>();
    for (const node of orchestration.nodes) {
      if (node.decompositionChildren?.length) {
        const parentRepository = (node.repository ?? options.repository).trim().toLowerCase();
        const children = node.decompositionChildren.map((issue) => {
          const match = [...byId.values()].find((candidate) =>
            (candidate.repository ?? options.repository).trim().toLowerCase() === parentRepository
            && candidate.issue === issue,
          );
          return { issue, id: match?.id };
        });
        replacements.set(node.id, {
          childIssues: children.map(({ issue }) => issue),
          childNodeIds: children.flatMap(({ id }) => id === undefined ? [] : [id]),
        });
      }
    }
    const reroute = (item: ScheduledWorkItem): ScheduledWorkItem => {
      const dependencies = [...new Set(item.dependencies.flatMap((dependency) => {
        const replacement = replacements.get(dependency);
        return replacement ? replacement.childNodeIds : [dependency];
      }))];
      return dependencies.length === item.dependencies.length
        ? item
        : { ...item, dependencies };
    };
    const items = [...byId.values()]
      .filter((item) => confirmed.has(item.id))
      .map(reroute);
    const initialItemIds = new Set(items.map((item) => item.id));
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      const dependencies = item.dependencies.filter((dependency) => initialItemIds.has(dependency));
      if (dependencies.length !== item.dependencies.length) items[index] = { ...item, dependencies };
    }
    if (new Set(items.map((item) => `${(item.repository ?? options.repository).trim().toLowerCase()}#${item.issue}`)).size !== items.length) {
      throw new Error("Investigation materialization returned duplicate confirmed issues");
    }
    let executionItems = items;
    let executionEdges: ClaimSerializationEdge[];
    if (packets !== undefined) {
      const packetById = new Map<string, typeof packets[number]>();
      const packetIds = new Set<string>();
      const packetNodeIds = new Set<string>();
      for (const packet of packets) {
        if (packetNodeIds.has(packet.nodeId)) throw new Error(`Duplicate durable packet identity for ${packet.nodeId}`);
        packetNodeIds.add(packet.nodeId);
        if (packet.packetId !== undefined) {
          if (packetIds.has(packet.packetId)) throw new Error(`Duplicate packet identity ${packet.packetId}`);
          packetIds.add(packet.packetId);
        }
        if (packet.status === "completed") packetById.set(packet.nodeId, packet);
      }
      const confirmedPacketIds = new Set(items.map((item) => item.id));
      const packetInputs = items.map((item) => {
        const packet = packetById.get(item.id);
        if (!packet?.expectedPaths?.length || !packet.baseSha) throw new Error(`Packet barrier has no durable packet for ${item.id}`);
        if (packet.semanticDependencies === undefined) throw new Error(`Packet ${item.id} lacks authoritative semantic dependency evidence`);
        const semanticDependencies = normalizeSemanticDependencies(packet.semanticDependencies);
        if (semanticDependencies.some((dependency) => !confirmedPacketIds.has(dependency))) {
          throw new Error(`Packet ${item.id} references unknown semantic dependency`);
        }
        return {
          id: item.id,
          issue: item.issue,
          expectedPaths: normalizePacketPaths(packet.expectedPaths),
          baseRef: packet.baseSha,
          semanticDependencies,
          ...(item.memberIssues !== undefined ? { childIssues: item.memberIssues } : {}),
        };
      });
      if (!packetInputs.length) {
        executionItems = [];
        executionEdges = [];
      } else {
        const baseRef = packetInputs[0]!.baseRef;
        if (packetInputs.some((packet) => packet.baseRef !== baseRef)) throw new Error("Packet barrier contains multiple or missing exact bases");
        const compiled = compileExecutionDag({ items, packets: packetInputs, baseRef });
        executionItems = compiled.items;
        executionEdges = compiled.edges;
      }
    } else {
      executionEdges = materializeClaimDependencies(items).edges;
    }
    const itemsForExecution = executionItems;
    const itemIds = new Set(itemsForExecution.map((item) => item.id));
    const nextInvestigationItems: ScheduledWorkItem[] = [];
    const decompositionReplacements: { parentNodeId: string; childIssues: number[]; childNodeIds: string[] }[] = [];
    for (const entry of allInvestigations.filter((candidate) => candidate.wave === orchestration.investigationWave && candidate.outcome === "decompose")) {
      assertMaterializationActive();
      const parent = orchestration.nodes.find((node) => node.id === entry.nodeId);
      if (!parent) throw new Error(`Decomposition parent ${entry.nodeId} is missing from the durable investigation set`);
      const expansion = await options.materializeDecomposition({
        orchestration,
        item: sourceItems.find((candidate) => candidate.id === entry.nodeId) ?? {
          id: parent.id, issue: parent.issue, priority: parent.priority, dependencies: [], claims: [],
        },
        childIssues: await options.childIssuesFor?.(entry) ?? [],
        ...(signal !== undefined ? { signal } : {}),
        assertActive: assertMaterializationActive,
      });
      if (expansion) {
        const expanded = expansion.items.map((child) => structuredClone(child));
        nextInvestigationItems.push(...expanded);
        decompositionReplacements.push({
          parentNodeId: entry.nodeId,
          childIssues: expanded.map((child) => child.issue),
          childNodeIds: expanded.map((child) => child.id),
        });
      }
    }
    return {
      items: itemsForExecution,
      serializationEdges: executionEdges,
      ...(nextInvestigationItems.length ? { nextInvestigationItems } : {}),
      ...(decompositionReplacements.length ? { decompositionReplacements } : {}),
    };
  };
  return { investigationWorker, packetWorker, materializeExecution };
}

interface InvestigationCheckpoint {
  subject: Subject;
  run: RunState;
  intent: DurableArtifact<"Intent">;
  investigation: DurableArtifact<"Investigation">;
  artifacts: readonly DurableArtifact[];
}

async function loadExactInvestigationCheckpoint(
  options: InvestigationFirstFactoryOptions,
  item: ScheduledWorkItem,
  record: OrchestrationInvestigationRecord,
): Promise<InvestigationCheckpoint> {
  const subject = { repo: item.repository ?? options.repository, issue: item.issue };
  if (record.reservation && record.reservation.repository !== subject.repo.trim().toLowerCase()) {
    throw new Error(`Packet ${item.id} investigation repository does not match reserved repository`);
  }
  if (record.nodeId !== item.id) {
    throw new Error(`Packet ${item.id} investigation node ${record.nodeId} does not match scheduled node`);
  }
  if (record.issue !== item.issue) {
    throw new Error(`Packet ${item.id} investigation issue ${record.issue} does not match scheduled issue ${item.issue}`);
  }
  const reservation = record.reservation;
  const runId = (record.runId ?? reservation?.runId)?.trim();
  if (!runId) throw new Error(`Packet ${item.id} has no durable investigation run`);
  const investigationId = (record.investigationArtifactId ?? reservation?.investigationId)?.trim();
  if (!investigationId) throw new Error(`Packet ${item.id} has no durable Investigation artifact identity`);

  const run = await options.runs.load(runId);
  if (!run) throw new Error(`Packet ${item.id} investigation run ${runId} is missing`);
  if (run.workflow !== "work-on") throw new Error(`Packet ${item.id} investigation run ${runId} has workflow ${run.workflow}`);
  if (run.runId !== runId) throw new Error(`Packet ${item.id} loaded the wrong durable run ${run.runId}`);
  if (!sameSubject(run.subject, subject)) throw new Error(`Packet ${item.id} durable run subject does not match the scheduled issue`);

  const artifacts = await options.artifacts.list(subject);
  const intents = artifacts.filter((artifact): artifact is DurableArtifact<"Intent"> =>
    artifact.kind === "Intent" && artifact.runId === runId && sameSubject(artifact.subject, subject));
  if (intents.length !== 1) {
    throw new Error(`Packet ${item.id} requires exactly one durable Intent for run ${runId}; found ${intents.length}`);
  }
  const intent = intents[0]!;
  assertArtifact(intent);
  if (reservation && intent.id !== reservation.intentId) {
    throw new Error(`Packet ${item.id} Intent ${intent.id} does not match reserved Intent ${reservation.intentId}`);
  }
  const investigations = artifacts.filter((artifact): artifact is DurableArtifact<"Investigation"> =>
    artifact.kind === "Investigation"
      && artifact.runId === runId
      && sameSubject(artifact.subject, subject));
  if (investigations.length !== 1) {
    throw new Error(`Packet ${item.id} requires exactly one durable Investigation ${investigationId} for run ${runId}; found ${investigations.length}`);
  }
  if (investigations[0]!.id !== investigationId) {
    throw new Error(`Packet ${item.id} loaded Investigation ${investigations[0]!.id} instead of reserved ${investigationId}`);
  }
  const investigation = investigations[0]!;
  assertArtifact(investigation);
  if (investigation.payload.outcome !== "confirmed") {
    throw new Error(`Packet ${item.id} requires a confirmed durable Investigation, found ${investigation.payload.outcome}`);
  }
  if (record.outcome !== undefined && record.outcome !== "confirmed") {
    throw new Error(`Packet ${item.id} investigation record is ${record.outcome}, not confirmed`);
  }
  assertOptionalIdentity(record.evidence?.runId, runId, `Packet ${item.id} investigation evidence run`);
  assertOptionalIdentity(record.evidence?.investigationId, investigationId, `Packet ${item.id} investigation evidence artifact`);
  if (reservation) {
    if (reservation.runId !== runId || reservation.investigationId !== investigationId || reservation.issue !== item.issue) {
      throw new Error(`Packet ${item.id} investigation evidence does not match reserved semantic attempt ${reservation.semanticAttemptId}`);
    }
  }
  return { subject, run, intent, investigation, artifacts };
}

async function resolveExactBaseSha(
  options: InvestigationFirstFactoryOptions,
  item: ScheduledWorkItem,
  route: InvestigationFirstRoute,
  investigationArtifact: DurableArtifact<"Investigation">,
  record: OrchestrationInvestigationRecord,
): Promise<string> {
  const rawBaseSha = record.baseSha?.trim();
  if (!rawBaseSha) throw new Error(`Packet ${item.id} has no durable investigation base SHA`);
  const baseSha = rawBaseSha.toLowerCase();
  assertExactSha(`Packet ${item.id} durable investigation base`, baseSha, rawBaseSha);
  const evidenceBaseSha = typeof record.evidence?.baseSha === "string" ? record.evidence.baseSha : undefined;
  if (evidenceBaseSha !== undefined) assertExactSha(`Packet ${item.id} investigation evidence base`, baseSha, evidenceBaseSha);
  if (route.baseSha !== undefined) assertExactSha(`Packet ${item.id} route base`, baseSha, route.baseSha);
  const observed = await options.getBranchHead(item.repository ?? options.repository, route.targetBranch);
  assertExactSha(`Packet ${item.id} branch base`, baseSha, observed);
  // The Investigation artifact has no base field in its schema. Its identity is
  // nevertheless checked above through the orchestration record, which is the
  // controller-owned exact-base checkpoint for this phase.
  void investigationArtifact;
  return baseSha;
}

function assertRouteMatchesCheckpoint(
  route: InvestigationFirstRoute,
  run: RunState,
  record: OrchestrationInvestigationRecord,
  itemId: string,
): void {
  if (run.targetBranch !== undefined && run.targetBranch !== route.targetBranch) {
    throw new Error(`Packet ${itemId} durable run target ${run.targetBranch} does not match route ${route.targetBranch}`);
  }
  if (record.targetBranch !== undefined && record.targetBranch !== route.targetBranch) {
    throw new Error(`Packet ${itemId} investigation target ${record.targetBranch} does not match route ${route.targetBranch}`);
  }
  if (run.lane !== undefined && run.lane !== route.lane) {
    throw new Error(`Packet ${itemId} durable run lane ${run.lane} does not match route ${route.lane}`);
  }
  if (record.lane !== undefined && record.lane !== route.lane) {
    throw new Error(`Packet ${itemId} investigation lane ${record.lane} does not match route ${route.lane}`);
  }
  if (run.promotionTarget !== undefined && run.promotionTarget !== route.promotionTarget) {
    throw new Error(`Packet ${itemId} durable run promotion target does not match route`);
  }
}

function reusableBuildPacket(
  artifacts: readonly DurableArtifact[],
  run: RunState,
  subject: Subject,
  baseSha: string,
  itemId: string,
  investigation: DurableArtifact<"Investigation">,
  reservation?: OrchestrationSemanticAttempt,
): DurableArtifact<"BuildPacket"> {
  const packet = findReusableBuildPacket(artifacts, run, subject, baseSha, itemId, investigation, reservation);
  if (!packet) throw new Error(`Packet ${itemId} building recovery requires exactly one attached BuildPacket`);
  return packet;
}

/** Find one exact attached packet, or one uncommitted artifact from the append/commit crash window. */
function findReusableBuildPacket(
  artifacts: readonly DurableArtifact[],
  run: RunState,
  subject: Subject,
  baseSha: string,
  itemId: string,
  investigation: DurableArtifact<"Investigation">,
  reservation?: OrchestrationSemanticAttempt,
): DurableArtifact<"BuildPacket"> | undefined {
  const attachedIds = run.artifactIds.BuildPacket ?? [];
  if (attachedIds.length > 1 || (attachedIds.length === 1 && !attachedIds[0])) {
    throw new Error(`Packet ${itemId} has an ambiguous durable BuildPacket attachment`);
  }
  const allCandidates = artifacts.filter((artifact): artifact is DurableArtifact<"BuildPacket"> =>
    artifact.kind === "BuildPacket" && artifact.runId === run.runId && sameSubject(artifact.subject, subject));
  if (allCandidates.length > 1) throw new Error(`Packet ${itemId} has ambiguous durable BuildPacket artifacts`);
  const candidates = reservation === undefined
    ? allCandidates
    : allCandidates.filter((artifact) => artifact.id === reservation.packetId);
  const selected = attachedIds.length === 1
    ? candidates.filter((candidate) => candidate.id === attachedIds[0])
    : candidates;
  if (selected.length > 1) throw new Error(`Packet ${itemId} has ambiguous durable BuildPacket artifacts`);
  if (!selected.length) {
    if (attachedIds.length === 1) throw new Error(`Packet ${itemId} building recovery could not load exact BuildPacket ${attachedIds[0]}`);
    return undefined;
  }
  const packet = selected[0]!;
  assertArtifact(packet);
  if (!packet.payload.expectedPaths.length) throw new Error(`Packet ${itemId} durable BuildPacket has no expected paths`);
  normalizePacketPaths(packet.payload.expectedPaths);
  for (const packetBaseSha of [
    packet.payload.contextPackage?.baseSha,
    packet.payload.relationGraph?.baseSha,
    packet.payload.investigationScopeReceipt?.baseSha,
  ]) {
    if (packetBaseSha !== undefined) assertExactSha(`Packet ${itemId} BuildPacket base`, baseSha, packetBaseSha);
  }
  const investigationDigest = createHash("sha256").update(JSON.stringify(investigation.payload)).digest("hex");
  const receipt = packet.payload.investigationScopeReceipt;
  if (reservation && !receipt) throw new Error(`Packet ${itemId} reserved BuildPacket lacks investigation digest evidence`);
  if (receipt) {
    if (receipt.runId !== run.runId) throw new Error(`Packet ${itemId} BuildPacket scope receipt run identity drifted`);
    if (!sameSubject(receipt.subject, subject)) throw new Error(`Packet ${itemId} BuildPacket scope receipt subject drifted`);
    if (receipt.investigationId !== investigation.id) throw new Error(`Packet ${itemId} BuildPacket scope receipt investigation identity drifted`);
    if (receipt.investigationDigest !== investigationDigest) throw new Error(`Packet ${itemId} BuildPacket investigation digest drifted`);
  }
  if (reservation && packet.id !== reservation.packetId) {
    throw new Error(`Packet ${itemId} BuildPacket ${packet.id} is outside reserved packet identity ${reservation.packetId}`);
  }
  if (packet.payload.contextPackage?.investigationDigest !== undefined
    && packet.payload.contextPackage.investigationDigest !== investigationDigest) {
    throw new Error(`Packet ${itemId} BuildPacket context investigation digest drifted`);
  }
  return packet;
}

function packetIdentity(
  item: ScheduledWorkItem,
  packetId: string,
  run: RunState,
  investigation: DurableArtifact<"Investigation">,
  baseSha: string,
  reservation?: OrchestrationSemanticAttempt,
): OrchestrationPacketIdentity {
  if (reservation && packetId !== reservation.packetId) throw new Error(`Packet ${item.id} packet identity is not reserved`);
  return {
    nodeId: item.id,
    packetId,
    runId: run.runId,
    investigationId: investigation.id,
    subject: { repo: run.subject.repo, issue: item.issue },
    baseSha,
    ...(reservation ? { orchestrationId: reservation.orchestrationId, wave: reservation.wave, attempt: reservation.attempt, repository: reservation.repository } : {}),
  };
}

function assertSemanticReservation(
  reservation: OrchestrationSemanticAttempt,
  orchestrationId: string,
  item: ScheduledWorkItem,
  wave: number,
  routeBaseSha?: string,
  fallbackRepository = "",
): void {
  const repository = (item.repository ?? fallbackRepository).trim().toLowerCase();
  if (reservation.orchestrationId !== orchestrationId || reservation.nodeId !== item.id
    || reservation.wave !== wave || reservation.issue !== item.issue
    || reservation.repository !== repository) {
    throw new Error(`Semantic attempt ${reservation.semanticAttemptId} has wrong orchestration/node/wave/repository/issue identity`);
  }
  if (reservation.baseSha !== undefined && !/^[0-9a-f]{7,64}$/i.test(reservation.baseSha)) {
    throw new Error(`Semantic attempt ${reservation.semanticAttemptId} has malformed exact base`);
  }
  if (routeBaseSha !== undefined && reservation.baseSha && reservation.baseSha.toLowerCase() !== routeBaseSha.toLowerCase()) {
    throw new Error(`Semantic attempt ${reservation.semanticAttemptId} has exact-base drift`);
  }
  for (const key of ["runId", "intentId", "investigationId", "packetId"]) {
    const value = reservation[key as keyof OrchestrationSemanticAttempt];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Semantic attempt ${reservation.semanticAttemptId} lacks ${key}`);
  }
  if (!Number.isSafeInteger(reservation.attempt) || reservation.attempt < 1) throw new Error(`Semantic attempt ${reservation.semanticAttemptId} has invalid attempt`);
}

function assertOptionalIdentity(value: unknown, expected: string, label: string): void {
  if (value !== undefined && String(value) !== expected) throw new Error(`${label} does not match ${expected}`);
}

function assertExactSha(label: string, expected: string, observed: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(expected)) throw new Error(`${label} is not an exact SHA: ${expected}`);
  if (!/^[0-9a-f]{7,64}$/i.test(observed) || observed.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} drifted: expected ${expected}, observed ${observed}`);
  }
}

function sameSubject(left: Subject, right: Subject): boolean {
  return left.repo.trim().toLowerCase() === right.repo.trim().toLowerCase()
    && left.issue === right.issue
    && left.pr === right.pr;
}


async function assertExactCheckout(cwd: string, expectedSha: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFile("git", ["rev-parse", "HEAD"], { cwd, maxBuffer: 128 * 1024 }));
  } catch (error) {
    throw new Error(`Investigation requires an exact git checkout at ${expectedSha}`, { cause: error });
  }
  const observed = stdout.trim();
  if (observed.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(`Investigation checkout drifted: expected local HEAD ${expectedSha}, observed ${observed}`);
  }
}
async function contextBaseSha(
  options: InvestigationFirstFactoryOptions,
  route: InvestigationFirstRoute,
  item: ScheduledWorkItem,
): Promise<string> {
  const snapshot = route.baseSha;
  if (snapshot) return snapshot;
  return options.getBranchHead(item.repository ?? options.repository, route.targetBranch);
}
