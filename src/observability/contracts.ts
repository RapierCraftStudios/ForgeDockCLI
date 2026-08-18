// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";

export const OBSERVATION_SCHEMA_VERSION = "forgedock.observation/v1" as const;
export const DEFAULT_OBSERVATION_MAX_STRING_BYTES = 8 * 1024;
export const DEFAULT_OBSERVATION_MAX_PAYLOAD_BYTES = 64 * 1024;
export const DEFAULT_OBSERVATION_MAX_OUTPUT_BYTES = 32 * 1024;
export const DEFAULT_OBSERVATION_RETENTION: ObservationRetentionPolicy = {
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  maxEventsPerScope: 20_000,
  maxOutputBytesPerScope: 64 * 1024 * 1024,
};

export type ObservationSource =
  | "workflow"
  | "controller"
  | "agent"
  | "reviewer"
  | "tool"
  | "process"
  | "artifact"
  | "pi-subagents"
  | "observer";

export type ObservationChannel =
  | "lifecycle"
  | "activity"
  | "stdout"
  | "stderr"
  | "tool"
  | "supervisor"
  | "decision"
  | "review"
  | "artifact"
  | "diagnostic";

export type ObservationSeverity = "debug" | "info" | "notice" | "warning" | "error" | "critical";
export type ObservationSensitivity = "public" | "internal" | "sensitive";

/** Canonical cross-process identity. Every adapter should populate all fields it knows. */
export interface ObservationIdentity {
  repository?: string;
  issueNumber?: number;
  forgeRunId?: string;
  orchestrationId?: string;
  workUnitId?: string;
  nodeId?: string;
  agentTaskId?: string;
  agentRole?: string;
  parentAgentId?: string;
  childIndex?: number;
  depth?: number;
  controllerTaskId?: string;
  piSessionRef?: string;
  piAsyncId?: string;
  checkpointId?: string;
  reviewId?: string;
  artifactId?: string;
}

export interface ObservationProducer {
  component: string;
  processInstanceId: string;
  pid?: number;
}

export interface ObservationDelivery {
  truncated?: boolean;
  droppedEvents?: number;
  originalBytes?: number;
  coalesced?: boolean;
}

export interface ObservationSecurity {
  redacted: boolean;
  sensitivity?: ObservationSensitivity;
}

export interface ObservationOutputChunk {
  channel: "stdout" | "stderr";
  text: string;
  chunkSequence: number;
  bytes: number;
}

export interface ObservationEnvelopeV1 {
  schemaVersion: typeof OBSERVATION_SCHEMA_VERSION;
  eventId: string;
  runSequence: number;
  producerSequence: number;
  occurredAt: string;
  ingestedAt: string;
  identity: ObservationIdentity;
  producer: ObservationProducer;
  source: ObservationSource;
  channel: ObservationChannel;
  kind: string;
  severity: ObservationSeverity;
  payload: unknown;
  delivery: ObservationDelivery;
  security: ObservationSecurity;
  output?: ObservationOutputChunk;
}

export interface ObservationDraft {
  identity?: ObservationIdentity;
  producer: ObservationProducer;
  source: ObservationSource;
  channel: ObservationChannel;
  kind: string;
  severity?: ObservationSeverity;
  payload?: unknown;
  occurredAt?: string;
  producerSequence?: number;
  delivery?: ObservationDelivery;
  security?: Partial<ObservationSecurity>;
  output?: {
    channel: "stdout" | "stderr";
    text: string;
    chunkSequence?: number;
  };
}

export interface ObservationQuery {
  scopeKey?: string;
  forgeRunId?: string;
  orchestrationId?: string;
  source?: ObservationSource;
  channel?: ObservationChannel;
  kinds?: readonly string[];
  sinceRunSequence?: number;
  limit?: number;
  newestFirst?: boolean;
}

export interface ObservationRetentionPolicy {
  maxAgeMs?: number;
  maxEventsPerScope?: number;
  maxOutputBytesPerScope?: number;
}

export interface ObservationRetentionResult {
  deletedEvents: number;
  deletedOutputChunks: number;
  remainingEvents: number;
}

