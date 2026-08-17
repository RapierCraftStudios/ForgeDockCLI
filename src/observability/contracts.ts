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

/** Stateful terminal parser used by ingress adapters for chunked output. */
export interface TerminalTextSanitizer {
  write(value: string): string;
  finish(): void;
  /**
   * Fail closed after a dropped chunk while retaining only a terminator hunt.
   * The dropped text is optional for callers that have no output chunk; when
   * supplied it lets the parser account for a sequence that began and ended
   * entirely inside the dropped chunk without rendering that text.
   */
  discard?(value?: string): void;
}

const SENSITIVE_KEY = /(?:authorization|api[-_]?key|credential|cookie|jwt|password|private[-_]?key|secret|token|access[-_]?token)/i;
// Match both ordinary names (token, api_key) and environment-style names
// (OPENAI_API_KEY, database_password) without treating surrounding prose as a key.
const CREDENTIAL_KEY_SOURCE_V2 = "(?:(?:[A-Za-z_][A-Za-z0-9_-]*?)?(?:authorization|api[-_]?key|credential|cookie|jwt|password|passwd|private[-_]?key|secret|token|access[-_]?token|client[-_]?secret)[A-Za-z0-9_-]*)";
const CREDENTIAL_ASSIGNMENT_PREFIX_V2 = String.raw`((?:^|[^A-Za-z0-9_])(?:--)?${CREDENTIAL_KEY_SOURCE_V2}(?:["']?\s*[:=]\s*))`;
const CREDENTIAL_OPTION_PREFIX_V2 = String.raw`((?:^|[^A-Za-z0-9_])--${CREDENTIAL_KEY_SOURCE_V2}\s+)`;
const CREDENTIAL_VALUE_SOURCE_V2 = String.raw`(?:\[REDACTED(?:_[A-Za-z0-9_-]+)?\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]"']+)`;
const CREDENTIAL_ASSIGNMENT_V2 = new RegExp(`${CREDENTIAL_ASSIGNMENT_PREFIX_V2}${CREDENTIAL_VALUE_SOURCE_V2}`, "gi");
const CREDENTIAL_OPTION_V2 = new RegExp(`${CREDENTIAL_OPTION_PREFIX_V2}${CREDENTIAL_VALUE_SOURCE_V2}`, "gi");

const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;
const BEARER_VALUE = /\b(Bearer\s+)([A-Za-z0-9._~+\/-]+=*)/gi;
const KNOWN_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]{4,}|github_pat_[A-Za-z0-9_]{4,}|glpat-[A-Za-z0-9_-]{4,}|sk-[A-Za-z0-9_-]{8,})\b/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z0-9 ]+ PRIVATE KEY-----/i;

