// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";

/** Authority which may introduce a graph seed. Model/investigation suggestions are deliberately absent. */
export type RelationSeedProvenance = "issue" | "controller" | "config";
export type RelationFactProvenance = "controller" | "repository" | "config";
export type RelationNodeKind = "file" | "symbol" | "interface" | "config" | "generated" | "test" | "invariant" | "command";
export type RelationEdgeKind = "import" | "call" | "implements" | "reads-config" | "generated-by" | "serializes" | "deserializes" | "test-covers" | "asserts" | "invariant" | "command-target";

export interface RelationGraphLimits {
  maxNodes: number;
  maxEdges: number;
  maxDepth: number;
  maxFiles: number;
  maxBytes: number;
  maxCollateralPaths: number;
}

export const DEFAULT_RELATION_GRAPH_LIMITS: Readonly<RelationGraphLimits> = Object.freeze({
  maxNodes: 10_000,
  maxEdges: 25_000,
  maxDepth: 8,
  maxFiles: 2_000,
  maxBytes: 4_000_000,
  maxCollateralPaths: 512,
});

export interface RelationSeed {
  path: string;
  provenance: RelationSeedProvenance;
  contentDigest?: string;
}

export interface RelationNode {
  id: string;
  kind: RelationNodeKind;
  identity: string;
  digest?: string;
}

export interface RelationEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: RelationEdgeKind;
  adapterId: string;
  provenance: RelationFactProvenance;
  sourcePath?: string;
  targetPath?: string;
  evidenceDigest: string;
}

export interface RelationGraph {
  version: "forgedock.relation-graph/v1";
  baseSha: string;
  adapterIds: string[];
  seeds: RelationSeed[];
  nodes: RelationNode[];
  edges: RelationEdge[];
  limits: RelationGraphLimits;
  graphDigest: string;
}

export interface PacketClosure {
  writablePaths: string[];
  evidencePaths: string[];
  invariantIds: string[];
  commandIds: string[];
  closureDigest: string;
  graphDigest: string;
  diagnostics: string[];
}

export interface RelationGraphBuildInput {
  baseSha: string;
  seeds: readonly RelationSeed[];
  facts?: { adapterId: string; nodes: readonly RelationNode[]; edges: readonly RelationEdge[] }[];
  limits?: Partial<RelationGraphLimits>;
}

const SHA = /^[0-9a-f]{7,64}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const PATH = /^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/;

export function canonicalRelationPath(value: string): string {
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || !PATH.test(path) || path.endsWith("/") || path.includes("//")) throw new Error(`Invalid repository path '${value}'`);
  return path;
}

