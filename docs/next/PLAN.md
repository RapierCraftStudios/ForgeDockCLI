# ForgeDock Next — Execution-Ready Consolidation Plan

**Status**: Execution-ready · **Next gate**: Phase G latency/token/recovery efficiency · **Scope**: the entire ForgeDock Next runtime, end to end · **Owner**: ForgeDock maintainers
**Spec type**: this is the consolidated implementation plan for the provider-neutral rewrite. It covers enforcement boundaries, orchestration, token efficiency, recursive remediation, constituent-issue provenance, observability, configuration, and green-gate hygiene.
**Authoritative references**: `AGENTS.md`, `docs/next/IMPLEMENTATION.md`, `docs/CODEX.md`, `docs/spec/forge-protocol-v1.md`, and the current source tree. GitHub issue numbers in §10 are portfolio references and must be revalidated before filing work; they are not immutable requirements.
**Legacy boundary**: `commands/`, `bin/`, hooks, and the v1 protocol remain behavioral evidence and temporary compatibility code. Do not copy their architecture into `src/`, and do not modify them as part of this plan.

This document is execution-ready because every phase below has an explicit contract, integration point, acceptance test, and failure/rollback behavior. The implementation is authoritative for current behavior; this document is authoritative for the intended changes.

---

## 0. Current baseline and architecture map

### 0.1 Baseline to refresh before Phase 0

The refreshed Next gate is **255 tests: 255 passing, 0 failing** under the default concurrency; `npm run build` and `npm run docs:build` are green. With the staging shell's `jq` path available, the current legacy invocation reaches **1,813 passing, 0 failing, and 8 intentionally skipped**. The legacy source remains outside this plan's change scope.

The disposable ForgeDockCLI run `run_ba9da0ae-4178-4a8b-8c60-cac26a9b866c` reached an approving fresh Review Verdict at `c59e2cce` but stopped at `workflow:awaiting-merge` by explicit `--no-auto-merge`. Intent-to-approval elapsed time was approximately **70m05s**, including failed recovery attempts and manual intervention. The first BuildResult's packet-to-build gap was **11m06s**, while its recorded verification checks totaled only **2m33s**; the remaining time is unmeasured agent/controller overhead. This is the performance baseline that Phase G must explain and reduce; its agent token/cost usage predates the new receipt layer and cannot be reconstructed.

Before starting Phase 0, run and record:

```bash
npm run build
npm run test:next
npm run test:legacy
```

If the counts differ, update this section and `docs/next/IMPLEMENTATION.md` before changing runtime behavior. No phase may claim a green gate using stale counts.

### 0.2 Existing integration points

- **Workflow authority**: `src/core/state/machine.ts`, `src/workflows/work-on/work-on.ts`, and the review/build/verify controllers.
- **Agent seam**: `src/runtime/agent-runtime.ts` and `src/runtime/pi-adapter.ts`. Pi is an internal kernel only.
- **Filesystem boundary**: `src/runtime/sandboxed-tools.ts`; the current guard is worktree-confined and rejects lexical and symlink escapes.
- **TUI/native tools**: `src/tui/forgedock-tools.ts` contains orchestration, batching, worker delegation, configuration, and status tool behavior. `src/tui/forgedock-extension.ts` registers and activates those tools; it is not the orchestration domain implementation.
- **CLI**: `src/cli/main.ts` has a separate `orchestrate` path and must use the same orchestration domain services as the TUI.
- **Batching**: `src/workflows/orchestrate/batching.ts` currently contracts compatible P2/P3 `review-finding` issues. `contractBatchGroups` already carries member issue numbers, while `scheduler.ts` currently schedules only the contracted issue node.
- **Scheduling**: `src/workflows/orchestrate/scheduler.ts` owns dependency validation, claim serialization, bounded concurrency, and the in-memory status map. TUI scheduling currently does not acquire the CLI's SQLite lease directly.
- **Durable artifacts**: `src/core/artifacts/schema.ts`, `codec.ts`, the artifact repositories, and the GitHub adapter. The current v2 payload set is Intent, Investigation, BuildPacket, BuildResult, ReviewVerdict, and Outcome.
- **GitHub authority**: `src/core/ports/forge-host.ts` and `src/adapters/github/github-client.ts`. New issue/branch/comment actions must be added to this port rather than calling `gh` from a TUI or agent.
- **Configuration**: `src/core/config/forgedock-config.ts` owns the managed `FORGEDOCK:NEXT-CONFIG` block in `forge.yaml`.
- **Observability**: `src/core/state/reconcile.ts`, run history, background-task records, and TUI status are operational projections; none is semantic authority.

### 0.3 Current problems

| ID | Problem | Current evidence | Cost |
| --- | --- | --- | --- |
| P1 | **The enforcement model is hard to see.** Users still associate ForgeDock with a Markdown checklist and model-controlled phase changes. | Legacy `commands/work-on.md` is prompt material; Next uses `machine.ts` and typed `AgentTask<T>` contracts. | Trust/adoption |
| P2 | **A blocked review stops delivery.** Out-of-packet findings and exhausted remediation budgets become human blocks. | `work-on.ts` calls `blockingFindingOutsidePacket` and `blockForReviewFindings`; review uses `findingIssuePolicy: "approved-only"`. | Merge throughput |
| P3 | **Arbitrary issue sets do not contract.** Current batching is deliberately limited to compatible P2/P3 review findings. | `batching.ts#batchExclusionReason` excludes ordinary, urgent, unscoped, and human-state issues. | Token/cost scale |
| P4 | **Batch members receive only a thin completion projection.** | `complete.ts` closes members and appends typed Outcome artifacts, but does not publish a complete per-member trajectory. | Provenance/learning |
| P5 | **Blocks are difficult to operate.** | Section 5 of `docs/next/IMPLEMENTATION.md` still lists the event bus, timeline, Review Desk, and Orchestration Board as incomplete. | Human triage |
| P6 | **Next has a latency regression against the legacy path.** | The disposable run took 70m05s wall-clock; the clean first path reached its first review in about 19m29s, and the packet-to-build interval contained about 8m34s beyond recorded verification. | Throughput/cost |
| P7 | **Token and cost usage need production validation.** | The runtime now emits additive provider/unavailable usage receipts and SQLite/status projections, but the historical baseline and live p50/p95 budget evidence are still missing. | Budget/audit |
| P8 | **The tested remediation branch is not yet the immutable release baseline.** | PR #118 is open against a disposable milestone branch; staging is detached and broadly dirty. Canonical subject isolation and migration fixes must be integrated into the release branch before further production claims. | Integrity/reproducibility |

These are the actual remaining gaps. Do not describe already-implemented P2/P3 batching or member Outcome projection as wholly new functionality; the phases below extend them.

---

## 1. Decisions that remove ambiguity

These decisions are part of the plan, not implementation-time choices.

### D1 — One orchestration domain, two adapters

Create pure orchestration services under `src/workflows/orchestrate/`. Both `src/tui/forgedock-tools.ts` and `src/cli/main.ts` call those services. The TUI and CLI may differ in confirmation, output, and delegation, but they must produce the same assembly, policy, contract, and schedule snapshots for the same input.

`src/tui/forgedock-extension.ts` remains a registration boundary. It may activate tools and forward events, but it must not become a second orchestration implementation.

### D2 — Explicit batching policies

`BatchingPolicy` has exactly three values:

