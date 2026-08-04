// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDecisionFlowComponent, validateDecisionFlow, type DecisionFlowInput, type DecisionFlowResult } from "./decision-flow.js";

const key = {
  down: "\u001b[B",
  left: "\u001b[D",
  tab: "\t",
  enter: "\r",
  escape: "\u001b",
  shiftN: "N",
} as const;

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

function question(overrides: Partial<DecisionFlowInput["questions"][number]> = {}): DecisionFlowInput["questions"][number] {
  return {
    id: "rollout",
    label: "Rollout",
    prompt: "How should this ship?",
    type: "single",
    options: [
      { value: "safe", label: "Canary", description: "Limits blast radius" },
      { value: "fast", label: "Immediate", description: "Finishes sooner" },
    ],
    recommendedValue: "safe",
    recommendation: "Canary limits impact while evidence is incomplete.",
    ...overrides,
  };
}

function fixture(input: DecisionFlowInput) {
  let result: DecisionFlowResult | undefined;
  let renders = 0;
  const component = createDecisionFlowComponent(
    { requestRender: () => { renders++; } },
    theme,
    input,
    (value) => { result = value; },
  );
  component.focused = true;
  return { component, result: () => result, renders: () => renders };
}

describe("ForgeDock decision interview", () => {
  it("shows recommendation evidence, advances to review, and submits a typed answer", () => {
    const flow = fixture({ title: "Choose rollout", questions: [question()] });
    const initial = flow.component.render(80).join("\n");
    assert.match(initial, /☐ Rollout/);
    assert.match(initial, /★ Recommended: Canary/);
    assert.match(initial, /Canary limits impact/);
    assert.match(initial, /Type your own/);

    flow.component.handleInput("1");
    assert.match(flow.component.render(80).join("\n"), /Review your decisions/);
    assert.match(flow.component.render(80).join("\n"), /→ Canary/);
    flow.component.handleInput("1");

    assert.equal(flow.result()?.cancelled, false);
    assert.deepEqual(flow.result()?.answers.rollout, {
      values: ["safe"], labels: ["Canary"], indices: [1],
    });
  });

  it("supports multi-select questions and number-key toggles", () => {
    const flow = fixture({ questions: [question({ type: "multi" })] });
    flow.component.handleInput("1");
    flow.component.handleInput("2");
    flow.component.handleInput(key.tab);
    flow.component.handleInput(key.enter);
    assert.deepEqual(flow.result()?.answers.rollout?.values, ["safe", "fast"]);
  });

  it("captures an inline custom answer with the native editor", () => {
    const flow = fixture({ questions: [question()] });
    flow.component.handleInput(key.down);
    flow.component.handleInput(key.down);
    flow.component.handleInput(key.enter);
    for (const character of "Staged by region") flow.component.handleInput(character);
    flow.component.handleInput(key.enter);
    assert.match(flow.component.render(80).join("\n"), /Review your decisions/);
    flow.component.handleInput(key.enter);
    assert.deepEqual(flow.result()?.answers.rollout, {
      values: ["Staged by region"], labels: ["Staged by region"], indices: [], customText: "Staged by region",
    });
  });

  it("captures notes and returns an elaboration continuation", () => {
    const flow = fixture({ questions: [question()] });
    flow.component.handleInput("1");
    flow.component.handleInput(key.left);
    flow.component.handleInput(key.shiftN);
    for (const character of "Explain operational cost") flow.component.handleInput(character);
    flow.component.handleInput(key.enter);
    flow.component.handleInput(key.tab);
    flow.component.handleInput(key.down);
    flow.component.handleInput(key.enter);

    assert.equal(flow.result()?.mode, "elaborate");
    assert.equal(flow.result()?.answers.rollout?.note, "Explain operational cost");
    assert.deepEqual(flow.result()?.elaboration?.items, [{
      questionId: "rollout", note: "Explain operational cost", currentAnswer: "Canary",
    }]);
  });

  it("requires a second dismissal when the interview contains decisions", () => {
    const flow = fixture({ questions: [question({ type: "multi" })] });
    flow.component.handleInput("1");
    flow.component.handleInput(key.escape);
    assert.equal(flow.result(), undefined);
    assert.match(flow.component.render(80).join("\n"), /Press Esc or Ctrl\+C again/);
    flow.component.handleInput(key.escape);
    assert.equal(flow.result()?.cancelled, true);
  });

  it("validates duplicate values, recommendations, and preview payloads", () => {
    const issues = validateDecisionFlow({ questions: [question({
      type: "preview",
      recommendedValue: "missing",
      options: [
        { value: "same", label: "One", preview: "Details" },
        { value: "same", label: "Two" },
      ],
    })] });
    assert.ok(issues.some((issue) => issue.path.endsWith("options[1].value")));
    assert.ok(issues.some((issue) => issue.path.endsWith("options[1].preview")));
    assert.ok(issues.some((issue) => issue.path.endsWith("recommendedValue")));
  });

  it("never renders a line wider than the terminal", () => {
    const flow = fixture({ title: "A deliberately long decision interview title", questions: [question()] });
    for (const line of flow.component.render(32)) assert.ok(visibleWidth(line) <= 32, `${visibleWidth(line)}: ${line}`);
  });
});
