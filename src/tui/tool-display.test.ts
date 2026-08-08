// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { forgeDockToolPresentation } from "./tool-display.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

const context = (overrides: Record<string, unknown> = {}) => ({
  args: {}, toolCallId: "tool-1", state: {}, cwd: process.cwd(), executionStarted: true,
  argsComplete: true, isPartial: true, expanded: false, showImages: true, isError: false,
  invalidate: () => undefined, ...overrides,
}) as any;

test("semantic tool calls render compact safe arguments", () => {
  const presentation = forgeDockToolPresentation("ForgeDock work on");
  const rendered = presentation.renderCall?.({
    issue: 42,
    autoMerge: true,
    executionPlan: [{ huge: "must not render" }],
    token: "must not render",
  }, theme, context()).render(160).join("\n") ?? "";

  assert.match(rendered, /ForgeDock work on issue=42 autoMerge=true/);
  assert.doesNotMatch(rendered, /executionPlan|token|must not render/);
});

test("semantic tool results preserve a bounded live tail and expand on demand", () => {
  const presentation = forgeDockToolPresentation("ForgeDock work on");
  const output = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  const result = { content: [{ type: "text" as const, text: output }], details: undefined };
  const collapsed = presentation.renderResult?.(result, { expanded: false, isPartial: true }, theme, context()).render(160).join("\n") ?? "";
  assert.doesNotMatch(collapsed, /line 1\b/);
  assert.match(collapsed, /line 20\b/);
  assert.match(collapsed, /6 earlier lines/);

  const expanded = presentation.renderResult?.(result, { expanded: true, isPartial: false }, theme, context({ isPartial: false, expanded: true })).render(160).join("\n") ?? "";
  assert.match(expanded, /line 1\b/);
  assert.match(expanded, /line 20\b/);
});
