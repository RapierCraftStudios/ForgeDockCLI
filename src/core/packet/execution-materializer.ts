// SPDX-License-Identifier: AGPL-3.0-or-later

import { digestRelation, canonicalJson } from "./relation-graph.js";
import { compileExecutionDag, normalizePacketPaths, normalizeSemanticDependencies } from "../../workflows/orchestrate/packet-wave.js";
import { assembleWorkUnits, DEFAULT_BATCHING_OPTIONS, type BatchingOptions } from "../../workflows/orchestrate/assemble.js";
import type { BatchableWorkItem } from "../../workflows/orchestrate/batching.js";
import { normalizedDeliveryRouteClaim, validateGraph, type ClaimSerializationEdge, type ScheduledWorkItem } from "../../workflows/orchestrate/scheduler.js";
import type {
  OrchestrationBatchCandidate,
  OrchestrationBuilderFrontierEntry,
  OrchestrationExecutionPlan,
  OrchestrationInvestigationRecord,
  OrchestrationItemRecord,
  OrchestrationPacketRecord,
  OrchestrationRecord,
  OrchestrationSerializationEdgeRecord,
} from "../ports/orchestration.js";

export interface ExecutionMaterializerLimits {
  maxNodes: number;
  maxEdges: number;
  maxFrontier: number;
  maxBatchCandidates: number;
}

export const DEFAULT_EXECUTION_MATERIALIZER_LIMITS: Readonly<ExecutionMaterializerLimits> = Object.freeze({
  maxNodes: 256,
  maxEdges: 4_096,
  maxFrontier: 256,
  maxBatchCandidates: 256,
});

/** Packet-bound evidence projected by the controller, not by a worker prompt. */
export interface ExecutionPacketEvidence extends OrchestrationPacketRecord {}

export interface ExecutionMaterializerInput {
  orchestration: Readonly<OrchestrationRecord>;
  items: readonly ScheduledWorkItem[];
  packets: readonly ExecutionPacketEvidence[];
  investigations?: readonly OrchestrationInvestigationRecord[];
  baseSha: string;
  serializationEdges?: readonly ClaimSerializationEdge[];
  batching?: BatchingOptions;
  limits?: Partial<ExecutionMaterializerLimits>;
  /** New controller-owned callers use strict certification; legacy adapters may opt into projection-only replay. */
  requireCompleteEvidence?: boolean;
}

export interface CertifiedExecutionSet {
  items: ScheduledWorkItem[];
  serializationEdges: ClaimSerializationEdge[];
  settledSetDigest: string;
  baseSha: string;
  packetDigest: string;
  relationDigest: string;
  verificationDigest: string;
  riskDigest: string;
  claimDigest: string;
}

export interface ExecutionMaterializationResult {
  plan: OrchestrationExecutionPlan;
  certified: CertifiedExecutionSet;
  builderFrontier: OrchestrationBuilderFrontierEntry[];
  batchCandidates: OrchestrationBatchCandidate[];
}

export class ExecutionMaterializationCertificationError extends Error {
  readonly code: "identity" | "route" | "packet" | "relation" | "semantic" | "verification" | "risk" | "claims" | "limit" | "tamper";

  constructor(code: ExecutionMaterializationCertificationError["code"], message: string) {
    super(`[execution-certification:${code}] ${message}`);
    this.name = "ExecutionMaterializationCertificationError";
    this.code = code;
  }
}

/**
 * The single pure admission gate for a settled execution set. It has no
 * repository, GitHub, clock, or batch-issue side effect and returns nothing
 * until every bounded projection is internally consistent.
 */
