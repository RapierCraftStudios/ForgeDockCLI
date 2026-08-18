// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentEvent, AgentEventSink } from "../runtime/agent-runtime.js";
import { createObservationLogicalStreamId, createObservationProducer, createStreamingObservationText, type ObservationDraft, type ObservationIdentity, type ObservationSink, type ObservationSeverity, type StreamingObservationText } from "./contracts.js";

export interface ObservationAdapterContext {
  identity?: ObservationIdentity;
  /** Mutable identity holder; enrichment never reallocates stream identity. */
  identityRef?: { current: ObservationIdentity };
  /** Optional ID for callers that own exactly one logical stream. */
  logicalStreamId?: string;
  producer?: ReturnType<typeof createObservationProducer>;
}

export function createAgentEventObservationSink(observer: ObservationSink, context: ObservationAdapterContext = {}): AgentEventSink {
  let outputSequence = 0;
  const producer = context.producer ?? createObservationProducer("agent-runtime");
  const underlyingObserver = observer;
  observer = { emit: (draft) => underlyingObserver.emit(draft).catch(() => undefined as never) };
  const streams = new Map<string, StreamingObservationText>();
  const logicalStreamIds = new Map<string, string>();
  const logicalStreamIdFor = (event: AgentEvent): string => {
    const existing = logicalStreamIds.get(event.taskId);
    if (existing) return existing;
    const supplied = context.logicalStreamId ?? context.identityRef?.current.logicalStreamId ?? context.identity?.logicalStreamId;
    const logicalStreamId = supplied && logicalStreamIds.size === 0 ? supplied : createObservationLogicalStreamId();
    logicalStreamIds.set(event.taskId, logicalStreamId);
    return logicalStreamId;
  };
  const identityFor = (event: AgentEvent): ObservationIdentity => ({
    ...(context.identityRef?.current ?? context.identity ?? {}),
    logicalStreamId: logicalStreamIdFor(event),
    agentTaskId: event.taskId,
    ...(event.observability?.activeChild ? { parentAgentId: event.observability.activeChild } : {}),
  });
  const streamKey = (event: AgentEvent): string => logicalStreamIdFor(event);
  const emitOutput = (event: AgentEvent, text: string): void => {
    if (!text) return;
    outputSequence += 1;
    const identity = identityFor(event);
    void observer.emit({
      producer,
      identity,
      source: "agent",
      channel: "activity",
      kind: "output.delta",
      payload: { summary: "Assistant output", text },
      output: { channel: "stdout", text, chunkSequence: outputSequence },
    });
  };
  const flush = (event: AgentEvent): void => {
    const key = streamKey(event);
    const stream = streams.get(key);
    if (!stream) return;
    emitOutput(event, stream.finish());
    streams.delete(key);
  };
  return (event: AgentEvent) => {
    const identity = identityFor(event);
    const base = {
      producer,
      identity,
      source: "agent" as const,
    };
    if (event.type === "thinking.delta") {
      flush(event);
      void observer.emit({ ...base, channel: "activity", kind: "activity.changed", severity: "debug", payload: { activity: "thinking", summary: "Model activity" } });
      return;
    }
    if (event.type === "text.delta") {
      const key = streamKey(event);
      const stream = streams.get(key) ?? createStreamingObservationText();
      streams.set(key, stream);
      emitOutput(event, stream.push(event.text));
      return;
    }
    flush(event);
    if (event.type === "session.started") {
      void observer.emit({ ...base, identity: { ...identity, piSessionRef: event.sessionRef }, channel: "lifecycle", kind: "agent.session.started", payload: { provider: event.provider, model: event.model, ...observabilityPayload(event) } });
      return;
    }
    if (event.type === "session.progress") {
      void observer.emit({ ...base, identity: { ...identity, piSessionRef: event.sessionRef }, channel: "activity", kind: "agent.session.progress", severity: "debug", payload: observabilityPayload(event) });
      return;
    }
    if (event.type === "tool.started") {
      void observer.emit({ ...base, channel: "tool", kind: "tool.started", payload: { tool: event.tool, toolCallId: event.toolCallId, args: safeToolArgs(event.args), ...observabilityPayload(event) } });
      return;
    }
    if (event.type === "tool.progress") {
      void observer.emit({ ...base, channel: "tool", kind: "tool.progress", severity: "debug", payload: { tool: event.tool, toolCallId: event.toolCallId, elapsedMs: event.elapsedMs, timeoutMs: event.timeoutMs, ...observabilityPayload(event) } });
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
    const terminal = event.type === "session.completed"
      ? { kind: "agent.session.completed", severity: "info" as const, payload: observabilityPayload(event) }
      : event.type === "session.failed"
        ? { kind: "agent.session.failed", severity: "error" as const, payload: { summary: event.errorSummary, ...observabilityPayload(event) } }
        : { kind: "agent.session.cancelled", severity: "warning" as const, payload: { summary: event.errorSummary, ...observabilityPayload(event) } };
    void observer.emit({
      ...base,
      identity: { ...identity, piSessionRef: event.sessionRef },
      channel: "lifecycle",
      kind: terminal.kind,
      severity: terminal.severity,
      payload: terminal.payload,
    });
    logicalStreamIds.delete(event.taskId);
  };
}

export class ControllerObservationAdapter {
  readonly #observer: ObservationSink;
  readonly #context: ObservationAdapterContext;
  readonly #logicalStreamId: string;
  #outputSequence = 0;

  constructor(observer: ObservationSink, context: ObservationAdapterContext = {}) {
    this.#observer = observer;
    this.#context = context;
    this.#logicalStreamId = context.logicalStreamId
      ?? context.identity?.logicalStreamId
      ?? context.identityRef?.current.logicalStreamId
      ?? createObservationLogicalStreamId();
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
      identity: {
        ...(this.#context.identityRef?.current ?? this.#context.identity ?? {}),
        logicalStreamId: this.#logicalStreamId,
      },
      source: "controller",
      channel,
      kind,
      severity,
      payload,
      ...(output ? { output } : {}),
      ...(delivery ? { delivery } : {}),
    }).catch(() => undefined);
  }
}

