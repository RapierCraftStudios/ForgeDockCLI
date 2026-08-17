// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FORGEDOCK_ORCHESTRATION_WIDGET_KEY,
  OrchestrationBoardController,
  formatOrchestrationInvocationLabel,
  formatPreviewDeadline,
} from "./orchestration-board.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function snapshot(orchestrationId: string, issue: number, status: "queued" | "running" | "completed" | "blocked", updatedAt: string) {
  return {
    orchestrationId,
    nodes: [{
      id: `issue-${issue}`,
      issue,
      memberIssues: [issue],
      status,
      dependencies: status === "blocked" ? ["issue-68"] : [],
      claims: [],
      ...(status === "blocked" ? { error: "predecessor failed" } : {}),
    }],
    readyNodes: status === "queued" ? [`issue-${issue}`] : [],
    blockedNodes: status === "blocked" ? [`issue-${issue}`] : [],
    invalidNodes: [],
    suspendedNodes: [],
    activeLeases: [],
    remediationCheckpoints: [],
    updatedAt,
  };
}

test("board registry renders concurrent DAGs without overwriting either snapshot", () => {
  const widgets = new Map<string, unknown>();
  let renderRequests = 0;
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (key: string, content: unknown) => {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      },
    },
  } as any;
  const board = new OrchestrationBoardController();
  board.attach(ctx);
  board.updateEvent({
    name: "started",
    orchestrationId: "dag_abc123",
    at: "2030-01-01T00:00:01.000Z",
    snapshot: snapshot("dag_abc123", 68, "running", "2030-01-01T00:00:01.000Z"),
  }, "/orchestrate #68", "owner/repo");

  const factory = widgets.get(FORGEDOCK_ORCHESTRATION_WIDGET_KEY) as (tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[] };
  assert.ok(factory);
  const component = factory({ requestRender: () => { renderRequests++; } }, theme);
  board.updateEvent({
    name: "blocked",
    orchestrationId: "dag_def456",
    at: "2030-01-01T00:00:02.000Z",
    snapshot: snapshot("dag_def456", 69, "blocked", "2030-01-01T00:00:02.000Z"),
  }, "/orchestrate #69", "owner/repo");

  const rendered = component.render(160).join("\n");
  assert.match(rendered, /dag_abc123/);
  assert.match(rendered, /dag_def456/);
  assert.match(rendered, /#68 running/);
  assert.match(rendered, /#69 blocked/);
  assert.match(rendered, /deps=issue-68/);
  assert.equal(renderRequests, 1);

  board.dispose();
  const requestsBeforeLateEvent = renderRequests;
  board.updateEvent({
    name: "completed",
    orchestrationId: "dag_abc123",
    at: "2030-01-01T00:00:03.000Z",
    snapshot: snapshot("dag_abc123", 68, "completed", "2030-01-01T00:00:03.000Z"),
  }, "/orchestrate #68", "owner/repo");
  assert.equal(renderRequests, requestsBeforeLateEvent);
  assert.equal(widgets.has(FORGEDOCK_ORCHESTRATION_WIDGET_KEY), false);
});

test("preview deadline and invocation labels are display-only projections", () => {
  assert.equal(formatOrchestrationInvocationLabel("orchestrate", "#68\nsecret"), "/orchestrate #68 secret");
  assert.equal(formatPreviewDeadline("not-a-date"), "checkpoint deadline unknown");
  assert.equal(formatPreviewDeadline("2000-01-01T00:00:00.000Z"), "deadline reached");
});
