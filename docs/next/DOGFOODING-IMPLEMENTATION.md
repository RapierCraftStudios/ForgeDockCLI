# ForgeDock CLI dogfood-readiness certification

**Updated:** 2026-08-18
**Status:** implementation present; certification open; no readiness claim

This ledger covers the current ForgeDock Next dogfood-readiness behavior. Checked
items describe implemented contracts, not live certification. Certification runs in
the ordered waves below. The word *wave* here refers only to certification order;
DAG execution itself continuously streams ready nodes and has no topological wave
barrier.

## Implemented contract

- [x] Default to one selected issue per visible DAG node and top-level `work-on`
  slot; treat `maxParallel` as a 1–20 issue-slot budget. Explicit batches consume
  one slot per member, and available transport may lower dispatch.
- [x] Keep semantic dependencies separate from release-only conflict claims.
  Dependencies require an authoritative successful predecessor Outcome. Claims
  serialize overlapping work only within the same repository and delivery target
  and release when the predecessor is terminal.
- [x] Refine predicted claims from frozen Build Packet paths, expose claim waits,
  and refresh the exact target before dispatch after a claim deferral.
- [x] Require explicit batching opt-in. Apply typed compatibility to eligible
  ordinary issues and review findings. Sensitive security/auth groups require
  exactly two members, shared causal-family evidence, and secondary proof, and are
  effectively hard-capped at two even though managed config currently defaults the
  sensitive size to three; priority labels alone do not define compatibility.
- [x] Convert natural-language selection into typed discovery evidence before the
  controller validates and freezes membership, routes, dependencies, priorities,
  and claims.
- [x] Report selected and runnable-now issue demand plus requested, sampled-
  transport, and effective caps without labeling runnable demand as active. Show
  typed semantic-dependency, claim, capacity, suspended-recovery, and decomposition
  waits. Use controller-observed semantic activity for idle decisions rather than
  treating raw log-file growth as progress.
- [x] Use the bounded packet-selected `forgedock.verification/v2` catalog and typed
  criterion anchors. Require nonempty `github-required` provenance and live passing
  hosted CI at the exact reviewed SHA for auto-merge.
- [x] Allow at most two fresh bounded builder repairs. Preserve prior submission/
  session continuity within one process and durable Outcome continuity after
  restart; prohibit repair scope expansion and generic-green criterion evidence.
- [x] Persist exact-head `FindingRootLedger` epochs and schema-v4 closure plans.
  Omission is not closure. Keep controller-owned `mustFix` separate from final
  `blocking`; either obligation can force bounded remediation, re-verification, and
  fresh closure review.

## Certification wave 0 — documentation and deterministic gate

- [x] Synchronize the operator docs with the implemented contracts above.
- [ ] Pass `npm run build` from the exact candidate checkout.
- [ ] Pass `npm run test:next` and all focused dogfood-readiness regression tests.
- [ ] Pass `npm run certify:orchestration`; retain its exact-file command audit and
  deterministic diagnostics. Use `npm run certify:orchestration:dry-run` to review
  the mutation-free plan first.
- [ ] Pass `npm run docs:build`, conformance checks, and available Markdown/link
  checks.
- [ ] Record the exact candidate commit and retain the complete command receipts.

## Certification wave 1 — focused invariant probes

- [ ] Prove default one-node/one-slot behavior and `maxParallel` enforcement under
  lower transport capacity.
- [ ] Prove semantic dependency success admission separately from terminal claim
  release, including cross-repository and cross-target non-conflicts.
- [ ] Prove dynamic Build Packet claim refinement, truthful wait projection, and
  exact-target refresh after a deferred claim clears.
- [ ] Prove batching is absent by default and that explicit batching accepts only
  typed-compatible members, including sensitive compatibility and size limits.
- [ ] Prove observation-backed activity prevents false idle cancellation without
  allowing output noise to keep a stalled controller alive.

## Certification wave 2 — controlled lifecycle and fault injection

- [ ] Prove packet-scoped local verification, criterion-evidence binding, retained
  builder repair, and scope refusal on a failing fixture.
- [ ] Prove required CI is re-read live for the exact SHA and that stale, pending,
  failed, contradictory, or unavailable observations block.
- [ ] Prove durable finding-root continuity, delta classification, `mustFix`
  remediation, fresh exact-SHA review, and crash/resume at each durable boundary.
- [ ] Prove no duplicate issue, worker, PR, finding root, publication, or closure
  across interruption and resume.

## Certification wave 3 — small live staging DAGs

- [ ] Use fresh, controlled staging issues rather than a noisy backlog.
- [ ] Run independent, semantic-dependency, same-target claim-conflict, and
  non-conflicting cross-target cases with batching disabled.
- [ ] Repeat with explicit compatible batching, including a sensitive rejection.
- [ ] Exercise no-finding, advisory-only, nonblocking-`mustFix`, blocking,
  builder-repair, pending-CI, failed-CI, and successful completion paths.
- [ ] Verify the board, task output, GitHub artifacts, exact SHAs, merges, issue
  closures, and cleanup against live authority.

## Certification wave 4 — repeated canary and release decision

- [ ] Complete three to five fresh native staging runs with no unexplained manual
  repair, duplicate side effect, false activity, false slot occupancy, or stale-SHA
  approval.
- [ ] Review failures and rerun any affected earlier wave after a code or policy
  change.
- [ ] Record an explicit maintainer certification decision against one immutable
  candidate SHA.

Until every required wave is complete, documentation may say the behavior is
implemented, but must not call the candidate dogfood-ready, certified, or ready for
release.
