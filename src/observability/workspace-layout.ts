// SPDX-License-Identifier: AGPL-3.0-or-later

export type WorkspacePaneKind = "overview" | "events" | "output" | "tools" | "attention" | "artifacts" | "review" | "health" | "diff";

export interface WorkspacePane {
  id: string;
  kind: WorkspacePaneKind;
  title: string;
  entityId?: string;
  width?: number;
  height?: number;
}

export interface WorkspaceLayout {
  id: string;
  name: string;
  panes: WorkspacePane[];
  focusedPaneId: string;
  updatedAt: string;
}

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayout = {
  id: "default",
  name: "ForgeDock Observer",
  panes: [
    { id: "tree", kind: "overview", title: "Run tree", width: 30 },
    { id: "detail", kind: "events", title: "Active pane", width: 50 },
    { id: "attention", kind: "attention", title: "Attention", width: 20 },
  ],
  focusedPaneId: "tree",
  updatedAt: new Date(0).toISOString(),
};

export function cloneWorkspaceLayout(layout: WorkspaceLayout = DEFAULT_WORKSPACE_LAYOUT): WorkspaceLayout {
  return {
    ...layout,
    panes: layout.panes.map((pane) => ({ ...pane })),
  };
}