- `aggressive` — the Next default after Phase A. Eligible ordinary issues may be contracted when the explicit compatibility rules below hold.
- `conservative` — preserves the current behavior: only compatible P2/P3 `review-finding` work is batchable.
- `none` — never creates a batch issue; every selected issue remains a work unit.

The default is **aggressive**, not a migration-time conservative default. `conservative` is an explicit diagnostic escape hatch, not a promise to preserve the old architecture.

Invocation flags override `forge.yaml`; configuration overrides built-in defaults:

```text
--batching aggressive|conservative|none
--priority P0,P1           # include only these priority labels
--milestone <title>        # include only this milestone
--no-milestone             # include only issues without a milestone
--scope-expansion scope-locked|recursive
--max-remediation-cycles N
```

`--milestone` and `--no-milestone` are mutually exclusive. `--priority` is a filter, not a re-prioritization operation.

### D3 — Assembly is pure; GitHub mutation is confirmed and idempotent

`assembleWorkUnits` only classifies, clusters, filters, and contracts in-memory items. It never creates a GitHub issue. The execution sequence is:

```text
resolve inputs
  → build evidence-backed issue plan
  → assembleWorkUnits (pure)
  → validate the proposed contracted graph
  → dry-run/confirmation
  → re-read authoritative GitHub issue evidence
  → materialize batch issues idempotently
  → contract the validated graph with real batch issue numbers
  → validate claims/dependencies again
  → run the schedule
```

A rejected confirmation or failed validation must not create a batch issue. Existing deterministic `FORGEDOCK:BATCH` markers remain the idempotency key.

### D4 — Scope has pre-packet hints and post-packet enforcement

The investigator cannot use `BuildPacket.expectedPaths` because the packet does not exist yet. Use:

- **Pre-packet `ScopeHints`**: explicit affected files, claims, issue sections, and a bounded set of repository metadata roots needed to understand verification/configuration.
- **Post-packet `ScopeManifest`**: the frozen Build Packet paths plus explicitly named read-only context roots.

The controller may widen scope only through the explicit recursive-remediation checkpoint described in Phase C. Prompt text is never the security boundary.

### D5 — Recursive child delivery targets the parent PR branch

A child remediation work-on does not create an unrelated PR against the repository default/milestone branch. It creates a child PR whose base is the **parent delivery branch**. After child verification and approval, that child PR merges into the parent branch; the parent PR therefore receives the fix and gets a new head SHA.

The parent is re-verified and freshly reviewed at that new SHA before it can merge into its original target branch. This is the only supported recursive branch strategy.

### D6 — Audit receipts use the FORGE protocol's comment transport

The protocol defines append-only issue/PR comments and `FORGE:TRAJECTORY`. Do not invent `FORGEDOCK:TRACTION`, mutate issue bodies, or add a non-protocol closing convention without changing the protocol and parser together.

Each completed member receives one idempotent `FORGE:TRAJECTORY` issue comment containing a bounded, machine-readable `forgedock.trajectory/v1` receipt plus a human-readable summary. The parent batch issue may receive an aggregate trajectory comment.

### D7 — Semantic state is durable; scheduling state is rebuildable

GitHub artifacts/comments, PRs, branches, and issue state are semantic truth. SQLite leases, local run history, scheduler status, background-task records, and Pi sessions are operational state. Lease rows are never fencing authority: an authenticated retained checkpoint outside the rollback scope must verify and advance every epoch, and loss/divergence denies acquire, heartbeat, release, and dependent writes until higher-epoch re-enrollment. Recursive orchestration must be restartable by reconstructing from durable artifacts; an in-memory callback alone is not sufficient.

---

## 2. Target execution graph

```text
/orchestrate issues + resolved policy
        │
        ▼
shared buildVisibleOrchestrationPlan adapter
        │
        ▼
pure assembleWorkUnits
  ├─ apply priority/milestone filters
  ├─ classify singleton vs batchable
  ├─ cluster compatible members deterministically
  ├─ retain member contracts, dependencies, claims, lanes, and risk
  └─ produce proposal + graph input; no GitHub writes
        │
        ▼
confirm → authoritative revalidation → idempotent batch materialization
        │
        ▼
contractBatchGroups → materializeClaimDependencies → runSchedule
        │
        ├─ normal work unit
        │    └─ issue worker → typed work-on → verify → PR → review → merge
        │
        └─ recursive remediation work unit
             ├─ parent enters semantic blocked checkpoint
             ├─ coordinator materializes finding issues through ForgeHost
             ├─ child PRs target the parent's delivery branch
             ├─ child PRs verify/review/merge serially on that branch
             ├─ parent branch is re-verified at a new SHA
             ├─ exact approved remediation scope is granted
             └─ parent resumes fresh review; only then can it merge
```

### Non-negotiable invariants

- `src/core/state/machine.ts` is the sole authority for phase transitions and merge admission. A successful delivery still requires `REVIEW_APPROVED → MERGE_COMPLETED → CLOSE_COMPLETED`.
- Pi is accessed only through `src/runtime/pi-adapter.ts`; reviewers have `read`, `grep`, `find`, and `ls` only. No reviewer or worker receives unrestricted shell or GitHub authority.
- `scope-locked` is the default. Recursive scope expansion is opt-in, exact, bounded, and auditable.
- An out-of-packet finding is never silently downgraded, ignored, or folded into a packet without a durable controller checkpoint.
- The original Build Packet remains immutable. Recursive scope is represented by a separate, controller-authored checkpoint/allowance and is limited to the recorded finding locations.
- No 100 KB Markdown command specification is placed in a model prompt. Native prompts contain only the resolved task, policy, bounded context, and typed tool contract.
- Dependents do not run while a prerequisite is `blocked` or recursively `suspended`; after successful parent resumption they are released through the normal DAG.
- Every external mutation is performed through a typed port and has an idempotency key.

---

## 3. Phased implementation roadmap

### Phase 0 — Green gate and documentation baseline

**Goal**: establish a trustworthy starting point before changing orchestration behavior.

#### Changes

1. Add `"compute"` to the expected builder grants in `src/workflows/work-on/build.test.ts`.
2. Re-run `npm run build`, `npm run test:next`, and `npm run test:legacy`.
3. Synchronize the counts and known pending items in `docs/next/IMPLEMENTATION.md`.
4. Record the commit/test output in the Phase 0 issue.

#### Acceptance

- `npm run build` exits successfully.
- `npm run test:next` reports 255/255 (or the refreshed baseline count with zero failures).
- `npm run test:legacy` reports zero failures.
- No source authority or behavior changes are included in this phase.

**Dogfood**: this one-line assertion fix is a green-gate prerequisite. Do not force it through recursive remediation merely to make the dogfood narrative circular.

---

### Phase A — Shared pre-DAG work-unit assembly

**Goal**: contract arbitrary compatible issue sets before worker dispatch without duplicating the TUI and CLI implementations.

#### A1. Define the pure contracts

Create `src/workflows/orchestrate/assemble.ts` with:

```ts
interface BatchingOptions {
  policy: "aggressive" | "conservative" | "none";
  maxBatchSize: number;          // default 8, positive integer
  maxSensitiveBatchSize: number; // default 3, positive integer <= maxBatchSize
}

interface WorkUnitAssembly {
  selected: BatchableWorkItem[];
  groups: IssueBatchGroup[];
  ungrouped: BatchableWorkItem[];
  excluded: Array<{ item: BatchableWorkItem; reason: string }>;
  policy: BatchingOptions;
}

function assembleWorkUnits(
  items: readonly BatchableWorkItem[],
  options: BatchingOptions,
): WorkUnitAssembly;
```

