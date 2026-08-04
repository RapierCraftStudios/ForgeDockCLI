// SPDX-License-Identifier: AGPL-3.0-or-later
// Interaction design inspired by @eko24ive/pi-ask (MIT); implemented locally for ForgeDock.

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Focusable, type TUI } from "@earendil-works/pi-tui";

export type DecisionQuestionType = "single" | "multi" | "preview";

export interface DecisionOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
}

export interface DecisionQuestion {
  id: string;
  label: string;
  prompt: string;
  type: DecisionQuestionType;
  options: DecisionOption[];
  recommendedValue: string;
  recommendation: string;
}

export interface DecisionFlowInput {
  title?: string;
  questions: DecisionQuestion[];
}

export interface DecisionAnswer {
  values: string[];
  labels: string[];
  indices: number[];
  customText?: string;
  note?: string;
  optionNotes?: Record<string, string>;
}

export interface DecisionFlowResult {
  title?: string;
  cancelled: boolean;
  mode: "submit" | "elaborate";
  questions: Array<Pick<DecisionQuestion, "id" | "label" | "prompt" | "type" | "recommendedValue" | "recommendation">>;
  answers: Record<string, DecisionAnswer>;
  elaboration?: {
    instruction: string;
    items: Array<{ questionId: string; optionValue?: string; note?: string; currentAnswer?: string }>;
  };
}

type EditorTarget =
  | { kind: "custom"; questionId: string }
  | { kind: "question-note"; questionId: string }
  | { kind: "option-note"; questionId: string; optionValue: string };

interface DecisionState {
  tab: number;
  cursor: Map<string, number>;
  selected: Map<string, Set<string>>;
  custom: Map<string, string>;
  questionNotes: Map<string, string>;
  optionNotes: Map<string, Map<string, string>>;
  reviewAction: number;
  editorTarget?: EditorTarget;
  dismissArmed: boolean;
}

export interface DecisionValidationIssue {
  path: string;
  message: string;
}

export function validateDecisionFlow(input: DecisionFlowInput): DecisionValidationIssue[] {
  const issues: DecisionValidationIssue[] = [];
  if (!input.questions.length) issues.push({ path: "questions", message: "at least one question is required" });
  const questionIds = new Set<string>();
  input.questions.forEach((question, questionIndex) => {
    const path = `questions[${questionIndex}]`;
    if (!question.id.trim()) issues.push({ path: `${path}.id`, message: "must not be blank" });
    else if (questionIds.has(question.id)) issues.push({ path: `${path}.id`, message: "must be unique" });
    questionIds.add(question.id);
    if (!question.prompt.trim()) issues.push({ path: `${path}.prompt`, message: "must not be blank" });
    if (!question.recommendation.trim()) issues.push({ path: `${path}.recommendation`, message: "must explain the recommendation" });
    if (question.options.length < 2) issues.push({ path: `${path}.options`, message: "at least two options are required" });
    const values = new Set<string>();
    question.options.forEach((option, optionIndex) => {
      const optionPath = `${path}.options[${optionIndex}]`;
      if (!option.value.trim()) issues.push({ path: `${optionPath}.value`, message: "must not be blank" });
      else if (values.has(option.value)) issues.push({ path: `${optionPath}.value`, message: "must be unique within the question" });
      values.add(option.value);
      if (!option.label.trim()) issues.push({ path: `${optionPath}.label`, message: "must not be blank" });
      if (question.type === "preview" && !option.preview?.trim()) {
        issues.push({ path: `${optionPath}.preview`, message: "preview questions require preview text for every option" });
      }
    });
    if (!values.has(question.recommendedValue)) {
      issues.push({ path: `${path}.recommendedValue`, message: "must identify one of the supplied options" });
    }
  });
  return issues;
}

export async function runDecisionFlow(ctx: ExtensionContext, input: DecisionFlowInput): Promise<DecisionFlowResult> {
  if (ctx.mode !== "tui") return emptyResult(input, true);
  ctx.ui.setWorkingVisible(false);
  try {
    return await ctx.ui.custom<DecisionFlowResult>((tui, theme, _keybindings, done) =>
      createDecisionFlowComponent(tui, theme, input, done));
  } finally {
    ctx.ui.setWorkingVisible(true);
  }
}

