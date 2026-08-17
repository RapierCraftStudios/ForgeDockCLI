// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { ForgeDockObserver } from "../observability/observer.js";
import { SqliteObservationStore } from "../observability/sqlite-store.js";
import { ForgeDockObserverWorkspace } from "./observer-workspace.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function contextObserver(): ForgeDockObserver {
  return new ForgeDockObserver({
    store: new SqliteObservationStore(":memory:"),
    producer: { component: "workspace-test", processInstanceId: "workspace-test:1", pid: 1 },
  });
}

test("workspace renders semantic state, attention, and channel-preserving output", async () => {
  const observer = contextObserver();
  await observer.emit({
    producer: observer.producer,
    identity: { forgeRunId: "run-1", workUnitId: "unit-1", issueNumber: 68 },
    source: "workflow",
    channel: "lifecycle",
    kind: "workflow.state.changed",
    payload: { phase: "building", state: "building", label: "#68 worker" },
  });
  await observer.emit({
    producer: observer.producer,
    identity: { forgeRunId: "run-1", workUnitId: "unit-1", issueNumber: 68 },
    source: "controller",
    channel: "stdout",
    kind: "output.stdout",
    output: { channel: "stdout", text: "verification started", chunkSequence: 1 },
    payload: {},
  });
  await observer.emit({
    producer: observer.producer,
    identity: { forgeRunId: "run-1", workUnitId: "unit-1", issueNumber: 68 },
    source: "workflow",
    channel: "decision",
    kind: "attention.created",
    severity: "warning",
    payload: { attentionId: "a1", level: "action-required", reason: "Resume checkpoint" },
  });
  const component = new ForgeDockObserverWorkspace(observer, theme, () => undefined);
  const rendered = component.render(120).join("\n");
  assert.match(rendered, /ForgeDock Observer/);
  assert.match(rendered, /#68 worker/);
  assert.match(rendered, /ACTION-REQUIRED: Resume/);
  assert.match(rendered, /checkpoint/);
  component.handleInput("\t");
  assert.match(component.render(120).join("\n"), /events|output|attention|health/i);
  component.dispose();
  observer.close();
});