`assembleWorkUnits` is deterministic: same issue plan and options produce the same group IDs, member ordering, and contracted dependency set.

#### A2. Define eligibility and clustering exactly

`batching.ts` must split the current exclusion behavior into explicit predicates:

#### Always singleton/excluded

- already-batched members;
- `needs-human`, `blocked`, `operator-only`, or `batch` state;
- billing work is always singleton; security/auth work is sensitive and may group only under the explicit sensitive-cap rules below;
- migrations and high-blast-radius paths, including `.env*`, compose/Docker files, `index.*`, `main.*`, and the existing high-blast-radius patterns;
- issues without a trustworthy repository/lane/target branch;
- issues with no affected file or explicit component claim. These may be selected as singleton work, but never grouped by guesswork.

#### Conservative policy

- retain the current `review-finding` label requirement;
- retain the current P2/P3 urgency requirement;
- retain all current risk and human-state exclusions;
- use the current grouping precedence.

#### Aggressive policy

- ordinary issues and P0/P1 issues may be grouped only when they share all of:
  - repository and target branch/lane;
  - urgency tier (`urgent` = P0/P1 or `normal` = P2/P3; unknown is singleton);
  - risk class;
  - a compatible grouping key;
  - no unsafe path or human/operator state;
- `security` and `auth` groups use `maxSensitiveBatchSize` and require an exact same-file, source-PR, or defect-class key; they may not be grouped merely because they share a directory;
- `billing` remains always singleton.
- grouping precedence is deterministic: `same-file`, then `source-pr`, then `defect-class`, then `leaf-directory`;
- a key is usable only when at least two members share it;
- members are sorted by priority then issue number and split at the configured cap;
- internal dependencies are removed from the contracted node; external dependencies are unioned and remapped to the batch node; the post-contract graph must pass cycle validation;
- a group is rejected if its members have incompatible milestones or if the resulting dependency/claim graph is non-convex.

`claimsConflict` remains a scheduling safety mechanism, not a substitute for batch eligibility. The output must retain each member's `memberIssues`, `affectedFiles`, claims, priority, risk, and member contract.

#### A3. Separate materialization from assembly

Extract the existing TUI-side authoritative validation/materialization behavior into `src/workflows/orchestrate/materialize.ts`. Add the required batch-materialization operation to `ForgeHost`, implemented by `GitHubClient`, so the shared service never reaches directly into a TUI client:

1. re-read every proposed member through `ForgeHost`;
2. verify state is open, labels/body markers and affected files still match, and milestones/lanes still agree;
3. preserve the existing deterministic `FORGEDOCK:BATCH` marker and `renderBatchIssueBody` idempotency behavior;
4. create or reuse each batch issue through `ForgeHost`, never through an agent or direct TUI `gh` call;
5. return real batch issue numbers and the validated member contract;
6. re-run dependency and claim validation after materialization.

Dry-run and cancelled confirmation must result in zero GitHub writes.

#### A4. Wire both adapters

Modify both orchestration entry points:

- `src/tui/forgedock-tools.ts`: use the shared assembly/materialization services in the native orchestrate tool; expose the policy and filter inputs.
- `src/cli/main.ts`: make CLI `orchestrate` use the same services rather than bypassing batching.
- `src/tui/forgedock-extension.ts`: only forward tool activation/events; do not add a second planner.
- `src/workflows/orchestrate/scheduler.ts`: carry `memberIssues` and member metadata through schedule inputs/results without making the scheduler responsible for GitHub materialization.

#### Phase A acceptance

- A deterministic 30-issue fixture with declared paths, priorities, risk, and dependencies contracts to the documented expected groups and no more than seven work units. The number is fixture-specific, not a universal promise for arbitrary issue text.
- `--batching none` produces one work unit per selected issue.
- `conservative` matches the current P2/P3 review-finding behavior.
- `aggressive` groups eligible ordinary issues but never groups the safety exclusions above.
- TUI and CLI produce byte-equivalent assembly/schedule snapshots for the same fixture.
- Dry-run and cancelled confirmation perform no GitHub mutation.
- Repeating materialization reuses the same batch issue rather than creating a duplicate.
- External dependencies reroute to the batch node and cycles are rejected before dispatch.
- All Phase 0 tests remain green.

**Files/tests**: `assemble.ts`, `assemble.test.ts`, `materialize.ts`, `materialize.test.ts`, `batching.ts`, `batching.test.ts`, `scheduler.ts`, `scheduler.test.ts`, `src/tui/forgedock-tools.ts`, `src/cli/main.ts`, and their existing integration tests.

**Rollback**: keep `--batching conservative` and `--batching none` available. If aggressive assembly fails validation, dispatch the original uncontracted set only after explicit confirmation; never silently fall back after GitHub mutation.

---

### Phase B — Scoped context and filesystem access

**Goal**: reduce repeated repository ingestion while preserving a usable, fail-closed controller boundary.

#### B1. Add an explicit scope manifest

Extend `src/runtime/agent-runtime.ts` with a typed scope manifest carried by `AgentTask.workspace`:

```ts
interface ScopeManifest {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  source: "issue-hints" | "build-packet" | "remediation";
}
```

The existing worktree root and symlink protections remain mandatory. Scope roots are an additional allowlist, not a replacement for the worktree guard.

- Investigator: use pre-packet `ScopeHints` derived from issue evidence and work-unit affected files. The controller computes the bounded metadata roots before the agent starts: root package manifest, lockfile(s), TypeScript/build/lint configuration referenced by the verification policy, `forge.yaml`, `FORGE.md`, and the specific directories containing declared affected paths. It never grants an unbounded repository root merely because discovery is inconvenient.
- Builder/remediator: read the packet and approved context roots; write only inside packet `expectedPaths` (plus explicitly declared generated/test paths).
- Reviewer: read-only; read roots include the frozen diff, packet paths, and packet-declared context. Reviewer scope is never widened by prompt text.
- Recursive child: use the finding location and parent-branch contract as its initial scope.

If no trustworthy affected path or claim exists, the issue is a singleton and the investigator receives only bounded metadata roots; it must return `decompose` or request a decision rather than scanning the entire repository.

#### B2. Enforce the manifest in every tool

Modify `src/runtime/sandboxed-tools.ts` so `read`, `grep`, `find`, `ls`, `edit`, and `write` all enforce:

- lexical path normalization;
- allowed-root ancestor/descendant semantics;
- realpath/symlink checks;
- `grep` search roots and `find` search CWDs inside the manifest;
- writes inside both the worktree and `writeRoots`.

Update `src/runtime/pi-adapter.ts` and `assertToolPolicy` so every task receives the manifest and no role can omit it accidentally.

#### B3. Thread scope at the correct lifecycle points

Modify `investigate.ts`, `prepare.ts`, `build.ts`, `remediate.ts`, and `work-on.ts`:

1. derive and persist pre-packet hints in the Intent/work-unit execution context;
2. create the Build Packet from that bounded context;
3. freeze the packet's expected paths;
4. construct the post-packet manifest for build, verify, and review;
5. retain the manifest in recovery inputs so resume cannot silently regain repository-wide access.

#### Phase B acceptance

