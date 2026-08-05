# ForgeDock Next implementation status

This is the execution tracker for the greenfield rewrite described in [`../forgedock-next.html`](../forgedock-next.html). The normative contract for the Verifiable Workflow Authority & Portability milestone is [`VERIFIABLE-WORKFLOW-AUTHORITY.md`](VERIFIABLE-WORKFLOW-AUTHORITY.md); this tracker records implementation status and evidence, but does not redefine that contract.

## Rules

- The legacy engine is evidence and a temporary compatibility path, not a dependency of the new core.
- Workflow authority stays in typed ForgeDock code.
- Pi is accessed only through `src/runtime/pi-adapter.ts`.
- GitHub artifacts are durable truth; local state and Pi sessions are operational aids.
- No phase is reported complete until its acceptance tests pass.
- Private AlterLab issue content must not be copied into this repository.
- A contract slice remains pending until its named executable evidence gate passes; documentation review alone is not completion evidence.

<a id="verifiable-authority-contract"></a>
## Verifiable authority & portability contract map

The following are the subsequent implementation slices currently represented in this tracker. Stable anchors are normative in [`VERIFIABLE-WORKFLOW-AUTHORITY.md`](VERIFIABLE-WORKFLOW-AUTHORITY.md); no slice below is marked complete by this documentation change.

