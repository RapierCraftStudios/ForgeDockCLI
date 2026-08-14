// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { OrchestrationEvent, OrchestrationSnapshot } from "../workflows/orchestrate/events.js";
import type { ScheduledStatus } from "../workflows/orchestrate/scheduler.js";

export const FORGEDOCK_ORCHESTRATION_WIDGET_KEY = "forgedock-orchestration-board";

export type OrchestrationUiPhase =
  | "resolving"
  | "preview"
  | "awaiting-confirmation"
  | "dispatching"
  | "delegated"
  | "active"
  | "completed"
  | "failed"
  | "blocked"
  | "suspended"
  | "invalid"
  | "checkpoint-expired"
  | "detached";

export interface OrchestrationPreviewView {
  checkpoint: boolean;
  expiresAt?: string;
  repository?: string;
  selectedIssueNumbers: readonly number[];
  workUnitCount: number;
  maxParallel: number;
  batching: "aggressive" | "conservative" | "none";
  scopeExpansion: "scope-locked" | "recursive";
  autoMerge: boolean;
}

export interface OrchestrationToolView {
  schemaVersion: 1;
  phase: OrchestrationUiPhase;
  invocationLabel: string;
  repository?: string;
  selectedIssueCount?: number;
  workUnitCount?: number;
  initialReadyCount?: number;
  maxParallel?: number;
  batching?: "aggressive" | "conservative" | "none";
  scopeExpansion?: "scope-locked" | "recursive";
  autoMerge?: boolean;
  orchestrationId?: string;
  preview?: OrchestrationPreviewView;
  snapshot?: OrchestrationSnapshot;
  summary?: string;
}

export type OrchestrationBoardPhase = Exclude<OrchestrationUiPhase, "resolving" | "preview" | "awaiting-confirmation" | "dispatching" | "delegated">;

type BoardRecord = {
  orchestrationId: string;
  phase: OrchestrationBoardPhase;
  invocationLabel: string;
  snapshot: OrchestrationSnapshot;
  repository?: string;
  summary?: string;
  updatedAt: string;
};

type BoardTui = { requestRender(): void };
type Theme = ExtensionContext["ui"]["theme"];

const REFRESH_MS = 1_000;
const MAX_NODE_ROWS_PER_DAG = 4;
const MAX_DAG_ROWS = 8;

export function formatOrchestrationInvocationLabel(command: string, rawArgs: string): string {
  const safe = rawArgs
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const suffix = safe.length > 120 ? `${safe.slice(0, 119)}…` : safe;
  return `/${command}${suffix ? ` ${suffix}` : ""}`;
}

export function orchestrationTerminalPhase(snapshot: OrchestrationSnapshot): OrchestrationBoardPhase {
  const statuses = snapshot.nodes.map((node) => node.status);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("suspended")) return "suspended";
  if (statuses.includes("invalid")) return "invalid";
  return "completed";
}

export class OrchestrationBoardController {
  private ctx: ExtensionContext | undefined;
  private ui: ExtensionContext["ui"] | undefined;
  private tui: BoardTui | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private widgetRegistered = false;
  private lastRenderKey = "";
  private disposed = false;
  private preview: { invocationLabel: string; view: OrchestrationPreviewView } | undefined;
  private readonly records = new Map<string, BoardRecord>();

  attach(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    this.disposed = false;
    if (this.ui !== ctx.ui) this.clearUiRegistration();
    this.ctx = ctx;
    this.ui = ctx.ui;
    if (!this.timer) {
      this.timer = setInterval(() => this.refresh(), REFRESH_MS);
      this.timer.unref?.();
    }
    this.refresh();
  }

  showPreview(invocationLabel: string, view: OrchestrationPreviewView): void {
    if (this.disposed) return;
    this.preview = { invocationLabel, view };
    this.refresh();
  }

  clearPreview(): void {
    if (this.disposed) return;
    this.preview = undefined;
    this.refresh();
  }

