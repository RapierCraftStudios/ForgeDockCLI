// SPDX-License-Identifier: AGPL-3.0-or-later

import { Check } from "typebox/value";
import {
	assertPlanningPacket,
	normalizePlanningQuestion,
	PlanningAnswerSchema,
	validatePlanningQuestionRound,
	type PlanningAnswer,
	type PlanningDecision,
	type PlanningPacket,
	type PlanningPacketDraft,
	type PlanningQuestion,
	type PlanningQuestionInput,
} from "./schema.js";

export const MAX_PLANNING_QUESTIONS_PER_ROUND = 6;
export const MAX_PLANNING_ROUNDS = 6;

export type PlanningSessionStatus =
	| "questioning"
	| "ready"
	| "confirmed"
	| "cancelled"
	| "blocked";

export interface PlanningSessionState {
	id: string;
	title?: string;
	objective: string;
	round: number;
	status: PlanningSessionStatus;
	answers: Record<string, PlanningAnswer>;
	decisions: PlanningDecision[];
	currentQuestions: PlanningQuestion[];
}

export function createPlanningSession(input: {
	id?: string;
	title?: string;
	objective: string;
}): PlanningSessionState {
	const objective = input.objective.trim();
	if (!objective) throw new Error("Deep Plan objective must not be empty");
	return {
		id: input.id ?? `plan_${crypto.randomUUID()}`,
		...(input.title?.trim() ? { title: input.title.trim() } : {}),
		objective,
		round: 0,
		status: "questioning",
		answers: {},
		decisions: [],
		currentQuestions: [],
	};
}

export function openPlanningRound(
	state: PlanningSessionState,
	inputs: readonly PlanningQuestionInput[],
): PlanningSessionState {
	if (state.status !== "questioning") {
		throw new Error(`Deep Plan session ${state.id} is ${state.status}`);
	}
	if (state.round >= MAX_PLANNING_ROUNDS) {
		throw new Error(
			`Deep Plan session ${state.id} reached the ${MAX_PLANNING_ROUNDS}-round budget`,
		);
	}
	const questions = inputs.map(normalizePlanningQuestion);
	if (state.currentQuestions.length) {
		const currentIds = new Set(
			state.currentQuestions.map((question) => question.id),
		);
		const replacementIds = new Set(questions.map((question) => question.id));
		if (
			currentIds.size !== replacementIds.size ||
			[...currentIds].some((id) => !replacementIds.has(id))
		) {
			throw new Error(
				"Deep Plan cannot replace an unanswered frontier; preserve its stable question IDs",
			);
		}
	}
	const issues = validatePlanningQuestionRound(
		questions,
		new Set(
			Object.keys(state.answers).filter(
				(id) => !state.currentQuestions.some((question) => question.id === id),
			),
		),
	);
	if (issues.length) {
		throw new Error(
			`Invalid Deep Plan question round: ${issues
				.slice(0, 5)
				.map((issue) => `${issue.path}: ${issue.message}`)
				.join("; ")}`,
		);
	}
	return { ...state, currentQuestions: questions };
}

export function acceptPlanningRound(
	state: PlanningSessionState,
	answers: Readonly<Record<string, PlanningAnswer>>,
	mode: "submit" | "elaborate",
): PlanningSessionState {
	if (!state.currentQuestions.length) {
		throw new Error("Deep Plan has no open question round");
	}
	const questionIds = new Set(
		state.currentQuestions.map((question) => question.id),
	);
	const unexpected = Object.keys(answers).filter((id) => !questionIds.has(id));
	if (unexpected.length) {
		throw new Error(
			`Deep Plan received answers for unknown questions: ${unexpected.join(", ")}`,
		);
	}
	const missing = state.currentQuestions.filter(
		(question) => {
			const answer = answers[question.id] as PlanningAnswer | undefined;
			return !answer || !Array.isArray(answer.values) || !answer.values.length;
		},
	);
	if (missing.length) {
		throw new Error(
			`Deep Plan requires an answer for: ${missing
				.map((question) => question.id)
				.join(", ")}`,
		);
	}
	const nextAnswers = { ...state.answers };
	// Elaboration keeps the current frontier open. Re-answering that frontier
	// replaces its provisional resolution instead of creating duplicate stable
	// question IDs in the eventual packet.
	const nextDecisions = state.decisions.filter(
		(decision) => !questionIds.has(decision.questionId),
	);
	for (const question of state.currentQuestions) {
		const answer = answers[question.id]!;
		assertPlanningAnswer(question, answer);
		nextAnswers[question.id] = cloneAnswer(answer);
		nextDecisions.push({
			round: state.round + 1,
			questionId: question.id,
			values: [...answer.values],
			labels: [...answer.labels],
			...(answer.customText !== undefined
				? { customText: answer.customText }
				: {}),
			...(answer.note !== undefined ? { note: answer.note } : {}),
			...(answer.optionNotes !== undefined
				? { optionNotes: { ...answer.optionNotes } }
				: {}),
			authority: "user",
		});
	}
	return {
		...state,
		answers: nextAnswers,
		decisions: nextDecisions,
		round: mode === "submit" ? state.round + 1 : state.round,
		currentQuestions: mode === "submit" ? [] : state.currentQuestions,
	};
}

