// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_PLANNING_QUESTIONS_PER_ROUND,
	acceptPlanningRound,
	buildPlanningPacket,
	canFinishPlanning,
	confirmPlanningPacket,
	createPlanningSession,
	openPlanningRound,
	PlanningSessionStore,
} from "./frontier.js";
import type { PlanningAnswer, PlanningQuestionInput } from "./schema.js";
import { validatePlanningPacket } from "./schema.js";

function question(
	id: string,
	overrides: Partial<PlanningQuestionInput> = {},
): PlanningQuestionInput {
	return {
		id,
		label: id,
		prompt: `Choose ${id}`,
		type: "single",
		options: [
			{ value: "safe", label: "Safe" },
			{ value: "fast", label: "Fast" },
		],
		recommendedValue: "safe",
		recommendation: "Safe limits blast radius.",
		...overrides,
	};
}

function answer(value = "safe"): PlanningAnswer {
	return { values: [value], labels: [value], indices: [1] };
}

describe("native Deep Plan frontier", () => {
	it("keeps independent questions in one bounded round", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		const opened = openPlanningRound(state, [
			question("rollout"),
			question("telemetry"),
		]);
		assert.equal(opened.currentQuestions.length, 2);
		assert.equal(opened.round, 0);
	});

	it("rejects questions whose prerequisites are not answered", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		assert.throws(
			() =>
				openPlanningRound(state, [
					question("implementation", { dependsOn: ["architecture"] }),
				]),
			/depends on unanswered question architecture/,
		);
	});

	it("rejects duplicate stable question IDs in a round", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		assert.throws(
			() => openPlanningRound(state, [question("rollout"), question("rollout")]),
			/must be unique within the round/,
		);
	});

	it("does not discard an unanswered frontier during elaboration", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		const opened = openPlanningRound(state, [question("rollout")]);
		assert.throws(
			() => openPlanningRound(opened, [question("architecture")]),
			/preserve its stable question IDs/,
		);
	});

	it("preserves custom answers and notes across a submitted round", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		const opened = openPlanningRound(state, [question("rollout")]);
		const next = acceptPlanningRound(
			opened,
			{
				rollout: {
					values: ["regional"],
					labels: ["Regional"],
					indices: [],
					customText: "regional",
					note: "Start with one customer segment.",
				},
			},
			"submit",
		);
		assert.equal(next.round, 1);
		assert.equal(next.currentQuestions.length, 0);
		assert.equal(next.answers.rollout?.customText, "regional");
		assert.equal(next.decisions[0]?.note, "Start with one customer segment.");
		assert.equal(canFinishPlanning(next), true);
	});

	it("rejects answer values that were neither offered nor entered as custom text", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		const opened = openPlanningRound(state, [question("rollout")]);
		assert.throws(
			() =>
				acceptPlanningRound(
					opened,
					{
						rollout: {
							values: ["hidden-choice"],
							labels: ["Hidden choice"],
							indices: [],
						},
					},
					"submit",
				),
			/unknown option value hidden-choice/,
		);
	});

	it("keeps the round open when the user requests elaboration", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		const opened = openPlanningRound(state, [question("rollout")]);
		const next = acceptPlanningRound(
			opened,
			{ rollout: answer() },
			"elaborate",
		);
		assert.equal(next.round, 0);
		assert.equal(next.currentQuestions[0]?.id, "rollout");
		assert.equal(canFinishPlanning(next), false);
	});

	it("enforces the six-question round budget", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		const questions = Array.from(
			{ length: MAX_PLANNING_QUESTIONS_PER_ROUND + 1 },
			(_, index) => question(`q${index}`),
		);
		assert.throws(
			() => openPlanningRound(state, questions),
			/at most six questions/,
		);
	});

	it("validates packet dependencies before confirmation", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		const opened = openPlanningRound(state, [question("rollout")]);
		const ready = acceptPlanningRound(opened, { rollout: answer() }, "submit");
		const packet = buildPlanningPacket(ready, {
			assumptions: [],
			evidence: [],
			vocabulary: [],
			outOfScope: [],
			openQuestions: [],
			nodes: [
				{
					id: "implementation",
					title: "Implement rollout",
					outcome: "The rollout is implemented.",
					dependsOn: [],
					acceptanceCriteria: ["The rollout is covered by tests."],
					affectedFiles: ["src/rollout.ts"],
					claims: ["src/rollout.ts"],
					verificationPlan: ["npm test"],
					priority: 1,
					riskClass: "routine",
					evidenceIds: [],
				},
			],
		});
		assert.equal(packet.status, "ready");
		const confirmed = confirmPlanningPacket(ready, packet);
		assert.equal(confirmed.state.status, "confirmed");
		assert.equal(confirmed.packet.status, "confirmed");
	});

	it("requires a ready packet and a ready session for confirmation", () => {
		const state = createPlanningSession({ objective: "Design a rollout" });
		const opened = openPlanningRound(state, [question("rollout")]);
		assert.throws(
			() =>
				confirmPlanningPacket(opened, {
					schema: "forgedock.planning/v1",
					sessionId: opened.id,
					revision: 1,
					status: "confirmed",
					objective: opened.objective,
					assumptions: [],
					evidence: [],
					vocabulary: [],
					decisions: [],
					outOfScope: [],
					openQuestions: [],
					nodes: [
						{
							id: "implementation",
							title: "Implement rollout",
							outcome: "The rollout is implemented.",
							dependsOn: [],
							acceptanceCriteria: ["The rollout works."],
							affectedFiles: [],
							claims: [],
							verificationPlan: ["npm test"],
							priority: 1,
							riskClass: "routine",
							evidenceIds: [],
						},
					],
				}),
			/not ready for confirmation/,
		);
	});

	it("rejects unresolved evidence references and duplicate open questions", () => {
		const issues = validatePlanningPacket({
			schema: "forgedock.planning/v1",
			sessionId: "plan-1",
			revision: 1,
			status: "ready",
			objective: "Design a rollout",
			assumptions: [],
			evidence: [],
			vocabulary: [
				{
					id: "term-1",
					term: "rollout",
					definition: "A staged release.",
					aliases: [],
					evidenceIds: ["missing"],
					status: "accepted",
				},
			],
			decisions: [],
			outOfScope: [],
			openQuestions: ["Which region?", "Which region?"],
			nodes: [
				{
					id: "implementation",
					title: "Implement rollout",
					outcome: "The rollout is implemented.",
					dependsOn: [],
					acceptanceCriteria: ["The rollout works."],
					affectedFiles: [],
					claims: [],
					verificationPlan: ["npm test"],
					priority: 1,
					riskClass: "routine",
					evidenceIds: ["missing"],
				},
			],
		});
		assert.ok(issues.some((issue) => /unknown planning evidence missing/.test(issue.message)));
		assert.ok(issues.some((issue) => /duplicate values/.test(issue.message)));
	});

	it("stores and clears supervisor-owned sessions", () => {
		const store = new PlanningSessionStore();
		const state = store.start({
			title: "Rollout",
			objective: "Design a rollout",
		});
		store.openRound(state.id, [question("rollout")]);
		store.acceptRound(state.id, { rollout: answer() }, "submit");
		assert.equal(store.get(state.id).round, 1);
		store.clear();
		assert.throws(() => store.get(state.id), /Unknown Deep Plan session/);
	});
});
