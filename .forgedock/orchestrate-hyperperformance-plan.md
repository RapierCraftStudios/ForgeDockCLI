# ForgeDock `/orchestrate` Hyperperformance Investigation and Plan

Status: evidence-backed plan; reversible native impact-gated review projection is
implemented behind an explicit policy flag and is awaiting the real staging
resume/shadow canary.

## Mission

Take the native ForgeDock orchestration pipeline from its current first end-to-end
closure proof to a high-throughput, low-token, high-accuracy system. The intended
direction is a bounded context-producing pipeline:

```text
issue contract -> Intent -> Investigation -> Build Packet -> BuildResult
              -> focused verification -> independent review -> merge/close
```

Each boundary must produce durable, typed evidence that the next boundary can use
without rereading the whole repository or repeating work. The model should resolve
ambiguity and implement code; deterministic code should own routing, claims,
verification authority, diff truth, state transitions, and cleanup.

The 5–8 minute issue target is a soft target, not a correctness override. It must
be measured by complexity tier and by both wall-clock and active model time. A
small issue that cannot meet the target after caching and focused verification is
evidence of a design problem; a broad issue (for example one whose Build Packet
contains dozens of expected paths) needs a separate budget and may be serialized.

## Evidence boundary

This plan uses only:

1. `.forgedock/orchestrate-watch.md` — the observation ledger and the sole source
   of historical run claims for this investigation.
2. Files explicitly named by that ledger: the cited headless/live logs and NDJSON
   traces, `.forgedock/state.db`, durable artifacts, run progress/telemetry,
   process observations, and the referenced source paths used to explain an
   observed behavior.

No external historical run, repository-wide performance assumption, or imagined
review result is treated as evidence. A recommendation marked “experiment” must
be measured in a future canary before it becomes a default.

## Current run status at plan capture

- Active DAG: `dag_0a31acc5-3ca0-49d3-a4ec-28d7c1faf4b9`.
- Controller: PID `25376`, creation time `2026-08-16 11:12:10` local;
  observer PID `26184`; log prefix `.forgedock/headless-resume-20260816-111210`.
- Both were intentionally stopped at 12:56 local after exact process-family
  validation; the same DAG remains resumable and no durable state was deleted.
- Durable projection: 4 completed, 4 running, 2 suspended, 24 queued; zero
  failed, blocked, or invalid nodes at the latest checkpoint.
- Suspensions are claim arbitration, not ordinary failures: #189/#199 were held
  behind overlapping active work and non-conflicting capacity was reused.
- The controller predates the F-024 source repair, so some active attempts still
  show `launching` with no `childRunIds`; a restarted controller is required to
  live-prove truthful early run identity.

Capture confirmation at `2026-08-16T12:32:04+05:30`: controller PID `25376` was
alive with the same creation time, and the node projection was 4 completed, 4
running, 2 suspended, and 24 queued. At `2026-08-16T12:56:03+05:30` the exact
validated family and observer were stopped without deleting durable state; no
failed, blocked, or invalid node was observed before the pause.

## Plan lock: execution order and stop conditions

This plan is the authority for the review-quality improvement work. No default
review behavior, reviewer roster, merge policy, or issue projection is changed
until the preceding stage has produced its durable evidence and passed its stop
conditions.

### Stage 0 — Freeze the evidence boundary

- Keep the current controller/DAG observation-only; do not restart or mutate it
  for an optimization experiment.
- Preserve the watch ledger, named logs, durable artifacts, process identities,
  and the current review verdict/issue lifecycle as the baseline.
- Stop immediately if a new unsafe route, overlapping builder, false terminal
  outcome, orphan external mutation, or failed/blocked/invalid node appears;
  repair the safety defect before any performance or review-policy work.

### Stage 1 — Shadow classification only

- Capture complete reviewer submissions and controller-consolidated findings for
  3–5 additional PRs across small, cross-boundary, and remediation changes.
- Classify each proposal as `substantive`, `advisory`, `duplicate`, or
  `unsupported` without changing issue creation, merge decisions, or reviewer
  coverage.
- Include low/P3 test-only cases such as #264 and record whether a concrete
  reachable impact exists.
- Deliver a per-finding scorecard: trigger, affected invariant, evidence anchor,
  acceptance relevance, severity/confidence, proposed disposition, and eventual
  validation/supersession outcome.
- Stop if raw reviewer output cannot be captured completely, if panel markers are
  missing, or if shadow classification disagrees materially between independent
  adjudicators without a deterministic resolution rule.

#### Fast dogfood lane (the same native staging pipeline)

To reach dogfooding quickly without destabilizing the current live controller,
the first implementation may be developed in an isolated checkout, but its
acceptance run must be this repository's native `staging` pipeline and its real
`/orchestrate` flow—not a parallel prototype or synthetic harness. Enable it
only through an explicit feature flag/config value for the first canary:

- keep legacy `commands/review-pr*` behavior unchanged;
- keep the complete selected reviewer panel, blocking policy, merge authority,
  remediation, and closure state machine unchanged;
- emit the new impact classification and metrics in shadow mode first;
- permit `impact-gated` projection only for explicitly opted-in dogfood runs;
- default missing/malformed classification to the existing safe behavior in
  shadow mode and to fail-closed/no new issue in enforced mode;
- make one switch roll back to current `findingIssuePolicy="all"` without
  rewriting durable verdicts or resurrecting superseded findings.

The dogfood acceptance bar is deliberately small: the current native review
tests pass; one real low/P3 case such as #264 is classified and reconciled
without creating a durable work item under the opt-in policy; a real
high-confidence race/security/data defect still projects; reviewer markers and
merge gates remain unchanged; and the feature can be disabled without a state
repair. The first post-change canary must run through the same staging
controller, scheduler, work-on children, GitHub projections, review, merge, and
closure paths that this audit is observing. Only after that bar passes does the
policy become the staging default; legacy compatibility is evaluated separately.

#### Implemented native slice (2026-08-16)

- `FindingImpactSchema` is optional on durable findings for backwards decoding,
  but the reviewer task now requires category, trigger, affected invariant, and
  observable consequence. Missing impact is visible in the verdict and cannot
  qualify for the enforced lane.
