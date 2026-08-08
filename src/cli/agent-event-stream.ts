// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentEvent } from "../runtime/agent-runtime.js";
import { statusGlyph, type ColorMode } from "../tui/brand.js";

const TOOL_ARG_KEYS = ["path", "file_path", "pattern", "query", "glob", "command", "offset", "limit"] as const;
const MAX_ARG_PREVIEW = 240;

export type AgentEventWrite = (text: string) => void;

/**
 * Projects bounded AgentRuntime activity into the controller's stdout stream.
 * The parent semantic tool forwards this stream into the selected fleet worker,
 * so SDK-owned inner sessions remain observable without weakening controller
 * authority or exposing complete tool payloads.
 */
export class AgentEventStreamWriter {
  readonly #write: AgentEventWrite;
  readonly #mode: ColorMode;
  #stream: { task: string; kind: "assistant" | "thinking"; lineOpen: boolean } | undefined;

  constructor(write: AgentEventWrite, mode: ColorMode) {
    this.#write = write;
    this.#mode = mode;
  }

  write(event: AgentEvent, prefix?: string): void {
    const task = prefix ? `${prefix} · ${event.taskId}` : event.taskId;
    if (event.type === "text.delta" || event.type === "thinking.delta") {
      this.writeDelta(task, event.type === "thinking.delta" ? "thinking" : "assistant", event.text);
      return;
    }

    this.finishDelta();
    if (event.type === "session.started") {
      this.#write(`  ${statusGlyph("active", this.#mode)} ${task} · ${event.provider}/${event.model}\n`);
    } else if (event.type === "tool.started") {
      const args = toolArgPreview(event.tool, event.args);
      this.#write(`    ${statusGlyph("active", this.#mode)} ${task} · ${event.tool}${args ? ` · ${args}` : ""}\n`);
    } else if (event.type === "tool.completed") {
      const status = event.isError ? "failed" : "passed";
      this.#write(`    ${statusGlyph(status, this.#mode)} ${task} · ${event.tool} ${event.isError ? "failed" : "complete"}\n`);
    } else if (event.type === "artifact.submitted") {
      this.#write(`  ${statusGlyph("passed", this.#mode)} ${task} · artifact submitted\n`);
    } else if (event.type === "session.completed") {
      this.#write(`  ${statusGlyph("passed", this.#mode)} ${task} · session complete\n`);
    }
  }

  finish(): void {
    this.finishDelta();
  }

  private writeDelta(task: string, kind: "assistant" | "thinking", rawText: string): void {
    if (!rawText) return;
    if (!this.#stream || this.#stream.task !== task || this.#stream.kind !== kind) {
      this.finishDelta();
      this.#write(`    ${statusGlyph("active", this.#mode)} ${task} · ${kind}\n`);
      this.#stream = { task, kind, lineOpen: false };
    }

    const text = rawText.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
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
  if (typeof value === "string" && value.trim()) return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}
