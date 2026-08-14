// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentEvent, AgentEventSink } from "../runtime/agent-runtime.js";
import { createObservationProducer, type ObservationDraft, type ObservationIdentity, type ObservationSink, type ObservationSeverity } from "./contracts.js";

export interface ObservationAdapterContext {
  identity?: ObservationIdentity;
  producer?: ReturnType<typeof createObservationProducer>;
}

export function createAgentEventObservationSink(observer: ObservationSink, context: ObservationAdapterContext = {}): AgentEventSink {
  let outputSequence = 0;
  const producer = context.producer ?? createObservationProducer("agent-runtime");
  return (event: AgentEvent) => {
    const identity: ObservationIdentity = {
      ...(context.identity ?? {}),
      agentTaskId: event.taskId,
      ...(event.observability?.activeChild ? { parentAgentId: event.observability.activeChild } : {}),
    };
    const base = {
      producer,
      identity,
      source: "agent" as const,
    };
    if (event.type === "thinking.delta") {
      void observer.emit({ ...base, channel: "activity", kind: "activity.changed", severity: "debug", payload: { activity: "thinking", summary: "Model activity" } });
      return;
    }
    if (event.type === "text.delta") {
      outputSequence += 1;
      void observer.emit({
        ...base,
        channel: "activity",
        kind: "output.delta",
        payload: { summary: "Assistant output", text: event.text },
        output: { channel: "stdout", text: event.text, chunkSequence: outputSequence },
      });
      return;
    }
    if (event.type === "session.started") {
      void observer.emit({ ...base, identity: { ...identity, piSessionRef: event.sessionRef }, channel: "lifecycle", kind: "agent.session.started", payload: { provider: event.provider, model: event.model, ...observabilityPayload(event) } });
      return;
    }
    if (event.type === "tool.started") {
      void observer.emit({ ...base, channel: "tool", kind: "tool.started", payload: { tool: event.tool, toolCallId: event.toolCallId, args: safeToolArgs(event.args), ...observabilityPayload(event) } });
      return;
    }
    if (event.type === "tool.completed") {
      void observer.emit({ ...base, channel: "tool", kind: "tool.completed", severity: event.isError ? "error" : "info", payload: { tool: event.tool, toolCallId: event.toolCallId, isError: event.isError, ...(event.errorSummary ? { summary: event.errorSummary } : {}), ...observabilityPayload(event) } });
      return;
    }
    if (event.type === "artifact.submitted") {
      void observer.emit({ ...base, channel: "artifact", kind: "artifact.submitted", payload: { ...observabilityPayload(event) } });
      return;
    }
    void observer.emit({
      ...base,
      identity: { ...identity, piSessionRef: event.sessionRef },
      channel: "lifecycle",
      kind: "agent.session.completed",
      payload: { ...observabilityPayload(event) },
    });
  };
}

export class ControllerObservationAdapter {
  readonly #observer: ObservationSink;
  readonly #context: ObservationAdapterContext;
  #outputSequence = 0;

  constructor(observer: ObservationSink, context: ObservationAdapterContext = {}) {
    this.#observer = observer;
    this.#context = context;
  }

  started(command: string, args: readonly string[]): void {
    this.emit("lifecycle", "controller.started", { command, args: safeArgs(args) });
  }

  output(channel: "stdout" | "stderr", text: string): void {
    this.#outputSequence += 1;
    this.emit(channel, channel === "stdout" ? "output.stdout" : "output.stderr", { bytes: Buffer.byteLength(text, "utf8") }, "info", {
      channel,
      text,
      chunkSequence: this.#outputSequence,
    });
  }

  completed(code: number, truncated = false): void {
    if (truncated) this.emit("diagnostic", "output.truncated", { summary: "Controller output was bounded to the retained tail" }, "warning", undefined, { truncated: true });
    this.emit("lifecycle", "controller.completed", { code }, code === 0 ? "info" : "error", undefined, truncated ? { truncated: true } : undefined);
  }

  failed(error: unknown): void {
    this.emit("lifecycle", "controller.failed", { summary: error instanceof Error ? error.message : String(error) }, "error");
  }

  private emit(channel: "lifecycle" | "stdout" | "stderr" | "diagnostic", kind: string, payload: unknown, severity: ObservationSeverity = "info", output?: ObservationDraft["output"], delivery?: ObservationDraft["delivery"]): void {
    void this.#observer.emit({
      producer: this.#context.producer ?? createObservationProducer("forgedock-controller"),
      ...(this.#context.identity ? { identity: this.#context.identity } : {}),
      source: "controller",
      channel,
      kind,
      severity,
      payload,
      ...(output ? { output } : {}),
      ...(delivery ? { delivery } : {}),
    });
  }
}

export class BackgroundTaskObservationAdapter {
  readonly #observer: ObservationSink;
  readonly #producer: ReturnType<typeof createObservationProducer>;

  constructor(observer: ObservationSink, producer = createObservationProducer("forgedock-background-task")) {
    this.#observer = observer;
    this.#producer = producer;
  }

  started(task: { id: string; command: string; args: readonly string[]; cwd: string; pid: number }): void {
    this.emit(task.id, "process.started", "info", { command: task.command, args: safeArgs(task.args), cwd: task.cwd, pid: task.pid });
  }

  adopted(taskId: string, pid: number): void {
    this.emit(taskId, "process.adopted", "notice", { pid, summary: "Controller adopted after terminal restart" });
  }

