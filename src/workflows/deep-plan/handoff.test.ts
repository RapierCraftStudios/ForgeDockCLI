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

		await assert.rejects(
			materializeConfirmedPlan({ repo: REPO, packet: packet("ready"), host }),
			/requires a confirmed packet; received ready/,
		);
		await assert.rejects(
			materializeConfirmedPlan({
				repo: REPO,
				packet: packet("confirmed", undefined, ["Choose a rollout lane"]),
				host,
			}),
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

	it("passes the exact stable request to the host and marks only a valid mapping handed off", async () => {
		const confirmed = packet("confirmed", [node("build")]);
		let captured: PlanMaterializationRequest | undefined;
		const host: PlanMaterializationHost = {
			async materializePlan(input) {
				captured = input;
				return {
					repo: REPO,
					planId: input.planId,
					revision: input.revision,
					nodes: [resultNode(confirmed, "build", 101, [], [])],
				};
			},
		};

		const handoff = await materializeConfirmedPlan({
			repo: REPO,
			packet: confirmed,
			host,
		});
		assert.deepEqual(
			captured,
			createPlanMaterializationRequest(REPO, confirmed),
		);
		assert.equal(handoff.packet.status, "handed-off");
		assert.equal(handoff.items[0]?.issue, 101);
	});
});
