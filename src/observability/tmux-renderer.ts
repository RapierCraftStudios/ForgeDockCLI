// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawnSync } from "node:child_process";
import type { WorkspaceLayout } from "./workspace-layout.js";

export interface TmuxPaneCommand {
  paneId: string;
  title: string;
  command: string[];
}

export interface TmuxWorkspacePlan {
  sessionName: string;
  panes: TmuxPaneCommand[];
  attachCommand: string[];
}

/** Optional Unix/WSL frontend plan. It never owns ForgeDock processes. */
export function buildTmuxWorkspacePlan(runId: string, layout: WorkspaceLayout, observerCommand = "forgedock"): TmuxWorkspacePlan {
  const sessionName = `forgedock-${runId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 48)}`;
  return {
    sessionName,
    panes: layout.panes.map((pane) => ({
      paneId: pane.id,
      title: pane.title,
      command: [observerCommand, "observe", runId, "--pane", pane.kind, "--renderer", "plain"],
    })),
    attachCommand: ["tmux", "attach-session", "-t", sessionName],
  };
}

export function isTmuxAvailable(): boolean {
  if (process.platform === "win32") return false;
  return spawnSync("tmux", ["-V"], { shell: false, stdio: "ignore" }).status === 0;
}
