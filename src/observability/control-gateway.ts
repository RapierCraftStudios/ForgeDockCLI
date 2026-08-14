// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type { ObservationIdentity, ObservationSink } from "./contracts.js";

export type ObservationControlKind = "resume" | "cancel" | "steer" | "approve" | "retry";

export interface ObservationControlRequest {
  identity: ObservationIdentity;
  actor: string;
  expectedVersion?: number;
  confirmation?: string;
  payload?: unknown;
}

export interface ObservationControlReceipt {
  actionId: string;
  kind: ObservationControlKind;
  accepted: boolean;
  state: "requested" | "accepted" | "rejected" | "completed";
  message: string;
  target: ObservationIdentity;
}

export interface ObservationControlHandlers {
  authorize?: (kind: ObservationControlKind, request: ObservationControlRequest) => Promise<void> | void;
  resume?: (request: ObservationControlRequest) => Promise<unknown>;
  cancel?: (request: ObservationControlRequest) => Promise<unknown>;
  steer?: (request: ObservationControlRequest) => Promise<unknown>;
  approve?: (request: ObservationControlRequest) => Promise<unknown>;
  retry?: (request: ObservationControlRequest) => Promise<unknown>;
}

export interface ObservationControlGateway {
  resumeRun(request: ObservationControlRequest): Promise<ObservationControlReceipt>;
  cancelRun(request: ObservationControlRequest): Promise<ObservationControlReceipt>;
  steerAgent(request: ObservationControlRequest): Promise<ObservationControlReceipt>;
  approveDecision(request: ObservationControlRequest): Promise<ObservationControlReceipt>;
  retryWorkUnit(request: ObservationControlRequest): Promise<ObservationControlReceipt>;
}

/**
 * Control gateway that records every request and delegates mutation to an
 * explicitly supplied typed-controller or leaf-run adapter. The observer
 * itself never mutates a workflow.
 */
export class ForgeDockObservationControlGateway implements ObservationControlGateway {
  constructor(readonly observer: ObservationSink, readonly handlers: ObservationControlHandlers = {}) {}

  resumeRun(request: ObservationControlRequest): Promise<ObservationControlReceipt> { return this.execute("resume", request); }
  cancelRun(request: ObservationControlRequest): Promise<ObservationControlReceipt> { return this.execute("cancel", request); }
  steerAgent(request: ObservationControlRequest): Promise<ObservationControlReceipt> { return this.execute("steer", request); }
  approveDecision(request: ObservationControlRequest): Promise<ObservationControlReceipt> { return this.execute("approve", request); }
  retryWorkUnit(request: ObservationControlRequest): Promise<ObservationControlReceipt> { return this.execute("retry", request); }

  private async execute(kind: ObservationControlKind, request: ObservationControlRequest): Promise<ObservationControlReceipt> {
    const actionId = randomUUID();
    const producer = { component: "forgedock-observer-control", processInstanceId: `observer-control:${process.pid}` };
    await this.observer.emit({
      producer,
      identity: request.identity,
      source: "observer",
      channel: "decision",
      kind: "control.requested",
      payload: { actionId, control: kind, actor: request.actor },
    });
    const handler = this.handlers[kind];
    try {
      if (kind === "cancel" && request.confirmation !== "confirmed") throw new Error("Cancellation requires explicit confirmation");
      if (!handler) throw new Error(`No ${kind} control adapter is configured for this target`);
      await this.handlers.authorize?.(kind, request);
      await this.observer.emit({
        producer,
        identity: request.identity,
        source: "observer",
        channel: "decision",
        kind: "control.accepted",
        payload: { actionId, control: kind, actor: request.actor },
      });
      await handler(request);
      await this.observer.emit({
        producer,
        identity: request.identity,
        source: "observer",
        channel: "decision",
        kind: "control.completed",
        payload: { actionId, control: kind },
      });
      return { actionId, kind, accepted: true, state: "completed", message: `${kind} accepted`, target: request.identity };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.observer.emit({
        producer,
        identity: request.identity,
        source: "observer",
        channel: "decision",
        kind: "control.rejected",
        severity: "warning",
        payload: { actionId, control: kind, reason: message },
      });
      return { actionId, kind, accepted: false, state: "rejected", message, target: request.identity };
    }
  }
}
