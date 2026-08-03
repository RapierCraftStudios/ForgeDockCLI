// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TSchema } from "typebox";
import type { DurableArtifact } from "../core/artifacts/schema.js";

export type AgentRole = "investigator" | "packet-author" | "builder" | "reviewer" | "remediator";
export type ToolGrant = "read" | "grep" | "find" | "ls" | "bash" | "edit" | "write";

export interface WorkspaceGrant {
  cwd: string;
  mode: "read-only" | "write";
}

export interface ModelPolicy {
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  requireDifferentFrom?: { provider?: string; model?: string };
}

export interface AgentTask<T> {
  id: string;
  role: AgentRole;
  objective: string;
  instructions: string;
  context: readonly DurableArtifact[];
  workspace: WorkspaceGrant;
  tools: readonly ToolGrant[];
  outputSchema: TSchema;
  modelPolicy: ModelPolicy;
}

export type AgentEvent =
  | { type: "session.started"; taskId: string; sessionRef: string; provider: string; model: string }
  | { type: "text.delta"; taskId: string; text: string }
  | { type: "tool.started"; taskId: string; tool: string }
  | { type: "tool.completed"; taskId: string; tool: string; isError: boolean }
  | { type: "artifact.submitted"; taskId: string }
  | { type: "session.completed"; taskId: string; sessionRef: string };

export interface AgentRunResult<T> {
  output: T;
  sessionRef: string;
  provider: string;
  model: string;
}

export type AgentEventSink = (event: AgentEvent) => void;

export interface RuntimeCapabilities {
  runtime: string;
  resumableSessions: boolean;
  tools: readonly ToolGrant[];
}

export interface AgentRuntime {
  capabilities(): Promise<RuntimeCapabilities>;
  run<T>(task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>>;
  close(): Promise<void>;
}
