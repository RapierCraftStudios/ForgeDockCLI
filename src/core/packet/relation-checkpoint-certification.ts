// SPDX-License-Identifier: AGPL-3.0-or-later

import type { BuildPacketPayload, RelationGraphCheckpointPayload } from "../artifacts/schema.js";
import { repositoryAdaptersFor, detectRepositoryLanguages, type RepositoryAdapter } from "../../adapters/repository/bounded-adapter.js";
import {
  buildRelationGraph,
  closeRelationGraph,
  digestRelation,
  graphCommandPlanDigest,
  graphConfigDigest,
  graphEvidenceContractDigest,
  relationGraphCheckpointDigest,
  revalidateRelationGraph,
  type RelationGraph,
} from "./relation-graph.js";

export interface RelationCheckpointCertificationInput {
  checkpoint: RelationGraphCheckpointPayload;
  packet: Pick<BuildPacketPayload, "relationGraph" | "expectedPaths" | "evidencePaths" | "verificationPolicyVersion" | "verificationCommandTargets" | "verificationCommandIdentities" | "evidenceContract" | "investigationScopeReceipt">;
  cwd: string;
  baseSha: string;
  adapters?: readonly RepositoryAdapter[];
}

/**
 * Certifies the durable relation checkpoint against the packet and a fresh,
 * bounded read of the checkout. This is intentionally a separate gate: a
 * packet's copied graph metadata is never itself treated as graph authority.
 */
