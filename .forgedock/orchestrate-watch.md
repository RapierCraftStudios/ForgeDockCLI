# ForgeDock Orchestration Behavior Audit

## Mission

The durable optimization investigation and compaction-safe execution plan is
maintained in `.forgedock/orchestrate-hyperperformance-plan.md`. This watch file
remains the empirical evidence ledger; the plan may reference only this ledger
and the artifacts/logs it explicitly names.

Audit the currently running native ForgeDock `/orchestrate` flow from operator
request through issue-set closure. This is a behavior-first audit: observed
processes, logs, durable records, GitHub artifacts, timestamps, and terminal
outcomes are primary evidence. Source code is used only after an observed event
needs explanation or a confirmed flaw needs to be located.

ForgeDock has not yet orchestrated an issue set end to end to closure. The audit
must therefore continue past initial planning and dispatch and determine exactly
where progress succeeds, stalls, diverges, or fails.

## Active Run

- Worktree: `C:\Users\ItsMr\Documents\Coding Projects\.forgedock-worktrees\forgedockcli\staging`
- Branch: `staging`
- Invocation: `/orchestrate https://github.com/RapierCraftStudios/ForgeDockCLI/issues?q=is%3Aissue%20state%3Aopen%20no%3Amilestone`
- Requested scope: all open issues in `RapierCraftStudios/ForgeDockCLI` without a milestone
- Initial observed query result: 43 issues
- Operator has not yet reported a typed DAG ID or worker dispatch.

## Audit Rules

1. Do not mutate, cancel, resume, confirm, or otherwise interfere with the active
   run unless the user explicitly authorizes that action.
2. Do not modify `.forgedock/state.db`, task records, task logs, GitHub issues,
   branches, pull requests, labels, or comments during observation.
3. Record behavior before reading implementation. Code may explain evidence; it
   must not substitute for evidence.
4. Distinguish supervisor planning, typed-controller execution, transport worker
   execution, nested reviewer execution, GitHub publication, merge, projection,
   and issue closure as separate boundaries.
5. Treat a worker/session spawn acknowledgement as transport evidence only, not
   semantic completion.
6. End-to-end success requires authoritative closure evidence for every selected
   issue or an explicit, correctly represented terminal disposition for work that
   cannot close.
7. Preserve timestamps, IDs, paths, exit states, and concise log excerpts needed
   to reproduce each confirmed flaw. Do not copy credentials or secrets.

## End-to-End Checkpoints

- [x] User invocation accepted by the ForgeDock terminal
- [x] Repository resolved from `remote.origin.url`
- [x] GitHub query executed and 43 candidate issues observed
- [ ] Typed orchestration tool invoked
- [ ] Authoritative issue scope frozen
- [ ] Preview rendered
- [ ] User dispatch authorization observed
- [ ] Durable orchestration/DAG record created
- [ ] Initial ready set dispatched
- [ ] Successors streamed as predecessors become terminal
- [ ] Work-on child controllers create durable run artifacts
- [ ] Verification and independent review complete
- [ ] Remediation/recovery paths behave correctly where exercised
- [ ] Pull requests merge where authorized
- [ ] Batch member outcomes project correctly
- [ ] Every selected issue reaches authoritative closure or a truthful terminal state
- [ ] Parent DAG reaches truthful terminal completion

## Observation Timeline

### Initial planning behavior

- The supervisor resolved `RapierCraftStudios/ForgeDockCLI` with
  `git config --get remote.origin.url`.
- It ran the decoded GitHub query with `gh issue list` and requested full bodies.
- A roughly 197 KB JSON result exceeded the visible tool-output limit, so the
  supervisor reran a bounded summary.
- It wrote all 43 issue bodies to `/tmp/forgedock-open-no-milestone.json`, then the
  file reader attempted `C:\tmp\...` and failed because Git Bash `/tmp` mapped to
  the Windows user temp directory.
- The supervisor recovered by calling `cygpath -w`, rendered a 119 KB text file,
  and read about 2,024 lines in three slices.
- It then began inferring dependencies, affected-file claims, batching policy,
  risk classes, and a complete execution plan.
- At the last operator-provided screen, the run was still planning and had not
  visibly invoked the typed orchestration tool or dispatched a worker.

### Live process and persistence baseline

- At `2026-08-15T22:57:27+05:30`, the active terminal process was PID `7776`
  (`node bin/forgedock-terminal.mjs`), under the expected `npm run terminal`
  launcher chain.
- From `22:57:55` through `22:58:26`, repeated process-tree sampling found no
  descendant controller, worker, `gh`, Git, shell, or reviewer process beneath
  PID `7776`.
- During that sample, `.forgedock/state.db` did not change and no file under
  `.forgedock/tasks/` was created or updated.
- Therefore the observed delay in this interval belongs to the supervisor model
  planning turn. It cannot be attributed to scheduler admission, SQLite writes,
  worker startup, work-on execution, verification, or review.
- A read-only SQLite snapshot showed one older orchestration record only:
  `dag_64873991-1fb8-4015-b9a0-e9469a496669`, created on 2026-08-14 for nine
  requested issues and terminally failed with one completed, two failed, one
  invalid, and one skipped work unit. It predates this invocation and provides
  a control record for detecting creation of the new DAG.
- At `2026-08-15T22:59:18+05:30`, an independent read-only GitHub query still
  returned exactly 43 open, no-milestone issues (`#188` through `#230`): 25 P1,
  16 P2, and 2 P3. None yet carried a `workflow:*` label attributable to this run.

### First typed-tool attempt

- After the long planning pass, the supervisor called `forgedock_orchestrate`
  with the 43 issue numbers, `maxParallel=10`, `dryRun=false`, and
  `autoMerge=true`.
- The call failed immediately with:
  `forgedock_orchestrate requires an invocation bound by the interactive
  /orchestrate command or an active preview confirmation`.
- The supervisor then began reasoning about preview tokens and attempting to
  recover by calling `forgedock_orchestrate` again.
- No preview, DAG ID, SQLite write, task record, or worker process was observed
  before this failure. This is an invocation-to-tool handoff failure, not a DAG
  scheduler or worker failure.

### Second typed-tool attempt and failed dispatch precondition

- The supervisor automatically retried and progressed farther than the first
  binding failure.
- The second attempt failed with:
  `Authenticated lease witness is required before orchestration dispatch`.
- The terminal accurately stated that no workers were started, but it did not
  disclose that GitHub had already been mutated.
- Read-only verification found six new open batch issues created by this failed
  invocation at approximately `23:03` local time:
  - `#231`: members `#218`, `#225`
  - `#232`: members `#223`, `#224`
  - `#233`: members `#217`, `#226`, `#227`
  - `#234`: members `#215`, `#220`
  - `#235`: members `#214`, `#228`
  - `#236`: members `#229`, `#230`
- All six contain durable batch contracts and remain open. Twelve original
  issues are therefore represented in newly materialized batch issues without
  a parent DAG record or worker owner.
- `.forgedock/lease-witness.json` is absent. `.forgedock/state.db` retained its
  pre-run timestamp, and no new task file exists.

## Confirmed Findings

### F-001: Explicit query routing performs an unbounded supervisor-side planning pass

Status: observed; engineering boundary identified; end impact still being measured.

Evidence:

- The query URL already provides repository and authoritative membership intent.
- The supervisor nevertheless loaded every selected issue body into its own
  context to construct a complete execution plan.
- This produced output truncation, duplicate queries, temporary-file handling,
  a cross-shell path error, and multiple large reads before controller admission.

Behavioral risk:

- High pre-dispatch latency and token use.
- Larger issue sets may exhaust context or never reach controller dispatch.
- Supervisor-derived dependency/claim inference can be less reliable than a
  bounded typed planning stage over authoritative records.

Relevant code was inspected only after observing the behavior. The native prompt
currently requires a complete per-issue execution plan, while the typed tool later
fetches authoritative issue records again.

### F-002: Interactive `/orchestrate` loses or never establishes its typed-tool binding

Status: observed transient failure; automatic retry later crossed this boundary;
precise event ordering remains to be instrumented.

Evidence:

- The operator invoked `/orchestrate` interactively and supplied the URL on the
  following input line.
- The semantic supervisor received that request and completed GitHub discovery.
- Its first typed-tool call was rejected because neither a pending interactive
  invocation nor a preview checkpoint existed.

Impact:

- The first attempt could not reach preview, admission, durable DAG creation, or
  dispatch.
- The error invites model-driven recovery even though the missing binding is
  extension-owned state the model cannot safely reconstruct.
- In this run the supervisor did automatically retry and reached the later lease
  witness check. That recovery contradicts treating the binding loss as
  permanently unrecoverable and must be explained before fixing it.

Implementation correlation after observation (working hypothesis, not yet proven
as the complete cause):

- The slash-command handler binds the pending invocation and then queues the
  orchestration prompt as a Pi `followUp` message.
- The handler returns before that follow-up model turn invokes the tool.
- Pi's `agent_settled` handler calls `restoreAssistantMode()`, which unconditionally
  deletes the pending orchestration invocation.
- The later follow-up model turn therefore reaches the typed tool with neither a
  pending binding nor a preview checkpoint and receives the observed error.
- Existing tests assert command queuing and direct bound-tool execution as
  separate cases. They do not execute the real sequence of slash-command bind,
  queued follow-up settlement, and tool call. One test explicitly settles after
  command queuing and checks tool deactivation, thereby encoding the lifecycle
  action that clears the binding without checking the subsequent tool handoff.

Likely correction boundary:

- Establish or refresh the invocation binding when the queued native-workflow
  message actually begins its model turn, using structured message details that
  retain the raw arguments; do not rely on pre-follow-up transient state.
- Add an integration test reproducing the exact event order observed in the live
  terminal before considering this finding resolved.

### F-003: Mandatory lease-witness readiness is checked after expensive planning

Status: confirmed blocker; not yet fixed.

Evidence:

- The checkout has no `.forgedock/lease-witness.json`.
- The invocation spent minutes enumerating and planning 43 issues before reporting
  the missing mandatory prerequisite.
- No DAG can execute without witnessed admission, so this condition was knowable
  before issue-body retrieval, plan synthesis, preview, or materialization.

Impact:

- Operators pay the complete planning cost for an invocation that cannot dispatch.
- The failure appears late and is presented as a manual recovery instruction
  instead of a preflight or onboarding requirement.

### F-004: Batch issues are materialized before dispatch admission succeeds

Status: confirmed high-severity transactional flaw; local ordering fix implemented;
live verification and orphan cleanup/reconciliation remain pending.

Evidence:

- Six batch issues (`#231`–`#236`) were created before the lease-witness check
  failed.
- No new orchestration record or task record exists to own those batch issues.
- The terminal reported only that dispatch was blocked and no workers started;
  it did not report the partial GitHub mutations or offer cleanup/reconciliation.

Impact:

- Failed preflight leaves durable orphan work items in GitHub.
- A retry may adopt, duplicate, or conflict with these batches depending on marker
  reconciliation behavior.
- The parent run has no durable record from which cleanup or resume can be driven.

Required correction boundary:

- Validate witnessed execution admission before any GitHub mutation, or create a
  durable parent record and reservation before materialization with idempotent
  rollback/reconciliation semantics.
- Failure reporting must disclose every durable side effect and its recovery path.

## Open Questions / Watch Targets

- Does the supervisor eventually call `forgedock_orchestrate`, or does context
  pressure prevent it from reaching the tool call?
- Is preview the configured dispatch mode, and does confirmation preserve the
  exact frozen plan without repeating discovery?
- Is a durable DAG record written before the first worker launch?
- Does transport capacity cap concurrency as intended without starving ready work?
- Are work-on controller tasks spawned directly or through Pi subagent RPC?
- Are worker completions reconciled from authoritative Outcome artifacts rather
  than process exit alone?
- Do failures/suspensions leave successors truthfully queued and resumable?
- Do batch issues project merged Outcomes to all members before closure?
- Does the parent orchestration ever report completion while member issues remain open?

## Fix Direction