export interface ObservationStore {
  append(draft: ObservationDraft): Promise<ObservationEnvelopeV1>;
  query(query?: ObservationQuery): Promise<ObservationEnvelopeV1[]>;
  prune(scopeKey: string | undefined, policy: ObservationRetentionPolicy): Promise<ObservationRetentionResult>;
  close(): void;
}

export interface ObservationLayoutStore {
  saveLayout(layout: import("./workspace-layout.js").WorkspaceLayout): Promise<void>;
  loadLayout(id: string): Promise<import("./workspace-layout.js").WorkspaceLayout | undefined>;
}

export interface ObservationSink {
  emit(draft: ObservationDraft): Promise<ObservationEnvelopeV1>;
}

export interface ObservationSubscription {
  unsubscribe(): void;
}

export interface ObservationRedactionPolicy {
  maxStringBytes?: number;
  maxPayloadBytes?: number;
  maxOutputBytes?: number;
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
}

export interface RedactedValue {
  value: unknown;
  redacted: boolean;
  originalBytes: number;
  outputBytes: number;
  truncated: boolean;
}

const SENSITIVE_KEY = /(?:authorization|api[-_]?key|credential|cookie|jwt|password|private[-_]?key|secret|token)/i;
const SENSITIVE_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/=-]+|gh[pousr]_\w+|sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/i;
const STREAM_SECRET_PATTERNS = [
  /bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /authorization\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gi,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
] as const;
const STREAM_HOLDBACK_LIMIT_BYTES = 16 * 1024;
const STREAM_SECRET_PREFIXES = ["bearer", "authorization", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "sk-", "-----BEGIN "];
const CREDENTIAL_ASSIGNMENT_KEY = /(?:--?(?:api[-_]?key|token|password|authorization|credential|cookie|jwt|private[-_]?key|secret)|api[-_]?key|token|password|authorization|credential|cookie|jwt|private[-_]?key|secret)/i;
const REDACTION_MARKER = /^\[REDACTED(?:[-_:][A-Za-z0-9_-]*)?\]$/i;

type TerminalParserState = "ground" | "escape" | "csi" | "osc" | "osc-escape" | "ss3";

/** Stateful, fail-closed sanitizer for output that arrives in arbitrary chunks. */
export class StreamingObservationText {
  #state: TerminalParserState = "ground";
  #holdback = "";
  #quarantined = false;

