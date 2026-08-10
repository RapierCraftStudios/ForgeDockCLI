# ForgeDock Next implementation status

This is the execution tracker for the greenfield rewrite described in [`../forgedock-next.html`](../forgedock-next.html).

## Rules

- The legacy engine is evidence and a temporary compatibility path, not a dependency of the new core.
- Workflow authority stays in typed ForgeDock code.
- Pi is accessed only through `src/runtime/pi-adapter.ts`.
- GitHub artifacts are durable truth; local state and Pi sessions are operational aids.
- No phase is reported complete until its acceptance tests pass.
- Private AlterLab issue content must not be copied into this repository.

## Vertical slices

### 0. Foundation — implemented

- [x] TypeScript build and Node `>=22.19.0` runtime floor
- [x] Seven v2 artifact schemas, including durable recursive-remediation checkpoints
- [x] Human Markdown plus Base64url machine marker codec
- [x] Typed `work-on` state machine with guarded transitions
- [x] Optimistic run repository contract with in-memory and SQLite implementations
- [x] SQLite compare-and-swap transitions and rebuildable artifact cache
- [x] Provider-neutral `AgentRuntime` contract
- [x] Deterministic fake runtime
- [x] Pi 0.83 SDK adapter with terminating structured-output tool
- [x] Role-based tool grants and read-only investigator boundary
- [x] Worktree-confined read/search/edit/write operations with lexical and symlink escape rejection
- [x] Unrestricted agent shell access disabled
- [x] GitHub issue/comment adapter
- [x] Cinematic Installer Chrome & Ember palette and F marks moved into an independent new UI module
- [x] Branded `forgedock-next` development entry point

### 1. Investigation barrier — implemented and validated on live GitHub probes

- [x] Resolve an issue through `gh`
- [x] Create durable Intent
- [x] Run an isolated investigator through `AgentRuntime`
- [x] Validate `confirmed`, `invalid`, and `decompose` semantics
- [x] Emit Investigation and terminal Outcome artifacts
- [x] Commit deterministic transitions and failures
- [x] Dry-run support
- [x] Live read-only Pi adapter smoke test on Node `22.23.2` using the configured `openai-codex/gpt-5.6-sol` model
- [x] Live combined investigation/GitHub smoke test through isolated repository issues

Development invocation after upgrading Node:

```bash
npm run build
node bin/forgedock-next.mjs work-on 123 \
  --through investigate \
  --repo owner/repo \
  --provider openai-codex \
  --model gpt-5.6-sol \
  --dry-run
```

Remove `--dry-run` only in a designated test repository; it publishes Intent and Investigation comments.

### 2. Complete `work-on` — executable core and CLI implemented

- [x] Build Packet author policy and durable artifact
- [x] Git worktree adapter and branch ownership
- [x] Builder session with workspace-only mutation rights and no shell/GitHub grant
- [x] Credential-isolated verification runner with normalized/redacted output digests; every frozen required command executes independently with fail-closed evidence
- [x] Scope-drift check against expected paths
- [x] Hook-disabled branch push and PR publication with verified-SHA, raw committed-blob, and asserted Git-tree checks; repository clean filters are rejected
- [x] End-to-end six-artifact trajectory test through merge and closure
- [x] Auto-merge default after successful verification and independent approval, with explicit `--no-auto-merge` opt-out
- [ ] Idempotent publication reconciliation after a crash between push and state commit
- [ ] Apply configured issue closure/decomposition actions for terminal investigation outcomes
- [x] Fail-safe semantic-state reconstruction from GitHub artifacts plus local status store
- [x] Duplicate-run admission guard: terminal subjects skip and interrupted subjects block unless `--rerun` is explicit
- [x] Verification-stage resume from retained workspaces without replaying investigation or build
- [x] Review/remediation/publication/completion checkpoint recovery from durable artifacts without replaying completed semantic phases
- [x] Frozen verification-plan coverage: every controller-approved diff/package command executes and contributes evidence instead of stopping after the first failure or claiming unobserved success
- [x] Same-invocation verification recovery: in-packet build and post-review remediation failures receive at most two evidence-backed builder repairs, with durable crash-resume budgets and no scope widening
- [x] Truthful Build Results require controller-observed changed paths to match the worker report and explicit coverage for every frozen acceptance criterion
- [x] Frozen Build Packet scope replaces issue-hint authority durably, grants only bounded discovery reads plus exact writes, and is rebuilt deterministically on resume
- [x] Terminal merged Outcomes remain unpublished until idempotent trajectory projection and authoritative re-read proof that every parent/member issue is closed