export function createDecisionFlowComponent(
  tui: Pick<TUI, "requestRender">,
  theme: Theme,
  input: DecisionFlowInput,
  done: (result: DecisionFlowResult) => void,
): Focusable & { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
  const state: DecisionState = {
    tab: 0,
    cursor: new Map(input.questions.map((question) => [question.id, 0])),
    selected: new Map(input.questions.map((question) => [question.id, new Set<string>()])),
    custom: new Map(),
    questionNotes: new Map(),
    optionNotes: new Map(),
    reviewAction: 0,
    dismissArmed: false,
  };
  const editor = new Editor(tui as TUI, {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  });
  let focused = false;
  let cache: { width: number; lines: string[] } | undefined;

  const refresh = () => { cache = undefined; tui.requestRender(); };
  const currentQuestion = () => input.questions[state.tab];
  const isReview = () => state.tab === input.questions.length;
  const hasDirtyState = () => state.selected.size > 0 && (
    [...state.selected.values()].some((values) => values.size > 0)
    || state.custom.size > 0 || state.questionNotes.size > 0 || state.optionNotes.size > 0);
  const moveTab = (delta: number) => {
    state.tab = (state.tab + delta + input.questions.length + 1) % (input.questions.length + 1);
    state.dismissArmed = false;
    delete state.editorTarget;
    editor.setText("");
    refresh();
  };
  const advance = () => {
    state.tab = Math.min(input.questions.length, state.tab + 1);
    state.dismissArmed = false;
    refresh();
  };
  const cancel = () => {
    if (hasDirtyState() && !state.dismissArmed) {
      state.dismissArmed = true;
      refresh();
      return;
    }
    done({ ...toResult(input, state, "submit"), cancelled: true });
  };
  const edit = (target: EditorTarget, initial: string) => {
    state.editorTarget = target;
    editor.setText(initial);
    state.dismissArmed = false;
    refresh();
  };
  const saveEditor = (submittedValue?: string) => {
    const target = state.editorTarget;
    if (!target) return;
    const value = (submittedValue ?? editor.getExpandedText()).trim();
    if (target.kind === "custom") {
      if (value) state.custom.set(target.questionId, value); else state.custom.delete(target.questionId);
      const question = input.questions.find((candidate) => candidate.id === target.questionId);
      if (question?.type !== "multi") state.selected.get(target.questionId)?.clear();
    } else if (target.kind === "question-note") {
      if (value) state.questionNotes.set(target.questionId, value); else state.questionNotes.delete(target.questionId);
    } else {
      const notes = state.optionNotes.get(target.questionId) ?? new Map<string, string>();
      if (value) notes.set(target.optionValue, value); else notes.delete(target.optionValue);
      if (notes.size) state.optionNotes.set(target.questionId, notes); else state.optionNotes.delete(target.questionId);
    }
    delete state.editorTarget;
    editor.setText("");
    if (target.kind === "custom" && input.questions.find((question) => question.id === target.questionId)?.type !== "multi") {
      advance();
      return;
    }
    refresh();
  };
  editor.onSubmit = (value) => saveEditor(value);

  const choose = (index: number) => {
    const question = currentQuestion();
    if (!question) return;
    if (index === question.options.length) {
      edit({ kind: "custom", questionId: question.id }, state.custom.get(question.id) ?? "");
      return;
    }
    const option = question.options[index];
    if (!option) return;
    const selected = state.selected.get(question.id)!;
    if (question.type === "multi") {
      if (selected.has(option.value)) selected.delete(option.value); else selected.add(option.value);
      refresh();
      return;
    }
    selected.clear();
    selected.add(option.value);
    state.custom.delete(question.id);
    advance();
  };
  const openNote = (questionLevel: boolean) => {
    const question = currentQuestion();
    if (!question) return;
    if (questionLevel) {
      edit({ kind: "question-note", questionId: question.id }, state.questionNotes.get(question.id) ?? "");
      return;
    }
    const index = state.cursor.get(question.id) ?? 0;
    const option = question.options[index];
    if (!option) return;
    edit({ kind: "option-note", questionId: question.id, optionValue: option.value }, state.optionNotes.get(question.id)?.get(option.value) ?? "");
  };
  const activateReview = () => {
    if (state.reviewAction === 0) done(toResult(input, state, "submit"));
    else if (state.reviewAction === 1) done(toResult(input, state, "elaborate"));
    else cancel();
  };

  const handleInput = (data: string) => {
    if (state.editorTarget) {
      if (matchesKey(data, Key.escape)) { saveEditor(); return; }
      editor.handleInput(data);
      refresh();
      return;
    }
    if (matchesKey(data, Key.ctrl("c"))) { cancel(); return; }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) { moveTab(1); return; }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) { moveTab(-1); return; }
    if (matchesKey(data, Key.escape)) { cancel(); return; }
    if (isReview()) {
      if (matchesKey(data, Key.up)) state.reviewAction = Math.max(0, state.reviewAction - 1);
      else if (matchesKey(data, Key.down)) state.reviewAction = Math.min(2, state.reviewAction + 1);
      else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) activateReview();
      else if (/^[1-3]$/.test(data)) { state.reviewAction = Number(data) - 1; activateReview(); }
      refresh();
      return;
    }
    const question = currentQuestion()!;
    const maxIndex = question.options.length;
    const cursor = state.cursor.get(question.id) ?? 0;
    if (matchesKey(data, Key.up)) state.cursor.set(question.id, Math.max(0, cursor - 1));
    else if (matchesKey(data, Key.down)) state.cursor.set(question.id, Math.min(maxIndex, cursor + 1));
    else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) choose(cursor);
    else if (matchesKey(data, Key.shift("n"))) { openNote(true); return; }
    else if (data === "n") { openNote(false); return; }
    else if (/^[1-9]$/.test(data)) {
      const index = Number(data) - 1;
      if (index <= maxIndex) { state.cursor.set(question.id, index); choose(index); return; }
    }
    state.dismissArmed = false;
    refresh();
  };

  const render = (width: number): string[] => {
    if (cache?.width === width) return cache.lines;
    const lines = renderDecisionScreen(input, state, editor, theme, Math.max(1, width));
    cache = { width, lines };
    return lines;
  };

  return {
    get focused() { return focused; },
    set focused(value: boolean) { focused = value; editor.focused = value; },
    render,
    handleInput,
    invalidate() { cache = undefined; editor.invalidate(); },
  };
}

