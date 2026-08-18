// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import {
  AgentExecutionInterruptedError,
  AgentRunError,
  TelemetryAgentRuntime,
  type AgentEvent,
  type AgentEventSink,
  type AgentRunResult,
  type AgentRuntime,
  type AgentTask,
  type RuntimeCapabilities,
} from "./agent-runtime.js";
import {
  LivenessRecoveringAgentRuntime,
  SemanticIdleWatchdog,
  type SemanticIdleClock,
} from "./semantic-idle.js";
import { scopeManifestFor } from "./agent-runtime.js";
import type { AgentRunReceipt } from "../core/ports/telemetry.js";

class FakeClock implements SemanticIdleClock {
  #now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number { return this.#now; }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.#now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void { this.#timers.delete(handle as number); }

  advance(ms: number): void {
    const target = this.#now + ms;
    while (true) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, left], [, right]) => left.at - right.at)[0];
      if (!due) break;
      this.#now = due[1].at;
      this.#timers.delete(due[0]);
      due[1].callback();
    }
    this.#now = target;
  }
}

const task: AgentTask<{ ok: boolean }> = {
  id: "run:investigation:1",
  role: "investigator",
  objective: "test",
  instructions: "test",
  context: [],
  workspace: { cwd: process.cwd(), mode: "read-only", scope: scopeManifestFor("issue-hints", { metadataRoots: ["."] }) },
  tools: ["read"],
  outputSchema: Type.Object({ ok: Type.Boolean() }),
  modelPolicy: {},
};

const capabilities: RuntimeCapabilities = { runtime: "fake", resumableSessions: false, tools: ["read"] };
const reviewerTask: AgentTask<{ ok: boolean }> = { ...task, id: "run:reviewer:1", role: "reviewer" };

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

test("semantic idle resets on useful progress and has no total-run deadline", () => {
  const clock = new FakeClock();
  let idleAt: number | undefined;
  const watchdog = new SemanticIdleWatchdog({ idleMs: 10, clock, onIdle: (lastProgressAt) => { idleAt = lastProgressAt; } });

  clock.advance(5);
  watchdog.markProgress({ type: "session.started", logicalStreamId: "stream-watchdog", taskId: task.id, sessionRef: "s", provider: "fake", model: "test" });
  clock.advance(4);
  assert.equal(idleAt, undefined);
  watchdog.markProgress({ type: "text.delta", logicalStreamId: "stream-watchdog", taskId: task.id, text: "still working" });
  clock.advance(9);
  assert.equal(idleAt, undefined);
  clock.advance(1);
  assert.equal(idleAt, 9);
  watchdog.stop();
});

test("relayed nested-session progress resets semantic idle", () => {
  const clock = new FakeClock();
  let idleAt: number | undefined;
  const watchdog = new SemanticIdleWatchdog({ idleMs: 10, clock, onIdle: (lastProgressAt) => { idleAt = lastProgressAt; } });

  clock.advance(9);
  watchdog.markProgress({ type: "session.progress", logicalStreamId: "stream-watchdog", taskId: task.id, sessionRef: "nested", });
  clock.advance(9);
  assert.equal(idleAt, undefined);
  clock.advance(1);
  assert.equal(idleAt, 9);
  watchdog.stop();
});

test("frozen provider is interrupted, cleaned up, and retried exactly once", async () => {
  const clock = new FakeClock();
  let runCalls = 0;
  let interruptCalls = 0;
  const inner: AgentRuntime = {
    capabilities: async () => capabilities,
    async run<T>(suppliedTask: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
      runCalls += 1;
      options.onEvent?.({ type: "session.started", logicalStreamId: `stream-attempt-${runCalls}`, taskId: suppliedTask.id, sessionRef: `session-${runCalls}`, provider: "fake", model: "test" });
      return new Promise<AgentRunResult<T>>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    },
    interrupt: () => { interruptCalls += 1; },
    close: async () => undefined,
  };
  const runtime = new LivenessRecoveringAgentRuntime(inner, { idleMs: 10, retryLimit: 1, clock });
  const pending = runtime.run(task);
  await flush();
  clock.advance(10);
  await flush();
  clock.advance(10);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AgentExecutionInterruptedError);
    assert.equal(error.reason, "semantic-idle");
    return true;
  });
  assert.equal(runCalls, 2);
  assert.equal(interruptCalls, 2);
});

