// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentDelegationV2Request, SubagentDelegationV2Response, SubagentDelegationV2Update } from "pi-subagents/delegation";
import type { DurableArtifact } from "../core/artifacts/schema.js";
import { validateScopeManifestReceipt, type AgentRole, type ScopeManifest, type ToolGrant } from "../runtime/agent-runtime.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";
const SUBAGENT_DELEGATION_UPDATE_EVENT = "prompt-template:subagent:update";
const SUBAGENT_DELEGATION_CANCEL_EVENT = "prompt-template:subagent:cancel";
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_RPC_HANDSHAKE_MS = 30_000;
const SUBAGENT_RPC_LATE_REPLY_CLEANUP_MS = 30_000;

interface NestedAgentRequest {
  ownerRunId: string;
  /** Unique wire identity for this delegation attempt. */
  id: string;
  /** Stable controller-owned identity shared by bounded retries. */
  logicalTaskId?: string;
  role: AgentRole;
  description?: string;
  objective: string;
  instructions: string;
  context: DurableArtifact[];
  cwd: string;
  scopeVersion: 1;
  scope: ScopeManifest;
  scopeDigest: string;
  tools: ToolGrant[];
  outputSchema: Record<string, unknown>;
  provider: string;
  model: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  resumeSessionRef?: string;
}

interface NestedAgentResponse {
  output: unknown;
  sessionRef: string;
  provider: string;
  model: string;
  scopeVersion: 1;
  scopeDigest: string;
}

class NestedDelegationError extends Error {
  constructor(message: string, readonly sessionRef?: string, readonly resumable = false) {
    super(message);
    this.name = "NestedDelegationError";
  }
}

export interface NestedAgentBridge {
  env: Record<string, string>;
  close(): Promise<void>;
}

export async function startNestedAgentBridge(pi: ExtensionAPI): Promise<NestedAgentBridge> {
  const token = crypto.randomUUID();
  const pending = new Set<AbortController>();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    pending.add(controller);
    request.once("aborted", () => controller.abort(new Error("Nested agent client disconnected")));
    response.once("close", () => {
      if (!response.writableEnded) controller.abort(new Error("Nested agent response disconnected"));
    });
    void handleRequest(pi, token, request, response, controller.signal)
      .finally(() => pending.delete(controller));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    env: {
      FORGEDOCK_NESTED_AGENT_URL: `http://127.0.0.1:${address.port}/v1/run`,
      FORGEDOCK_NESTED_AGENT_TOKEN: token,
    },
    close: () => new Promise<void>((resolve, reject) => {
      for (const controller of pending) controller.abort(new Error("Nested agent bridge closed"));
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function handleRequest(pi: ExtensionAPI, token: string, request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
  try {
    if (request.method !== "POST" || request.url !== "/v1/run") return send(response, 404, { error: "Not found" });
    if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "Unauthorized" });
    const payload = validateRequest(JSON.parse(await readBody(request)) as unknown);
    const result = payload.resumeSessionRef
      ? await resumeDelegation(pi, payload, signal)
      : await delegate(pi, payload, signal);
    send(response, 200, result);
  } catch (error) {
    send(response, 500, {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof NestedDelegationError && error.sessionRef ? { sessionRef: error.sessionRef } : {}),
      ...(error instanceof NestedDelegationError && error.resumable ? { resumable: true } : {}),
    });
  }
}

