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
