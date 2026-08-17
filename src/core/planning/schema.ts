// SPDX-License-Identifier: AGPL-3.0-or-later

import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

const NonEmptyString = Type.String({ minLength: 1 });

export const PlanningOptionSchema = Type.Object({
	value: NonEmptyString,
	label: NonEmptyString,
	description: Type.Optional(Type.String()),
	preview: Type.Optional(Type.String()),
});

export const PlanningQuestionSchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	prompt: NonEmptyString,
	type: Type.Union([
		Type.Literal("single"),
		Type.Literal("multi"),
		Type.Literal("preview"),
	]),
	options: Type.Array(PlanningOptionSchema, { minItems: 2, maxItems: 8 }),
	recommendedValue: NonEmptyString,
	recommendation: NonEmptyString,
	/** IDs of decisions that must already be answered before this question is shown. */
	dependsOn: Type.Optional(Type.Array(NonEmptyString, { maxItems: 8 })),
});

export const PlanningAnswerSchema = Type.Object({
	values: Type.Array(Type.String()),
	labels: Type.Array(Type.String()),
	indices: Type.Array(Type.Integer({ minimum: 1 })),
	customText: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	optionNotes: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const PlanningEvidenceSchema = Type.Object({
	id: NonEmptyString,
	authority: Type.Union([
		Type.Literal("user"),
		Type.Literal("github"),
		Type.Literal("repository"),
		Type.Literal("forge-guidance"),
		Type.Literal("devdocs"),
		Type.Literal("prototype"),
	]),
	source: NonEmptyString,
	locator: NonEmptyString,
	claim: NonEmptyString,
	detail: NonEmptyString,
});

export const PlanningTermSchema = Type.Object({
	id: NonEmptyString,
	term: NonEmptyString,
	definition: NonEmptyString,
	aliases: Type.Array(Type.String()),
	evidenceIds: Type.Array(NonEmptyString),
	status: Type.Union([
		Type.Literal("proposed"),
		Type.Literal("accepted"),
		Type.Literal("rejected"),
	]),
});

export const PlanningDecisionSchema = Type.Object({
	round: Type.Integer({ minimum: 1 }),
	questionId: NonEmptyString,
	values: Type.Array(Type.String()),
	labels: Type.Array(Type.String()),
	customText: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
	optionNotes: Type.Optional(Type.Record(Type.String(), Type.String())),
	authority: Type.Literal("user"),
});

export const PlanningNodeSchema = Type.Object({
	id: NonEmptyString,
	title: NonEmptyString,
	outcome: NonEmptyString,
	dependsOn: Type.Array(NonEmptyString),
	acceptanceCriteria: Type.Array(NonEmptyString, { minItems: 1 }),
	affectedFiles: Type.Array(Type.String()),
	claims: Type.Array(NonEmptyString),
	verificationPlan: Type.Array(NonEmptyString, { minItems: 1 }),
	priority: Type.Integer({ minimum: 0 }),
	riskClass: Type.Union([
		Type.Literal("routine"),
		Type.Literal("security"),
		Type.Literal("auth"),
		Type.Literal("billing"),
	]),
	evidenceIds: Type.Array(NonEmptyString),
});

export const PlanningPacketDraftSchema = Type.Object({
	assumptions: Type.Array(Type.String()),
	evidence: Type.Array(PlanningEvidenceSchema),
	vocabulary: Type.Array(PlanningTermSchema),
	outOfScope: Type.Array(Type.String()),
	openQuestions: Type.Array(NonEmptyString),
	nodes: Type.Array(PlanningNodeSchema, { minItems: 1 }),
});

export const PlanningPacketSchema = Type.Object({
	schema: Type.Literal("forgedock.planning/v1"),
	sessionId: NonEmptyString,
	revision: Type.Integer({ minimum: 1 }),
	status: Type.Union([
		Type.Literal("ready"),
		Type.Literal("confirmed"),
		Type.Literal("handed-off"),
		Type.Literal("blocked"),
	]),
	objective: NonEmptyString,
	assumptions: Type.Array(Type.String()),
	evidence: Type.Array(PlanningEvidenceSchema),
	vocabulary: Type.Array(PlanningTermSchema),
	decisions: Type.Array(PlanningDecisionSchema),
	outOfScope: Type.Array(Type.String()),
	openQuestions: Type.Array(NonEmptyString),
	nodes: Type.Array(PlanningNodeSchema, { minItems: 1 }),
});

export type PlanningQuestionInput = Static<typeof PlanningQuestionSchema>;
export type PlanningQuestion = Omit<PlanningQuestionInput, "dependsOn"> & {
	dependsOn: string[];
};
export type PlanningAnswer = Static<typeof PlanningAnswerSchema>;
export type PlanningEvidence = Static<typeof PlanningEvidenceSchema>;
export type PlanningTerm = Static<typeof PlanningTermSchema>;
export type PlanningDecision = Static<typeof PlanningDecisionSchema>;
export type PlanningNode = Static<typeof PlanningNodeSchema>;
export type PlanningPacketDraft = Static<typeof PlanningPacketDraftSchema>;
export type PlanningPacket = Static<typeof PlanningPacketSchema>;

export interface PlanningValidationIssue {
	path: string;
	message: string;
}

export function normalizePlanningQuestion(
	question: PlanningQuestionInput,
): PlanningQuestion {
	return {
		id: question.id.trim(),
		label: question.label.trim(),
		prompt: question.prompt.trim(),
		type: question.type,
		options: question.options.map((option) => ({
			value: option.value.trim(),
			label: option.label.trim(),
			...(option.description?.trim()
				? { description: option.description.trim() }
				: {}),
			...(option.preview?.trim() ? { preview: option.preview.trim() } : {}),
		})),
		recommendedValue: question.recommendedValue.trim(),
		recommendation: question.recommendation.trim(),
		dependsOn: [...(question.dependsOn ?? [])].map((value) => value.trim()),
	};
}

export function validatePlanningQuestionRound(
	questions: readonly PlanningQuestion[],
	answeredQuestionIds: ReadonlySet<string>,
): PlanningValidationIssue[] {
	const issues: PlanningValidationIssue[] = [];
	if (questions.length < 1) {
		issues.push({
			path: "questions",
			message: "at least one question is required",
		});
	}
	if (questions.length > 6) {
		issues.push({
			path: "questions",
			message: "a round may contain at most six questions",
		});
	}
	const ids = new Set<string>();
	questions.forEach((question, questionIndex) => {
		const path = `questions[${questionIndex}]`;
		if (!Check(PlanningQuestionSchema, question)) {
			issues.push({
				path,
				message: "does not match the planning question schema",
			});
		}
		if (!question.id)
			issues.push({ path: `${path}.id`, message: "must not be blank" });
		if (ids.has(question.id)) {
			issues.push({
				path: `${path}.id`,
				message: "must be unique within the round",
			});
		}
		if (answeredQuestionIds.has(question.id)) {
			issues.push({
				path: `${path}.id`,
				message: "must not reuse an answered question ID",
			});
		}
		ids.add(question.id);
		const optionValues = new Set<string>();
		question.options.forEach((option, optionIndex) => {
			if (optionValues.has(option.value)) {
				issues.push({
					path: `${path}.options[${optionIndex}].value`,
					message: "must be unique within the question",
				});
			}
			optionValues.add(option.value);
		});
		if (!optionValues.has(question.recommendedValue)) {
			issues.push({
				path: `${path}.recommendedValue`,
				message: "must identify one of the supplied options",
			});
		}
		const dependencies = new Set<string>();
		for (const dependency of question.dependsOn) {
			if (dependencies.has(dependency)) {
				issues.push({
					path: `${path}.dependsOn`,
					message: "must not contain duplicate dependencies",
				});
			}
			dependencies.add(dependency);
			if (dependency === question.id) {
				issues.push({
					path: `${path}.dependsOn`,
					message: "must not depend on itself",
				});
			} else if (!answeredQuestionIds.has(dependency)) {
				issues.push({
					path: `${path}.dependsOn`,
					message: `depends on unanswered question ${dependency}`,
				});
			}
		}
		if (question.type === "preview") {
			question.options.forEach((option, optionIndex) => {
				if (!option.preview?.trim()) {
					issues.push({
						path: `${path}.options[${optionIndex}].preview`,
						message: "preview questions require preview text for every option",
					});
				}
			});
		}
	});
	return issues;
}

export function validatePlanningPacket(
	packet: unknown,
): PlanningValidationIssue[] {
	if (!Check(PlanningPacketSchema, packet)) {
		return [...Errors(PlanningPacketSchema, packet)]
			.slice(0, 8)
			.map((error) => ({
				path: (error as { path?: string }).path || "packet",
				message: error.message,
			}));
	}
	const planningPacket = packet as PlanningPacket;
	const issues = validatePlanningNodes(planningPacket.nodes);
	validateUniqueIds(
		planningPacket.evidence.map((evidence) => evidence.id),
		"evidence",
		issues,
	);
	validateUniqueIds(
		planningPacket.vocabulary.map((term) => term.id),
		"vocabulary",
		issues,
	);
	validateUniqueIds(
		planningPacket.decisions.map((decision) => decision.questionId),
		"decisions",
		issues,
	);
	validateUniqueValues(planningPacket.openQuestions, "openQuestions", issues);

	const evidenceIds = new Set(
		planningPacket.evidence.map((evidence) => evidence.id),
	);
	for (const [index, term] of planningPacket.vocabulary.entries()) {
		validateEvidenceReferences(
			term.evidenceIds,
			`vocabulary[${index}].evidenceIds`,
			evidenceIds,
			issues,
		);
	}
	for (const [index, node] of planningPacket.nodes.entries()) {
		validateEvidenceReferences(
			node.evidenceIds,
			`nodes[${index}].evidenceIds`,
			evidenceIds,
			issues,
		);
	}
	return issues;
}

export function validatePlanningNodes(
	nodes: readonly PlanningNode[],
): PlanningValidationIssue[] {
	const issues: PlanningValidationIssue[] = [];
	const nodeIds = new Set<string>();
	for (const [index, node] of nodes.entries()) {
		const normalized = node.id.trim();
		if (!normalized) {
			issues.push({ path: `nodes[${index}].id`, message: "must not be blank" });
		} else if (normalized !== node.id) {
			issues.push({
				path: `nodes[${index}].id`,
				message: "must not contain surrounding whitespace",
			});
		}
		if (nodeIds.has(normalized)) {
			issues.push({ path: `nodes[${index}].id`, message: "must be unique" });
		}
		nodeIds.add(normalized);
	}
	for (const [index, node] of nodes.entries()) {
		const dependencies = new Set<string>();
		for (const dependency of node.dependsOn) {
			const normalized = dependency.trim();
			if (!normalized || normalized !== dependency) {
				issues.push({
					path: `nodes[${index}].dependsOn`,
					message: "dependency IDs must be non-blank without surrounding whitespace",
				});
			}
			if (dependencies.has(normalized)) {
				issues.push({
					path: `nodes[${index}].dependsOn`,
					message: `must not contain duplicate dependency ${normalized}`,
				});
			}
			dependencies.add(normalized);
			if (!nodeIds.has(normalized)) {
				issues.push({
					path: `nodes[${index}].dependsOn`,
					message: `unknown planning node ${normalized || "<blank>"}`,
				});
			}
			if (normalized === node.id.trim()) {
				issues.push({
					path: `nodes[${index}].dependsOn`,
					message: "must not depend on itself",
				});
			}
		}
	}
	const hasInvalidDependency = nodes.some((node) =>
		node.dependsOn.some(
			(dependency) => dependency === node.id || !nodeIds.has(dependency),
		),
	);
	if (!hasInvalidDependency && hasPlanningNodeCycle(nodes)) {
		issues.push({ path: "nodes", message: "planning node dependency cycle" });
	}
	return issues;
}

function validateUniqueIds(
	values: readonly string[],
	path: string,
	issues: PlanningValidationIssue[],
): void {
	const seen = new Set<string>();
	for (const [index, value] of values.entries()) {
		const normalized = value.trim();
		if (!normalized) {
			issues.push({ path: `${path}[${index}]`, message: "ID must not be blank" });
		} else if (normalized !== value) {
			issues.push({
				path: `${path}[${index}]`,
				message: "ID must not contain surrounding whitespace",
			});
		}
		if (seen.has(normalized)) {
			issues.push({
				path: `${path}[${index}]`,
				message: `duplicate ID ${normalized}`,
			});
		}
		seen.add(normalized);
	}
}

function validateUniqueValues(
	values: readonly string[],
	path: string,
	issues: PlanningValidationIssue[],
): void {
	const seen = new Set<string>();
	for (const [index, value] of values.entries()) {
		const normalized = value.trim();
		if (!normalized) {
			issues.push({ path: `${path}[${index}]`, message: "must not be blank" });
		} else if (seen.has(normalized)) {
			issues.push({
				path: `${path}[${index}]`,
				message: "must not contain duplicate values",
			});
		}
		seen.add(normalized);
	}
}

function validateEvidenceReferences(
	references: readonly string[],
	path: string,
	evidenceIds: ReadonlySet<string>,
	issues: PlanningValidationIssue[],
): void {
	const seen = new Set<string>();
	for (const reference of references) {
		if (seen.has(reference)) {
			issues.push({
				path,
				message: `must not contain duplicate evidence reference ${reference}`,
			});
		}
		seen.add(reference);
		if (!evidenceIds.has(reference)) {
			issues.push({ path, message: `unknown planning evidence ${reference}` });
		}
	}
}

function hasPlanningNodeCycle(nodes: readonly PlanningNode[]): boolean {
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const visit = (id: string): boolean => {
		if (visited.has(id)) return false;
		if (visiting.has(id)) return true;
		visiting.add(id);
		const cycle = (byId.get(id)?.dependsOn ?? []).some(visit);
		visiting.delete(id);
		visited.add(id);
		return cycle;
	};
	return nodes.some((node) => visit(node.id));
}

export function assertPlanningPacket(
	packet: unknown,
): asserts packet is PlanningPacket {
	const issues = validatePlanningPacket(packet);
	if (issues.length) {
		throw new Error(
			`Invalid planning packet: ${issues
				.slice(0, 5)
				.map((issue) => `${issue.path}: ${issue.message}`)
				.join("; ")}`,
		);
	}
}
