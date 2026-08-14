// SPDX-License-Identifier: AGPL-3.0-or-later

const ORCHESTRATE_VALUE_OPTIONS = new Set([
  "--batching", "--priority", "--milestone", "--scope-expansion", "--max-remediation-cycles",
  "--max-remediation-depth", "--max-remediation-children", "--max-parallel", "--provider", "--model",
]);

export const PROMOTION_VALUE_OPTIONS = new Set(["--from", "--to", "--resume", "--repo", "--provider", "--model"]);

export function parseOrchestrationIssueNumbers(argv: readonly string[]): number[] {
  const issues: number[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      if (ORCHESTRATE_VALUE_OPTIONS.has(arg)) index++;
      continue;
    }
    if (/^\d+$/.test(arg)) issues.push(Number(arg));
  }
  return [...new Set(issues)];
}