  updateEvent(event: OrchestrationEvent, invocationLabel: string, repository?: string): void {
    if (this.disposed) return;
    const previous = this.records.get(event.orchestrationId);
    if (previous && event.at < previous.updatedAt) return;
    const record: BoardRecord = {
      orchestrationId: event.orchestrationId,
      phase: "active",
      invocationLabel: previous?.invocationLabel ?? invocationLabel,
      snapshot: event.snapshot,
      ...(previous?.repository !== undefined ? { repository: previous.repository } : repository !== undefined ? { repository } : {}),
      ...(previous?.summary !== undefined ? { summary: previous.summary } : {}),
      updatedAt: event.at,
    };
    this.records.set(event.orchestrationId, record);
    this.refresh();
  }

  complete(
    orchestrationId: string,
    phase: OrchestrationBoardPhase,
    snapshot: OrchestrationSnapshot,
    invocationLabel: string,
    repository?: string,
    summary?: string,
  ): void {
    if (this.disposed) return;
    const previous = this.records.get(orchestrationId);
    const record: BoardRecord = {
      orchestrationId,
      phase,
      invocationLabel: previous?.invocationLabel ?? invocationLabel,
      snapshot,
      ...(previous?.repository !== undefined ? { repository: previous.repository } : repository !== undefined ? { repository } : {}),
      ...(summary !== undefined ? { summary } : previous?.summary !== undefined ? { summary: previous.summary } : {}),
      updatedAt: snapshot.updatedAt,
    };
    this.records.set(orchestrationId, record);
    this.refresh();
  }

  detach(): void {
    if (this.disposed) return;
    for (const [orchestrationId, record] of this.records) {
      if (record.phase === "active") this.records.set(orchestrationId, { ...record, phase: "detached" });
    }
    this.refresh();
  }

  dispose(): void {
    this.disposed = true;
    this.clearUiRegistration();
    this.ctx = undefined;
    this.ui = undefined;
    this.preview = undefined;
    this.records.clear();
  }

