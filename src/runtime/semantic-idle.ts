// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  AgentExecutionInterruptedError,
  AgentRunError,
  type AgentEvent,
  type AgentEventSink,
  type AgentRunResult,
  type AgentRuntime,
  type AgentTask,
} from "./agent-runtime.js";

/** The existing controller warning is 120s; this is an idle bound, not a run lifetime. */
export const DEFAULT_SEMANTIC_IDLE_MS = 120_000;
export const MAX_SEMANTIC_IDLE_MS = 60 * 60 * 1000;
export const DEFAULT_INTERRUPT_DRAIN_MS = 15_000;
export const MAX_INTERRUPT_DRAIN_MS = 60_000;

export interface SemanticIdleClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: SemanticIdleClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Events which prove that the provider is still doing useful semantic work. */
export function isSemanticProgressEvent(event: AgentEvent): boolean {
  return event.type === "thinking.delta"
    || event.type === "text.delta"
    || event.type === "tool.started"
    || event.type === "tool.completed"
    || event.type === "artifact.submitted";
}

export function validateSemanticIdleMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SEMANTIC_IDLE_MS) {
    throw new Error(`Semantic idle timeout must be an integer from 1 to ${MAX_SEMANTIC_IDLE_MS}`);
  }
  return value;
}

function validateInterruptDrainMs(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INTERRUPT_DRAIN_MS) {
    throw new Error(`Agent interruption drain timeout must be an integer from 1 to ${MAX_INTERRUPT_DRAIN_MS}`);
  }
  return value;
}

/**
 * A watchdog keyed to semantic activity. It deliberately has no total-run
 * timer: each meaningful agent event moves the deadline forward.
 */
export class SemanticIdleWatchdog {
  readonly #idleMs: number;
  readonly #clock: SemanticIdleClock;
  readonly #onIdle: (lastProgressAt: number) => void;
  #timer: unknown;
  #stopped = false;
  #fired = false;
  #lastProgressAt: number;

  constructor(input: {
    idleMs: number;
    clock?: SemanticIdleClock;
    onIdle: (lastProgressAt: number) => void;
  }) {
    this.#idleMs = validateSemanticIdleMs(input.idleMs);
    this.#clock = input.clock ?? systemClock;
    this.#onIdle = input.onIdle;
    this.#lastProgressAt = this.#clock.now();
    this.schedule();
  }

