// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import type { InvestigationSnapshotIdentity } from "../../core/ports/git-workspace.js";
import type {
  OrchestrationExecutionPlanCandidate,
  OrchestrationExecutionPlanCertificate,
  OrchestrationExecutionPlanNodeProjection,
  OrchestrationPlanMetadata,
  OrchestrationSerializationEdgeRecord,
} from "../../core/ports/orchestration.js";
import { materializeClaimDependencies, validateGraph, type ClaimSerializationEdge, type ScheduledWorkItem } from "./scheduler.js";

/** Exact source identity which makes a completed packet safe to reuse. */
export interface PacketWaveIdentity {
  /** Stable orchestration node identity. */
  nodeId: string;
  /** Durable investigation/work run which produced the packet. */
  runId: string;
  /** Repository-qualified issue subject used by that run. */
  subject: { repo: string; issue: number };
  /** Exact revision read while producing the packet. */
  baseRef: string;
  targetBranch?: string;
  snapshot?: InvestigationSnapshotIdentity;
  /** Durable Investigation artifact identity. */
  investigationId: string;
}

/** The durable, read-only result needed to compile a mutation DAG. */
export interface PacketWaveItem {
  id: string;
  issue: number;
  expectedPaths: readonly string[];
  /** Exact base used while reading and authoring the packet. */
  baseRef: string;
  /** Exact node/run/subject/base/investigation lineage for restart reuse. */
  identity?: PacketWaveIdentity;
  /** Confirmed semantic edges from investigation/issue evidence. */
  semanticDependencies: readonly string[];
  /** Invalid and decomposed issues never enter the mutation DAG. */
  outcome?: "confirmed" | "invalid" | "decomposed";
  /** Optional children retained when a decomposition is expanded. */
  childIssues?: readonly number[];
}

export interface PacketDagInput {
  items: readonly ScheduledWorkItem[];
  packets: readonly PacketWaveItem[];
  /** First base is retained for backward-compatible barrier display; packet identities may differ. */
  baseRef: string;
  /** Never enabled implicitly. */
  fallback?: "none" | "preview-claims";
}

export interface ClaimProvenance {
  source: "build-packet";
  packetId: string;
  expectedPaths: string[];
  baseRef: string;
  repository?: string;
  targetBranch?: string;
  snapshotId?: string;
}

export interface DependencyProvenance {
  source: "investigation";
  dependencies: string[];
}

export interface CompiledPacketDag {
  items: ScheduledWorkItem[];
  edges: ClaimSerializationEdge[];
  packetBarrier: { baseRef: string; packetIds: string[]; groups: { identity: string; baseRef: string; packetIds: string[] }[]; completed: number; total: number };
  observability: {
    semanticFrontier: number;
    claimEdgeCount: number;
    claimComponents: number;
  };
}

/**
 * Build the only digest used for execution admission. Arrays which represent
 * sets are normalized here, while node and edge order is canonicalized by
 * identity. This makes replay order irrelevant but keeps semantic changes
 * observable.
 */
export function buildExecutionPlanCertificate(input: {
  nodes: readonly OrchestrationExecutionPlanNodeProjection[];
  serializationEdges: readonly OrchestrationSerializationEdgeRecord[];
  builderFrontier: readonly string[];
  batchCandidates: readonly OrchestrationExecutionPlanCandidate[];
  barrier: OrchestrationExecutionPlanCertificate["barrier"];
}): OrchestrationExecutionPlanCertificate {
  const nodes = [...input.nodes].map((node) => canonicalPlanNode(node)).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const serializationEdges = [...input.serializationEdges].map((edge) => ({
    predecessor: edge.predecessor,
    successor: edge.successor,
    overlappingClaims: [...new Set(edge.overlappingClaims)].sort(),
  })).sort((left, right) => left.predecessor.localeCompare(right.predecessor) || left.successor.localeCompare(right.successor));
  const builderFrontier = [...new Set(input.builderFrontier)].sort();
  const batchCandidates = [...input.batchCandidates].map((candidate) => ({
    ...candidate,
    repository: candidate.repository.trim().toLowerCase(),
    ...(candidate.targetBranch !== undefined ? { targetBranch: candidate.targetBranch.trim() } : {}),
    expectedPaths: [...new Set(candidate.expectedPaths)].sort(),
    dependencies: [...new Set(candidate.dependencies)].sort(),
    claims: [...new Set(candidate.claims)].sort(),
  })).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const unsigned = {
    schema: "forgedock.execution-plan/v1" as const,
    nodes,
    serializationEdges,
    builderFrontier,
    batchCandidates,
    barrier: canonicalJsonValue({
      ...input.barrier,
      investigationNodeIds: [...input.barrier.investigationNodeIds].sort(),
      packetNodeIds: [...input.barrier.packetNodeIds].sort(),
    }),
  };
  const digest = createHash("sha256").update(canonicalJson(unsigned), "utf8").digest("hex");
  return { ...unsigned, digest };
}