function toResult(input: DecisionFlowInput, state: DecisionState, mode: "submit" | "elaborate"): DecisionFlowResult {
  const answers: Record<string, DecisionAnswer> = {};
  for (const question of input.questions) {
    const selected = state.selected.get(question.id) ?? new Set<string>();
    const options = question.options.filter((option) => selected.has(option.value));
    const customText = state.custom.get(question.id);
    if (!options.length && !customText && !state.questionNotes.has(question.id)) continue;
    const selectedNotes = Object.fromEntries(options.flatMap((option) => {
      const note = state.optionNotes.get(question.id)?.get(option.value);
      return note ? [[option.value, note]] : [];
    }));
    const questionNote = state.questionNotes.get(question.id);
    answers[question.id] = {
      values: [...options.map((option) => option.value), ...(customText ? [customText] : [])],
      labels: [...options.map((option) => option.label), ...(customText ? [customText] : [])],
      indices: options.map((option) => question.options.indexOf(option) + 1),
      ...(customText ? { customText } : {}),
      ...(questionNote ? { note: questionNote } : {}),
      ...(Object.keys(selectedNotes).length ? { optionNotes: selectedNotes } : {}),
    };
  }
  const result: DecisionFlowResult = {
    ...(input.title ? { title: input.title } : {}),
    cancelled: false,
    mode,
    questions: input.questions.map(({ id, label, prompt, type, recommendedValue, recommendation }) => ({ id, label, prompt, type, recommendedValue, recommendation })),
    answers,
  };
  if (mode === "elaborate") {
    const items = input.questions.flatMap((question) => {
      const currentAnswer = answers[question.id]?.labels.join(", ");
      const questionNote = state.questionNotes.get(question.id);
      const optionItems = [...(state.optionNotes.get(question.id) ?? new Map())].map(([optionValue, note]) => ({
        questionId: question.id, optionValue, note, ...(currentAnswer ? { currentAnswer } : {}),
      }));
      return [...(questionNote ? [{ questionId: question.id, note: questionNote, ...(currentAnswer ? { currentAnswer } : {}) }] : []), ...optionItems];
    });
    result.elaboration = {
      instruction: "Explain the evidence and tradeoffs directly. Re-ask only questions that remain unresolved, preserving committed answers.",
      items: items.length ? items : Object.entries(answers).map(([questionId, answer]) => ({ questionId, currentAnswer: answer.labels.join(", ") })),
    };
  }
  return result;
}