- `FindingIssuePolicy` supports `impact-gated` and `shadow-impact-gated`;
  `FORGEDOCK_REVIEW_FINDING_POLICY` overrides existing native `all` call sites
  (explicit `none` remains authoritative).
- The controller owns `findingMaterializationReason`: enforced projection
  requires in-scope, high-confidence, causal-rooted, anchored impact evidence;
  advisory/malformed evidence and low-severity test/performance/compatibility/
  operability gaps stay out of the issue queue. Low-severity correctness,
  security, data-integrity, and availability defects remain eligible when
  concretely evidenced.
- `ReviewVerdict.findingProjection` records candidates, materialized IDs, and
  deterministic suppression reasons. Shadow mode still creates legacy issues
  while recording what the impact gate would have withheld.
- Native focused tests and the full Next suite pass (`657/657`). The feature is
  not the staging default yet; the next live step is a same-DAG shadow resume,
  followed by an enforced canary only after real reviewer evidence is captured.

The same-DAG shadow resume was attempted at 13:08 local and intentionally
stopped at 13:10 when #197 became blocked on a truthful changed-path mismatch.
That result validates resumability but fails the canary's closure gate: review
policy work must pause while recovery/terminal-state handling for a blocked
verification attempt is diagnosed. The preserved DAG now has 4 completed, 4
running, 1 blocked, and 25 queued nodes; no further resume should consume
provider tokens until that blocker has an evidence-backed disposition.

#### Recovery correction before the next canary (2026-08-16 13:24 local)

The blocker was reproduced from the durable #197 artifact sequence and traced to
reconciliation ordering. `decideSubjectAdmission()` already recognized a newer
verified `BuildResult` as recoverable publication, but `reconcileArtifacts()`
let the older request-changes `ReviewVerdict` produce a blocked state. The
orchestration resume reconciler then terminalized the node through
`terminalOrchestrationResult()`. This would strand valid repaired work and spend
tokens on the wrong recovery path.

`src/core/state/reconcile.ts` now ignores a verdict superseded by a later
BuildResult, exposing `publishing` so the existing publication/review pipeline
can resume. The new regression mirrors the observed ordering; no default policy
or reviewer/merge behavior changed. Build, focused tests, and the full native
Next suite pass (`658/658`). A live read-only replay of #197 reports
`publishing` with no terminal result. The DAG remains paused; the next action is
one deliberate same-DAG shadow canary to prove publication through closure.

### Stage 2 — Contract and compatibility design

- Specify the typed impact/disposition fields and their backwards-compatible
  defaults for older `ReviewVerdict` artifacts.
- Trace native and legacy callers of finding projection, remediation admission,
  reconciliation, batching, and resume. Decide where advisory evidence lives and
  ensure it cannot become a work item accidentally.
- Add positive/negative fixtures for real defects, test-only gaps, measurable
  performance/operator impact, security/data-integrity issues, and style-only
  suggestions.
- Deliver schema and state-machine tests before changing production defaults.
- Stop if a legitimate low-severity defect would be downgraded solely by severity,
  or if old verdicts can resurrect/lose finding state during resume/supersession.

### Stage 3 — Reversible implementation slices

Implement in this order, each behind a feature flag and with focused tests:

1. reviewer prompt additions: counterfactual trigger/impact question and an
   explicit non-finding list;
2. structured reviewer disposition and controller-owned impact gate;
3. advisory projection/PR evidence that cannot create child issues;
4. substantive issue projection, semantic deduplication, and recurrence handling;
5. phase-attribution telemetry linking accepted findings to Intent,
   Investigation, Build Packet, BuildResult, verification, or delivery;
6. dashboards/receipts and rollback switch.

Do not reduce the independent reviewer panel, alter blocking thresholds, or merge
on a missing/malformed reviewer result during these slices. Run the existing
review, remediation, reconciliation, and closure tests after each slice.

### Stage 4 — Canary and promotion decision

- Run a small mixed-complexity canary with shadow and enforced modes compared to
  the frozen baseline.
- Promote only if substantive detection and review-escape rates do not regress,
  mechanical issue projection is zero, panel completeness remains 100%, and
  issue count/remediation/token cost improve without closure regressions.
- If any guard fails, disable the feature flag and retain the old projection
  policy while preserving the evidence for diagnosis. Do not patch around a
  failed canary by weakening the rubric.

### Stage 5 — Default rollout

Only after the canary passes, make impact-gated projection the default, retain the
full panel for novel/high-risk cells, and continue measuring false positives,
validated-positive rate, duplicate roots, remediation cycles, escapes, speed,
and cost. Revisit panel de-escalation separately; it is not a prerequisite for
the anti-frivolous finding gate.

## What the observed run actually costs

The watch ledger reports four terminal native closures: #190, #192, #193, and
#195. Their DAG-linked receipts account for:

| Measure | Observed value |
|---|---:|
| Model sessions | 31 |
| Summed active model time | 162.9 min |
| Fresh input tokens | 2,967,727 |
| Output tokens | 397,072 |
| Cache-read tokens | 26,369,536 |
| Provider-total tokens (includes cache reads) | 29,734,335 |
| Estimated model cost | ~$1.60 |

Cache reads are not fresh prompt input; provider-total tokens must not be treated
as billable fresh context. Both numbers should remain visible because cache volume
still indicates repeated context traversal and latency pressure.

Per-issue receipt reconstruction gives the following shape:

| Issue | Changed paths | Active model time | Estimated cost | Approx. intent→merge wall time | Notable rework |
|---:|---:|---:|---:|---:|---|
| #192 | 2 | 27.7 min | $0.193 | 62 min | Canonical Windows command false-block, then verification recovery |
| #193 | 5 | 37.4 min | $0.309 | 113 min | Long baseline/verification path; 3 review sessions |
| #195 | 2 | 35.3 min | $0.297 | 67 min | 2 review sessions; otherwise clean closure |
| #190 | 8 | 62.5 min | $0.800 | 158 min | 2 BuildResults, superseded blocked Outcomes, remediation, 8 review sessions |

