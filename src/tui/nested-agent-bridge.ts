// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentDelegationV2Request, SubagentDelegationV2Response } from "pi-subagents/delegation";
import type { DurableArtifact } from "../core/artifacts/schema.js";
import type { AgentRole, ToolGrant } from "../runtime/agent-runtime.js";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const SUBAGENT_DELEGATION_REQUEST_EVENT = "prompt-template:subagent:request";
const SUBAGENT_DELEGATION_RESPONSE_EVENT = "prompt-template:subagent:response";

interface NestedAgentRequest {
  ownerRunId: string;
  id: string;
  role: AgentRole;
  objective: string;
  instructions: string;
  context: DurableArtifact[];
  cwd: string;
  tools: ToolGrant[];
  outputSchema: Record<string, unknown>;
  provider: string;
  model: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

interface NestedAgentResponse {
  output: unknown;
  sessionRef: string;
  provider: string;
  model: string;
}

export interface NestedAgentBridge {
  env: Record<string, string>;
  close(): Promise<void>;
}

export async function startNestedAgentBridge(pi: ExtensionAPI): Promise<NestedAgentBridge> {
  const token = crypto.randomUUID();
  const server = createServer((request, response) => void handleRequest(pi, token, request, response));
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
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

async function handleRequest(pi: ExtensionAPI, token: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.method !== "POST" || request.url !== "/v1/run") return send(response, 404, { error: "Not found" });
    if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "Unauthorized" });
    const payload = validateRequest(JSON.parse(await readBody(request)) as unknown);
    const result = await delegate(pi, payload);
    send(response, 200, result);
  } catch (error) {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function delegate(pi: ExtensionAPI, input: NestedAgentRequest): Promise<NestedAgentResponse> {
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
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof unsubscribe === "function") unsubscribe();
      callback();
    };
    const unsubscribe = pi.events.on(SUBAGENT_DELEGATION_RESPONSE_EVENT, (raw) => {
      const value = raw as SubagentDelegationV2Response;
      if (value.version !== 2 || value.requestId !== requestId || value.ownerRunId !== input.ownerRunId || value.nodeId !== input.id) return;
      if (value.status !== "completed" || value.result?.kind !== "structured") {
        finish(() => reject(new Error(value.error ?? `Nested ${input.role} ended with ${value.status}`)));
        return;
      }
      const output = value.result.value;
      finish(() => resolve({
        output,
        sessionRef: value.runId ?? `nested_${requestId}`,
        provider: input.provider,
        model: value.model ?? input.model,
      }));
    });
    const timer = setTimeout(() => finish(() => reject(new Error(`Nested ${input.role} timed out`))), 30 * 60_000);
    pi.events.emit(SUBAGENT_DELEGATION_REQUEST_EVENT, request);
  });
}

function buildTask(input: NestedAgentRequest): string {
  const context = input.context.map((artifact) => ({ kind: artifact.kind, id: artifact.id, payload: artifact.payload }));
  return [
    `ForgeDock nested task id: ${input.id}`,
    `Role: ${input.role}`,
    "",
    "# Objective",
    input.objective,
    "",
    "# Controller instructions",
    input.instructions,
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
  for (const key of ["ownerRunId", "id", "role", "objective", "instructions", "cwd", "provider", "model"] as const) {
    if (typeof input[key] !== "string" || !input[key]) throw new Error(`Nested request ${key} is required`);
  }
  if (input.role !== "reviewer") throw new Error(`Nested role is not authorized: ${input.role}`);
  if (!Array.isArray(input.context) || !Array.isArray(input.tools)) throw new Error("Nested request context and tools must be arrays");
  if (!input.outputSchema || typeof input.outputSchema !== "object" || Array.isArray(input.outputSchema)) throw new Error("Nested request outputSchema is required");
  if (input.tools.some((tool) => tool === "edit" || tool === "write" || tool === "bash")) throw new Error("Nested reviewers must be read-only");
  return input as NestedAgentRequest;
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
