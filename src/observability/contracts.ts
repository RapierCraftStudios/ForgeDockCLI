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
const SENSITIVE_VALUE = /(?:bearer\s+|gh[pousr]_\w+|sk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/i;
const STREAM_SECRET_PATTERNS = [
  /bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /authorization\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/gi,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gi,
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
] as const;
const STREAM_HOLDBACK_LIMIT_BYTES = 16 * 1024;
const STREAM_SECRET_PREFIXES = ["bearer", "authorization", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "sk-", "-----BEGIN "];

type TerminalParserState = "ground" | "escape" | "csi" | "osc" | "osc-escape" | "ss3";

interface CredentialStreamResult {
  value: string;
  redacted: boolean;
}

/**
 * Holds only a trailing sensitive assignment whose value has not reached a
 * delimiter yet. This is deliberately per stream: output chunks from two
 * identities or channels must never complete one another's assignment.
 */
class StreamingCredentialAssignments {
  #holdback = "";

  push(value: string): CredentialStreamResult {
    if (!value) return { value: "", redacted: false };
    if (this.#holdback) {
      const candidate = this.#holdback + value;
      this.#holdback = "";
      const trailing = trailingCredentialAssignmentStart(candidate);
      if (trailing !== undefined && trailing > 0) {
        this.#holdback = candidate.slice(trailing);
        const prefix = candidate.slice(0, trailing);
        const masked = maskCredentialContinuation(prefix);
        return { value: masked, redacted: true };
      }
      if (!isCredentialValueDelimiter(value[0] ?? "")) {
        return { value: maskCredentialContinuation(candidate), redacted: true };
      }
      const masked = maskCredentialAssignments(candidate);
      return { value: masked.value, redacted: masked.redacted };
    }

    const pendingStart = trailingCredentialAssignmentStart(value);
    if (pendingStart !== undefined) {
      this.#holdback = value.slice(pendingStart);
      const prefix = value.slice(0, pendingStart);
      const masked = maskCredentialAssignments(prefix);
      return { value: masked.value, redacted: true };
    }
    const masked = maskCredentialAssignments(value);
    return { value: masked.value, redacted: masked.redacted };
  }

  finish(): CredentialStreamResult {
    if (!this.#holdback) return { value: "", redacted: false };
    const pending = this.#holdback;
    this.#holdback = "";
    return { value: maskCredentialContinuation(pending), redacted: true };
  }

  reset(): void {
    this.#holdback = "";
  }
}

/** Stateful, fail-closed sanitizer for output that arrives in arbitrary chunks. */
export class StreamingObservationText {
  #state: TerminalParserState = "ground";
  #holdback = "";
  #quarantined = false;
  #credentialAssignments = new StreamingCredentialAssignments();

  push(value: string): string {
    if (!value || this.#quarantined) return "";
    const visible = this.consumeTerminal(value);
    if (!visible) return "";
    const assignments = this.#credentialAssignments.push(visible);
    if (!assignments.value) return "";
    return this.flushSafe(assignments.value);
  }

  /** Backpressure may discard an incomplete control/secret sequence. */
  markDropped(): void {
    this.#quarantined = true;
    this.#state = "ground";
    this.#holdback = "";
    this.#credentialAssignments.reset();
  }

  reset(): void {
    this.#state = "ground";
    this.#holdback = "";
    this.#credentialAssignments.reset();
    this.#quarantined = false;
  }

  finish(): string {
    if (this.#quarantined) {
      this.reset();
      return "";
    }
    const assignmentTail = this.#credentialAssignments.finish();
    const emitted = assignmentTail.value ? this.flushSafe(assignmentTail.value) : "";
    const tail = streamingSecretSuffixStart(this.#holdback) === undefined
      ? redactStreamingSecrets(this.#holdback)
      : "[REDACTED]";
    this.#holdback = "";
    this.#state = "ground";
    return emitted + tail;
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
    let output = "";
    for (const character of value) {
      const code = character.charCodeAt(0);
      if (this.#state === "ground") {
        if (code === 0x1b) this.#state = "escape";
        else if (code === 0x0a || code === 0x0d || code === 0x09 || code >= 0x20) output += character;
        continue;
      }
      if (this.#state === "escape") {
        if (character === "[") this.#state = "csi";
        else if (character === "]") this.#state = "osc";
        else if (character === "O") this.#state = "ss3";
        else this.#state = "ground";
        continue;
      }
      if (this.#state === "csi" || this.#state === "ss3") {
        if (code >= 0x40 && code <= 0x7e) this.#state = "ground";
        else if (code === 0x1b) this.#state = "escape";
        continue;
      }
      if (this.#state === "osc") {
        if (code === 0x07) this.#state = "ground";
        else if (code === 0x1b) this.#state = "osc-escape";
        continue;
      }
      if (code === 0x5c) this.#state = "ground";
      else if (code === 0x1b) this.#state = "osc-escape";
      else this.#state = "osc";
    }
    return output;
  }
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
  ];
  for (const pattern of suffixPatterns) {
    const match = pattern.exec(value);
    if (match?.[1] !== undefined) candidates.push(match.index + match[0].length - match[1].length);
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
  return [
    identity.forgeRunId ?? "",
    identity.orchestrationId ?? "",
    identity.workUnitId ?? "",
    identity.agentTaskId ?? "",
    identity.controllerTaskId ?? "",
    identity.piAsyncId ?? "",
    channel,
  ].join("|");
}

interface ControllerCredentialStreamState {
  sanitizer: StreamingCredentialAssignments;
  chunkSequence: number;
  output: string;
  redacted: boolean;
}

const controllerCredentialStreams = new Map<string, ControllerCredentialStreamState>();

/**
 * Encode controller stream identity without delimiter ambiguity. The
 * credential continuation map is process-global, so every identity component
 * and the producer instance must remain distinguishable from the others.
 */
function controllerCredentialKey(
  identity: ObservationIdentity,
  channel: "stdout" | "stderr",
  processInstanceId: string,
): string {
  return JSON.stringify([
    identity.forgeRunId ?? null,
    identity.orchestrationId ?? null,
    identity.workUnitId ?? null,
    identity.agentTaskId ?? null,
    identity.controllerTaskId ?? null,
    identity.piAsyncId ?? null,
    channel,
    processInstanceId,
  ]);
}

function controllerCredentialStreamKey(draft: ObservationDraft): string | undefined {
  if (draft.source !== "controller" || !draft.output || draft.output.chunkSequence === undefined) return undefined;
  return controllerCredentialKey(draft.identity ?? {}, draft.output.channel, draft.producer.processInstanceId);
}

function isObservationStreamTerminal(kind: string): boolean {
  return /(?:session\.(?:completed|failed|cancelled)|process\.(?:exited|failed)|controller\.(?:completed|failed))$/i.test(kind);
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
    const assignmentMask = maskCredentialAssignments(sanitized);
    const masked = redactStreamingSecrets(assignmentMask.value);
    if (masked !== assignmentMask.value || SENSITIVE_VALUE.test(sanitized)) {
      return { value: "[REDACTED]", redacted: true, originalBytes, outputBytes: 11, truncated: false };
    }
    const terminalSequencesRemoved = sanitized !== value;
    const redacted = terminalSequencesRemoved || assignmentMask.redacted;
    const bytes = Buffer.byteLength(assignmentMask.value, "utf8");
    if (bytes <= maxStringBytes) return { value: assignmentMask.value, redacted, originalBytes, outputBytes: bytes, truncated: false };
    const clipped = clipUtf8(assignmentMask.value, maxStringBytes);
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
  const outputValue = draft.output
    ? redactObservationValue(draft.output.text, { ...policy, maxPayloadBytes: policy.maxOutputBytes ?? DEFAULT_OBSERVATION_MAX_OUTPUT_BYTES })
    : undefined;
  const controllerStreamKey = controllerCredentialStreamKey(draft);
  let output = outputValue;
  if (isObservationStreamTerminal(draft.kind) && draft.source === "controller") {
    for (const channel of ["stdout", "stderr"] as const) {
      controllerCredentialStreams.delete(controllerCredentialKey(identity, channel, draft.producer.processInstanceId));
    }
  }
  if (outputValue && controllerStreamKey && !outputValue.redacted && draft.security?.redacted !== true) {
    const prior = controllerCredentialStreams.get(controllerStreamKey);
    if (prior && prior.chunkSequence === draft.output!.chunkSequence) {
      output = { ...outputValue, value: prior.output, redacted: prior.redacted || outputValue.redacted };
    } else {
      const sanitizer = prior?.sanitizer ?? new StreamingCredentialAssignments();
      const streamed = sanitizer.push(String(outputValue.value));
      const state = {
        sanitizer,
        chunkSequence: draft.output!.chunkSequence!,
        output: streamed.value,
        redacted: outputValue.redacted || streamed.redacted,
      };
      controllerCredentialStreams.set(controllerStreamKey, state);
      output = { ...outputValue, value: streamed.value, redacted: state.redacted };
    }
  }
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
  return value
    // OSC hyperlinks, titles, and clipboard sequences can execute in some terminal emulators.
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, "")
    // CSI/SS3 and other ANSI control sequences are not part of the observation payload.
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])/g, "")
    // Preserve newline, carriage return, and tab while removing other C0 controls.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function maskCredentialAssignments(value: string): { value: string; redacted: boolean } {
  let result = maskUrlUserinfo(value);
  result = maskDelimitedAssignments(result);
  result = maskCommandLineAssignments(result);
  return { value: result, redacted: result !== value };
}

interface SensitiveAssignmentMatch {
  index: number;
  valueStart: number;
}

function sensitiveAssignments(value: string): SensitiveAssignmentMatch[] {
  const patterns = [
    /(^|[^\w-])((?:["']?)(?:--)?[A-Za-z][A-Za-z0-9_.-]*(?:["']?))\s*([:=])\s*/g,
    /(^|[^\w-])(--[A-Za-z][A-Za-z0-9_.-]*)[ \t]+/g,
  ];
  const matches: SensitiveAssignmentMatch[] = [];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const rawKey = match[2];
      const key = rawKey?.replace(/["']/g, "").replace(/^-+/, "");
      if (key && SENSITIVE_KEY.test(key)) matches.push({ index: match.index, valueStart: match.index + match[0].length });
    }
  }
  return matches.sort((left, right) => left.index - right.index);
}

function firstSensitiveAssignment(value: string): SensitiveAssignmentMatch | undefined {
  return sensitiveAssignments(value)[0];
}

function assignmentValueEndsAt(value: string, start: number): number {
  const opening = value[start];
  if (opening === "\"" || opening === "'") {
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === opening) {
        let end = index + 1;
        while (end < value.length && !isCredentialValueDelimiter(value[end]!)) end += 1;
        return end;
      }
    }
    return value.length;
  }
  let end = start;
  while (end < value.length) {
    if (value[start] === "[" && value[end] === "]") {
      end += 1;
      continue;
    }
    if (isCredentialValueDelimiter(value[end]!)) break;
    end += 1;
  }
  return end;
}

function trailingCredentialAssignmentStart(value: string): number | undefined {
  const matches = sensitiveAssignments(value);
  for (const match of matches.reverse()) {
    const end = assignmentValueEndsAt(value, match.valueStart);
    if (end !== value.length) continue;
    const raw = value.slice(match.valueStart, end);
    if (!raw) return match.index;
    if (value[match.valueStart] === "\"" || value[match.valueStart] === "'") {
      const closing = raw.lastIndexOf(value[match.valueStart]!);
      if (closing < 0) return match.index;
      if (closing + 1 === raw.length && isCompleteRedactionMarker(raw.slice(1, -1))) return match.index;
      continue;
    }
    if (isCompleteRedactionMarker(raw)) return match.index;
  }
  return undefined;
}

/** Mask a value that was continued by a later chunk, including quoted marker suffixes. */
function maskCredentialContinuation(value: string): string {
  const match = firstSensitiveAssignment(value);
  if (!match) return maskCredentialAssignments(value).value;
  const end = assignmentValueEndsAt(value, match.valueStart);
  const opening = value[match.valueStart];
  const replacement = opening === "\"" || opening === "'" ? `${opening}[REDACTED]${opening}` : "[REDACTED]";
  const masked = `${value.slice(0, match.valueStart)}${replacement}${value.slice(end)}`;
  return maskCredentialAssignments(masked).value;
}

function maskUrlUserinfo(value: string): string {
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi, (match, scheme: string, userinfo: string) => {
    if (isCompleteRedactionMarker(userinfo)) return match;
    return `${scheme}[REDACTED]@`;
  });
}

function maskDelimitedAssignments(value: string): string {
  const assignment = /(^|[^\w-])((?:["']?)(?:--)?[A-Za-z][A-Za-z0-9_.-]*(?:["']?))\s*([:=])\s*/g;
  return maskAssignmentMatches(value, assignment, (match) => {
    const rawKey = match[2];
    if (!rawKey) return undefined;
    const key = rawKey.replace(/["']/g, "").replace(/^-+/, "");
    return SENSITIVE_KEY.test(key) ? match.index + match[0].length : undefined;
  });
}

function maskCommandLineAssignments(value: string): string {
  const commandLine = /(^|[^\w-])(--[A-Za-z][A-Za-z0-9_.-]*)[ \t]+/g;
  return maskAssignmentMatches(value, commandLine, (match) => {
    const rawKey = match[2];
    if (!rawKey || !SENSITIVE_KEY.test(rawKey.slice(2))) return undefined;
    return match.index + match[0].length;
  });
}

/**
 * Replace sensitive assignment values while scanning the original string.
 * In particular, a preserved marker ends at the delimiter, not after it; the
 * delimiter must remain available for the next assignment match.
 */
function maskAssignmentMatches(
  value: string,
  assignment: RegExp,
  valueStartFor: (match: RegExpExecArray) => number | undefined,
): string {
  let output = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(value)) !== null) {
    const valueStart = valueStartFor(match);
    if (valueStart === undefined) continue;
    const masked = maskCredentialValue(value, valueStart);
    output += value.slice(cursor, valueStart);
    output += masked.replacement;
    cursor = masked.end;
    // Resume at the value's end, including a preserved marker's delimiter.
    assignment.lastIndex = masked.end;
  }
  return output + value.slice(cursor);
}

function maskCredentialValue(value: string, start: number): { end: number; replacement: string } {
  const opening = value[start];
  if (opening === "\"" || opening === "'") {
    let escaped = false;
    for (let index = start + 1; index < value.length; index += 1) {
      const character = value[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character !== opening) continue;
      const raw = value.slice(start + 1, index);
      return isCompleteRedactionMarker(raw)
        ? { end: index + 1, replacement: value.slice(start, index + 1) }
        : { end: index + 1, replacement: `${opening}[REDACTED]${opening}` };
    }
    return { end: value.length, replacement: `${opening}[REDACTED]` };
  }

  let end = start;
  while (end < value.length) {
    // A marker's closing bracket is part of the value, not its delimiter.
    if (value[start] === "[" && value[end] === "]") {
      end += 1;
      continue;
    }
    if (isCredentialValueDelimiter(value[end]!)) break;
    end += 1;
  }
  const raw = value.slice(start, end);
  return raw && isCompleteRedactionMarker(raw)
    ? { end, replacement: raw }
    : { end, replacement: raw ? "[REDACTED]" : "" };
}

function isCredentialValueDelimiter(character: string): boolean {
  return /[\s,;})\]&]/.test(character);
}

function isCompleteRedactionMarker(value: string): boolean {
  return /^\[REDACTED(?:[A-Za-z0-9 _:#.-]*)?\]$/i.test(value);
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