- A three-path fixture proves investigator reads/searches only permitted roots and still reaches required package/config metadata.
- A builder cannot read or write a path outside its manifest, including through `..`, absolute paths, symlinks, glob search roots, or directory aliases.
- A reviewer remains read-only and cannot request `edit`, `write`, or `bash`.
- Recovery/resume preserves the same scope manifest.
- Missing or ambiguous scope causes a typed investigation outcome, not an unrestricted fallback.
- Existing workspace escape and builder-boundary tests remain green.

**Files/tests**: `agent-runtime.ts`, `pi-adapter.ts`, `sandboxed-tools.ts`, `sandboxed-tools.test.ts`, `investigate.ts`, `prepare.ts`, `build.ts`, `remediate.ts`, `work-on.ts`, and workflow recovery tests.

---

### Phase C — Durable, orchestrator-owned recursive remediation

**Goal**: make opt-in scope expansion safe, restartable, branch-correct, and reviewable without changing the default scope-locked behavior.

#### C1. Define the durable checkpoint

Add `RemediationBlocked` to the existing v2 artifact payload registry in `src/core/artifacts/schema.ts`. This is an additive kind; do not change the existing envelope or legacy command system.

The payload must contain:

```text
checkpointKey       deterministic run/head/finding identity for idempotency
checkpointSequence  monotonically increasing checkpoint revision for this key
status              awaiting-dispatch | children-running | ready-to-resume | terminal
parentRunId         parent work-on run
parentIssue         batch/source issue number
pullRequest         parent PR number
headSha             frozen parent PR SHA at the block
headBranch          parent delivery branch
baseBranch          original PR target branch
packetArtifactId    immutable Build Packet being expanded from
verdictArtifactId   blocking Review Verdict
reason              scope-violation | remediation-budget
findings[]          finding id, severity, title, evidence, location, remediation
childIssues[]       materialized child issue numbers
childRunIds[]       child run identifiers when known
approvedPaths[]     exact paths granted after successful child completion
childOutcomeIds[]   authoritative child Outcome artifact IDs
remediationDepth    current depth
maxRemediationDepth configured bound
```

Each status change is a new immutable artifact with the same `checkpointKey` and a higher checkpoint sequence. `reconcileArtifacts` uses the newest valid checkpoint; it never mutates or infers one from a session log.

Update `schema.ts`, `codec.ts`, artifact repository tests, GitHub artifact parsing, and `reconcile.ts`. The latest checkpoint is resumable only when `status=ready-to-resume`, all listed child Outcomes are authoritative and merged, the parent branch head can be re-read, and the exact `approvedPaths` are present.

#### C2. Keep the default path unchanged

For `scope-locked`, retain the existing behavior:

- review findings are materialized according to the current policy;
- `blockingFindingOutsidePacket` or an exhausted remediation budget produces the existing blocked Outcome/state;
- the PR does not merge;
- no child worker is created.

For `recursive`, only findings with a stable location, a bounded remediation description, and an independently testable acceptance criterion are eligible. Any finding without those properties remains human-blocked even under recursive policy.

Do not treat every exhausted remediation budget as automatically decomposable. An in-scope finding that merely needs another builder cycle must be resumed through the existing review checkpoint or escalated; it is not automatically converted into an unrelated child issue.

#### C3. Materialize child issues through the host port

Use the existing review-finding/decomposition materialization mechanism, extended through `ForgeHost`, rather than calling `github.createIssue` from the orchestrator. Child issue creation must be deterministic on `(repo, parentRunId, findingId, headSha)` and include:

- parent batch/source issue and parent PR;
- exact finding evidence and location;
- one bounded acceptance criterion;
- parent delivery branch target metadata;
- remediation depth and checkpoint key;
- a link to the blocking Review Verdict.

The orchestrator appends a `children-running` checkpoint after child materialization. Repeated dispatch after a crash reuses existing child issues and never duplicates workers without checking child run/artifact state.

#### C4. Deliver child fixes onto the parent branch

Add a trusted `parentRemediation` target to the work-on controller input. It must include the parent run, parent PR, parent delivery branch, captured parent head SHA, finding ID, and depth. The controller must:

1. verify the parent branch still exists and has the expected ancestry;
2. create a child delivery branch from the captured parent branch;
3. run the normal typed investigate/build/verify/review/merge path for the child;
4. create the child PR with the parent delivery branch as its base;
5. acquire a branch claim so only one child mutates that parent branch at a time;
6. merge only at the expected child SHA;
7. emit a normal child Outcome linked to the parent checkpoint.

Modify `src/workflows/work-on/lane.ts`, `src/workflows/work-on/publish.ts`, `src/workflows/work-on/complete.ts`, `src/core/ports/forge-host.ts`, and `src/adapters/github/github-client.ts` to enforce this target. A child PR targeting the repository default or ordinary milestone branch is invalid for this path.

#### C5. Resume the parent only after a fresh proof

After all child Outcomes are merged:

1. fetch the parent PR and its new head SHA;
2. verify that the head branch is the recorded parent branch and that the new SHA contains the child merges;
3. run the parent's frozen verification commands against the new head with a dedicated `verifyParentRevision` controller path; this path creates a new Build Result without pretending a new builder session authored the child commits;
4. append a `ready-to-resume` checkpoint containing the child Outcome IDs and exact approved finding paths;
5. add and use the explicit `RESUME_EXPANDED_REVIEW` transition from `blocked` to `reviewing`; this is the only semantic transition for this path and is accepted only after steps 1–4 pass;
6. pass the checkpoint as review context and make `blockingFindingOutsidePacket` accept only the checkpoint's exact approved paths;
7. perform a fresh independent review at the new SHA;
8. if approved, use the normal merge/close gate.

`verifyParentRevision` takes the retained parent workspace/branch, the frozen verification plan, the child Outcome IDs, and the approved finding paths. It runs the required checks, compares the remote parent SHA, creates a controller-authored Build Result, and does not create a synthetic builder commit or builder session. Failed checks leave the parent blocked with failure evidence.

The original Build Packet remains immutable. A reviewer may not treat arbitrary new paths as in-scope merely because a child completed; only the controller-authored checkpoint grants the recorded finding scope. `machine.ts` must define `RESUME_EXPANDED_REVIEW` from `blocked` to `reviewing`, and `transition()` must clear the blocked reason for that event just as it does for the other resume events.

#### C6. Make orchestration suspension durable

Extend the shared scheduler contract with a typed worker result and an operational `suspended` status:

```text
completed  — work unit completed and dependents may proceed
blocked    — terminal/human block; dependents remain blocked
suspended  — recursive checkpoint is active; dependents wait
failed     — operational failure; recovery policy applies
```

`runSchedule` must expose status updates through a callback/event sink and must not model a suspended parent as a successful completion. Add a shared `RemediationSupervisor` under `src/workflows/orchestrate/` that:

- observes a `RemediationBlocked` result;
- materializes/reuses child issues;
- starts child work units with a dependency on the parent checkpoint;
- resumes the parent after C5;
- records operational orchestration state sufficient for restart;
- converts child failure, cancellation, depth exhaustion, cycle detection, or missing branch to a human block.

The TUI and CLI call this supervisor. A session restart reconstructs it from the parent checkpoint, child issue markers, child artifacts, and branch/PR state. An in-memory `taskFor` callback is never the only parent/child relationship.

#### C7. Bound recursion

Defaults and hard caps:

- `scopeExpansion`: `scope-locked`;
- `maxRemediationCycles`: 2;
- `maxRemediationDepth`: 2;
- `maxRemediationChildren`: 8 per checkpoint;
- one child per finding identity and one active child per parent branch claim.

