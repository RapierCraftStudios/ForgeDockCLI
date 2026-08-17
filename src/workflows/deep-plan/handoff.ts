// SPDX-License-Identifier: AGPL-3.0-or-later

import {
	assertPlanningPacket,
	type PlanningNode,
	type PlanningPacket,
} from "../../core/planning/schema.js";
import type {
	MaterializedPlanNode,
	PlanMaterializationHost,
	PlanMaterializationRequest,
	PlanMaterializationResult,
} from "../../core/ports/forge-host.js";
import {
	validateGraph,
	type ScheduledWorkItem,
} from "../orchestrate/scheduler.js";

export interface DeepPlanHandoffResult {
	packet: PlanningPacket;
	materialization: PlanMaterializationResult;
	items: ScheduledWorkItem[];
}

/**
 * Canonical, side-effect-free projection from a confirmed packet to the
 * GitHub port. No random IDs, titles, or adapter-derived state participate in
 * identity: the tuple (sessionId, revision, node.id) is stable.
 */
export function createPlanMaterializationRequest(
	repo: string,
	packet: PlanningPacket,
): PlanMaterializationRequest {
	assertConfirmedForMaterialization(packet);
	const normalizedRepo = repo.trim();
	if (!normalizedRepo) throw new Error("Plan handoff requires a repository");

	return {
		repo: normalizedRepo,
		planId: packet.sessionId,
		revision: packet.revision,
		objective: packet.objective,
		assumptions: [...packet.assumptions],
		evidence: [...packet.evidence]
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((evidence) => ({ ...evidence })),
		vocabulary: [...packet.vocabulary]
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((term) => ({
				...term,
				aliases: [...term.aliases],
				evidenceIds: [...term.evidenceIds].sort(),
			})),
		decisions: [...packet.decisions]
			.sort(
				(left, right) =>
					left.round - right.round ||
					left.questionId.localeCompare(right.questionId),
			)
			.map((decision) => ({
				...decision,
				values: [...decision.values],
				labels: [...decision.labels],
				...(decision.optionNotes !== undefined
					? { optionNotes: sortedRecord(decision.optionNotes) }
					: {}),
			})),
		outOfScope: [...packet.outOfScope],
		nodes: topologicallyOrderPlanningNodes(packet.nodes).map((node) => ({
			planId: packet.sessionId,
			revision: packet.revision,
			nodeId: node.id,
			title: node.title,
			outcome: node.outcome,
			dependsOnNodeIds: [...node.dependsOn].sort(),
			acceptanceCriteria: [...node.acceptanceCriteria],
			affectedFiles: [...node.affectedFiles],
			claims: [...node.claims],
			verificationPlan: [...node.verificationPlan],
			priority: node.priority,
			riskClass: node.riskClass,
			evidenceIds: [...node.evidenceIds].sort(),
		})),
	};
}

/**
 * Execute the single authorized host mutation, then convert its authoritative
 * node/issue mapping into the scheduler's existing work-item contract.
 */
export async function materializeConfirmedPlan(input: {
	repo: string;
	packet: PlanningPacket;
	host: PlanMaterializationHost;
}): Promise<DeepPlanHandoffResult> {
	const request = createPlanMaterializationRequest(input.repo, input.packet);
	const materialization = await input.host.materializePlan(request);
	if (materialization.repo !== request.repo) {
		throw new Error(
			`Materialized plan repository ${materialization.repo} does not match ${request.repo}`,
		);
	}
	const items = materializedPlanToScheduledWorkItems(
		input.packet,
		materialization,
	);
	const handedOff: PlanningPacket = {
		...input.packet,
		status: "handed-off",
	};
	assertPlanningPacket(handedOff);
	return { packet: handedOff, materialization, items };
}

/**
 * Pure conversion for controller recovery. Adapter result order is ignored;
 * output is a deterministic topological order using priority and stable node
 * ID as tie breakers.
 */
export function materializedPlanToScheduledWorkItems(
	packet: PlanningPacket,
	materialization: PlanMaterializationResult,
): ScheduledWorkItem[] {
	assertRecoverableHandoff(packet);
	const mapped = assertMaterializationMatchesPacket(packet, materialization);
	const items = topologicallyOrderPlanningNodes(packet.nodes).map((node) => {
		const result = mapped.get(node.id)!;
		return {
			id: planNodeWorkItemId(packet.sessionId, packet.revision, node.id),
			issue: result.issue.number,
			priority: node.priority,
			dependencies: [...node.dependsOn]
				.sort()
				.map((dependency) =>
					planNodeWorkItemId(
						packet.sessionId,
						packet.revision,
						dependency,
					),
				),
			claims: [...node.claims],
			affectedFiles: [...node.affectedFiles],
			title: node.title,
			summary: node.outcome,
		};
	});
	validateGraph(items);
	return items;
}

export function planNodeWorkItemId(
	planId: string,
	revision: number,
	nodeId: string,
): string {
	return `plan/${encodeURIComponent(planId)}/revision/${revision}/node/${encodeURIComponent(nodeId)}`;
}