The clean proportionality test is #195: two changed files still required six
model sessions and 35.3 active minutes. The current pipeline therefore misses the
soft 5–8 minute target even for a small fix. The gap is not explained by code
editing alone; setup, repeated context, verification, review fan-out, and recovery
are material.

The phase aggregate in the watch ledger (including active/retried DAG work) is:

| Phase | Sessions | Active time | Estimated cost | Reading |
|---|---:|---:|---:|---|
| Build | 6 | 55.7 min | $0.335 | Dominated by full verification/retries for some workers |
| Build Packet | 7 | 51.1 min | $0.474 | High-value scope/claim discovery, but broad rereads |
| Review | 16 | 46.3 min | $0.406 | Real independent shards; repeated common-context reads |
| Investigation | 7 | 34.1 min | $0.570 | Broad repository comprehension is expensive |
| Remediation | 1 | 12.0 min | $0.201 | Avoidable when deterministic delivery errors are normalized |

## Phase-by-phase diagnosis

### 1. Issue specification and Intent

The four terminal inputs are structured review-finding issues. Their Intent
payloads contain roughly 2.2–2.8K characters of problem text, but the durable
Intent artifact has empty structured `constraints`, `acceptanceHints`, and
`dependencies` for this sample. The issue text is sufficiently precise for all
four terminal investigations to be `confirmed` (three high confidence, one
medium); there is no evidence here that vague issue specs are the dominant cost.

The real defect is context transport: the same long issue body is available to
every phase without a compact, typed contract. The fix is not to remove issue
detail. It is to parse and freeze it once:

- source issue number, updated timestamp, source PR/SHA, authoritative target
  lane, acceptance criteria, affected-file claims, and explicit dependencies;
- section hashes/offsets so a later phase can request the exact missing evidence;
- a short Intent brief with links back to the authoritative source sections.

Missing required sections should fail or request clarification before model
investigation. Existing structured issues should not pay a model turn to prove
that their sections exist.

### 2. Investigation

The four terminal investigations all reached `confirmed`, with 6–8 evidence
items and 2–7 affected surfaces. Active time ranged from 3.8 to 7.2 minutes per
investigation and fresh input from approximately 136K to 223K tokens. This is
good semantic yield but expensive repository exploration.

The live log shows repeated guesses such as `path="."`, `test`, `tests`, and
absolute workspace paths that the scoped tools reject. These are recoverable, but
each failed call consumes a turn and forces the model to rediscover the workspace
boundary. Investigation should receive the typed issue contract and a deterministic
initial inventory of its claimed paths. It should then produce an evidence map:

```text
claim -> exact path/symbol -> observed behavior -> test/evidence -> confidence
```

The investigator may expand beyond the initial paths only when an import,
call-site, test, or runtime trace proves the expansion is necessary. “Search the
whole repository” should be a bounded escalation, not the default.

### 3. Build Packet

Build Packet is a high-value safety boundary and must remain. It discovered
dynamic overlap that static issue claims missed; the scheduler correctly suspended
workers rather than allowing concurrent edits. Removing or weakening this phase
would recreate the confirmed cross-worker claim failure.

The packet size is the complexity signal. Terminal packets contained 2–8 expected
paths; #199’s packet contained 42 paths and consumed 16.9 active minutes, 885K
fresh input tokens, and about $0.467 before being suspended on a real overlap.
That is not a small issue and should be classified as broad/serialized rather than
forced through a small-issue budget.

Optimize the packet author by reusing the Intent/Investigation evidence bundle,
reading exact candidate paths first, and emitting deterministic normalized claims.
The packet must still freeze expected paths, verification commands, target lane,
risks, and out-of-scope boundaries before builder dispatch.

### 4. Build and BuildResult

The four merged changes are appropriately scoped: 2, 5, 2, and 8 changed paths.
However, #190 needed a second BuildResult and remediation, and the live #197 path
spent a full builder attempt repairing a report that said important observed files
were unchanged. That is a delivery-metadata defect, not productive implementation.

The controller already observes the real branch diff. Make that diff the source of
truth for `changedPaths` and status classification. Treat the model’s change
report as explanatory metadata. Normalize/synthesize it from the observed diff;
ask a model only for a missing semantic explanation. Continue to fail closed on
untracked, unauthorized, or out-of-packet files. This removes whole builder retry
sessions without reducing code review quality.

### 5. Verification and environment setup

This is the largest wall-clock bottleneck. The watch records full `npm test`
baselines for each admitted worker, with a machine-wide verifier lock serializing
those phases. #201 remained parent-`launching` for roughly thirteen minutes while
baseline work ran before its semantic run identity became visible. #199 also had a
several-minute isolated `npm ci --ignore-scripts` setup interval.

The baseline is valuable, but repeating the same base-revision/policy check per
issue is not. Cache a verified baseline by:

```text
repository + base SHA + lockfile/package-manager hash + Node/npm identity
+ OS + verification-policy/catalog hash
```

On a cache hit, run only issue-focused tests and changed-path checks in the issue
worktree. Run the complete suite once at the staging merge gate (and when the
cache key invalidates). Keep Git common-metadata mutations serialized, but do not
serialize independent test processes unless measured resource contention proves it
necessary. Baseline worktrees must be removed in `finally` after success or
interruption; the watch found roughly 1.73 GB of retry-created baseline orphans.

### 6. Review

Review is real and must remain independent. The four terminal nodes used 16 review
sessions. #192, #193, and #195 reached merge with 3, 3, and 2 review sessions;
#190 used 8 across multiple cycles and remediation. The evidence shows review can
catch substantive issues, but reviewers repeatedly reread common repository
context.

#### Review-quality evidence checkpoint (2026-08-16)

The durable native `ReviewVerdict` artifacts for the four merged PRs are a useful
quality sample, but not proof of a universal false-positive rate:

