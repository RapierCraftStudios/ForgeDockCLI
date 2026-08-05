// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

interface TranscriptWriter {
  writeChildEvent(event: Record<string, unknown>): void;
}

interface TranscriptEvent {
  kind: string;
  status?: string;
  output?: string;
}

describe("bundled subagent live visibility", () => {
  it("forces operational artifacts into temp storage instead of delivery worktrees", () => {
    const extension = readFileSync(resolve("node_modules/pi-subagents/src/extension/index.ts"), "utf8");
    const defaults = readFileSync(resolve("node_modules/pi-subagents/src/shared/types.ts"), "utf8");
    assert.match(extension, /artifactDir: "temp" as const/);
    assert.match(defaults, /DEFAULT_ARTIFACT_CONFIG[\s\S]*?dir: "temp"/);
  });

  it("shows nested reviewer grandchildren as a selectable tree and summarizes their count", () => {
    const fleet = readFileSync(resolve("node_modules/pi-subagents/src/tui/fleet.ts"), "utf8");
    const fleetStatus = readFileSync(resolve("node_modules/pi-subagents/src/tui/fleet-status.ts"), "utf8");
    const nestedEvents = readFileSync(resolve("node_modules/pi-subagents/src/runs/shared/nested-events.ts"), "utf8");
    const executor = readFileSync(resolve("node_modules/pi-subagents/src/runs/foreground/subagent-executor.ts"), "utf8");
    assert.match(fleet, /nestedFleetItems/);
    assert.match(fleet, /treePrefix/);
    assert.match(fleet, /review · \$\{reviewLabel\}/);
    assert.match(fleet, /\(\+\$\{item\.nestedCount\} agent/);
    assert.match(fleetStatus, /nestedCountForStep/);
    assert.match(fleetStatus, /\(\+\$\{entry\.nestedCount\} agent/);
    assert.match(nestedEvents, /stringValue\(raw\.description, 2048\)/);
    assert.match(executor, /description: foregroundDescription\.slice\(0, 2048\)/);
  });

  it("flattens reviewer grandchildren immediately beneath their issue-worker parent", async () => {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const fleet = await jiti.import(resolve("node_modules/pi-subagents/src/tui/fleet.ts")) as {
      collectFleetSnapshot(state: Record<string, unknown>): { items: Array<Record<string, unknown>> };
    };
    const fleetStatus = await jiti.import(resolve("node_modules/pi-subagents/src/tui/fleet-status.ts")) as {
      collectFleetStatusEntries(state: Record<string, unknown>): Array<Record<string, unknown>>;
    };
    const now = Date.now();
    const asyncJobs = new Map([["issue-worker", {
      asyncId: "issue-worker", asyncDir: join(tmpdir(), "issue-worker"), sessionId: "parent-session",
      status: "running", mode: "single", startedAt: now - 10_000, updatedAt: now,
      steps: [{ agent: "forgedock-issue-worker", index: 0, status: "running", startedAt: now - 10_000 }],
      nestedChildren: [{
        id: "review-security", parentRunId: "issue-worker", parentStepIndex: 0, parentAgent: "forgedock-issue-worker",
        depth: 1, path: [{ runId: "issue-worker", stepIndex: 0, agent: "forgedock-issue-worker" }],
        state: "running", mode: "single", agent: "forgedock-reviewer",
        description: "ForgeDock review · security\nForgeDock nested task id: run:review:sha:security",
        startedAt: now - 5_000, lastUpdate: now,
      }],
    }]]);
    const state = {
      baseCwd: process.cwd(), currentSessionId: "parent-session", foregroundControls: new Map(),
      foregroundRuns: new Map(), asyncJobs,
    };
    const snapshot = fleet.collectFleetSnapshot(state);
    assert.equal(snapshot.items.length, 2);
    assert.equal(snapshot.items[0]?.agent, "forgedock-issue-worker");
    assert.equal(snapshot.items[0]?.nestedCount, 1);
    assert.equal(snapshot.items[1]?.agent, "review · security");
    assert.equal(snapshot.items[1]?.treePrefix, "└─ ");
    assert.equal(snapshot.items[1]?.key, "nested:issue-worker:review-security");
    assert.equal(fleetStatus.collectFleetStatusEntries(state)[0]?.nestedCount, 1);
  });

  it("accepts a completed read-only ForgeDock review despite an earlier optional probe failure", () => {
    const execution = readFileSync(resolve("node_modules/pi-subagents/src/runs/foreground/execution.ts"), "utf8");
    assert.match(execution, /agent\.name === "forgedock-reviewer"[\s\S]*?structuredOutputToolInvoked[\s\S]*?detectSubagentError\(\[\]\)/);
    assert.match(execution, /recoveredForgeDockTransportReview[\s\S]*?websocket[\s\S]*?result\.exitCode = 0[\s\S]*?result\.error = undefined/);
  });

  it("projects streaming tool updates into the per-worker fleet transcript", async () => {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const childTranscript = await jiti.import(resolve("node_modules/pi-subagents/src/shared/child-transcript.ts")) as {
      createChildTranscriptWriter(input: Record<string, unknown>): TranscriptWriter;
    };
    const fleetTranscript = await jiti.import(resolve("node_modules/pi-subagents/src/tui/fleet-transcript.ts")) as {
      readFleetTranscript(path: string, options: { trustedRoots: string[] }): { events: TranscriptEvent[] };
    };
    const directory = mkdtempSync(join(tmpdir(), "forgedock-visible-worker-"));
    const transcriptPath = join(directory, "worker.jsonl");
    const writer = childTranscript.createChildTranscriptWriter({
      transcriptPath, source: "async", runId: "run-visible", agent: "forgedock-issue-worker", childIndex: 0, cwd: process.cwd(),
    });
    writer.writeChildEvent({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "forgedock_work_on", args: { issue: 4 } });
    writer.writeChildEvent({
      type: "tool_execution_update", toolCallId: "tool-1", toolName: "forgedock_work_on",
      partialResult: { content: [{ type: "text", text: "investigating #4\nreading repository" }] },
    });

    const transcript = fleetTranscript.readFleetTranscript(transcriptPath, { trustedRoots: [directory] });
    const tool = transcript.events.find((event) => event.kind === "tool");
    assert.ok(tool);
    assert.equal(tool.status, "running");
    assert.equal(tool?.output, "investigating #4\nreading repository");
  });
});
