// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FORGEDOCK_ORCHESTRATION_WIDGET_KEY,
  OrchestrationBoardController,
  formatOrchestrationInvocationLabel,
  formatPreviewDeadline,
} from "./orchestration-board.js";
import type { OrchestrationSnapshot } from "../workflows/orchestrate/events.js";
import type { ScheduledStatus } from "../workflows/orchestrate/scheduler.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function snapshot(orchestrationId: string, issue: number, status: ScheduledStatus, updatedAt: string): OrchestrationSnapshot {
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
    invalidNodes: status === "invalid" ? [`issue-${issue}`] : [],
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
  assert.match(rendered, /semantic-deps=issue-68/);
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

test("persisted completed invalid snapshots use terminal progress [invariant:matrix-adapter-lifecycle-280fca5b8d56] [invariant:matrix-terminal-metadata-3b76cac705b1]", () => {
  const widgets = new Map<string, unknown>();
  let renderRequests = 0;
  const board = new OrchestrationBoardController();
  board.attach({ hasUI: true, ui: { setWidget: (key: string, value: unknown) => value === undefined ? widgets.delete(key) : widgets.set(key, value) } } as any);

  board.complete("dag_invalid", "completed", snapshot("dag_invalid", 71, "invalid", "2030-01-01T00:00:01.000Z"), "/orchestrate #71", "owner/repo");
  const factory = widgets.get(FORGEDOCK_ORCHESTRATION_WIDGET_KEY) as (tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[] };
  const component = factory({ requestRender: () => { renderRequests++; } }, theme);
  const invalidRendered = component.render(160).join("\n");
  assert.match(invalidRendered, /dag_invalid · completed · 1\/1 terminal/);
  assert.match(invalidRendered, /! #71 invalid/);
  assert.doesNotMatch(invalidRendered, /0\/1 complete/);

  board.complete("dag_invalid", "completed", snapshot("dag_invalid", 71, "completed", "2030-01-01T00:00:02.000Z"), "/orchestrate #71", "owner/repo");
  const completedRendered = component.render(160).join("\n");
  assert.match(completedRendered, /dag_invalid · completed · 1\/1 complete/);
  assert.match(completedRendered, /✓ #71 completed/);
  assert.equal(renderRequests, 1);
  board.dispose();
});

test("later invalid event refreshes the existing board projection [invariant:matrix-adapter-lifecycle-ad54a36e007c] [invariant:matrix-terminal-metadata-2ca71677e424]", () => {
  const widgets = new Map<string, unknown>();
  let renderRequests = 0;
  const board = new OrchestrationBoardController();
  board.attach({ hasUI: true, ui: { setWidget: (key: string, value: unknown) => value === undefined ? widgets.delete(key) : widgets.set(key, value) } } as any);
  board.updateEvent({
    name: "started",
    orchestrationId: "dag_live_invalid",
    at: "2030-01-01T00:00:01.000Z",
    snapshot: snapshot("dag_live_invalid", 72, "running", "2030-01-01T00:00:01.000Z"),
  }, "/orchestrate #72", "owner/repo");
  const factory = widgets.get(FORGEDOCK_ORCHESTRATION_WIDGET_KEY) as (tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[] };
  const component = factory({ requestRender: () => { renderRequests++; } }, theme);

  board.updateEvent({
    name: "invalid",
    orchestrationId: "dag_live_invalid",
    at: "2030-01-01T00:00:02.000Z",
    snapshot: snapshot("dag_live_invalid", 72, "invalid", "2030-01-01T00:00:02.000Z"),
  }, "/orchestrate #72", "owner/repo");
  const rendered = component.render(160).join("\n");
  assert.match(rendered, /dag_live_invalid · active · 1\/1 terminal/);
  assert.match(rendered, /! #72 invalid/);
  assert.equal(renderRequests, 1);
  board.dispose();
});

test("mixed terminal statuses remain distinct and count once [invariant:matrix-adapter-lifecycle-a7e3a44163e4] [invariant:matrix-terminal-metadata-76660230fb62]", () => {
  const widgets = new Map<string, unknown>();
  const board = new OrchestrationBoardController();
  board.attach({ hasUI: true, ui: { setWidget: (key: string, value: unknown) => value === undefined ? widgets.delete(key) : widgets.set(key, value) } } as any);
  const statuses = [
    [101, "completed"],
    [102, "failed"],
    [103, "blocked"],
    [104, "skipped"],
    [105, "invalid"],
  ] as const;
  const mixed: OrchestrationSnapshot = {
    ...snapshot("dag_mixed_terminal", 101, "completed", "2030-01-01T00:00:03.000Z"),
    orchestrationStatus: "completed",
    nodes: statuses.map(([issue, status]) => ({
      id: `issue-${issue}`,
      issue,
      memberIssues: [issue],
      status,
      dependencies: status === "blocked" ? ["issue-101"] : [],
      claims: [],
      ...(status === "blocked" ? { error: "predecessor failed" } : {}),
    })),
  };
  board.complete("dag_mixed_terminal", "completed", mixed, "/orchestrate #101 #102 #103 #104 #105", "owner/repo");
  const factory = widgets.get(FORGEDOCK_ORCHESTRATION_WIDGET_KEY) as (tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[] };
  const rendered = factory({ requestRender: () => undefined }, theme).render(240).join("\n");
  assert.match(rendered, /dag_mixed_terminal · completed · 5\/5 terminal/);
  for (const [issue, status] of statuses) assert.match(rendered, new RegExp(`#${issue} ${status}`));
  assert.equal((rendered.match(/#\d+ (?:completed|failed|blocked|skipped|invalid)/g) ?? []).length, 5);
  assert.doesNotMatch(rendered, /#105 completed/);
  assert.doesNotMatch(rendered, /5\/5 complete/);
  board.dispose();
});

test("board renders cancelled DAGs as stopped without active attention", () => {
  const widgets = new Map<string, unknown>();
  const board = new OrchestrationBoardController();
  board.attach({ hasUI: true, ui: { setWidget: (key: string, value: unknown) => value === undefined ? widgets.delete(key) : widgets.set(key, value) } } as any);
  board.updateEvent({ name: "snapshot", orchestrationId: "dag_cancel", at: "2030-01-01T00:00:00.000Z", snapshot: { ...snapshot("dag_cancel", 70, "queued", "2030-01-01T00:00:00.000Z"), orchestrationStatus: "cancelled" } }, "/orchestrate stop dag_cancel", "owner/repo");
  const factory = widgets.get(FORGEDOCK_ORCHESTRATION_WIDGET_KEY) as (tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[] };
  const rendered = factory({ requestRender: () => undefined }, theme).render(160).join("\n");
  assert.match(rendered, /dag_cancel · cancelled · .*stopped/);
  board.dispose();
});

test("preview confirmation window includes elapsed state, fresh-preview guidance, and absolute deadline", () => {
  assert.equal(formatOrchestrationInvocationLabel("orchestrate", "#68\nsecret"), "/orchestrate #68 secret");
  assert.equal(
    formatPreviewDeadline("not-a-date"),
    "confirmation window unavailable · fresh preview required · deadline unknown",
  );
  const elapsed = formatPreviewDeadline("2000-01-01T00:00:00.000Z");
  assert.match(elapsed, /^confirmation window elapsed \d+:\d{2} ago/);
  assert.match(elapsed, /fresh preview required/);
  assert.match(elapsed, /deadline 2000-01-01T00:00:00\.000Z$/);
});

test("board renders all five nodes, explicit batch members, waits, and capacity invalidation", () => {
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
  const updatedAt = "2030-01-01T00:00:00.000Z";
  const nodes = [1, 2, 3, 4, 5].map((issue) => ({
    id: `issue-${issue}`,
    issue,
    memberIssues: issue === 5 ? [5, 6] : [issue],
    status: "queued" as const,
    dependencies: issue === 1 ? [] : [`issue-${issue - 1}`],
    claims: [`src/${issue}.ts`],
    title: `Visible issue ${issue}`,
    route: { repository: "owner/repo", targetBranch: "main", lane: "fast" as const },
    ...(issue === 5 ? { waitReason: { kind: "capacity" as const, maxParallel: 2 } } : {}),
  }));
  const first = {
    orchestrationId: "dag_five",
    nodes,
    readyNodes: ["issue-1"],
    blockedNodes: [],
    invalidNodes: [],
    suspendedNodes: [],
    activeLeases: [],
    remediationCheckpoints: [],
    selectedIssueNumbers: [1, 2, 3, 4, 5, 6],
    issueSlots: { selected: 6, runnableNow: 1, requestedCap: 3, transportCap: 2, effectiveCap: 2 },
    serializationEdges: [],
    serializationChains: [],
    updatedAt,
  };
  board.updateEvent({ name: "snapshot", orchestrationId: "dag_five", at: updatedAt, snapshot: first }, "/orchestrate #1 #2 #3 #4 #5 #6");
  const factory = widgets.get(FORGEDOCK_ORCHESTRATION_WIDGET_KEY) as (tui: { requestRender(): void }, theme: unknown) => { render(width: number): string[] };
  const component = factory({ requestRender: () => { renderRequests++; } }, theme);
  const rendered = component.render(240).join("\n");
  for (const issue of [1, 2, 3, 4, 5]) assert.match(rendered, new RegExp(`#${issue} queued`));
  assert.match(rendered, /members=#5,#6/);
  assert.match(rendered, /6 selected · 1 runnable now · requested cap 3 · transport cap 2 · effective cap 2/);
  assert.match(rendered, /wait=capacity 2 issue slot/);
  assert.doesNotMatch(rendered, /more node/);

  board.updateEvent({
    name: "snapshot",
    orchestrationId: "dag_five",
    at: updatedAt,
    snapshot: {
      ...first,
      issueSlots: { ...first.issueSlots, transportCap: 1, effectiveCap: 1 },
      nodes: nodes.map((node) => node.issue === 5
        ? { ...node, waitReason: { kind: "active-claim-conflict" as const, node: "issue-4", claims: ["src/5.ts"] } }
        : node),
    },
  }, "/orchestrate #1 #2 #3 #4 #5 #6");
  assert.equal(renderRequests, 1, "wait/capacity changes at the same timestamp invalidate the board");
  board.dispose();
});