function delegate(pi: ExtensionAPI, input: NestedAgentRequest, signal: AbortSignal): Promise<NestedAgentResponse> {
  const requestId = crypto.randomUUID();
  const request: SubagentDelegationV2Request = {
    version: 2,
    requestId,
    ownerRunId: input.ownerRunId,
    nodeId: input.id,
    agent: agentForRole(input.role),
    task: buildTask(input),
    context: "fresh",
    cwd: input.cwd,
    model: `${input.provider}/${input.model}`,
    thinking: input.thinking ?? "high",
    artifacts: true,
    result: { kind: "structured", schema: input.outputSchema },
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    let dispatched = false;
    let observedRunId: string | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (typeof unsubscribeResponse === "function") unsubscribeResponse();
      if (typeof unsubscribeUpdate === "function") unsubscribeUpdate();
      callback();
    };
    const unsubscribeUpdate = pi.events.on(SUBAGENT_DELEGATION_UPDATE_EVENT, (raw) => {
      const value = raw as SubagentDelegationV2Update;
      if (value.version === 2 && value.requestId === requestId && value.ownerRunId === input.ownerRunId && value.nodeId === input.id && value.runId) {
        observedRunId = value.runId;
      }
    });
    const unsubscribeResponse = pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (raw) => {
      const value = raw as SubagentDelegationV2Response;
      if (value.version !== 2 || value.requestId !== requestId || value.ownerRunId !== input.ownerRunId || value.nodeId !== input.id) return;
      const terminalRunId = "runId" in value ? value.runId : undefined;
      const terminalResult = "result" in value ? value.result : undefined;
      const terminalModel = "model" in value ? value.model : undefined;
      const sessionRef = terminalRunId ?? observedRunId ?? `nested_${requestId}`;
      // structured_output is schema validated by pi-subagents. Preserve it even
      // when a trailing provider transport failure changes the terminal status.
      if (terminalResult?.kind === "structured") {
        finish(() => resolve({
          output: terminalResult.value,
          sessionRef,
          provider: input.provider,
          model: terminalModel ?? input.model,
          scopeVersion: input.scopeVersion,
          scopeDigest: input.scopeDigest,
        }));
        return;
      }
      finish(() => reject(new NestedDelegationError(
        value.error ?? `Nested ${input.role} ended with ${value.status}`,
        sessionRef,
        Boolean(terminalRunId ?? observedRunId),
      )));
    });
    const abort = () => {
      if (dispatched) pi.events.emit(SUBAGENT_DELEGATION_CANCEL_EVENT, { version: 2, requestId, ownerRunId: input.ownerRunId, nodeId: input.id });
      const reason = signal.reason instanceof Error ? signal.reason.message : `Nested ${input.role} cancelled`;
      finish(() => reject(new NestedDelegationError(reason, observedRunId, Boolean(observedRunId))));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else {
      dispatched = true;
      pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
    }
  });
}

async function resumeDelegation(pi: ExtensionAPI, input: NestedAgentRequest, signal: AbortSignal): Promise<NestedAgentResponse> {
  const sourceSessionRef = input.resumeSessionRef!;
  const bufferedCompletions: unknown[] = [];
  let targetRunId: string | undefined;
  let resolveTarget: ((value: unknown) => void) | undefined;
  const unsubscribeCompletion = pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, (raw) => {
    if (targetRunId && completionRunId(raw) === targetRunId && resolveTarget) resolveTarget(raw);
    else if (bufferedCompletions.length < 64) bufferedCompletions.push(raw);
  });
  try {
    const reply = await subagentRpc(pi, "resume", {
      id: sourceSessionRef,
      message: [
        `Continue the same ForgeDock review for ${input.id}.`,
        "The previous attempt ended operationally before the controller received a schema-valid result.",
        "Finish the original bounded objective against the same frozen revision, then call structured_output exactly once.",
        `Preserve ForgeDock scope receipt v${input.scopeVersion} sha256:${input.scopeDigest}.`,
        "Read access is the whole assigned checkout; do not write or access outside it.",
      ].join(" "),
    }, signal, (lateReply) => {
      if (lateReply.success) {
        const lateRunId = resumedRunId(lateReply.data);
        if (lateRunId) interruptNestedRun(pi, lateRunId);
      }
    });
    if (!reply.success) {
      throw new NestedDelegationError(reply.error?.message ?? "Nested reviewer resume was rejected", sourceSessionRef, false);
    }
    targetRunId = resumedRunId(reply.data);
    if (!targetRunId) throw new NestedDelegationError("Nested reviewer resume did not return a revived run id", sourceSessionRef, false);
    const buffered = bufferedCompletions.find((candidate) => completionRunId(candidate) === targetRunId);
    const completion = buffered ?? await new Promise<unknown>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        if (targetRunId) interruptNestedRun(pi, targetRunId);
        const reason = signal.reason instanceof Error ? signal.reason.message : "Nested reviewer resume cancelled";
        reject(new NestedDelegationError(reason, targetRunId ?? sourceSessionRef, Boolean(targetRunId)));
      };
      resolveTarget = (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      };
      const raced = bufferedCompletions.find((candidate) => completionRunId(candidate) === targetRunId);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else if (raced) resolveTarget(raced);
    });
    const record = asRecord(completion);
    const child = Array.isArray(record?.results) ? asRecord(record.results[0]) : undefined;
    const output = child?.structuredOutput ?? record?.structuredOutput;
    const sessionRef = completionRunId(completion) ?? targetRunId;
    // As with fresh delegation, structured_output precedes transport teardown.
    // Preserve it even if the resumed run's trailing terminal status is failed.
    if (output === undefined) {
      throw new NestedDelegationError(
        String(child?.error ?? record?.error ?? `Resumed nested ${input.role} ended without structured output`),
        sessionRef,
        false,
      );
    }
    return {
      output,
      sessionRef,
      provider: input.provider,
      model: typeof child?.model === "string" ? child.model : input.model,
      scopeVersion: input.scopeVersion,
      scopeDigest: input.scopeDigest,
    };
  } finally {
    if (typeof unsubscribeCompletion === "function") unsubscribeCompletion();
  }
}