export function cancelPlanningSession(
	state: PlanningSessionState,
): PlanningSessionState {
	return { ...state, status: "cancelled", currentQuestions: [] };
}

export function canFinishPlanning(state: PlanningSessionState): boolean {
	return (
		state.status === "questioning" &&
		state.round > 0 &&
		state.currentQuestions.length === 0
	);
}

export function buildPlanningPacket(
	state: PlanningSessionState,
	draft: PlanningPacketDraft,
): PlanningPacket {
	if (!canFinishPlanning(state)) {
		throw new Error(
			"Deep Plan must complete its current question round before it can be confirmed",
		);
	}
	const packet: PlanningPacket = {
		schema: "forgedock.planning/v1",
		sessionId: state.id,
		revision: 1,
		status: "ready",
		objective: state.objective,
		assumptions: [...draft.assumptions],
		evidence: [...draft.evidence],
		vocabulary: [...draft.vocabulary],
		decisions: state.decisions.map((decision) => ({
			...decision,
			values: [...decision.values],
			labels: [...decision.labels],
			...(decision.optionNotes !== undefined
				? { optionNotes: { ...decision.optionNotes } }
				: {}),
		})),
		outOfScope: [...draft.outOfScope],
		openQuestions: [...draft.openQuestions],
		nodes: draft.nodes.map((node) => ({
			...node,
			dependsOn: [...node.dependsOn],
			acceptanceCriteria: [...node.acceptanceCriteria],
			affectedFiles: [...node.affectedFiles],
			claims: [...node.claims],
			verificationPlan: [...node.verificationPlan],
			evidenceIds: [...node.evidenceIds],
		})),
	};
	assertPlanningPacket(packet);
	return packet;
}

export function confirmPlanningPacket(
	state: PlanningSessionState,
	packet: PlanningPacket,
): { state: PlanningSessionState; packet: PlanningPacket } {
	if (!canFinishPlanning(state)) {
		throw new Error(
			`Deep Plan session ${state.id} is not ready for confirmation`,
		);
	}
	if (packet.sessionId !== state.id) {
		throw new Error("Planning packet belongs to a different Deep Plan session");
	}
	if (packet.status !== "ready") {
		throw new Error(
			`Planning packet must be ready before confirmation; received ${packet.status}`,
		);
	}
	if (packet.objective !== state.objective) {
		throw new Error("Planning packet objective differs from the Deep Plan session");
	}
	if (!sameDecisions(packet.decisions, state.decisions)) {
		throw new Error(
			"Planning packet decisions differ from the user-authorized session decisions",
		);
	}
	const confirmed: PlanningPacket = { ...packet, status: "confirmed" };
	assertPlanningPacket(confirmed);
	return {
		state: { ...state, status: "confirmed" },
		packet: confirmed,
	};
}

export class PlanningSessionStore {
	private readonly sessions = new Map<string, PlanningSessionState>();

	start(input: { title?: string; objective: string }): PlanningSessionState {
		const state = createPlanningSession(input);
		this.sessions.set(state.id, state);
		return state;
	}

	get(id: string): PlanningSessionState {
		const state = this.sessions.get(id);
		if (!state) throw new Error(`Unknown Deep Plan session ${id}`);
		return state;
	}