export async function certifyRelationGraphCheckpoint(input: RelationCheckpointCertificationInput): Promise<void> {
  const { checkpoint, packet } = input;
  const metadata = packet.relationGraph;
  if (!metadata) return;
  if (!checkpoint || checkpoint.checkpoint !== "relation-graph") throw new Error("[graph-authority] Relation graph checkpoint is missing");
  if (!checkpoint.checkpointId || !checkpoint.checkpointDigest) throw new Error("[graph-authority] Relation graph checkpoint has no complete identity");
  if (checkpoint.seeds.some((seed) => !seed.contentDigest)) throw new Error("[graph-authority] Relation graph checkpoint contains a seed without a full content digest");
  if (checkpoint.nodes.some((node) => ["file", "generated", "test", "config"].includes(node.kind) && !node.digest)) throw new Error("[graph-authority] Relation graph checkpoint contains an authoritative node without a full content digest");
  if (checkpoint.edges.some((edge) => !edge.evidenceDigest)) throw new Error("[graph-authority] Relation graph checkpoint contains an edge without a full evidence digest");
  const unsigned = { ...checkpoint } as Record<string, unknown>;
  delete unsigned.checkpointId;
  delete unsigned.checkpointDigest;
  const digest = relationGraphCheckpointDigest(unsigned as never);
  if (digest !== checkpoint.checkpointDigest) throw new Error("[graph-tamper] Relation graph checkpoint digest does not match its payload");
  if (checkpoint.checkpointId !== `relation-graph:${checkpoint.checkpointDigest}`) throw new Error("[graph-tamper] Relation graph checkpoint ID does not match its digest");
  if (metadata.checkpointId !== checkpoint.checkpointId || metadata.checkpointDigest !== checkpoint.checkpointDigest) throw new Error("[graph-authority] Packet is not bound to the exact relation graph checkpoint");
  if (checkpoint.baseSha.toLowerCase() !== input.baseSha.toLowerCase() || metadata.baseSha.toLowerCase() !== input.baseSha.toLowerCase()) throw new Error("[graph-stale] Relation graph checkpoint base SHA is stale");
  if (checkpoint.graphDigest !== metadata.graphDigest || checkpoint.closureDigest !== metadata.closureDigest
    || checkpoint.configDigest !== metadata.configDigest || checkpoint.commandPlanDigest !== metadata.commandPlanDigest
    || checkpoint.evidenceContractDigest !== metadata.evidenceContractDigest) throw new Error("[graph-drift] Packet relation metadata differs from its checkpoint");

  const graph = checkpointGraph(checkpoint);
  revalidateRelationGraph(graph, { baseSha: input.baseSha, graphDigest: checkpoint.graphDigest });
  const checkpointClosure = closeRelationGraph(graph);
  if (checkpointClosure.diagnostics.length) throw new Error(checkpointClosure.diagnostics.join("\n"));
  assertEqualPaths(checkpointClosure.writablePaths, checkpoint.writablePaths, "writable closure");
  assertAuthorizedSubset(checkpointClosure.evidencePaths, checkpoint.evidencePaths, "evidence closure");
  assertEqualPaths(checkpointClosure.invariantIds, checkpoint.invariantIds, "invariant closure");
  assertAuthorizedSubset(checkpointClosure.commandIds, checkpoint.commandIds, "command closure");

  const adapters = input.adapters ?? repositoryAdaptersFor(await detectRepositoryLanguages(input.cwd));
  const plannedPaths = new Set(packet.investigationScopeReceipt?.newPaths ?? []);
  const facts = [];
  for (const adapter of adapters) {
    const fact = await adapter.inspect({ cwd: input.cwd, limits: checkpoint.limits });
    // Planned paths are represented by deterministic base placeholders in the
    // checkpoint. Ignore their dirty post-build adapter nodes/edges so strict
    // restart certification remains anchored to the exact base evidence.
    facts.push(plannedPaths.size ? {
      ...fact,
      nodes: fact.nodes.filter((node) => !plannedPaths.has(node.identity)),
      edges: (() => {
        const removedNodeIds = new Set(fact.nodes.filter((node) => plannedPaths.has(node.identity)).map((node) => node.id));
        return fact.edges.filter((edge) => !removedNodeIds.has(edge.sourceId) && !removedNodeIds.has(edge.targetId)
          && !plannedPaths.has(edge.sourcePath ?? "") && !plannedPaths.has(edge.targetPath ?? ""));
      })(),
    } : fact);
  }
  const fresh = buildRelationGraph({ baseSha: input.baseSha, seeds: checkpoint.seeds, facts, limits: checkpoint.limits });
  revalidateRelationGraph(graph, { baseSha: input.baseSha, graphDigest: checkpoint.graphDigest }, fresh);
  const freshClosure = closeRelationGraph(fresh);
  if (freshClosure.diagnostics.length) throw new Error(freshClosure.diagnostics.join("\n"));
  assertEqualPaths(freshClosure.writablePaths, checkpoint.writablePaths, "fresh writable closure");
  assertAuthorizedSubset(freshClosure.evidencePaths, checkpoint.evidencePaths, "fresh evidence closure");
  assertEqualPaths(freshClosure.invariantIds, checkpoint.invariantIds, "fresh invariant closure");
  assertAuthorizedSubset(freshClosure.commandIds, checkpoint.commandIds, "fresh command closure");

  const expectedClosureDigest = digestRelation({ graphDigest: checkpoint.graphDigest, writablePaths: checkpoint.writablePaths, evidencePaths: checkpoint.evidencePaths, invariantIds: checkpoint.invariantIds, commandIds: checkpoint.commandIds });
  if (expectedClosureDigest !== checkpoint.closureDigest) throw new Error("[graph-tamper] Relation graph closure digest does not match its paths");
  const expectedConfigDigest = graphConfigDigest({ adapters: fresh.adapterIds, limits: fresh.limits });
  if (expectedConfigDigest !== checkpoint.configDigest) throw new Error("[graph-drift] Relation graph configuration digest differs from checkout authority");
  const commandPlan = {
    ...(packet.verificationPolicyVersion !== undefined ? { verificationPolicyVersion: packet.verificationPolicyVersion } : {}),
    ...(packet.verificationCommandTargets !== undefined ? { verificationCommandTargets: packet.verificationCommandTargets } : {}),
    ...(packet.verificationCommandIdentities !== undefined ? { verificationCommandIdentities: packet.verificationCommandIdentities } : {}),
  };
  if (graphCommandPlanDigest(commandPlan) !== checkpoint.commandPlanDigest) throw new Error("[graph-drift] Relation graph command plan is stale");
  if (graphEvidenceContractDigest(packet.evidenceContract) !== checkpoint.evidenceContractDigest) throw new Error("[graph-drift] Relation graph evidence contract is stale");
  assertEqualPaths(packet.expectedPaths, checkpoint.writablePaths, "packet expected paths");
  const packetEvidencePaths = (packet.evidencePaths ?? []).map(({ path }) => path);
  if (packetEvidencePaths.some((path) => !checkpoint.evidencePaths.includes(path))) throw new Error("[graph-drift] Packet evidence path is outside its frozen authority");
}

export function checkpointGraph(checkpoint: RelationGraphCheckpointPayload): RelationGraph {
  return {
    version: checkpoint.version,
    baseSha: checkpoint.baseSha,
    adapterIds: [...checkpoint.adapterIds],
    seeds: checkpoint.seeds.map((seed) => ({ ...seed })),
    nodes: checkpoint.nodes.map((node) => ({ ...node })),
    edges: checkpoint.edges.map((edge) => ({ ...edge })),
    limits: { ...checkpoint.limits },
    graphDigest: checkpoint.graphDigest,
  };
}

function assertAuthorizedSubset(actual: readonly string[], authority: readonly string[], label: string): void {
  const allowed = new Set(authority);
  const unexpected = [...new Set(actual)].filter((value) => !allowed.has(value)).sort();
  if (unexpected.length) throw new Error(`[graph-drift] Relation graph ${label} exceeds its frozen authority: ${unexpected.join(", ")}`);
}

function assertEqualPaths(actual: readonly string[], expected: readonly string[], label: string): void {
  const left = JSON.stringify([...actual].sort());
  const right = JSON.stringify([...expected].sort());
  if (left !== right) throw new Error(`[graph-drift] Relation graph ${label} differs from its frozen authority`);
}