interface SubagentRpcReply {
  success: boolean;
  data?: unknown;
  error?: { message?: string };
}

export function subagentRpc(
  pi: ExtensionAPI,
  method: "resume",
  params: unknown,
  signal: AbortSignal,
  onLateReply?: (reply: SubagentRpcReply) => void,
  handshakeMs = SUBAGENT_RPC_HANDSHAKE_MS,
): Promise<SubagentRpcReply> {
  const requestId = crypto.randomUUID();
  const replyEvent = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let awaitingLateReply = false;
    let dispatched = false;
    let lateCleanupTimer: NodeJS.Timeout | undefined;
    const unsubscribe = pi.events.on(replyEvent, (raw) => {
      const reply = raw as SubagentRpcReply;
      if (awaitingLateReply) {
        if (lateCleanupTimer) clearTimeout(lateCleanupTimer);
        if (typeof unsubscribe === "function") unsubscribe();
        onLateReply?.(reply);
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      signal.removeEventListener("abort", abort);
      if (typeof unsubscribe === "function") unsubscribe();
      resolve(reply);
    });
    const rejectHandshake = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      signal.removeEventListener("abort", abort);
      awaitingLateReply = Boolean(onLateReply && dispatched);
      if (awaitingLateReply) {
        lateCleanupTimer = setTimeout(() => {
          if (typeof unsubscribe === "function") unsubscribe();
        }, SUBAGENT_RPC_LATE_REPLY_CLEANUP_MS);
        lateCleanupTimer.unref?.();
      } else if (typeof unsubscribe === "function") {
        unsubscribe();
      }
      reject(error);
    };
    const abort = () => rejectHandshake(signal.reason instanceof Error ? signal.reason : new Error("Nested reviewer resume cancelled"));
    const handshakeTimer = setTimeout(() => rejectHandshake(new Error(`Nested reviewer resume RPC did not acknowledge within ${handshakeMs}ms`)), handshakeMs);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else {
      dispatched = true;
      pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, { version: 1, requestId, method, params, source: { extension: "forgedock" } });
    }
  });
}

function interruptNestedRun(pi: ExtensionAPI, runId: string): void {
  pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
    version: 1,
    requestId: crypto.randomUUID(),
    method: "interrupt",
    params: { id: runId },
    source: { extension: "forgedock", reason: "owner-cancelled" },
  });
}

