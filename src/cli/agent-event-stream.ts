// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentEvent } from "../runtime/agent-runtime.js";
import { createAgentEventObservationSink } from "../observability/adapters.js";
import { sanitizeTerminalText, type ObservationIdentity, type ObservationSink } from "../observability/contracts.js";
import { statusGlyph, type ColorMode } from "../tui/brand.js";

const TOOL_ARG_KEYS = ["path", "file_path", "pattern", "query", "glob", "command", "offset", "limit"] as const;
const MAX_ARG_PREVIEW = 240;

export type AgentEventWrite = (text: string) => void;

let agentObservationSink: ((event: AgentEvent) => void) | undefined;
let agentObservationObserver: ObservationSink | undefined;
let agentObservationIdentity: ObservationIdentity = {};

export function setAgentEventObservationSink(observer: ObservationSink | undefined, identity: ObservationIdentity = {}): void {
  agentObservationObserver = observer;
  agentObservationIdentity = { ...identity };
  agentObservationSink = observer ? createAgentEventObservationSink(observer, { identity: agentObservationIdentity }) : undefined;
}

export function setAgentEventObservationIdentity(identity: ObservationIdentity): void {
  agentObservationIdentity = { ...identity };
  agentObservationSink = agentObservationObserver
    ? createAgentEventObservationSink(agentObservationObserver, { identity: agentObservationIdentity })
    : undefined;
}

export function observeAgentEvent(event: AgentEvent): void {
  agentObservationSink?.(event);
}

/**
 * Projects bounded AgentRuntime activity into the controller's stdout stream.
 * The parent semantic tool forwards this stream into the selected fleet worker,
 * so SDK-owned inner sessions remain observable without weakening controller
 * authority or exposing complete tool payloads.
 */
export class AgentEventStreamWriter {
  readonly #write: AgentEventWrite;
  readonly #mode: ColorMode;
  #stream: { task: string; kind: "assistant"; lineOpen: boolean } | undefined;

  constructor(write: AgentEventWrite, mode: ColorMode) {
    this.#write = write;
    this.#mode = mode;
  }

  write(event: AgentEvent, prefix?: string): void {
    const task = prefix ? `${prefix} · ${event.taskId}` : event.taskId;
    if (event.type === "thinking.delta") {
      // Private model reasoning is intentionally neither rendered nor persisted.
      this.finishDelta();
      return;
    }
    if (event.type === "text.delta") {
      this.writeDelta(task, "assistant", event.text);
      return;
    }

    this.finishDelta();
    const milestone = observabilityPreview(event.observability);
    if (event.type === "session.started") {
      this.#write(`  ${statusGlyph("active", this.#mode)} ${task} · ${event.provider}/${event.model}${milestone ? ` · ${milestone}` : ""}\n`);
    } else if (event.type === "tool.started") {
      const args = toolArgPreview(event.tool, event.args);
      const call = toolCallPreview(event.toolCallId);
      this.#write(`    ${statusGlyph("active", this.#mode)} ${task} · ${event.tool}[${call}]${args ? ` · ${args}` : ""}${milestone ? ` · ${milestone}` : ""}\n`);
    } else if (event.type === "tool.completed") {
      const status = event.isError ? "failed" : "passed";
      const call = toolCallPreview(event.toolCallId);
      const error = event.isError && event.errorSummary ? ` · ${sanitizeTerminalText(event.errorSummary)}` : "";
      this.#write(`    ${statusGlyph(status, this.#mode)} ${task} · ${event.tool}[${call}] ${event.isError ? "failed" : "complete"}${error}${milestone ? ` · ${milestone}` : ""}\n`);
    } else if (event.type === "artifact.submitted") {
      this.#write(`  ${statusGlyph("passed", this.#mode)} ${task} · artifact submitted${milestone ? ` · ${milestone}` : ""}\n`);
    } else if (event.type === "session.completed") {
      this.#write(`  ${statusGlyph("passed", this.#mode)} ${task} · session complete${milestone ? ` · ${milestone}` : ""}\n`);
    } else if (event.type === "session.failed") {
      this.#write(`  ${statusGlyph("failed", this.#mode)} ${task} · session failed · ${sanitizeTerminalText(event.errorSummary)}${milestone ? ` · ${milestone}` : ""}\n`);
    } else if (event.type === "session.cancelled") {
      this.#write(`  ${statusGlyph("blocked", this.#mode)} ${task} · session cancelled · ${sanitizeTerminalText(event.errorSummary)}${milestone ? ` · ${milestone}` : ""}\n`);
    }
  }

  finish(): void {
    this.finishDelta();
  }

  private writeDelta(task: string, kind: "assistant", rawText: string): void {
    if (!rawText) return;
    if (!this.#stream || this.#stream.task !== task || this.#stream.kind !== kind) {
      this.finishDelta();
      this.#write(`    ${statusGlyph("active", this.#mode)} ${task} · ${kind}\n`);
      this.#stream = { task, kind, lineOpen: false };
    }

    const text = sanitizeTerminalText(rawText).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    for (const part of text.split(/(\n)/)) {
      if (!part) continue;
      if (part === "\n") {
        if (!this.#stream.lineOpen) this.#write("      │");
        this.#write("\n");
        this.#stream.lineOpen = false;
        continue;
      }
      if (!this.#stream.lineOpen) {
        this.#write("      │ ");
        this.#stream.lineOpen = true;
      }
      this.#write(part);
    }
  }

  private finishDelta(): void {
    if (this.#stream?.lineOpen) this.#write("\n");
    this.#stream = undefined;
  }
}

function observabilityPreview(observability: AgentEvent["observability"]): string {
  if (!observability) return "";
  return [
    observability.phase,
    observability.cycle ? `cycle ${observability.cycle.current}/${observability.cycle.total}` : "",
    observability.activeChild ? `child ${observability.activeChild}` : "",
    observability.reviewerRoles?.length ? `roles ${observability.reviewerRoles.join(",")}` : "",
    observability.latestArtifacts?.buildResult ? `BuildResult ${observability.latestArtifacts.buildResult}` : "",
    observability.latestArtifacts?.reviewVerdict ? `ReviewVerdict ${observability.latestArtifacts.reviewVerdict}` : "",
    observability.remainingRemediationCycles !== undefined ? `remaining ${observability.remainingRemediationCycles}` : "",
  ].filter(Boolean).join(" · ");
}

function toolCallPreview(value: string): string {
  return value.length > 12 ? value.slice(-12) : value;
}

function toolArgPreview(tool: string, args: unknown): string | undefined {
  if (tool === "submit_artifact" || !args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const values = args as Record<string, unknown>;
  const parts = TOOL_ARG_KEYS.flatMap((key) => {
    const value = scalar(values[key]);
    return value === undefined ? [] : [`${key}=${value}`];
  });
  if (!parts.length) return undefined;
  const preview = parts.join(" ");
  return preview.length <= MAX_ARG_PREVIEW ? preview : `${preview.slice(0, MAX_ARG_PREVIEW - 1)}…`;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return JSON.stringify(sanitizeTerminalText(value));
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}
