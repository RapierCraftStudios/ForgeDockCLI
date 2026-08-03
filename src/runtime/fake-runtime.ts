// SPDX-License-Identifier: AGPL-3.0-or-later

import { Check, Errors } from "typebox/value";
import type {
  AgentEventSink,
  AgentRunResult,
  AgentRuntime,
  AgentTask,
  RuntimeCapabilities,
} from "./agent-runtime.js";

export type FakeResponse = unknown | Error | ((task: AgentTask<unknown>) => unknown | Promise<unknown>);

export class FakeAgentRuntime implements AgentRuntime {
  readonly tasks: AgentTask<unknown>[] = [];
  readonly #responses: FakeResponse[];

  constructor(responses: FakeResponse[] = []) {
    this.#responses = [...responses];
  }

  enqueue(response: FakeResponse): void {
    this.#responses.push(response);
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      runtime: "fake",
      resumableSessions: false,
      tools: ["read", "grep", "find", "ls", "edit", "write"],
    };
  }

  async run<T>(task: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Agent task aborted");
    this.tasks.push(task as AgentTask<unknown>);
    const sessionRef = `fake_${crypto.randomUUID()}`;
    const emit = options.onEvent ?? (() => undefined);
    emit({ type: "session.started", taskId: task.id, sessionRef, provider: "fake", model: "scripted" });

    const response = this.#responses.shift();
    if (response === undefined) throw new Error(`No fake response queued for ${task.id}`);
    if (response instanceof Error) throw response;
    const value = typeof response === "function" ? await response(task as AgentTask<unknown>) : response;
    if (!Check(task.outputSchema, value)) {
      const details = [...Errors(task.outputSchema, value)].slice(0, 5).map((error) => error.message);
      throw new Error(`Fake response does not match task schema: ${details.join("; ")}`);
    }
    emit({ type: "artifact.submitted", taskId: task.id });
    emit({ type: "session.completed", taskId: task.id, sessionRef });
    return { output: value as T, sessionRef, provider: "fake", model: "scripted" };
  }

  async close(): Promise<void> {}
}
