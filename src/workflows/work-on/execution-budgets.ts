// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AgentTask } from "../../runtime/agent-runtime.js";

/**
 * Per-agent ceilings for the native pipeline. These are deliberately large
 * enough for a complete bounded pass, but small enough to force a resumable
 * checkpoint instead of allowing exploratory loops to run for hours.
 */
export const WORK_ON_EXECUTION_BUDGETS = {
  investigator: { maxTurns: 16, maxToolCalls: 48 },
  packetAuthor: { maxTurns: 12, maxToolCalls: 40 },
  builder: { maxTurns: 32, maxToolCalls: 96 },
  remediator: { maxTurns: 24, maxToolCalls: 64 },
  ciRepair: { maxTurns: 24, maxToolCalls: 64 },
} as const satisfies Record<string, NonNullable<AgentTask<unknown>["executionBudget"]>>;
