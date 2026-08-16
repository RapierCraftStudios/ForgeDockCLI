// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PlanningNode, PlanningPacket } from "../../core/planning/schema.js";
import type {
	IssueSnapshot,
	MaterializedPlanNode,
	PlanMaterializationHost,
	PlanMaterializationRequest,
	PlanMaterializationResult,
} from "../../core/ports/forge-host.js";
import {
	createPlanMaterializationRequest,
	materializeConfirmedPlan,
	materializedPlanToScheduledWorkItems,
	planNodeWorkItemId,
} from "./handoff.js";

const REPO = "owner/repo";

function node(
	id: string,
	dependsOn: string[] = [],
	priority = 2,
): PlanningNode {
	return {
		id,
		title: `Deliver ${id}`,
		outcome: `${id} is delivered`,
		dependsOn,
		acceptanceCriteria: [`${id} works`],
		affectedFiles: [`src/${id}.ts`],
		claims: [`src/${id}.ts`],
		verificationPlan: [`test ${id}`],
		priority,
		riskClass: "routine",
		evidenceIds: ["repo-evidence"],
	};
}

function packet(
	status: PlanningPacket["status"] = "confirmed",
	nodes: PlanningNode[] = [node("build")],
	openQuestions: string[] = [],
): PlanningPacket {
	return {
		schema: "forgedock.planning/v1",
		sessionId: "plan-stable",
		revision: 3,
		status,
		objective: "Ship the native planning handoff",
		assumptions: ["GitHub is the durable authority"],
		evidence: [
			{
				id: "repo-evidence",
				authority: "repository",
				source: "ForgeDock",
				locator: "src/core/planning",
				claim: "The planning schema is typed",
				detail: "Repository inspection confirmed the schema boundary.",
			},
		],
		vocabulary: [
			{
				id: "handoff-term",
				term: "handoff",
				definition: "A confirmed conversion into existing scheduler inputs.",
				aliases: ["execution handoff"],
				evidenceIds: ["repo-evidence"],
				status: "accepted",
			},
		],
		decisions: [
			{
				round: 1,
				questionId: "delivery-route",
				values: ["orchestrate"],
				labels: ["Orchestrate"],
				authority: "user",
			},
		],
		outOfScope: ["Automatic dispatch"],
		openQuestions,
		nodes,
	};
}

function issue(nodeId: string, number: number): IssueSnapshot {
	return {
		repo: REPO,
		number,
		title: `Deliver ${nodeId}`,
		body: `Plan node ${nodeId}`,
		url: `https://github.test/${REPO}/issues/${number}`,
		state: "OPEN",
	};
}

function resultNode(
	plan: PlanningPacket,
	nodeId: string,
	number: number,
	dependsOnNodeIds: string[],
	dependencyIssueNumbers: number[],
): MaterializedPlanNode {
	return {
		planId: plan.sessionId,
		revision: plan.revision,
		nodeId,
		issue: issue(nodeId, number),
		dependsOnNodeIds,
		dependencyIssueNumbers,
	};
}