test("periodic semantic progress survives repeated idle windows", async () => {
  const clock = new FakeClock();
  let emit: AgentEventSink | undefined;
  let finish!: () => void;
  const inner: AgentRuntime = {
    capabilities: async () => capabilities,
    async run<T>(suppliedTask: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
      emit = options.onEvent;
      options.onEvent?.({ type: "session.started", logicalStreamId: "stream-live", taskId: suppliedTask.id, sessionRef: "live", provider: "fake", model: "test" });
      return new Promise<AgentRunResult<T>>((resolve) => {
        finish = () => resolve({ output: { ok: true } as T, sessionRef: "live", provider: "fake", model: "test" });
      });
    },
    interrupt: () => { throw new Error("progressing provider must not be interrupted"); },
    close: async () => undefined,
  };
  const runtime = new LivenessRecoveringAgentRuntime(inner, { idleMs: 10, retryLimit: 1, clock });
  const pending = runtime.run(task);
  await flush();
  for (let index = 0; index < 6; index += 1) {
    clock.advance(9);
    emit?.({ type: "tool.completed", logicalStreamId: "stream-live", taskId: task.id, toolCallId: `tool-${index}`, tool: "read", isError: false });
  }
  finish();
  const result = await pending;
  assert.deepEqual(result.output, { ok: true });
});

test("in-flight bounded verification heartbeat survives the generic idle window", async () => {
  const clock = new FakeClock();
  let emit: AgentEventSink | undefined;
  let finish!: () => void;
  let interruptCalls = 0;
  const inner: AgentRuntime = {
    capabilities: async () => capabilities,
    async run<T>(suppliedTask: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
      emit = options.onEvent;
      options.onEvent?.({ type: "session.started", logicalStreamId: "stream-verify-live", taskId: suppliedTask.id, sessionRef: "verify-live", provider: "fake", model: "test" });
      options.onEvent?.({ type: "tool.started", logicalStreamId: "stream-verify-live", taskId: suppliedTask.id, toolCallId: "verify-1", tool: "verify", args: { commandId: "tests" } });
      return new Promise<AgentRunResult<T>>((resolve) => {
        finish = () => resolve({ output: { ok: true } as T, sessionRef: "verify-live", provider: "fake", model: "test" });
      });
    },
    interrupt: () => { interruptCalls += 1; },
    close: async () => undefined,
  };
  const runtime = new LivenessRecoveringAgentRuntime(inner, { idleMs: 10, retryLimit: 0, clock });
  const pending = runtime.run(task);
  await flush();
  for (let index = 0; index < 20; index += 1) {
    clock.advance(9);
    emit?.({ type: "tool.progress", logicalStreamId: "stream-verify-live", taskId: task.id, toolCallId: "verify-1", tool: "verify", elapsedMs: (index + 1) * 9, timeoutMs: 300 });
  }
  assert.equal(interruptCalls, 0);
  finish();
  const result = await pending;
  assert.deepEqual(result.output, { ok: true });
});

test("a verify call without heartbeats still reaches the generic fail-closed bound", async () => {
  const clock = new FakeClock();
  let interruptCalls = 0;
  const inner: AgentRuntime = {
    capabilities: async () => capabilities,
    async run<T>(suppliedTask: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
      options.onEvent?.({ type: "session.started", logicalStreamId: "stream-verify-hung", taskId: suppliedTask.id, sessionRef: "verify-hung", provider: "fake", model: "test" });
      options.onEvent?.({ type: "tool.started", logicalStreamId: "stream-verify-hung", taskId: suppliedTask.id, toolCallId: "verify-1", tool: "verify", args: { commandId: "tests" } });
      return new Promise<AgentRunResult<T>>((_, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    },
    interrupt: () => { interruptCalls += 1; },
    close: async () => undefined,
  };
  const runtime = new LivenessRecoveringAgentRuntime(inner, { idleMs: 10, retryLimit: 0, clock });
  const pending = runtime.run(task);
  await flush();
  clock.advance(10);
  await flush();
  await assert.rejects(pending, (error: unknown) => error instanceof AgentExecutionInterruptedError);
  assert.equal(interruptCalls, 1);
});

test("does not retry while an interrupted provider remains in flight", async () => {
  const clock = new FakeClock();
  let runCalls = 0;
  let interruptCalls = 0;
  const inner: AgentRuntime = {
    capabilities: async () => capabilities,
    async run<T>(): Promise<AgentRunResult<T>> {
      runCalls += 1;
      return new Promise<AgentRunResult<T>>(() => undefined);
    },
    interrupt: () => { interruptCalls += 1; },
    close: async () => undefined,
  };
  const runtime = new LivenessRecoveringAgentRuntime(inner, { idleMs: 10, drainMs: 5, retryLimit: 1, clock });
  const pending = runtime.run(task);
  await flush();
  clock.advance(10);
  await flush();
  clock.advance(5);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AgentExecutionInterruptedError);
    assert.equal(error.drainExpired, true);
    assert.equal(error.drainMs, 5);
    return true;
  });
  assert.equal(runCalls, 1);
  assert.equal(interruptCalls, 1);
});