| Merged PR / issue | Final reviewer roles | Final findings | What the findings contained |
|---|---|---:|---|
| #258 / #192 | correctness, data, concurrency | 0 | Clean approval; required checks passed. |
| #259 / #193 | correctness, data, concurrency | 2 | A missing post-check base-race regression and a string-matched merge-race path that loses durable `Outcome.mergeGate` evidence. Both were high-confidence, medium-severity, concrete correctness/durability concerns. |
| #260 / #190 | correctness, data, concurrency | 0 | Final approval after remediation and a fresh review wave. An earlier request-changes verdict contained two claim-checkpoint findings that were remediated before the final approval. |
| #265 / #195 | correctness, concurrency | 1 | Milestone-branch provisioning occurred before the protected-target classifier; a route-side-effect safety concern, not a style or mechanical suggestion. It was correctly retained as a non-blocking follow-up because the minimal repair crossed the frozen write paths. |

Thus the final merged sample has two clean approvals and three structured,
high-confidence, impact-backed, non-blocking findings. There is also a directly
observed low-severity projection: the earlier #190 review wave emitted a P3,
test-only “fresh successful claim promotion has no ordering regression assertion”
finding, which created GitHub issue #264 before the final zero-finding verdict
superseded and closed it. That is not formatting or naming noise—the missing
assertion touches a real ordering invariant—but it is a credible advisory
candidate whose separate issue and pipeline admission were disproportionate to
its demonstrated runtime impact. The sample is too small to claim a general
false-positive rate, and the raw provider conversations are not the authority
here; the structured artifacts plus issue lifecycle are. The next canary must
classify every raw proposal as substantive, advisory, duplicate, or unsupported
before changing projection behavior.

The reviewer prompt already requires an isolated fresh context, a concrete
evidence/intent/remediation triple, a causal-root label, exact packet-criterion
matching, and bounded exploration (`src/workflows/review-pr/review.ts:404-451`).
Consolidation also validates anchors and scope before deciding whether a finding
can block (`src/workflows/review-pr/consolidate.ts:62-89`). Those are valuable
guards and explain why the observed findings are qualitative.

The materialization policy is nevertheless too permissive for a pipeline that
must not inflate its own issue backlog. Native review defaults to
`findingIssuePolicy = "all"` and projects every terminal finding
(`src/workflows/review-pr/review.ts:649-657`); `shouldMaterializeFinding` rejects
only `scopeDisposition === "rejected"`, so `follow_up`, low-severity, and merely
non-blocking findings still become GitHub issues
(`src/workflows/review-pr/scope.ts:88-90`). The legacy command contract has the
same problem more explicitly: minor/style findings do not block, but every
confidence level is still filed, and unstructured `Finding`/`Issue`/`Bug`/
`Warning` text is a fallback input (`commands/review-pr.md:26, 1645-1667`;
`docs/spec/review-protocol.md:121-143`). This is the principal systemic
issue-inflation risk—not evidence that the current three findings were
frivolous.

#### Finding-to-phase root-cause trace

- **#193, base-race regression:** The finding is explicitly covered by the
  Build Packet's merge-gate criterion, but the builder added head/open-state
  fixtures without the equivalent base interleaving and left workflow-level
  typed race persistence untested. Classify this as an implementation/
  verification-coverage gap, not a reviewer-quality problem. The review exposed
  a real cross-boundary omission that the packet named but the build evidence did
  not prove.
- **#193, durable merge-race evidence:** The packet required recoverable
  `Outcome.mergeGate` evidence, while completion classified adapter race strings
  too narrowly. Classify this as an implementation boundary/type-contract gap
  (with a possible Build Packet-to-code traceability weakness), not a trivial
  suggestion. The fix should be a typed error/explicit classification and a
  workflow regression, not a cosmetic change.
- **#195, pre-classification branch provisioning:** The packet's acceptance
  criterion required route rejection before branch-head validation and workspace
  side effects, but the frozen write paths were only `lane.ts` and its tests.
  The reviewer found the missing CLI/TUI/orchestration ordering before the guard.
  Classify this as packet-scope/integration-boundary leakage: the local classifier
  fix was correct, but packet decomposition did not include the side-effecting
  callers. It is a legitimate route-safety finding, not an out-of-scope style
  preference.

The general lesson is to preserve the full independent panel and improve the
finding contract. A reviewer must answer: **what exact trigger reaches the
changed code, what invariant/user/operator/security property fails, what is the
evidence anchor, and what is the smallest corrective action?** If it cannot
answer those questions, it is an advisory or an unfounded observation—not a new
work item. This rule is deliberately codebase-neutral.

#### Implementation readiness and remaining investigation gates

The plan is qualitatively ready as a direction and as a staged experiment, but
not yet safe to implement as an unconditional behavior change. Before enforcing
HP-14/HP-15, complete these bounded investigations:

1. **Shadow proposal census:** capture the complete structured reviewer
   submissions, consolidated findings, issue projections, and supersession
   outcomes for at least 3–5 additional PRs across small, cross-boundary, and
   remediation reviews. Include the #264 class explicitly. Measure how often a
   low/non-blocking finding has a reachable user/operator/security/data impact
   versus only a missing test or preferred hardening.
2. **Contract compatibility:** trace every native and legacy caller of
   `findingIssuePolicy`, `shouldMaterializeFinding`, remediation admission, and
   review reconciliation. Decide whether advisory data lives only in the
   `ReviewVerdict`, a PR comment, or a separate non-work issue projection; prove
   that old verdicts resume, supersede, and close without resurrecting advisories.
3. **Acceptance of the impact rubric:** test representative real defects,
   test-only gaps, performance regressions, security concerns, and style-only
   suggestions against the proposed fields. The rubric must retain legitimate
   low-severity defects while rejecting speculative or mechanical work.
4. **Operational rollout design:** add a feature flag, shadow telemetry, a
   deterministic schema gate, and a rollback path before changing default
   projection. Validate that malformed reviewer output fails closed and that the
   full reviewer panel still runs and posts its markers.
5. **Canary validation:** run the shadow/enforced policy on a small issue set,
   compare substantive detection, false positives, remediation cycles, issue
   count, tokens, and closure success to the current behavior. Only then make
   the policy default.

