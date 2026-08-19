// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatOrchestrationIssueSlots, formatPreviewDeadline, type OrchestrationToolView } from "./orchestration-board.js";
import { renderOrchestrationBoard } from "../workflows/orchestrate/view-model.js";

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

type ToolPresentation = Pick<ToolDefinition, "renderShell" | "renderCall" | "renderResult">;
type ToolCallArgs = Parameters<NonNullable<ToolPresentation["renderCall"]>>[0];
type ToolTheme = Parameters<NonNullable<ToolPresentation["renderCall"]>>[1];
type ToolContext = Parameters<NonNullable<ToolPresentation["renderCall"]>>[2];
type ToolResultOptions = Parameters<NonNullable<ToolPresentation["renderResult"]>>[1];

/** Render-only presentation for ForgeDock semantic tools. */
export function forgeDockToolPresentation(label: string): ToolPresentation {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderToolCall(label, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const output = collectText(result);
      return renderToolResultText(output, options, theme, context);
    },
  };
}

/** Presentation for the orchestration preview and post-delegation handoff. */
export function forgeDockOrchestrateToolPresentation(label = "ForgeDock orchestrate"): ToolPresentation {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderToolCall(label, args, theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = (result as { details?: unknown }).details;
      const view = orchestrationView(details);
      const output = sanitizeOrchestrationOutput(collectText(result), details);
      const summary = view ? renderOrchestrationSummary(view) : "";
      return renderToolResultText(summary ? `${summary}${output ? `\n${output}` : ""}` : output, options, theme, context, view !== undefined);
    },
  };
}

function renderToolResultText(
  output: string,
  options: ToolResultOptions,
  theme: ToolTheme,
  context: ToolContext,
  preserveAllLines = false,
): Text {
  if (!output) return new Text("", 0, 0);

  const allLines = output.split(/\r?\n/);
  const live = options.isPartial;
  const limit = preserveAllLines || options.expanded ? allLines.length : live ? LIVE_RESULT_LINES : COLLAPSED_RESULT_LINES;
  const lines = live ? allLines.slice(-limit) : allLines.slice(0, limit);
  const omitted = Math.max(0, allLines.length - lines.length);
  const color = context.isError ? "error" : live ? "toolOutput" : "muted";
  let text = lines.map((line: string) => `│ ${theme.fg(color, line)}`).join("\n");
  if (omitted > 0) {
    const direction = live ? "earlier" : "more";
    text += `\n│ ${theme.fg("dim", `… ${omitted} ${direction} line${omitted === 1 ? "" : "s"} · Ctrl+O to expand`)}`;
  }
  return new Text(text, 1, 0);
}

function collectText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => Boolean(item)
      && typeof item === "object"
      && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string")
    .map((item) => item.text)
    .join("\n")
    .trimEnd();
}

function orchestrationView(details: unknown): OrchestrationToolView | undefined {
  if (!details || typeof details !== "object") return undefined;
  const view = (details as { ui?: unknown }).ui;
  if (!view || typeof view !== "object" || (view as { schemaVersion?: unknown }).schemaVersion !== 1) return undefined;
  return view as OrchestrationToolView;
}

function sanitizeOrchestrationOutput(output: string, details: unknown): string {
  const previewToken = details && typeof details === "object" && typeof (details as { previewToken?: unknown }).previewToken === "string"
    ? (details as { previewToken: string }).previewToken
    : undefined;
  return output
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("FORGEDOCK_PREVIEW_CONTINUATION "))
    .map((line) => previewToken ? line.split(previewToken).join("[internal preview token redacted]") : line)
    .join("\n")
    .trimEnd();
}

function renderOrchestrationSummary(view: OrchestrationToolView): string {
  const lines: string[] = [];
  if (view.phase === "preview" || view.phase === "awaiting-confirmation") {
    lines.push(`ForgeDock orchestration ${view.phase === "preview" ? "preview" : "awaiting confirmation"}`);
    if (view.repository) lines.push(`Repository: ${view.repository}`);
    if (view.selectedIssueCount !== undefined || view.workUnitCount !== undefined) {
      lines.push(`${view.selectedIssueCount ?? "?"} issue(s) → ${view.workUnitCount ?? "?"} work unit(s)`);
    }
    if (view.preview?.expiresAt) lines.push(`Confirmation: ${formatPreviewDeadline(view.preview.expiresAt)}`);
  } else {
    if (view.phase === "dispatching") lines.push("ForgeDock orchestration dispatching");
    if (view.phase === "delegated") lines.push(`ForgeDock orchestration delegated${view.orchestrationId ? `: ${view.orchestrationId}` : ""}`);
    if (view.phase === "active") lines.push(`ForgeDock orchestration active${view.orchestrationId ? `: ${view.orchestrationId}` : ""}`);
    if (view.phase === "completed") lines.push(`ForgeDock orchestration complete${view.orchestrationId ? `: ${view.orchestrationId}` : ""}`);
    if (view.phase === "failed" || view.phase === "blocked" || view.phase === "suspended" || view.phase === "invalid") {
      lines.push(`ForgeDock orchestration ${view.phase}${view.orchestrationId ? `: ${view.orchestrationId}` : ""}`);
    }
    if (view.phase === "detached") lines.push("Live DAG display detached; durable state remains authoritative.");
  }
  const snapshot = view.snapshot ?? view.preview?.snapshot;
  const slots = view.issueSlots ?? snapshot?.issueSlots ?? view.preview?.issueSlots;
  if (!snapshot && slots) {
    lines.push(formatOrchestrationIssueSlots(slots, slots.selected, view.maxParallel ?? view.preview?.maxParallel));
  } else if (!snapshot && view.maxParallel !== undefined) {
    lines.push(formatOrchestrationIssueSlots(undefined, view.selectedIssueCount ?? 0, view.maxParallel));
  }
  if (snapshot) lines.push(renderOrchestrationBoard(snapshot));
  if (view.summary) lines.push(view.summary);
  return lines.join("\n");
}

function renderToolCall(label: string, args: ToolCallArgs, theme: ToolTheme, context: ToolContext): Text {
  const suffix = summarizeArgs(args);
  const status = context.isError
    ? theme.fg("error", "✕")
    : context.executionStarted
      ? context.isPartial ? theme.fg("warning", "●") : theme.fg("success", "✓")
      : theme.fg("dim", "○");
  return new Text(`${status} ${theme.fg("toolTitle", theme.bold(label))}${suffix ? ` ${theme.fg("muted", suffix)}` : ""}`, 1, 0);
}

function summarizeArgs(value: ToolCallArgs): string {
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