test("caller cancellation drains the owned attempt before returning", async () => {
  const clock = new FakeClock();
  let interruptCalls = 0;
  const inner: AgentRuntime = {
    capabilities: async () => capabilities,
    async run<T>(): Promise<AgentRunResult<T>> { return new Promise<AgentRunResult<T>>(() => undefined); },
    interrupt: () => { interruptCalls += 1; },
    close: async () => undefined,
  };
  const runtime = new LivenessRecoveringAgentRuntime(inner, { idleMs: 100, drainMs: 5, clock });
  const controller = new AbortController();
  const pending = runtime.run(task, { signal: controller.signal });
  await flush();
  controller.abort(new Error("operator cancelled"));
  await flush();
  clock.advance(5);
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof AgentExecutionInterruptedError);
    assert.equal(error.reason, "cancelled");
    assert.equal(error.drainExpired, true);
    const cause = (error as Error & { cause?: unknown }).cause;
    if (!(cause instanceof Error)) return false;
    assert.equal(cause.message, "operator cancelled");
    return true;
  });
  assert.equal(interruptCalls, 1);
});

test("returns a late successful idle result instead of starting duplicate work", async () => {
  const clock = new FakeClock();
  let finish!: () => void;
  let runCalls = 0;
  const inner: AgentRuntime = {
    capabilities: async () => capabilities,
    async run<T>(): Promise<AgentRunResult<T>> {
      runCalls += 1;
      return new Promise<AgentRunResult<T>>((resolve) => {
        finish = () => resolve({ output: { ok: true } as T, sessionRef: "late", provider: "fake", model: "test" });
      });
    },
    interrupt: () => undefined,
    close: async () => undefined,
  };
  const runtime = new LivenessRecoveringAgentRuntime(inner, { idleMs: 10, drainMs: 5, clock });
  const pending = runtime.run(task);
  await flush();
  clock.advance(10);
  await flush();
  finish();
  const result = await pending;
  assert.deepEqual(result.output, { ok: true });
  assert.equal(runCalls, 1);
});

test("leaves reviewer retry ownership to the workflow attempt budget", async () => {
  const clock = new FakeClock();
  let runCalls = 0;
  const inner: AgentRuntime = {
    capabilities: async () => capabilities,
    async run<T>(_task: AgentTask<T>, options: { signal?: AbortSignal } = {}): Promise<AgentRunResult<T>> {
      runCalls += 1;
      return new Promise<AgentRunResult<T>>((_, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
    },
    interrupt: () => undefined,
    close: async () => undefined,
  };
  const runtime = new LivenessRecoveringAgentRuntime(inner, { idleMs: 10, retryLimit: 1, clock });
  const pending = runtime.run(reviewerTask);
  await flush();
  clock.advance(10);
  await flush();
  await assert.rejects(pending, (error: unknown) => error instanceof AgentExecutionInterruptedError);
  assert.equal(runCalls, 1);
});

test("telemetry records each hidden retry and preserves interrupted execution usage", async () => {
  const clock = new FakeClock();
  let runCalls = 0;
  const receipts: AgentRunReceipt[] = [];
  const inner: AgentRuntime = {
    capabilities: async () => capabilities,
    async run<T>(_task: AgentTask<T>, options: { signal?: AbortSignal } = {}): Promise<AgentRunResult<T>> {
      runCalls += 1;
      if (runCalls === 1) {
        return new Promise<AgentRunResult<T>>((_, reject) => options.signal?.addEventListener("abort", () => reject(new AgentRunError("aborted", {
          execution: { turns: 1, toolCalls: 2 },
        })), { once: true }));
      }
      return { output: { ok: true } as T, sessionRef: "retry", provider: "fake", model: "test" };
    },
    interrupt: () => undefined,
    close: async () => undefined,
  };
  const runtime = new LivenessRecoveringAgentRuntime(
    new TelemetryAgentRuntime(inner, (receipt) => { receipts.push(receipt); }),
    { idleMs: 10, retryLimit: 1, clock },
  );
  const pending = runtime.run(task);
  await flush();
  clock.advance(10);
  const result = await pending;
  assert.deepEqual(result.output, { ok: true });
  assert.equal(runCalls, 2);
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts[0]?.execution, { turns: 1, toolCalls: 2 });
});