export function certifyExecutionSet(input: ExecutionMaterializerInput): CertifiedExecutionSet {
  const limits = normalizedLimits(input.limits);
  if (!input.items.length) throw new ExecutionMaterializationCertificationError("identity", "settled set is empty");
  if (input.items.length > limits.maxNodes) throw new ExecutionMaterializationCertificationError("limit", "execution node limit exceeded");
  if (!input.baseSha.trim()) throw new ExecutionMaterializationCertificationError("identity", "exact base identity is missing");

  const byId = new Map<string, ScheduledWorkItem>();
  const issueKeys = new Set<string>();
  for (const raw of input.items) {
    if (!raw.id.trim() || byId.has(raw.id)) throw new ExecutionMaterializationCertificationError("identity", `duplicate node identity ${raw.id}`);
    const repository = raw.repository?.trim();
    if (!repository) throw new ExecutionMaterializationCertificationError("identity", `node ${raw.id} lacks repository-qualified issue identity`);
    if (!Number.isSafeInteger(raw.issue) || raw.issue < 1) throw new ExecutionMaterializationCertificationError("identity", `node ${raw.id} has an invalid issue identity`);
    const issueKey = `${repository.toLowerCase()}#${raw.issue}`;
    if (issueKeys.has(issueKey)) throw new ExecutionMaterializationCertificationError("identity", `duplicate repository-qualified issue ${issueKey}`);
    issueKeys.add(issueKey);
    if (!raw.targetBranch?.trim()) {
      throw new ExecutionMaterializationCertificationError("route", `node ${raw.id} lacks a complete delivery route`);
    }
    const route = normalizedDeliveryRouteClaim(repository, raw.targetBranch);
    if (raw.targetRouteClaim !== undefined && raw.targetRouteClaim !== route) {
      throw new ExecutionMaterializationCertificationError("route", `node ${raw.id} has contradictory delivery route evidence`);
    }
    byId.set(raw.id, {
      ...raw,
      repository,
      targetRouteClaim: route,
      dependencies: [...raw.dependencies],
      claims: [...raw.claims],
      ...(raw.affectedFiles ? { affectedFiles: [...raw.affectedFiles] } : {}),
      ...(raw.memberIssues ? { memberIssues: [...raw.memberIssues] } : {}),
      ...(raw.plan !== undefined ? { plan: structuredClone(raw.plan) } : {}),
    });
  }

  if (input.investigations !== undefined) {
    const settled = input.investigations.filter((entry) => entry.status === "completed" && entry.outcome === "confirmed");
    const settledIds = new Set(settled.map((entry) => entry.nodeId));
    if (settledIds.size !== byId.size || [...byId.keys()].some((id) => !settledIds.has(id))) {
      throw new ExecutionMaterializationCertificationError("identity", "settled confirmed union does not match execution nodes");
    }
    for (const entry of settled) {
      const item = byId.get(entry.nodeId)!;
      if (entry.issue !== item.issue) throw new ExecutionMaterializationCertificationError("identity", `investigation issue drift for ${entry.nodeId}`);
      if (entry.targetBranch !== undefined && entry.targetBranch !== item.targetBranch) throw new ExecutionMaterializationCertificationError("route", `investigation route drift for ${entry.nodeId}`);
    }
  }

  const packetsByNode = new Map<string, ExecutionPacketEvidence>();
  const packetIds = new Set<string>();
  for (const packet of input.packets) {
    if (!byId.has(packet.nodeId)) throw new ExecutionMaterializationCertificationError("packet", `packet ${packet.nodeId} is outside the settled node set`);
    if (packetsByNode.has(packet.nodeId)) throw new ExecutionMaterializationCertificationError("packet", `duplicate packet node identity ${packet.nodeId}`);
    if (packet.packetId !== undefined && packetIds.has(packet.packetId)) throw new ExecutionMaterializationCertificationError("packet", `duplicate packet identity ${packet.packetId}`);
    if (packet.packetId !== undefined) packetIds.add(packet.packetId);
    packetsByNode.set(packet.nodeId, packet);
  }

  const packetInputs = input.items.map((item) => {
    const packet = packetsByNode.get(item.id);
    if (!packet || packet.status !== "completed" || !packet.baseSha || !packet.expectedPaths?.length) {
      throw new ExecutionMaterializationCertificationError("packet", `complete packet evidence is missing for ${item.id}`);
    }
    if (packet.baseSha !== input.baseSha) throw new ExecutionMaterializationCertificationError("packet", `packet base drift for ${item.id}`);
    if (packet.identity) {
      if (packet.identity.nodeId !== item.id || packet.identity.subject.issue !== item.issue
        || packet.identity.subject.repo.trim().toLowerCase() !== item.repository!.trim().toLowerCase()
        || packet.identity.baseSha !== input.baseSha) {
        throw new ExecutionMaterializationCertificationError("identity", `packet identity drift for ${item.id}`);
      }
      const investigation = input.investigations?.find((entry) => entry.nodeId === item.id);
      if (investigation?.runId !== undefined && packet.identity.runId !== investigation.runId) {
        throw new ExecutionMaterializationCertificationError("identity", `packet run identity drift for ${item.id}`);
      }
      if (investigation?.investigationArtifactId !== undefined && packet.identity.investigationId !== investigation.investigationArtifactId) {
        throw new ExecutionMaterializationCertificationError("identity", `packet investigation identity drift for ${item.id}`);
      }
    }
    const paths = normalizePacketPaths(packet.expectedPaths);
    const semanticDependencies = normalizeSemanticDependencies(packet.semanticDependencies ?? []);
    for (const dependency of semanticDependencies) {
      if (!byId.has(dependency)) throw new ExecutionMaterializationCertificationError("semantic", `unknown semantic dependency ${dependency} from ${item.id}`);
    }
    validatePacketCertification(item, packet, paths, input.requireCompleteEvidence === true);
    return {
      id: item.id,
      issue: item.issue,
      expectedPaths: paths,
      baseRef: input.baseSha,
      semanticDependencies,
      ...(item.memberIssues ? { childIssues: item.memberIssues } : {}),
    };
  });

  const compiled = compileExecutionDag({ items: [...byId.values()], packets: packetInputs, baseRef: input.baseSha });
  const suppliedEdges = input.serializationEdges?.map(cloneEdge);
  if (suppliedEdges !== undefined && digestRelation(suppliedEdges.map(edgeProjection).sort(compareCanonical))
    !== digestRelation(compiled.edges.map(edgeProjection).sort(compareCanonical))) {
    throw new ExecutionMaterializationCertificationError("claims", "supplied serialization edges drift from the certified sparse claim graph");
  }
  const edges = suppliedEdges ?? compiled.edges;
  validateGraph(compiled.items, edges);
  if (edges.length > limits.maxEdges) throw new ExecutionMaterializationCertificationError("limit", "serialization edge limit exceeded");

  const packetDigest = executionPacketEvidenceDigest(input.packets);
  const relationDigest = digestRelation(input.packets.map((packet) => packet.certification?.relationDigest ?? null).sort());
  const verificationDigest = digestRelation(input.packets.map((packet) => packet.certification?.verificationCommandIdentities ?? []).flat().sort(compareCanonical));
  const riskDigest = digestRelation(compiled.items.map((item) => item.plan?.riskPolicy ?? item.plan?.risk ?? null));
  const claimDigest = digestRelation(compiled.items.map((item) => ({ id: item.id, claims: [...item.claims].sort(), route: item.targetRouteClaim })).sort(compareCanonical));
  const settledSetDigest = executionSettledEvidenceDigest(
    input.orchestration,
    compiled.items.map(orchestrationItem).sort((left, right) => left.id.localeCompare(right.id)),
    input.packets,
    input.investigations ?? [],
    input.baseSha,
  );
  return { items: compiled.items, serializationEdges: edges, settledSetDigest, baseSha: input.baseSha, packetDigest, relationDigest, verificationDigest, riskDigest, claimDigest };
}

