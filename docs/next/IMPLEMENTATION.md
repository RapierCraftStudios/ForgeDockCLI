# ForgeDock Next implementation status

**Updated:** 2026-08-18
**Runtime status:** implemented behavior described below
**Dogfood status:** certification pending; no readiness claim

This tracker summarizes the executable ForgeDock Next core described in
[`../forgedock-next.html`](../forgedock-next.html). The source and tests are
authoritative when prose and code differ. Passing local regression tests proves an
implementation boundary, not live dogfood readiness; the certification ledger is
[`DOGFOODING-IMPLEMENTATION.md`](DOGFOODING-IMPLEMENTATION.md).

## Authority rules

- Typed ForgeDock code owns workflow transitions, side effects, verification,
  review policy, merge admission, and completion.
- Agents receive bounded role tools and submit typed proposals; they do not receive
  workflow or GitHub mutation authority.
- GitHub artifacts plus freshly read repository, PR, check, and issue state are
  durable semantic truth. SQLite, leases, task records, sessions, and TUI views are
  operational state.
- [`VERIFIABLE-WORKFLOW-AUTHORITY.md`](VERIFIABLE-WORKFLOW-AUTHORITY.md) remains the
  normative source for protected evidence, identity, capabilities, events, leases,
  bundles, compatibility, and tamper-evidence limits. The current v2 artifacts are
  legacy-unverified and do not become protected evidence through documentation.
- RelationGraph checkpoints currently run in shadow mode: they are persisted and
  certified for diagnostics, but graph drift does not block delivery unless
  `FORGEDOCK_STRICT_RELATION_CHECKPOINT=1`. Proven packet scope, command identities,
  evidence contracts, content digests, and exact-SHA review/merge remain blocking.
- No phase or release is called ready until its required tests and live
  certification evidence pass at one immutable candidate SHA.

## Implemented workflow core

### `work-on`

- [x] Typed investigation outcomes (`confirmed`, `invalid`, `decompose`) and durable
  Intent, Investigation, Build Packet, Build Result, Review Verdict, and Outcome
  artifacts.
- [x] Frozen Build Packet scope, stable criterion IDs, exact write authority,
  bounded discovery reads, isolated worktrees, and controller-observed changed-path
  validation.
- [x] Packet-scoped `forgedock.verification/v2` discovery from the refreshed exact
  base: `diff-check`, at most one safe direct TypeScript integrity gate, and targeted
  direct Node tests selected by typed packet requirements. No automatic lint, docs,
  broad npm lifecycle, or nested-coverage inheritance.
- [x] Required hosted CI treated as live external authority. Auto-merge requires
  `github-required` provenance, a nonempty required-check set, passing observations
  at the exact reviewed SHA, and mergeability; pending/unknown is polled and missing,
  stale, failed, cancelled, contradictory, conflicting, or unavailable authority
  fails closed.
- [x] At most two fresh bounded builder repair sessions. Within one live process the
  repair receives the prior submission/session reference and exact failed-check
  Outcome; after restart only durable Outcome continuity is reconstructed. Repairs
  remain in frozen packet scope and return to independent verification.
- [x] Criterion coverage anchored to frozen paths, symbols, tests/invariants, and
  required command IDs with passing controller-observed results. A generic green
  command cannot stand in for semantic criterion evidence. Security-sensitive
  packets receive controller-derived invariant-matrix row IDs, bounded to 128
  expanded cases; builders must exercise/anchor them, but the controller does not
  generate repository tests or prove named symbols/test IDs exist.
- [x] Exact-SHA publication, review, merge, closure, and recovery freshness checks,
  including authoritative issue re-read before a merged Outcome is final.
- [x] Durable verification receipt reuse is limited to passed, fully bound controller commands. SQLite stores the rebuildable cache; exact command/args, packet targets, policy/catalog, base/revision, lockfiles, toolchain, environment, and content identities are required, with hit/miss/reject/store progress and post-hit pristine checks.

### `review-pr`

- [x] Frozen exact-SHA Review Plans with bounded capability groups, parallel/session/
  attempt/model-call budgets, fresh independent sessions, and fail-closed partial
  failure behavior.
- [x] Durable exact-head `FindingRootLedger` artifacts with monotonic epochs,
  structural root IDs, aliases/owners, and explicit `open`, `fix-attempted`, `fixed`,
  `regressed`, `follow-up`, or `rejected` state. Projection plans and receipts use
  root identity and resume canonical GitHub publication idempotently.
- [x] Schema-v4 initial and closure Review Plans. Closure review proves exact
  prior-to-current paths/hunks, retains open-root owners, and requires correctness
  plus every owner role to assess each prior open/fix-attempted/regressed root;
  omission becomes `fix-attempted`, not closure.
- [x] Controller policy derives `mustFix` separately from final `blocking`. A
  qualifying medium root can remain nonblocking but still force `request_changes`;
  reviewer booleans are not authority.
- [x] Bounded remediation selects every accepted `mustFix` root (legacy fallback:
  `blocking`) and refuses to silently omit roots when cluster bounds are exceeded.
  Approval requires re-verification, a new pushed SHA, and fresh closure review with
  no unresolved `mustFix ?? blocking` root.
- [x] Exact-head required CI and mergeability are refreshed immediately before
  verdict publication and merge admission. Pending, stale, contradictory, failed,
  cancelled, or unavailable authority blocks.

### `orchestrate`