Keep the supervisor responsible for semantic intent and ambiguity resolution, but
avoid sending the full issue corpus through its conversation. Let typed code fetch
and freeze authoritative metadata, derive deterministic fields, conservatively
serialize unknown claims, and use bounded model analysis only for residual
ambiguity. Any change must be justified by the completed behavioral timeline.

## Remediation Log

### Local fixes after the first failed run

1. Invocation handoff:
   - Preserve the pending `/orchestrate` binding when the slash-command dispatch
     turn settles before its queued custom follow-up starts.
   - Mark the actual orchestration prompt as started from its custom-message event,
     after which normal settlement cleanup resumes.
   - Retain raw arguments in structured custom-message details.
2. Witness preflight and mutation ordering:
   - Resolve effective dispatch policy before GitHub discovery.
   - Require and open witnessed durable persistence for every dispatch-capable
     mode before GitHub reads or batch materialization.
   - Keep pure preview and dry-run paths usable without a witness.
3. Supervisor planning cost:
   - Explicit GitHub queries and ordinary exact issue sets no longer require the
     supervisor to load every issue body or synthesize a complete execution plan.
   - The typed tool now derives priority, affected-file claims, exact structured
     dependency sections, Source PR, FORGE:CLASS, and risk from the authoritative
     issue records it already retrieves.
   - Issues without bounded claim evidence retain conservative repository-wide
     serialization.

### Local verification

- `npm run build`: passing.
- Focused TUI/orchestration suite: 102 tests passing, 0 failing.
- Full ForgeDock Next suite: 621 tests passing, 0 failing.
- New regression coverage exercises:
  - slash-command settlement before queued orchestration prompt start;
  - missing witness failure before GitHub/durable mutation work;
  - bounded typed metadata derivation without treating unrelated body references
    as dependencies;
  - prompt contract forbidding full-corpus issue-body ingestion for complete
    GitHub queries.

### Required before the next live run

- Run the full Next test suite.
- Bootstrap or explicitly configure the checkout's authenticated lease witness.
- Decide how to recover or close `#231`–`#236`. They are part of the next query's
  open/no-milestone membership and must not be silently duplicated or co-scheduled
  with their twelve original members.
- Start a fresh terminal from the rebuilt staging worktree and resume behavior-first
  observation from invocation through closure.

### 2026-08-16 restart checkpoint

- The host restarted; no ForgeDock terminal survived, as expected.
- The OS-local witness directory survived, but the checkout reference remained
  absent, confirming the prior partial-bootstrap state was durable.
- Added a fail-closed recovery path for the atomic-install interruption window.
  Recovery accepts only the exact three expected regular files, the canonical
  checkout-derived key identity, a matching Ed25519 keypair, and a valid signed
  checkpoint. It writes only the missing checkout reference and never rewrites
  retained material.
- Witness recovery tests: 7 passed, 0 failed. Build and `git diff --check` pass.
- Live recovery succeeded with `recovered: true` for checkout digest
  `bcced3f88e76292cf7b3d9c98817eb1044638f5b068474835551b8c3082c63b8`.
- Earlier prerequisites are now satisfied: the full Next suite passed 623/623,
  and the authenticated witness is configured for this checkout.
- Next action: start `npm run terminal`, invoke the same `/orchestrate` URL, and
  observe preflight, existing-batch reconciliation, durable DAG creation,
  dispatch, worker progression, merge, projection, and closure.

### 2026-08-16 second live run

- Terminal PID: `5636`.
- The supervisor used bounded number/title discovery and did not ingest the
  complete issue-body corpus into model context.
- Preview confirmation was presented and the user explicitly entered
  `proceed`.
- Confirmed execution created batch issues `#237` through `#243` before the
  durable DAG write. The first batch creation was observed at
  `2026-08-16T00:49:37Z`; the parent SQLite WAL first changed at
  `2026-08-16T00:50:26Z`.
- Durable parent: `dag_60083266-eaaf-4a54-b77b-e371a7f507d3`, 43 requested
  source issues, 34 work units, `maxParallel=4`.
- No worker was launched. The retained checkpoint was epoch 1 while
  `lease_state.max_epoch` was 0, so execution admission failed before acquiring
  a lease.
- The delegator resolved its first-dispatch signal from the rejection handler,
  raced that signal against the rejected completion, and returned a false
  `started streaming DAG` result. The durable parent remained `running` with
  `executionAttempt=0`, no claim ID, 34 queued nodes, and no attempts.
- The user exited the terminal and closed generated batch issues `#231` through
  `#243`. Original issues `#188` through `#230` were not closed.

### Findings from the second run

#### F-005: Confirmed preview replay repeats expensive authoritative discovery

Status: confirmed performance flaw; optimization still pending.

- The typed tool fetched issue bodies and comments across the selected set and
  repeated authoritative reads during confirmed replay and batch revalidation.
- This work stays out of model context, but it creates high subprocess/API
  volume and delays admission materially.

#### F-006: TUI batch reservations were process-local

Status: confirmed recovery flaw; local fix implemented, live verification pending.

- TUI orchestration constructed `GitHubClient` with its default in-memory
  remediation-admission repository even after witnessed SQLite was available.
- A restart therefore forgot pending/materialized batch reservations and could
  create another issue instead of reconciling its canonical marker.
- Confirmed TUI execution now supplies the witnessed SQLite repository to the
  GitHub adapter. Every materialization claim is durable before the GitHub write.

#### F-007: Bootstrap epoch and empty SQLite epoch disagree

Status: confirmed dispatch blocker; local fix implemented and tested.

- Historical bootstrap seeded checkpoint epoch 1 while a fresh/unused SQLite
  lease store starts at epoch 0. Exact equality admission rejected all first use.
- New bootstraps seed epoch 0 and advance to 1 on first acquire.
- Historical epoch-1 witnesses may initialize SQLite only when local maximum is
  exactly 0 and the lease table is empty; all stores with lease history continue
  to fail closed on divergence.

#### F-008: Pre-dispatch rejection is reported as successful delegation

Status: confirmed correctness/observability flaw; local fix implemented and tested.

- The delegator signalled first dispatch in its rejection handler, allowing the
  tool to return `started` even when execution admission failed.
- Rejections no longer signal dispatch, so the originating tool call receives
  the error.
- A newly created, wholly unstarted DAG is now persisted as failed when
  execution admission itself throws.
- Dispatch-capable TUI orchestration performs an actual acquire/assert/release
  preflight before any GitHub mutation; opening key files alone is insufficient.

### Verification after second-run fixes

- Focused witness/controller/TUI suite: 78 passed, 0 failed.
- Full ForgeDock Next suite: 627 passed, 0 failed across 193 suites.
- `npm run build` and `git diff --check`: passing.
- Next live action must be a fresh orchestration because the prior DAG points at
  batch issues the user closed. Do not resume `dag_60083266...`.
- Reconciled `dag_60083266...` from false `running` to `failed` only after an
  exact guard proved `executionAttempt=0`, no claim, all 34 nodes queued, and no
  worker attempts. The nodes and record remain available as audit evidence.

### 2026-08-16 third live run (active)

- Terminal PID: `34708`; observer PID: `6892`; observer log:
  `.forgedock/orchestrate-live-20260816-063103.ndjson`.
- Invocation used the same GitHub query for open issues without a milestone.
  Bounded supervisor discovery found source issues `#188` through `#230`.
- Preview remained read-only: before confirmation there was no SQLite write,
  no new GitHub issue, no DAG, and no worker process.
- Preview construction nevertheless fetched every selected issue and its
  comments more than once, including one sequential pass followed by a broad
  concurrent pass. This strengthens F-005: typed discovery is bounded away from
  model context but operationally expensive and duplicative.
- User entered exact confirmation `proceed` after the clean preview boundary.
- Confirmed execution performed an authenticated acquire/assert/release lease
  preflight before the first GitHub mutation. The historical witness bridge
  advanced `lease_state.max_epoch` from 0 to 2 and left no active lease,
  live-verifying F-007's compatibility path.
- Batch admission was written durably before each `gh issue create` and marked
  materialized afterward, live-verifying F-006. Batch issues `#244` through
  `#250` were created. Per batch, the runtime also repeated member fetches, a
  full `issues?state=all` scan, and a `gh label create --force` call.
- Fresh durable parent: `dag_1b7f0a8c-4532-4e2b-bb07-56b9659ef40c`, 43 source
  issues, 34 work units, execution attempt 1, authenticated claim
  `3:b02c38b5a6661c62`.
- Requested `maxParallel=4` was reduced to `effectiveMaxParallel=2` because the
  nested transport advertised capacity 2. The durable record exposes this,
  but the interactive preview did not make the effective reduction apparent.
- First eligible workers launched successfully at `2026-08-16T01:07:15Z`:
  issue `#189` as task `task_55fbe7a9d3` and issue `#190` as task
  `task_aba53906a0`. Both created isolated worktrees and entered the native
  `work-on` pipeline. This live-verifies F-008's corrected dispatch result.
- Current active work: `#190` is running its Codex investigation after its
  baseline gate; `#189` has entered the full workflow after a slower baseline
  installation. Continue observing controller logs, durable transitions,
  reviews, merges, dependency release, and end-to-end closure.

### Third-run stop condition

- The run was intentionally terminated at `2026-08-16T01:29:35Z` after a
  confirmed cross-worker claim-coordination failure. The user explicitly
  authorized terminating the terminal on an actual orchestration fault to
  avoid wasting model tokens.
- Issue `#190` promoted a Build Packet whose `expectedPaths` include
  `src/workflows/orchestrate/scheduler.ts`, then entered `building` at
  `2026-08-16T01:22:33Z` and edited that file.
- Issue `#189` later promoted a Build Packet whose `expectedPaths` also include
  `src/workflows/orchestrate/scheduler.ts`, but it too entered `building` at
  `2026-08-16T01:27:24Z` instead of suspending on the active claim.
- The parent DAG still stored only the initial under-approximated claims:
  `#189 -> src/workflows/orchestrate/batching.ts` and
  `#190 -> src/workflows/work-on/work-on.ts`. It had no child run IDs and no
  updated attempt timestamp despite both child workflows reaching later phases.
- This proves dynamic Build Packet claim promotion did not reach or update the
  parent scheduler across the native background-controller process boundary.
  Both isolated branches could therefore edit the same file concurrently.
- Terminal PID `34708` and worker PIDs `16352`/`19764` were killed child-first
  after exact command-line and process-creation validation. Observer PID
  `25620` then stopped cleanly. All worktrees, task logs, observation events,
  artifacts, leases, and DAG records were retained for diagnosis.
- Audit watcher hardening: Windows may reuse a dead numeric parent PID. The
  watcher now rejects a parent-child edge when the alleged child predates the
  current parent process, preventing unrelated older processes from entering
  the evidence tree.

#### F-009: Dynamic claims do not cross the native task boundary

Status: confirmed orchestration safety failure; local fix implemented, focused tests passing; full-suite verification pending.

- Initial issue-derived claims are sufficient to launch a controller task but
  can under-approximate the Build Packet's authoritative `expectedPaths`.
- A standalone `forgedock-next work-on` child can prepare and build against its
  packet without the parent scheduler atomically accepting those promoted
  claims. The durable DAG consequently retains stale claims while overlapping
  workers keep running.
- Required invariant: before a child starts any builder work, its exact frozen
  packet paths must be submitted to the parent orchestration admission owner;
  the parent must atomically accept and persist them or return the typed claim
  conflict that leaves the child at its resumable Build Packet checkpoint.

### F-009 implementation and verification notes

- Each native controller task now receives a per-task authenticated loopback
  claim arbiter bound to the exact orchestration ID, node ID, and durable
  attempt ID. Tokens and endpoints are carried only in the child environment.
- The standalone `work-on` process awaits parent arbitration after freezing its
  Build Packet and before builder dispatch. Early preparation resumes and all
  retained Build Packet resumes re-arbitrate as well, closing the crash window
  between artifact persistence and claim promotion.
- The parent scheduler reserves promoted claims synchronously against its live
  running set, then persists the expanded node claims before returning success
  to the child. A competing promotion returns a typed conflict over HTTP 409.
