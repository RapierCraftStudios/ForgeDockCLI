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
}

export interface VerificationRunner {
  run(commands: readonly VerificationCommand[], signal?: AbortSignal): Promise<CheckResult[]>;
}