	openRound(
		id: string,
		questions: readonly PlanningQuestionInput[],
	): PlanningSessionState {
		const next = openPlanningRound(this.get(id), questions);
		this.sessions.set(id, next);
		return next;
	}

	acceptRound(
		id: string,
		answers: Readonly<Record<string, PlanningAnswer>>,
		mode: "submit" | "elaborate",
	): PlanningSessionState {
		const next = acceptPlanningRound(this.get(id), answers, mode);
		this.sessions.set(id, next);
		return next;
	}

	cancel(id: string): PlanningSessionState {
		const next = cancelPlanningSession(this.get(id));
		this.sessions.set(id, next);
		return next;
	}

	confirm(
		id: string,
		packet: PlanningPacket,
	): {
		state: PlanningSessionState;
		packet: PlanningPacket;
	} {
		const confirmed = confirmPlanningPacket(this.get(id), packet);
		this.sessions.set(id, confirmed.state);
		return confirmed;
	}

	clear(): void {
		this.sessions.clear();
	}
}

function cloneAnswer(answer: PlanningAnswer): PlanningAnswer {
	return {
		values: [...answer.values],
		labels: [...answer.labels],
		indices: [...answer.indices],
		...(answer.customText !== undefined
			? { customText: answer.customText }
			: {}),
		...(answer.note !== undefined ? { note: answer.note } : {}),
		...(answer.optionNotes !== undefined
			? { optionNotes: { ...answer.optionNotes } }
			: {}),
	};
}

export function assertPlanningAnswer(
	question: PlanningQuestion,
	answer: PlanningAnswer,
): void {
	const issues: string[] = [];
	if (!Check(PlanningAnswerSchema, answer)) {
		throw new Error(
			`Invalid Deep Plan answer for ${question.id}: does not match the planning answer schema`,
		);
	}
	const optionByValue = new Map(
		question.options.map((option, index) => [option.value, index + 1] as const),
	);
	const customText = answer.customText?.trim();
	const allowed = new Set(optionByValue.keys());
	if (customText) allowed.add(customText);
	if (answer.customText !== undefined && !customText) {
		issues.push("customText must not be blank when supplied");
	}
	if (new Set(answer.values).size !== answer.values.length) {
		issues.push("values must not contain duplicates");
	}
	for (const value of answer.values) {
		if (!allowed.has(value)) issues.push(`unknown option value ${value}`);
	}
	if (customText && !answer.values.includes(customText)) {
		issues.push("customText must be included in values");
	}
	if (question.type !== "multi" && answer.values.length !== 1) {
		issues.push(`${question.type} questions require exactly one value`);
	}
	if (answer.labels.length !== answer.values.length) {
		issues.push("labels must correspond one-to-one with values");
	}
	const indexedValues = answer.indices.flatMap((index) => {
		const option = question.options[index - 1];
		if (!option) {
			issues.push(`option index ${index} is out of range`);
			return [];
		}
		return [option.value];
	});
	const selectedOptionValues = answer.values.filter((value) =>
		optionByValue.has(value),
	);
	if (
		new Set(answer.indices).size !== answer.indices.length ||
		[...indexedValues].sort().join("\u0000") !==
			[...selectedOptionValues].sort().join("\u0000")
	) {
		issues.push("indices must identify exactly the selected supplied options");
	}
	for (const value of Object.keys(answer.optionNotes ?? {})) {
		if (!optionByValue.has(value)) {
			issues.push(`optionNotes contains unknown option value ${value}`);
		}
	}
	if (issues.length) {
		throw new Error(
			`Invalid Deep Plan answer for ${question.id}: ${issues.join("; ")}`,
		);
	}
}

function sameDecisions(
	left: readonly PlanningDecision[],
	right: readonly PlanningDecision[],
): boolean {
	const canonical = (decision: PlanningDecision) => ({
		round: decision.round,
		questionId: decision.questionId,
		values: [...decision.values],
		labels: [...decision.labels],
		customText: decision.customText ?? null,
		note: decision.note ?? null,
		optionNotes: Object.entries(decision.optionNotes ?? {}).sort(
			([leftKey], [rightKey]) => leftKey.localeCompare(rightKey),
		),
		authority: decision.authority,
	});
	return JSON.stringify(left.map(canonical)) === JSON.stringify(right.map(canonical));
}
