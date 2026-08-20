// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Static } from "typebox";
import type { CheckResultSchema } from "../artifacts/schema.js";

export type CheckResult = Static<typeof CheckResultSchema>;

export type VerificationLockScope = "machine-global" | "workspace";

/** Safe, controller-owned meaning of a verification command's result. */
export const VERIFICATION_EVIDENCE_CAPABILITIES = [
  "generic", "targeted-test", "regression", "invariant", "path-bound",
] as const;
export type VerificationEvidenceCapability = typeof VERIFICATION_EVIDENCE_CAPABILITIES[number];

export interface VerificationCommand {
  id: string;
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  required: boolean;
  /** Additive policy identity for durable evidence and safe resume. */
  policyVersion?: string;
  /** Exact repository-relative paths bound into a targeted command. */
  targets?: readonly string[];
  /** Catalog entries classified as integrity checks run for every new packet. */
  selection?: "always" | "packet";
  /** Controller-owned target expansion; never inferred from package script text. */
  targeting?: "expected-test-paths";
  /** Proven frozen TypeScript source/output mapping for targeted tests. */
  typescriptLayout?: { sourceRoot: string; outputRoot: string; project: string; configDigest: string };
  /** Operational output directory removed immediately before this command. */
  cleanOutputRoot?: string;
  /** Old commands default to the conservative machine-global lease. */
  lockScope?: VerificationLockScope;
  /** Stable verification-plan identity shared by baseline and changed runs. */
  planId?: string;
  /** Commands covered transitively by another selected script; do not execute twice. */
  coveredBy?: readonly string[];
  /** Optional explicit semantic classification owned by the controller catalog. */
  evidenceCapability?: VerificationEvidenceCapability;
}

export type VerificationCommandProgress =
  | { phase: "lock-waiting" | "lock-acquired" | "lock-released"; lockScope: VerificationLockScope }
  | { phase: "command-started"; commandId: string; index: number; total: number }
  | { phase: "command-completed"; commandId: string; index: number; total: number; status: CheckResult["status"]; durationMs: number };

export type VerificationProgressCallback = (progress: VerificationCommandProgress) => void | Promise<void>;

export interface VerificationRunner {
  run(
    commands: readonly VerificationCommand[],
    signal?: AbortSignal,
    onProgress?: VerificationProgressCallback,
  ): Promise<CheckResult[]>;
}