  push(value: string): string {
    if (!value || this.#quarantined) return "";
    const visible = this.consumeTerminal(value);
    if (!visible) return "";
    return this.flushSafe(visible);
  }

  /** Consume an input chunk without returning any text, then quarantine the stream. */
  discard(value: string): void {
    if (!this.#quarantined) this.#state = consumeTerminalText(value, this.#state).state;
    this.markDropped();
  }

  /** Backpressure may discard an incomplete control/secret sequence. */
  markDropped(): void {
    this.#quarantined = true;
    this.#state = "ground";
    this.#holdback = "";
  }

  reset(): void {
    this.#state = "ground";
    this.#holdback = "";
    this.#quarantined = false;
  }

  finish(): string {
    if (this.#quarantined) {
      this.reset();
      return "";
    }
    const tail = streamingSecretSuffixStart(this.#holdback) === undefined
      ? redactStreamingSecrets(this.#holdback)
      : "[REDACTED]";
    this.#holdback = "";
    this.#state = "ground";
    return tail;
  }

  get quarantined(): boolean { return this.#quarantined; }

  private flushSafe(value: string): string {
    const candidate = this.#holdback + value;
    const secretStart = streamingSecretSuffixStart(candidate);
    if (secretStart !== undefined) {
      const holdback = candidate.slice(secretStart);
      if (Buffer.byteLength(holdback, "utf8") > STREAM_HOLDBACK_LIMIT_BYTES) {
        this.markDropped();
        return "";
      }
      this.#holdback = holdback;
      return redactStreamingSecrets(candidate.slice(0, secretStart));
    }
    this.#holdback = "";
    return redactStreamingSecrets(candidate);
  }

  private consumeTerminal(value: string): string {
    const result = consumeTerminalText(value, this.#state);
    this.#state = result.state;
    return result.text;
  }
}

function consumeTerminalText(value: string, initialState: TerminalParserState): { text: string; state: TerminalParserState } {
  let output = "";
  let state = initialState;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (state === "ground") {
      if (code === 0x1b) state = "escape";
      else if (code === 0x9b) state = "csi";
      else if (code === 0x9d) state = "osc";
      else if (code === 0x8f) state = "ss3";
      else if (code === 0x9c) continue;
      else if (code === 0x0a || code === 0x0d || code === 0x09 || (code >= 0x20 && !(code >= 0x80 && code <= 0x9f))) output += character;
      continue;
    }
    if (state === "escape") {
      if (character === "[") state = "csi";
      else if (character === "]") state = "osc";
      else if (character === "O") state = "ss3";
      else state = "ground";
      continue;
    }
    if (state === "csi" || state === "ss3") {
      if (code === 0x9c) state = "ground";
      else if (code >= 0x40 && code <= 0x7e) state = "ground";
      else if (code === 0x1b) state = "escape";
      continue;
    }
    if (state === "osc") {
      if (code === 0x07 || code === 0x9c) state = "ground";
      else if (code === 0x1b) state = "osc-escape";
      continue;
    }
    if (code === 0x5c || code === 0x9c) state = "ground";
    else if (code === 0x1b) state = "osc-escape";
    else state = "osc";
  }
  return { text: output, state };
}

export function createStreamingObservationText(): StreamingObservationText {
  return new StreamingObservationText();
}

export function redactStreamingSecrets(value: string): string {
  let result = value;
  for (const pattern of STREAM_SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result;
}

function streamingSecretSuffixStart(value: string): number | undefined {
  const candidates: number[] = [];
  const suffixPatterns = [
    /(?:^|[^A-Za-z0-9_])(bearer\s+[A-Za-z0-9._~+/=-]*)$/i,
    /(?:^|[^A-Za-z0-9_])(authorization\s*[:=]\s*[A-Za-z0-9._~+/=-]*)$/i,
    /(?:^|[^A-Za-z0-9_])(gh[pousr]_[A-Za-z0-9_]*)$/i,
    /(?:^|[^A-Za-z0-9_])(sk-[A-Za-z0-9_-]*)$/i,
    /(?:^|[\s,{?&;])["']?((?:--?(?:api[-_]?key|token|password|authorization|credential|cookie|jwt|private[-_]?key|secret)|api[-_]?key|token|password|authorization|credential|cookie|jwt|private[-_]?key|secret))["']?[\s]*[:=][\s]*[^\s,}&;]*$/i,
  ];
  for (const pattern of suffixPatterns) {
    const match = pattern.exec(value);
    if (match?.[1] !== undefined) {
      // Include the complete assignment in the holdback; match[1] is only the key.
      candidates.push(match.index + match[0].indexOf(match[1]));
    }
  }
  const privateKeyHeader = /-----BEGIN [A-Z ]+ PRIVATE KEY-----/i.exec(value);
  if (privateKeyHeader && !/-----END [A-Z ]+ PRIVATE KEY-----/i.test(value.slice(privateKeyHeader.index))) {
    candidates.push(privateKeyHeader.index);
  }
  for (const prefix of STREAM_SECRET_PREFIXES) {
    for (let length = prefix.length; length >= 1; length -= 1) {
      const start = value.length - length;
      if (start < 0 || !prefix.toLowerCase().startsWith(value.slice(start).toLowerCase())) continue;
      if (start > 0 && /[A-Za-z0-9_]/.test(value[start - 1] ?? "")) continue;
      candidates.push(start);
      break;
    }
  }
  return candidates.length ? Math.min(...candidates) : undefined;
}

export function observationScopeKey(identity: ObservationIdentity): string {
  return identity.forgeRunId
    ?? identity.orchestrationId
    ?? identity.workUnitId
    ?? identity.controllerTaskId
    ?? identity.piAsyncId
    ?? identity.agentTaskId
    ?? "global";
}

export function observationStreamKey(identity: ObservationIdentity, channel: "stdout" | "stderr"): string {
  // Task/channel identity is stable across enrichment and prevents a refreshed
  // run/work-unit identity from escaping an existing quarantine.
  const logical = identity.agentTaskId
    ? `agent:${identity.agentTaskId}`
    : identity.controllerTaskId
      ? `controller:${identity.controllerTaskId}`
      : identity.piAsyncId
        ? `pi:${identity.piAsyncId}`
        : identity.workUnitId
          ? `work:${identity.workUnitId}`
          : identity.orchestrationId
            ? `orchestration:${identity.orchestrationId}`
            : identity.forgeRunId
              ? `run:${identity.forgeRunId}`
              : "global";
  return `${logical}|${channel}`;
}

export function observationEntityId(identity: ObservationIdentity, producer: ObservationProducer): string {
  return identity.agentTaskId
    ?? identity.workUnitId
    ?? identity.controllerTaskId
    ?? identity.piAsyncId
    ?? identity.piSessionRef
    ?? identity.nodeId
    ?? identity.forgeRunId
    ?? identity.orchestrationId
    ?? `${producer.component}:${producer.processInstanceId}`;
}

export function createObservationProducer(component: string, pid = process.pid): ObservationProducer {
  return { component, processInstanceId: `${component}:${pid}:${randomUUID()}`, pid };
}

export function redactObservationValue(value: unknown, policy: ObservationRedactionPolicy = {}, depth = 0): RedactedValue {
  const maxStringBytes = policy.maxStringBytes ?? DEFAULT_OBSERVATION_MAX_STRING_BYTES;
  const maxPayloadBytes = policy.maxPayloadBytes ?? DEFAULT_OBSERVATION_MAX_PAYLOAD_BYTES;
  const maxDepth = policy.maxDepth ?? 8;
  const maxArrayItems = policy.maxArrayItems ?? 64;
  const maxObjectKeys = policy.maxObjectKeys ?? 128;
  const serializedInput = safeJson(value);
  const originalBytes = Buffer.byteLength(serializedInput, "utf8");

  if (depth > maxDepth) {
    return { value: "[observation depth limit]", redacted: true, originalBytes, outputBytes: 28, truncated: true };
  }

  if (typeof value === "string") {
    const sanitized = sanitizeTerminalText(value);
    const streamed = redactStreamingSecrets(sanitized);
    const masked = maskCredentialAssignments(streamed);
    const sensitive = SENSITIVE_VALUE.test(sanitized);
    const changed = masked !== value;
    if (changed || sensitive) {
      // Keep the detector and replacement boundaries aligned: a positive
      // detector result must never report redaction while returning the input.
      const safeMasked = sensitive && masked === sanitized ? "[REDACTED]" : masked;
      const bytes = Buffer.byteLength(safeMasked, "utf8");
      if (bytes <= maxStringBytes) return { value: safeMasked, redacted: true, originalBytes, outputBytes: bytes, truncated: false };
      const clipped = clipUtf8(safeMasked, maxStringBytes);
      return { value: `${clipped}… [truncated]`, redacted: true, originalBytes, outputBytes: Buffer.byteLength(clipped, "utf8") + 14, truncated: true };
    }
    const terminalSequencesRemoved = sanitized !== value;
    const bytes = Buffer.byteLength(sanitized, "utf8");
    if (bytes <= maxStringBytes) return { value: sanitized, redacted: terminalSequencesRemoved, originalBytes, outputBytes: bytes, truncated: false };
    const clipped = clipUtf8(sanitized, maxStringBytes);
    return {
      value: `${clipped}… [truncated]`,
      redacted: true,
      originalBytes,
      outputBytes: Buffer.byteLength(clipped, "utf8") + 14,
      truncated: true,
    };
  }

  if (Array.isArray(value)) {
    const selected = value.slice(0, maxArrayItems);
    const children = selected.map((item) => redactObservationValue(item, policy, depth + 1));
    const output = children.map((child) => child.value);
    const truncated = selected.length !== value.length || children.some((child) => child.truncated);
    if (truncated) output.push("[items truncated]");
    const result = { value: output, redacted: truncated || children.some((child) => child.redacted), originalBytes, outputBytes: Buffer.byteLength(safeJson(output), "utf8"), truncated };
    return enforcePayloadLimit(result, maxPayloadBytes);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const output: Record<string, unknown> = {};
    let redacted = false;
    let truncated = false;
    for (const [key, childValue] of entries.slice(0, maxObjectKeys)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = "[REDACTED]";
        redacted = true;
        continue;
      }
      const child = redactObservationValue(childValue, policy, depth + 1);
      output[key] = child.value;
      redacted ||= child.redacted;
      truncated ||= child.truncated;
    }
    if (entries.length > maxObjectKeys) {
      output.__observationTruncated = `${entries.length - maxObjectKeys} object field(s) omitted`;
      redacted = true;
      truncated = true;
    }
    const result = { value: output, redacted, originalBytes, outputBytes: Buffer.byteLength(safeJson(output), "utf8"), truncated };
    return enforcePayloadLimit(result, maxPayloadBytes);
  }

  return { value, redacted: false, originalBytes, outputBytes: originalBytes, truncated: false };
}

export function normalizeObservationDraft(draft: ObservationDraft, policy: ObservationRedactionPolicy = {}): ObservationDraft {
  const identity = { ...(draft.identity ?? {}) };
  const payload = redactObservationValue(draft.payload ?? {}, policy);
  const output = draft.output
    ? redactObservationValue(draft.output.text, { ...policy, maxPayloadBytes: policy.maxOutputBytes ?? DEFAULT_OBSERVATION_MAX_OUTPUT_BYTES })
    : undefined;
  const delivery: ObservationDelivery = {
    ...(draft.delivery ?? {}),
    ...(payload.truncated || output?.truncated ? { truncated: true } : {}),
    ...(payload.originalBytes > payload.outputBytes ? { originalBytes: payload.originalBytes } : {}),
  };
  return {
    ...draft,
    identity,
    payload: payload.value,
    severity: draft.severity ?? "info",
    delivery,
    security: {
      redacted: draft.security?.redacted === true || payload.redacted || output?.redacted === true,
      ...(draft.security?.sensitivity ? { sensitivity: draft.security.sensitivity } : {}),
    },
    ...(output ? {
      output: {
        ...draft.output!,
        text: String(output.value),
      },
    } : {}),
  };
}

export function sanitizeTerminalText(value: string): string {
  // Use the same fail-closed transition model as chunked adapters. An incomplete
  // sequence is discarded rather than becoming visible at this boundary.
  return consumeTerminalText(value, "ground").text;
}

function maskCredentialAssignments(value: string): string {
  let result = value;
  const assignment = /(?:^|[\s,{?&;])["']?(?:--?(?:api[-_]?key|token|password|authorization|credential|cookie|jwt|private[-_]?key|secret)|api[-_]?key|token|password|authorization|credential|cookie|jwt|private[-_]?key|secret)["']?\s*[:=]\s*/gi;
  let searchFrom = 0;
  while (searchFrom < result.length) {
    assignment.lastIndex = searchFrom;
    const match = assignment.exec(result);
    if (!match) break;
    const valueStart = match.index + match[0].length;
    const quote = result[valueStart];
    const quoted = quote === '"' || quote === "'";
    const contentStart = valueStart + (quoted ? 1 : 0);
    let end = contentStart;
    if (quoted) {
      while (end < result.length) {
        if (result[end] === quote && result[end - 1] !== "\\") break;
        end += 1;
      }
    } else {
      while (end < result.length && !/[\s,}&;]/.test(result[end] ?? "")) end += 1;
    }
    const raw = result.slice(contentStart, end);
    if (raw && !REDACTION_MARKER.test(raw)) {
      result = `${result.slice(0, contentStart)}[REDACTED]${result.slice(end)}`;
      searchFrom = contentStart + "[REDACTED]".length;
    } else {
      searchFrom = Math.max(end + 1, valueStart + 1);
    }
  }
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1$2:[REDACTED]@");
}

function enforcePayloadLimit(value: RedactedValue, maxBytes: number): RedactedValue {
  if (value.outputBytes <= maxBytes) return value;
  const clipped = clipUtf8(safeJson(value.value), maxBytes);
  return {
    value: `${clipped}… [payload truncated]`,
    redacted: true,
    originalBytes: value.originalBytes,
    outputBytes: Buffer.byteLength(clipped, "utf8") + 19,
    truncated: true,
  };
}

function clipUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  return bytes.subarray(0, Math.max(0, maxBytes)).toString("utf8").replace(/[\uD800-\uDFFF]$/u, "");
}

function safeJson(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return "[unserializable observation payload]";
  }
}
