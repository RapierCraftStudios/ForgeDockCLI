// SPDX-License-Identifier: AGPL-3.0-or-later

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ClaimPromotionConflictError } from "../workflows/orchestrate/scheduler.js";

const CLAIM_PROMOTION_PATH = "/v1/orchestration/claims";
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_CLAIMS = 2_000;
const REQUEST_TIMEOUT_MS = 30_000;

const ENVIRONMENT_KEYS = {
  url: "FORGEDOCK_CLAIM_PROMOTION_URL",
  token: "FORGEDOCK_CLAIM_PROMOTION_TOKEN",
  orchestrationId: "FORGEDOCK_ORCHESTRATION_ID",
  nodeId: "FORGEDOCK_ORCHESTRATION_NODE",
  attemptId: "FORGEDOCK_ORCHESTRATION_ATTEMPT",
} as const;

export interface OrchestrationClaimIdentity {
  orchestrationId: string;
  nodeId: string;
  attemptId: string;
}

export interface OrchestrationClaimPromotionServer {
  env: Record<string, string>;
  close(): Promise<void>;
}

/**
 * Promote claims through every scheduler boundary that owns this worker.
 * A subprocess uses the authenticated environment transport; an in-process
 * CLI orchestration supplies its controller callback directly. Nested
 * orchestration may require both boundaries and therefore must not choose one
 * merely because the other is configured.
 */
export async function promoteOrchestrationClaims(
  claims: readonly string[],
  options: {
    environment?: NodeJS.ProcessEnv;
    local?: (claims: readonly string[]) => Promise<void>;
  } = {},
): Promise<{ transport: "not-configured" | "promoted"; local: boolean }> {
  const transport = await promoteOrchestrationClaimsFromEnvironment(claims, options.environment ?? process.env);
  if (options.local) await options.local(claims);
  return { transport, local: options.local !== undefined };
}

export async function startOrchestrationClaimPromotionServer(input: {
  identity: OrchestrationClaimIdentity;
  promoteClaims(claims: readonly string[]): Promise<void>;
}): Promise<OrchestrationClaimPromotionServer> {
  const identity = validateIdentity(input.identity);
  const token = crypto.randomUUID();
  const pending = new Set<AbortController>();
  const server = createServer((request, response) => {
    const controller = new AbortController();
    pending.add(controller);
    request.once("aborted", () => controller.abort(new Error("Claim-promotion client disconnected")));
    response.once("close", () => {
      if (!response.writableEnded) controller.abort(new Error("Claim-promotion response disconnected"));
    });
    void handlePromotionRequest(input.promoteClaims, identity, token, request, response, controller.signal)
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
      [ENVIRONMENT_KEYS.url]: `http://127.0.0.1:${address.port}${CLAIM_PROMOTION_PATH}`,
      [ENVIRONMENT_KEYS.token]: token,
      [ENVIRONMENT_KEYS.orchestrationId]: identity.orchestrationId,
      [ENVIRONMENT_KEYS.nodeId]: identity.nodeId,
      [ENVIRONMENT_KEYS.attemptId]: identity.attemptId,
    },
    close: () => new Promise<void>((resolve, reject) => {
      for (const controller of pending) controller.abort(new Error("Claim-promotion server closed"));
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

/**
 * Promote a child controller's frozen Build Packet paths into its live parent
 * scheduler. An absent environment means this is not an orchestrated child;
 * a partial or dead transport fails closed before builder dispatch.
 */
export async function promoteOrchestrationClaimsFromEnvironment(
  claims: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<"not-configured" | "promoted"> {
  const configured = Object.fromEntries(Object.entries(ENVIRONMENT_KEYS).map(([key, name]) => [key, environment[name]?.trim()]));
  const values = Object.values(configured);
  if (values.every((value) => !value)) return "not-configured";
  if (values.some((value) => !value)) {
    throw new Error("Orchestrated claim promotion is only partially configured; refusing to start the builder");
  }
  const identity = validateIdentity({
    orchestrationId: configured.orchestrationId!,
    nodeId: configured.nodeId!,
    attemptId: configured.attemptId!,
  });
  const normalizedClaims = validateClaims(claims);
  let response: Response;
  try {
    response = await fetch(configured.url!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${configured.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...identity, claims: normalizedClaims }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Parent orchestration claim arbiter is unavailable; refusing to start the builder: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const payload = await readResponse(response);
  if (response.ok) return "promoted";
  if (response.status === 409 && payload.code === "claim-conflict") {
    throw new ClaimPromotionConflictError(
      typeof payload.itemId === "string" ? payload.itemId : identity.nodeId,
      Array.isArray(payload.conflicts) ? payload.conflicts.filter((value): value is string => typeof value === "string") : [],
    );
  }
  throw new Error(`Parent orchestration rejected claim promotion (${response.status}): ${typeof payload.error === "string" ? payload.error : response.statusText}`);
}

async function handlePromotionRequest(
  promoteClaims: (claims: readonly string[]) => Promise<void>,
  expectedIdentity: OrchestrationClaimIdentity,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  try {
    if (request.method !== "POST" || request.url !== CLAIM_PROMOTION_PATH) return send(response, 404, { error: "Not found" });
    if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "Unauthorized" });
    const payload = JSON.parse(await readBody(request, signal)) as unknown;
    if (!isObject(payload)) return send(response, 400, { error: "Claim-promotion payload must be an object" });
    const receivedIdentity = validateIdentity({
      orchestrationId: payload.orchestrationId,
      nodeId: payload.nodeId,
      attemptId: payload.attemptId,
    });
    if (receivedIdentity.orchestrationId !== expectedIdentity.orchestrationId
      || receivedIdentity.nodeId !== expectedIdentity.nodeId
      || receivedIdentity.attemptId !== expectedIdentity.attemptId) {
      return send(response, 409, { code: "identity-mismatch", error: "Claim-promotion identity does not match the active worker attempt" });
    }
    const claims = validateClaims(payload.claims);
    await promoteClaims(claims);
    send(response, 200, { status: "promoted" });
  } catch (error) {
    if (error instanceof ClaimPromotionConflictError) {
      return send(response, 409, {
        code: "claim-conflict",
        itemId: error.itemId,
        conflicts: [...error.conflicts],
        error: error.message,
      });
    }
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

function validateIdentity(value: { orchestrationId: unknown; nodeId: unknown; attemptId: unknown }): OrchestrationClaimIdentity {
  const orchestrationId = requiredIdentityPart(value.orchestrationId, "orchestrationId");
  const nodeId = requiredIdentityPart(value.nodeId, "nodeId");
  const attemptId = requiredIdentityPart(value.attemptId, "attemptId");
  return { orchestrationId, nodeId, attemptId };
}

function requiredIdentityPart(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n]/.test(value)) {
    throw new Error(`Claim-promotion ${name} must be a non-empty bounded string`);
  }
  return value.trim();
}

function validateClaims(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_CLAIMS) {
    throw new Error(`Claim promotion requires 1 to ${MAX_CLAIMS} paths`);
  }
  return [...new Set(value.map((claim) => {
    if (typeof claim !== "string" || !claim.trim() || claim.length > 1_024 || /[\r\n]/.test(claim)) {
      throw new Error("Claim-promotion paths must be non-empty bounded strings");
    }
    return claim.trim();
  }))];
}

async function readBody(request: IncomingMessage, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    if (signal.aborted) throw signal.reason;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_REQUEST_BYTES) throw new Error("Claim-promotion request is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json() as unknown;
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

function send(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
  if (response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
