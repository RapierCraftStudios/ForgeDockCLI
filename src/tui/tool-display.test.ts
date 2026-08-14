// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { forgeDockOrchestrateToolPresentation, forgeDockToolPresentation } from "./tool-display.js";

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

test("orchestration rendering hides preview tokens in collapsed and expanded output", () => {
  const presentation = forgeDockOrchestrateToolPresentation();
  const result = {
    content: [{ type: "text" as const, text: 'FORGEDOCK_PREVIEW_CONTINUATION {"previewToken":"secret-token"}\nForgeDock orchestration preview\nSelected issues: #68' }],
    details: {
      command: "orchestrate",
      args: ["68"],
      state: "completed",
      previewToken: "secret-token",
      ui: {
        schemaVersion: 1 as const,
        phase: "preview" as const,
        invocationLabel: "/orchestrate #68",
        repository: "owner/repo",
        selectedIssueCount: 1,
        workUnitCount: 1,
        maxParallel: 4,
        preview: {
          checkpoint: true,
          expiresAt: "2030-01-01T00:00:00.000Z",
          repository: "owner/repo",
          selectedIssueNumbers: [68],
          workUnitCount: 1,
          maxParallel: 4,
          batching: "conservative" as const,
          scopeExpansion: "scope-locked" as const,
          autoMerge: true,
        },
      },
    },
  };
  const collapsed = presentation.renderResult?.(result, { expanded: false, isPartial: false }, theme, context({ isPartial: false })).render(160).join("\n") ?? "";
  const expanded = presentation.renderResult?.(result, { expanded: true, isPartial: false }, theme, context({ isPartial: false, expanded: true })).render(160).join("\n") ?? "";
  for (const rendered of [collapsed, expanded]) {
    assert.match(rendered, /ForgeDock orchestration preview/);
    assert.match(rendered, /owner\/repo/);
    assert.doesNotMatch(rendered, /secret-token|FORGEDOCK_PREVIEW_CONTINUATION/);
  }
});

test("orchestration handoff renders delegated instead of active", () => {
  const presentation = forgeDockOrchestrateToolPresentation();
  const result = {
    content: [{ type: "text" as const, text: "ForgeDock started streaming DAG dag_abc123." }],
    details: {
      command: "orchestrate",
      args: ["68"],
      state: "delegated",
      ui: {
        schemaVersion: 1 as const,
        phase: "delegated" as const,
        invocationLabel: "/orchestrate #68",
        orchestrationId: "dag_abc123",
        summary: "Live progress is shown in the ForgeDock orchestration board.",
      },
    },
  };
  const rendered = presentation.renderResult?.(result, { expanded: false, isPartial: false }, theme, context({ isPartial: false })).render(160).join("\n") ?? "";
  assert.match(rendered, /delegated: dag_abc123/);
  assert.match(rendered, /Live progress is shown in the ForgeDock orchestration board/);
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