/** JCS-compatible enough for the JSON-safe orchestration domain: sorted keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value)) ?? "";
}

function canonicalJsonValue(value: unknown): any {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJsonValue(entry)]));
  }
  return value;
}

function canonicalPlanNode(node: OrchestrationExecutionPlanNodeProjection): OrchestrationExecutionPlanNodeProjection {
  return {
    ...node,
    repository: node.repository.trim().toLowerCase(),
    ...(node.targetBranch !== undefined ? { targetBranch: node.targetBranch.trim() } : {}),
    dependencies: [...new Set(node.dependencies)].sort(),
    claims: [...new Set(node.claims)].sort(),
    expectedPaths: [...new Set(node.expectedPaths)].sort(),
    semanticDependencies: [...new Set(node.semanticDependencies)].sort(),
  };
}

/**
 * Replace preview claims with the durable packet scope and compile only after
 * every confirmed issue has a packet. This is deliberately pure so callers can
 * persist the result and audit/replay it without invoking workers.
 */
export function compileExecutionDag(input: PacketDagInput): CompiledPacketDag {
  if (!input.baseRef.trim()) throw new Error("Packet DAG requires an exact base reference");
  const byId = new Map<string, ScheduledWorkItem>();
  for (const item of input.items) {
    if (byId.has(item.id)) throw new Error(`Duplicate packet DAG item identity ${item.id}`);
    byId.set(item.id, item);
  }
  const packets = new Map<string, PacketWaveItem>();
  for (const packet of input.packets) {
    if (packets.has(packet.id)) throw new Error(`Duplicate packet identity ${packet.id}`);
    packets.set(packet.id, packet);
  }
  const included = input.items.filter((item) => {
    const packet = packets.get(item.id);
    return packet?.outcome !== "invalid" && packet?.outcome !== "decomposed";
  });
  const compiled: ScheduledWorkItem[] = [];
  for (const item of included) {
    const packet = packets.get(item.id);
    if (!packet) throw new Error(`Packet barrier incomplete: missing packet for ${item.id}`);
    // A wave may contain multiple immutable route/base groups. The packet's
    // own base is retained in provenance; only blank bases are rejected.
    if (!packet.baseRef.trim()) throw new Error(`Packet ${item.id} has no exact base reference`);
    const paths = normalizePacketPaths(packet.expectedPaths);
    if (!paths.length) {
      if (input.fallback !== "preview-claims") throw new Error(`Packet ${item.id} has no bounded expected paths`);
    }
    if (packet.semanticDependencies === undefined) throw new Error(`Packet ${item.id} lacks authoritative semantic dependency evidence`);
    const dependencies = normalizeSemanticDependencies(packet.semanticDependencies);
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
        ...(packet.identity?.subject.repo !== undefined ? { repository: packet.identity.subject.repo } : {}),
        ...(packet.identity?.targetBranch !== undefined ? { targetBranch: packet.identity.targetBranch } : {}),
        ...(packet.identity?.snapshot?.snapshotId !== undefined ? { snapshotId: packet.identity.snapshot.snapshotId } : {}),
      } satisfies ClaimProvenance,
      dependencyProvenance: {
        source: "investigation",
        dependencies,
      } satisfies DependencyProvenance,
    };
    const claims = paths.length ? paths : normalizePreviewClaims(item.claims);
    const memberIssues = [...new Set([...(item.memberIssues ?? []), ...(packet.childIssues ?? [])])];
    compiled.push({
      ...item,
      dependencies,
      claims,
      plan: provenance,
      ...(memberIssues.length ? { memberIssues } : {}),
    });
  }
  const graph = materializeClaimDependencies(compiled);
  const activeIds = new Set(graph.items.map((item) => item.id));
  const edges = graph.edges.filter((edge) => activeIds.has(edge.predecessor) && activeIds.has(edge.successor));
  validateGraph(graph.items, edges);
  const frontier = graph.items.filter((item) => item.dependencies.length === 0).length;
  const packetIds = graph.items.map((item) => packets.get(item.id)!.id);
  const groups = new Map<string, { identity: string; baseRef: string; packetIds: string[] }>();
  for (const id of packetIds) {
    const packet = packets.get(id)!;
    const identity = JSON.stringify({ repo: packet.identity?.subject.repo ?? "", route: packet.identity?.targetBranch ?? "", base: packet.baseRef, snapshot: packet.identity?.snapshot?.snapshotId ?? "" });
    const group = groups.get(identity) ?? { identity, baseRef: packet.baseRef, packetIds: [] };
    group.packetIds.push(id);
    groups.set(identity, group);
  }
  return {
    items: graph.items,
    edges,
    packetBarrier: {
      baseRef: input.baseRef,
      packetIds,
      groups: [...groups.values()],
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

export function normalizePacketPaths(paths: readonly string[]): string[] {
  const result = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string") throw new Error(`Unsafe packet expected path: ${String(raw)}`);
    const slashSeparated = raw.replaceAll("\\", "/").trim();
    // Reject absolute POSIX/UNC paths and Windows drive paths before resolving
    // segments. Resolving first would let repo/../outside escape the boundary.
    if (!slashSeparated || slashSeparated.startsWith("/") || /^[A-Za-z]:/.test(slashSeparated)) {
      throw new Error(`Unsafe packet expected path: ${raw}`);
    }
    if (/[?*[\]{}]/.test(slashSeparated)) throw new Error(`Unsafe packet expected path: ${raw}`);
    const segments: string[] = [];
    for (const segment of slashSeparated.split("/")) {
      if (segment === "..") throw new Error(`Unsafe packet expected path: ${raw}`);
      if (!segment || segment === ".") continue;
      segments.push(segment);
    }
    if (!segments.length) throw new Error(`Unsafe packet expected path: ${raw}`);
    result.add(segments.join("/"));
  }
  return [...result].sort();
}

/** Normalize authoritative semantic edges without silently dropping blanks. */
export function normalizeSemanticDependencies(values: readonly string[]): string[] {
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !value.trim()) throw new Error("Packet semantic dependency must not be blank");
    result.add(value.trim());
  }
  return [...result];
}