describe("confirmed Deep Plan handoff", () => {
	it("performs no host mutation before explicit confirmation", async () => {
		let calls = 0;
		const host: PlanMaterializationHost = {
			async materializePlan(): Promise<PlanMaterializationResult> {
				calls += 1;
				throw new Error("must not be called");
			},
		};

		for (const status of ["ready", "handed-off", "blocked"] as const) {
			assert.throws(
				() => createPlanMaterializationRequest(REPO, packet(status)),
				new RegExp(`requires a confirmed packet; received ${status}`),
			);
			await assert.rejects(
				materializeConfirmedPlan({ repo: REPO, packet: packet(status), host }),
				new RegExp(`requires a confirmed packet; received ${status}`),
			);
		}

		const unresolved = packet("confirmed", undefined, [
			"Choose a rollout lane",
		]);
		assert.throws(
			() => createPlanMaterializationRequest(REPO, unresolved),
			/requires all open questions to be resolved/,
		);
		await assert.rejects(
			materializeConfirmedPlan({ repo: REPO, packet: unresolved, host }),
			/requires all open questions to be resolved/,
		);
		assert.equal(calls, 0);
	});

	it("rejects unknown and cyclic planning dependencies before mutation", () => {
		const unknown = packet("confirmed", [node("build", ["missing"])]);
		assert.throws(
			() => createPlanMaterializationRequest(REPO, unknown),
			/unknown planning node missing/,
		);

		const cyclic = packet("confirmed", [
			node("build", ["verify"]),
			node("verify", ["build"]),
		]);
		assert.throws(
			() => createPlanMaterializationRequest(REPO, cyclic),
			/planning node dependency cycle/,
		);
	});

	it("builds a stable rich materialization request from plan identities", () => {
		const confirmed = packet("confirmed", [
			node("verify", ["build"], 0),
			node("build", [], 2),
		]);
		const first = createPlanMaterializationRequest(` ${REPO} `, confirmed);
		const second = createPlanMaterializationRequest(REPO, confirmed);

		assert.deepEqual(first, second);
		assert.deepEqual(
			first.nodes.map(({ planId, revision, nodeId }) => ({
				planId,
				revision,
				nodeId,
			})),
			[
				{ planId: "plan-stable", revision: 3, nodeId: "build" },
				{ planId: "plan-stable", revision: 3, nodeId: "verify" },
			],
		);
		assert.deepEqual(first.nodes[1]?.dependsOnNodeIds, ["build"]);
		assert.deepEqual(first.nodes[1]?.acceptanceCriteria, ["verify works"]);
		assert.deepEqual(first.nodes[1]?.verificationPlan, ["test verify"]);
		assert.deepEqual(first.nodes[1]?.evidenceIds, ["repo-evidence"]);
	});

	it("converts a shuffled host mapping into one deterministic execution DAG", () => {
		const confirmed = packet("confirmed", [
			node("docs", [], 5),
			node("verify", ["build"], 1),
			node("build", [], 2),
		]);
		const materialization: PlanMaterializationResult = {
			repo: REPO,
			planId: confirmed.sessionId,
			revision: confirmed.revision,
			nodes: [
				resultNode(confirmed, "verify", 103, ["build"], [101]),
				resultNode(confirmed, "docs", 102, [], []),
				resultNode(confirmed, "build", 101, [], []),
			],
		};

		const first = materializedPlanToScheduledWorkItems(
			confirmed,
			materialization,
		);
		const second = materializedPlanToScheduledWorkItems(confirmed, {
			...materialization,
			nodes: [...materialization.nodes].reverse(),
		});

		assert.deepEqual(first, second);
		assert.deepEqual(
			first.map((item) => item.issue),
			[101, 103, 102],
		);
		assert.deepEqual(first[1]?.dependencies, [
			planNodeWorkItemId("plan-stable", 3, "build"),
		]);
		assert.equal(first[1]?.id, planNodeWorkItemId("plan-stable", 3, "verify"));
	});

	it("round-trips the returned handed-off packet without another host mutation", async () => {
		const confirmed = packet("confirmed", [
			node("docs", [], 5),
			node("verify", ["build"], 1),
			node("build", [], 2),
		]);
		let calls = 0;
		let captured: PlanMaterializationRequest | undefined;
		const host: PlanMaterializationHost = {
			async materializePlan(input) {
				calls += 1;
				captured = input;
				return {
					repo: REPO,
					planId: input.planId,
					revision: input.revision,
					nodes: [
						resultNode(confirmed, "verify", 103, ["build"], [101]),
						resultNode(confirmed, "docs", 102, [], []),
						resultNode(confirmed, "build", 101, [], []),
					],
				};
			},
		};

		const handoff = await materializeConfirmedPlan({
			repo: REPO,
			packet: confirmed,
			host,
		});
		const recovered = materializedPlanToScheduledWorkItems(
			handoff.packet,
			handoff.materialization,
		);

		assert.deepEqual(
			captured,
			createPlanMaterializationRequest(REPO, confirmed),
		);
		assert.equal(handoff.packet.status, "handed-off");
		assert.deepEqual(recovered, handoff.items);
		assert.deepEqual(
			recovered.map((item) => ({ id: item.id, issue: item.issue })),
			[
				{ id: planNodeWorkItemId("plan-stable", 3, "build"), issue: 101 },
				{ id: planNodeWorkItemId("plan-stable", 3, "verify"), issue: 103 },
				{ id: planNodeWorkItemId("plan-stable", 3, "docs"), issue: 102 },
			],
		);
		assert.deepEqual(recovered[1]?.dependencies, [
			planNodeWorkItemId("plan-stable", 3, "build"),
		]);
		assert.equal(calls, 1);
	});

	it("rejects tampered handed-off mappings before returning scheduler items", () => {
		const confirmed = packet("confirmed", [
			node("docs", [], 5),
			node("verify", ["build"], 1),
			node("build", [], 2),
		]);
		const handedOff: PlanningPacket = { ...confirmed, status: "handed-off" };
		const materialization: PlanMaterializationResult = {
			repo: REPO,
			planId: handedOff.sessionId,
			revision: handedOff.revision,
			nodes: [
				resultNode(handedOff, "verify", 103, ["build"], [101]),
				resultNode(handedOff, "docs", 102, [], []),
				resultNode(handedOff, "build", 101, [], []),
			],
		};
		const reject = (
			candidate: PlanMaterializationResult,
			message: RegExp,
		): void => {
			assert.throws(
				() =>
					materializedPlanToScheduledWorkItems(handedOff, candidate),
				message,
			);
		};

		reject(
			{ ...materialization, planId: "stale-plan" },
			/Materialized plan ID .* does not match/,
		);
		reject(
			{
				...materialization,
				nodes: materialization.nodes.map((result) =>
					result.nodeId === "build"
						? { ...result, planId: "stale-plan" }
						: result,
				),
			},
			/has a mismatched plan identity/,
		);
		reject(
			{
				...materialization,
				nodes: materialization.nodes.map((result) =>
					result.nodeId === "build"
						? { ...result, issue: { ...result.issue, repo: "foreign/repo" } }
						: result,
				),
			},
			/issue belongs to foreign\/repo/,
		);
		reject(
			{
				...materialization,
				nodes: materialization.nodes.map((result) =>
					result.nodeId === "build"
						? { ...result, issue: { ...result.issue, state: "CLOSED" } }
						: result,
				),
			},
			/issue is closed/,
		);
		reject(
			{
				...materialization,
				nodes: materialization.nodes.map((result) =>
					result.nodeId === "build"
						? { ...result, issue: { ...result.issue, number: 103 } }
						: result,
				),
			},
			/assigned issue #103 to more than one node/,
		);
		reject(
			{ ...materialization, nodes: materialization.nodes.slice(0, 2) },
			/omitted node build/,
		);
		reject(
			{
				...materialization,
				nodes: [
					...materialization.nodes,
					resultNode(handedOff, "unknown", 104, [], []),
				],
			},
			/unknown node unknown/,
		);
		reject(
			{
				...materialization,
				nodes: [...materialization.nodes, materialization.nodes[0]!],
			},
			/duplicate node verify/,
		);
		reject(
			{
				...materialization,
				nodes: materialization.nodes.map((result) =>
					result.nodeId === "verify"
						? { ...result, dependsOnNodeIds: [] }
						: result,
				),
			},
			/dependencies do not match/,
		);
		reject(
			{
				...materialization,
				nodes: materialization.nodes.map((result) =>
					result.nodeId === "verify"
						? { ...result, dependencyIssueNumbers: [999] }
						: result,
				),
			},
			/dependency issues do not match/,
		);
	});
});