| Slice | Status in this tracker | Normative anchors | Evidence gate before completion |
| --- | --- | --- | --- |
| Protected envelope, canonical bytes, digest/signature, and chain verification | Pending | [`#protected-envelope`](VERIFIABLE-WORKFLOW-AUTHORITY.md#protected-envelope), [`#canonical-bytes`](VERIFIABLE-WORKFLOW-AUTHORITY.md#canonical-bytes), [`#digest-and-signature`](VERIFIABLE-WORKFLOW-AUTHORITY.md#digest-and-signature), [`#chain-rules`](VERIFIABLE-WORKFLOW-AUTHORITY.md#chain-rules) | Golden canonical-byte vectors plus malformed, signature, predecessor, and chain-gap tests; build and focused test output. |
| Idempotent publication reconciliation after a crash between push and state commit | Pending (see slice 2 below) | [`#authority-boundary`](VERIFIABLE-WORKFLOW-AUTHORITY.md#authority-boundary), [`#capability-discovery`](VERIFIABLE-WORKFLOW-AUTHORITY.md#capability-discovery), [`#workflow-events`](VERIFIABLE-WORKFLOW-AUTHORITY.md#workflow-events) | Crash/restart tests prove envelope-ID idempotency, durable decision reconciliation, exact-SHA recheck, and no duplicated host side effect. |
| Controller identity, key lifecycle, and historical verification | Pending | [`#controller-identity`](VERIFIABLE-WORKFLOW-AUTHORITY.md#controller-identity), [`#identity-rotation-loss`](VERIFIABLE-WORKFLOW-AUTHORITY.md#identity-rotation-loss) | Custody, dual-sign transition, loss, revocation, historical verification, and secret-exclusion tests. |
| Delegation, attenuation, and one-shot replay | Pending | [`#delegation`](VERIFIABLE-WORKFLOW-AUTHORITY.md#delegation) | Closed-vocabulary/default-deny, binding, expiry, depth, attenuation, nonce-CAS, replay, and restart tests. |
| Canonical subjects, host capabilities, adapter conformance, and operation gates | Pending | [`#subject-capabilities`](VERIFIABLE-WORKFLOW-AUTHORITY.md#subject-capabilities), [`#canonical-subject`](VERIFIABLE-WORKFLOW-AUTHORITY.md#canonical-subject), [`#capability-discovery`](VERIFIABLE-WORKFLOW-AUTHORITY.md#capability-discovery) | Subject vectors and conformance tests for publish, review, merge, CAS, and unsupported-host denial. |
| Workflow event bus and stable view model (including run timeline, review desk, and orchestration board) | Pending (see slice 5 below) | [`#workflow-events`](VERIFIABLE-WORKFLOW-AUTHORITY.md#workflow-events), [`#event-envelope`](VERIFIABLE-WORKFLOW-AUTHORITY.md#event-envelope), [`#verification-states`](VERIFIABLE-WORKFLOW-AUTHORITY.md#verification-states) | Per-run ordering/correlation, commit-before-event, duplicate, unknown-version, verification-state rendering, and non-authority consumer tests. |
| Cross-machine/GitHub-backed lease coordination | Pending (see slice 4 below) | [`#leases`](VERIFIABLE-WORKFLOW-AUTHORITY.md#leases), [`#lease-protocol`](VERIFIABLE-WORKFLOW-AUTHORITY.md#lease-protocol) | CAS race, heartbeat, expiry, stale takeover, fencing sequence, split-brain, restart, and unsupported-host tests. |
| Portable bundle export/import and offline verification | Pending | [`#portable-bundles`](VERIFIABLE-WORKFLOW-AUTHORITY.md#portable-bundles), [`#bundle-format`](VERIFIABLE-WORKFLOW-AUTHORITY.md#bundle-format), [`#offline-import`](VERIFIABLE-WORKFLOW-AUTHORITY.md#offline-import) | Deterministic bytes, size limits, secret exclusion, offline limitations, revalidation, and archival-only import tests. |
| Restart/reconciliation and merge-sequencing integration tests | Pending (see slice 4 below) | [`#authority-boundary`](VERIFIABLE-WORKFLOW-AUTHORITY.md#authority-boundary), [`#capability-discovery`](VERIFIABLE-WORKFLOW-AUTHORITY.md#capability-discovery), [`#leases`](VERIFIABLE-WORKFLOW-AUTHORITY.md#leases), [`#compatibility`](VERIFIABLE-WORKFLOW-AUTHORITY.md#compatibility) | Interrupted workers, stale decisions, host head changes, fencing failures, and merge ordering are replayed from durable evidence without optimistic mutation. |
| Legacy artifact read compatibility and migration gates | Pending (see slice 6 below) | [`#compatibility`](VERIFIABLE-WORKFLOW-AUTHORITY.md#compatibility), [`#verification-states`](VERIFIABLE-WORKFLOW-AUTHORITY.md#verification-states) | Fixtures for every compatibility row and observable read/verify/gate/import outcomes, including mixed/degraded fail-closed behavior. |

The existing checked items in slices 0–5 describe the pre-contract v2/local baseline where applicable. They do not constitute evidence for the protected profile. The pending tracker items **Idempotent publication reconciliation after a crash between push and state commit**, **Cross-machine/GitHub-backed lease coordination**, **Restart/reconciliation and merge-sequencing integration tests**, **Workflow event bus and stable view model**, and **Legacy artifact read compatibility** are the concrete follow-up entries for the corresponding rows above; run timeline, review desk, orchestration board, and capability diagnostics are projections of the event/capability rows. The other rows require separately tracked follow-up issues before implementation begins.

## Vertical slices

### 0. Foundation — implemented

- [x] TypeScript build and Node `>=22.19.0` runtime floor
- [x] Six v2 artifact schemas
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
- [x] Verification command runner, output digests, and fail-closed required gates
- [x] Scope-drift check against expected paths
- [x] Branch push and PR publication with verified-SHA assertion
- [x] End-to-end six-artifact trajectory test through merge and closure
- [x] Manual merge default and explicit `--auto-merge`
- [ ] Idempotent publication reconciliation after a crash between push and state commit
- [ ] Apply configured issue closure/decomposition actions for terminal investigation outcomes
- [x] Fail-safe semantic-state reconstruction from GitHub artifacts plus local status store
- [x] Duplicate-run admission guard: terminal subjects skip and interrupted subjects block unless `--rerun` is explicit
- [x] Verification-stage resume from retained workspaces without replaying investigation or build
- [ ] Review/remediation-stage automatic resume after reconciliation

### 3. Independent `review-pr` — executable core and CLI implemented

- [x] Resolve original intent and exact PR head SHA
- [x] Detached read-only review worktree at the frozen SHA
- [x] Baseline fresh-context reviewer
- [x] Risk-based specialist router
- [x] Structured findings and deterministic blocking policy
- [x] SHA freshness invalidation before and after review
- [x] Bounded remediation, re-verification, revision push, and fresh re-review loop
- [x] Manual merge default and policy-controlled auto-merge
- [x] Live GitHub review smoke test with parallel, independently inspectable nested reviewer sessions

### 4. Lean `orchestrate` — scheduler and CLI implemented; durable coordination pending

- [x] Dependency DAG, unknown-dependency checks, and cycle diagnostics
- [x] Bounded concurrency with deterministic priority ordering
- [x] Exact path-prefix and component conflict claims
- [x] Conservative serialization when no claims are configured
- [x] Isolated `work-on` worker lifecycle
- [x] In-memory and SQLite lease ownership, heartbeat, expiry, and stale recovery semantics
- [x] Explicit issue-set CLI and dry-run plan
- [x] Natural-language issue discovery produces a typed evidence-backed DAG with priorities, dependencies, and path/component claims
- [x] Visible asynchronous workers stream the live DAG ready set without static topological phase barriers
- [x] Same-session DAG resume preserves completed nodes and retries failed/blocked nodes through durable work-on checkpoint recovery
- [x] Interrupted building runs recover their deterministic retained worktree and continue from the frozen Build Packet
- [x] Compatible P2/P3 review findings sharing a bounded concern surface contract into one durable batch issue and one work-on agent
- [x] Successful batch completion projects a typed merged Outcome to each member before closing the member issues
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
- [x] Route child `need_decision` and `interview_request` escalations to the parent supervisor, with a lazily activated pi-native decision interview for decisions that require the user
- [x] Add a checkout-safe build-and-launch script plus `/forgedock-runtime` provenance/RPC diagnostics so cached registry runtimes cannot be mistaken for local code
- [x] Add native session-scoped background controller tasks with task IDs, bounded log tails, completion notifications, `/forgedock-tasks` management, and complete process-tree cancellation
- [x] Remove fixed wall-clock lifetimes from workflow controllers and nested reviews; retain explicit cancellation, owner-disconnect cleanup, and verification-command and short transport-handshake bounds
- [x] Materialize issue-worker definitions with an absolute child-only ForgeDock extension path so strict subagent tool allowlists can actually load `forgedock_work_on`
- [x] Project typed run transitions into auto-provisioned, mutually exclusive `workflow:*` GitHub labels without making labels authoritative
- [x] Refresh explicitly configured GitHub App credentials at interactive terminal startup through a packaged cross-platform Node helper
- [x] Serialize verification, bound Node test fanout, and terminate full subprocess trees on timeout/cancellation
- [x] Keep subagent transcripts out of delivery worktrees and reject automatic remediation outside frozen Build Packet paths
- [x] Bootstrap `forge.yaml` on parent-terminal launch and preserve it through an isolated ForgeDock Next managed section with natural-language `/forgedock-config`, live-catalog model alias resolution, and all-subagent role updates
- [x] Load explicit `FORGE.md` project guidance in the terminal and bounded typed workflow agents
- [x] Provide token-bounded `devdocs/` memory retrieval with anchors, wiki links, backlinks, and an explicit reference-only authority boundary
- [x] Persist user-requested preferences and decisions through `/forgedock-remember`
- [ ] Workflow event bus and stable view model
- [ ] Run timeline
- [ ] Review desk
- [ ] Orchestration board
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
- New core and terminal integration tests cover typed configuration, streaming DAG scheduling, P2/P3 work-unit contraction and member closure, prerequisite admission, FORGE.md preferences, token-bounded devdocs retrieval, links/backlinks, native background controller completion/cancellation, and the previously listed workflow/runtime boundaries, including runtime provenance/RPC diagnostics, lazy semantic-tool dispatch, least-authority issue-child tooling, visible nested reviewer delegation, supervisor escalation activation, tabbed decision-interview rendering, controller streaming, resumable verification, deterministic review thresholds, a complete synthetic `work-on` trajectory across all six artifacts, GitHub reconciliation, dual issue/PR projection, workspace-escape tests, and the branded Pi fork launcher.
- Pi adapter module import: passing.
- Live Pi structured-output smoke test: passing both before and after replacing Pi's filesystem tools with ForgeDock's sandboxed operations; the model received only `read`, read `package.json`, called the terminating `submit_artifact` tool, and returned the expected package name/version.
- Fork source build, focused ForgeDock brand test, terminal version/help launch, CLI status, degraded branding, and package-content smoke tests: passing.
- Legacy suite: 1,807 passing, 0 failing, 7 intentionally skipped. Two Windows-only baseline defects were fixed: file-URL conversion for the invariant test module and path-semantic ownership checks for orphaned command symlinks.

## Resolved environment and dependency blockers

1. **Node runtime:** the machine-wide Node installation was upgraded to `22.23.2` and verified through Winget. A checksum-verified user-scoped `22.23.2` fallback also remains installed, and `bin/forgedock-next.mjs` can re-execute itself with a compatible configured/user-scoped/Pi runtime if launched by an older Node executable.
2. **Pi ownership and transitive vulnerability:** ForgeDock now maintains the source fork at `RapierCraftStudios/pi` and pins it under `vendor/pi` rather than carrying an opaque compiled copy. The distributed coding-agent dependency resolves fixed `brace-expansion@5.0.9`; ForgeDock development and production audits report zero vulnerabilities. Fork provenance, MIT licensing, upstream synchronization, and the controller/kernel boundary are documented in `vendor/pi/FORGEDOCK.md`.
3. **GitHub authentication:** interactive startup refreshes `rapiercraft-forgedock[bot]` through the packaged Node helper when `FORGEDOCK_APP_PEM` is configured. This avoids Windows Bash path conversion failures and restores expired installation credentials before workers launch.
4. **Live lifecycle probes:** issue #4 completed the six-artifact path through parallel nested review, PR #18 merge, issue closure, and successful-workspace cleanup. Issue #16/PR #17 removed the Windows-only legacy verification blockers discovered by the probe.
