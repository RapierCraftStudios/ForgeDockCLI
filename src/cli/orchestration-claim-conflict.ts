// SPDX-License-Identifier: AGPL-3.0-or-later

import { ClaimPromotionConflictError, type ScheduleWorkerResult } from "../workflows/orchestrate/scheduler.js";

export interface StandaloneClaimConflictResolution {
  kind: "standalone";
  conflict: ClaimPromotionConflictError;
}

export interface ParentClaimConflictResolution {
  kind: "suspended";
  conflict: ClaimPromotionConflictError;
  result: Exclude<ScheduleWorkerResult, void>;
}

export function resolveClaimPromotionConflictAtBoundary(error: unknown, boundary: "nested-work-on"): never;
export function resolveClaimPromotionConflictAtBoundary(error: unknown, boundary: "standalone-work-on"): StandaloneClaimConflictResolution;
export function resolveClaimPromotionConflictAtBoundary(error: unknown, boundary: "orchestration-parent"): ParentClaimConflictResolution;
export function resolveClaimPromotionConflictAtBoundary(
  error: unknown,
  boundary: "standalone-work-on" | "nested-work-on" | "orchestration-parent",
): StandaloneClaimConflictResolution | ParentClaimConflictResolution {
  if (!(error instanceof ClaimPromotionConflictError)) throw error;
  if (boundary === "nested-work-on") throw error;
  if (boundary === "standalone-work-on") return { kind: "standalone", conflict: error };
  return {
    kind: "suspended",
    conflict: error,
    result: { status: "suspended", error },
  };
}