Exceeding any cap produces a normal human block with a durable reason. No recursive path may create an unbounded issue/worker tree.

#### Phase C acceptance

- Scope-locked behavior is unchanged by regression tests.
- Recursive mode creates deterministic finding issues through `ForgeHost`, never duplicates them after restart, and records a `RemediationBlocked` checkpoint.
- Child PRs target and merge into the parent delivery branch, not the repository default/milestone branch.
- A child merge changes the parent PR head; the parent is re-verified and freshly reviewed at that exact SHA.
- The parent does not receive a `needs-human` terminal projection while children are active, but it cannot merge until the fresh review approves.
- Child failure, stale branch, missing location, cycle, depth cap, or verification failure becomes a human block.
- A second recursive block resumes from the durable checkpoint rather than replaying completed child work.
- CLI and TUI produce the same supervisor outcome.

**Files/tests**: `schema.ts`, `codec.ts`, artifact repository tests, `reconcile.ts`, `machine.ts`/transition tests as required by the chosen event path, `forge-host.ts`, `github-client.ts`, `lane.ts`, `publish.ts`, `complete.ts`, `work-on.ts`, `review.ts`, new `src/workflows/orchestrate/remediation.ts`, `scheduler.ts`, `src/tui/forgedock-tools.ts`, `src/cli/main.ts`, and restart/branch/recovery integration tests.

---

### Phase D — Per-member audit trajectory

**Goal**: preserve what each member required, what changed, why it was accepted, and how it was reviewed.

#### D1. Preserve a machine-readable member contract

Extend the batch contract produced by Phase A with, for every member:

- issue number and repository;
- original title/problem summary;
- acceptance criteria copied from authoritative issue evidence;
- affected files/claims;
- dependency and risk metadata.

The batch issue body must retain the current deterministic `FORGEDOCK:BATCH` marker and add exactly this bounded member-contract block:

```text
<!-- FORGEDOCK:BATCH_CONTRACT:v1 -->
{"members":[{"issue":123,"title":"...","acceptanceCriteria":["..."],"affectedFiles":["src/example.ts"],"claims":["component:example"],"riskClass":"routine"}]}
<!-- /FORGEDOCK:BATCH_CONTRACT:v1 -->
```

The JSON is limited to the member issue number, title, acceptance criteria, affected files, claims, risk class, and source issue URL; full issue bodies and transcripts do not belong in the contract. `parseBatchMemberIssues` and a new `parseBatchContract` must reject malformed, duplicated, or ambiguous contracts rather than guessing.

#### D2. Publish protocol-compliant trajectory comments

Add a typed host method equivalent to:

```ts
publishIssueComment({
  repo,
  issue,
  marker,
  body,
}): Promise<void>;
```

The GitHub implementation must deduplicate by the deterministic trajectory marker. `completeWorkItem` must call this method for every member after the parent PR has merged and before member closure is projected.

The comment must begin with `<!-- FORGE:TRAJECTORY -->` and contain a bounded `forgedock.trajectory/v1` receipt with:

- member issue and batch parent;
- Intent/Investigation/BuildPacket/BuildResult artifact IDs;
- member acceptance criteria and per-criterion evidence/status;
- changed paths and verification summary;
- PR URL, final SHA, and original target branch;
- review verdict ID, disposition, specialist roles, finding IDs, and session references;
- direct-merge or recursive-remediation disposition;
- child issue/outcome references when applicable;
- completion timestamp and controller run ID.

End the receipt with the protocol completion sentinel `<!-- FORGE:TRAJECTORY:COMPLETE -->`. Do not write this receipt into the issue body; comments are the protocol's append-only transport. The parent batch issue may receive a compact aggregate `FORGE:TRAJECTORY` comment.

#### D3. Make completion idempotent

A repeated completion/recovery attempt must not duplicate trajectory comments or close the wrong issue. The deterministic marker must include run ID, member issue, and final SHA. Member closure remains through `ForgeHost.closeIssue` after the receipt is successfully published; if receipt publication fails, the run remains recoverable and is not falsely projected as complete.

#### Phase D acceptance

- A successful batch merge publishes one parseable trajectory receipt to every member issue.
- `gh issue view <member> --json comments` contains the receipt; the body is unchanged unless a separate user action edits it.
- The receipt includes the member contract, PR SHA, verification evidence, review verdict, and disposition.
- Re-running completion does not duplicate the receipt.
- `node scripts/conformance-check.mjs` accepts the comment and a focused trajectory parser test validates the JSON payload.
- Existing typed member Outcome artifacts and issue closure behavior remain intact.

**Files/tests**: `batching.ts`, batch parser tests, `complete.ts`, `work-on.ts`, new trajectory renderer/parser tests, `forge-host.ts`, `github-client.ts`, artifact/trajectory conformance tests, and `scripts/conformance-check.mjs` only if its existing protocol parser needs the new payload shape.

---

### Phase E — Event bus, run timeline, Review Desk, and Orchestration Board

**Goal**: make durable state and live operational state visible without moving authority into the TUI.

#### E1. Define one view-model/event contract

Create `src/workflows/orchestrate/events.ts` for event names/payloads and `src/workflows/orchestrate/view-model.ts` for projection and snapshot construction. The shared orchestration snapshot/event type is:

```text
OrchestrationSnapshot {
  orchestrationId,
  nodes: [{ id, issue, memberIssues, status, dependencies, claims, error }],
  readyNodes,
  blockedNodes,
  suspendedNodes,
  activeLeases,
  remediationCheckpoints,
  updatedAt
}
```

`runSchedule` emits snapshots on queue, start, completion, failure, block, suspension, and resume. The snapshot is an operational projection; it cannot authorize a transition or merge.

#### E2. Implement the consumers

- **Orchestration Board**: render ready/running/suspended/blocked/completed nodes, claims, leases, and dependents.
- **Review Desk**: render blocking findings, exact scope, checkpoint status, child issues, and the next allowed action.
- **Run timeline**: project `RunRepository.history`/`TransitionRecord` when available and reconstruct artifact milestones when local history is missing. Never infer authority from a Pi transcript.
- **Status command**: show the same durable state in CLI JSON/text and TUI views.

A “decompose” action is a controller request to the shared remediation supervisor, not a TUI-side issue mutation. The action must be idempotent and must show the checkpoint it is acting on.

#### E3. Rebuild after restart

Persist enough operational snapshot/task metadata to reconnect visible workers, but rebuild semantic status from GitHub artifacts, PR/issue state, leases, and `RemediationBlocked` checkpoints. A lost TUI session must not lose a child dependency or cause duplicate dispatch.

#### Phase E acceptance

- Live TUI and CLI views receive scheduler updates without polling loops that become authority.
- A blocked recursive checkpoint shows finding, parent PR SHA, child status, and available actions.
- A suspended parent never appears completed to dependents.
- Restart reconstructs the same semantic status and does not duplicate child issue/worker dispatch.
- A TUI action can request supervisor work but cannot bypass the state machine or merge gate.

**Files/tests**: new orchestration event/view-model modules and tests, `scheduler.ts`, `src/tui/forgedock-tools.ts`, `src/tui/forgedock-extension.ts`, background task projection, `src/cli/main.ts`, status/reconcile tests, and TUI rendering tests.

---

### Phase F — Configuration and developer experience

**Goal**: expose the policies consistently and make their precedence observable.

#### F1. Managed configuration shape

Extend only the managed `FORGEDOCK:NEXT-CONFIG` block:

```yaml
next:
  agents:
    worker_model: "provider/model"
    worker_thinking: "high"
    planning_model: "provider/model"
    planning_thinking: "high"
    reviewer_model: "provider/model"
    reviewer_thinking: "high"
    max_review_specialists: 4
  orchestration:
    batching:
      policy: "aggressive"
      max_batch_size: 8
      max_sensitive_batch_size: 3
    scope_expansion: "scope-locked"
    max_remediation_cycles: 2
    max_remediation_depth: 2
    max_remediation_children: 8
    max_parallel: 4
    auto_merge: true
```

Defaults are:

```text
batching.policy             aggressive
max_batch_size              8
max_sensitive_batch_size    3
scope_expansion             scope-locked
max_remediation_cycles      2
max_remediation_depth       2
max_remediation_children    8
max_parallel                existing safe default (up to 4)
auto_merge                  existing configured default
```

#### F2. Define precedence and validation

`planning_model` and `planning_thinking` select the read-only investigator and Build Packet author independently from worker and reviewer models. Native `/orchestrate` issue-set interpretation remains the supervising terminal model and is not silently redirected by this setting.

`src/core/config/forgedock-config.ts` must provide typed parsing/rendering and helpers:

```text
invocation flag > forge.yaml managed value > built-in default
```

Validate enum values, positive integer bounds, sensitive cap <= normal cap, and mutually exclusive filters. Preserve unrelated user-authored YAML and update only the managed block atomically.

#### F3. Wire every interface

- `src/tui/forgedock-tools.ts` CONFIG_TOOL accepts and displays batching, scope, remediation-cycle/depth/child, and parallel settings.
- Native `orchestrate` accepts the per-run policy/filter/scope fields.
- `src/cli/main.ts` accepts the same flags and resolves them through the same helper.
- `buildIssueWorkerTask` and `buildNativeCommandPrompt("orchestrate")` include the resolved policy and explicitly state that workers cannot override it.
- `/forgedock-status` displays the effective policy and source of each value.

#### Phase F acceptance

- TUI and CLI resolve identical effective options.
- `/forgedock-config` writes only the managed block and round-trips the nested values.
- Invocation overrides config; config overrides defaults.
- Invalid ranges/policies fail before GitHub mutation.
- Worker prompts contain the effective policy, scope mode, and remediation bounds.
- No legacy command file is modified.

**Files/tests**: `src/core/config/forgedock-config.ts`, config tests, `forge.yaml` managed section, `src/tui/forgedock-tools.ts`, `src/tui/forgedock-extension.ts`, `src/cli/main.ts`, prompt/tool tests, and status tests.

---

### Phase G — Latency, token, and recovery efficiency

**Goal**: bring the controlled Next path back to the legacy service level without weakening typed authority, independent review, verification, or auditability. This is the immediate next gate and must run before additional live multi-issue dogfooding.

#### G0. Freeze a comparable benchmark

Create a repeatable disposable benchmark with one small issue and one issue that requires one in-scope remediation. Record both **wall-clock** and **active controller** time; human approval holds, manual edits, provider outages, and waiting for an operator are separate intervals, not hidden inside a phase.

The benchmark must capture the current run's evidence as a regression fixture:

- Intent `12:53:47.781Z`;
- Investigation `12:55:33.931Z`;
- Build Packet `12:58:34.030Z`;
- first Build Result `13:09:40.225Z`;
- first Review Verdict `13:13:17.320Z`;
- blocked Outcome `13:20:02.264Z`;
- remediated Build Results `13:45:27.040Z` and `14:00:25.508Z`;
- approving fresh Review Verdict `14:03:52.855Z`.

Do not use the 70m05s number as a pure compute benchmark; preserve it as the lifecycle/recovery benchmark and explain every idle/manual interval.

#### G1. Add durable phase and agent usage receipts

Extend `src/runtime/agent-runtime.ts` and `src/runtime/pi-adapter.ts` with a normalized operational receipt returned by every agent task:

```text
AgentUsage {
  inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
  totalTokens, estimatedCostUsd, source: provider | unavailable
}
AgentTiming {
  queuedAt, startedAt, completedAt, activeMs, queueMs,
  retryCount, resumedFrom
}
```

The adapter must map provider usage when available and explicitly record `source=unavailable` when a provider does not expose it; never invent zeroes. Add a bounded additive `RunTelemetry` artifact or equivalent operational repository record containing run ID, phase, task ID, provider/model, timing, usage, retry/error classification, and correlation IDs. Telemetry is audit/projection data only: it cannot authorize a transition, approve a review, or merge a PR. Do not persist prompts, secrets, or full model transcripts.

Aggregate totals must be queryable from `status --json` and included in the bounded trajectory/completion receipt. Nested reviewers and resumed sessions must contribute exactly once by session lineage, while retries remain visible as attempts. This closes the current inability to answer “how many tokens did this run burn?”

#### G2. Fail fast before GitHub mutation

Add a typed runtime preflight before Intent publication, worktree creation, or agent dispatch. It must validate:

- provider/model selection and authentication;
- model availability in the configured Pi runtime;
- required local executables and package verification policy;
- required repository/ref access;
- configured verification commands and known environment blockers such as missing `jq`.

A failed preflight returns an actionable local error and telemetry, not a partially started semantic run that later fails with `Pi runtime requires a provider and model`. `--provider`/`--model` and managed configuration retain their existing precedence.

#### G3. Remove redundant verification work

Refactor `src/cli/verification-policy.ts` and `src/adapters/process/process-verifier.ts` so the controller can prove command coverage without executing the same work twice:

- detect nested scripts such as `npm test` invoking `npm run build`, and reuse the already-produced build result;
- run independent `diff-check`, build, documentation, and test groups concurrently only when their fixture/lease declarations prove isolation;
- skip documentation/build checks only when the frozen policy and changed-path evidence explicitly permit it;
- keep required evidence and baseline-failure comparison intact; optimization must never turn an unexecuted required check into `passed`;
- separate Next tests from legacy compatibility tests when the packet permits, while retaining an explicit full-gate mode for release validation.

Add command-plan IDs, deduplication tests, and timing receipts proving which executable work actually ran.

#### G4. Shorten the LLM critical path without removing authority

Benchmark and then adopt role-specific model policies:

- investigation and packet authoring use a bounded/medium thinking tier unless the risk classifier requires escalation;
- builder uses a bounded worker budget and receives a compact typed context rather than repeated full artifact serialization;
- reviewers retain a required correctness reviewer, but specialist count is risk-based and capped; post-remediation review remains fresh and independent without automatically repeating irrelevant specialists;
- packet authoring must consume the confirmed Investigation and avoid a second unrestricted repository discovery pass;
- cache bounded `FORGE.md`/devdocs lookups per run and scope, rather than performing identical retrieval for every agent;
- every agent has an explicit tool-call/attempt/elapsed budget and must terminate after `submit_artifact`.

A cheaper/faster model is acceptable only when the same schema, scope, verification, review, and controller gates remain authoritative. No optimization may merge independent reviewer sessions into one self-review.

#### G5. Make recovery cheap and automatic

Treat stale PR projection, provider failure, SQLite lock, and process interruption as typed recoverable checkpoints:

- refresh an existing PR after pushing and compare the remote branch head directly;
- supersede stale failed/blocked Outcomes when a newer verified Build Result exists;
- resume from the latest durable checkpoint without replaying investigation, packet authoring, or build;
- preflight provider/model state before retrying a reviewer;
- distinguish controller-active time, waiting-for-provider time, and human-held time in the timeline;
- never require manual file edits, commit, or push merely to continue a verified remediation.