  private refresh(): void {
    if (this.disposed) return;
    const ctx = this.getActiveContext();
    if (!ctx) return;
    if (!this.preview && this.records.size === 0) {
      this.clearWidget(ctx);
      return;
    }

    const renderKey = this.getRenderKey();
    if (!this.widgetRegistered) {
      ctx.ui.setWidget(FORGEDOCK_ORCHESTRATION_WIDGET_KEY, (tui, theme) => {
        this.tui = tui;
        return {
          render: (width: number) => this.render(width, theme),
          invalidate: () => {
            this.lastRenderKey = "";
          },
          dispose: () => {
            if (this.tui !== tui) return;
            this.widgetRegistered = false;
            this.tui = undefined;
          },
        };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
      this.lastRenderKey = renderKey;
      return;
    }
    if (renderKey === this.lastRenderKey) return;
    this.lastRenderKey = renderKey;
    this.tui?.requestRender();
  }

  private render(width: number, theme: Theme): string[] {
    const lines: string[] = [theme.fg("toolTitle", theme.bold("ForgeDock orchestrations"))];
    if (this.preview) {
      const { invocationLabel, view } = this.preview;
      const expiry = view.expiresAt ? formatPreviewDeadline(view.expiresAt) : "no checkpoint";
      lines.push(truncateToWidth(`◇ ${invocationLabel} · preview · ${expiry}`, width));
      lines.push(truncateToWidth(`  ${view.selectedIssueNumbers.length} issue(s) → ${view.workUnitCount} work unit(s) · max parallel ${view.maxParallel}`, width));
    }

    const records = [...this.records.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.orchestrationId.localeCompare(right.orchestrationId))
      .slice(0, MAX_DAG_ROWS);
    for (const record of records) {
      const completed = record.snapshot.nodes.filter((node) => node.status === "completed").length;
      const terminal = record.snapshot.nodes.filter((node) => !["queued", "running"].includes(node.status)).length;
      const active = record.snapshot.nodes.filter((node) => node.status === "running").length;
      const total = record.snapshot.nodes.length;
      const progress = record.phase === "completed" ? `${completed}/${total} complete` : `${terminal}/${total} terminal`;
      lines.push(truncateToWidth(`${phaseGlyph(record.phase, theme)} ${record.orchestrationId} · ${record.phase} · ${progress}${active ? ` · ${active} active` : ""}`, width));
      for (const node of record.snapshot.nodes.slice(0, MAX_NODE_ROWS_PER_DAG)) {
        const dependencies = node.dependencies.length ? ` · deps=${node.dependencies.join(",")}` : "";
        const error = node.error ? ` · ${safeInline(node.error)}` : "";
        lines.push(truncateToWidth(`  ${statusGlyph(node.status, theme)} #${node.issue} ${node.status}${dependencies}${error}`, width));
      }
      if (record.snapshot.nodes.length > MAX_NODE_ROWS_PER_DAG) {
        lines.push(truncateToWidth(`  … ${record.snapshot.nodes.length - MAX_NODE_ROWS_PER_DAG} more node(s)`, width));
      }
    }
    return lines.map((line) => truncateToWidth(line, width));
  }

  private getRenderKey(): string {
    const now = this.preview?.view.expiresAt ? Math.floor(Date.now() / 1_000) : 0;
    return JSON.stringify({
      now,
      preview: this.preview ? {
        label: this.preview.invocationLabel,
        view: this.preview.view,
      } : undefined,
      records: [...this.records.values()].map((record) => [
        record.orchestrationId,
        record.phase,
        record.updatedAt,
        record.snapshot.nodes.map((node) => [node.id, node.status, node.error]),
      ]),
    });
  }

  private getActiveContext(): ExtensionContext | undefined {
    const ctx = this.ctx;
    if (!ctx) return undefined;
    try {
      return ctx.hasUI ? ctx : undefined;
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
      this.clearUiRegistration();
      return undefined;
    }
  }

  private clearWidget(ctx: ExtensionContext): void {
    if (!this.widgetRegistered) return;
    try {
      ctx.ui.setWidget(FORGEDOCK_ORCHESTRATION_WIDGET_KEY, undefined);
    } catch (error) {
      if (!isStaleExtensionContextError(error)) throw error;
    }
    this.widgetRegistered = false;
    this.tui = undefined;
    this.lastRenderKey = "";
  }

  private clearUiRegistration(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;

    const ctx = this.ctx;
    if (ctx && this.widgetRegistered) this.clearWidget(ctx);
    this.ctx = undefined;
    this.ui = undefined;
    this.tui = undefined;
  }
}

export function formatPreviewDeadline(expiresAt: string): string {
  const remaining = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(remaining)) return "checkpoint deadline unknown";
  if (remaining <= 0) return "deadline reached";
  const seconds = Math.ceil(remaining / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `expires in ${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function phaseGlyph(phase: OrchestrationBoardPhase, theme: Theme): string {
  if (phase === "completed") return theme.fg("success", "✓");
  if (phase === "failed" || phase === "invalid") return theme.fg("error", "✕");
  if (phase === "blocked") return theme.fg("error", "■");
  if (phase === "detached") return theme.fg("dim", "◇");
  return theme.fg("warning", "◆");
}

function statusGlyph(status: ScheduledStatus, theme: Theme): string {
  switch (status) {
    case "completed": return theme.fg("success", "✓");
    case "running": return theme.fg("warning", "◆");
    case "blocked": return theme.fg("error", "■");
    case "failed": return theme.fg("error", "✕");
    case "invalid": return theme.fg("error", "!");
    case "skipped": return theme.fg("muted", "↷");
    case "suspended": return theme.fg("warning", "Ⅱ");
    default: return theme.fg("dim", "·");
  }
}

function safeInline(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error
    && (error.message.includes("This extension ctx is stale")
      || error.message.includes("Extension context no longer active"));
}