export function digestRelation(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function boundedLimits(input: Partial<RelationGraphLimits> | undefined): RelationGraphLimits {
  const limits = { ...DEFAULT_RELATION_GRAPH_LIMITS, ...(input ?? {}) };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Relation graph limit ${key} must be a non-negative integer`);
  }
  if (limits.maxNodes < 1 || limits.maxEdges < 1 || limits.maxDepth < 1 || limits.maxFiles < 1 || limits.maxBytes < 1) {
    throw new Error("Relation graph node, edge, depth, file, and byte limits must be positive");
  }
  return limits;
}

export function buildRelationGraph(input: RelationGraphBuildInput): RelationGraph {
  if (!SHA.test(input.baseSha)) throw new Error(`Invalid relation graph base SHA '${input.baseSha}'`);
  const limits = boundedLimits(input.limits);
  const seeds = [...input.seeds].map((seed) => {
    if (seed.provenance !== "issue" && seed.provenance !== "controller" && seed.provenance !== "config") throw new Error("[graph-authority] Investigation/model suggestions cannot authorize relation graph seeds");
    return {
      path: canonicalRelationPath(seed.path),
      provenance: seed.provenance,
      ...(seed.contentDigest !== undefined ? { contentDigest: seed.contentDigest } : {}),
    };
  }).sort(seedOrder);
  const uniqueSeeds = dedupeBy(seeds, (seed) => `${seed.provenance}:${seed.path}`);
  if (uniqueSeeds.length > 4096) throw new Error("Relation graph seed limit exceeded");
  const nodeMap = new Map<string, RelationNode>();
  const edgeMap = new Map<string, RelationEdge>();
  for (const fact of input.facts ?? []) {
    for (const node of fact.nodes) {
      if (!node.id || !node.identity) throw new Error(`Adapter ${fact.adapterId} produced an invalid node`);
      if (["file", "generated", "test", "config"].includes(node.kind)) canonicalRelationPath(node.identity);
      if (nodeMap.has(node.id) && canonicalJson(nodeMap.get(node.id)) !== canonicalJson(node)) throw new Error(`Relation graph node collision '${node.id}'`);
      nodeMap.set(node.id, { ...node });
    }
    for (const edge of fact.edges) {
      if (edge.adapterId !== fact.adapterId) throw new Error(`Relation edge '${edge.id}' has mismatched adapter provenance`);
      if (!DIGEST.test(edge.evidenceDigest)) throw new Error(`Relation edge '${edge.id}' lacks a valid evidence digest`);
      if (edge.provenance === "repository" && !edge.sourcePath && !edge.targetPath) throw new Error(`Repository edge '${edge.id}' lacks path provenance`);
      if (edge.sourcePath !== undefined) canonicalRelationPath(edge.sourcePath);
      if (edge.targetPath !== undefined) canonicalRelationPath(edge.targetPath);
      edgeMap.set(edge.id, { ...edge });
    }
  }
  for (const seed of uniqueSeeds) {
    const id = fileNodeId(seed.path);
    if (!nodeMap.has(id)) nodeMap.set(id, { id, kind: "file", identity: seed.path, ...(seed.contentDigest ? { digest: seed.contentDigest } : {}) });
  }
  if (nodeMap.size > limits.maxNodes) throw new Error(`Relation graph exceeds maxNodes (${limits.maxNodes})`);
  if (edgeMap.size > limits.maxEdges) throw new Error(`Relation graph exceeds maxEdges (${limits.maxEdges})`);
  const graphBase = { version: "forgedock.relation-graph/v1" as const, baseSha: input.baseSha.toLowerCase(), adapterIds: [...new Set((input.facts ?? []).map((fact) => fact.adapterId))].sort(), seeds: uniqueSeeds, nodes: [...nodeMap.values()].sort(nodeOrder), edges: [...edgeMap.values()].sort(edgeOrder), limits };
  return { ...graphBase, graphDigest: digestRelation(graphBase) };
}

/** Fixed-point, breadth-first closure. Only seeds and validated adapter facts can authorize paths. */
export function closeRelationGraph(graph: RelationGraph): PacketClosure {
  const diagnostics: string[] = [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edgesBySource = new Map<string, RelationEdge[]>();
  for (const edge of graph.edges) {
    if (!nodeById.has(edge.sourceId) || !nodeById.has(edge.targetId)) { diagnostics.push(`[dangling-edge] ${edge.id}`); continue; }
    const list = edgesBySource.get(edge.sourceId) ?? []; list.push(edge); edgesBySource.set(edge.sourceId, list);
  }
  const seedIds = graph.seeds.map((seed) => fileNodeId(seed.path));
  const seen = new Set(seedIds);
  let frontier = [...seedIds];
  let depth = 0;
  while (frontier.length && depth < graph.limits.maxDepth) {
    const next: string[] = [];
    for (const source of frontier) for (const edge of (edgesBySource.get(source) ?? []).sort(edgeOrder)) {
      // Commands/invariants may be covered, but never become writable files.
      const target = nodeById.get(edge.targetId)!;
      if (!seen.has(target.id)) { seen.add(target.id); next.push(target.id); }
    }
    frontier = next;
    depth += 1;
    if (seen.size > graph.limits.maxNodes) { diagnostics.push(`[graph-limit] maxNodes ${graph.limits.maxNodes} exceeded during closure`); break; }
  }
  if (frontier.length) diagnostics.push(`[graph-depth] relation closure exceeded maxDepth ${graph.limits.maxDepth}`);
  const reachable = [...seen].map((id) => nodeById.get(id)).filter((node): node is RelationNode => Boolean(node));
  const writablePaths = reachable.filter((node) => node.kind === "file" || node.kind === "generated").map((node) => node.identity).sort();
  const evidencePaths = reachable.filter((node) => node.kind === "test" || node.kind === "file" || node.kind === "generated").map((node) => node.identity).sort();
  const invariantIds = reachable.filter((node) => node.kind === "invariant").map((node) => node.identity).sort();
  const commandIds = reachable.filter((node) => node.kind === "command").map((node) => node.identity).sort();
  const collateral = writablePaths.filter((path) => !graph.seeds.some((seed) => seed.path === path));
  if (collateral.length > graph.limits.maxCollateralPaths) diagnostics.push(`[collateral-limit] ${collateral.length} paths exceed maxCollateralPaths ${graph.limits.maxCollateralPaths}`);
  const closureBase = { graphDigest: graph.graphDigest, writablePaths, evidencePaths, invariantIds, commandIds };
  return { ...closureBase, closureDigest: digestRelation(closureBase), diagnostics };
}

export function graphConfigDigest(config: unknown): string { return digestRelation(config ?? {}); }
export function graphCommandPlanDigest(commands: unknown): string { return digestRelation(commands ?? []); }
export function graphEvidenceContractDigest(contract: unknown): string { return digestRelation(contract ?? {}); }

export interface RelationGraphCheckpointInput {
  graph: RelationGraph;
  closure: PacketClosure;
  configDigest: string;
  commandPlanDigest: string;
  evidenceContractDigest: string;
}

export function relationGraphCheckpointPayload(input: RelationGraphCheckpointInput) {
  return {
    checkpoint: "relation-graph" as const,
    version: "forgedock.relation-graph/v1" as const,
    baseSha: input.graph.baseSha,
    graphDigest: input.graph.graphDigest,
    configDigest: input.configDigest,
    closureDigest: input.closure.closureDigest,
    commandPlanDigest: input.commandPlanDigest,
    evidenceContractDigest: input.evidenceContractDigest,
    adapterIds: input.graph.adapterIds,
    seeds: input.graph.seeds,
    nodes: input.graph.nodes,
    edges: input.graph.edges,
    writablePaths: input.closure.writablePaths,
    evidencePaths: input.closure.evidencePaths,
    invariantIds: input.closure.invariantIds,
    commandIds: input.closure.commandIds,
    limits: input.graph.limits,
    createdAt: new Date().toISOString(),
  };
}

/** Revalidation used at packet selection/build; legacy packets have no graph and remain conservative. */
export function revalidateRelationGraph(graph: RelationGraph, expected: Pick<RelationGraph, "graphDigest" | "baseSha">): void {
  const adapterIds = graph.adapterIds;
  const facts = adapterIds.map((adapterId) => ({ adapterId, nodes: graph.nodes, edges: graph.edges.filter((edge) => edge.adapterId === adapterId) }));
  const rebuilt = buildRelationGraph({ baseSha: graph.baseSha, seeds: graph.seeds, facts, limits: graph.limits });
  if (rebuilt.baseSha !== expected.baseSha.toLowerCase() || rebuilt.graphDigest !== expected.graphDigest) throw new Error("[graph-drift] Relation graph checkpoint no longer matches its frozen digest or base SHA");
}

export function fileNodeId(path: string): string { return `file:${canonicalRelationPath(path)}`; }
export function nodeId(kind: RelationNodeKind, identity: string): string { return `${kind}:${identity}`; }

export const buildControllerRelationGraph = buildRelationGraph;
export const computePacketClosure = closeRelationGraph;
export const derivePacketClosure = closeRelationGraph;

function dedupeBy<T>(values: readonly T[], key: (value: T) => string): T[] { const seen = new Set<string>(); return values.filter((value) => { const k = key(value); if (seen.has(k)) return false; seen.add(k); return true; }); }
function seedOrder(a: RelationSeed, b: RelationSeed): number { return `${a.path}\0${a.provenance}`.localeCompare(`${b.path}\0${b.provenance}`); }
function nodeOrder(a: RelationNode, b: RelationNode): number { return `${a.kind}\0${a.identity}\0${a.id}`.localeCompare(`${b.kind}\0${b.identity}\0${b.id}`); }
function edgeOrder(a: RelationEdge, b: RelationEdge): number { return `${a.sourceId}\0${a.targetId}\0${a.kind}\0${a.id}`.localeCompare(`${b.sourceId}\0${b.targetId}\0${b.kind}\0${b.id}`); }