No further broad repository archaeology is required for the plan itself. These
are behavior measurements and compatibility checks needed to implement it
without suppressing a real defect or breaking the existing remediation/closure
state machine.

First optimize the review packet, not the verdict: provide the exact diff, changed
symbols, packet acceptance criteria, risk notes, relevant tests, and prior phase
evidence. A reviewer can request a bounded expansion when a claim cannot be
validated. Each reviewer must return path/symbol, risk, evidence/check, and
verdict—not a generic approval.

Only after a shadow measurement should panel intensity become risk-selected. Novel,
security, concurrency, deployment, routing, and broad packets keep the full panel.
Proven low-risk cells may use a smaller panel only when the shadow comparison
shows no increase in review escapes or manual fix-ups. Remediation always triggers
fresh focused verification and re-review of the touched surface.

### 7. Orchestration, closure, and observability

The watch identifies safety-critical state-machine failures: dynamic claim
promotion crossing the native boundary, typed suspension being swallowed, false
terminal Outcomes being resurrected, stale suspended projections, and delayed
child-run identity. The fixes demonstrate that correctness depends on durable
artifacts and parent-mediated claims, not process exit codes.

Keep these invariants non-negotiable:

- exact Build Packet claims are durably accepted before builder dispatch;
- a claim conflict suspends/retries the same node and never starts overlapping
  builder work;
- only the latest reconciled run can produce a terminal Outcome;
- a fresh semantic run is allowed after an explicit abandoned/reset Outcome;
- target-branch evidence is structural and production-target dispatch remains
  impossible without explicit authority;
- parent status records the child run as soon as admission chooses it;
- pre-dispatch failures do not trigger global status polling or hidden GitHub
  mutation;
- every GitHub side effect has a durable reservation and an idempotent recovery
  path;
- successful and interrupted baseline/delivery worktrees are cleaned up.

Do not increase `maxParallel` while these invariants or the baseline lock are
unmeasured. The live scheduler is already reusing safe capacity; more workers
would multiply setup and contention rather than improve throughput.

## Prioritized improvement backlog

### P0 — Instrument and preserve safety before optimizing

#### HP-00: Truthful phase telemetry and early run identity

Boundary: orchestration controller ↔ nested work-on admission (F-024).

Action:

- record `runId` immediately after semantic admission, before baseline/setup;
- emit typed timestamps for queued, setup, baseline, model-active, verifier-wait,
  claim-wait, review-wait, remediation, and terminal transitions;
- attach base SHA, packet path count, changed-path count, baseline cache key/hit,
  review panel, retry reason, and token/cost receipt to the issue attempt.

Acceptance:

- a restarted controller never leaves an active semantic worker as anonymous
  `launching` beyond the admission boundary;
- every issue can be decomposed into queue/setup/model/wait time without reading
  raw model text;
- no state transition, claim, or terminal classifier behavior changes.

#### HP-01: Deterministic contract gates

Boundaries: Intent, Investigation, Build Packet, BuildResult, Outcome.

Action: enforce typed invariants for source hash/sections, investigation evidence
coverage, packet claim coverage, observed diff coverage, verification command
coverage, target lane, and latest-run Outcome ownership. Keep model prose as
explanation, not authority.

Acceptance: replay the observed F-009/F-018/F-019/F-020/F-021/F-022/F-023 failure
shapes and prove they fail closed or recover to the same safe state. No extra
model retry is used for a deterministic schema/diff mismatch.

### P1 — Remove duplicated reads and setup cost

#### HP-02: One authoritative issue snapshot per admission

Use one immutable scope snapshot for preview and confirmation. At confirmation,
revalidate only the snapshot revision/updated records and canonical batch markers;
do not hydrate every issue and comment again unless a record changed. Coalesce
batch member fetches, `state=all` scans, and label setup instead of repeating them
for each batch. Preserve the existing closed-projection invalidation and open
marker fail-closed rules.

Success metric: preview/confirmation API calls per selected issue; no orphan batch
issue on failed admission; exact frozen membership after confirmation.

#### HP-03: Typed Intent/context bundle

Create a compact durable context bundle once per semantic run. Subsequent phases
receive references and structured slices rather than the entire issue body,
repository-wide instructions, and repeated source comments. Add a bounded
`expandEvidence(paths, symbols, reason)` request for legitimate investigation
expansion.

Success metric: fresh input tokens per phase and duplicate path reads fall by at
least 50% on a small-fix canary, while every acceptance criterion still has an
evidence link.

#### HP-04: Baseline cache and focused verification

Implement the cache key described above. On a hit, skip the repeated full baseline;
run focused tests for the packet’s changed/expected paths and one complete suite at
the staging merge gate. Invalidate on base SHA, lockfile, runtime, policy, or test
catalog changes. Clean all temporary baseline worktrees in `finally`.

Success metric: baseline cache hit rate, baseline wall time, verifier-lock wait,
full-suite executions per staging bundle, and zero escaped defects attributable
to a stale cache.

#### HP-05: Deterministic path/tool resolution

Give each model worker a repo-relative allowed-root map derived from its packet.
Reject out-of-scope paths before a model call and return an actionable typed list
of valid roots. Eliminate default guesses for `.`, `test`, `tests`, and absolute
workspace paths. This is a safety-preserving ergonomics fix, not a broadening of
file authority.

Success metric: failed path-tool calls per phase and invalid-call token cost.

### P2 — Improve code accuracy without turning review into ceremony

#### HP-06: Evidence-first Investigation prompt

Require the claim/evidence map above, root cause, affected surfaces, explicit
non-goals, and confidence. The investigator must distinguish source issue prose
from observed repository behavior and state what would falsify the verdict. The
typed issue snapshot supplies known paths; the model expands only with evidence.

Success metric: investigation confirmation accuracy, evidence completeness, scope
expansion count, and invalid/re-investigation rate. Keep the current fail-closed
invalid path.

#### HP-07: Build Packet as a compact, deterministic handoff

Keep packet generation and claim promotion, but derive normalized path/branch/
verification fields in code. Have the model explain scope and implementation order
only where the typed data cannot. Automatically classify packets by path count,
cross-domain risk, target lane, and claim overlap. Packets above a broadness
threshold should be serialized or decomposed rather than hidden inside a small
issue budget.