export function observationScopeKey(identity: ObservationIdentity): string {
  return identity.forgeRunId
    ?? identity.orchestrationId
    ?? identity.workUnitId
    ?? identity.controllerTaskId
    ?? identity.piAsyncId
    ?? identity.agentTaskId
    ?? "global";
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

/**
 * Sanitize one output chunk with a caller-owned parser. Keeping this helper at
 * the contract boundary makes stateful ingress adapters preserve sequence
 * boundaries while still reporting sanitization through the v1 security flag.
 */
export function sanitizeObservationOutput(draft: ObservationDraft, sanitizer: TerminalTextSanitizer): ObservationDraft {
  if (!draft.output) return draft;
  const text = sanitizer.write(draft.output.text);
  if (text === draft.output.text) {
    return { ...draft, output: { ...draft.output, text } };
  }
  return {
    ...draft,
    security: { ...(draft.security ?? {}), redacted: true },
    output: { ...draft.output, text },
  };
}

/** Stable stream identity used by observer and direct SQLite defense-in-depth. */
export function observationOutputStreamPrefix(draft: ObservationDraft): string {
  const identity = draft.identity ?? {};
  const streamIdentity = identity.agentTaskId
    ?? identity.controllerTaskId
    ?? identity.piAsyncId
    ?? identity.workUnitId
    ?? identity.nodeId
    ?? identity.forgeRunId
    ?? `${draft.producer.component}:${draft.producer.processInstanceId}`;
  return `${draft.source}:${streamIdentity}:${draft.producer.processInstanceId}:`;
}

export function observationOutputStreamKey(draft: ObservationDraft): string | undefined {
  if (!draft.output) return undefined;
  return `${observationOutputStreamPrefix(draft)}${draft.output.channel}`;
}

export function redactObservationValue(value: unknown, policy: ObservationRedactionPolicy = {}, depth = 0): RedactedValue {
  return redactObservationValueInternal(value, policy, depth, false);
}

function redactObservationValueInternal(value: unknown, policy: ObservationRedactionPolicy, depth: number, sensitiveContext: boolean): RedactedValue {
  const maxStringBytes = boundedLimit(policy.maxStringBytes ?? DEFAULT_OBSERVATION_MAX_STRING_BYTES);
  const maxPayloadBytes = boundedLimit(policy.maxPayloadBytes ?? DEFAULT_OBSERVATION_MAX_PAYLOAD_BYTES);
  const maxDepth = boundedLimit(policy.maxDepth ?? 8);
  const maxArrayItems = boundedLimit(policy.maxArrayItems ?? 64);
  const maxObjectKeys = boundedLimit(policy.maxObjectKeys ?? 128);
  const originalBytes = observationValueBytes(value);

  if (depth > maxDepth) {
    return { value: "[observation depth limit]", redacted: true, originalBytes, outputBytes: Buffer.byteLength("[observation depth limit]", "utf8"), truncated: true };
  }

  if (sensitiveContext) return redactedValue("[REDACTED]", originalBytes);

  if (typeof value === "string") {
    const sanitized = sanitizeTerminalText(value);
    const masked = maskObservationString(sanitized);
    const bytes = Buffer.byteLength(masked, "utf8");
    if (isObservationTruncationMarker(masked)) {
      return { value: masked, redacted: true, originalBytes, outputBytes: bytes, truncated: true };
    }
    if (bytes <= maxStringBytes) {
      return { value: masked, redacted: sanitized !== value || masked !== sanitized, originalBytes, outputBytes: bytes, truncated: false };
    }
    const output = boundedTextWithMarker(masked, maxStringBytes, "… [truncated]");
    return {
      value: output,
      redacted: true,
      originalBytes,
      outputBytes: Buffer.byteLength(output, "utf8"),
      truncated: true,
    };
  }

  if (Array.isArray(value)) {
    const selected = value.slice(0, maxArrayItems);
    let sensitiveNext = false;
    const children = selected.map((item) => {
      const standaloneOption = typeof item === "string" && isStandaloneSensitiveOption(item);
      const child = redactObservationValueInternal(item, policy, depth + 1, sensitiveNext && !standaloneOption);
      sensitiveNext = standaloneOption;
      return child;
    });
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
      const child = redactObservationValueInternal(childValue, policy, depth + 1, isSensitiveObservationKey(key));
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
  const outputLimit = boundedLimit(policy.maxOutputBytes ?? DEFAULT_OBSERVATION_MAX_OUTPUT_BYTES);
  const outputPolicy: ObservationRedactionPolicy = {
    ...policy,
    maxStringBytes: Math.min(boundedLimit(policy.maxStringBytes ?? DEFAULT_OBSERVATION_MAX_STRING_BYTES), outputLimit),
    maxPayloadBytes: outputLimit,
  };
  const output = draft.output
    ? redactObservationValueInternal(draft.output.text, outputPolicy, 0, false)
    : undefined;
  const outputText = output ? String(output.value) : undefined;
  const normalizedPayload = updateOutputByteMetadata(payload.value, outputText);
  const originalBytes = Math.max(
    draft.delivery?.originalBytes ?? 0,
    payload.redacted || payload.truncated ? payload.originalBytes : 0,
    output && (output.redacted || output.truncated) ? output.originalBytes : 0,
  );
  const delivery: ObservationDelivery = {
    ...(draft.delivery ?? {}),
    ...(payload.truncated || output?.truncated ? { truncated: true } : {}),
    ...(originalBytes > 0 ? { originalBytes } : {}),
  };
  return {
    ...draft,
    identity,
    payload: normalizedPayload,
    severity: draft.severity ?? "info",
    delivery,
    security: {
      redacted: draft.security?.redacted === true || payload.redacted || output?.redacted === true,
      ...(draft.security?.sensitivity ? { sensitivity: draft.security.sensitivity } : {}),
    },
    ...(output ? {
      output: {
        ...draft.output!,
        text: outputText!,
      },
    } : {}),
  };
}

function observationValueBytes(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : safeJson(value), "utf8");
}

function boundedLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function isSensitiveObservationKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

function isStandaloneSensitiveOption(value: string): boolean {
  return new RegExp(String.raw`^\s*--${CREDENTIAL_KEY_SOURCE_V2}(?:=)?\s*$`, "i").test(value);
}

function updateOutputByteMetadata(value: unknown, outputText: string | undefined): unknown {
  if (outputText === undefined || value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (typeof record.bytes !== "number") return value;
  const bytes = Buffer.byteLength(outputText, "utf8");
  return record.bytes === bytes ? value : { ...record, bytes };
}

/**
 * Sanitize one complete value. Incomplete sequences are dropped through the end
 * of the value, which is deliberately fail-closed for non-streaming callers.
 */
export function sanitizeTerminalText(value: string): string {
  const sanitizer = createTerminalTextSanitizer();
  const output = sanitizer.write(value);
  sanitizer.finish();
  return output;
}

export function createTerminalTextSanitizer(): TerminalTextSanitizer {
  let state: TerminalParserState = "text";
  let discardedState: TerminalParserState | undefined;

  return {
    write(value: string): string {
      let output = "";
      for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        if (discardedState) {
          discardedState = consumeDiscardedTerminalCode(discardedState, code);
          continue;
        }
        if (state === "text") {
          if (code === 0x1b) { state = "escape"; continue; }
          const nextState = c1SequenceState(code);
          if (nextState) { state = nextState; continue; }
          if (isForbiddenTerminalControl(code)) continue;
          output += character;
          continue;
        }

        if (state === "escape") {
          if (code === 0x5b) { state = "csi"; continue; }
          if (code === 0x5d) { state = "osc"; continue; }
          if (code === 0x4f) { state = "ss3"; continue; }
          if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) { state = "string"; continue; }
          if (isEscapeIntermediate(code)) { state = "escape-sequence"; continue; }
          if (isEscapeFinal(code)) { state = "text"; continue; }
          if (code === 0x1b) continue;
          const nextState = c1SequenceState(code);
          if (nextState) { state = nextState; continue; }
          state = "text";
          if (!isForbiddenTerminalControl(code)) output += character;
          continue;
        }

        if (state === "escape-sequence") {
          if (isEscapeFinal(code)) { state = "text"; continue; }
          if (isEscapeIntermediate(code)) continue;
          if (code === 0x1b) { state = "escape"; continue; }
          const nextState = c1SequenceState(code);
          if (nextState) { state = nextState; continue; }
          if (isForbiddenTerminalControl(code)) continue;
          state = "text";
          output += character;
          continue;
        }

        if (state === "csi" || state === "ss3") {
          if (code >= 0x40 && code <= 0x7e) { state = "text"; continue; }
          if (code === 0x1b) { state = "escape"; continue; }
          const nextState = c1SequenceState(code);
          if (nextState) { state = nextState; continue; }
          continue;
        }

        if (state === "osc") {
          if (code === 0x07 || code === 0x9c) { state = "text"; continue; }
          if (code === 0x1b) { state = "osc-escape"; continue; }
          continue;
        }

        if (state === "osc-escape") {
          // An ESC inside OSC is only a terminator when followed by a backslash.
          if (code === 0x5c || code === 0x07 || code === 0x9c) { state = "text"; continue; }
          if (code === 0x1b) continue;
          state = "osc";
          continue;
        }

        if (state === "string") {
          if (code === 0x9c) { state = "text"; continue; }
          if (code === 0x1b) { state = "string-escape"; continue; }
          continue;
        }

        // DCS, SOS, PM, and APC terminate only with ST.
        if (code === 0x5c || code === 0x9c) { state = "text"; continue; }
        if (code === 0x1b) continue;
        state = "string";
      }
      return output;
    },
    finish(): void {
      state = "text";
      discardedState = undefined;
    },
    discard(value?: string): void {
      // Account for the dropped chunk without returning any of its text. This
      // preserves an incomplete sequence that started in the dropped chunk,
      // while still allowing ordinary dropped text to resume normally.
      if (value) void this.write(value);
      // Once a dropped chunk has left us in fail-closed mode, subsequent
      // dropped chunks must not clear the terminator hunt. Clearing it would
      // allow visible text after a queue gap to be rendered without proving
      // that the abandoned control sequence has ended.
      if (discardedState) return;
      discardedState = state === "text" ? undefined : state;
      state = "text";
    },
  };
}

