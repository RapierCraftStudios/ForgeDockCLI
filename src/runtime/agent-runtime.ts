// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TSchema } from "typebox";
import type { DurableArtifact } from "../core/artifacts/schema.js";

export type AgentRole = "investigator" | "packet-author" | "builder" | "reviewer" | "adjudicator" | "remediator";
export type ToolGrant = "read" | "grep" | "find" | "ls" | "compute" | "bash" | "edit" | "write";

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
  | { type: "thinking.delta"; taskId: string; text: string }
  | { type: "text.delta"; taskId: string; text: string }
  | { type: "tool.started"; taskId: string; tool: string; args?: unknown }
  | { type: "tool.completed"; taskId: string; tool: string; isError: boolean }
  | { type: "artifact.submitted"; taskId: string }
  | { type: "session.completed"; taskId: string; sessionRef: string };

export interface AgentRunResult<T> {
  output: T;
  sessionRef: string;
  /** Ordered persisted-session ancestry when a failed session was resumed. */
  sessionLineage?: readonly string[];
  provider: string;
  model: string;
}

/** Operational failure metadata used only to recover the same persisted agent session. */
export class AgentRunError extends Error {
  readonly sessionRef: string | undefined;
  readonly resumable: boolean;

  constructor(message: string, options: { sessionRef?: string; resumable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AgentRunError";
    this.sessionRef = options.sessionRef;
    this.resumable = options.resumable === true && options.sessionRef !== undefined;
  }
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
  /** Resume one explicitly identified persisted session; runtimes without this seam report resumableSessions=false. */
  resume?<T>(sessionRef: string, task: AgentTask<T>, options?: { signal?: AbortSignal; onEvent?: AgentEventSink }): Promise<AgentRunResult<T>>;
  close(): Promise<void>;
}