/** Deterministically derives the immutable plan and both pure projections. */
export function materializeExecutionPlan(input: ExecutionMaterializerInput): ExecutionMaterializationResult {
  const limits = normalizedLimits(input.limits);
  const certified = certifyExecutionSet(input);
  const nodes = certified.items.map(orchestrationItem).sort((left, right) => left.id.localeCompare(right.id));
  const serializationEdges = certified.serializationEdges.map(orchestrationEdge).sort(compareEdges);
  const builderFrontier = certified.items
    .filter((item) => item.dependencies.length === 0)
    .map((item) => ({
      nodeId: item.id,
      issue: item.issue,
      repository: item.repository!,
      targetRouteClaim: item.targetRouteClaim!,
      dependencies: [...item.dependencies],
      claims: [...item.claims],
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  if (builderFrontier.length > limits.maxFrontier) throw new ExecutionMaterializationCertificationError("limit", "builder frontier limit exceeded");

  const batchCandidates = deriveBatchCandidates(certified.items, input.batching ?? defaultBatching(input.orchestration));
  if (batchCandidates.length > limits.maxBatchCandidates) throw new ExecutionMaterializationCertificationError("limit", "batch candidate limit exceeded");
  const unsigned = {
    version: "forgedock.execution-plan/v1" as const,
    settledSetDigest: certified.settledSetDigest,
    baseSha: certified.baseSha,
    packetDigest: certified.packetDigest,
    relationDigest: certified.relationDigest,
    verificationDigest: certified.verificationDigest,
    riskDigest: certified.riskDigest,
    claimDigest: certified.claimDigest,
    nodes,
    serializationEdges,
    builderFrontier,
    batchCandidates,
    limits,
  };
  const digest = digestRelation(unsigned);
  const plan: OrchestrationExecutionPlan = { ...unsigned, digest };
  return { plan, certified, builderFrontier, batchCandidates };
}

export function executionPacketEvidenceDigest(packets: readonly ExecutionPacketEvidence[]): string {
  return digestRelation(packets.map(packetProjection).sort(compareCanonical));
}

export function executionSettledEvidenceDigest(
  orchestration: Pick<OrchestrationRecord, "orchestrationId" | "repository">,
  items: readonly OrchestrationItemRecord[],
  packets: readonly ExecutionPacketEvidence[],
  investigations: readonly OrchestrationInvestigationRecord[],
  baseSha: string,
): string {
  return digestRelation({
    orchestrationId: orchestration.orchestrationId,
    repository: orchestration.repository.trim().toLowerCase(),
    baseSha,
    items,
    packets: packets.map(packetProjection).sort(compareCanonical),
    investigations: [...investigations].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  });
}

export function executionPlanDigest(plan: OrchestrationExecutionPlan): string {
  const { digest: _digest, ...unsigned } = plan;
  return digestRelation(unsigned);
}

/** Fail closed on durable tampering before any scheduler dispatch. */
export function assertExecutionPlanIntegrity(plan: OrchestrationExecutionPlan): void {
  if (plan.version !== "forgedock.execution-plan/v1") throw new ExecutionMaterializationCertificationError("tamper", "unknown execution plan version");
  if (!/^[0-9a-f]{64}$/.test(plan.digest) || executionPlanDigest(plan) !== plan.digest) {
    throw new ExecutionMaterializationCertificationError("tamper", "execution plan digest does not match its canonical payload");
  }
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) throw new ExecutionMaterializationCertificationError("tamper", `execution plan duplicates node ${node.id}`);
    ids.add(node.id);
  }
  validateGraph(plan.nodes.map((node) => ({ ...node, status: "queued" as const, childRunIds: [] })), plan.serializationEdges.map((edge) => ({ ...edge })));
}

function validatePacketCertification(item: ScheduledWorkItem, packet: ExecutionPacketEvidence, paths: readonly string[], strict: boolean): void {
  const certification = packet.certification;
  if (!strict) return;
  if (!certification) throw new ExecutionMaterializationCertificationError("relation", `packet ${item.id} has no complete certification evidence`);
  if (JSON.stringify(normalizePacketPaths(certification.expectedPaths)) !== JSON.stringify(paths)) {
    throw new ExecutionMaterializationCertificationError("relation", `packet ${item.id} has contradictory exact path evidence`);
  }
  const certifiedPaths = new Set(certification.relationPaths ?? []);
  for (const path of paths) if (!certifiedPaths.has(path)) throw new ExecutionMaterializationCertificationError("relation", `packet ${item.id} path ${path} is outside relation closure`);
  if (!certification.symbols?.length) throw new ExecutionMaterializationCertificationError("relation", `packet ${item.id} has no exact symbol evidence`);
  if (!certification.generatedPaths || !certification.sourcePaths || !certification.testPaths || !certification.configPaths) {
    throw new ExecutionMaterializationCertificationError("relation", `packet ${item.id} lacks generated/source/test/config closure evidence`);
  }
  const commandIds = certification.verificationCommandIdentities ?? [];
  if (!commandIds.length || commandIds.some((command) => !command.id || !/^[0-9a-f]{64}$/.test(command.identityDigest))) {
    throw new ExecutionMaterializationCertificationError("verification", `packet ${item.id} lacks stable verification command identities`);
  }
  if (new Set(commandIds.map((command) => command.id)).size !== commandIds.length) {
    throw new ExecutionMaterializationCertificationError("verification", `packet ${item.id} contains duplicate verification command identities`);
  }
  if (certification.verificationCapabilityIds !== undefined
    && commandIds.some((command) => !certification.verificationCapabilityIds!.includes(command.id))) {
    throw new ExecutionMaterializationCertificationError("verification", `packet ${item.id} command identity is not a selected capability`);
  }
  const relationPaths = new Set(certification.relationPaths ?? []);
  if (commandIds.some((command) => command.targets.some((target) => !relationPaths.has(target) && !paths.includes(target)))) {
    throw new ExecutionMaterializationCertificationError("verification", `packet ${item.id} has verification target drift`);
  }
  if (!certification.verificationPolicyVersion) throw new ExecutionMaterializationCertificationError("verification", `packet ${item.id} lacks verification policy identity`);
  if (!certification.riskPolicyDigest) throw new ExecutionMaterializationCertificationError("risk", `packet ${item.id} lacks risk policy evidence`);
  if (!certification.claimDigest) throw new ExecutionMaterializationCertificationError("claims", `packet ${item.id} lacks claim evidence`);
}

function deriveBatchCandidates(items: readonly ScheduledWorkItem[], options: BatchingOptions): OrchestrationBatchCandidate[] {
  const batchItems: BatchableWorkItem[] = items.map((item) => ({
    ...item,
    title: item.title ?? item.id,
    summary: item.summary ?? item.id,
    labels: labelsFromPlan(item.plan),
    affectedFiles: [...(item.affectedFiles ?? item.claims)],
    ...(item.repository !== undefined ? { repository: item.repository } : {}),
    ...(item.targetBranch !== undefined ? { targetBranch: item.targetBranch } : {}),
    riskClass: riskFromPlan(item.plan),
  }));
  const assembly = assembleWorkUnits(batchItems, options);
  return assembly.groups.map((group) => ({
    id: group.id,
    kind: group.kind,
    key: group.key,
    riskClass: group.riskClass,
    memberNodeIds: group.members.map((member) => member.id).sort(),
    memberIssues: group.members.map((member) => member.issue).sort((left, right) => left - right),
    repository: group.members[0]!.repository ?? group.members[0]!.repo!,
    targetBranch: group.members[0]!.targetBranch!,
    claims: [...new Set(group.members.flatMap((member) => member.claims))].sort(),
    affectedFiles: [...new Set(group.members.flatMap((member) => member.affectedFiles))].sort(),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function defaultBatching(orchestration: Readonly<OrchestrationRecord>): BatchingOptions {
  const raw = orchestration.plan?.batching;
  if (raw && typeof raw === "object") {
    const candidate = raw as Partial<BatchingOptions>;
    if (candidate.policy && candidate.maxBatchSize && candidate.maxSensitiveBatchSize) return {
      ...DEFAULT_BATCHING_OPTIONS,
      ...candidate,
    } as BatchingOptions;
  }
  return { ...DEFAULT_BATCHING_OPTIONS };
}

function normalizedLimits(input: Partial<ExecutionMaterializerLimits> | undefined): ExecutionMaterializerLimits {
  const limits = { ...DEFAULT_EXECUTION_MATERIALIZER_LIMITS, ...(input ?? {}) };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new ExecutionMaterializationCertificationError("limit", `${name} must be a positive integer`);
  }
  return limits;
}

function orchestrationItem(item: ScheduledWorkItem): OrchestrationItemRecord {
  return {
    id: item.id,
    issue: item.issue,
    priority: item.priority,
    dependencies: [...item.dependencies],
    claims: [...item.claims],
    ...(item.repository !== undefined ? { repository: item.repository } : {}),
    ...(item.targetBranch !== undefined ? { targetBranch: item.targetBranch } : {}),
    ...(item.targetRouteClaim !== undefined ? { targetRouteClaim: item.targetRouteClaim } : {}),
    ...(item.lane !== undefined ? { lane: item.lane } : {}),
    ...(item.promotionTarget !== undefined ? { promotionTarget: item.promotionTarget } : {}),
    ...(item.productionTarget !== undefined ? { productionTarget: item.productionTarget } : {}),
    ...(item.affectedFiles !== undefined ? { affectedFiles: [...item.affectedFiles] } : {}),
    ...(item.memberIssues !== undefined ? { memberIssues: [...item.memberIssues] } : {}),
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.summary !== undefined ? { summary: item.summary } : {}),
    ...(item.plan !== undefined ? { plan: structuredClone(item.plan) } : {}),
  };
}

function orchestrationEdge(edge: ClaimSerializationEdge): OrchestrationSerializationEdgeRecord {
  return { predecessor: edge.predecessor, successor: edge.successor, overlappingClaims: [...edge.overlappingClaims].sort() };
}
function edgeProjection(edge: ClaimSerializationEdge): unknown {
  return { predecessor: edge.predecessor, successor: edge.successor, overlappingClaims: [...edge.overlappingClaims].sort() };
}
function cloneEdge(edge: ClaimSerializationEdge): ClaimSerializationEdge { return { predecessor: edge.predecessor, successor: edge.successor, overlappingClaims: [...edge.overlappingClaims] }; }
function packetProjection(packet: ExecutionPacketEvidence): unknown {
  return {
    nodeId: packet.nodeId, wave: packet.wave, status: packet.status, packetId: packet.packetId,
    expectedPaths: packet.expectedPaths, semanticDependencies: packet.semanticDependencies, baseSha: packet.baseSha,
    identity: packet.identity, certification: packet.certification,
  };
}
function compareEdges(left: OrchestrationSerializationEdgeRecord, right: OrchestrationSerializationEdgeRecord): number { return `${left.predecessor}\0${left.successor}`.localeCompare(`${right.predecessor}\0${right.successor}`); }
function compareCanonical(left: unknown, right: unknown): number { return canonicalJson(left).localeCompare(canonicalJson(right)); }
function labelsFromPlan(plan: ScheduledWorkItem["plan"]): string[] { const labels = plan?.labels; return Array.isArray(labels) ? labels.filter((value): value is string => typeof value === "string") : []; }
function riskFromPlan(plan: ScheduledWorkItem["plan"]): "routine" | "security" | "auth" | "billing" { const risk = plan?.riskClass; return risk === "security" || risk === "auth" || risk === "billing" ? risk : "routine"; }
