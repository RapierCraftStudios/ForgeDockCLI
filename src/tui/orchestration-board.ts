// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { OrchestrationEvent, OrchestrationIssueSlots, OrchestrationNode, OrchestrationRoute, OrchestrationSnapshot } from "../workflows/orchestrate/events.js";
import type { ScheduledStatus } from "../workflows/orchestrate/scheduler.js";
import { renderSerializationLines, renderWaitReason } from "../workflows/orchestrate/view-model.js";

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
  /** Structured proposal projection; absent in legacy extension results. */
  snapshot?: OrchestrationSnapshot;
  issueSlots?: OrchestrationIssueSlots;
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
  selectedIssueNumbers?: readonly number[];
  workUnitCount?: number;
  initialReadyCount?: number;
  maxParallel?: number;
  issueSlots?: OrchestrationIssueSlots;
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
      const expiry = view.expiresAt ? formatPreviewDeadline(view.expiresAt) : "no confirmation checkpoint";
      lines.push(truncateToWidth(`◇ ${invocationLabel} · preview · ${expiry}`, width));
      const slots = view.issueSlots ?? view.snapshot?.issueSlots;
      lines.push(truncateToWidth(`  ${formatOrchestrationIssueSlots(slots, view.selectedIssueNumbers.length, view.maxParallel)}`, width));
      if (view.snapshot) {
        for (const node of view.snapshot.nodes) lines.push(truncateToWidth(`  ${renderNodeRow(node, theme)}`, width));
        for (const line of renderSerializationLines(view.snapshot)) lines.push(truncateToWidth(`  ${line}`, width));
      }
    }

    const records = [...this.records.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.orchestrationId.localeCompare(right.orchestrationId))
      .slice(0, MAX_DAG_ROWS);
    for (const record of records) {
      const completed = record.snapshot.nodes.filter((node) => node.status === "completed").length;
      const terminal = record.snapshot.nodes.filter((node) => ["completed", "skipped", "failed", "blocked", "invalid"].includes(node.status)).length;
      const active = record.snapshot.nodes.filter((node) => node.status === "running").length;
      const total = record.snapshot.nodes.length;
      const progress = record.phase === "completed" ? `${completed}/${total} complete` : `${terminal}/${total} terminal`;
      lines.push(truncateToWidth(`${phaseGlyph(record.phase, theme)} ${record.orchestrationId} · ${record.phase} · ${progress}${active ? ` · ${active} active` : ""}`, width));
      lines.push(truncateToWidth(`  ${formatOrchestrationIssueSlots(record.snapshot.issueSlots, selectedIssueCount(record.snapshot), undefined)}`, width));
      for (const node of record.snapshot.nodes) lines.push(truncateToWidth(`  ${renderNodeRow(node, theme)}`, width));
      for (const line of renderSerializationLines(record.snapshot)) lines.push(truncateToWidth(`  ${line}`, width));
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
      records: [...this.records.values()].map((record) => ({
        orchestrationId: record.orchestrationId,
        phase: record.phase,
        repository: record.repository,
        summary: record.summary,
        updatedAt: record.updatedAt,
        // Include every rendered scheduling fact. In particular, capacity and
        // wait reasons may change at the same durable timestamp in test/adaptor
        // projections and must still invalidate the widget.
        snapshot: record.snapshot,
      })),
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
  const deadlineMs = Date.parse(expiresAt);
  if (!Number.isFinite(deadlineMs)) return "confirmation window unavailable · fresh preview required · deadline unknown";
  const deadline = new Date(deadlineMs).toISOString();
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) {
    const elapsedSeconds = Math.floor(Math.abs(remaining) / 1_000);
    const minutes = Math.floor(elapsedSeconds / 60);
    const elapsed = `${minutes}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
    return `confirmation window elapsed ${elapsed} ago · fresh preview required · deadline ${deadline}`;
  }
  const seconds = Math.ceil(remaining / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `confirmation window ${minutes}:${String(seconds % 60).padStart(2, "0")} remaining · deadline ${deadline}`;
}

export function formatOrchestrationIssueSlots(
  slots: OrchestrationIssueSlots | undefined,
  selectedFallback: number,
  requestedFallback: number | undefined,
): string {
  const selected = slots?.selected ?? selectedFallback;
  const runnable = slots?.runnableNow ?? "unknown";
  const requested = slots?.requestedCap ?? requestedFallback ?? "unknown";
  const transport = slots?.transportCap ?? "not sampled";
  const effective = slots?.effectiveCap ?? requested;
  return `Issue slots: ${selected} selected · ${runnable} runnable now · requested cap ${requested} · transport cap ${transport} · effective cap ${effective}`;
}

export function formatOrchestrationRoute(route: OrchestrationRoute): string {
  return `${route.repository ?? "repository?"}@${route.targetBranch ?? "target?"}${route.lane ? `(${route.lane})` : ""}`;
}

function renderNodeRow(node: OrchestrationNode, theme: Theme): string {
  const members = (node.memberIssues?.length ?? 0) > 1
    ? ` · members=${node.memberIssues.map((issue) => `#${issue}`).join(",")}`
    : "";
  const title = node.title ? ` · ${safeInline(node.title)}` : "";
  const dependencies = ` · semantic-deps=${node.dependencies?.length ? node.dependencies.join(",") : "none"}`;
  const route = node.route
    ? ` · route=${formatOrchestrationRoute(node.route)}`
    : "";
  const wait = node.waitReason ? ` · wait=${renderWaitReason(node.waitReason)}` : "";
  const error = node.error ? ` · ${safeInline(node.error)}` : "";
  return `${statusGlyph(node.status, theme)} #${node.issue} ${node.status}${members}${title}${dependencies}${route}${wait}${error}`;
}

function selectedIssueCount(snapshot: OrchestrationSnapshot): number {
  return snapshot.selectedIssueNumbers?.length
    ?? new Set(snapshot.nodes.flatMap((node) => node.memberIssues?.length ? [...node.memberIssues] : [node.issue])).size;
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
    case "target_recovery": return theme.fg("warning", "↻");
    case "retry_wait": return theme.fg("warning", "…");
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
