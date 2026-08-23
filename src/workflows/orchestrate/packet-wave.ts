// SPDX-License-Identifier: AGPL-3.0-or-later

import type { OrchestrationPlanMetadata } from "../../core/ports/orchestration.js";
import { materializeClaimDependencies, validateGraph, type ClaimSerializationEdge, type ScheduledWorkItem } from "./scheduler.js";

/** The durable, read-only result needed to compile a mutation DAG. */
export interface PacketWaveItem {
  id: string;
  issue: number;
  expectedPaths: readonly string[];
  /** Exact base used while reading and authoring the packet. */
  baseRef: string;
  /** Confirmed semantic edges from investigation/issue evidence. */
  semanticDependencies?: readonly string[];
  /** Invalid and decomposed issues never enter the mutation DAG. */
  outcome?: "confirmed" | "invalid" | "decomposed";
  /** Optional children retained when a decomposition is expanded. */
  childIssues?: readonly number[];
}

export interface PacketDagInput {
  items: readonly ScheduledWorkItem[];
  packets: readonly PacketWaveItem[];
  /** Exact base is part of the packet barrier identity. */
  baseRef: string;
  /** Never enabled implicitly. */
  fallback?: "none" | "preview-claims";
}

export interface ClaimProvenance {
  source: "build-packet";
  packetId: string;
  expectedPaths: string[];
  baseRef: string;
}

export interface DependencyProvenance {
  source: "investigation";
  dependencies: string[];
}

export interface CompiledPacketDag {
  items: ScheduledWorkItem[];
  edges: ClaimSerializationEdge[];
  packetBarrier: { baseRef: string; packetIds: string[]; completed: number; total: number };
  observability: {
    semanticFrontier: number;
    claimEdgeCount: number;
    claimComponents: number;
  };
}

/**
 * Replace preview claims with the durable packet scope and compile only after
 * every confirmed issue has a packet. This is deliberately pure so callers can
 * persist the result and audit/replay it without invoking workers.
 */
export function compileExecutionDag(input: PacketDagInput): CompiledPacketDag {
  if (!input.baseRef.trim()) throw new Error("Packet DAG requires an exact base reference");
  const byId = new Map(input.items.map((item) => [item.id, item]));
  const packets = new Map(input.packets.map((packet) => [packet.id, packet]));
  const included = input.items.filter((item) => {
    const packet = packets.get(item.id);
    return packet?.outcome !== "invalid" && packet?.outcome !== "decomposed";
  });
  const compiled: ScheduledWorkItem[] = [];
  for (const item of included) {
    const packet = packets.get(item.id);
    if (!packet) throw new Error(`Packet barrier incomplete: missing packet for ${item.id}`);
    if (packet.baseRef !== input.baseRef) throw new Error(`Packet base drift for ${item.id}: ${packet.baseRef} != ${input.baseRef}`);
    const paths = normalizePaths(packet.expectedPaths);
    if (!paths.length) {
      if (input.fallback !== "preview-claims") throw new Error(`Packet ${item.id} has no bounded expected paths`);
    }
    const dependencies = packet.semanticDependencies === undefined
      ? [...item.dependencies]
      : unique(packet.semanticDependencies);
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) throw new Error(`Packet ${item.id} references unknown semantic dependency ${dependency}`);
    }
    const provenance: OrchestrationPlanMetadata = {
      ...(item.plan ?? {}),
      claimProvenance: {
        source: "build-packet",
        packetId: packet.id,
        expectedPaths: paths,
        baseRef: packet.baseRef,
      } satisfies ClaimProvenance,
      dependencyProvenance: {
        source: "investigation",
        dependencies,
      } satisfies DependencyProvenance,
    };
    const claims = paths.length ? paths : normalizePaths(item.claims);
    compiled.push({ ...item, dependencies, claims, plan: provenance });
  }
  const graph = materializeClaimDependencies(compiled);
  const activeIds = new Set(graph.items.map((item) => item.id));
  const edges = graph.edges.filter((edge) => activeIds.has(edge.predecessor) && activeIds.has(edge.successor));
  validateGraph(graph.items, edges);
  const frontier = graph.items.filter((item) => item.dependencies.length === 0).length;
  return {
    items: graph.items,
    edges,
    packetBarrier: {
      baseRef: input.baseRef,
      packetIds: graph.items.map((item) => packets.get(item.id)!.id),
      completed: graph.items.length,
      total: graph.items.length,
    },
    observability: {
      semanticFrontier: frontier,
      claimEdgeCount: edges.length,
      claimComponents: countComponents(graph.items, edges),
    },
  };
}