Each recovery path needs a focused fault-injection test and an idempotency assertion.

#### Phase G acceptance

- Three disposable benchmark runs establish p50/p95 active and wall-clock timings. A clean small issue must meet or beat the legacy **12-minute** target; one in-scope remediation must meet or beat the legacy **17-minute** target without manual intervention. If the target is missed, the phase remains open with a measured bottleneck, not a readiness claim.
- Every agent task and controller phase has timing and token/cost data, or an explicit unavailable marker; `status --json` reports run totals.
- Provider/model misconfiguration fails before semantic GitHub mutation.
- No nested verification command runs twice; full release validation remains available and auditable.
- The first BuildResult packet-to-build overhead is decomposed into agent active, queue, tool, retry, and controller time; no unexplained gap remains.
- Recovery from stale PR head, provider failure, SQLite lock, and process restart completes without replaying completed semantic phases.
- A clean immutable staging commit—not a broad dirty checkout—is the benchmark/release subject.
- All Next tests, docs, focused fault-injection tests, and the required legacy gate pass before performance is declared production-ready.

**Files/tests**: `src/runtime/agent-runtime.ts`, `src/runtime/pi-adapter.ts`, `src/cli/main.ts`, `src/cli/verification-policy.ts`, `src/adapters/process/process-verifier.ts`, `src/core/artifacts/schema.ts`/`codec.ts` if telemetry is durable, `src/core/state/reconcile.ts`, `src/workflows/work-on/*.ts`, `src/workflows/review-pr/review.ts`, telemetry/status tests, recovery/fault-injection tests, and a disposable benchmark harness under `scripts/` or `src/workflows/`.

**Rollback**: telemetry is additive and can be disabled at the projection layer. Keep the original serial verification plan and high-thinking reviewer policy behind explicit configuration while benchmark results are collected. Never silently reduce required checks or reviewer independence to hit a timing target.

## 4. Phase dependency and delivery order

The implementation order is fixed:

```text
Phase 0
  ↓
Phase G (latency, token/cost, verification deduplication, and recovery baseline)
  ↓
Phase A (shared assembly + authoritative materialization)
  ↓
Phase B (scope manifests; may run in parallel with A only after its contracts exist)
  ↓
Phase C1/C2 (durable blocked checkpoint and default-path regression)
  ↓
Phase C3–C7 (child branch delivery, supervisor, parent resume)
  ↓
Phase D (trajectory receipts)
  ↓
Phase E (view model and operational consumers)
  ↓
Phase F (final policy/config UX; config fields may be added earlier only as inert validated values)
```

Phase G is deliberately ahead of further dogfooding: without timing and usage receipts, later orchestration benchmarks cannot distinguish model work, verification work, controller queueing, human holds, and recovery replay.

Phase C recursive behavior must not be enabled in a real repository until C1–C7 integration tests pass. Phase D can begin with direct batch completion once Phase A's member contract exists, but recursive disposition fields remain absent until Phase C produces them.

Each phase is one or more GitHub issues with:

- exact paths and symbols;
- a typed acceptance test reference;
- explicit `scope-locked`/failure behavior;
- no unrelated refactor;
- required build/test commands;
- a rollback/recovery note.

The existing `/orchestrate` pipeline may execute these issues, but Phase A itself cannot rely on arbitrary-issue batching before Phase A lands. Until then, use explicit issue sets and `conservative`/`none` behavior; do not claim that the pre-Phase-A pipeline can already contract the full portfolio.

---

## 5. Exact file matrix

| Area | Files | Required change |
| --- | --- | --- |
| Green gate | `src/workflows/work-on/build.test.ts`, `docs/next/IMPLEMENTATION.md` | Fix compute assertion; refresh recorded baseline |
| Assembly | `src/workflows/orchestrate/assemble.ts`, `assemble.test.ts`, `batching.ts`, batching tests | Pure policy/classification/clustering/member contracts |
| Materialization | `src/workflows/orchestrate/materialize.ts`, materialization tests, `src/tui/forgedock-tools.ts`, `src/cli/main.ts` | Authoritative revalidation, confirmation boundary, idempotent batch issue creation |
| Scheduling | `src/workflows/orchestrate/scheduler.ts`, scheduler tests | Member metadata, typed results, suspension/events as required by C/E |
| Scope | `src/runtime/agent-runtime.ts`, `pi-adapter.ts`, `sandboxed-tools.ts`, sandbox tests | ScopeManifest enforcement and recovery preservation |
| Work-on scope | `investigate.ts`, `prepare.ts`, `build.ts`, `remediate.ts`, `verify.ts`, `work-on.ts`, related tests | Pre/post packet scope threading and recursive target input |
| Remediation | `src/workflows/orchestrate/remediation.ts`, remediation tests, `machine.ts`, `work-on.ts`, `review.ts`, `verify.ts`, `publish.ts`, `complete.ts` | Durable supervisor, `RESUME_EXPANDED_REVIEW`, child parent-branch delivery, fresh parent proof |
| Artifacts | `src/core/artifacts/schema.ts`, `codec.ts`, repositories/tests, `src/core/state/reconcile.ts` | Add/validate `RemediationBlocked` checkpoints and reconstruction |
| Authority ports | `src/core/ports/forge-host.ts`, `src/adapters/github/github-client.ts`, adapter tests | Canonical subject filtering, idempotent finding/child materialization, and issue trajectory comments |
| Branch targeting | `src/workflows/work-on/lane.ts`, lane tests, publish/merge tests | Trusted parent-remediation delivery target and branch claims |
| Audit | `src/workflows/work-on/trajectory.ts` (if extracted), `complete.ts`, trajectory/parser tests, `scripts/conformance-check.mjs` if needed | `FORGE:TRAJECTORY` receipts and idempotent member publication |
| Observability | `src/workflows/orchestrate/events.ts`, `view-model.ts`, their tests, `scheduler.ts`, `src/tui/forgedock-tools.ts`, `src/tui/forgedock-extension.ts`, `src/cli/main.ts`, background/status tests | Board, Review Desk, timeline, restartable snapshots |
| Performance/usage | `src/runtime/agent-runtime.ts`, `src/runtime/pi-adapter.ts`, `src/cli/verification-policy.ts`, `src/adapters/process/process-verifier.ts`, telemetry/status/benchmark tests | Phase timing, token/cost receipts, preflight, verification deduplication, and latency budgets |
| Configuration | `src/core/config/forgedock-config.ts`, config tests, `forge.yaml`, TUI/CLI prompt/tool tests | Policy schema, precedence, flags, managed-block rendering |
| Legacy | `commands/**`, `bin/**`, hooks | Do not edit for this plan |

The matrix intentionally includes `src/tui/forgedock-tools.ts` and `src/cli/main.ts`; `forgedock-extension.ts` alone is not the orchestration integration point.

---

## 6. Risks, failure handling, and non-goals

### Batching risks

- **Conflicting ordinary issues**: require same lane, urgency tier, risk, and compatible key; revalidate authoritative issue bodies; validate the contracted graph before mutation; keep `none` and `conservative` escapes.
- **Non-convex dependencies**: reject the group before issue creation rather than guessing.
- **Duplicate batch issues**: preserve the deterministic batch marker and verify existing members before reuse.
- **Ambiguous issue scope**: keep as singleton and return a typed investigation/decomposition outcome; never widen repository reads silently.