### 3. Independent `review-pr` — executable core and CLI implemented

- [x] Resolve original intent and exact PR head SHA
- [x] Detached read-only review worktree at the frozen SHA
- [x] Baseline fresh-context reviewer
- [x] Typed, scored Review Plan using changed-path, added-diff, Build Packet, and explicit repository-policy evidence with selected/skipped rationale
- [x] Soft specialist budget with concrete-surface override, bounded reviewer slices, and one finding-triggered adaptive escalation wave
- [x] Structured findings, deterministic blocking policy, semantic cross-reviewer consolidation, and source/session lineage
- [x] Build-Packet semantic scope adjudication and post-remediation continuity gating prevent newly discovered adjacent concerns from expanding the active delivery
- [x] Full head SHA, head branch, base branch, and PR-state freshness invalidation before, during, and immediately before verdict publication; standalone review preserves explicit delivery-run lineage
- [x] Bounded remediation, re-verification, revision push, and fresh re-review loop; remediated Build Results validate rename-complete delivery paths and stable content against frozen scope, an immutable base SHA, and the asserted committed tree across recovery
- [x] Policy-controlled auto-merge default with explicit per-run or project-level opt-out
- [x] Live GitHub review smoke test with parallel, independently inspectable nested reviewer sessions
- [x] Per-reviewer provisional PR comments and a controller-authoritative consolidated Review Verdict; create follow-up issues only for unresolved blockers or independently corroborated high-risk follow-ups, and close stale projections after a superseding verdict
- [x] Preserve schema-valid output across trailing transport failure and resume one genuinely incomplete persisted reviewer session before fresh replacement

### 4. Lean `orchestrate` — scheduler and CLI implemented; durable coordination pending

- [x] Dependency DAG, unknown-dependency checks, and cycle diagnostics
- [x] Bounded concurrency with deterministic priority ordering
- [x] Exact path-prefix and component conflict claims
- [x] Conservative serialization when no claims are configured
- [x] Isolated `work-on` worker lifecycle
- [x] In-memory and SQLite lease ownership, heartbeat, expiry, and stale recovery semantics
- [x] Explicit issue-set CLI and dry-run plan
- [x] Natural-language issue discovery produces a typed evidence-backed DAG with priorities, dependencies, and path/component claims
- [x] Every native `/orchestrate` invocation performs model intent routing first; deterministic controller validation then freezes repository, URL/query membership, count, open-state, milestone, and decomposed-parent constraints before mutation
- [x] Visible asynchronous workers stream the live DAG ready set without static topological phase barriers
- [x] Same-session DAG resume preserves completed nodes and retries failed/blocked nodes through durable work-on checkpoint recovery; explicit fresh-rerun authorization is carried to selected failed nodes without repeating unsupported resume mode
- [x] Interrupted building runs recover their deterministic retained worktree and continue from the frozen Build Packet
- [x] Shared pure work-unit assembly with aggressive, conservative, and none policies, filters, deterministic clustering, and dependency contraction
- [x] Authoritative batch revalidation/materialization through ForgeHost with deterministic idempotency markers
- [x] Compatible ordinary and P2/P3 review findings sharing a bounded concern surface contract into one durable batch issue and one work-on agent
- [x] Strict machine-readable member contracts are parsed before batch execution
- [x] Successful batch completion projects a typed merged Outcome and protocol trajectory receipt to each member before closing the member issues
- [x] Durable recursive-remediation checkpoints, checkpoint-authorized nested child targeting with frozen depth/child limits, synchronized parent-SHA and child-commit ancestry verification, actual expanded-path proof, and exact expanded-review transition without replaying superseded checkpoints
- [x] Explicit ScopeManifest enforcement across investigator, builder, remediator, and reviewer runtime tool grants
- [x] Scheduler suspension statuses, typed event sinks, orchestration snapshots, and restartable remediation projections
- [x] Downstream typed work-on admission verifies prerequisite issues have an authoritative completed outcome
- [x] Durable same-checkout cross-process leases and heartbeats
- [ ] Cross-machine/GitHub-backed lease coordination
- [ ] Promote Build Packet paths into live scheduler claims
- [ ] Token/cost budgets in addition to worker concurrency
- [ ] Restart/reconciliation and merge-sequencing integration tests