- Missing, partial, dead, unauthenticated, or stale-attempt transport fails
  closed. If the terminal dies while a child is preparing, that child cannot
  silently continue into building.
- A claim conflict no longer turns the issue workflow into a failed Outcome or
  deletes its worktree. The durable run remains at its frozen `building`
  checkpoint, the native task exits as blocked, and the parent node becomes
  `suspended` for explicit orchestration resume.
- Focused transport, scheduler, parent-controller, TUI-delegator, and work-on
  trajectory tests: 115 passed, 0 failed. Tests prove that the parent DAG is
  updated before acknowledgement, a second overlapping native worker is
  suspended, and no builder is dispatched while admission is pending.
- Full ForgeDock Next suite after the F-009 fix: 632 passed, 0 failed across 197
  top-level suites/tests. `npm run build` and `git diff --check` also pass.
- The killed terminal has not been restarted. The stopped DAG and issue
  worktrees remain preserved as audit evidence; no unfinished worker changes
  were adopted into staging.

### Stopped DAG reconciliation

- At `2026-08-16T01:45:43.788Z`, exact guards confirmed terminal PID `34708`
  and worker PIDs `16352`/`19764` were absent, the issue and execution leases
  were expired, the parent record was still the original running execution
  attempt/claim, and its active attempt/task identities still matched the
  killed processes.
- A consistent SQLite backup was created at
  `.forgedock/state-before-dag-1b7f0a8c-cancel.db`.
- Parent `dag_1b7f0a8c-4532-4e2b-bb07-56b9659ef40c` is now `cancelled` so it
  cannot be accidentally resumed. Nodes `issue-189` and `issue-190` are
  `suspended`; their active pointers were cleared and their exact attempts are
  marked `interrupted` with the operator stop reason. Queued nodes, worktrees,
  logs, artifacts, and expired leases remain preserved.
- GitHub batch issues `#244` through `#250` were not changed. They must be
  excluded or closed before another broad `no:milestone` live query, otherwise
  they can re-enter source selection.

### Post-cancellation cleanup

- GitHub authentication had expired when cleanup began. A read-only native
  status call exercised ForgeDock's configured authentication recovery, after
  which repository cleanup continued normally.
- Exactly seven open `batch` issues existed, all created by the cancelled run:
  `#244` through `#250`. Each was closed with a comment naming the cancelled
  DAG and the confirmed safety failure. No other issue was closed.
- Native `forgedock-next reset` was run for source issues `#189` and `#190`.
  Their interrupted run IDs now have durable `abandoned` Outcomes on GitHub;
  workflow labels were cleared, no PR existed to close, and all prior Intent,
  Investigation, Build Packet, telemetry, and comments remain audit history.
- GitHub reconstruction now reports both issues as `cancelled`. Their ordinary
  triage labels remain `review-finding`, `needs-validation`, and `priority:P1`.
- The broad open/no-milestone query is back to exactly 43 source issues,
  `#188` through `#230`; open batch count is zero.
- The interrupted issue worktrees remain registered and untouched as forensic
  evidence. New attempts use new run-scoped worktrees, so they do not collide.

#### F-010: Dead detached task records consume transport capacity

Status: confirmed live-run throughput/dispatch flaw; local fix implemented and fully tested.

- Four dead controller records remained durably `detached`. Before the fix,
  transport capacity counted their labels rather than actual supervised
  process liveness. Two older dead review tasks reduced the third run from the
  requested four workers to two; adding the two killed workers would have
  reduced the next run to zero and blocked dispatch entirely.
- Background task supervision now exposes operational liveness separately from
  the retained record status. Dead detached records remain visible audit
  evidence but no longer consume capacity or masquerade as attachable workers.
- Recovery attaches only when the task is both labeled active and operationally
  live; a dead detached task proceeds through durable workflow reconciliation.
- Live inspection after the fix found all four retained detached records
  `active=false` and `operational_active=0`, restoring all four transport slots.
- Focused background-task/TUI/controller suite: 82 passed, 0 failed. Full
  ForgeDock Next suite: 633 passed, 0 failed across 198 top-level suites/tests.
  `npm run build` and `git diff --check` pass.

### Fresh live verification run (2026-08-16 08:22 local)

- The user restarted `npm run terminal` from the staging checkout after the
  F-009/F-010 fixes. The exact native terminal process is PID `9196`, created
  at `2026-08-16 08:22:35` local, beneath npm PID `26820` and command-shell
  PID `30320`.
- A fresh observer is running as PID `16764`, bound to terminal PID `9196`.
  Its evidence stream is
  `.forgedock/orchestrate-live-20260816-082402.ndjson` and its first record is
  `observer_started` at `2026-08-16T02:54:02.3015814Z`.
- Continue behavior-first observation through preview, confirmation, native
  worker dispatch, claim promotion, review/merge, and cleanup. If a confirmed
  safety/runtime fault occurs, terminate only the creation-time-validated
  terminal process tree immediately and preserve all evidence before cleanup.

### Fresh live verification result: stopped before dispatch

- Preview token `422f0a55-cb1d-4354-a837-9594c28d856f` selected the correct
  43 source issues and proposed 34 work units with seven batch groups. Preview
  created no issues, DAG, or workers and changed no ForgeDock state files.
- The user confirmed at `2026-08-16T02:59:15.817Z`. Confirmation failed before
  any worker or DAG creation with: `Cached batch admission no longer matches an
  open authoritative GitHub issue for <!-- FORGEDOCK:BATCH 218-225 -->`.
- The supervisor did not stop after the terminal tool error. It began multiple
  broad/status calls, including an unfiltered status result truncated at 50KB.
  To prevent further token waste, exact creation-time guards were applied and
  terminal PID `9196` was killed at approximately `2026-08-16T03:00:30Z`.
  No descendants were active at kill time. Observer PID `16764` then stopped
  normally at `2026-08-16T03:00:37.2171175Z`.
- Post-stop authority checks: zero open batch issues; 43 open/no-milestone
  source issues; no new orchestration record. The only durable DAG remains the
  previously cancelled `dag_1b7f0a8c-4532-4e2b-bb07-56b9659ef40c`.

#### F-011: Preview hydrates every selected issue four times

Status: confirmed live performance/rate-limit flaw; local fix implemented and tested.

- Observer evidence recorded exactly 172 `gh issue view` calls for 43 issues,
  plus matching comment retrievals: four complete issue hydrations per issue.
  The first two passes were serial and the final two were launched together.
- Root cause: query membership eligibility, selected-set eligibility, final
  scope observation, and authoritative plan derivation each fetched the same
  issue. The first three are checks over one read-only routing snapshot.
- Routed scope resolution now memoizes issue reads only for the lifetime of
  that resolution call. Planning deliberately retains its later fresh
  authoritative pass, reducing expected preview hydration from four reads per
  issue to two without extending snapshot lifetime across phase boundaries.

#### F-012: Supervisor invents a concurrency override

Status: confirmed live policy/presentation flaw; local authority guard implemented and tested.

- The user supplied no concurrency value and `forge.yaml` has no override, so
  the configured default is four. The supervisor nevertheless passed
  `maxParallel=20`, and preview advertised a concurrency cap of 20. Native
  execution would have separately clamped transport capacity to four, making
  the confirmed preview misleading even though runtime dispatch stayed safe.
- The native orchestration prompt now requires `maxParallel` to be omitted
  unless the user explicitly requested a concurrency value. The typed tool
  also independently rejects any supplied override that neither matches an
  explicitly parsed user concurrency request nor the configured default. This
  keeps model suggestions from expanding execution policy authority.

#### F-013: Closed cached batch projections permanently block a fresh run

Status: confirmed live dispatch blocker; local fix implemented and fully tested.

- Durable single-flight admission correctly retained the seven earlier batch
  projections, but cleanup had authoritatively closed their GitHub issues.
  Batch materialization combined closed state and marker loss into one fatal
  error and had no stale-projection recovery, unlike review findings.
- A closed cached batch projection is now atomically invalidated using the
  existing expected-issue-number compare-and-delete operation, then safely
  re-enters materialization. Concurrent contenders still observe pending or
  the replacement projection and cannot duplicate the batch.
- An OPEN cached issue that loses its canonical root marker still fails closed;
  it is never silently replaced.
- Focused GitHub/TUI tests: 100 passed, 0 failed. Full ForgeDock Next suite:
  636 passed, 0 failed across 200 top-level suites/tests. `npm run build` and
  `git diff --check` pass.

#### F-014: Pre-dispatch failure triggers unbounded, unrelated status polling

Status: confirmed live token/diagnostic-control flaw; local prompt guard implemented and tested.

- After confirmation failed before returning a DAG or task identity, the
  supervisor invoked an unfiltered global status call (whose result exceeded
  50KB and was truncated), then several unrelated per-issue status calls.
  Because no execution existed, none could diagnose or recover the failed
  materialization and the calls only consumed context/tokens.
- Native orchestration guidance now distinguishes a pre-dispatch tool failure
  from a delegated execution failure. Before any orchestration/task identity
  exists it must report the exact error and yield without status polling.
  After delegation it may inspect only the returned identity and is explicitly
  forbidden from issuing an unfiltered global status poll.

### Next live verification run (2026-08-16 08:42 local)

- Fresh terminal PID `34360`, created `2026-08-16 08:42:29` local under npm
  PID `27924` and command shell PID `33840`.
- Observer PID `34460` is bound to that exact terminal and writes
  `.forgedock/orchestrate-live-20260816-084313.ndjson`.
- Required checkpoints: preview uses configured concurrency four; route reads
  are reduced; confirmation invalidates/replaces closed batch admissions;
  exactly four native workers dispatch; every Build Packet claim is promoted
  through the authenticated parent arbiter before builder execution.

#### Current invocation checkpoint (2026-08-16 08:46 local)

