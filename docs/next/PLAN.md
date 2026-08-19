# ForgeDock Next dogfood-readiness plan

**Updated:** 2026-08-18
**Status:** implementation synchronization and certification plan
**Next gate:** certification wave 0
**Readiness:** not claimed

The implementation and tests are authoritative for current runtime behavior. This
plan records the contract that must be documented and the evidence required before
maintainers may call the candidate dogfood-ready. It supersedes the earlier plan to
make aggressive batching the default and the older P2/P3-only batching description.

## 1. Runtime contract under certification

### 1.1 Typed selection and issue slots

Natural-language orchestration selection is discovery, not authority. It produces
typed, evidence-backed candidates. The controller validates repository and query
membership, open state, route, priority, semantic dependencies, predicted claims,
and decomposition replacements before freezing a DAG or mutating GitHub.

The default mapping is deliberately legible:

- one selected issue becomes one visible DAG node and one `work-on` pipeline;
- a running node occupies one top-level issue slot;
- `maxParallel` is the issue-slot budget (1–20), not a scheduler-node count or a
  promise that every slot can be filled;
- an explicit batch is one node/pipeline but consumes one slot per unique member;
  an indivisible batch larger than the cap may run alone to avoid deadlock;
- transport capacity and controller admission may reduce dispatch below the
  ceiling; and
- nested builder/reviewer activity does not become another top-level issue slot.

There are no topological execution waves. Ready nodes stream as their own
preconditions clear. The phased waves in §3 refer only to certification order.

### 1.2 Dependencies and claims are different relations

A **semantic dependency** means the successor requires an authoritative successful
predecessor Outcome. A blocked, failed, invalid, or otherwise unsuccessful
predecessor does not satisfy it.

A **conflict claim** is a release-only scheduling constraint. It serializes
potentially overlapping work only when both nodes use the same repository and exact
delivery target. It releases when the predecessor is terminal, regardless of
success, and must never be rendered or persisted as a semantic `Depends on`
relationship.

Discovery supplies conservative predicted path/component claims. The frozen Build
Packet refines claims while a node is live, and the scheduler applies those dynamic
claims to queued nodes. A node that waited on a claim must refresh the exact target
state after the claim clears and before dispatch; it cannot start from the stale
target it observed when first queued. Refresh requires a pristine pre-builder
workspace at its frozen base, compares the host-advertised and directly fetched
SHAs, retries target movement at most three times, fast-forwards only, then
rediscovers the verification catalog and baseline. Dirty or partially built retained
workspaces keep their frozen base rather than being silently rewritten.

### 1.3 Batching is explicit

Batching is off by default. Without a per-run or configured policy opt-in, every
selected issue remains its own node and pipeline.

An opt-in policy may contract eligible ordinary issues and review findings; it is
not defined only by P2/P3 labels. Compatibility is typed and requires compatible
repository, target, concern/scope, dependency shape, route, risk, and member
contract. Sensitive security/auth groups are deny-by-default: they require exactly
two members, the same causal family and risk partition, at least one secondary
proof (capability, primary domain, or shared symbol), bounded production paths and
atomic criteria, and never leaf-directory-only compatibility. Assembly clamps the
effective sensitive size to two even though the current managed-config default for
`max_sensitive_batch_size` remains three. Ambiguous, urgent, human-held,
incompatible, or unsafe work remains singleton.
Assembly is pure, preview is mutation-free, authoritative issue state is re-read
after confirmation, and batch materialization is idempotent.

### 1.4 Truthful observation and UI

The orchestration board and task views are projections, never workflow authority.
They must distinguish:

- selected issue demand and runnable-now demand from active/running node status; it
  must not label runnable demand as occupied;
- requested, sampled transport, and effective issue-slot caps;
- top-level nodes from nested agents and queued nodes;
- semantic-dependency, conflict-claim, controller-capacity, and transport waits;
- blocked, failed, suspended, awaiting-human, and terminal states; and
- controller-observed semantic activity from arbitrary stdout/stderr traffic.

Idle protection advances only from accepted semantic observations. Output noise
cannot make a stalled worker healthy, while observed reasoning/tool activity cannot
be mislabeled idle merely because no phase transition has occurred.

### 1.5 Verification and repair

Local verification uses controller-owned `forgedock.verification/v2` metadata and
the exact refreshed base. The executable plan contains only always-selected
`git diff --check`, at most one safe direct TypeScript integrity command, and
packet-targeted direct `node --test` when supported; it does not inherit lint, docs,
broad npm lifecycle tests, or nested coverage from script prose. Typed requirements
must cover every stable criterion ID. Criterion anchors name frozen paths, symbols,
tests/invariants, and required command IDs, and every cited command must pass in
controller-observed changed-revision results. A generic green build is not semantic
acceptance evidence. Security-sensitive packets also receive controller-derived
invariant-matrix row identities (bounded to 128 expanded cases); builders must
exercise and anchor them, but the controller does not generate repository tests or
prove that named symbols/test IDs physically exist.