### 5. ForgeDock terminal (Pi fork)

- [x] Fork Pi at `RapierCraftStudios/pi` and pin it as the `vendor/pi` submodule
- [x] Preserve the upstream remote and document the fork/update boundary
- [x] Apply ForgeDock identity, Chrome & Ember startup styling, config namespace, and terminal title in source
- [x] Add receipt-backed first-run onboarding with welcome/privacy, provider authentication, explicit model selection, and a completion card
- [x] Replace Pi's product-facing assistant identity in the default system prompt while retaining Pi only as an internal kernel attribution
- [x] Launch the fork from the primary `forgedock` package entry point
- [x] Inject controller-backed `/work-on`, `/review-pr`, `/orchestrate`, and `/forgedock-status` commands
- [x] Expose one semantic native tool per command, activate only the invoked workflow schema, and let the selected model resolve natural-language intent without runtime Markdown loading
- [x] Bundle pinned `pi-subagents`, launch visible parallel issue workers, and preserve the typed controller as the only mutation authority
- [x] Surface nested reviewer grandchildren as selectable fleet-tree rows and summarize them as `(+N agents)` on the parent status row
- [x] Resume incomplete nested reviewers through the package-owned RPC/session lease lifecycle, including child-safe issue-worker RPC registration, bounded handshake failure, structured-output recovery, and no controller polling loop
- [x] Provide native multi-image clipboard attachments with inline previews plus compact, expandable built-in and ForgeDock semantic-tool presentation without renderer dependencies or execution overrides
- [x] Route child `need_decision` and `interview_request` escalations to the parent supervisor, with a lazily activated pi-native decision interview for decisions that require the user
- [x] Add a checkout-safe build-and-launch script plus `/forgedock-runtime` provenance/RPC diagnostics so cached registry runtimes cannot be mistaken for local code
- [x] Add native session-scoped background controller tasks with task IDs, bounded log tails, completion notifications, `/forgedock-tasks` management, and complete process-tree cancellation
- [x] Remove fixed wall-clock lifetimes from workflow controllers and nested reviews; retain explicit cancellation, owner-disconnect cleanup, and verification-command and short transport-handshake bounds
- [x] Materialize issue-worker definitions with an absolute child-only ForgeDock extension path so strict subagent tool allowlists can actually load `forgedock_work_on`
- [x] Project typed run transitions into auto-provisioned, mutually exclusive `workflow:*` GitHub labels without making labels authoritative
- [x] Refresh explicitly configured GitHub App credentials at interactive terminal startup through a packaged cross-platform Node helper
- [x] Serialize verification, bound Node test fanout, terminate full subprocess trees on timeout/cancellation, isolate credential-free verification homes, and redact credential-shaped durable output
- [x] Keep subagent transcripts out of delivery worktrees and reject automatic remediation outside frozen Build Packet paths
- [x] Correlate concurrent worker tool calls by call ID and retain only bounded, single-line, credential-redacted failure summaries in live controller logs
- [x] Bootstrap `forge.yaml` on parent-terminal launch and preserve it through an isolated ForgeDock Next managed section with natural-language `/forgedock-config`, live-catalog model alias resolution, and all-subagent role updates
- [x] Load explicit `FORGE.md` project guidance in the terminal and bounded typed workflow agents
- [x] Provide token-bounded `devdocs/` memory retrieval with anchors, wiki links, backlinks, and an explicit reference-only authority boundary
- [x] Persist user-requested preferences and decisions through `/forgedock-remember`
- [x] Workflow event bus and stable orchestration view model
- [x] Run timeline projection
- [x] Review desk checkpoint projection
- [x] Orchestration board projection
- [ ] Model/provider profiles and capability diagnostics
- [x] Tabbed single/multi/preview decision interviews with explicit recommendations, custom answers, notes, review, and elaboration for supervised child escalations
- [ ] Session attach and durable cross-restart child supervision