type TerminalParserState = "text" | "escape" | "escape-sequence" | "csi" | "ss3" | "osc" | "osc-escape" | "string" | "string-escape";

function c1SequenceState(code: number): TerminalParserState | undefined {
  if (code === 0x9b) return "csi";
  if (code === 0x9d) return "osc";
  if (code === 0x8f) return "ss3";
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) return "string";
  return undefined;
}

/** Consume a continuation after a dropped chunk without ever rendering it. */
function consumeDiscardedTerminalCode(state: TerminalParserState, code: number): TerminalParserState | undefined {
  if (state === "osc") {
    if (code === 0x07 || code === 0x9c) return undefined;
    return code === 0x1b ? "osc-escape" : "osc";
  }
  if (state === "osc-escape") {
    if (code === 0x5c || code === 0x07 || code === 0x9c) return undefined;
    return code === 0x1b ? "osc-escape" : "osc";
  }
  if (state === "string") {
    if (code === 0x9c) return undefined;
    return code === 0x1b ? "string-escape" : "string";
  }
  if (state === "string-escape") {
    if (code === 0x5c || code === 0x9c) return undefined;
    return code === 0x1b ? "string-escape" : "string";
  }
  if (state === "csi" || state === "ss3") {
    if (code >= 0x40 && code <= 0x7e) return undefined;
    if (code === 0x1b) return "escape";
    return c1SequenceState(code) ?? state;
  }
  if (state === "escape") {
    if (isEscapeFinal(code)) return undefined;
    if (isEscapeIntermediate(code)) return "escape-sequence";
    if (code === 0x1b) return "escape";
    return c1SequenceState(code) ?? "escape";
  }
  if (isEscapeFinal(code)) return undefined;
  if (isEscapeIntermediate(code)) return "escape-sequence";
  if (code === 0x1b) return "escape";
  return c1SequenceState(code) ?? "escape-sequence";
}

function isEscapeIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isEscapeFinal(code: number): boolean {
  return code >= 0x30 && code <= 0x7e;
}

function isForbiddenTerminalControl(code: number): boolean {
  return (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d)
    || code === 0x7f
    || (code >= 0x80 && code <= 0x9f);
}

function maskObservationString(value: string): string {
  let masked = value.replace(URL_USERINFO, (_match, scheme: string) => `${scheme}[REDACTED]@`);
  masked = maskCredentialAssignmentsV2(masked);
  masked = masked.replace(BEARER_VALUE, (match, prefix: string, token: string) => isRedactionPlaceholder(token) ? match : `${prefix}[REDACTED]`);
  masked = masked.replace(KNOWN_TOKEN, "[REDACTED_TOKEN]");
  masked = masked.replace(JWT_VALUE, "[REDACTED_JWT]");
  return PRIVATE_KEY_MARKER.test(masked) ? "[REDACTED]" : masked;
}

function maskCredentialAssignmentsV2(value: string): string {
  const mask = (match: string, prefix: string): string => {
    const rawValue = match.slice(prefix.length);
    const quote = rawValue[0] === "\"" || rawValue[0] === "'" ? rawValue[0] : "";
    const content = quote && rawValue.endsWith(quote) ? rawValue.slice(1, -1) : rawValue;
    if (isRedactionPlaceholder(content)) return match;
    return `${prefix}${quote ? `${quote}[REDACTED]${quote}` : "[REDACTED]"}`;
  };
  const assigned = value.replace(CREDENTIAL_ASSIGNMENT_V2, mask);
  return assigned.replace(CREDENTIAL_OPTION_V2, mask);
}