- Pi session `01a0088e-835b-7bb8-9088-cb848c933e41` resolved the bounded
  GitHub query to exactly 43 open, no-milestone issues (#188-#230).
- The model correctly omitted `maxParallel` from `forgedock_orchestrate`; the
  native configured default must therefore produce a preview/runtime cap of 4.
- At `2026-08-16T03:16:48Z`, the terminal was alive and still performing the
  first authoritative hydration pass (31 observed `gh issue view` calls).
  No GitHub mutation command was observed. Do not confirm until the completed
  preview is inspected and the full hydration count is recorded.
- Preview token `5319a4af-bd20-44ac-a74e-3086a908eb15` completed at
  `2026-08-16T03:17:05Z`: exactly 43 source issues, 34 proposed work units,
  seven same-file batches, and concurrency cap 4. The observer recorded
  exactly 86 `gh issue view` calls (two per source issue) and no mutation
  commands before confirmation. User was told it is safe to type `proceed`.

#### Confirmed dispatch and critical stop

- Confirmation entered at `2026-08-16T03:18:02Z`. Closed cached projections
  #244-#250 were safely invalidated and replaced by open batches #251-#257.
- New DAG `dag_0a31acc5-3ca0-49d3-a4ec-28d7c1faf4b9` was created with
  `maxParallel=4` and held exactly four native controller workers. Initial
  #189/#190 workers exited 0 almost immediately, after which #192-#195 filled
  the four slots; the concurrency cap behaved correctly.
- The DAG nevertheless became non-closable immediately: #189 and #190 were
  marked failed with `has no completed terminal Outcome; reconciled state is
  cancelled`. Their task logs said the prior run was already cancelled and no
  duplicate run was created.
- Exact PID/creation-time guards terminated terminal PID 34360 and its complete
  descendant tree at approximately `2026-08-16T03:20:41Z`. Observer PID 34460
  stopped normally at `2026-08-16T03:20:46.041Z`. No worker processes remain.
  The failed DAG, task records, replacement batches, and worker worktrees are
  retained as evidence.

#### F-015: Reset abandonment permanently locks the issue against a clean run

Status: confirmed live end-to-end blocker; local fix implemented and tested.

- Native reset appended a final durable `Outcome: abandoned` to #189/#190,
  explicitly stating that the next attempt should start cleanly. Admission
  reconciled that status to `cancelled` and treated it like an ordinary
  terminal deduplication result, so a subsequent initial orchestration worker
  exited 0 without creating a new run. The parent then correctly rejected the
  absence of a completed terminal Outcome, permanently failing both nodes.
- Subject admission now treats a final durable abandoned Outcome as the reset
  authorization to start a new semantic run without requiring an additional
  `--rerun` flag. It requires abandonment to be the final artifact; evidence
  published afterward remains fail-closed and is not silently discarded.
- Focused admission suite: 38 passed, 0 failed. Full ForgeDock Next suite:
  638 passed, 0 failed across 200 top-level suites/tests. `npm run build`
  passes.

#### Planned recovery

- Resume the existing exact DAG instead of issuing the broad no-milestone
  query again. Keep open replacement batches #251-#257; they are already the
  durable contracted work units for this DAG.
- Start a fresh terminal built from the fixed checkout, then explicitly resume
  `dag_0a31acc5-3ca0-49d3-a4ec-28d7c1faf4b9` with fresh-rerun authorization
  for #189 and #190. Completed nodes (none yet) remain preserved. Dead
  #192-#195 task records have been operationally reconciled as detached/failed
  and must be relaunched through the DAG resume path, not ad-hoc work-on.
- At the pre-resume snapshot the DAG is `running`, execution attempt 1,
  effective concurrency 4: two failed nodes (#189/#190), four stale running
  nodes (#192-#195), and 28 queued nodes. No matching live worker process or
  active lease remains.

#### Headless ownership (2026-08-16 09:02 local)

- The user authorized fully headless continuation; no interactive terminal or
  further confirmation is required.
- Before launch, CLI resume inspection exposed that its in-process `workOn`
  calls had no direct parent scheduler claim callback. The shared promotion
  boundary now supports authenticated subprocess transport, a direct local
  controller callback, or both for nested ownership. Both fresh and retained
  Build Packet paths in CLI recovery use it. Focused admission/transport tests
  pass 43/43 and the build passes.
- Headless controller PID `14172`, created `2026-08-16 09:02:14` local, is
  running `forgedock-next orchestrate --resume
  dag_0a31acc5-3ca0-49d3-a4ec-28d7c1faf4b9`.
- Stdout: `.forgedock/headless-resume-20260816-090213.log`; stderr:
  `.forgedock/headless-resume-20260816-090213.stderr.log`; observer PID
  `34224`; trace `.forgedock/headless-resume-20260816-090213.ndjson`.
- Resume relaunched exactly four nodes (#189, #190, #192, #193). #189/#190
  passed the former abandonment lock and entered controlled delivery instead
  of exiting as cancelled.

#### Headless attempt-2 live checkpoint (2026-08-16 09:08 local)

- The durable DAG remains `running` at execution attempt 2 with exactly four
  running nodes (#189, #190, #192, #193), 30 queued nodes, and no failed or
  suspended nodes. All four active attempts still own their original static
  claims; no dynamic Build Packet claims have been promoted yet.
- Baseline setup ran `npm ci` for the four admitted nodes concurrently, while
  the expensive full `npm test` baseline checks have so far progressed one
  worktree at a time: #193 completed first, then #192. This is currently a
  throughput observation, not a safety fault; retain timing evidence and
  determine whether serialization is intentional before changing it.
- #193 created clean run `run_84603a54-d642-4200-aa1d-f183b27cd668`, posted
  its Intent at `2026-08-16T03:35:59Z`, and entered investigation in worktree
  `issue-193-2-4200-aa1d-f183b27cd668`. #192 entered its full workflow after
  its baseline completed. #189/#190 remain admitted and pre-workflow while
  their baseline sequence catches up; neither repeated the abandoned-run
  short circuit.
- Several test subprocess launchers exited before their descendants, so a
  live PID tree reconstructed only from current parent links is incomplete on
  Windows. The creation-time observer trace remains the authoritative process
  genealogy for termination and timing analysis.

#### Live parent claim-promotion proof (2026-08-16 09:20 local)

- #192 committed Build Packet `art_393f97ae-d696-449e-bd07-4bf9c846cc0c`
  at `2026-08-16T03:50:23.197Z`; the run reached building/version 3 at
  `03:50:24.741Z` with expected paths `src/workflows/deep-plan/handoff.ts`
  and `src/workflows/deep-plan/handoff.test.ts`.
- Before the #192 builder session began, the parent controller durably replaced
  the node's single static claim with those two exact packet paths and emitted
  a scheduler snapshot. The worktree had no scoped source edit at the barrier
  (`git status` showed only controller-created `.forgedock/` metadata).
- #193 then followed the same order: its packet committed at
  `2026-08-16T03:50:41.259Z`, the parent DAG expanded the node to six packet
  paths by `03:50:46.444Z`, emitted a snapshot, and only then started the
  builder. This is the first live proof that CLI-headless, in-process work-on
  now uses the authenticated parent claim-promotion boundary.
- #189 and #190 investigations both confirmed broad dynamic scopes that
  overlap in scheduler/controller/SQLite surfaces despite disjoint static
  issue claims. Their packet promotions remain the required live conflict
  canary: one must be suspended before builder work if both packets retain the
  overlapping paths.
- Efficiency observation: investigators and packet authors repeatedly probe
  `path="."`, guessed `test`/`tests` roots, and absolute workspace directories
  that the scoped file tools reject before recovering to exact paths. This is
  non-terminal but consumes substantial calls and should be corrected after
  safety/closure behavior is proven.

#### F-017: CLI resume loses typed claim suspension (2026-08-16 09:23 local)

Status: confirmed live end-to-end blocker; controller process tree stopped
before further token or repository work could be wasted.

- #190 promoted a broad frozen Build Packet first and entered its builder.
  #189 then attempted to promote an overlapping frozen packet. The parent
  claim arbiter correctly rejected #189 before its builder started, and the
  child printed that it was suspended and retained for explicit orchestration
  resume.
- The in-process `workOn` CLI wrapper swallowed
  `ClaimPromotionConflictError` after printing it and returned normally. Both
  orchestration resume adapters consequently ran generic durable-artifact
  reconciliation, saw the intentionally retained `building` checkpoint, and
  converted it to a failed scheduler result. The durable DAG recorded #189 as
  failed at `2026-08-16T03:53:06.427Z` with `resumed to building: durable
  recovery details are required`, then incorrectly admitted #194.
- Exact controller PID `14172` and its current descendants were terminated
  deepest-first after validating the controller creation time. Observer stop
  file `.forgedock/headless-resume-20260816-090213.ndjson.stop` was created.
  No controller, observer, or worker process remained afterward.
- At stop the DAG was still `running`: #189 failed, #190/#192/#193/#194
  running, and 29 nodes queued. #189's run and frozen packet remain a valid
  building checkpoint; no #189 builder work started after the rejected claim.
- Required repair: an orchestration-bound `workOn` must rethrow the typed
  conflict after normal resource cleanup, and both parent in-process resume
  call sites must translate it to `ScheduleWorkerResult.status = suspended`.
  Standalone `work-on` should retain its existing user-facing suspension and
  exit-code behavior.

#### F-017 repair live proof (2026-08-16 09:31 local)

- Added one typed CLI boundary policy: standalone `work-on` retains its
  existing suspension/exit behavior, nested `workOn` rethrows the conflict,
  and the orchestration parent converts only that typed error to a scheduler
  suspension. Both initial-admission resume and explicit DAG resume use the
  same policy and restore parent observation identity in `finally`.
- Build passes; 105 focused orchestration/admission/work-on tests pass; the
  full ForgeDock Next suite passes 644/644; `git diff --check` passes.
- Headless attempt 3 started from the same DAG at `2026-08-16 09:30:39`
  local: controller PID `11620`, observer PID `6180`, stdout
  `.forgedock/headless-resume-20260816-093039.log`, stderr
  `.forgedock/headless-resume-20260816-093039.stderr.log`, trace
  `.forgedock/headless-resume-20260816-093039.ndjson`.
- The live conflict canary now behaves correctly. #189 is durably
  `suspended` on attempt 3 with `Promoted scheduler claims for issue-189
  conflict with active work: issue-190`. #190/#192/#193/#194 are the only
  four running nodes and all 29 other nodes remain queued. #189 is no longer
  failed and no replacement node was admitted because of its suspension.

#### F-018: Canonical Windows verification commands false-block (2026-08-16 09:45 local)

Status: confirmed systemic end-to-end blocker; attempt 3 stopped immediately.

- #192 completed its two-file scoped implementation and its builder reported
  that `npm run build`, full `npm test`, and `git diff --check` passed. The
  controller nevertheless wrote a blocked Outcome with zero controller checks:
  `Frozen verification plan is not covered by controller-approved commands`.
- Packet canonicalization had correctly derived the command catalog's native
  Windows invocations, for example
  `C:\Program Files\nodejs\node.exe C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js run build`.
  Verification coverage recognizes an allowed command expressed as `npm run
  build`, and recognizes a configured command whose executable is Node plus
  npm-cli, but it cannot recognize the exact canonical Node/npm-cli invocation
  it generated in the packet. The generic exact-invocation comparison is
  missing.
- This is systemic: #193's frozen packet contains the same command form and
  would false-block after spending its remaining build/verification tokens.
  #192's false block already made the DAG non-closable, so continuing 31 more
  nodes would be wasteful.
- Created observer stop file
  `.forgedock/headless-resume-20260816-093039.ndjson.stop`. Validated controller
  PID `11620` by creation time and terminated eight currently live members of
  its traced process family, including the active full-test tree. Observer
  emitted `observer_stopped`; no controller or worker process remains.
- Required repair: coverage must first accept an exact normalized invocation
  of a current controller-approved command, including absolute executables and
  arguments containing Windows path separators/spaces, while preserving the
  existing fail-closed rejection of near matches, extra flags, and invented
  commands. Typed command IDs remain the packet authoring boundary.

#### F-018 repair checkpoint (2026-08-16 09:48 local)

- Verification coverage now accepts an exact packet invocation assembled from
  a current controller-approved command before applying npm/diff aliases or
  command-shaped prose rejection. This covers the canonical Windows
  Node/npm-cli command generated by packet preparation without broadening
  execution authority.
- Regression coverage proves the exact absolute invocation is covered and an
  otherwise identical invocation with `-- --watch` remains uncovered. Build,
  focused verification/work-on tests (45/45), full ForgeDock Next suite
  (644/644), and `git diff --check` pass.
- Attempt 3 stopped with durable counts: one suspended (#189), four running
  (#190/#193/#194/#195), one blocked (#192), 28 queued. #192 retains its
  builder submission and workspace, so ordinary DAG resume should select the
  verification checkpoint and rerun controller checks without replaying the
  builder.

#### F-018 repair live proof attempt 4 (2026-08-16 09:48 local)

- Resumed the same durable DAG headlessly with controller PID `32164` and
  observer PID `33836`. Logs are
  `.forgedock/headless-resume-20260816-094840.log`, `.stderr.log`, and
  `.ndjson`.
- Scheduler behavior is healthy at admission: effective parallelism remains
  four; #189 again suspended cleanly on its promoted-claim conflict with
  active #190, and #194 filled the released slot. No conflicting #189 builder
  was started.
- #192 entered its retained controller-verification recovery path. The live
  process trace shows the exact canonical Windows Node/npm-cli commands now
  executing (`run build`, followed by full `test`) in the retained #192
  baseline rather than being rejected by verification-plan coverage. This is
  live proof that F-018's original false preflight block is repaired; final
  publication/closure is still in progress.
- The headless harness is only a noninteractive transport plus external
  observer around the same native CLI resume command. It has not introduced a
  distinct orchestration failure. Keep attempt 4 running unless a new systemic
  or non-closable fault is confirmed.
- Recovery checkpoint semantics are now behaviorally differentiated as
  intended: #192's previously submitted builder did not replay, while #190 and
  #193 resumed incomplete build sessions. #192 is durably `verifying` and all
  controller leases continue to renew.
- Efficiency finding (noncritical): each concurrently resumed node creates and
  fully verifies a separate baseline, but the machine-wide verifier lock
  serializes their full `npm test` phases. Baseline runs for #190, #193, and
  #194 were admitted ahead of #192's post-build verification, substantially
  increasing recovery latency without violating safety or state correctness.
- #192 then executed its actual retained-workspace verification in
  `issue-192-c-4d66-b7bf-1acf9806d1e4`, produced BuildResult commit
  `66daf52b17b6711d7c0990dea4338a7442e82e75`, advanced durably from version 7
  `verifying` to version 9 `reviewing`, and launched the expected correctness,
  data, and concurrency review shards. This is conclusive live proof that the
  canonical Windows verification command repair crossed the old F-018
  blocker and preserved the retained builder submission.

#### First full node closure and cleanup audit (2026-08-16 10:04 local)

- #192 passed all three review shards, created PR #258 at exact head
  `66daf52b17b6711d7c0990dea4338a7442e82e75`, passed GitHub CI and DCO, and
  merged with optimistic head matching as merge commit
  `eaca149287b6166ce472bbc7438dd20543f3226e`.
- Issue #192 closed as completed; run
  `run_874371e3-7eac-4d66-b7bf-1acf9806d1e4` reached durable version 12
  `completed`; the DAG marked #192 completed and immediately launched #195
  into the released fourth slot. The delivery workspace and delivery branch
  were removed. This is the first observed native orchestration node to travel
  from a recovered checkpoint through verification, review, merge, issue
  closure, cleanup, and scheduler slot release.
- Noncritical cleanup defect: the verifier baseline worktree/branch is not
  removed when a node completes. Seven retry-created baseline worktrees remain,
  totaling about 1.73 GB (roughly 244-252 MB each), including #192's completed
  baseline. With 49.9 GB free the current issue set is not at immediate disk
  risk, but repeated resumes multiply the leak and normal completion must clean
  baseline worktrees as well as the delivery workspace.
- GitHub label cleanup is incomplete: closed #192 has `workflow:merged` but
  still carries `needs-validation`. This does not prevent DAG closure but is a
  durable workflow-projection hygiene defect.

#### F-019: Problem prose becomes production routing authority (2026-08-16 10:08 local)

Status: confirmed critical production-target safety failure; attempt 4 stopped
before #195 created a run, delivery workspace, branch, or PR.

- The durable DAG planned #195 with `targetBranch: main` and
  `productionTarget: main`, even though the issue contains no authorizing
  routing field. Its Problem/Evidence prose describes the vulnerability using
  the literal examples `Code branch: main` and `Target branch: main`.
- ForgeDock treated those quoted reproduction examples as explicit routing
  evidence. It then began #195's baseline from `origin/main` commit
  `e1313b26d1488b8174e1e1f4bba6ccdf31564ddd`. Had dispatch continued, the
  ordinary issue worker could have opened a direct production PR—the exact
  protected-route bypass that #195 reports.
- Created stop file
  `.forgedock/headless-resume-20260816-094840.ndjson.stop`, validated controller
  PID `32164` against its 09:48:40 creation time, and terminated its ten-member
  current process family deepest-first. Observer PID `33836` emitted
  `observer_stopped`; no controller or worker remains.
- Durable stop state: #192 completed end to end; #189 suspended; #190/#193/#194
  running checkpoints; #195 launching with no child run; 28 nodes queued.
- Required repair has two boundaries: branch evidence extraction must only
  recognize structurally authoritative issue fields rather than occurrences in
  narrative/problem prose, and resume must revalidate/rematerialize unsafe
  frozen target branches so the existing #195 `main` projection cannot be
  dispatched after the parser is corrected.
- Baseline cleanup refinement: successful/currently unwinding baselines are
  removed by `finally`; the remaining 1.73 GB are interrupted-attempt orphans.
  Recovery/cleanup must reclaim those, but normal successful baseline cleanup
  itself is working.

#### F-019 repair checkpoint (2026-08-16 10:34 local)

- Branch metadata extraction is now line-anchored. Standalone documented
  `Code branch`, `Worktree base`, and `Target branch` fields remain valid, as
  do standalone prescriptive PR-target sentences, while #195's inline
  Problem/Evidence examples no longer become route authority.
- Lane classification now rejects every explicit source/target form equal to
  the configured protected production target before returning a fast lane.
- The orchestration controller independently rejects any newly materialized
  node that directly targets production. On resume it asks the caller to
  re-read authoritative issue/config/branch state before dispatch. A stale
  route may be repaired only when wrapper attempts produced no semantic child
  run and no active transport identity; route drift after a durable child run
  fails closed.
- Both the headless CLI and TUI durable-DAG rebuild path provide that
  authoritative route revalidation. Focused regressions cover #195's exact
  inline evidence shape, all three explicit production fields, new-DAG
  production rejection, safe pre-child route repair, and fail-closed drift
  after run identity. Build and focused suites pass (39/39).
- No orchestration process has been restarted yet. The next resume must prove
  that #195 is durably changed from `main` to `staging` before its baseline or
  worker starts; kill immediately if any #195 process still uses `origin/main`.

#### F-019 live proof attempt 5 (2026-08-16 10:18 local)

- Resumed the same DAG with controller PID `4760`; observer PID `33944`;
  stdout/stderr/trace use the prefix
  `.forgedock/headless-resume-20260816-101801`.
- Before scheduler dispatch, authoritative route revalidation changed #195
  durably from `fast:main` to `fast:staging`, cleared its stale active wrapper
  pointer through ordinary recovery, and retained zero child runs. At the
  proof read it remained queued while the controller was still revalidating
  later nodes. This satisfies the F-019 no-production-dispatch invariant.

#### F-020: concurrent Git metadata writes fail healthy workers (2026-08-16 10:19 local)

Status: confirmed closure-blocking concurrency failure; attempt 5 stopped.

- Once scheduling began, #190 and #193 both failed with `git fetch failed in
  staging ... fetching ref refs/remotes/origin/staging failed: incorrect old
  value provided`. The process trace shows four concurrent workers issuing
  the same force-fetch refspec into the shared `origin/staging` tracking ref.
- A successful peer had advanced that ref from `5340794c` to #192's merged
  staging head `eaca1492`; competing Git ref transactions retained the old
  compare-and-swap value and failed. The scheduler then admitted #195/#197/
  #201 even though two nodes were already irrecoverably failed, so continued
  execution could not close the DAG.
- Created the attempt-5 stop file, validated PID `4760` at its 10:18:01
  creation time, and terminated its six-member process family deepest-first.
  The observer stopped and no family member remains. #195's live baseline was
  created at exact staging commit `eaca149287b6166ce472bbc7438dd20543f3226e`,
  confirming F-019 remained repaired.
- Repair replaces shared tracking-ref and `FETCH_HEAD` mutation with exact
  advertised-ref resolution plus `git fetch --no-write-fetch-head --refmap=`;
  fetched commit existence is verified before use. Git common-metadata
  mutations (`worktree add/prune/remove`, branch/config updates) now use both
  an in-process queue and a cross-process, PID-witnessed filesystem lease.
- The focused integration suite passes 5/5, including four concurrent manager
  calls and four independent Node subprocesses. All eight resolve the fresh
  remote SHA while the deliberately stale local tracking ref remains
  unchanged.

#### F-020 live proof attempt 6 (2026-08-16 10:25 local)

- Resumed the same DAG with controller PID `7432`, observer PID `2024`, and
  log prefix `.forgedock/headless-resume-20260816-102539`.
- All authoritative base fetches now use concurrent `ls-remote` plus
  `fetch --no-tags --no-write-fetch-head --refmap=`. The trace contains no
  tracking-ref destination and no `FETCH_HEAD` read. Cross-worker worktree
  creation is serialized: #193, #190, then #195 entered `worktree add` rather
  than overlapping in the common Git directory.
- #190 and #193 both crossed the exact point that failed in attempt 5 and
  remain running against staging. No `incorrect old value` error recurred.
  #195's attempt-6 baseline again uses staging commit `eaca1492`.

#### Attempt 6 safe-conflict behavior (2026-08-16 10:44 local)

- #194 completed its investigation and Build Packet without opening a
  delivery workspace or editing. Its promoted write claims then conflicted
  with active #193, so the controller durably suspended #194 and immediately
  admitted #197 into the freed slot. This is the intended late-claim barrier:
  no overlapping writer was dispatched and the DAG remains closable.
- Current durable count at this checkpoint: one completed (#192), four
  running (#190, #193, #195, #197), two suspended (#189 behind #190 and #194
  behind #193), and 27 queued. There are zero failed, blocked, or invalid
  nodes.
- #190 and #193 are in live build sessions with current controller
  heartbeats. #193 has made a scoped test edit and is iterating verification;
  #195 is producing its Build Packet; #197 is investigating the SQLite lease
  bootstrap epoch mismatch. Initial invalid `path="."`/missing-directory tool
  calls remain a prompt-efficiency defect, but all affected agents recovered
  and continued semantic work.

#### F-021: transient claim suspensions strand the live DAG (2026-08-16 11:12 local)

Status: repaired and validated; attempt 6 was stopped before further spend.

- #193 completed end to end in attempt 6: PR #259 merged to `staging`, its
  Outcome is complete, the DAG projected it completed, and issue #193 closed.
  Once #193 released its claims, #194 remained suspended and the scheduler
  admitted #201 instead. The same stranded state already existed for #189
  behind #190.
- This confirmed that a late Build Packet conflict was safe but not live:
  `runSchedule` treated every `suspended` result as terminal for the current
  invocation. Only a later top-level `resume()` could turn the node back into
  queued work, guaranteeing a failed final orchestration whenever a transient
  claim conflict occurred.
- Created stop file
  `.forgedock/headless-resume-20260816-102539.ndjson.stop`, validated controller
  PID `7432` against its 10:25:39 creation time, and terminated the ten-member
  process family deepest-first. No family member remained.
- Durable stop state: #192 and #193 completed; #189 and #194 suspended;
  #190/#195/#197/#201 retained recoverable running checkpoints; all remaining
  nodes queued. There were no ordinary failed, blocked, or invalid nodes.
- The scheduler now retains and persists the losing worker's discovered Build
  Packet claims, emits its durable suspended checkpoint, requeues only a typed
  `ClaimPromotionConflictError`, waits on the actual active claim, and creates
  a fresh `resume` attempt after the owner exits. Lease-continuity, recursive
  remediation, awaiting-human, and other suspensions remain fail-closed.
- Typed conflict identity is preserved at both native boundaries: the headless
  CLI returns the error object to the scheduler, and the interactive TUI
  retains the parent arbiter's typed error across the controller subprocess
  transport instead of replacing it with a generic blocked-task message.
- Regression coverage proves scheduler suspended-to-resumed dispatch,
  persisted claims, durable attempt history `initial -> resume`, single-call
  controller completion, and native TUI child-task recovery. The full Next
  suite passes: 651/651 tests.

#### F-022: superseded failure Outcome is resurrected on parent resume (2026-08-16 11:28 local)

Status: repaired and validated; attempt 7 stopped before dispatch.

- Attempt 7 resumed the same DAG with controller PID `33428`, observer PID
  `7448`, and log prefix `.forgedock/headless-resume-20260816-110627`.
  During silent authoritative reconciliation, before scheduler dispatch, #190
  changed from recoverable running work to terminal `blocked`; 31 nodes were
  still queued. The exact 11-process family was killed immediately and the
  observer stopped; zero family processes remained.
- The blocking Outcome for #190 was created at `05:11:45Z` after an initial
  builder-report mismatch. It was later superseded by a verified BuildResult
  at `05:24:18Z`; SQLite has the run at version 12, state `reviewing`, updated
  `05:24:26Z`, with active review-cycle progress through `05:27:05Z`.
  Therefore the run was not authoritatively terminal.
- Both CLI and TUI parent reconciliation first computed the correct latest-run
  state, then independently scanned the raw artifact list for any historical
  blocked/failed Outcome. That second scan resurrected the superseded Outcome
  and durably projected the DAG node blocked.
- A shared terminal classifier now trusts latest-run reconciliation first. It
  returns a terminal scheduler result only when that reconciled state itself is
  `blocked` or `failed`, and uses an Outcome reason only when the Outcome has
  the same status and belongs to that exact latest run. Historical outcomes
  superseded by a later BuildResult, and outcomes from older semantic runs, are
  ignored.
- Focused state/controller/TUI coverage passes 87/87. The complete Next suite
  passes 654/654; one intervening run exposed an unrelated asynchronous TUI
  test-harness notification race, while the TUI file passed in isolation and
  the immediate full rerun was clean.

#### Attempt 8 claim-retry proof and F-023 projection refinement (2026-08-16 11:43 local)

- Attempt 8 uses controller PID `25376`, observer PID `26184`, and log prefix
  `.forgedock/headless-resume-20260816-111210`. F-022 is live-proven: #190 was
  cleared from the false blocked projection, requeued, and resumed from its
  durable publication/review checkpoint. Four workers are active (#190, #194,
  #195, #197), with #192/#193 complete and no failed/blocked/invalid nodes.
- #189 again discovered a live Build Packet conflict with #190. In the same
  top-level invocation the scheduler emitted `suspended`, then `resumed`, kept
  #189 claim-blocked behind #190, and admitted #197 into the released slot.
  This is the first live proof of the F-021 automatic retry path.
- The durable controller still displayed #189 as suspended while the scheduler
  had it queued because its stale-event guard treated every completed suspended
  attempt as terminal. This did not dispatch duplicate work, but made the live
  checkpoint untruthful and would show an active recovery retry as suspended.
- The guard now permits only an explicit `resumed` event for the same suspended
  node when its typed wait reason is `active-claim-conflict`; synthetic resume
  events for skipped/invalid/other terminal nodes remain protected. A regression
  waits for post-persistence event delivery and asserts the node is durably
  queued with that claim wait reason before its owner releases. Focused tests
  pass 41/41 and the complete Next suite passes 654/654.
- Attempt 8 loaded the pre-refinement build, so its in-memory retry is valid but
  its interim SQLite projection remains suspended. A future restart will load
  the durable projection refinement; no restart is needed solely for current
  semantic progress.

#### Attempt 8 third end-to-end closure (2026-08-16 11:34 local)

- #195 completed its resumed build, verification, publication, two-shard
  review, merge, and close sequence without operator input. PR #265 merged to
  `staging` at `42c9bfdba9b01f2c61430b694c89bc15cb13bd06`; GitHub closed #195
  at `06:03:58Z`, and the scheduler durably projected `issue-195` completed.
- Capacity was reused immediately: the scheduler admitted #199 in the same
  invocation after #195 completed. #190 also completed remediation cycle 1 and
  began its three-shard review cycle 2 against BuildResult
  `fdd566d41ce531295c02e95775e13efb1d79ab84`.
- Live DAG state after the transition: three completed nodes (#192, #193,
  #195), four active workers (#190, #194, #197, #199), one expected pre-F-023
  suspended projection (#189, queued in scheduler memory behind #190), and no
  failed, blocked, or invalid nodes.

#### Attempt 8 fourth end-to-end closure and continued claim wait (2026-08-16 11:40 local)

- #190 completed its remediation, verification, second three-shard review,
  merge, and close sequence. PR #260 merged to `staging` at
  `a8ab1d16c3b889ea47267d4dc59412e9ce1bc145`; GitHub closed #190 at
  `06:09:46Z`, and the scheduler durably projected `issue-190` completed.
- #189 did not immediately dispatch after #190 released its claims because its
  promoted claim set also overlaps the still-active #197 work in
  `src/adapters/sqlite/sqlite-repositories.ts` and its tests. The scheduler
  validly admitted non-conflicting #201 into the free slot. This is continued
  claim arbitration, not evidence that the retry was lost.
- #199's several-minute `launching` interval was traced to a real isolated
  checkout `npm ci --ignore-scripts` subprocess. It subsequently created
  `run_e276abaa-c56f-49a0-9fef-445ada3b65a5` and entered investigation. Setup
  is currently operational but insufficiently surfaced in typed progress.

#### F-024: fresh workers launched by `orchestrate --resume` hide their run identity (2026-08-16 11:46 local)

Status: repaired; compile validation passed, live proof requires a restarted controller.

- Runtime evidence: #199 had an active semantic run
  `run_e276abaa-c56f-49a0-9fef-445ada3b65a5`, emitted investigation and
  Build-Packet progress, and renewed its work-on lease, while the parent DAG
  still persisted its attempt as `launching` with `childRunIds: []`. #201 also
  spent several minutes running baseline verification with the same empty
  parent identity.
- The CLI resume worker called nested `workOn(...)` and only invoked
  `context.recordTask({ runId })` after the entire workflow returned. The
  nested command already knew the selected fresh/resumed run ID before
  preflight, baseline checks, and semantic work, but had no callback to report
  it to the parent.
- `workOn` now accepts an optional `recordRun` boundary callback and reports
  the authoritative `progressRunId` immediately after admission selects it.
  Both fresh and resume orchestration call sites wire that callback to the
  controller's durable `recordTask`. This moves the attempt to `running` and
  records its child run while work is actually active, improving truthful
  status and crash recovery. `npm run build` passes; the complete suite remains
  to be run without contending with the live workers' full baseline suites.

#### Efficiency checkpoint (2026-08-16 11:52 local)

- The four completed nodes (#190, #192, #193, #195) consumed 31 recorded model
  sessions and 162.9 summed agent-active minutes: 2,967,727 fresh input tokens,
  397,072 output tokens, 26,369,536 cache-read tokens, 29,734,335 provider-total
  tokens, and about $1.60 estimated model cost.
- #195 is the clean proportionality example: a two-file change (79 additions,
  5 deletions) consumed six sessions, 35.3 agent-active minutes, 558,967 fresh
  input, 77,716 output, 4,612,096 cache reads, and about $0.30, with roughly 67
  minutes of wall time from run creation to closure.
- Across the DAG-linked receipts so far, phase cost/active time is led by
  investigation ($0.570 / 34.1 min), Build Packet ($0.474 / 51.1 min), review
  ($0.406 / 46.3 min), build ($0.335 / 55.7 min), and remediation ($0.201 /
  12.0 min). Repeated broad reads dominate input/cache use; multiple reviewers
  reread common code, and invalid path/offset calls add recoverable churn.
- Baseline verification is also disproportionate and opaque. #201 remained in
  parent `launching` for about thirteen minutes while a baseline `npm test`
  traversed Next and legacy suites (including nested installer/router tests)
  before its semantic run `run_206f9af4-d3cc-423b-9f88-ae9aceac9022` became
  visible. Recommended follow-up: base-SHA/policy baseline caching, compact
  evidence handoff between phases, risk-selected reviewers, focused per-issue
  verification, and one complete staging merge gate.

#### Attempt 8 efficiency/status checkpoint (2026-08-16 12:05 local)

- The controller and observer remain live. The durable DAG has four completed,
  four running, two suspended, and twenty-four queued nodes, with zero failed,
  blocked, or invalid nodes.
- #197 advanced to review cycle 1. #199 completed its Build Packet but its
  promoted claims conflict with the still-active #197, so the scheduler
  suspended it and admitted #202 into the released slot. This is effective
  conflict avoidance and capacity reuse, not a critical orchestration failure.
- #201 and #202 still project as `launching` with no child run identity because
  this controller predates F-024. The source repair is compiled but requires a
  future controller restart for live proof.
- Current judgment: safety/correctness is materially improving, but delivery
  efficiency remains poor. Four closures required 31 model sessions, 162.9
  summed active minutes, and 29.7M provider-total tokens. Most avoidable spend
  is duplicated repository comprehension and repeated broad verification,
  while claim arbitration itself is behaving proportionally and should remain.

#### Review quality checkpoint (2026-08-16 12:39 local)

- Read the native reviewer task construction and the consolidation/materialization
  path after inspecting the durable artifacts, preserving the behavior-first
  evidence boundary. The reviewer task is independently dispatched and receives
  the frozen Intent, Investigation, Build Packet, BuildResult, exact diff shard,
  acceptance criteria, evidence-anchor requirements, causal-root requirement,
  scope disposition, and bounded read/search budget. This is a substantive review
  contract, not an inline approval shortcut.
- Final durable verdicts for the four merged closures were: #258/#192 = zero
  findings; #259/#193 = two high-confidence medium findings; #260/#190 = zero
  findings after an earlier request-changes/remediation cycle; #265/#195 = one
  high-confidence medium finding. The three final findings are concrete
  correctness/durability/route-safety concerns, not formatting, naming, lint, or
  other mechanical suggestions. The review sample therefore supports the
  reviewers' qualitative value, while remaining too small to estimate a general
  false-positive rate.
- Root-cause trace: #193's missing base-race fixture and typed merge-race
  persistence are implementation/verification-boundary gaps despite being named
  by the Build Packet; #195's pre-classification branch provisioning is a
  packet-scope/integration-boundary gap where the local classifier fix did not
  cover side-effecting callers. None is a reviewer-quality failure.
- Important qualification: the earlier #190 review wave also materialized the
  low-severity, test-only finding “Fresh successful claim promotion has no
  ordering regression assertion” as GitHub issue #264 with `priority:P3`. The
  final zero-finding verdict superseded and closed #264, but the issue was still
  created and briefly entered the issue universe. It is not a purely mechanical
  defect, yet its demonstrated runtime impact is low enough that it should be an
  advisory candidate under an impact gate. This is the first direct behavior
  evidence of the issue-inflation concern, rather than only a source-level risk.
- Confirmed systemic inflation risk: native review defaults to
  `findingIssuePolicy="all"`, and `shouldMaterializeFinding` rejects only
  `scopeDisposition="rejected"`; `follow_up`, low-severity, and non-blocking
  findings therefore project as GitHub issues. The legacy review contract also
  files every confidence level and falls back to unstructured Finding/Issue/Bug/
  Warning text. This is the exact behavior to change; it is distinct from the
  current sample's actual finding quality.
- Durable plan updated at
  `.forgedock/orchestrate-hyperperformance-plan.md`: added review evidence,
  implementation-to-finding trace, HP-14 impact-gated two-track output, and
  HP-15 phase-attribution feedback. Proposed rollout is shadow classification,
  then controller-owned issue projection gating, while retaining the full
  independent reviewer panel. No live controller, DAG, GitHub, or source-code
  behavior was changed in this checkpoint.

#### Implementation-readiness checkpoint (2026-08-16 12:47 local)

- The qualitative direction is ready, but unconditional implementation is not
  yet authorized by evidence. Remaining work is bounded behavioral validation:
  shadow-capture complete reviewer proposals and projection/supersession for
  3–5 more PRs; trace native/legacy policy and reconciliation compatibility;
  calibrate the impact rubric on real defects, test-only gaps, performance,
  security, and style observations; add a feature flag/rollback and malformed
  output gate; then run a canary comparing substantive detection, false
  positives, issue count, remediation, tokens, and closure success.
- No further broad repository archaeology is needed. These gates prevent two
  opposite failures: suppressing a legitimate low-severity defect, or allowing a
  low-value test/style suggestion to become another orchestrated work item.

#### Mission clarification (2026-08-16)

- “Dogfooding” means improving and proving the actual native `staging`
  `/orchestrate` pipeline observed in this ledger. A separate prototype or
  synthetic benchmark is not an acceptable substitute.
- An isolated development checkout may be used only to avoid mutating the live
  controller's files while it is running. The acceptance canary must return to
  this repository's staging controller and exercise its real scheduler,
  work-on children, GitHub projections, review, merge, and closure paths.
- The non-regression bar therefore applies to the same end-to-end behavior being
  audited: safety invariants, truthful durable state, reviewer-panel integrity,
  substantive finding detection, issue projection, remediation, merge, and
  authoritative closure.

#### Resumable shutdown checkpoint (2026-08-16 12:56 local)

- Per the operator request, the exact controller family for DAG
  `dag_0a31acc5-3ca0-49d3-a4ec-28d7c1faf4b9` was paused. Before termination,
  PID `25376` was verified as the native command
  `bin/forgedock-next.mjs orchestrate --resume
  dag_0a31acc5-3ca0-49d3-a4ec-28d7c1faf4b9`, created at 11:12:10. The observer
  PID `26184` and the controller's descendants were enumerated by parent PID
  and creation time; no unrelated process was targeted.
- The observer stop sentinel was written to
  `.forgedock/headless-resume-20260816-111210.ndjson.stop`. The validated
  controller family and observer are now absent; no matching ForgeDock,
  worker-worktree, `gh`, or test process remains.
- SQLite/GitHub state was not deleted or rewritten. The durable orchestration
  row remains `running` with its node attempts/checkpoints (the pre-stop row
  had four completed, four running, two suspended, and twenty-four queued),
  so the next command must use the same DAG id with `--resume`. This is an
  intentional interruption checkpoint, not a cancellation or failure.
- The stop operation exposed no native controller stop-file protocol; the
  observer sentinel controls observation only. Exact process-family shutdown
  is therefore the safe pause mechanism until a controller-owned graceful
  pause command is added and behaviorally proven.

#### Native impact-gate implementation checkpoint (2026-08-16 13:08 local)

- The first reversible optimization slice is implemented in the same native
  `src/` review path used by `/orchestrate`: `FindingImpactSchema`, reviewer
  prompt requirements for category/trigger/invariant/consequence, controller-
  owned impact gating, and durable `ReviewVerdict.findingProjection` evidence.
- Policies are `all` (legacy), `shadow-impact-gated` (legacy projection plus
  deterministic suppression telemetry), and `impact-gated` (only high-
  confidence, in-scope, causal-rooted, anchored concrete impact becomes a
  GitHub issue). Missing/malformed impact is retained in the verdict but fails
  closed for the enforced lane. Low test/performance/compatibility/operability
  gaps remain advisory; low correctness/security/data-integrity/availability
  defects can still project when concretely evidenced.
- The opt-in switch is `FORGEDOCK_REVIEW_FINDING_POLICY`; explicit `none`
  remains authoritative. No reviewer role, blocking threshold, merge gate,
  remediation state machine, or closure authority changed. Legacy command
  files remain untouched.
- Verification: `npm run build` passed; focused review/scope/consolidation/codec
  tests passed; full native Next suite passed `657/657`. These are local
  deterministic checks, not a substitute for the live staging canary.
- Next live action: resume this exact DAG with
  `FORGEDOCK_REVIEW_FINDING_POLICY=shadow-impact-gated`, observe controller
  reconciliation and real reviewer projections, and do not enforce the gate
  until a real high-confidence defect and a low/advisory candidate are seen in
  durable artifacts. A new safety failure still warrants exact-family shutdown.

#### Same-DAG resume and safety stop (2026-08-16 13:10 local)

- The exact DAG was resumed as execution attempt 9 with the newly built native
  `dist/` and `FORGEDOCK_REVIEW_FINDING_POLICY=shadow-impact-gated`. The
  controller reconciled prior interrupted attempts and dispatched live child
  runs for #189, #194, #202, and #207; this proves the durable resume path can
  continue work after an exact process-family interruption rather than creating
  a replacement DAG.
- Recovery immediately exposed a non-closable blocker: #197 changed to
  `blocked` with
  `Verification repair attempt 1 dispatched: Builder change report does not
  match the controller-observed delivery revision: reported unchanged
  src/adapters/sqlite/sqlite-repositories.ts`. The durable `Outcome` failure
  evidence says the repair submission reported four changed paths while the
  controller-observed delivery revision contained five, including that file.
  This is a truthful fail-closed verification result, not a review-policy
  suppression or a process crash.
- To honor the token-safety rule, the exact resumed controller PID `16456`
  (created 13:08:35) and observer PID `35176` were stopped at 13:10 after
  validating the command line and enumerating descendants by parent PID and
  creation time. No unrelated process was targeted; the observer log ends with
  `observer_stopped`, and no matching controller/worker/test process remains.
- Post-stop durable projection is `4 completed, 4 running, 1 blocked, 25
  queued`; the blocked #197 and running attempts are preserved for explicit
  diagnosis/resume. Do not resume this DAG again until the #197 recovery
  contract is understood; otherwise repeated verification repair dispatches
  would spend tokens without increasing closure probability.
- Behavior evidence for #197: its authoritative run transitions include
  `VERIFICATION_FAILED` with the exact changed-path mismatch, then
  `VERIFICATION_REPAIR_REQUESTED`, followed by later successful BuildResult and
  ReviewVerdict artifacts from prior work. On resume the local/run projection
  diverged from GitHub authority and re-entered verification, so the controller
  re-applied the fail-closed mismatch guard instead of trusting stale builder
  prose. This is the next recovery/terminal-state audit target.

#### Recovery reconciliation correction (2026-08-16 13:24 local)

- The #197 blocker was reproduced from the authoritative GitHub artifact set,
  without restarting the DAG. The sequence is: blocked verification Outcome,
  first BuildResult, request-changes ReviewVerdict, then a newer verified
  BuildResult. `decideSubjectAdmission()` correctly classified that sequence as
  `resume / publishing`, but `reconcileArtifacts()` ranked the older verdict
  above the newer build and returned `blocked`; `terminalOrchestrationResult()`
  then converted that recoverable state into a terminal scheduler result.
- This is a controller reconciliation defect, not a bad builder submission or
  review-policy effect. It explains why the resumed node became blocked even
  though the durable latest BuildResult was present and the normal work-on
  admission path could continue publication/review.
- The native fix in `src/core/state/reconcile.ts` treats a BuildResult published
  after a ReviewVerdict as a new review head and exposes `publishing`, matching
  admission ordering. A regression fixture mirrors #197's stale verdict plus
  newer build and asserts no terminal classification. No GitHub/state mutation
  was performed.
- Verification after the fix: `npm run build`, focused reconciliation/terminal
  tests (`12/12`), and full native Next suite (`658/658`) passed. A live read-only
  replay of issue #197 now reports `state=publishing`, no warnings, and no
  terminal scheduler result.
- The DAG remains stopped and resumable. The next canary may resume the same DAG
  once the operator elects to spend tokens; this correction removes the known
  false terminalization path, but the run still needs live proof through
  publication, review, remediation/merge, and closure. Keep the exact-family
  shutdown rule active for any new non-closable safety fault.

#### Same-DAG canary: authoritative invalid closure and controlled stop (2026-08-16 13:38 local)

- The corrected native build was resumed again as the exact same DAG with
  `FORGEDOCK_REVIEW_FINDING_POLICY=shadow-impact-gated`. At the canary start the
  durable projection was `4 completed, 4 running, 26 queued`; #197 was queued,
  not falsely blocked, which is live confirmation of the reconciliation fix.
- Issue #207 then produced an `Investigation` with `outcome=invalid`, followed by
  two durable `Outcome` artifacts with `status=invalid`. The later outcome has
  `issueClosure.status=completed`, and GitHub issue #207 is authoritatively
  `CLOSED` with `workflow:invalid`. A read-only artifact replay returns
  `state=invalid` with no warnings. This is a legitimate terminal issue result,
  not a repository defect or a missing worker delivery.
- The scheduler treated #207 as terminal and admitted #208, as its claim-
  serialization and dependency rules permit. The current orchestration
  finalizer nevertheless counts `invalid` nodes in the batch-level `failed`
  predicate. That reporting choice is now an explicit metric/design question:
  invalid/decomposed issues may be terminally closed while the batch remains
  non-successful. Do not change it without deciding whether batch success means
  “every issue had code delivered” or “every issue reached an authoritative
  terminal closure.”
- Per the operator's token-safety rule, the exact controller PID `30912`
  (created 13:21:34) and observer PID `37464` were validated and stopped after
  the `invalid` event. Descendant tests, workers, and `gh` processes were
  terminated only within that creation-time-validated family; no durable state
  or GitHub artifact was deleted. The stop left #208's live attempt resumable.
- Post-stop state is `4 completed, #207 invalid, #189/#194/#202 running, #208
  running, and 25 queued`; no controller or matching observer remains. The next
  resume must reconcile #208's orphaned attempt, must not replay #207 after
  completed invalid closure, and should continue to the review/merge/closure
  proof for a substantive issue.

#### Same-DAG canary: decomposition expansion gap and resumable stop (2026-08-16 14:06 local)

- The resumed DAG continued to produce real phase work. GitHub `updatedAt` was
  stale for active issues #189 (`03:53Z`), #194 (`06:54Z`), and #202
  (`06:48Z`), while the local SQLite progress/observer receipts were fresh:
  #194 entered a new remediation checkpoint and a full validation command,
  #189 resumed build reads, and #202 had a live verification subprocess. This
  confirms that comment timestamps are not a valid liveness signal.
- #208's investigation was substantive and high confidence: it confirmed a
  review-worktree code-execution and credential-boundary defect. The durable
  `Outcome` created two GitHub children, #278 (remove PR-controlled patch
  execution) and #279 (close the credential/file-locator environment boundary),
  with `status=decomposed` and closure evidence. The parent node became
  `skipped` with `#208 decomposed into replacement scope`, but neither #278 nor
  #279 was added to this persisted DAG. The scheduler instead admitted unrelated
  #209. `commands/orchestrate/phase-1-resolve.md` explicitly requires a
  decomposed parent to expand to open sub-issues, so this is an end-to-end
  closure defect, not a cosmetic status choice: the current invocation can
  finish without ever executing the replacement security work it just created.
- To cap token spend while preserving evidence, the exact controller PID
  `29968` (created 13:51:17) and its matching observer were validated against
  the same DAG/log path and stopped at 14:06. Descendants (including active
  validation/test processes) were terminated only within that creation-time
  validated process family. No unrelated terminal process, durable state,
  worktree, GitHub issue, or artifact was deleted. The sentinel
  `.forgedock/headless-resume-20260816-1352.ndjson.stop` remains as the
  resumable-stop marker.
- Post-stop durable projection is `4 completed, #207 invalid, #208 skipped
  (decomposed), #189/#194/#202/#209 running, and 24 queued` (the exact count is
  read from SQLite on resume; #278/#279 are not members of this DAG). The next
  implementation slice must make child expansion durable and bounded, then
  resume this same DAG and prove that #278/#279 (or their authoritative
  replacement records) are admitted rather than silently left outside closure.

#### HP-16 implementation and pre-resume verification (2026-08-16 14:32 local)

- The provider-neutral scheduler now carries `childIssues` from a skipped worker
  outcome into a typed `decompositions` result and a durable
  `decomposition-replan` wait reason. Duplicate, malformed, self-referential,
  over-limit, and over-depth references fail closed.
- The durable controller now materializes replacement nodes in the same DAG,
  records `decompositionChildren`/lineage depth, appends the complete issue
  scope, rewrites semantic and claim-only edges, reopens blocked descendants,
  and runs a follow-up scheduler pass. A legacy skipped parent can be resumed
  by an adapter resolver that discovers the authoritative Outcome; the parent
  is never replayed.
- Native CLI and TUI adapters now parse child references from the authoritative
  decomposed Outcome, re-read each child issue/lane/affected-file claim, and
  supply bounded replacement nodes to the controller. The TUI keeps the new
  nodes visible to subsequent worker dispatch and permits legacy recovery only
  when a resolver is present.
- Verification before resuming the live DAG: `npm run build`; focused
  controller/scheduler tests `43/43`; TUI extension tests `56/56`; full native
  Next suite `664/664`. No GitHub issue, artifact, worktree, or orchestration
  record was deleted or rewritten by this implementation step.
- The saved DAG remains stopped. The next live proof must resume the exact DAG,
  verify that #278 and #279 are persisted before unrelated capacity is admitted,
  and stop the exact family again if either child produces a new non-closable
  safety fault.

#### HP-16 live resume performance stop (2026-08-16 14:39 local)

- The same DAG was resumed with execution attempt 13 at 14:31 local. The
  decomposition repair worked: the durable record contained #208 as
  `skipped`/`decomposition-replan`, persisted `decompositionChildren=[278,279]`,
  and added both children to the same issue scope. #278 was queued behind
  capacity and #279 was queued behind #278's claim-serialization edge. This is
  positive same-DAG expansion evidence, but not closure evidence.
- Wall-clock performance was not acceptable. At 14:38 local the orchestration
  projection was still `running=4, completed=4, queued=26, invalid=1,
  skipped=1`, with `updated_at=09:02:08Z` (14:32 local). No issue had closed
  during this resume window and neither replacement child had dispatched.
  Local run-progress was still emitting tool/test heartbeats for #189, #194,
  #202, and #209, so process liveness existed, but that activity did not
  produce issue-level forward progress. #194 was still in remediation cycle
  1/4 with three cycles remaining, carrying a BuildResult from 12:24 local and
  a ReviewVerdict from 12:34 local. This is a concrete token/wall-clock stall,
  not evidence that GitHub `updatedAt` alone is stale.
- The exact root PID `29368` (created 14:31:03) and its live descendants were
  stopped at 14:39 after writing
  `.forgedock/headless-resume-20260816-143103.ndjson.stop`. The matching
  observer had already exited on that sentinel. Descendant processes were
  selected by parent-PID tree rooted at 29368; no unrelated process, GitHub
  artifact, issue, branch, worktree, or SQLite record was deleted. The durable
  orchestration record remains `running`/resumable and must be reconciled by
  the next resume rather than treated as completed.
- Operational conclusion: the new decomposition path passes persistence and
  admission shape, but the existing worker/remediation policy can consume
  tens of minutes or hours without a node transition. Do not claim the 5–8
  minute target or end-to-end closure until bounded per-phase leases, progress
  budgets, and a controller-visible “no issue-level progress” watchdog are
  implemented and proven on a smaller canary.

#### HP-17 heartbeat truthfulness repair (2026-08-16 14:46 local)

- Source-to-behavior comparison found two concrete liveness defects in the
  native CLI adapter. The fresh worker path invoked
  `controllerContext.heartbeat()` as detached `void` work, so a rejected
  durable save could neither abort the worker nor surface to the scheduler.
  The resume worker path had no orchestration heartbeat or parent abort signal
  at all; it could run `work-on` while its DAG node remained stale.
- The adapter now handles heartbeat rejection by aborting the worker, adds an
  orchestration-scoped worker lease/20-second heartbeat around resumed
  `work-on`, and forwards the parent AbortSignal into nested work-on/runtime
  phases. The nested signal is removed in `finally`; the worker lease is
  released without deleting recovery evidence.
- The TUI `VisibleDagDelegator` now applies the same durable heartbeat while
  waiting on native controller tasks or async Pi workers. A rejected heartbeat
  stops the matching child transport and returns a resumable `suspended`
  result; it never silently treats a dead durable write as successful work.
- Verification: `npm run build` passed; the focused TUI extension suite passed
  `56/56`; and the final full native Next suite passed `664/664` after both
  adapter changes. The saved live DAG was not restarted during verification.
- This fixes false liveness and provides the cancellation channel needed for a
  later bounded-progress watchdog. It does not yet impose a time budget, so
  the 5–8 minute target remains unproven.
#### HP-18 semantic-progress watchdog (implementation complete; live proof pending)

- Added `src/workflows/orchestrate/progress-watchdog.ts`. It polls the durable
  `RunRepository` and treats a change in `RunState.version`, state, or
  `updatedAt` as semantic progress. Heartbeats, tool receipts, and subprocess
  activity do not reset the timer. Three consecutive repository-read failures
  also fail closed.
- Fresh CLI workers now attach the watchdog to the Intent run before build
  execution. Resumed CLI workers attach it to the recovered run, and newly
  created nested runs bind through the existing `recordRun` callback. A stall
  records an `orchestration.watchdog` progress receipt, aborts the exact
  worker signal, preserves the worktree/checkpoint, and returns a resumable
  `suspended` result; it does not manufacture a normal issue failure.
- The stall budget is frozen in new orchestration plan metadata as
  `maxWorkerStallMs`; old DAGs default to 12 minutes unless resume supplies a
  bounded `--max-worker-stall-ms` (also accepted through
  `FORGEDOCK_ORCHESTRATE_MAX_WORKER_STALL_MS`). The CLI caps overrides at 24
  hours and rejects values below one second.
- Verification: `npm run build`; focused watchdog tests `3/3`; final native
  Next suite `667/667` (207 suites). No live controller was started during
  this verification step. The saved DAG remains resumable and still needs a
  bounded ten-closure run to establish behavior-level throughput.

#### HP-18 live watchdog canary (2026-08-16 15:04–15:32 local)

- The corrected native CLI resumed the exact DAG as execution attempt 14 with
  `--max-worker-stall-ms 480000` (8 minutes). Four workers were admitted and
  the observer captured their full subprocess family. GitHub issue timestamps
  remained unchanged, while durable run-progress showed controller heartbeats
  and tool receipts.
- Durable RunState changes were selective: #189 advanced `v6→v7`, #194
  `v11→v12`, #201 later advanced through `verifying→reviewing`, and #209 moved
  `investigating→preparing→building`. Those workers were not stopped while
  they made semantic progress.
- #202, #189, #194, #209, and #197 each reached the 481-second no-transition
  boundary on separate attempts. Each produced an
  `orchestration.watchdog` receipt, its node became `suspended` with the exact
  run/checkpoint retained, and the controller admitted a replacement (#210,
  #197, #201, #211, #212 respectively). No normal failure or issue mutation
  was manufactured. This is direct behavior evidence that the guard releases
  capacity without discarding recovery state.
- At the latest observation the DAG was `completed=4, suspended=5,
  running=4, queued=21, invalid=1, skipped=1`; no new authoritative issue
  closure has occurred yet. The live family remains contained and the run is
  still active; continue toward ten *new* completed nodes, counting neither
   suspended nodes nor the four pre-existing completions.

#### HP-18 correction: the 5-8 minute target is not a termination policy (2026-08-16 15:50 local)

- The operator clarified that 5-8 minutes per issue is a soft performance
  aspiration, not a hard cap and not permission to terminate a still-valid
  worker. The 8-minute watchdog canary therefore tested an unauthorized policy
  and must not be counted as throughput or closure evidence.
- The canary produced nine resumable suspensions and no new authoritative
  closures. The exact controller root `20504`, its descendant `34400`, and the
  matching observer were stopped after the stop sentinel was written. The DAG
  remains durable and resumable at execution attempt 14 with
  `suspended=9, completed=4, queued=17, running=4, invalid=1, skipped=1`.
  No GitHub issue, artifact, worktree, branch, or SQLite record was deleted.
- The hard semantic watchdog, its default, plan metadata, CLI option, and
  automatic abort path were removed before another run. The valid HP-17
  heartbeat/lease truthfulness repair remains. Future performance work may
  observe phase age, issue-level transitions, queue time, and token/cost burn,
  and an operator may explicitly stop a bad family; a soft target must never
  suspend work by itself.
- Verification after removal: `npm run build` and the full native Next suite
  passed `667/667` tests across `207` suites. No new live controller was
  started after the correction. This is a rollback/correction checkpoint, not
  a handoff claim: the ten-new-closure proof is still outstanding.

#### HP-18 launch correction (2026-08-16 15:02 local)

- The first attempt to start the new bounded resume exited before controller
  admission because `parseOrchestrationIssueNumbers` did not yet know the new
  `--max-worker-stall-ms` value option and interpreted `480000` as a selected
  issue. This was a CLI-only regression introduced by the watchdog option; no
  worker, GitHub mutation, or DAG transition occurred.
- Added the option to the parser's value-option set and a regression case. The
  rebuild and argument-parser suite passed (`6/6`). The exact DAG remains at
  execution attempt 13 with `4 completed, 4 running, 26 queued, 1 invalid,
  1 skipped`; the corrected resume is the next live action.

#### HP-18 final correction (supersedes the earlier live-canary notes)

The corrected resume did run, but its 8-minute watchdog was an invalid hard-cap
interpretation of the user's soft target. It was stopped and the hard-cap code
was removed. Final durable observation: attempt 14, `suspended=9,
completed=4, queued=17, running=4, invalid=1, skipped=1`, with no new closure.
Do not restart from the stale “next live action” note above; use the correction
entry as the current checkpoint.

#### No-milestone workflow-engine-error reconciliation (live checkpoint, 2026-08-16)

- The authoritative open/no-milestone query returned exactly seven requested
  issues: #189, #194, #202, #209, #210, #211, and #212. The fresh native run is
  DAG `dag_50ad2a24-44f7-4a1e-96a2-6766f7119f58`, launched from the staging
  checkout with `--rerun --auto --batching none --max-parallel 4`, provider
  `openai-codex`, model `gpt-5.6-luna`, and thinking `max`.
- A first launch without explicit provider/model failed at runtime preflight
  before admission (`Pi runtime preflight requires a provider and model`). It
  created no worker, GitHub mutation, or issue transition. Relaunching with
  explicit provider/model admitted the fresh DAG. This is a configuration
  resolution gap, not a worker failure.
- The live root is PID 17936; stdout/stderr and the observer are recorded under
  `.forgedock/no-ms-engine-errors-20260816-155957.*`. The observer's NDJSON
  stream is advancing and no stop sentinel is present.
- All seven nodes received the fallback claim
  `component:RapierCraftStudios/ForgeDockCLI`; with batching disabled, the
  controller conservatively serialized them. Six nodes therefore waited behind
  the active predecessor with durable `claim-serialization` reasons. This is
  safe but is a direct throughput finding: issue-specific concrete scopes were
  not inferred for this set.
- #189 completed investigation, Build Packet, build verification, a full
  correctness/data/concurrency review panel, promotion, and is now authoritative
  GitHub `CLOSED` with `workflow:merged`. This is the first new closure in this
  fresh reconciliation run.
- #194 completed investigation and submitted its durable artifact, then entered
  Build Packet. Its agent produced repeated invalid path probes and one retried
  read failure while continuing to make progress. These are token/time
  inefficiencies observed in subprocess evidence, not controller errors. At the
  checkpoint, #194 was still active in Build Packet and #202/#209/#210/#211/#212
  remained queued behind the same claim.
- The 5-8 minute issue target remains a soft aspiration. No timeout, watchdog,
  or automatic stop is authorized by this run; stop only for a concrete safety
  fault or confirmed dead/duplicating process family.

#### HP-19 operator stop and resume checkpoint (2026-08-16 17:51 local)

- The operator stopped the fresh reconciliation after the wall-clock review
  showed approximately 1h50m elapsed: #189 took about 36 minutes to close and
  #194 had consumed about 74 minutes without closure. This was an explicit
  operator stop for unacceptable token/time burn, not an automatic watchdog.
- The exact controller family was verified before termination: root PID 17936
  ran the expected seven-issue `dist/cli/main.js orchestrate` command and its
  only descendant was conhost PID 35604. Both were terminated. The observer
  stop sentinel was written at
  `.forgedock/no-ms-engine-errors-20260816-155957.ndjson.stop`; no unrelated
  process was targeted and no issue, artifact, worktree, branch, or database
  record was deleted.
- The durable DAG remains `dag_50ad2a24-44f7-4a1e-96a2-6766f7119f58` in
  `.forgedock/state.db`. #189 is completed and #194 retains Intent,
  Investigation, Build Packet, BuildResult, and ReviewVerdict artifacts while
  its run is at the review checkpoint; #202/#209/#210/#211/#212 remain queued
  behind the fallback component claim. The database still records the
  orchestration as running because the process was intentionally stopped before
  its final controller transition; the native `orchestrate --resume <dag-id>`
  path is the supported recovery mechanism and must reconcile this state before
  any fresh semantic rerun.
- This stop confirms the current bottleneck is architectural/operational rather
  than issue complexity alone: a broad fallback claim serialized unrelated
  scopes, and #194's review/remediation policy spent multiple full panels on a
  single issue. Future improvements must reduce needless panel/rebuild work,
  preserve substantive review, and improve claim derivation without adding a
  hard wall-clock cap.
