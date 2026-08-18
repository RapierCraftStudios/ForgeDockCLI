// SPDX-License-Identifier: AGPL-3.0-or-later

import { join } from "node:path";
import { DEFAULT_OBSERVATION_RETENTION, createObservationProducer, normalizeObservationDraft, observationStreamKey, retainObservationLogicalStreamId, type ObservationDraft, type ObservationEnvelopeV1, type ObservationLayoutStore, type ObservationQuery, type ObservationRedactionPolicy, type ObservationRetentionPolicy, type ObservationSink, type ObservationStore, type ObservationSubscription } from "./contracts.js";
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
  #quarantinedStreams = new Set<string>();
  #dropWaiters: Array<{ resolve: (event: ObservationEnvelopeV1) => void; reject: (error: unknown) => void }> = [];
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

    // Resolve and retain the output identity before queue accounting. The
    // same object is then carried into normalization, quarantine, and markers.
    let resolvedInput = input;
    let streamKey: string | undefined;
    if (input.output) {
      try {
        const identity = retainObservationLogicalStreamId(input.identity);
        resolvedInput = { ...input, identity };
        streamKey = observationStreamKey(identity, input.output.channel);
      } catch (error) {
        return Promise.reject(error);
      }
    }

    if (this.#pending >= this.#maxQueueDepth) {
      this.#droppedEvents += 1;
      if (streamKey) this.#quarantinedStreams.add(streamKey);
      if (!this.#droppedInput) {
        const { output: _output, ...withoutOutput } = resolvedInput;
        this.#droppedInput = {
          ...withoutOutput,
          payload: { reason: "Output payload omitted after observer backpressure" },
        };
      }
      const dropped = new Promise<ObservationEnvelopeV1>((resolve, reject) => this.#dropWaiters.push({ resolve, reject }));
      this.scheduleDropMarker();
      return dropped;
    }
    this.#pending += 1;
    const quarantined = streamKey !== undefined && this.#quarantinedStreams.has(streamKey);
    const draft = normalizeObservationDraft({
      ...quarantined ? quarantinedDraft(resolvedInput) : resolvedInput,
      producer: resolvedInput.producer ?? this.#producer,
    }, this.#redaction);
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
    this.#store.close();
  }

  get producer(): ReturnType<typeof createObservationProducer> {
    return this.#producer;
  }

  private layoutStore(): ObservationLayoutStore {
    if (isObservationLayoutStore(this.#store)) return this.#store;
    throw new Error("The configured observation store does not support workspace layouts");
  }

  private appendAndProject(draft: ObservationDraft): Promise<ObservationEnvelopeV1> {
    return this.#store.append(draft).then((event) => {
      this.#projector.apply(event);
      if (isObservationStreamReset(event.kind) && event.identity.logicalStreamId) {
        // Reset/terminal events use the ID retained at the output boundary;
        // mutable labels are never consulted for lifecycle cleanup.
        this.#quarantinedStreams.delete(observationStreamKey(event.identity, "stdout"));
        this.#quarantinedStreams.delete(observationStreamKey(event.identity, "stderr"));
      }
      for (const listener of this.#listeners) {
        try { listener(event); } catch { /* observers cannot break the producer */ }
      }
      return event;
    });
  }

  private scheduleDropMarker(): void {
    if (this.#dropScheduled) return;
    this.#dropScheduled = true;
    let markerStarted = false;
    let markerWaiters: Array<{ resolve: (event: ObservationEnvelopeV1) => void; reject: (error: unknown) => void }> = [];
    const result = this.#queue.then(async () => {
      markerStarted = true;
      // Capture this batch before appending. Drops arriving while the marker
      // is in flight belong to the next marker, not to this one's waiters.
      markerWaiters = this.#dropWaiters.splice(0);
      const input = this.#droppedInput;
      const droppedEvents = this.#droppedEvents;
      this.#droppedInput = undefined;
      this.#droppedEvents = 0;
      try {
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
        for (const waiter of markerWaiters) waiter.resolve(event);
        return event;
      } catch (error) {
        for (const waiter of markerWaiters) waiter.reject(error);
        throw error;
      } finally {
        this.#dropScheduled = false;
        if (this.#droppedInput) this.scheduleDropMarker();
      }
    });
    this.#queue = result.catch((error) => {
      // If the queue rejected before the marker callback could capture its
      // batch, reject those waiters here; otherwise the callback already did.
      if (!markerStarted) {
        this.#dropScheduled = false;
        const waiters = this.#dropWaiters.splice(0);
        for (const waiter of waiters) waiter.reject(error);
        if (this.#droppedInput) this.scheduleDropMarker();
      }
      return undefined;
    });
  }
}

function quarantinedDraft(input: ObservationDraft): ObservationDraft {
  const text = "[output quarantined after backpressure drop]";
  const payload = input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
    ? { ...(input.payload as Record<string, unknown>), text }
    : { text };
  return {
    ...input,
    payload,
    ...(input.output ? { output: { ...input.output, text } } : {}),
    delivery: { ...(input.delivery ?? {}), truncated: true },
    security: { ...(input.security ?? {}), redacted: true },
  };
}

function isObservationStreamReset(kind: string): boolean {
  return /(?:session\.(?:completed|failed|cancelled)|process\.(?:exited|failed)|controller\.(?:completed|failed))$/i.test(kind);
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