  output(taskId: string, channel: "stdout" | "stderr", text: string, chunkSequence: number): void {
    void this.#observer.emit({
      producer: this.#producer,
      identity: { controllerTaskId: taskId },
      source: "process",
      channel,
      kind: channel === "stdout" ? "output.stdout" : "output.stderr",
      payload: { bytes: Buffer.byteLength(text, "utf8") },
      output: { channel, text, chunkSequence },
    });
  }

  finished(taskId: string, status: string, exitCode?: number): void {
    this.emit(taskId, status === "completed" ? "process.exited" : "process.failed", status === "completed" ? "info" : "error", { status, ...(exitCode !== undefined ? { exitCode } : {}) });
  }

  private emit(taskId: string, kind: string, severity: ObservationSeverity, payload: unknown): void {
    void this.#observer.emit({ producer: this.#producer, identity: { controllerTaskId: taskId }, source: "process", channel: "lifecycle", kind, severity, payload });
  }
}

export interface PiAsyncStatusSnapshot {
  id: string;
  state?: string;
  sessionId?: string;
  asyncDir?: string;
  agent?: string;
  currentTool?: string;
  currentPath?: string;
  parentRunId?: string;
  parentStepIndex?: number;
  depth?: number;
  pid?: number;
  summary?: string;
}

export class PiAsyncObservationAdapter {
  readonly #observer: ObservationSink;
  readonly #producer: ReturnType<typeof createObservationProducer>;

  constructor(observer: ObservationSink, producer = createObservationProducer("pi-subagents")) {
    this.#observer = observer;
    this.#producer = producer;
  }

  started(status: PiAsyncStatusSnapshot): void {
    this.emit(status, "pi.async.started", "info");
  }

  updated(status: PiAsyncStatusSnapshot): void {
    this.emit(status, "pi.async.updated", "debug");
  }

  completed(status: PiAsyncStatusSnapshot): void {
    this.emit(status, "pi.async.completed", status.state === "complete" || status.state === "completed" ? "info" : "error");
  }

  private emit(status: PiAsyncStatusSnapshot, kind: string, severity: ObservationSeverity): void {
    const identity: ObservationIdentity = {
      piAsyncId: status.id,
      ...(status.sessionId ? { piSessionRef: status.sessionId } : {}),
      ...(status.parentRunId ? { parentAgentId: status.parentRunId } : {}),
      ...(status.parentStepIndex !== undefined ? { childIndex: status.parentStepIndex } : {}),
      ...(status.depth !== undefined ? { depth: status.depth } : {}),
    };
    void this.#observer.emit({
      producer: this.#producer,
      identity,
      source: "pi-subagents",
      channel: "lifecycle",
      kind,
      severity,
      payload: {
        state: status.state,
        agent: status.agent,
        currentTool: status.currentTool,
        currentPath: status.currentPath,
        summary: status.summary,
        ...(status.pid !== undefined ? { pid: status.pid } : {}),
      },
    });
  }
}

export class NestedReviewerObservationAdapter {
  readonly #observer: ObservationSink;
  readonly #producer: ReturnType<typeof createObservationProducer>;

  constructor(observer: ObservationSink, producer = createObservationProducer("forgedock-nested-reviewer")) {
    this.#observer = observer;
    this.#producer = producer;
  }

  requested(identity: ObservationIdentity, summary: string): void { this.emit(identity, "review.requested", "info", { summary }); }
  started(identity: ObservationIdentity, sessionRef?: string): void { this.emit({ ...identity, ...(sessionRef ? { piSessionRef: sessionRef } : {}) }, "review.started", "info", {}); }
  completed(identity: ObservationIdentity, summary?: string): void { this.emit(identity, "review.completed", "info", { ...(summary ? { summary } : {}) }); }
  failed(identity: ObservationIdentity, error: unknown): void { this.emit(identity, "review.failed", "error", { summary: error instanceof Error ? error.message : String(error) }); }

  private emit(identity: ObservationIdentity, kind: string, severity: ObservationSeverity, payload: unknown): void {
    void this.#observer.emit({ producer: this.#producer, identity: { ...identity, agentRole: "reviewer" }, source: "reviewer", channel: "review", kind, severity, payload });
  }
}

export function createArtifactObservation(observer: ObservationSink, identity: ObservationIdentity, artifactId: string, kind: string): void {
  void observer.emit({
    producer: createObservationProducer("forgedock-artifact"),
    identity: { ...identity, artifactId },
    source: "artifact",
    channel: "artifact",
    kind: "artifact.submitted",
    payload: { artifactId, kind },
  });
}

function observabilityPayload(event: AgentEvent): Record<string, unknown> {
  return event.observability ? {
    phase: event.observability.phase,
    ...(event.observability.cycle ? { cycle: event.observability.cycle } : {}),
    ...(event.observability.activeChild ? { activeChild: event.observability.activeChild } : {}),
    ...(event.observability.reviewerRoles ? { reviewerRoles: [...event.observability.reviewerRoles] } : {}),
    ...(event.observability.latestArtifacts ? { latestArtifacts: event.observability.latestArtifacts } : {}),
    ...(event.observability.remainingRemediationCycles !== undefined ? { remainingRemediationCycles: event.observability.remainingRemediationCycles } : {}),
  } : {};
}

function safeToolArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const input = args as Record<string, unknown>;
  const keys = ["path", "file_path", "pattern", "query", "glob", "command", "offset", "limit"];
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = value;
  }
  return Object.keys(output).length ? output : undefined;
}

function safeArgs(args: readonly string[]): string[] {
  return args.map((arg) => arg.length > 256 ? `${arg.slice(0, 255)}…` : arg).slice(0, 64);
}