function isRedactionPlaceholder(value: string): boolean {
  return /^\[REDACTED(?:_[A-Za-z0-9_-]+)?\]$/.test(value);
}

function redactedValue(value: string, originalBytes: number, truncated = false): RedactedValue {
  return {
    value,
    redacted: true,
    originalBytes,
    outputBytes: Buffer.byteLength(value, "utf8"),
    truncated,
  };
}

function isObservationTruncationMarker(value: string): boolean {
  return value.endsWith("… [truncated]") || value.endsWith("… [payload truncated]");
}

function enforcePayloadLimit(value: RedactedValue, maxBytes: number): RedactedValue {
  const limit = boundedLimit(maxBytes);
  if (value.outputBytes <= limit) return value;
  const serialized = safeJson(value.value);
  const output = boundedSerializedTextWithMarker(serialized, limit, "… [payload truncated]");
  return {
    value: output,
    redacted: true,
    originalBytes: value.originalBytes,
    outputBytes: Buffer.byteLength(safeJson(output), "utf8"),
    truncated: true,
  };
}

function boundedTextWithMarker(value: string, maxBytes: number, marker: string): string {
  const limit = boundedLimit(maxBytes);
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (limit <= markerBytes) return clipUtf8(marker, limit);
  return `${clipUtf8(value, limit - markerBytes)}${marker}`;
}

function boundedSerializedTextWithMarker(value: string, maxBytes: number, marker: string): string {
  const limit = boundedLimit(maxBytes);
  const markerJsonBytes = Buffer.byteLength(JSON.stringify(marker), "utf8");
  if (limit <= markerJsonBytes) {
    let candidate = clipUtf8(marker, Math.max(0, limit - 2));
    while (candidate && Buffer.byteLength(safeJson(candidate), "utf8") > limit) candidate = candidate.slice(0, -1);
    return candidate;
  }
  const markerBytes = Buffer.byteLength(marker, "utf8");
  let candidate = `${clipUtf8(value, Math.max(0, limit - 2 - markerBytes))}${marker}`;
  while (Buffer.byteLength(safeJson(candidate), "utf8") > limit && candidate.length > marker.length) {
    candidate = `${candidate.slice(0, -marker.length - 1)}${marker}`;
  }
  return candidate;
}

function clipUtf8(value: string, maxBytes: number): string {
  const limit = boundedLimit(maxBytes);
  if (limit === 0) return "";
  const bytes = Buffer.from(value, "utf8");
  let output = bytes.subarray(0, Math.min(limit, bytes.length)).toString("utf8");
  while (output && Buffer.byteLength(output, "utf8") > limit) output = output.slice(0, -1);
  return output.replace(/[\uD800-\uDFFF]$/u, "");
}

function safeJson(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return "[unserializable observation payload]";
  }
}