Success metric: packet active minutes, path-read duplication, claim-conflict rate,
and builder starts that occur after exact claim persistence.

#### HP-08: Diff-truth BuildResult normalization

Compare the observed delivery diff with the builder’s report. Normalize changed
paths/checks from Git and retain the model’s summary as evidence. A report mismatch
must not launch a full builder repair attempt; it should become a deterministic
metadata repair or a narrow request for a missing explanation. Unauthorized paths,
missing required tests, or semantic acceptance failures still block.

Success metric: builder report mismatch retries, remediation cycles caused by
metadata only, and review findings caused by unreported changed files.

#### HP-09: Review packet and risk-tier shadow mode

Keep independent correctness/data/concurrency or domain reviewers where the packet
requires them. First run a shadow tier decision while still executing the current
full panel. Compare predicted smaller-panel verdicts with the full panel’s actual
findings, remediation, and later escapes. Promote only cells with sufficient
observations and no quality regression. Never allow the coordinator to synthesize
approval from missing reviewer markers.

Success metric: review sessions and fresh tokens per PR, first-pass approval rate,
findings per PR, manual fix-up rate, and review-escape rate. The quality gates are
the release criteria, not token savings alone.

#### HP-10: Bounded remediation

Classify a review result as substantive, deterministic delivery metadata, or
transport/panel integrity. Fix deterministic classes in code. For substantive
findings, provide the remediator only the finding, touched diff, relevant packet
criteria, and focused tests; then run a full fresh re-review. Do not spawn a new
issue for a phase-delivery problem and do not reread the entire repository by
default.

Success metric: remediation active minutes, cycles per issue, repeated finding
rate, and percentage of review findings resolved in one bounded cycle.

#### HP-14: Impact-gated findings and two-track review output

Keep the full independent reviewer panel, but split its output into two typed
tracks before GitHub projection:

1. **Substantive finding:** creates or updates a `review-finding` issue only when
   it has a concrete trigger or reproducible trace, affected behavior/invariant,
   evidence anchor, intent/acceptance relevance, calibrated severity, confidence,
   and a minimal remediation. A counterfactual sentence is mandatory: “If this
   remains unchanged, what breaks, for whom, under which input, concurrency,
   deployment, or operational condition?”
2. **Advisory:** style, naming, formatting, lint preference, documentation
   wording, speculative hardening, and other non-impact observations remain in
   the review evidence/PR summary and do not create child issues or consume the
   orchestration backlog. An advisory can be promoted only after new evidence
   satisfies the same impact gate.

The controller, not the model, owns the gate. Add a schema-valid classification
(`substantive`, `advisory`, `unsupported`, `duplicate`) and reject or downgrade
missing impact fields deterministically. Do not use low severity as a proxy for
frivolousness: a low-severity production, security, data-integrity, or measurable
operator-cost defect can still be substantive. Conversely, a high-sounding
claim without a reachable trigger or anchor cannot block or create an issue.
Keep exact-root/title deduplication and recurrence comments; never create a new
issue for a semantically identical root merely because the wording or line
number moved.

Roll this out in three stages: (A) shadow-classify all raw proposals while the
current full panel and projection remain unchanged; (B) enforce the gate while
retaining every selected reviewer and fail closed on malformed reviewer output;
(C) tune prompts and thresholds from validated outcomes. Do not reduce reviewer
coverage to save tokens until the shadow comparison shows no escape or
false-negative regression.

Success metrics: raw proposals per PR, substantive finding rate, advisory rate,
validated-positive rate, false-positive rate, duplicate/recurrence rate,
issue-projection rate, severity calibration, review escapes, remediation cycles,
and reviewer-panel completeness. Initial release guards: zero issue creation for
purely mechanical observations, zero missing impact fields admitted as issues,
no increase in escaped defects, and no reduction in independent-panel markers.

#### HP-15: Implementation-to-finding feedback loop

For every accepted substantive finding, compare the finding against Intent,
Investigation, Build Packet, BuildResult/diff truth, verification evidence, and
review scope. Record one root-cause tag:
`ISSUE_SPEC`, `INVESTIGATION`, `PACKET_SCOPE`, `IMPLEMENTATION`,
`VERIFICATION`, `REVIEW_CALIBRATION`, or `PIPELINE_DELIVERY`. Require the
review artifact to retain `introducedByRemediation`, matched acceptance
criterion, normalized causal root, and source session references. The current
native schema already carries most of these fields; the missing piece is a
deterministic phase attribution and aggregate feedback.

Use the tags to improve the earliest responsible phase, not to punish the
reviewer. In this sample, #193 maps primarily to implementation/verification
coverage and #195 to packet-scope/integration boundary. A validated advisory
must not become a phase defect merely because it was recorded. Feed recurring
accepted roots back into Investigation/Build Packet context or a deterministic
quality check only after three independently validated recurrences and seeded
positive/negative tests.

Success metrics: accepted finding root-cause distribution, packet criteria that
were present but unproven, changed-path/acceptance mismatches, repeat-root rate,
first-pass approval, remediation yield, and post-merge escape rate. The loop is
healthy when substantive findings decline because earlier handoffs improve—not
because the review gate suppresses them.

### P3 — Throughput and scaling after canary proof

#### HP-11: Safe scheduler utilization

Measure claim-wait, verifier-wait, Git metadata lock, and transport capacity
separately. Keep exact claim arbitration and common-Git leases. Increase effective
parallelism only if baseline cache hits, lock wait, memory, and review quality show
headroom. A suspended overlap is healthy; a duplicate builder is a release
blocker.

Success metric: issues closed per wall-hour, worker utilization excluding waits,
claim conflicts that resume successfully, and zero overlap/duplicate dispatch.

#### HP-12: Baseline/worktree lifecycle hygiene

Make cleanup idempotent for successful, interrupted, abandoned, and killed
attempts. Reconcile orphan worktrees at restart using creation-time/lease evidence;
never delete a live or unowned worktree. Track bytes and count per attempt.

