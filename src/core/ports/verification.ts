// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Static } from "typebox";
import type { CheckResultSchema } from "../artifacts/schema.js";

export type CheckResult = Static<typeof CheckResultSchema>;

export interface VerificationCommand {
  id: string;
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  required: boolean;
  /** Stable verification-plan identity shared by baseline and changed runs. */
  planId?: string;
  /** Commands covered transitively by another selected script; do not execute twice. */
  coveredBy?: readonly string[];
}

export interface VerificationRunner {
  run(commands: readonly VerificationCommand[], signal?: AbortSignal): Promise<CheckResult[]>;
}
