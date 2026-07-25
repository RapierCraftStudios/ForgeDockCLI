---
description: Orchestrate parallel work on multiple issues or an entire milestone — spawns sub-agents that each run the full /work-on pipeline
argument-hint: "[milestone <slug> | #1 #2 #3 | next <N> | fast-lane | priority:P0] [--auto|--confirm]"
---
<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# /orchestrate — Multi-Issue Parallel Orchestrator

**Input**: $ARGUMENTS

`--auto` and `--confirm` authorize the dispatch checkpoint; they are control
flags, not part of the issue-set query. `--deep-plan` requests the full analysis
path, and `--max-concurrent N` only tunes the dispatch cap.

This file is the slim dispatcher. Detailed phase content lives in `commands/orchestrate/`.

## OpenCode Preflight

When `FORGE_RUNTIME=opencode` (or an OpenCode runtime marker is present), run the
deterministic preflight at `$FORGE_HOME/bin/orchestrate-preflight.mjs` immediately,
before reading `orchestrate/config.md`, this workflow, or any phase spec. The helper
resolves the repository from `forge.yaml`, including a parent config when the target
is a nested Git worktree:

```bash
node "$FORGE_HOME/bin/orchestrate-preflight.mjs" \
  --repo "$GH_REPO" \
  --args "$ARGUMENTS"
```

The preflight is a compact mechanical adapter for issue resolution, eligibility,
explicit dependencies, scoped issue-body file overlap, database serialization, and
the initial ready queue. If it returns a supported plan with `requiresDeepPlan: false`
and `confirmed: true`, launch `dispatchNow` with native background `task` calls
immediately. Without an explicit `--auto` or `--confirm` argument, present the
compact plan and ask for one confirmation; after the user confirms, launch the
plan's ready queue without re-reading the large phase files. Do not load the full
Phase 3 or Phase 4 prose just to ask that question.

Continue through the phase files when the plan says `requiresDeepPlan`, the input is
unsupported, preflight fails, or a task-result event requires recovery. This adapter
never closes, deduplicates, or edits issues; the full shared workflow remains the
authority for investigations, review-finding cascade handling, recovery, cleanup,
and reporting.

For a supported compact OpenCode plan, stop after the fast-path dispatch. The phase
execution order below is the fallback path for deep plans, unsupported inputs,
preflight failures, and task-result recovery; do not read it merely to confirm or
dispatch a compact plan.

## Execution Order

Read and execute phases in sequence. Each phase file is self-contained.

| Step | File | Description |
|------|------|-------------|
| 0 | `orchestrate/config.md` | Hard rules, config resolution, multi-repo support — READ FIRST |
| 1 | `orchestrate/phase-1-resolve.md` | Resolve the issue set from input |
| 2 | `orchestrate/phase-2-triage.md` | Investigation-first triage, Wave 0 |
| 2.5 | `orchestrate/phase-2.5-synthesis.md` | Investigation synthesis and deconfliction |
| 3 | `orchestrate/phase-3-dependency.md` | Dependency analysis, DAG construction, execution plan |
| 4 | `orchestrate/phase-4-execution.md` | Streaming DAG execution, agent dispatch, stall detection |
| 5 | `orchestrate/phase-5-cleanup.md` | Post-batch cleanup sweep and agent audit |
| 6 | `orchestrate/phase-6-report.md` | Consolidated report and pipeline summary |
| — | `orchestrate/safety.md` | Safety rules and examples (reference) |

## Quick Reference

```
Read: $FORGE_HOME/commands/orchestrate/config.md       # ALWAYS READ FIRST
Read: $FORGE_HOME/commands/orchestrate/phase-1-resolve.md
Read: $FORGE_HOME/commands/orchestrate/phase-2-triage.md
Read: $FORGE_HOME/commands/orchestrate/phase-2.5-synthesis.md
Read: $FORGE_HOME/commands/orchestrate/phase-3-dependency.md
Read: $FORGE_HOME/commands/orchestrate/phase-4-execution.md
Read: $FORGE_HOME/commands/orchestrate/phase-5-cleanup.md
Read: $FORGE_HOME/commands/orchestrate/phase-6-report.md
```

The orchestrator reads only the phase file(s) relevant to the current step rather than
loading the full 2300-line monolith upfront.