  get lastProgressAt(): number { return this.#lastProgressAt; }
  get fired(): boolean { return this.#fired; }

  markProgress(event?: AgentEvent): void {
    if (this.#stopped || this.#fired) return;
    if (event !== undefined && !isSemanticProgressEvent(event)) return;
    this.#lastProgressAt = this.#clock.now();
    this.schedule();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  private schedule(): void {
    if (this.#stopped || this.#fired) return;
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    const elapsed = Math.max(0, this.#clock.now() - this.#lastProgressAt);
    const delay = Math.max(1, this.#idleMs - elapsed);
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      if (this.#stopped || this.#fired) return;
      const remaining = this.#idleMs - (this.#clock.now() - this.#lastProgressAt);
      if (remaining > 0) {
        this.schedule();
        return;
      }
      this.#fired = true;
      this.#onIdle(this.#lastProgressAt);
    }, delay);
  }
}

/**
 * Runtime wrapper used by CLI-owned provider calls. A frozen attempt is
 * interrupted, cleaned up, then gets exactly one fresh/resumable retry. A
 * second idle interruption is returned to the workflow as a recoverable
 * checkpoint instead of being mislabeled as a semantic failure.
 */
export class LivenessRecoveringAgentRuntime implements AgentRuntime {
  readonly #inner: AgentRuntime;
  readonly #idleMs: number;
  readonly #retryLimit: number;
  readonly #drainMs: number;
  readonly #clock: SemanticIdleClock;

  constructor(
    inner: AgentRuntime,
    options: {
      idleMs?: number;
      retryLimit?: number;
      drainMs?: number;
      clock?: SemanticIdleClock;
    } = {},
  ) {
    this.#inner = inner;
    this.#idleMs = validateSemanticIdleMs(options.idleMs ?? DEFAULT_SEMANTIC_IDLE_MS);
    const retryLimit = options.retryLimit ?? 1;
    if (!Number.isSafeInteger(retryLimit) || retryLimit < 0 || retryLimit > 1) {
      throw new Error("Semantic idle retryLimit must be 0 or 1");
    }
    this.#retryLimit = retryLimit;
    this.#drainMs = validateInterruptDrainMs(options.drainMs ?? DEFAULT_INTERRUPT_DRAIN_MS);
    this.#clock = options.clock ?? systemClock;
  }

  capabilities(): Promise<import("./agent-runtime.js").RuntimeCapabilities> { return this.#inner.capabilities(); }

  preflight(options?: import("./agent-runtime.js").RuntimePreflightOptions): Promise<import("./agent-runtime.js").RuntimePreflightResult> {
    if (!this.#inner.preflight) return Promise.reject(new Error("Agent runtime does not support preflight"));
    return this.#inner.preflight(options);
  }

  async run<T>(task: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
    return this.execute(task, options, undefined);
  }

  async resume<T>(sessionRef: string, task: AgentTask<T>, options: { signal?: AbortSignal; onEvent?: AgentEventSink } = {}): Promise<AgentRunResult<T>> {
    if (!this.#inner.resume) throw new AgentExecutionInterruptedError("Agent runtime cannot resume the interrupted session", { reason: "process-tree", sessionRef, resumable: false });
    return this.execute(task, options, sessionRef);
  }

  interrupt(taskId: string, reason?: unknown): void {
    try {
      void Promise.resolve(this.#inner.interrupt?.(taskId, reason)).catch(() => undefined);
    } catch {
      // Cleanup is best-effort; preserve the typed interruption for the
      // workflow checkpoint even if a runtime-specific terminator fails.
    }
  }

  close(): Promise<void> { return this.#inner.close(); }

  private async execute<T>(
    task: AgentTask<T>,
    options: { signal?: AbortSignal; onEvent?: AgentEventSink },
    sessionRef: string | undefined,
  ): Promise<AgentRunResult<T>> {
    let lastError: unknown;
    let resumeRef = sessionRef;
    const retryLimit = task.role === "reviewer" || task.role === "adjudicator" ? 0 : this.#retryLimit;
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      try {
        if (resumeRef !== undefined && this.#inner.resume) {
          return await this.runAttempt(task, options, (signal, onEvent) => this.#inner.resume!(resumeRef!, task, { signal, onEvent }));
        }
        return await this.runAttempt(task, options, (signal, onEvent) => this.#inner.run(task, { signal, onEvent }));
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted || !(error instanceof AgentExecutionInterruptedError) || error.drainExpired || attempt >= retryLimit) throw error;
        resumeRef = error.resumable ? error.sessionRef : undefined;
      }
    }
    throw lastError ?? new Error(`Agent ${task.id} ended without a result`);
  }

  private async runAttempt<T>(
    task: AgentTask<T>,
    options: { signal?: AbortSignal; onEvent?: AgentEventSink },
    operation: (signal: AbortSignal, onEvent: AgentEventSink) => Promise<AgentRunResult<T>>,
  ): Promise<AgentRunResult<T>> {
    let observedSessionRef: string | undefined;
    let interruptError: AgentExecutionInterruptedError | undefined;
    let externalError: unknown;
    let rejectIdle!: (error: AgentExecutionInterruptedError) => void;
    let rejectExternal!: (error: unknown) => void;
    const idle = new Promise<never>((_, reject) => { rejectIdle = reject; });
    const externalAbort = new Promise<never>((_, reject) => { rejectExternal = reject; });
    const controller = new AbortController();
    const abortFromCaller = () => {
      const reason = options.signal?.reason ?? new Error("Agent run aborted");
      externalError = reason;
      controller.abort(reason);
      this.interrupt(task.id, reason);
      rejectExternal(reason);
    };
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();
    const watchdog = new SemanticIdleWatchdog({
      idleMs: this.#idleMs,
      clock: this.#clock,
      onIdle: (lastProgressAt) => {
        interruptError = new AgentExecutionInterruptedError(
          `Agent ${task.id} interrupted after ${this.#idleMs}ms without semantic progress`,
          {
            reason: "semantic-idle",
            idleMs: this.#idleMs,
            lastProgressAt,
            ...(observedSessionRef !== undefined ? { sessionRef: observedSessionRef } : {}),
          },
        );
        controller.abort(interruptError);
        this.interrupt(task.id, interruptError);
        rejectIdle(interruptError);
      },
    });
    const emit: AgentEventSink = (event) => {
      if (event.type === "session.started" && event.taskId === task.id) observedSessionRef = event.sessionRef;
      watchdog.markProgress(event);
      options.onEvent?.(event);
    };
    const operationResult = Promise.resolve().then(() => operation(controller.signal, emit));
    try {
      return await Promise.race([operationResult, idle, externalAbort]);
    } catch (error) {
      if (interruptError) {
        const settled = await this.drain(operationResult);
        if (settled.status === "drain-expired") {
          void operationResult.catch(() => undefined);
          throw new AgentExecutionInterruptedError(interruptError.message, {
            reason: interruptError.reason,
            ...(interruptError.idleMs !== undefined ? { idleMs: interruptError.idleMs } : {}),
            ...(interruptError.lastProgressAt !== undefined ? { lastProgressAt: interruptError.lastProgressAt } : {}),
            ...(interruptError.sessionRef !== undefined ? { sessionRef: interruptError.sessionRef } : {}),
            drainExpired: true,
            drainMs: this.#drainMs,
            cause: interruptError,
          });
        }
        if (settled.status === "fulfilled") {
          if (externalError !== undefined) throw externalError;
          return settled.value;
        }
        const drainedError = settled.status === "rejected" ? settled.reason : undefined;
        if (drainedError instanceof AgentRunError) {
          // Keep a late session identity useful to a resumable runtime while
          // retaining the typed interrupted classification.
          const recoveredSessionRef = drainedError.sessionRef ?? observedSessionRef;
          throw new AgentExecutionInterruptedError(interruptError.message, {
            reason: interruptError.reason,
            ...(interruptError.idleMs !== undefined ? { idleMs: interruptError.idleMs } : {}),
            ...(interruptError.lastProgressAt !== undefined ? { lastProgressAt: interruptError.lastProgressAt } : {}),
            ...(recoveredSessionRef !== undefined ? { sessionRef: recoveredSessionRef } : {}),
            resumable: drainedError.resumable,
            ...(drainedError.execution !== undefined ? { execution: drainedError.execution } : {}),
            cause: drainedError,
          });
        }
        throw interruptError;
      }
      if (externalError !== undefined) {
        const settled = await this.drain(operationResult);
        if (settled.status === "drain-expired") {
          void operationResult.catch(() => undefined);
          throw new AgentExecutionInterruptedError(
            `Agent ${task.id} cancellation did not settle within the ${this.#drainMs}ms drain window`,
            { reason: "cancelled", drainExpired: true, drainMs: this.#drainMs, cause: externalError },
          );
        }
        // A cancelled call remains cancelled even if its provider eventually
        // returns a value; the late settlement is consumed by drain().
        throw externalError;
      }
      throw error;
    } finally {
      watchdog.stop();
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  private async drain<T>(operation: Promise<AgentRunResult<T>>): Promise<
    | { status: "fulfilled"; value: AgentRunResult<T> }
    | { status: "rejected"; reason: unknown }
    | { status: "drain-expired" }
  > {
    let timer: unknown;
    const settled = operation.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const expired = new Promise<{ status: "drain-expired" }>((resolve) => {
      timer = this.#clock.setTimeout(() => resolve({ status: "drain-expired" }), this.#drainMs);
    });
    const result = await Promise.race([settled, expired]);
    if (timer !== undefined) this.#clock.clearTimeout(timer);
    return result;
  }
}