Success metric: zero completed-attempt baseline worktrees left behind and bounded
disk growth during a 100-issue canary.

#### HP-13: Conditional deterministic check promotion

If the current run or a future canary records the same review defect pattern three
times, promote it to a quality-gate registry check. This is conditional: the
watch file alone does not provide a recurrence count sufficient to create a check
now. Every promoted check needs seeded positive/negative tests and a measured gate
runtime increase of at most five seconds.

## Stage-by-stage experiment design

### Stage A — Measurement-only canary

Run 3–5 issues spanning tiny (≤3 expected paths), medium (4–10), and broad
(>10) packets with current full review. Do not change model prompts or reviewer
count. Capture the HP-00 metrics and confirm that the baseline and receipt
accounting agree with the existing ledger.

### Stage B — Deterministic context and baseline optimizations

Enable HP-02 through HP-05 behind feature flags. Keep full review, full safety
claims, and one staging merge gate. Compare each issue to Stage A by complexity
tier. Roll back a cache or snapshot independently if any stale evidence, missing
acceptance link, or escaped defect appears.

### Stage C — Accuracy-focused handoffs

Enable HP-06 through HP-08 and shadow HP-14/HP-15. Require schema-complete
evidence and diff-truth metadata. Measure first-pass review approval and
remediation, not just tokens. The canary passes only if no safety invariant
regresses and substantive review quality does not decline.

### Stage D — Review shadow and utilization

Enforce HP-14 after its shadow gate, then enable HP-09, HP-10, HP-11, and the
phase-feedback portion of HP-15. Keep the full reviewer panel until the shadow
model has enough same-run evidence to show equal or better defect detection.
Increase parallelism only after verifier-lock and claim-wait telemetry show that
the current cap is the bottleneck.

## Release scorecard

Report these per complexity tier and for the whole canary:

| Dimension | Required measure | Initial release guard |
|---|---|---|
| Correctness | review findings/PR, manual fix-up, review escape, post-merge failure | no increase; escape target remains <2% once sample exists |
| Investigation | confirmed/partial/invalid, evidence completeness, re-investigation | no invalidation or evidence-completeness regression |
| Code accuracy | changed paths vs observed diff, focused test pass, acceptance coverage | zero unreported authorized changes; zero unauthorized changes admitted |
| Review quality | first-pass approval, substantive/advisory/unsupported rates, validated-positive rate, false-positive rate, panel marker completeness | zero mechanical issues projected; no missing reviewer marker; no “approval by timeout” |
| Safety | production-target dispatch, overlapping builder claims, orphan side effects, stale terminal projection | zero occurrences |
| Speed | intent→close wall p50/p90; queue/setup/model/wait split | tiny target 5–8 min p50; broad issues explicitly exempt |
| Token efficiency | fresh input/output/cache reads per issue and per phase | ≥50% fresh-input reduction on small canary |
| Cost | provider estimate per issue and per changed path | lower than current tier baseline without quality loss |
| Throughput | completed issues per wall-hour; effective worker utilization | improve only after lock/cache data proves capacity |
| Hygiene | baseline/worktree count and bytes after terminal state | zero completed-attempt orphans |

The current sample is too small to claim a statistically stable review-escape or
post-deploy rate. It is sufficient to prove that the present cost and retry shape
cannot meet the intended target without reducing duplicate work.

### Live canary correction note (2026-08-16 13:38 local)

The corrected reconciliation build was exercised on the same persisted DAG. The
false #197 terminalization did not recur: it remained queued for capacity. #207
reached a durable, authoritatively closed `invalid` outcome, and the scheduler
correctly admitted #208 afterward. This distinguishes a valid terminal issue
classification from a controller safety failure. The exact process family was
stopped at that checkpoint to cap token spend, leaving all durable state
resumable.

The canary also exposes a product metric decision that must precede any batch-
success optimization: `finalizeRecord()` currently marks an orchestration
failed when any node is `invalid`, even when the issue has a completed closure
proof. Preserve this behavior until the desired contract is explicit; measure
issue terminal-closure rate separately from code-delivery success rather than
silently relabeling invalid/decomposed work as successful.

Next canary acceptance: resume the same DAG, prove #208's interrupted attempt
is reconciled rather than duplicated, and capture at least one substantive
issue through BuildResult, review verdict/projection, remediation or merge, and
authoritative issue closure. Only then compare time/tokens against the plan's
speed and quality guards.

### Live canary decomposition finding (2026-08-16 14:06 local)

The resumed run supplied a stronger end-to-end test than a synthetic fixture.
Investigation of #208 confirmed a high-severity security boundary defect and
created replacement issues #278 and #279. The native controller marked #208
`skipped`/`decomposed`, but the persisted DAG did not add either replacement;
the next slot was consumed by unrelated #209. This contradicts the shared
orchestration contract that decomposed parents expand to open children and can
leave an invocation successful-looking while the required replacement work is
outside its closure set.

#### HP-16: Bounded durable decomposition expansion (P0)

When a live investigation returns `decompose`, the controller must validate the
child issue references, persist an explicit expansion event, and add the open
children to the same orchestration (or persist a durable successor DAG linked
to the parent). Admission must re-run claim/dependency materialization for the
new nodes, preserve the parent as a terminal tracker, and bound expansion depth,
child count, and duplicate IDs. A restart must reconstruct the exact same
replacement set from GitHub artifacts without replaying the parent. Report
`decomposed_pending_children` separately from code-delivery success and do not
consume capacity on unrelated nodes while an admitted replacement is waiting.

Acceptance evidence: a live canary where #208's #278/#279 children are both
represented durably, dispatched under normal claims, and each reaches an
authoritative terminal closure; a restart between expansion and dispatch must
not duplicate either child. Add focused controller/scheduler tests for invalid,
duplicate, closed, and over-limit child references. This slice is prerequisite
to claiming end-to-end orchestration closure.

Implementation status (2026-08-16 14:32 local): complete in the native
controller/scheduler and CLI/TUI adapters, pending live same-DAG proof. The
focused tests cover authoritative child propagation, duplicate rejection,
bounded expansion, dependent rewiring, and legacy skipped-parent recovery.
The full native suite remains green at `664/664` after the change.