function emptyResult(input: DecisionFlowInput, cancelled: boolean): DecisionFlowResult {
  return {
    ...(input.title ? { title: input.title } : {}), cancelled, mode: "submit", answers: {},
    questions: input.questions.map(({ id, label, prompt, type, recommendedValue, recommendation }) => ({ id, label, prompt, type, recommendedValue, recommendation })),
  };
}

function renderDecisionScreen(input: DecisionFlowInput, state: DecisionState, editor: Editor, theme: Theme, width: number): string[] {
  const lines: string[] = [];
  const add = (line = "") => lines.push(truncateToWidth(line, width));
  const wrap = (text: string, indent = " ", color: Parameters<Theme["fg"]>[0] = "text") => {
    const available = Math.max(1, width - visibleWidth(indent));
    const wrapped = wrapTextWithAnsi(theme.fg(color, text), available);
    for (const line of wrapped) add(`${indent}${line}`);
  };
  add(theme.fg("accent", "─".repeat(width)));
  if (input.title) { wrap(theme.bold(input.title), " ", "accent"); add(); }
  add(renderTabs(input, state, theme, width));
  add();
  if (state.tab === input.questions.length) renderReview(lines, input, state, theme, width);
  else renderQuestion(lines, input.questions[state.tab]!, state, editor, theme, width);
  add();
  if (state.dismissArmed) wrap("Unsaved decisions exist. Press Esc or Ctrl+C again to cancel.", " ", "warning");
  else if (state.editorTarget) wrap("Enter save · Esc close and keep draft", " ", "dim");
  else if (state.tab === input.questions.length) wrap("↑↓ action · Enter choose · 1/2/3 shortcut · Tab/←→ questions", " ", "dim");
  else wrap("↑↓ choose · Enter/Space select · 1-9 shortcut · n option note · Shift+N question note · Tab/←→ navigate", " ", "dim");
  add(theme.fg("accent", "─".repeat(width)));
  return lines;
}

function renderTabs(input: DecisionFlowInput, state: DecisionState, theme: Theme, width: number): string {
  const tabs = input.questions.map((question, index) => {
    const answered = Boolean(state.selected.get(question.id)?.size || state.custom.get(question.id));
    const text = ` ${answered ? "☒" : "☐"} ${question.label} `;
    return state.tab === index ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text);
  });
  const review = " ☰ Review ";
  tabs.push(state.tab === input.questions.length ? theme.bg("selectedBg", theme.fg("text", review)) : theme.fg("success", review));
  return truncateToWidth(` ← ${tabs.join(" ")} →`, width);
}