### Scope risks

- **Required config outside affected files**: declare bounded metadata/context roots in the ScopeManifest and test them; do not restore unrestricted root access as a convenience.
- **Symlink/glob bypass**: apply realpath checks to every tool operation, not only `read`.
- **Recovery widening**: persist and validate the same manifest on resume.

### Recursive remediation risks

- **Looping or explosion**: deterministic finding identity, max cycles/depth/children, one active child per parent branch claim, and durable checkpoint reconstruction.
- **Parent branch drift**: re-read branch/PR SHA before every child merge and parent resume; stale ancestry becomes a human block.
- **Child fixes not reaching parent**: child PR base must be the parent delivery branch; default/milestone branch targeting is rejected.
- **New findings outside the granted location**: remain out-of-packet and follow the configured policy; recursive mode does not grant blanket scope.
- **Partial child completion**: parent remains suspended/blocked; completed children are retained and only missing children resume after restart.
- **Budget exhaustion without independently actionable findings**: human block, not automatic decomposition.

### Audit risks

- **Issue-body pollution or protocol drift**: use append-only `FORGE:TRAJECTORY` comments and update the conformance parser/test only as needed.
- **Receipt publication failure**: do not close/project a member as complete until the idempotent receipt write succeeds; preserve a recoverable completion checkpoint.
- **Oversized comments**: bound evidence, findings, session references, and acceptance text; store full artifacts through the existing artifact channel.

### Explicit non-goals

- No legacy Markdown prompt optimization.
- No TUI-owned merge, issue creation, state transition, or authority.
- No GitHub-backed cross-machine lease implementation; the retained-checkpoint witness seam is now implemented, while a distributed witness remains a separate future adapter.
- Lease recovery is fail-closed: token-only local state is insufficient, and explicit authenticated higher-epoch re-enrollment is required after rollback or checkpoint loss.
- No evidence/memory graph implementation; Phase D emits provenance for that future consumer.
- No universal guarantee that any arbitrary 30-issue set contracts to seven units; only the documented fixture has that acceptance target.

---

## 7. Verification model and definition of done

### Per-phase gate

Every phase must pass:

```bash
npm run build
npm run test:next
npm run docs:build
```

Run `npm run test:legacy` when shared adapters, ports, configuration, or legacy-facing package behavior are touched. Phase G additionally requires the disposable benchmark and usage/timing receipt checks. Run focused tests after each change, then the full suite before merging.

### Required scenario tests

1. **Green gate**: builder grants include `compute`; reviewers remain read-only.
2. **Assembly**: deterministic 30-issue fixture, all three batching policies, safety exclusions, dependency remapping, dry-run/no-write, idempotent materialization.
3. **Scope**: pre-packet hints, post-packet writes, symlink/glob/path traversal, missing scope, recovery preservation.
4. **Recursive remediation**: blocked parent, deterministic child issue reuse, child PRs targeting parent branch, child merge changing parent SHA, parent re-verification, fresh review, successful parent merge, restart/cancellation/failure/cap paths.
5. **Audit**: one protocol-compliant trajectory comment per member, exact receipt fields, deduplication, publication failure recovery.
6. **Observability**: live snapshots, suspended vs blocked states, Review Desk action routing, restart reconstruction, no authority in TUI.
7. **Configuration**: CLI/TUI parity, precedence, round-trip rendering, invalid input rejection, prompt policy propagation.

### End-to-end gate

In a disposable test repository with a fake or controlled ForgeHost:

- run the documented 30-issue assembly fixture;
- confirm the proposed graph and materialize its batch issue(s);
- execute one batch through build, verification, review, merge, and member closure;
- assert trajectory comments on every member;
- inject an out-of-packet finding in recursive mode;
- assert child PR base is the parent delivery branch, parent head advances, and parent receives a new verified/reviewed SHA;
- restart the supervisor between child dispatch and child completion;
- assert no duplicate child issues/workers and correct final projection.

### Definition of done

The plan is complete only when:

- Phase 0 is green and `IMPLEMENTATION.md` is synchronized;
- TUI and CLI share the same assembly, policy, remediation, and view-model contracts;
- default `aggressive` batching is bounded by the explicit safety rules;
- default `scope-locked` behavior has regression coverage;
- recursive mode is durable, branch-correct, bounded, and fresh-review gated;
- every batch member has a protocol-compliant trajectory receipt;
- status/Review Desk views are projections, never authorities;
- every controller phase reports active/queued/human-held timing and every agent reports usage or an explicit unavailable marker;
- the clean and one-remediation latency budgets meet the legacy benchmark;
- build, Next tests, required legacy tests, conformance, and end-to-end scenarios pass.

---

## 8. Issue portfolio alignment and dogfood

The portfolio is supporting evidence and execution input, not a second specification. Before filing each phase issue, revalidate its current title, labels, dependencies, and open/closed state with GitHub. If an issue has already landed, retain its acceptance requirement here and do not duplicate the implementation.

| Portfolio area | Plan relationship |
| --- | --- |
| Orchestration Board/timeline/Review Desk/projection issues (#46–#51) | Phase E consumes durable artifacts, scheduler events, and leases; it does not move authority into the UI. |
| Review plan, finding anchors, remediation/provenance, merge-admission issues (#38–#42) | Phase C consumes their settled finding identity and merge contracts; unresolved schema conflicts must be resolved before recursive mode is enabled. |
| Scoped context and proof-report issues (#31, #50) | Phase B supplies bounded runtime context; Phase D supplies receipts/proof inputs. |
| Memory/evidence graph issues (#26–#30) | Phase D emits protocol-compliant provenance; the graph is not implemented here. |
| Canonical subjects, signing, event stream, bundles, leases (#7–#15) | Consume their ports and envelopes. Do not redesign their authority layer in this plan. |

Dogfood sequence:

1. Phase 0 is landed directly as the green-gate prerequisite.
2. Phase A is filed as a shared-core orchestration issue and executed through the existing pipeline using an explicit issue set; it must not assume arbitrary batching before it lands.
3. After Phase A, the portfolio can use default aggressive batching while retaining explicit conservative/none controls for diagnosis.
4. Phase B can be paired with the scoped-context portfolio work.
5. Phase C is gated on the settled finding/merge contracts and is not enabled merely because its issue was merged.
6. Phase D–F are then dogfooded through the newly shared orchestration path.

This sequencing avoids the original circular claim that the old pipeline can already execute the batching behavior that Phase A is meant to introduce.

---

## 9. Final operator checklist

Before merging any phase PR, the operator/reviewer must be able to answer “yes” to all of the following:

- Does the change use the shared TUI/CLI domain service rather than add a second path?
- Are all GitHub/git mutations behind a typed port?
- Are dry-run, confirmation, idempotency, and restart behavior tested?
- Does the change preserve the typed state machine and exact-SHA merge gate?
- Is scope explicit at the correct lifecycle stage and still enforced on recovery?
- If recursive, does the child PR target the parent branch and does the parent receive a fresh verification/review?
- Is every new artifact/comment schema registered, parsed, and conformance-tested?
- Does the TUI remain a projection/request surface rather than an authority?
- Are current test counts and `docs/next/IMPLEMENTATION.md` synchronized?
- Does the phase record token/cost usage, active versus human-held time, and the measured latency budget?

If any answer is “no”, the work is not execution-ready and the phase issue must be split or amended before implementation.
