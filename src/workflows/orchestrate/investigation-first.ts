// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createArtifact } from "../../core/artifacts/schema.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type {
  OrchestrationExecutionMaterializer,
  OrchestrationInvestigationWorker,
  OrchestrationPacketWorker,
} from "./controller.js";
import type { OrchestrationRecord, OrchestrationInvestigationRecord } from "../../core/ports/orchestration.js";
import type { ScheduledWorkItem, ClaimSerializationEdge } from "./scheduler.js";
import { investigateWorkItem } from "../work-on/investigate.js";
import { prepareBuildPacket, type VerificationCatalog } from "../work-on/prepare.js";
import { STANDARD_SCOPE_METADATA_ROOTS, type AgentRuntime } from "../../runtime/agent-runtime.js";
import type { ThinkingLevel } from "../../core/config/forgedock-config.js";
import { materializeClaimDependencies } from "./scheduler.js";
import { compileExecutionDag } from "./packet-wave.js";

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
    const intent = createArtifact({
      kind: "Intent",
      runId: `run_${crypto.randomUUID()}`,
      subject: { repo: item.repository ?? options.repository, issue: item.issue },
      producer: { role: "controller", runtime: "forgedock" },
      payload: {
        title: route.issue.title,
        problem: route.issue.body || route.issue.title,
        constraints: [],
        acceptanceHints: [],
        dependencies: [...item.dependencies],
        sourceUrl: route.issue.url,
      },
    });
    await context.recordTask({ runId: intent.runId });
    const baseSha = await contextBaseSha(options, route, item);
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
    const investigation = context.investigation;
    const runId = investigation.runId ?? String(investigation.evidence?.runId ?? "");
    if (!runId) throw new Error(`Packet ${item.id} has no durable investigation run`);
    const run = await options.runs.load(runId);
    if (!run) throw new Error(`Packet ${item.id} investigation run ${runId} is missing`);
    const artifacts = await options.artifacts.list({ repo: item.repository ?? options.repository, issue: item.issue });
    const intent = [...artifacts].reverse().find((artifact) => artifact.kind === "Intent" && artifact.runId === runId);
    const investigationArtifact = [...artifacts].reverse().find((artifact) => artifact.kind === "Investigation" && artifact.id === investigation.investigationArtifactId);
    if (!intent || intent.kind !== "Intent") throw new Error(`Packet ${item.id} is missing its durable Intent`);
    if (!investigationArtifact || investigationArtifact.kind !== "Investigation") throw new Error(`Packet ${item.id} is missing its durable Investigation artifact`);
    const route = await options.resolveRoute(item);
    const baseSha = investigation.baseSha ?? route.baseSha ?? await options.getBranchHead(item.repository ?? options.repository, route.targetBranch);
    await assertExactCheckout(options.checkoutRoot, baseSha);
    const prepared = await prepareBuildPacket({
      run,
      intent,
      investigation: investigationArtifact,
      cwd: options.checkoutRoot,
      scopeHints: { affectedFiles: item.affectedFiles ?? [], claims: item.claims, metadataRoots: STANDARD_SCOPE_METADATA_ROOTS },
      ...(options.verificationCatalog !== undefined ? { verificationCatalog: options.verificationCatalog } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options.thinking !== undefined ? { planningThinking: options.thinking } : {}),
      ...(options.planning ?? {}),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    }, { runtime: options.runtime, artifacts: options.artifacts, runs: options.runs });
    await assertExactCheckout(options.checkoutRoot, baseSha);
    const observed = await options.getBranchHead(item.repository ?? options.repository, route.targetBranch);
    if (observed !== baseSha) throw new Error(`Packet base drifted for ${item.id}: expected ${baseSha}, observed ${observed}`);
    await context.recordTask({ runId: prepared.run.runId });
    return {
      packetId: prepared.packet.id,
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
    if (packets?.length) {
      const packetById = new Map(packets.filter((packet) => packet.status === "completed").map((packet) => [packet.nodeId, packet]));
      const packetInputs = items.map((item) => {
        const packet = packetById.get(item.id);
        if (!packet?.expectedPaths?.length || !packet.baseSha) throw new Error(`Packet barrier has no durable packet for ${item.id}`);
        return {
          id: item.id,
          issue: item.issue,
          expectedPaths: packet.expectedPaths,
          baseRef: packet.baseSha,
          semanticDependencies: packet.semanticDependencies ?? item.dependencies,
          ...(item.memberIssues !== undefined ? { childIssues: item.memberIssues } : {}),
        };
      });
      const baseRef = packetInputs[0]?.baseRef;
      if (!baseRef || packetInputs.some((packet) => packet.baseRef !== baseRef)) throw new Error("Packet barrier contains multiple or missing exact bases");
      const compiled = compileExecutionDag({ items, packets: packetInputs, baseRef });
      executionItems = compiled.items;
      executionEdges = compiled.edges;
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
