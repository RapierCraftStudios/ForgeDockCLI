// SPDX-License-Identifier: AGPL-3.0-or-later

import { join } from "node:path";
import { DEFAULT_OBSERVATION_RETENTION, createObservationProducer, createTerminalTextSanitizer, normalizeObservationDraft, observationOutputStreamKey, observationOutputStreamPrefix, sanitizeObservationOutput, type ObservationDraft, type ObservationEnvelopeV1, type ObservationLayoutStore, type ObservationQuery, type ObservationRedactionPolicy, type ObservationRetentionPolicy, type ObservationSink, type ObservationStore, type ObservationSubscription } from "./contracts.js";
import { ObservationProjector, type ObservationProjectionSnapshot } from "./projections.js";
import type { WorkspaceLayout } from "./workspace-layout.js";
import { SqliteObservationStore } from "./sqlite-store.js";

export interface ForgeDockObserverOptions {
  store?: ObservationStore;
  component?: string;
  producer?: ReturnType<typeof createObservationProducer>;
  retention?: ObservationRetentionPolicy;
  redaction?: ObservationRedactionPolicy;
  /** Maximum number of events waiting for the journal before a drop marker is emitted. */
  maxQueueDepth?: number;
}

export type ObservationListener = (event: ObservationEnvelopeV1) => void;

/**
 * Renderer-neutral observation runtime. The journal and projection are
 * operational state; this class never performs workflow mutations.
 */
export class ForgeDockObserver implements ObservationSink {
  readonly #store: ObservationStore;
  readonly #projector = new ObservationProjector();
  readonly #listeners = new Set<ObservationListener>();
  readonly #producer: ReturnType<typeof createObservationProducer>;
  readonly #maxQueueDepth: number;
  readonly #redaction: ObservationRedactionPolicy;
  #queue: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #droppedEvents = 0;
  #droppedInput: ObservationDraft | undefined;
  #dropScheduled = false;
  #dropWaiters: Array<{ resolve: (event: ObservationEnvelopeV1) => void; reject: (error: unknown) => void }> = [];
  readonly #outputSanitizers = new Map<string, ReturnType<typeof createTerminalTextSanitizer>>();
  #closed = false;

  constructor(options: ForgeDockObserverOptions = {}) {
    this.#store = options.store ?? new SqliteObservationStore(":memory:");
    this.#producer = options.producer ?? createObservationProducer(options.component ?? "forgedock-observer");
    this.#maxQueueDepth = Math.max(1, Math.floor(options.maxQueueDepth ?? 2_048));
    this.#redaction = { ...(options.redaction ?? {}) };
  }

  async hydrate(query: ObservationQuery = {}): Promise<void> {
    const events = await this.#store.query(query);
    this.#projector.clear();
    for (const event of events.sort((left, right) => left.ingestedAt.localeCompare(right.ingestedAt) || left.runSequence - right.runSequence)) this.#projector.apply(event);
  }