function assertConfirmedForMaterialization(packet: PlanningPacket): void {
	assertPlanningPacket(packet);
	if (packet.status !== "confirmed") {
		throw new Error(
			`Plan handoff requires a confirmed packet; received ${packet.status}`,
		);
	}
	assertNoOpenQuestions(packet);
}

function assertRecoverableHandoff(packet: PlanningPacket): void {
	assertPlanningPacket(packet);
	if (packet.status !== "confirmed" && packet.status !== "handed-off") {
		throw new Error(
			`Plan handoff recovery requires a confirmed or handed-off packet; received ${packet.status}`,
		);
	}
	assertNoOpenQuestions(packet);
}

function assertNoOpenQuestions(packet: PlanningPacket): void {
	if (packet.openQuestions.length) {
		throw new Error(
			`Plan handoff requires all open questions to be resolved: ${packet.openQuestions.join(", ")}`,
		);
	}
}

function assertMaterializationMatchesPacket(
	packet: PlanningPacket,
	materialization: PlanMaterializationResult,
): Map<string, MaterializedPlanNode> {
	if (materialization.planId !== packet.sessionId) {
		throw new Error(
			`Materialized plan ID ${materialization.planId} does not match ${packet.sessionId}`,
		);
	}
	if (materialization.revision !== packet.revision) {
		throw new Error(
			`Materialized plan revision ${materialization.revision} does not match ${packet.revision}`,
		);
	}
	if (!materialization.repo.trim()) {
		throw new Error("Materialized plan repository must not be blank");
	}
	const expected = new Map(packet.nodes.map((node) => [node.id, node]));
	const mapped = new Map<string, MaterializedPlanNode>();
	const issueNumbers = new Set<number>();
	for (const result of materialization.nodes) {
		if (mapped.has(result.nodeId)) {
			throw new Error(`Materialized plan returned duplicate node ${result.nodeId}`);
		}
		const node = expected.get(result.nodeId);
		if (!node) {
			throw new Error(`Materialized plan returned unknown node ${result.nodeId}`);
		}
		if (
			result.planId !== packet.sessionId ||
			result.revision !== packet.revision
		) {
			throw new Error(
				`Materialized node ${result.nodeId} has a mismatched plan identity`,
			);
		}
		if (result.issue.repo !== materialization.repo) {
			throw new Error(
				`Materialized node ${result.nodeId} issue belongs to ${result.issue.repo}, not ${materialization.repo}`,
			);
		}
		if (result.issue.state !== "OPEN") {
			throw new Error(
				`Materialized node ${result.nodeId} issue is ${result.issue.state.toLowerCase()}`,
			);
		}
		if (!Number.isSafeInteger(result.issue.number) || result.issue.number < 1) {
			throw new Error(
				`Materialized node ${result.nodeId} has invalid issue number ${result.issue.number}`,
			);
		}
		if (issueNumbers.has(result.issue.number)) {
			throw new Error(
				`Materialized plan assigned issue #${result.issue.number} to more than one node`,
			);
		}
		issueNumbers.add(result.issue.number);
		assertSameSet(
			result.dependsOnNodeIds,
			node.dependsOn,
			`Materialized node ${result.nodeId} dependencies`,
		);
		mapped.set(result.nodeId, result);
	}
	for (const node of packet.nodes) {
		if (!mapped.has(node.id)) {
			throw new Error(`Materialized plan omitted node ${node.id}`);
		}
	}
	for (const node of packet.nodes) {
		const result = mapped.get(node.id)!;
		const dependencyIssueNumbers = node.dependsOn.map(
			(dependency) => mapped.get(dependency)!.issue.number,
		);
		assertSameNumberSet(
			result.dependencyIssueNumbers,
			dependencyIssueNumbers,
			`Materialized node ${node.id} dependency issues`,
		);
	}
	return mapped;
}

function topologicallyOrderPlanningNodes(
	nodes: readonly PlanningNode[],
): PlanningNode[] {
	const remaining = new Map(nodes.map((node) => [node.id, node]));
	const completed = new Set<string>();
	const result: PlanningNode[] = [];
	while (remaining.size) {
		const ready = [...remaining.values()]
			.filter((node) => node.dependsOn.every((id) => completed.has(id)))
			.sort(
				(left, right) =>
					left.priority - right.priority || left.id.localeCompare(right.id),
			);
		if (!ready.length) {
			throw new Error("Planning node dependency graph cannot be ordered");
		}
		const node = ready[0]!;
		remaining.delete(node.id);
		completed.add(node.id);
		result.push(node);
	}
	return result;
}

function sortedRecord(
	value: Readonly<Record<string, string>>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
	);
}

function assertSameSet(
	actual: readonly string[],
	expected: readonly string[],
	label: string,
): void {
	if (
		new Set(actual).size !== actual.length ||
		[...actual].sort().join("\u0000") !== [...expected].sort().join("\u0000")
	) {
		throw new Error(`${label} do not match the confirmed packet`);
	}
}

function assertSameNumberSet(
	actual: readonly number[],
	expected: readonly number[],
	label: string,
): void {
	if (
		new Set(actual).size !== actual.length ||
		[...actual].sort((left, right) => left - right).join(",") !==
			[...expected].sort((left, right) => left - right).join(",")
	) {
		throw new Error(`${label} do not match the confirmed packet`);
	}
}