- [x] One durable controller shared by CLI and TUI for DAG creation, execution,
  attempts, persistence, reconciliation, status, and explicit resume.
- [x] Natural-language selection projected into typed discovery evidence; controller
  validation freezes repository/query membership, open state, routes, priorities,
  semantic dependencies, decomposition replacements, and predicted claims before
  mutation.
- [x] Default one selected issue per visible DAG node and top-level `work-on` slot.
  `maxParallel` (validated 1–20) is an issue-slot budget; a contracted node consumes
  one slot per unique member, while lower transport availability reduces dispatch.
  An indivisible oversized batch may run alone to avoid deadlock.
- [x] Streaming ready-set scheduling without static topological execution waves.
- [x] Separate semantic dependencies and conflict claims. Dependencies require an
  authoritative successful predecessor Outcome. Claims are same-repository,
  same-target release-only serialization constraints and release at any terminal
  predecessor state.
- [x] Dynamic claim refinement from frozen Build Packet paths, queued-node conflict
  reevaluation, and exact target refresh before a previously claim-deferred node is
  dispatched.
- [x] Explicit batching policies with batching disabled by default. Opt-in assembly
  supports typed-compatible eligible ordinary issues and review findings. Sensitive
  security/auth batching requires exactly two members with matching causal-family
  evidence and secondary proof, and assembly hard-caps it at two even though the
  current managed-config default remains three. Incompatible work stays singleton;
  P2/P3 labels alone are not the batching contract.
- [x] Pure assembly, mutation-free preview, confirmation, authoritative issue
  revalidation, idempotent materialization, dependency contraction, member Outcome
  projection, and member closure.
- [x] Truthful scheduler snapshots and board rows for selected and runnable-now issue
  demand, requested/sampled-transport/effective caps, running-node status, nested
  activity, semantic-dependency waits, claim waits, controller capacity,
  suspension, blocked, awaiting-human, and terminal states. Runnable demand is not
  presented as occupied.
- [x] Observation-backed semantic activity for idle accounting. Generic output does
  not independently prove progress; accepted controller/tool/reviewer observations
  keep genuinely active work from being cancelled as idle.
- [x] Durable parent DAG/node records, live-owner reconciliation, completed-node
  preservation, retained-worktree recovery, and explicit failed/blocked-node resume.
- [x] Fresh native CLI and TUI DAGs use a shared investigation-first controller
  phase: independent read-only investigations run under the issue-slot and sampled
  transport caps, persist exact-base evidence, settle invalid/decomposed work at a
  durable wave barrier, then materialize the exact phase-2 execution DAG. Legacy
  records retain their prior execution semantics; restart rebuilds the phase
  materializer from durable identity.

## Configuration and UI

- [x] Marker-bounded `next` configuration in `forge.yaml`, preserving unrelated
  user-authored content.
- [x] Independent planning, worker, and reviewer model/thinking selection, review CI
  policy, delivery targets, merge defaults, orchestration concurrency, scope and
  remediation bounds, and explicit batching policy.
- [x] Native status/resume tools, fleet tree, run timeline, Review Desk, and
  Orchestration Board as non-authorizing projections.
- [x] Slot and wait text derived from scheduler state rather than inferred from task
  count or generic transcript output.
- [x] Background native controllers, passive completion notices, task inspection,
  process-tree cancellation, and local detach/adoption/reconciliation.

## Implemented local safety boundary

Interactive single-checkout use bootstraps a retained Ed25519 lease witness on first
mutating dispatch. Headless/direct CLI use can run
`forgedock-next lease-witness-bootstrap` from the canonical checkout. Complete
`FORGEDOCK_LEASE_WITNESS_*` environment configuration takes precedence; partial,
mismatched, unsafe, rolled-back, or unverifiable continuity fails closed.

This is single-machine, single-checkout fencing. Cross-machine/GitHub-backed lease
coordination and cross-checkout mutual exclusion are not implemented claims.
Confirmed Deep Plan packets remain active-session state until materialization, and a
lost owning bridge can still require explicit DAG resume.

## Remaining implementation/cutover work

- [ ] GitHub-backed cross-machine lease coordination.
- [x] Controller runtime token/cost budgets are enforced in both CLI and TUI; fulfilled and failed/resumed execution usage is charged before errors escape.
- [x] Verification stdout/stderr is continuously drained with bounded redacted diagnostic tails, split-secret handling, and explicit truncation markers.
- [x] Delivery content digests use canonical containment plus no-follow descriptors and descriptor `fstat` to fail closed on symlink replacement.
- [ ] Durable cross-restart child-session attachment beyond checkpoint resume.
- [ ] Protected-artifact implementation and conformance slices defined in
  `VERIFIABLE-WORKFLOW-AUTHORITY.md`.
- [ ] Legacy artifact read migration, duplicate-engine removal, and final cutover
  hardening.

## Current verification status

The changed behavior has focused implementation tests, but this document does not
freeze a test count or claim a green candidate. For the exact candidate checkout,
run and retain:

```bash
npm run build
npm run test:next
npm run certify:orchestration
npm run docs:build
node scripts/conformance-check.mjs
```

Run any available Markdown/link checks and the focused scheduler, verification,
review, work-on, adapter, observer, TUI, and recovery tests. Then complete the
phased live certification waves in `DOGFOODING-IMPLEMENTATION.md`. Until those
waves pass against one immutable SHA, the only accurate status is **implemented,
certification pending**.
