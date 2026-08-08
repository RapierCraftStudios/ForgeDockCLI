// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ARG_KEYS = [
  "action",
  "issue",
  "issueNumbers",
  "pullRequest",
  "taskId",
  "orchestrationId",
  "query",
  "maxParallel",
  "throughInvestigation",
  "dryRun",
  "autoMerge",
  "resume",
] as const;
const COLLAPSED_RESULT_LINES = 6;
const LIVE_RESULT_LINES = 14;

/** Render-only presentation for ForgeDock semantic tools. */
export function forgeDockToolPresentation(label: string): Pick<ToolDefinition, "renderShell" | "renderCall" | "renderResult"> {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const suffix = summarizeArgs(args);
      const status = context.executionStarted
        ? context.isPartial ? theme.fg("warning", "●") : theme.fg("success", "✓")
        : theme.fg("dim", "○");
      return new Text(`${status} ${theme.fg("toolTitle", theme.bold(label))}${suffix ? ` ${theme.fg("muted", suffix)}` : ""}`, 1, 0);
    },
    renderResult(result, options, theme, context) {
      const output = result.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n")
        .trimEnd();
      if (!output) return new Text("", 0, 0);

      const allLines = output.split(/\r?\n/);
      const live = options.isPartial;
      const limit = options.expanded ? allLines.length : live ? LIVE_RESULT_LINES : COLLAPSED_RESULT_LINES;
      const lines = live ? allLines.slice(-limit) : allLines.slice(0, limit);
      const omitted = Math.max(0, allLines.length - lines.length);
      const color = context.isError ? "error" : live ? "toolOutput" : "muted";
      let text = lines.map((line) => `│ ${theme.fg(color, line)}`).join("\n");
      if (omitted > 0) {
        const direction = live ? "earlier" : "more";
        text += `\n│ ${theme.fg("dim", `… ${omitted} ${direction} line${omitted === 1 ? "" : "s"} · Ctrl+O to expand`)}`;
      }
      return new Text(text, 1, 0);
    },
  };
}

function summarizeArgs(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const args = value as Record<string, unknown>;
  return ARG_KEYS.flatMap((key) => {
    const rendered = renderValue(args[key]);
    return rendered === undefined ? [] : [`${key}=${rendered}`];
  }).join(" ");
}

function renderValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return JSON.stringify(value.length > 80 ? `${value.slice(0, 79)}…` : value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "number" || typeof item === "string")) {
    const shown = value.slice(0, 8).join(",");
    return `[${shown}${value.length > 8 ? ",…" : ""}]`;
  }
  return undefined;
}