function normalizePaths(paths: readonly string[]): string[] {
  const result = new Set<string>();
  for (const raw of paths) {
    const path = raw.replaceAll("\\", "/").trim().replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.split("/").includes("..") || path.includes("*")) {
      throw new Error(`Unsafe packet expected path: ${raw}`);
    }
    result.add(path);
  }
  return [...result].sort();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function countComponents(items: readonly ScheduledWorkItem[], edges: readonly ClaimSerializationEdge[]): number {
  const parent = new Map(items.map((item) => [item.id, item.id] as const));
  const find = (id: string): string => {
    const root = parent.get(id);
    if (!root || root === id) return id;
    const resolved = find(root);
    parent.set(id, resolved);
    return resolved;
  };
  const join = (left: string, right: string) => {
    const a = find(left); const b = find(right);
    if (a !== b) parent.set(a, b);
  };
  for (const edge of edges) join(edge.predecessor, edge.successor);
  return new Set(items.map((item) => find(item.id))).size;
}

export type PacketWaveStatus = "queued" | "running" | "completed" | "failed";

export interface PacketWaveAttempt {
  id: string;
  status: PacketWaveStatus;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface PacketWaveState {
  baseRef: string;
  attempts: Record<string, PacketWaveAttempt>;
  /** Durable packet payloads make restart reuse explicit and lossless. */
  packets?: Record<string, PacketWaveItem>;
}

export interface PacketWaveStore {
  load(): Promise<PacketWaveState | undefined>;
  save(state: PacketWaveState): Promise<void>;
}

export interface PacketWaveOptions {
  concurrency: number;
  /** Base used by every read-only packet authoring operation. */
  baseRef: string;
  now?: () => string;
  /** Read-only operation; it must persist the packet before resolving. */
  materialize(item: ScheduledWorkItem): Promise<PacketWaveItem>;
}

/** Run/resume a bounded packet wave. Completed packets are reused. */
export async function runPacketWave(
  items: readonly ScheduledWorkItem[],
  store: PacketWaveStore,
  options: PacketWaveOptions,
): Promise<readonly PacketWaveItem[]> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error("Packet wave concurrency must be positive");
  const now = options.now ?? (() => new Date().toISOString());
  let state = await store.load();
  if (state && state.baseRef !== options.baseRef) state = undefined;
  state ??= { baseRef: options.baseRef, attempts: {}, packets: {} };
  state.packets ??= {};
  const results = new Map<string, PacketWaveItem>();
  for (const item of items) {
    const packet = state.packets[item.id];
    if (packet && state.attempts[item.id]?.status === "completed") results.set(item.id, packet);
  }
  const pending = items.filter((item) => !results.has(item.id));
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++]!;
      const previous = state!.attempts[item.id];
      const attempt: PacketWaveAttempt = { id: `${item.id}:${(previous ? 2 : 1)}`, status: "running", startedAt: now() };
      state!.attempts[item.id] = attempt;
      await store.save(state!);
      try {
        const packet = await options.materialize(item);
        if (packet.baseRef !== options.baseRef) throw new Error(`Packet ${item.id} returned base ${packet.baseRef}, expected ${options.baseRef}`);
        results.set(item.id, packet);
        state!.packets![item.id] = packet;
        state!.attempts[item.id] = { ...attempt, status: "completed", completedAt: now() };
        await store.save(state!);
      } catch (error) {
        state!.attempts[item.id] = { ...attempt, status: "failed", completedAt: now(), error: error instanceof Error ? error.message : String(error) };
        await store.save(state!);
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency, pending.length) }, worker));
  return [...results.values()];
}
