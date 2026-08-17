// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Component, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import type { ObservationEnvelopeV1, ObservationIdentity } from "../observability/contracts.js";
import type { ForgeDockObservationControlGateway } from "../observability/control-gateway.js";
import { ForgeDockObserver } from "../observability/observer.js";
import type { ObservedEntity, ObservationProjectionSnapshot } from "../observability/projections.js";

export interface ObserverWorkspaceOptions {
  initialEntityId?: string;
  gateway?: ForgeDockObservationControlGateway;
  markdownTheme?: MarkdownTheme;
}

type WorkspaceTab = "overview" | "events" | "output" | "attention" | "health";

/** Renderer-neutral observer workspace; closing it never affects a running task. */
export class ForgeDockObserverWorkspace implements Component {
  readonly #observer: ForgeDockObserver;
  readonly #gateway: ForgeDockObservationControlGateway | undefined;
  readonly #done: (result: undefined) => void;
  readonly #requestRender: () => void;
  readonly #theme: ExtensionContext["ui"]["theme"];
  readonly #markdownTheme: MarkdownTheme | undefined;
  readonly #unsubscribe: { unsubscribe(): void };
  #snapshot: ObservationProjectionSnapshot;
  #selected = 0;
  #selectedKey: string | undefined;
  #tab: WorkspaceTab = "overview";
  #follow = true;
  #detailScroll = 0;
  #confirmCancel = false;
  #actionMessage?: string;
  #disposed = false;
  #bodyHeight = 8;
  #detailHeight = 8;