### 6. Cutover

- [ ] Legacy artifact read compatibility
- [ ] Synthetic production-behavior regression suite
- [ ] Remove Claude/OpenCode runner and hooks
- [ ] Remove the old engine and duplicate recovery commands
- [ ] Move non-core commands to extensions/archive
- [ ] Remove the temporary `forgedock-next` alias
- [ ] Packaging, docs, and release hardening

## Current verification

- New TypeScript build: passing.
- New core and terminal integration tests cover typed configuration, streaming DAG scheduling, P2/P3 work-unit contraction and member closure, prerequisite admission, FORGE.md preferences, token-bounded devdocs retrieval, links/backlinks, native background controller completion/cancellation, and the previously listed workflow/runtime boundaries, including runtime provenance/RPC diagnostics, lazy semantic-tool dispatch, least-authority issue-child tooling, visible and resumable nested reviewer delegation, scored Review Plans, adaptive specialist escalation, semantic finding consolidation, supervisor escalation activation, tabbed decision-interview rendering, controller streaming, resumable verification, deterministic review thresholds, a complete synthetic `work-on` trajectory across all six artifacts, GitHub reconciliation, dual issue/PR projection, workspace-escape tests, and the branded Pi fork launcher.
- Pi adapter module import: passing.
- Live Pi structured-output smoke test: passing both before and after replacing Pi's filesystem tools with ForgeDock's sandboxed operations; the model received only `read`, read `package.json`, called the terminating `submit_artifact` tool, and returned the expected package name/version.
- Fork source build, focused ForgeDock brand test, terminal version/help launch, CLI status, degraded branding, and package-content smoke tests: passing.
- ForgeDock Next suite: 255 passing, 0 failing. `npm run build` and `npm run docs:build` are green. With the staging shell's `jq` path available, the legacy invocation reaches 1,813 passing, 0 failing, and 8 intentionally skipped. Two Windows-only baseline defects were fixed: file-URL conversion for the invariant test module and path-semantic ownership checks for orphaned command symlinks.
- Phase G in progress: agent receipts are persisted in SQLite and surfaced through `status --json`/trajectory comments, runtime preflight runs before semantic mutation, nested verification scripts produce covered evidence without duplicate execution, and packet/remediation writes are exact-path scoped.

## Resolved environment and dependency blockers

1. **Node runtime:** the machine-wide Node installation was upgraded to `22.23.2` and verified through Winget. A checksum-verified user-scoped `22.23.2` fallback also remains installed, and `bin/forgedock-next.mjs` can re-execute itself with a compatible configured/user-scoped/Pi runtime if launched by an older Node executable.
2. **Pi ownership and transitive vulnerability:** ForgeDock now maintains the source fork at `RapierCraftStudios/pi` and pins it under `vendor/pi` rather than carrying an opaque compiled copy. The distributed coding-agent dependency resolves fixed `brace-expansion@5.0.9`; ForgeDock development and production audits report zero vulnerabilities. Fork provenance, MIT licensing, upstream synchronization, and the controller/kernel boundary are documented in `vendor/pi/FORGEDOCK.md`.
3. **GitHub authentication:** interactive startup refreshes `rapiercraft-forgedock[bot]` through the packaged Node helper when `FORGEDOCK_APP_PEM` is configured. This avoids Windows Bash path conversion failures and restores expired installation credentials before workers launch.
4. **Live lifecycle probes:** issue #4 completed the six-artifact path through parallel nested review, PR #18 merge, issue closure, and successful-workspace cleanup. Issue #16/PR #17 removed the Windows-only legacy verification blockers discovered by the probe.