export class BackgroundTaskObservationAdapter {
  readonly #observer: ObservationSink;
  readonly #producer: ReturnType<typeof createObservationProducer>;
  readonly #streams = new Map<string, Map<"stdout" | "stderr", StreamingObservationText>>();
  readonly #logicalStreamIds = new Map<string, string>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #finished = new Map<string, Promise<void>>();

  constructor(observer: ObservationSink, producer = createObservationProducer("forgedock-background-task")) {
    this.#observer = observer;
    this.#producer = producer;
  }

  started(task: { id: string; command: string; args: readonly string[]; cwd: string; pid: number }): void {
    this.streamIdFor(task.id);
    this.emit(task.id, "process.started", "info", { command: task.command, args: safeArgs(task.args), cwd: task.cwd, pid: task.pid });
  }

  adopted(taskId: string, pid: number): void {
    this.emit(taskId, "process.adopted", "notice", { pid, summary: "Controller adopted after terminal restart" });
  }

  output(taskId: string, channel: "stdout" | "stderr", text: string, chunkSequence: number): Promise<void> {
    if (!text || this.#finished.has(taskId)) return Promise.resolve();
    return this.enqueue(taskId, async () => {
      const stream = this.streamFor(taskId, channel);
      const sanitized = stream.push(text);
      if (!sanitized) return;
      await this.emitOutput(taskId, channel, sanitized, text, chunkSequence, stream);
    });
  }

  finished(taskId: string, status: string, exitCode?: number): Promise<void> {
    const existing = this.#finished.get(taskId);
    if (existing) return existing;
    const completion = this.enqueue(taskId, async () => {
      const logicalStreamId = this.streamIdFor(taskId);
      try {
        const streams = this.#streams.get(logicalStreamId);
        if (streams) {
          for (const channel of ["stdout", "stderr"] as const) {
            const stream = streams.get(channel);
            if (!stream) continue;
            const tail = stream.finish();
            if (tail) await this.emitOutput(taskId, channel, tail, tail, undefined, stream);
          }
        }
        await this.emitLifecycle(taskId, status === "completed" ? "process.exited" : "process.failed", status === "completed" ? "info" : "error", { status, ...(exitCode !== undefined ? { exitCode } : {}) });
      } finally {
        this.#streams.delete(logicalStreamId);
        this.#logicalStreamIds.delete(taskId);
        this.#queues.delete(taskId);
      }
    });
    this.#finished.set(taskId, completion);
    return completion;
  }

  /** Discard parser state when an adopted process disappears without a semantic result. */
  discarded(taskId: string): Promise<void> {
    const existing = this.#finished.get(taskId);
    if (existing) return existing;
    const completion = this.enqueue(taskId, async () => {
      this.#streams.delete(this.streamIdFor(taskId));
      this.#logicalStreamIds.delete(taskId);
      this.#queues.delete(taskId);
    });
    this.#finished.set(taskId, completion);
    return completion;
  }

  private streamIdFor(taskId: string): string {
    const existing = this.#logicalStreamIds.get(taskId);
    if (existing) return existing;
    const logicalStreamId = createObservationLogicalStreamId();
    this.#logicalStreamIds.set(taskId, logicalStreamId);
    return logicalStreamId;
  }

  private streamFor(taskId: string, channel: "stdout" | "stderr"): StreamingObservationText {
    const logicalStreamId = this.streamIdFor(taskId);
    let streams = this.#streams.get(logicalStreamId);
    if (!streams) {
      streams = new Map();
      this.#streams.set(logicalStreamId, streams);
    }
    let stream = streams.get(channel);
    if (!stream) {
      stream = createStreamingObservationText();
      streams.set(channel, stream);
    }
    return stream;
  }

  private enqueue(taskId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(taskId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#queues.set(taskId, current);
    return current;
  }

  private async emitOutput(taskId: string, channel: "stdout" | "stderr", text: string, sourceText: string, chunkSequence: number | undefined, stream: StreamingObservationText): Promise<void> {
    try {
      const result = await this.#observer.emit({
        producer: this.#producer,
        identity: { logicalStreamId: this.streamIdFor(taskId), controllerTaskId: taskId },
        source: "process",
        channel,
        kind: channel === "stdout" ? "output.stdout" : "output.stderr",
        payload: { bytes: Buffer.byteLength(sourceText, "utf8") },
        output: { channel, text, ...(chunkSequence === undefined ? {} : { chunkSequence }) },
      });
      if (result.kind === "output.dropped") stream.markDropped();
    } catch {
      stream.markDropped();
    }
  }

  private async emitLifecycle(taskId: string, kind: string, severity: ObservationSeverity, payload: unknown): Promise<void> {
    try {
      await this.#observer.emit({ producer: this.#producer, identity: { logicalStreamId: this.streamIdFor(taskId), controllerTaskId: taskId }, source: "process", channel: "lifecycle", kind, severity, payload });
    } catch {
      // Lifecycle delivery failures must not retain parser state or block task cleanup.
    }
  }

  private emit(taskId: string, kind: string, severity: ObservationSeverity, payload: unknown): void {
    void this.emitLifecycle(taskId, kind, severity, payload);
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
