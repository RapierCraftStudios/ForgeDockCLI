# ForgeDock `/orchestrate` audit — handoff prompt

You are taking over a behavior-first audit and improvement task for the native ForgeDockCLI `/orchestrate` implementation. Work in:

`C:\Users\ItsMr\Documents\Coding Projects\.forgedock-worktrees\forgedockcli\staging`

Read these first:

1. `AGENTS.md` in the repository root.
2. `.forgedock/orchestrate-watch.md` — the durable evidence ledger; this is the primary observation boundary.
3. `.forgedock/orchestrate-hyperperformance-plan.md` — the current improvement plan.
4. `commands/orchestrate.md` and the relevant `src/` orchestration/controller files.

## User mission

Audit and improve the actual native ForgeDock orchestration behavior, not merely the source code. Observe subprocesses, durable SQLite state, scheduler events, artifacts, issue/PR transitions, review findings, wall-clock time, retries, and token/time waste. The long-term target is reliable end-to-end issue closure with high-quality code and substantive review. The 5–8 minute/issue figure is only a soft aspiration; it is **not** a timeout, watchdog, or termination policy. Never add a hard cap based on that aspiration.

Review must filter real bugs, security flaws, architectural problems, correctness issues, and meaningful product/quality regressions. Do not create remediation work for formatting, imports, trivial mechanics, speculative concerns, or test-gap-only findings unless the missing test proves a concrete behavior defect.

If a live run shows a critical safety fault, duplicate mutation, overlapping builders, orphaned subprocesses, unsafe route, or confirmed dead family, stop only the exact validated process family and preserve the durable recovery state. Do not delete issues, artifacts, worktrees, branches, or databases.

## Current state

- The problematic seven-issue no-milestone `workflow:engine-error` run was explicitly stopped. No native `dist/cli/main.js orchestrate` process is currently active.
- Durable DAG: `dag_50ad2a24-44f7-4a1e-96a2-6766f7119f58`.
- Selected issues: #189, #194, #202, #209, #210, #211, #212.
- #189 completed/merged. #194 retains durable Intent, Investigation, Build Packet, BuildResult, and ReviewVerdict evidence at a review checkpoint. #202/#209/#210/#211/#212 were queued behind the broad fallback component claim.
- The DAG may still say `running` because the operator stopped the controller before its final transition. The supported recovery path is native `orchestrate --resume <dag-id>`; do not start a fresh semantic rerun or resume without first reading the durable projection and confirming the intended operator action.
- Stop sentinel: `.forgedock/no-ms-engine-errors-20260816-155957.ndjson.stop`.
- The broad fallback claim `component:RapierCraftStudios/ForgeDockCLI` serialized otherwise unrelated work. This is direct live evidence of a major throughput problem.
- #194 spent roughly 74 minutes without closure and entered repeated review/remediation activity; this is evidence of lifecycle/review/token inefficiency, not permission to impose a hard wall-clock cutoff.

## Code already integrated and pushed

Remote `origin/staging` and local `staging` both point to:

`450a74ae Merge remote-tracking branch 'origin/staging' into staging`

The preceding local commits include:

- `dd431ea1 fix(next): reconcile claim admission and resumable retries`
- `278e7add fix(next): harden orchestration lifecycle and resumable state`
- Reconciled remote issue-delivery commits for #189, #190, #192, #193, and #195.

The current claim-admission behavior is intentional:

- A newly discovered conflicting Build Packet scope is retained in live scheduler memory so automatic retry waits instead of hot-looping.
- The conflicting scope is **not** published to durable node claims until admission succeeds.
- On successful retry, the scope is durably promoted.
- Async promotion call sites are awaited; sink failure rolls back the in-memory promotion.

Persistent evidence files were updated with HP-19 (operator stop/resume checkpoint) and HP-20 (claim-admission integration checkpoint). Do not rewrite history or remove those entries.

## Verification already completed

- `npm run build` passed.
- Focused controller/scheduler tests: `49/49`.
- Focused TUI extension tests: `56/56`.
- Full native Next suite: `696/696` tests, `207` suites.
- Verification did not start a live controller.

## Safe next actions

1. Confirm `git status`, current remote tip, and that no orchestration process is active.
2. Read the tail of `.forgedock/orchestrate-watch.md` and inspect the saved DAG before any resume.
3. If continuing behavior observation, use the native resume path and an external observer that records process families, phase transitions, durable RunState changes, issue/PR updates, review findings, and token/time evidence.
4. Do not claim the platform has achieved ten new end-to-end closures yet; that proof remains outstanding.
5. Preserve untracked scratch files (`-`, `.forgedock.state.db`, `.forgedock/issue-207-artifacts.json`, `.tables`, `x`) unless the user explicitly authorizes cleanup. They were intentionally not staged or deleted.

Your job is to continue from this evidence, not to restart the investigation from repository-wide history or infer behavior solely from code.

## Live continuation — 2026-08-16/17 UTC

The supported native recovery was executed with:

`npm run next -- orchestrate --resume dag_50ad2a24-44f7-4a1e-96a2-6766f7119f58`

The active controller is the native CLI (`node bin/forgedock-next.mjs`), using the frozen plan `openai-codex/gpt-5.6-luna` with `max` thinking and transport capacity 4. It is not the Codex Forge adapter and it is not a second orchestration engine. The current live process family is recorded in `.forgedock/native-next-resume-2026-08-16T22-40-22-090Z.watch.ndjson`; stdout/stderr are in the matching `.out.log`/`.err.log` files.

Observed durable projection at approximately `2026-08-16T23:16:36Z`:

- #189 completed.
- #194 blocked at merge admission because GitHub did not report PR #281's reviewed SHA mergeable on `staging`.
- #202, #209, and #210 were marked failed by the controller with `Issue #... is decomposed but has no authoritative decomposed Outcome`. This was a native CLI resume-branch classification defect: any skipped terminal state other than completed/invalid was incorrectly routed through decomposition expansion. It did not indicate actual decomposition.
- #211 is running the same semantic run `run_0bd33d87-4d3d-4c71-8da3-19dea51986e7`, currently in review after BuildResult, with #212 queued behind the frozen broad component claim.

Run-scoped telemetry for #211 at that observation: 4 tasks (3 with usage), 413,670 input tokens, 66,022 output tokens, 2,952,704 cache-read tokens, 3,432,396 total tokens, estimated cost `$0.22101448`, 1,962,993 active milliseconds, zero retries. Build and verification completed; the worker entered review cycle 1 with correctness and concurrency reviewers. Controller heartbeats continued every 20 seconds.

Two native CLI fixes were committed locally as `366e5920` (`fix: preserve orchestration terminal states and scoped claims`):

1. Resume now expands children only for an actual `decomposed` terminal state; failed/blocked/cancelled runs retain their own terminal result and reason.
2. Explicit CLI orchestration no longer pre-seeds every issue with `component:<repo>` before affected-file evidence is read. Bounded affected paths now form the initial claims; the repository-wide fallback is used only when no path evidence exists. The frozen active DAG is intentionally unchanged so its observed serialization remains valid.

Validation after the patch: `npm run build` passed; focused orchestration controller/scheduler/terminal-result tests passed `52/52`. The active #211 worker independently reached the project full-test gate and then review; do not stop it while semantic progress/heartbeats continue.
