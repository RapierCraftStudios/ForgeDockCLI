// SPDX-License-Identifier: AGPL-3.0-or-later

const ORCHESTRATE_VALUE_OPTIONS = new Set([
  "--batching", "--priority", "--milestone", "--scope-expansion", "--max-remediation-cycles",
  "--max-remediation-depth", "--max-remediation-children", "--max-parallel", "--provider", "--model",
  "--thinking", "--planning-model", "--planning-thinking", "--reviewer-model", "--reviewer-thinking",
  "--resume", "--repo",
]);

const WORK_ON_VALUE_OPTIONS = new Set([
  "--depends-on", "--through", "--repo", "--scope-expansion", "--max-remediation-cycles",
  "--max-remediation-depth", "--max-remediation-children", "--provider", "--model", "--thinking",
  "--planning-model", "--planning-thinking", "--reviewer-model", "--reviewer-thinking",
  "--adjudicate-verification",
]);

const REVIEW_VALUE_OPTIONS = new Set(["--repo", "--issue", "--provider", "--model", "--thinking"]);
const RESET_VALUE_OPTIONS = new Set(["--repo", "--reason"]);

export const PROMOTION_VALUE_OPTIONS = new Set(["--from", "--to", "--resume", "--repo", "--provider", "--model", "--thinking"]);

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

/**
 * Return the first true positional argument after consuming values owned by
 * known options. This keeps a reordered invocation such as
 * `--repo owner/repo 42` from selecting `owner/repo` as the subject.
 */
export function firstPositionalArgument(
  argv: readonly string[],
  valueOptions: ReadonlySet<string>,
): string | undefined {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg.startsWith("--")) {
      if (valueOptions.has(arg)) index++;
      continue;
    }
    return arg;
  }
  return undefined;
}

export function parseWorkOnIssueArgument(argv: readonly string[]): string | undefined {
  return firstPositionalArgument(argv, WORK_ON_VALUE_OPTIONS);
}

export function parseReviewPullRequestArgument(argv: readonly string[]): string | undefined {
  return firstPositionalArgument(argv, REVIEW_VALUE_OPTIONS);
}

export function parseResetIssueArgument(argv: readonly string[]): string | undefined {
  return firstPositionalArgument(argv, RESET_VALUE_OPTIONS);
}