Hosted CI is separate authority. Auto-merge requires `github-required` provenance,
a nonempty required-check set, passing observations for the exact reviewed SHA, and
a mergeable route. Pending/unknown authority is polled; stale, failed, cancelled,
contradictory, conflicting, empty, or unavailable authority fails closed.

Eligible verification failures receive at most two fresh schema-safe bounded builder
sessions. Within one live controller, each receives the prior submission/session
reference and exact durable failure Outcome so it amends rather than reconstructs
the checklist. Repair cannot widen the packet, change frozen criteria, or
self-authorize success. After process restart the Outcome remains durable continuity
evidence, but the explicit prior submission/session reference is not reconstructed.

### 1.6 Review, durable roots, and remediation

`FindingRootLedger` is a durable exact-head artifact with monotonic epochs and
structural semantic roots independent of rendered Markdown or one reviewer session.
Root states are `open`, `fix-attempted`, `fixed`, `regressed`, `follow-up`, and
`rejected`. A schema-v4 closure plan proves the prior-to-current paths/hunks and
retains the specialist owners of open roots. Every prior open, fix-attempted, or
regressed root must receive explicit correctness and owner-role assessment;
omission becomes `fix-attempted`, not closure.

`mustFix` is a controller-owned remediation obligation separate from final
`blocking`. Qualifying critical/high roots normally satisfy both; a qualifying
medium root may remain nonblocking yet still force `request_changes`. Bounded
remediation selects every accepted `mustFix` root (legacy fallback: `blocking`),
refuses to silently drop roots when clustering bounds are exceeded, reruns
verification, publishes a new SHA, and receives a fresh closure review. Approval is
unavailable while any open root has `mustFix ?? blocking` or lacks resolution
evidence. Unproven newly discovered preexisting concerns become follow-up work,
not silently expanded remediation scope. Projection, publication, reconciliation,
and closure remain idempotent and resumable.

## 2. Authority and recovery invariants

- Typed ForgeDock code owns transitions, retries, verification, GitHub mutation,
  review policy, merge admission, and completion. Models propose typed outputs.
- GitHub artifacts and exact live repository/PR state are durable semantic truth.
  SQLite, TUI snapshots, leases, and sessions are operational projections.
- Every external mutation uses a typed port, an idempotency identity, and a
  freshness check appropriate to the boundary.
- Completed DAG nodes remain completed on explicit resume. Live owners are
  reconciled before relaunch; interrupted semantic checkpoints resume rather than
  replaying completed work.
- Local witnessed leases provide single-machine, single-checkout fencing only.
  Cross-machine coordination remains outside the current claim.
- No implementation or local test result is itself a dogfood-readiness claim.

## 3. Phased certification waves

Detailed checkboxes live in
[`DOGFOODING-IMPLEMENTATION.md`](DOGFOODING-IMPLEMENTATION.md).

1. **Wave 0 — deterministic gate:** exact candidate SHA, build, Next tests, the
   audited exact-file `npm run certify:orchestration` gate, docs build, conformance,
   and available Markdown/link checks.
2. **Wave 1 — scheduler invariants:** typed discovery, default slots,
   `maxParallel`, dependency versus claim semantics, dynamic claims, target refresh,
   batching opt-in, sensitive compatibility, and truthful activity/waits.
3. **Wave 2 — lifecycle faults:** packet verification, exact-SHA CI, builder repair,
   durable roots, delta review, `mustFix` remediation, and crash/resume boundaries.
4. **Wave 3 — small live DAGs:** controlled staging cases for independent,
   dependent, conflicting, cross-target, batched, repair, review, and CI outcomes.
5. **Wave 4 — repeated canary:** three to five fresh successful native staging runs
   followed by an explicit maintainer decision bound to one immutable SHA.

A failure in any wave blocks certification. A code or policy change invalidates the
affected evidence and requires the relevant wave and all dependent waves to run
again.

## 4. Required evidence and exit rule

For each wave retain command output, candidate SHA, configuration, DAG/run IDs,
issue/PR references where applicable, exact reviewed and CI SHAs, fault-injection
point, observed wait/activity state, and final authoritative Outcome. Redact secrets;
do not replace evidence with narrative summaries.

The plan exits only when all required certification items pass and a maintainer
records the decision against the same candidate SHA. Until then, use **implemented,
certification pending**—never **ready**, **certified**, or **release-ready**.
