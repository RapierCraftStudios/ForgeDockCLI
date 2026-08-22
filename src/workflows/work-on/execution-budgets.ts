// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ordinary lifecycle roles intentionally have no implicit turn/tool ceiling.
 * Semantic idle cancellation, command timeouts, and workflow retry bounds remain
 * the applicable safeguards; explicit caller budgets are still honored by the runtime.
 */
export const WORK_ON_EXECUTION_BUDGETS = {
  investigator: undefined,
  packetAuthor: undefined,
  builder: undefined,
  remediator: undefined,
  ciRepair: undefined,
} as const;
