// SPDX-License-Identifier: AGPL-3.0-or-later

import { createArtifact } from "../../core/artifacts/schema.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import type {
  OrchestrationExecutionMaterializer,
  OrchestrationInvestigationWorker,
} from "./controller.js";
import type { OrchestrationRecord, OrchestrationInvestigationRecord } from "../../core/ports/orchestration.js";
import type { ScheduledWorkItem, ClaimSerializationEdge } from "./scheduler.js";
import { investigateWorkItem } from "../work-on/investigate.js";
import { STANDARD_SCOPE_METADATA_ROOTS, type AgentRuntime } from "../../runtime/agent-runtime.js";
import type { ThinkingLevel } from "../../core/config/forgedock-config.js";

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
  /** Initial frozen nodes, and the authoritative nodes when resuming. */
  sourceItems(orchestration: Readonly<OrchestrationRecord>, initialItems: readonly ScheduledWorkItem[]): readonly ScheduledWorkItem[];
  /** Resolve a decompose result into the bounded next investigation wave. */
  materializeDecomposition(input: {
    orchestration: Readonly<OrchestrationRecord>;
    item: ScheduledWorkItem;
    childIssues: readonly number[];
  }): Promise<{ items: readonly ScheduledWorkItem[] } | undefined>;
  childIssuesFor?(entry: OrchestrationInvestigationRecord): Promise<readonly number[]>;
}

export interface InvestigationFirstWorkers {
  investigationWorker: OrchestrationInvestigationWorker;
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
    }, { runtime: options.runtime, artifacts: options.artifacts, runs: options.runs });
    const payload = investigated.investigation.payload;
    return {
      outcome: payload.outcome,
      baseSha,
      evidence: {
        investigationId: investigated.investigation.id,
        rootCause: payload.rootCause ?? null,
        summary: payload.summary,
        affectedSurfaces: payload.affectedSurfaces,
      },
      ...(payload.decomposition !== undefined ? { childIssues: [] } : {}),
    };
  };

  const materializeExecution: OrchestrationExecutionMaterializer = async ({ orchestration, investigations }) => {
    const confirmed = new Set(investigations.filter((entry) => entry.outcome === "confirmed").map((entry) => entry.nodeId));
    const sourceItems = options.sourceItems(orchestration, initialItems);
    const items = sourceItems.filter((item) => confirmed.has(item.id));
    const sourceEdges = orchestration.investigationWave === 1
      ? undefined
      : orchestration.serializationEdges;
    const serializationEdges = sourceEdges
      ?.filter((edge) => confirmed.has(edge.predecessor) && confirmed.has(edge.successor))
      .map((edge): ClaimSerializationEdge => ({ ...edge, overlappingClaims: [...edge.overlappingClaims] }));
    const nextInvestigationItems: ScheduledWorkItem[] = [];
    for (const entry of investigations.filter((candidate) => candidate.outcome === "decompose")) {
      const parent = orchestration.nodes.find((node) => node.id === entry.nodeId);
      if (!parent) throw new Error(`Decomposition parent ${entry.nodeId} is missing from the durable investigation set`);
      const expansion = await options.materializeDecomposition({
        orchestration,
        item: sourceItems.find((candidate) => candidate.id === entry.nodeId) ?? {
          id: parent.id,
          issue: parent.issue,
          priority: parent.priority,
          dependencies: [],
          claims: [],
        },
        childIssues: await options.childIssuesFor?.(entry) ?? [],
      });
      if (expansion) nextInvestigationItems.push(...expansion.items);
    }
    return {
      items,
      ...(serializationEdges !== undefined ? { serializationEdges } : {}),
      ...(nextInvestigationItems.length ? { nextInvestigationItems } : {}),
    };
  };
  return { investigationWorker, materializeExecution };
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