function renderQuestion(lines: string[], question: DecisionQuestion, state: DecisionState, editor: Editor, theme: Theme, width: number): void {
  pushWrapped(lines, question.prompt, width, theme, "text", " ");
  lines.push("");
  pushWrapped(lines, `★ Recommended: ${question.options.find((option) => option.value === question.recommendedValue)?.label ?? question.recommendedValue}`, width, theme, "accent", " ");
  pushWrapped(lines, question.recommendation, width, theme, "muted", "   ");
  lines.push("");
  const cursor = state.cursor.get(question.id) ?? 0;
  const selected = state.selected.get(question.id) ?? new Set<string>();
  question.options.forEach((option, index) => {
    const pointer = cursor === index ? "❯ " : "  ";
    const checked = selected.has(option.value);
    const marker = question.type === "multi" ? (checked ? "☒" : "☐") : (checked ? "◉" : "○");
    const recommended = option.value === question.recommendedValue ? "  ★ recommended" : "";
    pushWrapped(lines, `${index + 1}. ${marker} ${option.label}${recommended}`, width, theme, cursor === index ? "accent" : checked ? "success" : "text", pointer);
    if (option.description) pushWrapped(lines, option.description, width, theme, "muted", "     ");
    const note = state.optionNotes.get(question.id)?.get(option.value);
    if (note) pushWrapped(lines, `Note: ${note}`, width, theme, "dim", "     ");
  });
  const customIndex = question.options.length;
  const customText = state.custom.get(question.id);
  pushWrapped(lines, `${customIndex + 1}. ✎ ${customText || "Type your own…"}`, width, theme, cursor === customIndex ? "accent" : customText ? "success" : "text", cursor === customIndex ? "❯ " : "  ");
  const questionNote = state.questionNotes.get(question.id);
  if (questionNote) { lines.push(""); pushWrapped(lines, `Question note: ${questionNote}`, width, theme, "dim", " "); }
  if (question.type === "preview" && cursor < question.options.length) {
    lines.push("");
    pushWrapped(lines, `Preview — ${question.options[cursor]!.label}`, width, theme, "accent", " ");
    pushWrapped(lines, question.options[cursor]!.preview ?? "", width, theme, "text", "   ");
  }
  if (state.editorTarget) {
    lines.push("");
    const label = state.editorTarget.kind === "custom" ? "Your answer" : state.editorTarget.kind === "question-note" ? "Question note" : "Option note";
    pushWrapped(lines, `${label}:`, width, theme, "muted", " ");
    for (const line of editor.render(Math.max(1, width - 2))) lines.push(truncateToWidth(` ${line}`, width));
  }
}

function renderReview(lines: string[], input: DecisionFlowInput, state: DecisionState, theme: Theme, width: number): void {
  pushWrapped(lines, "Review your decisions", width, theme, "accent", " ");
  lines.push("");
  for (const question of input.questions) {
    const selected = question.options.filter((option) => state.selected.get(question.id)?.has(option.value));
    const labels = [...selected.map((option) => option.label), ...(state.custom.get(question.id) ? [state.custom.get(question.id)!] : [])];
    pushWrapped(lines, question.label, width, theme, "text", " ");
    pushWrapped(lines, labels.length ? `→ ${labels.join(", ")}` : "— Unanswered", width, theme, labels.length ? "success" : "dim", "   ");
    if (state.questionNotes.get(question.id)) pushWrapped(lines, `Note: ${state.questionNotes.get(question.id)}`, width, theme, "dim", "   ");
  }
  lines.push("");
  ["Submit answers", "Elaborate on notes or selected answers", "Cancel"].forEach((label, index) => {
    pushWrapped(lines, `${index + 1}. ${label}`, width, theme, state.reviewAction === index ? "accent" : "text", state.reviewAction === index ? "❯ " : "  ");
  });
}

function pushWrapped(lines: string[], text: string, width: number, theme: Theme, color: Parameters<Theme["fg"]>[0], prefix: string): void {
  const prefixWidth = visibleWidth(prefix);
  const wrapped = wrapTextWithAnsi(theme.fg(color, text), Math.max(1, width - prefixWidth));
  wrapped.forEach((line, index) => lines.push(truncateToWidth(`${index ? " ".repeat(prefixWidth) : prefix}${line}`, width)));
}