function normalizePreviewClaims(paths: readonly string[]): string[] {
  const result = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string") throw new Error(`Unsafe packet expected path: ${String(raw)}`);
    const path = raw.replaceAll("\\", "/").trim().replace(/^\.\//, "");
    if (!path || path.startsWith("/") || path.split("/").includes("..") || path.includes("*") || path.includes("{")) {
      throw new Error(`Unsafe packet expected path: ${raw}`);
    }
    result.add(path);
  }
  return [...result].sort();
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
  /** Monotonic ordinal retained for stores which do not preserve attempt history. */
  attempt?: number;
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
  /** Resolve the exact identity expected for a packet on this run/resume. */
  identityFor?: (item: ScheduledWorkItem) => PacketWaveIdentity | undefined;
  /** Read-only operation; it must persist the packet before resolving. */
  materialize(item: ScheduledWorkItem): Promise<PacketWaveItem>;
}

/** Run/resume a bounded packet wave. Completed packets are reused only when their full identity matches. */
export async function runPacketWave(
  items: readonly ScheduledWorkItem[],
  store: PacketWaveStore,
  options: PacketWaveOptions,
): Promise<readonly PacketWaveItem[]> {
  if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1) throw new Error("Packet wave concurrency must be positive");
  if (!options.baseRef.trim()) throw new Error("Packet wave requires an exact base reference");
  const now = options.now ?? (() => new Date().toISOString());
  let state = await store.load();
  // A different base describes a new packet wave. Do not carry completed
  // packets across it, but preserve the existing restart behavior of starting
  // a fresh wave rather than treating an intentional base change as corruption.
  if (state && state.baseRef !== options.baseRef) state = undefined;
  state ??= { baseRef: options.baseRef, attempts: {}, packets: {} };
  state.packets ??= {};
  const results = new Map<string, PacketWaveItem>();
  for (const item of items) {
    const attempt = state.attempts[item.id];
    const packet = state.packets[item.id];
    if (attempt?.status !== "completed") continue;
    if (!attempt) throw new Error(`Packet ${item.id} completed attempt has no durable attempt`);
    assertPacketWaveAttemptRecord(item.id, attempt);
    if (!packet) throw new Error(`Packet ${item.id} completed attempt has no durable packet`);
    assertPacketIdentity(item, packet, options, true);
    results.set(item.id, packet);
  }
  const pending = items.filter((item) => !results.has(item.id));
  let cursor = 0;
  const worker = async () => {
    while (cursor < pending.length) {
      const item = pending[cursor++]!;
      const attemptNumber = nextAttemptNumber(item.id, state!.attempts);
      const attempt: PacketWaveAttempt = {
        id: `${item.id}:${attemptNumber}`,
        attempt: attemptNumber,
        status: "running",
        startedAt: now(),
      };
      state!.attempts[item.id] = attempt;
      await store.save(state!);
      try {
        const packet = await options.materialize(item);
        assertPacketIdentity(item, packet, options, false);
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

function assertPacketIdentity(
  item: ScheduledWorkItem,
  packet: PacketWaveItem,
  options: PacketWaveOptions,
  completedReuse: boolean,
): void {
  if (!packet || typeof packet !== "object") throw new Error(`Packet ${item.id} is not a durable packet object`);
  if (packet.id !== item.id) throw new Error(`Packet ${item.id} has node identity drift: ${packet.id}`);
  if (packet.issue !== item.issue) throw new Error(`Packet ${item.id} has subject issue drift: ${packet.issue} != ${item.issue}`);
  if (packet.baseRef !== options.baseRef) throw new Error(`Packet ${item.id} has base identity drift: ${packet.baseRef} != ${options.baseRef}`);

  const expected = options.identityFor?.(item);
  if (expected !== undefined) validateExpectedIdentity(item, expected, options.baseRef);
  const identity = packet.identity;
  if (!identity) {
    if (completedReuse || expected !== undefined) {
      throw new Error(`Packet ${item.id} lacks exact node/run/subject/base/investigation identity`);
    }
    return;
  }
  validatePacketIdentity(item, packet, identity, options.baseRef);
  if (!expected) return;
  if (identity.nodeId !== expected.nodeId) throw new Error(`Packet ${item.id} has node identity drift`);
  if (identity.runId !== expected.runId) throw new Error(`Packet ${item.id} has run identity drift`);
  if (!sameSubject(identity.subject, expected.subject)) throw new Error(`Packet ${item.id} has subject identity drift`);
  if (identity.baseRef !== expected.baseRef) throw new Error(`Packet ${item.id} has base identity drift`);
  if (identity.investigationId !== expected.investigationId) throw new Error(`Packet ${item.id} has investigation identity drift`);
  if (identity.targetBranch !== expected.targetBranch || !sameSnapshotIdentity(identity.snapshot, expected.snapshot)) {
    throw new Error(`Packet ${item.id} has route/snapshot identity drift`);
  }
}

function validateExpectedIdentity(item: ScheduledWorkItem, identity: PacketWaveIdentity, baseRef: string): void {
  if (identity.nodeId !== item.id) throw new Error(`Packet ${item.id} expected identity has node drift`);
  if (identity.baseRef !== baseRef) throw new Error(`Packet ${item.id} expected identity has base drift`);
  if (!identity.runId.trim() || !identity.investigationId.trim()) throw new Error(`Packet ${item.id} expected identity is incomplete`);
  if (identity.subject.issue !== item.issue || !identity.subject.repo.trim()) throw new Error(`Packet ${item.id} expected identity has subject drift`);
  if (identity.targetBranch !== undefined && !identity.targetBranch.trim()) throw new Error(`Packet ${item.id} expected identity has blank route`);
}

function validatePacketIdentity(
  item: ScheduledWorkItem,
  packet: PacketWaveItem,
  identity: PacketWaveIdentity,
  baseRef: string,
): void {
  if (identity.nodeId !== item.id || identity.nodeId !== packet.id) throw new Error(`Packet ${item.id} has node identity drift`);
  if (!identity.runId.trim() || !identity.investigationId.trim()) throw new Error(`Packet ${item.id} has incomplete run/investigation identity`);
  if (identity.subject.issue !== item.issue || !identity.subject.repo.trim()) throw new Error(`Packet ${item.id} has subject identity drift`);
  if (identity.baseRef !== baseRef || identity.baseRef !== packet.baseRef) throw new Error(`Packet ${item.id} has base identity drift`);
}

function sameSnapshotIdentity(left: InvestigationSnapshotIdentity | undefined, right: InvestigationSnapshotIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.schema === right.schema
    && left.repository === right.repository
    && left.repositoryRoot === right.repositoryRoot
    && left.targetBranch === right.targetBranch
    && left.baseSha === right.baseSha
    && left.snapshotId === right.snapshotId
    && left.snapshotPath === right.snapshotPath;
}

function sameSubject(left: PacketWaveIdentity["subject"], right: PacketWaveIdentity["subject"]): boolean {
  return left.issue === right.issue && left.repo.trim().toLowerCase() === right.repo.trim().toLowerCase();
}

function nextAttemptNumber(itemId: string, attempts: Record<string, PacketWaveAttempt>): number {
  const record = attempts[itemId];
  if (!record) return 1;
  assertPacketWaveAttemptRecord(itemId, record);
  if (record.attempt! >= Number.MAX_SAFE_INTEGER) throw new Error(`Packet ${itemId} attempt identity exhausted`);
  return record.attempt! + 1;
}

function assertPacketWaveAttemptRecord(itemId: string, record: PacketWaveAttempt): void {
  if (!Number.isSafeInteger(record.attempt) || record.attempt! < 1 || record.attempt! >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`Packet ${itemId} has an invalid persisted attempt ordinal`);
  }
  if (record.id !== `${itemId}:${record.attempt}`) {
    throw new Error(`Packet ${itemId} has a malformed persisted attempt identity`);
  }
}