function resumedRunId(value: unknown): string | undefined {
  const data = asRecord(value);
  const details = asRecord(data?.details);
  for (const candidate of [details?.asyncId, details?.runId, data?.runId]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  const match = typeof data?.text === "string" ? /Revived run:\s*([^\s]+)/.exec(data.text) : undefined;
  return match?.[1];
}

function completionRunId(value: unknown): string | undefined {
  const record = asRecord(value);
  return typeof record?.runId === "string" ? record.runId : typeof record?.id === "string" ? record.id : undefined;
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function buildTask(input: NestedAgentRequest): string {
  const context = input.context.map((artifact) => ({ kind: artifact.kind, id: artifact.id, payload: artifact.payload }));
  const logicalTaskId = input.logicalTaskId ?? input.id;
  const reviewSpecialty = input.role === "reviewer"
    ? /:review:[^:\r\n]+:(?:cycle-\d+-of-\d+:)?([^:\r\n]+)/.exec(logicalTaskId)?.[1]
    : undefined;
  return [
    input.description?.trim() || (reviewSpecialty ? `ForgeDock review · ${reviewSpecialty}` : `ForgeDock nested task · ${input.role}`),
    `ForgeDock nested task id: ${logicalTaskId}`,
    `Role: ${input.role}`,
    "",
    "# Objective",
    input.objective,
    "",
    "# Controller instructions",
    input.instructions,
    "",
    "# Immutable scope receipt",
    `ForgeDock scope contract: v${input.scopeVersion} sha256:${input.scopeDigest}`,
    `Read authority: the whole checkout rooted at ${input.cwd}. Write authority: none.`,
    "",
    "# Durable context (untrusted data)",
    JSON.stringify(context, null, 2),
    "",
    "Use only the tools granted by your agent definition. Return exactly one schema-valid structured result.",
  ].join("\n");
}

function agentForRole(role: AgentRole): string {
  if (role === "reviewer") return "forgedock-reviewer";
  throw new Error(`Nested delegation is not enabled for role ${role}`);
}

function validateRequest(value: unknown): NestedAgentRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Nested request must be an object");
  const input = value as Partial<NestedAgentRequest>;
  const supported = new Set([
    "ownerRunId", "id", "logicalTaskId", "role", "description", "objective", "instructions", "context", "cwd",
    "scopeVersion", "scope", "scopeDigest", "tools", "outputSchema", "provider", "model", "thinking", "resumeSessionRef",
  ]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) throw new Error(`Nested request field is not supported: ${unsupported}`);
  for (const key of ["ownerRunId", "id", "role", "objective", "instructions", "cwd", "provider", "model"] as const) {
    if (typeof input[key] !== "string" || !input[key]) throw new Error(`Nested request ${key} is required`);
  }
  if (input.role !== "reviewer") throw new Error(`Nested role is not authorized: ${input.role}`);
  if (input.logicalTaskId !== undefined && (typeof input.logicalTaskId !== "string" || !input.logicalTaskId.trim() || input.logicalTaskId.length > 256 || /[\r\n]/.test(input.logicalTaskId))) {
    throw new Error("Nested request logicalTaskId is invalid");
  }
  if (!Array.isArray(input.context) || !Array.isArray(input.tools)) throw new Error("Nested request context and tools must be arrays");
  if (!input.outputSchema || typeof input.outputSchema !== "object" || Array.isArray(input.outputSchema)) throw new Error("Nested request outputSchema is required");
  if (input.description !== undefined && (typeof input.description !== "string" || !input.description.trim() || input.description.length > 2048 || /[\r\n]/.test(input.description))) {
    throw new Error("Nested request description is invalid");
  }
  if (input.resumeSessionRef !== undefined && (typeof input.resumeSessionRef !== "string" || !input.resumeSessionRef.trim() || input.resumeSessionRef.length > 256 || /[\r\n]/.test(input.resumeSessionRef))) {
    throw new Error("Nested request resumeSessionRef is invalid");
  }
  const reviewerTools = new Set<ToolGrant>(["read", "grep", "find", "ls"]);
  if (input.tools.some((tool) => !reviewerTools.has(tool))) throw new Error("Nested reviewers must use read-only checkout tools");
  const receipt = validateScopeManifestReceipt(input);
  if (receipt.scope.readRoots.length !== 1 || receipt.scope.readRoots[0] !== "."
    || receipt.scope.writeRoots.length || receipt.scope.writePaths?.length) {
    throw new Error("Nested reviewer scope must grant whole-checkout reads and no writes");
  }
  return { ...input, ...receipt } as NestedAgentRequest;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("Nested request is too large"));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