  emit(input: ObservationDraft): Promise<ObservationEnvelopeV1> {
    if (this.#closed) return Promise.reject(new Error("ForgeDock observer is closed"));
    if (this.#pending >= this.#maxQueueDepth) {
      // A dropped chunk is a stream gap; never let parser state bridge it.
      this.resetOutputStream(input, true);
      this.#droppedEvents += 1;
      this.#droppedInput ??= input;
      const dropped = new Promise<ObservationEnvelopeV1>((resolve, reject) => this.#dropWaiters.push({ resolve, reject }));
      this.scheduleDropMarker();
      return dropped;
    }
    this.#pending += 1;
    const preparedInput = this.prepareInput({
      ...input,
      producer: input.producer ?? this.#producer,
    });
    const draft = normalizeObservationDraft(preparedInput, this.#redaction);
    const result = this.#queue.then(async () => this.appendAndProject(draft)).finally(() => {
      this.#pending -= 1;
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }

  subscribe(listener: ObservationListener): ObservationSubscription {
    this.#listeners.add(listener);
    return { unsubscribe: () => this.#listeners.delete(listener) };
  }

  snapshot(): ObservationProjectionSnapshot {
    return this.#projector.snapshot();
  }

  query(query: ObservationQuery = {}): Promise<ObservationEnvelopeV1[]> {
    return this.#store.query(query);
  }

  async flush(): Promise<void> {
    await this.#queue;
  }

  async prune(scopeKey: string | undefined, policy: Parameters<ObservationStore["prune"]>[1]): Promise<Awaited<ReturnType<ObservationStore["prune"]>>> {
    await this.flush();
    return this.#store.prune(scopeKey, policy);
  }

  saveLayout(layout: WorkspaceLayout): Promise<void> {
    return this.layoutStore().saveLayout(layout);
  }

  loadLayout(id: string): Promise<WorkspaceLayout | undefined> {
    return this.layoutStore().loadLayout(id);
  }

  close(): void {
    this.#closed = true;
    this.#listeners.clear();
    for (const sanitizer of this.#outputSanitizers.values()) sanitizer.finish();
    this.#outputSanitizers.clear();
    this.#store.close();
  }

  get producer(): ReturnType<typeof createObservationProducer> {
    return this.#producer;
  }

  private prepareInput(input: ObservationDraft): ObservationDraft {
    const key = observationOutputStreamKey(input);
    if (!key) {
      this.resetOutputStream(input);
      return input;
    }
    let sanitizer = this.#outputSanitizers.get(key);
    if (!sanitizer) {
      sanitizer = createTerminalTextSanitizer();
      this.#outputSanitizers.set(key, sanitizer);
    }
    const prepared = sanitizeObservationOutput(input, sanitizer);
    if (isTerminalObservationKind(input.kind)) {
      sanitizer.finish();
      this.#outputSanitizers.delete(key);
    }
    return prepared;
  }

  private resetOutputStream(input: ObservationDraft, discard = false): void {
    const key = observationOutputStreamKey(input);
    if (key) {
      const sanitizer = this.#outputSanitizers.get(key);
      if (sanitizer) {
        finishOutputSanitizer(sanitizer, discard, discard ? input.output?.text : undefined);
        if (!discard) this.#outputSanitizers.delete(key);
      }
      return;
    }
    const prefix = observationOutputStreamPrefix(input);
    for (const [streamKey, sanitizer] of this.#outputSanitizers) {
      if (streamKey.startsWith(prefix)) {
        finishOutputSanitizer(sanitizer, discard);
        if (!discard) this.#outputSanitizers.delete(streamKey);
      }
    }
  }

  private layoutStore(): ObservationLayoutStore {
    if (isObservationLayoutStore(this.#store)) return this.#store;
    throw new Error("The configured observation store does not support workspace layouts");
  }

  private appendAndProject(draft: ObservationDraft): Promise<ObservationEnvelopeV1> {
    return this.#store.append(draft).then((event) => {
      this.#projector.apply(event);
      for (const listener of this.#listeners) {
        try { listener(event); } catch { /* observers cannot break the producer */ }
      }
      return event;
    });
  }

  private scheduleDropMarker(): void {
    if (this.#dropScheduled) return;
    this.#dropScheduled = true;
    const result = this.#queue.then(async () => {
      const input = this.#droppedInput;
      const droppedEvents = this.#droppedEvents;
      this.#droppedInput = undefined;
      this.#droppedEvents = 0;
      this.#dropScheduled = false;
      if (!input) throw new Error("Observer backpressure marker lost its source context");
      const { output: _output, ...inputWithoutOutput } = input;
      const marker = normalizeObservationDraft({
        ...inputWithoutOutput,
        producer: input.producer ?? this.#producer,
        channel: "diagnostic",
        kind: "output.dropped",
        severity: "warning",
        payload: { reason: "Observer queue depth exceeded its bounded capacity", droppedEvents },
        delivery: { ...(input.delivery ?? {}), droppedEvents },
      }, this.#redaction);
      const event = await this.appendAndProject(marker);
      const waiters = this.#dropWaiters.splice(0);
      for (const waiter of waiters) waiter.resolve(event);
      return event;
    });
    this.#queue = result.catch((error) => {
      this.#dropScheduled = false;
      const waiters = this.#dropWaiters.splice(0);
      for (const waiter of waiters) waiter.reject(error);
      return undefined;
    });
  }
}

function finishOutputSanitizer(sanitizer: ReturnType<typeof createTerminalTextSanitizer>, discard: boolean, droppedText?: string): void {
  if (discard && sanitizer.discard) sanitizer.discard(droppedText);
  else sanitizer.finish();
}

function isTerminalObservationKind(kind: string): boolean {
  return /(?:^|\.)(?:completed|failed|cancelled|canceled|exited|finished)$/.test(kind);
}

function isObservationLayoutStore(store: ObservationStore): store is ObservationStore & ObservationLayoutStore {
  return typeof (store as Partial<ObservationLayoutStore>).saveLayout === "function"
    && typeof (store as Partial<ObservationLayoutStore>).loadLayout === "function";
}

export async function createForgeDockObserver(cwd: string, options: Omit<ForgeDockObserverOptions, "store"> = {}): Promise<ForgeDockObserver> {
  const observer = new ForgeDockObserver({
    ...options,
    store: new SqliteObservationStore(join(cwd, ".forgedock", "observations.db")),
  });
  await observer.hydrate({ limit: 5_000 });
  await observer.prune(undefined, options.retention ?? DEFAULT_OBSERVATION_RETENTION);
  return observer;
}