  constructor(
    observer: ForgeDockObserver,
    theme: ExtensionContext["ui"]["theme"],
    done: (result: undefined) => void,
    options: ObserverWorkspaceOptions = {},
    requestRender: () => void = () => undefined,
  ) {
    this.#observer = observer;
    this.#gateway = options.gateway;
    this.#done = done;
    this.#requestRender = requestRender;
    this.#theme = theme;
    this.#markdownTheme = options.markdownTheme;
    this.#snapshot = observer.snapshot();
    this.#selectedKey = options.initialEntityId;
    this.selectPreservingKey();
    this.#unsubscribe = observer.subscribe(() => {
      if (this.#disposed) return;
      this.#snapshot = observer.snapshot();
      this.selectPreservingKey();
      this.#requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.#confirmCancel) {
      if (matchesKey(data, "escape") || data.toLowerCase() === "n") {
        this.#confirmCancel = false;
        this.#actionMessage = "Cancellation cancelled";
        return;
      }
      if (matchesKey(data, "return") || data.toLowerCase() === "y") {
        this.#confirmCancel = false;
        void this.cancelSelected();
        return;
      }
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.#done(undefined);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.#selected = Math.max(0, this.#selected - 1);
      this.#selectedKey = this.#snapshot.entities[this.#selected]?.id;
      this.#detailScroll = 0;
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.#selected = Math.min(Math.max(0, this.#snapshot.entities.length - 1), this.#selected + 1);
      this.#selectedKey = this.#snapshot.entities[this.#selected]?.id;
      this.#detailScroll = 0;
      return;
    }
    if (matchesKey(data, "tab") || data === "\t") {
      this.#tab = nextTab(this.#tab);
      this.#detailScroll = 0;
      return;
    }
    if (data.toLowerCase() === "f") {
      this.#follow = !this.#follow;
      this.#actionMessage = this.#follow ? "Following latest events" : "Follow paused";
      return;
    }
    if (data.toLowerCase() === "a") {
      const attention = this.#snapshot.attention[0];
      if (attention) {
        const index = this.#snapshot.entities.findIndex((entity) => entity.id === attention.entityId);
        if (index >= 0) {
          this.#selected = index;
          this.#selectedKey = attention.entityId;
        }
        this.#tab = "attention";
      } else this.#actionMessage = "No unresolved attention items";
      return;
    }
    if (data.toLowerCase() === "r") {
      void this.resumeSelected();
      return;
    }
    if (data === "D" || data.toLowerCase() === "x") {
      if (!this.#gateway) this.#actionMessage = "No semantic control gateway is configured";
      else this.#confirmCancel = true;
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, Key.shift("k"))) {
      this.#detailScroll = Math.max(0, this.#detailScroll - this.#detailHeight);
      this.#follow = false;
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, Key.shift("j"))) {
      this.#detailScroll += this.#detailHeight;
      this.#follow = false;
    }
  }

  render(width: number): string[] {
    if (width < 80) return [truncateToWidth("ForgeDock observer needs at least 80 columns. Esc closes.", width)];
    const rows = 32;
    this.#bodyHeight = Math.max(6, Math.min(30, rows - 8));
    const innerWidth = width - 2;
    const treeWidth = Math.max(28, Math.floor(innerWidth * 0.3));
    const attentionWidth = Math.max(22, Math.floor(innerWidth * 0.22));
    const detailWidth = Math.max(20, innerWidth - treeWidth - attentionWidth - 2);
    const tree = this.treeLines(treeWidth);
    const detail = this.detailLines(detailWidth);
    const attention = this.attentionLines(attentionWidth);
    this.#detailHeight = Math.max(1, this.#bodyHeight - 2);
    const maxScroll = Math.max(0, detail.length - this.#detailHeight);
    if (this.#follow) this.#detailScroll = maxScroll;
    else this.#detailScroll = Math.min(this.#detailScroll, maxScroll);
    const detailVisible = detail.slice(this.#detailScroll, this.#detailScroll + this.#detailHeight);
    const lines = [
      this.borderLine(innerWidth, "╭", "╮"),
      this.cellLine(innerWidth, ` ForgeDock Observer ${this.#theme.fg("dim", `· ${this.#tab}`)}`, this.selectedStatus(), "", treeWidth, detailWidth, attentionWidth),
      this.borderLine(innerWidth, "├", "┤", "┬", "┬"),
    ];
    for (let index = 0; index < this.#bodyHeight; index++) {
      lines.push(this.rowLine(tree[index] ?? "", detailVisible[index] ?? "", attention[index] ?? "", treeWidth, detailWidth, attentionWidth));
    }
    lines.push(this.borderLine(innerWidth, "├", "┤", "┴", "┴"));
    const footer = `${this.#actionMessage ? `${this.#actionMessage} · ` : ""}↑↓ select · Tab pane · f follow:${this.#follow ? "on" : "off"} · a attention · r resume · D cancel · Esc close`;
    lines.push(this.singleLine(innerWidth, footer));
    lines.push(this.borderLine(innerWidth, "╰", "╯"));
    if (this.#confirmCancel) lines.splice(1, 0, this.singleLine(innerWidth, "Confirm semantic cancellation? Enter/Y confirms · N/Esc cancels"));
    return lines.map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {
    this.#snapshot = this.#observer.snapshot();
    this.selectPreservingKey();
  }

  dispose(): void {
    this.#disposed = true;
    this.#unsubscribe.unsubscribe();
  }

  private treeLines(width: number): string[] {
    if (!this.#snapshot.entities.length) return [this.#theme.fg("dim", "No observed entities")];
    return this.#snapshot.entities.slice(0, this.#bodyHeight).map((entity, index) => {
      const selected = index === this.#selected;
      const prefix = entity.parentId ? "  └─ " : "";
      const state = entity.workflow.state !== "unknown" ? entity.workflow.state : entity.process.state;
      const attention = entity.attention.level === "blocker" ? "!" : entity.attention.level === "action-required" ? "?" : "·";
      const label = `${selected ? "›" : " "} ${attention} ${prefix}${entity.label}`;
      const suffix = ` ${state}${entity.childCount ? ` (+${entity.childCount})` : ""}`;
      return fitLine(this.#theme.fg(selected ? "accent" : "muted", label) + this.#theme.fg("dim", suffix), width);
    });
  }

  private detailLines(width: number): string[] {
    const entity = this.selectedEntity();
    if (this.#tab === "attention") return this.#snapshot.attention.length ? this.#snapshot.attention.flatMap((item) => [`${item.level.toUpperCase()} · ${item.reason}`, `  entity: ${item.entityId}`, `  created: ${item.createdAt}`, ""]) : ["No unresolved attention items"];
    if (this.#tab === "events") return this.#snapshot.timeline.map((entry) => `${entry.event.occurredAt.slice(11, 19)} ${entry.event.channel.toUpperCase().padEnd(10)} ${entry.summary}`);
    if (this.#tab === "output") return this.#snapshot.output.map((event) => `${event.occurredAt.slice(11, 19)} ${event.channel.toUpperCase().padEnd(7)} ${payloadText(event)}`);
    if (this.#tab === "health") return entity ? [
      `Entity: ${entity.label}`,
      `Process: ${entity.process.state}`,
      `Last heartbeat: ${entity.process.lastHeartbeatAt ?? "unknown"}`,
      `Last event: ${entity.lastEventAt}`,
      `Sequence: ${entity.lastSequence}`,
      entity.outputLoss?.truncated ? "Output: truncated" : "Output: complete",
      ...identityLines(entity.identity),
    ] : ["No entity selected"];
    return entity ? [
      `${entity.label} · ${entity.workflow.state} · ${entity.activity.kind}`,
      `Phase: ${entity.workflow.phase}`,
      `Activity: ${entity.activity.summary ?? "none"}`,
      `Process: ${entity.process.state}`,
      `Last event: ${entity.lastEventAt}`,
      entity.attention.level !== "none" ? `Attention: ${entity.attention.level} · ${entity.attention.reason ?? ""}` : "Attention: none",
      "",
      "Use Tab to inspect events, output, attention, or health.",
    ].flatMap((line) => wrapTextWithAnsi(line, width)) : ["No entity selected"];
  }

  private attentionLines(width: number): string[] {
    if (!this.#snapshot.attention.length) return [this.#theme.fg("dim", "No attention")];
    return this.#snapshot.attention.slice(0, this.#bodyHeight).flatMap((item) => wrapTextWithAnsi(`${item.level.toUpperCase()}: ${item.reason}`, width));
  }

  private selectedEntity(): ObservedEntity | undefined { return this.#snapshot.entities[this.#selected]; }
  private selectedStatus(): string { const entity = this.selectedEntity(); return entity ? `${entity.label} · ${entity.workflow.state}` : "no run"; }

  private async resumeSelected(): Promise<void> {
    const entity = this.selectedEntity();
    if (!entity || !this.#gateway) { this.#actionMessage = "Resume unavailable for this selection"; return; }
    const receipt = await this.#gateway.resumeRun({ identity: entity.identity, actor: "observer-workspace" });
    this.#actionMessage = receipt.message;
  }

  private async cancelSelected(): Promise<void> {
    const entity = this.selectedEntity();
    if (!entity || !this.#gateway) { this.#actionMessage = "Cancellation unavailable for this selection"; return; }
    const receipt = await this.#gateway.cancelRun({ identity: entity.identity, actor: "observer-workspace", confirmation: "confirmed" });
    this.#actionMessage = receipt.message;
  }

  private selectPreservingKey(): void {
    if (this.#selectedKey) {
      const index = this.#snapshot.entities.findIndex((entity) => entity.id === this.#selectedKey);
      if (index >= 0) { this.#selected = index; return; }
    }
    this.#selected = Math.min(this.#selected, Math.max(0, this.#snapshot.entities.length - 1));
    this.#selectedKey = this.#snapshot.entities[this.#selected]?.id;
  }

  private borderLine(innerWidth: number, left: string, right: string, middle?: string, secondMiddle?: string): string {
    if (!middle || !secondMiddle) return this.#theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
    const treeWidth = Math.floor(innerWidth * 0.3);
    const attentionWidth = Math.floor(innerWidth * 0.22);
    const detailWidth = innerWidth - treeWidth - attentionWidth - 2;
    return this.#theme.fg("border", `${left}${"─".repeat(treeWidth)}${middle}${"─".repeat(detailWidth)}${secondMiddle}${"─".repeat(attentionWidth)}${right}`);
  }

  private cellLine(innerWidth: number, leftText: string, detailText: string, attentionText: string, treeWidth: number, detailWidth: number, attentionWidth: number): string {
    return this.#theme.fg("border", "│")
      + fitLine(leftText, treeWidth)
      + this.#theme.fg("border", "│")
      + fitLine(detailText, detailWidth)
      + this.#theme.fg("border", "│")
      + fitLine(attentionText || "Attention", attentionWidth)
      + this.#theme.fg("border", "│");
  }

  private rowLine(tree: string, detail: string, attention: string, treeWidth: number, detailWidth: number, attentionWidth: number): string {
    return this.#theme.fg("border", "│") + fitLine(tree, treeWidth) + this.#theme.fg("border", "│") + fitLine(detail, detailWidth) + this.#theme.fg("border", "│") + fitLine(attention, attentionWidth) + this.#theme.fg("border", "│");
  }

  private singleLine(innerWidth: number, text: string): string {
    return this.#theme.fg("border", "│") + fitLine(text, innerWidth) + this.#theme.fg("border", "│");
  }
}

export async function openForgeDockObserverWorkspace(ctx: ExtensionContext, observer: ForgeDockObserver, options: ObserverWorkspaceOptions = {}): Promise<void> {
  await ctx.ui.custom<undefined>(
    (tui, theme, _keybindings, done) => new ForgeDockObserverWorkspace(observer, theme, done, options, () => tui.requestRender()),
    { overlay: true, overlayOptions: { anchor: "center", width: "98%", minWidth: 80, maxHeight: "90%", margin: 1 } },
  );
}

function nextTab(tab: WorkspaceTab): WorkspaceTab {
  const tabs: WorkspaceTab[] = ["overview", "events", "output", "attention", "health"];
  return tabs[(tabs.indexOf(tab) + 1) % tabs.length]!;
}

function fitLine(text: string, width: number): string {
  const visible = visibleWidth(text);
  if (visible <= width) return `${text}${" ".repeat(width - visible)}`;
  return truncateToWidth(text, width);
}

function payloadText(event: ObservationEnvelopeV1): string {
  if (event.output?.text) return event.output.text.replaceAll(/\r?\n/g, " ");
  const payload = event.payload;
  if (typeof payload === "string") return payload;
  try { return JSON.stringify(payload); } catch { return "[unserializable]"; }
}

function identityLines(identity: ObservationIdentity): string[] {
  return Object.entries(identity).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${String(value)}`);
}