### HP-16 live performance result (2026-08-16 14:39 local)

The same-DAG resume proved durable child expansion but failed the throughput
guard. At 14:38 local, after a 14:31 resume, the projection remained
`running=4, completed=4, queued=26, invalid=1, skipped=1`; #278/#279 were
persisted but had not dispatched. Run-progress heartbeats showed active tools
and tests, yet no issue-level transition. #194's remediation cycle had already
carried a 12:24-local BuildResult and 12:34-local ReviewVerdict while still
reporting cycle 1/4 with three cycles remaining. The controller family was
stopped at 14:39 with a resumable sentinel to cap token spend.

This adds a P0 performance requirement before further broad-batch dogfooding:

- Enforce per-phase wall-clock and tool/token budgets with durable checkpoints.
- Treat heartbeat-only activity without issue-level progress as a watchdog
  condition; suspend/reconcile the worker instead of burning an unbounded
  remediation loop.
- Expose queue wait, active phase age, last issue-level transition, and estimated
  token/cost burn in the controller status so GitHub comment timestamps cannot
  mask a stall.
- Resume a one- or two-issue canary first, then prove child dispatch and terminal
  closure before restoring the 43-issue batch.

### HP-17: truthful orchestration liveness (P0)

The live canary showed that a running process and fresh tool receipts can mask
an unchanged issue-level projection. The native CLI had a detached heartbeat
promise on fresh workers and no orchestration heartbeat/abort channel on
resumed workers. Both paths could therefore spend tokens after durable DAG
progress stopped.

Implemented: heartbeat rejection now aborts the fresh worker; resumed workers
hold an orchestration-scoped lease, renew the DAG attempt, and forward a parent
AbortSignal into nested work-on/runtime phases. Build and the full native suite
are green (`664/664`).

Remaining watchdog work: add a frozen, configurable phase/progress budget and a
durable status projection that reports the last issue-level transition separately
from tool heartbeats. On budget expiry, abort through this signal, retain the
worktree/checkpoint, and return a resumable suspension rather than silently
creating an ordinary failure or continuing an unbounded remediation loop.

## Compaction recovery instructions

On resume, read this file first, then read the tail of
`.forgedock/orchestrate-watch.md`. Recheck the exact controller creation time and
the DAG projection before touching any process. Treat the watch ledger and the
artifacts it names as the evidence boundary. Do not restart the audit from
repository-wide history or infer a failure from a short wait. Kill only the exact
creation-time-validated controller family if a new failed/blocked/invalid node,
unsafe route, overlapping builder, orphan mutation, or other non-closable safety
fault is observed; otherwise continue collecting phase receipts and update this
plan’s evidence notes.
### HP-18: semantic-progress watchdog (implemented 2026-08-16)

The native CLI now has a bounded semantic-progress guard. It observes durable
`RunState` changes rather than process liveness, records a watchdog receipt,
aborts the matching worker through the already-tested parent signal, and leaves
the run/worktree resumable. The frozen `maxWorkerStallMs` plan value prevents a
restart from changing the budget; legacy plans use the conservative 12-minute
default and an operator can select a bounded value on resume.

Evidence: focused watchdog tests `3/3`, `npm run build`, and native Next suite
`667/667` across 207 suites. This addresses the unbounded heartbeat-only stall
observed in #194's remediation, but it is not a claim that the ten-issue live
lane has passed yet. The next proof must show either ten authoritative closures
or a watchdog suspension with an exact, resumable checkpoint and no orphaned
process family.

Launch correction: the first operator invocation exposed a parser omission for
the new numeric `--max-worker-stall-ms` option; the command exited before
admission and made no durable change. The option is now consumed as a value and
covered by the argument-parser regression suite (`6/6`).

Live canary evidence (15:04–15:32 local): execution attempt 14 resumed the
saved DAG with an 8-minute semantic budget. The watchdog ignored heartbeats and
tool receipts, reset on real RunState changes, and suspended five heartbeat-only
workers at 481 seconds while preserving their checkpoints and releasing their
slots. Replacement nodes were dispatched without restarting the controller.
This validates bounded liveness behavior, but the ten-new-closure throughput
acceptance is still pending (`4` pre-existing completed, `5` suspended, no new
 completed closure yet).

### HP-18 correction: remove the hard cap (2026-08-16 15:50 local)

The 5-8 minute figure is a soft intent target, not a per-worker termination
budget. The prior live canary incorrectly made it a hard 8-minute watchdog;
its nine suspensions and zero new closures are invalid as a performance
acceptance result. The exact controller family was stopped with its DAG and
checkpoints intact at attempt 14; the durable projection was
`suspended=9, completed=4, queued=17, running=4, invalid=1, skipped=1`.

The active watchdog implementation was removed from the native CLI, including
its default, frozen plan field, option, and automatic abort path. Keep the
truthful heartbeat/lease repair from HP-17, plus observational telemetry for
phase age, issue-level transitions, queue/wait time, and token/cost burn. Do
not turn the soft target into an implicit timeout. Any emergency stop remains
an explicit operator action against the exact process family, with durable
resume as the recovery path.

Post-correction verification is green: `npm run build`; native Next suite
`667/667` across `207` suites. No controller was restarted after this change;
the ten-new-closure end-to-end proof remains pending and this canary does not
count toward it.

### HP-20: claim-admission integration checkpoint (2026-08-16)

The stopped live run exposed broad fallback claims and expensive retry/review
behavior. The integrated scheduler fix keeps a conflicting Build Packet scope
in the active scheduler only, so a transient retry waits instead of repeatedly
dispatching; durable node claims change only after the scope is admitted. The
claim transport is now consistently awaited, and the conflict/sink/retry tests
exercise the lifecycle rather than relying on timing.

Evidence: build green; controller/scheduler `49/49`; TUI `56/56`; full native
Next suite `696/696` across `207` suites. This is a regression-free integration
checkpoint, not proof that the saved seven-issue DAG has closed ten issues.
