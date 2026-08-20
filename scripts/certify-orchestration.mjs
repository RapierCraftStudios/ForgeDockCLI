#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = [
  "dist/workflows/orchestrate/certification.test.js",
  "dist/workflows/orchestrate/scheduler.test.js",
  "dist/workflows/orchestrate/controller.test.js",
  "dist/workflows/orchestrate/reconcile-worker.test.js",
  "dist/workflows/orchestrate/stale-reaper.test.js",
  "dist/workflows/orchestrate/view-model.test.js",
  "dist/adapters/sqlite/orchestration-admission.test.js",
  "dist/core/ports/orchestration.test.js",
  "dist/adapters/sqlite/sqlite-repositories.test.js",
  "dist/observability/observer.test.js",
  "dist/workflows/work-on/publish.test.js",
  "dist/workflows/work-on/complete.test.js",
  "dist/cli/verification-policy.test.js",
  "dist/runtime/agent-runtime.test.js",
  "dist/adapters/process/process-verifier.test.js",
  "dist/workflows/work-on/verify.test.js",
  "dist/workflows/work-on/lane.test.js",
  "dist/workflows/work-on/conflict-recovery.test.js",
  "dist/workflows/orchestrate/decomposition-dependencies.test.js",
  "dist/core/retry.test.js",
  "dist/core/state/retry-checkpoints.test.js",
  "dist/core/packet/relation-graph.test.js",
  "dist/core/packet/relation-checkpoint-certification.test.js",
  "dist/workflows/work-on/prepare.relation-graph.test.js",
  "dist/workflows/work-on/target-recovery.test.js",
  "dist/workflows/work-on/publish-revision.test.js",
  "dist/workflows/reset/pristine-reset.test.js",
  "dist/workflows/reset/migration.test.js",
];

const coverage = {
  "capacity-and-streaming": ["certification", "scheduler", "controller"],
  "claim-serialization-and-promotion": ["certification", "scheduler", "controller"],
  "exact-once-and-issue-ownership": ["certification", "controller", "orchestration-port", "sqlite-repositories"],
  "lease-and-controller-fencing": ["orchestration-admission", "stale-reaper", "controller"],
  "cancellation-ownership": ["scheduler"],
  "restart-and-decomposition-recovery": ["controller", "reconcile-worker", "sqlite-repositories"],
  "observation-activity": ["controller", "view-model", "observer"],
  "ci-and-idempotent-github-effects": ["publish", "complete"],
  "scoped-verification": ["certification", "verification-policy", "process-verifier", "verify"],
  "runtime-budgets": ["agent-runtime"],
  "output-bounds-and-redaction": ["process-verifier"],
  "relation-graph-authority": ["relation-graph", "relation-checkpoint-certification", "prepare-relation-graph"],
  "target-advance-recovery": ["target-recovery", "publish-revision", "conflict-recovery", "scheduler", "controller"],
  "durable-retry-semantics": ["retry", "retry-checkpoints", "stale-reaper", "scheduler", "controller"],
  "terminal-preserving-migration": ["pristine-reset", "migration", "sqlite-repositories"],
};

const arguments_ = process.argv.slice(2);
let concurrency = 4;
let concurrencyConfigured = false;
let invalidArguments = false;
for (const argument of arguments_) {
  if (argument === "--dry-run") continue;
  if (!argument.startsWith("--concurrency=") || concurrencyConfigured) {
    invalidArguments = true;
    continue;
  }
  concurrencyConfigured = true;
  const value = argument.slice("--concurrency=".length);
  const parsed = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) {
    invalidArguments = true;
    continue;
  }
  concurrency = parsed;
}

const command = [process.execPath, "--test", `--test-concurrency=${concurrency}`, ...modules];
const renderedCommand = command.join(" ");
const commandAudit = {
  unexpectedTestTargets: modules.filter((target) =>
    !/^dist\/(?:[a-z0-9.-]+\/)*[a-z0-9.-]+\.test\.js$/i.test(target)
    || target.includes("..")
    || /[*?{}[\]]/.test(target)),
  fullSuiteCommandsInPlan: [
    /(?:^|\s)npm(?:\.cmd)?\s+(?:run\s+)?(?:test|test:next|test:legacy)(?:\s|$)/i.test(renderedCommand) ? "npm test" : undefined,
    modules.some((target) => /(?:^|\/)\*\*?\//.test(target)) ? "recursive test glob" : undefined,
  ].filter(Boolean),
  githubCommandsInPlan: command.filter((token) => /(?:^|[\\/])gh(?:\.exe)?$/i.test(token)),
};
if (commandAudit.unexpectedTestTargets.length
  || commandAudit.fullSuiteCommandsInPlan.length
  || commandAudit.githubCommandsInPlan.length) {
  throw new Error(`Unsafe certification command plan: ${JSON.stringify(commandAudit)}`);
}

const baseReport = {
  certification: "orchestration-dogfood-readiness",
  concurrency,
  mutationPolicy: "audited exact test files using local fakes and repositories; GitHub credentials removed",
  commandAudit,
  scope: {
    mode: "exact-test-files",
    fullSuite: commandAudit.fullSuiteCommandsInPlan.length > 0,
    modules,
  },
  scale: {
    oneIssuePerSlotNodes: 128,
    retainedFleetNodes: 500,
    frontierStressNodes: 1_000,
  },
  deterministicDiagnostics: [
    "dispatch-count",
    "attempt-count",
    "effective-capacity",
    "claim-conflict-candidates",
    "reachability-checks",
    "reachability-node-visits",
    "frontier-updates",
    "serialization-edge-count",
  ],
  coverage,
  command,
};

if (invalidArguments) {
  process.stderr.write("Usage: node scripts/certify-orchestration.mjs [--dry-run] [--concurrency=N]\n");
  process.exitCode = 2;
} else if (arguments_.includes("--dry-run")) {
  process.stdout.write(`${JSON.stringify({ ...baseReport, status: "planned" }, null, 2)}\n`);
} else {
  const certificationEnv = { ...process.env };
  for (const key of Object.keys(certificationEnv)) {
    if (/^(?:GH_|GITHUB_)/.test(key) || /(?:^|_)GITHUB_TOKEN$/.test(key)) delete certificationEnv[key];
  }
  certificationEnv.FORGEDOCK_CERTIFICATION_NO_GITHUB_MUTATIONS = "1";
  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    env: certificationEnv,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    process.stderr.write(`${JSON.stringify({ ...baseReport, status: "failed-to-start", error: error.message }, null, 2)}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    const passed = code === 0 && signal === null;
    process.stdout.write(`${JSON.stringify({
      ...baseReport,
      status: passed ? "passed" : "failed",
      exitCode: code,
      signal,
    }, null, 2)}\n`);
    process.exitCode = passed ? 0 : (code ?? 1);
  });
}
