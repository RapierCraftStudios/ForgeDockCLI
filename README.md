<div align="center">

<img src="https://avatars.githubusercontent.com/in/4051319?s=200&v=4" alt="ForgeDock" width="80" />

<h1>ForgeDock</h1>

<p><strong>Point it at an issue and get a merged, reviewed PR; point it at a <strong>milestone</strong> and get parallel pipelines with conflict-aware scheduling.</strong></p>

<p>LLMs generate the code. ForgeDock owns everything else — <strong>state, scheduling, recovery, review, and memory</strong> — as durable, inspectable structure on the GitHub you already have. Issues are the queue. PRs are the ledger. Annotations are the memory. Deterministic orchestration for autonomous software engineering.</p>

<p><em>ForgeDock (not ForgeRock) — this project is unrelated to ForgeRock's identity and access management platform.</em></p>

<p>📖 <a href="https://rapiercraftstudios.github.io/ForgeDock/">Full documentation site</a></p>

<a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg" alt="License: AGPL-3.0" /></a>
<a href="https://github.com/RapierCraftStudios/ForgeDock/stargazers"><img src="https://img.shields.io/github/stars/RapierCraftStudios/ForgeDock?style=social" alt="GitHub Stars" /></a>
<a href="https://github.com/RapierCraftStudios/pi"><img src="https://img.shields.io/badge/Terminal-ForgeDock%20Pi%20fork-ff8c1a" alt="Powered by the ForgeDock Pi fork" /></a>
<a href="https://www.npmjs.com/package/forgedockcli"><img src="https://img.shields.io/npm/v/forgedockcli?color=cb3837&logo=npm" alt="npm" /></a>
<a href="https://www.npmjs.com/package/forgedockcli"><img src="https://img.shields.io/npm/dm/forgedockcli?color=cb3837&logo=npm&label=downloads" alt="npm downloads per month" /></a>
<a href="https://github.com/RapierCraftStudios/ForgeDock/pulls"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" /></a>
<a href="https://github.com/sponsors/RapierCraftStudios"><img src="https://img.shields.io/badge/Sponsor-❤-ea4aaa.svg" alt="Sponsor" /></a>

</div>

<br />

<div align="center">

<img src="docs/demo.gif" alt="ForgeDock orchestrating multiple GitHub issues in parallel — agents investigate, build, review, and flip workflow labels through to merged" width="900" />

<p><em><strong>One <code>/orchestrate</code> runs a whole milestone.</strong> Agents pick up issues in parallel, drive each through investigate → build → review, and flip the GitHub labels to <code>merged</code> — live.</em></p>

</div>

**This repository builds itself with ForgeDock.** In its first 30 days (June 4 → July 4, 2026): **693 issues filed, 605 closed, 603 PRs merged — median 56 minutes from open to merged-and-closed.** 57% of those issues were filed by the pipeline itself; 49% are findings its own review agents raised, filed, and then fixed. Every run leaves a public audit trail — [click through the receipts](#watch-the-machine-work), or count them yourself:

```bash
gh issue list -R RapierCraftStudios/ForgeDock --state closed --limit 1000 --json number --jq 'length'
```

**A single run, up close** — a real one, [issue #1230](https://github.com/RapierCraftStudios/ForgeDock/issues/1230):

```console
$ /work-on #1230        "orchestrate: Layer 5 co-change signal is dead code"

  ✓ investigate    CONFIRMED/HIGH — feature shipped 3h earlier (PR #1204) reads a
                   never-populated variable; the co-change query can never fire
  ✓ build          fix branch, 1 file
  ✓ review         caught a defect in the fix itself: stray backticks in the grep
                   meant every git-log pathspec silently matched zero commits —
                   "the fix would not have actually worked." Corrected.
  ✓ merged         30m 37s → staging

  filed by the pipeline's own staging review. fixed before a human read it.
```

### Launch the ForgeDock terminal

**Requires:** [GitHub CLI](https://cli.github.com/) (authenticated), Node.js ≥ 22.19, and credentials for any Pi-supported model provider.

```bash
npm install -g forgedockcli
forgedockcli
```

The published package is `forgedockcli`; `forgedock` remains an executable
alias for compatibility with existing installations and scripts.

When testing unpublished changes from a source checkout, use the checkout-safe launcher instead:

```bash
npm run terminal
```

`npx forgedockcli` resolves the installed/cached ForgeDock Next package; it does not implicitly run unpublished files from the current repository. Use `/forgedock-runtime` to verify the `semantic-tools+live-subagents-v2` runtime, bundled delegation bridge, and resolved package root on demand; the idle terminal does not reserve space for a persistent runtime widget.

When orchestration is active, press `←` or `↓` on an empty editor to focus the worker fleet, select a worker, and press `Enter` to open its live controller transcript. ForgeDock expands tool arguments and streaming output by default; press `x` (or `Ctrl+O`) to toggle the compact view.

ForgeDock now ships a source-maintained [Pi fork](https://github.com/RapierCraftStudios/pi) with ForgeDock's Chrome & Ember identity. First launch guides you through terminal appearance, provider authentication, and explicit model selection. The terminal exposes native `/deep-plan` plus controller-backed `/work-on`, `/review-pr`, `/orchestrate`, and `/forgedock-status` commands. `/deep-plan` runs a confirmation-gated planning interview; only a separate post-confirmation `materialize` action, bound to the exact confirmed packet and an explicit `owner/repo`, can create the idempotent GitHub issue DAG. Materialization returns an orchestration-ready handoff but never dispatches workers. Each command lazily activates its own semantic native tool, so the selected model can interpret natural-language intent without loading large Markdown workflow specs into every conversation.

Direct work and review runs start as native background controller tasks by default. Normal TUI shutdown detaches still-running native tasks so a later local supervisor can reconcile or adopt them; `/forgedock-tasks cancel <task-id>` remains an explicit process-tree cancellation. Standalone `/review-pr` owns the configured PR CI/mechanical gate while keeping product-review remediation separate from `/work-on`: its safe default asks the user to fix failed checks, while `next.review.ci.failure_action: "auto-fix"` permits bounded, independently verified commits to a same-repository PR head without amend or force-push. When GitHub reports an empty required-check projection, ForgeDock honors the advisory review request with a visible durable warning instead of inventing a CI failure or refusing to dispatch reviewers.

CLI and TUI orchestration share one typed durable controller. Natural-language selection becomes typed discovery evidence before the controller freezes repository membership, priorities, semantic dependencies, delivery targets, and predicted claims. By default, each selected issue is one visible DAG node and consumes one top-level `work-on` issue slot when running; `maxParallel` is the issue-slot budget, while transport capacity may reduce actual dispatch. An explicitly contracted batch remains one node and one pipeline but consumes one slot per member; an indivisible batch larger than the cap may run alone to avoid deadlock. Completed nodes remain completed on explicit resume, and live native workers are reconciled before any relaunch.

Semantic dependencies and conflict claims are deliberately different. A dependency requires an authoritative successful predecessor Outcome. A path/component claim only serializes overlapping work in the same repository and against the same delivery target, and releases when its predecessor becomes terminal. Build Packet paths refine live claims; a worker deferred by a claim refreshes the exact target before dispatch. The board reports selected and runnable-now issue demand plus requested, sampled-transport, and effective caps; it never labels runnable demand as active occupancy. Node status and typed semantic-dependency, claim, capacity, suspended-recovery, and decomposition waits explain what is actually running or queued. Activity and idle decisions use controller-observed semantic events rather than undifferentiated output bytes.

Batching is off by default and requires an explicit policy opt-in. Eligible ordinary issues and review findings may share one pipeline only when their typed concern, route, dependency, risk, and scope contracts are compatible; sensitive security/auth surfaces require exactly two members plus matching causal-family and secondary proof, and are hard-capped at two even if a higher configured sensitive size is supplied. A successful batch Outcome is projected to every member before the controller closes member issues. Use native DAG status/resume or `forgedock-next status --orchestration <dag-id>` and `forgedock-next orchestrate --resume <dag-id>` after interruption.

Verification v2 discovers a bounded catalog from the refreshed exact base and executes only the frozen Build Packet selection: `git diff --check`, at most one safe direct TypeScript integrity command, and targeted direct `node --test` when supported. It does not inherit lint, docs, broad `npm test`, or nested coverage from package-script prose. Node test fanout is bounded, timeout/cancellation terminates the complete subprocess tree, and legacy commands retain conservative machine-global serialization while current v2 commands use `lockScope: "workspace"`, meaning they do not take that global lease (it is not a per-workspace filesystem lock). Criterion evidence must carry frozen paths, symbols, test/invariant IDs, and passing command IDs; a generic green build cannot prove semantic acceptance.

Required hosted CI remains separate live external authority. Auto-merge requires a nonempty set of GitHub-required checks, authoritative provenance, and passing observations for the exact reviewed PR SHA; configured names, arbitrary checks, historical runs, or no required checks do not count as success. Pending checks and unknown mergeability are polled until authority changes, cancellation, or lease loss; failed, contradictory, cancelled, conflicting, or unavailable authority fails closed. This fail-closed rule governs merge authorization, not whether an explicitly requested advisory review may run.

A verification repair uses a fresh bounded builder session but, within one live controller, receives the prior submission/session reference and exact failed-check Outcome so it can amend rather than reconstruct the frozen checklist. Repairs cannot widen packet scope and are independently reverified. After process restart, the durable failure Outcome preserves evidence, but the explicit prior submission/session reference is not reconstructed.

Review findings retain durable `FindingRootLedger` identities across exact-SHA reviews. A schema-v4 closure plan classifies the proven prior-to-current delta and requires every open, fix-attempted, or regressed root to be explicitly assessed; omission is not closure. `mustFix` is a controller-owned remediation obligation distinct from final `blocking`: an accepted medium root may be nonblocking yet still force `request_changes`. Every open `mustFix` or legacy blocking root survives bounded remediation, re-verification, and fresh exact-SHA closure review until owner roles and correctness provide resolution evidence. Subagent transcripts stay in temporary operational storage, and automatic remediation cannot expand beyond authorized scope.

> **Dogfood status (2026-08-18):** these controls are implemented and locally testable, but readiness is not claimed. Certification remains open across focused invariants, controlled lifecycle faults, small live DAGs, and repeated staging runs; see [`docs/next/DOGFOODING-IMPLEMENTATION.md`](docs/next/DOGFOODING-IMPLEMENTATION.md).

`forge.yaml` remains the project configuration file. ForgeDock Next creates a minimal marker-bounded file when one is absent, and `/forgedock-config <preference>` updates the managed section while preserving unrelated user content. Model, thinking, concurrency, and merge settings are resolved through the live authenticated catalog and typed controller. `FORGE.md` is explicit user-maintained project guidance, and `/forgedock-remember` can persist a preference or a structured decision. `devdocs/` is reference-only memory: ForgeDock retrieves compact anchored summaries, links, and backlinks, and memory can never authorize actions or override current intent or typed contracts. The fork is an internal interaction kernel; ForgeDock is the product identity, and its typed controller remains the sole owner of workflow transitions, verification, GitHub publication, review gates, and merge authority.

### ForgeDock Next local safety bootstrap

Mutating Next controllers require an authenticated retained lease witness. The
interactive terminal creates the single-machine, single-checkout witness on
first dispatch. Headless and direct CLI use remains explicit; from the canonical
checkout, build once and bootstrap it once:

```bash
npm run build
node bin/forgedock-next.mjs lease-witness-bootstrap
```

The command generates a non-overwriting Ed25519 key and signed checkpoint in OS-local user data, outside `.forgedock/state.db`, and writes only ignored path references to `.forgedock/lease-witness.json`. Private-key permissions are restricted where the operating system supports POSIX modes. A complete `FORGEDOCK_LEASE_WITNESS_PATH` / `FORGEDOCK_LEASE_WITNESS_PUBLIC_KEY` / `FORGEDOCK_LEASE_WITNESS_PRIVATE_KEY` environment configuration remains the highest-priority explicit override; partial configuration fails closed.

This bootstrap fences processes using one canonical checkout on one machine. It is not cross-machine or cross-checkout coordination, and copying or rolling back the SQLite database without the independently retained witness requires explicit authenticated recovery. Confirmed Deep Plan packets currently live only in the active TUI session, so finish and materialize before restarting the terminal. Detached native tasks remain locally adoptable, but loss of their owning bridge may require explicit DAG resume.

> ⭐ **If ForgeDock saves you time, [star the repo](https://github.com/RapierCraftStudios/ForgeDock/stargazers)** — it's the whole marketing budget.

---

**Your AI coding agent forgets everything after every session.** It re-explores the codebase from scratch, re-makes mistakes that were already fixed, and has no idea why the code it's touching looks the way it does. ForgeDock fixes that by making **GitHub itself the memory** — every pipeline stage writes structured findings that every later agent reads.

## Without ForgeDock vs. With ForgeDock

| Without ForgeDock | With ForgeDock |
|---|---|
| Agent starts every session blind — no context from prior work | Agent reads structured investigation, root cause, and history straight from GitHub |
| The same bugs get reintroduced across PRs | Review agents surface known pitfalls from past PRs *before* you commit |
| A crash or compaction loses the run | State lives on GitHub and in an event-sourced run log — the pipeline resumes where it stopped |
| You write the issue, plan the fix, open the PR, and review it | `/work-on #42` → investigated, built, reviewed, merged |
| Review depends on whoever has capacity | 9 domain-specialist agents (security, billing, DB, concurrency…) review every PR |
| One task at a time, serialized by your attention | `/orchestrate` runs a whole milestone through a streaming DAG; compatible findings can share one pipeline |

---

## The idea in one paragraph

AI agents have **no lookback**. They don't know a function was shaped by a bug fix in #347, that an approach was tried and reverted in PR #891, or that three other files need the same change. Context window isn't the bottleneck — **memory is.** But GitHub already stores everything an agent needs: commits, PRs, issues, blame, cross-references. It's a citation graph; agents just don't use it as one. ForgeDock makes every stage write **machine-readable annotations** to issues and PRs, and every downstream agent read them. The `gh` CLI becomes the query interface to institutional memory. The result: agents that follow structured data, not vibes.

```
┌──────────────────────────────────────────────────────────────────┐
│                     GITHUB (Knowledge Graph)                     │
│                                                                  │
│  Issues:  FORGE:INVESTIGATOR → FORGE:CONTEXT → FORGE:ARCHITECT   │
│           → FORGE:TRAJECTORY (the run's full audit trail)        │
│  PRs:     FORGE:BUILDER → structured review FINDING blocks       │
│  Links:   git blame → commit → PR → issue → related issues       │
│                                                                  │
│  Every agent reads this. Every agent writes to it.               │
│  Nothing is lost between conversations.                          │
└──────────────────────────────────────────────────────────────────┘
```

---

## Watch the machine work

Not a staged demo — these are real, public runs on this repository. Open any of them and read the full trail:

- **[#1230](https://github.com/RapierCraftStudios/ForgeDock/issues/1230)** — the pipeline's staging review caught dead code in a feature the pipeline had shipped three hours earlier; review then caught a bug in the fix itself. Intent to merged: **30 minutes**.
- **[#1172](https://github.com/RapierCraftStudios/ForgeDock/issues/1172)** — review found an `ANTHROPIC_API_KEY` exfiltration path in the headless runner (an in-process file read bypassed the env scrub), with exact line evidence. Fixed and merged in **18 minutes**, with regression tests. A later re-review found a second-order bypass of the first fix ([#1243](https://github.com/RapierCraftStudios/ForgeDock/issues/1243)) — the pipeline red-teams its own fixes.
- **[#952](https://github.com/RapierCraftStudios/ForgeDock/issues/952)** — the investigator closed the pipeline's *own proposal* as INVALID with receipts: the deliverable had already shipped weeks earlier. Zero code written, 34 minutes, full explanation.
- **[#1256](https://github.com/RapierCraftStudios/ForgeDock/issues/1256)** — decomposition that respects the existing graph: it created only the two net-new sub-issues no open issue already claimed, then sequenced three existing issues into the dependency order.
- **[#1322](https://github.com/RapierCraftStudios/ForgeDock/issues/1322)** — a heavyweight feature (the durable execution engine itself): 9 TDD tasks, whole-branch review caught two Criticals pre-merge, merged in **under 2 hours**.

And the part that makes it compound — the context phase citing past bugs *by number* before a line is written (from [#1196](https://github.com/RapierCraftStudios/ForgeDock/issues/1196)):

> "`commands/orchestrate.md` has a dense review-finding history from PR #1081/#1107/#1126… associative-array declaration mistakes (#1113), array-element removal via pattern substitution corrupting partial matches (#1108)… the new Layer 5 subsection should not introduce a competing edge-direction convention that could reintroduce a cycle class."

> Numbers on this page are point-in-time (2026-07-04), from this repository's first 30 days of dogfooding. A reproducible cost-per-issue benchmark is a hard gate on our own launch plan — [#1264](https://github.com/RapierCraftStudios/ForgeDock/issues/1264): no estimated efficiency claims.

---

## Orchestrate an entire milestone

`/work-on` ships one work unit. **`/orchestrate` ships a milestone.** It builds a dependency DAG and streams each ready issue as soon as its own semantic predecessors complete. The default is one selected issue per visible node and one top-level pipeline slot; explicit batching may contract compatible ordinary issues or review findings into one durable issue and one `/work-on` pipeline, while still charging one `maxParallel` issue slot per member. Every member closes only after the shared unit is verified, reviewed, and completed. On this repo's record day, that meant **29 issues taken to merged inside a single hour**.

Scheduling is conflict-aware before it is parallel. Typed discovery proposes dependencies and predicted path/component claims; the controller validates and freezes them. Semantic dependencies require successful predecessor Outcomes. Claims are release-only serialization constraints for overlapping work in the same repository and against the same target, become more precise from Build Packet paths, and release at any terminal predecessor state. There are no static execution waves: the scheduler continuously streams the ready set up to `maxParallel`, constrained by available transport. Exact wait reasons remain visible, and claim-deferred workers refresh the target before starting.

<div align="center">
<img src="assets/orchestration.svg" alt="One milestone fanned out into parallel work-on pipelines, each issue advancing through investigating, building, in-review, and merged" width="920" />
</div>

```bash
/orchestrate milestone/checkout-v2     # resolve → streaming conflict-aware DAG → merged PRs
```

---

## How it works

Each stage reads the structured output of the stages before it and writes its own findings back:

```
Issue → Investigate → Context → Architect → Build → Quality Gate → Review → Merge
              └──────────── each stage reads & writes GitHub ────────────┘
```

| Stage | Reads | Writes |
| --- | --- | --- |
| **Investigate** | Issue body, `git blame`, related issues/PRs | `FORGE:INVESTIGATOR` — verdict, root cause, affected files, severity |
| **Context** | Historical findings from related PRs, known pitfalls | `FORGE:CONTEXT` — institutional memory for this module |
| **Architect** | Investigation + context | `FORGE:ARCHITECT` — ordered plan, code paths, risks |
| **Build** | Everything above | `FORGE:BUILDER` — branch, commits, files changed |
| **Quality Gate** | Builder output, domain-specific checks | gate results, recorded in the run's trajectory |
| **Review** | PR diff, contract, gate results | `FORGE:REVIEW_STARTED` on the issue; per-agent findings as structured `FINDING` blocks on the PR |
| **Close** | All of the above | `FORGE:TRAJECTORY` — the full audit trail of the run |

**GitHub as the database.** Every annotation is wrapped in an HTML comment (`<!-- FORGE:INVESTIGATOR -->`) that makes it machine-parseable. When an agent starts — even in a brand-new conversation after compaction — it queries the issue via `gh` and reconstructs full context from these tags. Workflow labels (`workflow:investigating`, `workflow:in-review`, `workflow:merged`…) track state, and the pipeline resumes from whatever state GitHub reports. The annotation format is an open standard — see the [FORGE Annotation Protocol](docs/spec/forge-protocol-v1.md).

**Durable by design.** Headless runs are backed by a real execution engine, not prompt-hope: every phase transition is appended to an event-sourced, crash-safe run log, mirrored to the issue as a compact `FORGE:STATE` index, and guarded by leases so two agents can never own the same issue. Kill the process mid-run and restart it — the engine reconciles local state against GitHub (GitHub wins), adopts branches and PRs that already exist instead of re-running the LLM, and escalates to `needs-human` after bounded retries instead of looping. Phase selection is a pure rule-based state machine: **the engine, not the model, decides what happens next.** The headless core shipped in [PR #1326](https://github.com/RapierCraftStudios/ForgeDock/pull/1326); wiring the interactive path onto the same engine is in progress ([#1323](https://github.com/RapierCraftStudios/ForgeDock/issues/1323)–[#1325](https://github.com/RapierCraftStudios/ForgeDock/issues/1325)).

**Domain-specialist review.** Every PR is reviewed by agents with deep, narrow expertise — Security, Auth & Access Control, Billing Integrity, Database, Concurrency, Frontend, API, Performance, Infrastructure. Findings carry a confidence level, and a **reproduction gate** keeps them honest: a finding only blocks if the reviewer traced an actual code path or input that triggers it — pattern-match suspicions are downgraded, not merged into noise. Findings above the severity threshold are **automatically filed as new issues** that enter the same pipeline: on this repo, that loop produced 49% of all issues ever filed.

**It measures itself.** `/pipeline-health` correlates every prompt change against review-finding rates, build failures, and manual fix-up commits, then files its own report — including failing grades — as an issue. `/autopilot` pulls production signals (errors, CI failures, stale issues, analytics), files issues from them, and optionally runs `/work-on` on the top ones. The pipeline also invalidates its own bad ideas: proposals that turn out to be already-shipped or wrong are closed `workflow:invalid` with the reasoning attached ([example](https://github.com/RapierCraftStudios/ForgeDock/issues/952)).

---

## Built for the ways agents fail

Every mechanism above exists because autonomous agents fail in predictable ways. The skeptics are right about the failure modes — the answer is structure, not optimism:

| "We've all seen this go wrong…" | The mechanism |
| --- | --- |
| Parallel agents just turn typing time into *reading* time | Review is a pipeline stage: domain specialists with confidence ratings and a reproduction gate — not a pile of raw diffs |
| Agents game their own checks (or delete the tests) | Builders never grade their own work — the quality gate and reviewers are separate agents reading the diff cold |
| Third retry = increasingly creative excuses | Engine-owned state machine: bounded retries, then escalation to `needs-human` |
| One runaway agent wrecks the codebase | 1 issue = 1 agent, bounded by decomposition; conflict-aware scheduling; isolated worktrees |
| No institutional memory — "it can't read the Slack thread from 2023" | Every run writes citable annotations to GitHub; the context phase quotes past bugs by number |
| No way to tell when an agent drifts | A `FORGE:TRAJECTORY` receipt on the issue records what every phase actually did |
| Humans rubber-stamp 95%-good output | Specialist review raises the floor *before* a human looks at the PR |
| The economics are opaque | ForgeDock runs on your existing Claude account — it resells no compute and takes no per-task cut. Cost-per-issue benchmarks are tracked in the open ([#1264](https://github.com/RapierCraftStudios/ForgeDock/issues/1264)) |

---

## Commands

**The core loop:**

| Command | What it does |
| --- | --- |
| **`/deep-plan`** | Confirmation-gated planning, explicit GitHub issue-DAG materialization, then a separately confirmed orchestration handoff |
| **`/work-on`** | Full issue lifecycle: investigate → build → quality gate → review → merge |
| `/orchestrate` | A whole milestone through a streaming typed DAG; one issue per visible slot by default, with explicit compatible batching available |
| `/issue` | Creates pipeline-ready GitHub issues |
| `/milestone` | Create, manage, and ship milestones |
| `/review-pr` | Context-aware PR review with domain-specialist agents |
| `/quality-gate` | Pre-commit checks, gated by the domains your change actually touches |
| `/test-gate` | Acceptance verification against running code before anything deploys |

**Observe & recover** — the durable-state story, as commands:

| Command | What it does |
| --- | --- |
| `/pipeline-status` | Fleet view of every in-flight issue, straight from workflow labels |
| `/pipeline-resume` | Resume an interrupted run from whatever state GitHub reports |
| `/diagnose` | Trace why a run failed, from its annotations |
| `/explain` | Translate the FORGE annotations on any issue into plain language |
| `/replay` | Replay a past run's full audit trail |
| `/changelog` | Release notes assembled from merged PRs and trajectory receipts |

**Ops:**

| Command | What it does |
| --- | --- |
| `/deploy-info` | Staging vs. main diff with risk assessment |
| `/rollback` | Automated revert PR for production incidents |
| `/autopilot` | Production signals → triaged issues → fixes |
| `/security-audit` | Multi-phase security posture audit |
| `/cleanup` | Sweeps stale issues, branches, worktrees |

More ship today (web-property analytics, browser QA sweeps, self-benchmarking) — see the [full command reference](docs/site/command-reference.md). A leaner, tiered install that keeps the core loop front and center is planned in [#1257](https://github.com/RapierCraftStudios/ForgeDock/issues/1257).

---

## Install

ForgeDock Next is distributed as the `forgedockcli` npm package.

**Requirements:** [GitHub CLI](https://cli.github.com/) (authenticated), Node.js ≥ 22.19, and credentials for a Pi-supported model provider.

```bash
npm install -g forgedockcli
forgedockcli
```

For a one-off run:

```bash
npx forgedockcli
```

The `forgedock` executable remains an alias for compatibility with existing
installations and scripts. The published package contains the ForgeDock Next
terminal and runtime only; legacy command/spec trees are intentionally excluded
from the npm tarball and remain recoverable in the source repository during the
transition.

ForgeDock Next commands are native terminal commands such as `/work-on`,
`/review-pr`, `/orchestrate`, and `/forgedock-status`. For unpublished source
changes from this repository, use:

```bash
npm run terminal
```

The package is free and open-source. It runs the pipeline using your own
provider account; no compute is resold or marked up.

---

## For companies

The core is AGPL-3.0 and stays that way: engineers run the full pipeline on their own Claude account, forever free.

Two things are for sale:

- **A [commercial license](COMMERCIAL-LICENSE.md)** — for organizations that need ForgeDock inside proprietary workflows or products without AGPL copyleft obligations. Contact [support@rapiercraftstudios.com](mailto:support@rapiercraftstudios.com).
- **The fleet layer** *(in development)* — org-wide observability over every pipeline run: the receipts on this page, live, across all your repos, plus policy controls and audit-grade provenance for autonomous merges. We're onboarding a small group of design partners — see [ForgeDock for Companies](docs/site/for-companies.md) for details and intake.

---

## Where it's going

Month one built the execution layer. The open roadmap — tracked in the [five-foundations epic (#1320)](https://github.com/RapierCraftStudios/ForgeDock/issues/1320) — is about earning trust while unattended:

1. **Durability** — engine-owned state instead of prose-owned state. Headless core shipped ([PR #1326](https://github.com/RapierCraftStudios/ForgeDock/pull/1326)); interactive wiring in progress.
2. **Verification** — an outcome-based acceptance gate and a graded eval corpus, so "done" is machine-checkable before anything claims success. Per-release pipeline scorecards are published in [`docs/eval/`](docs/eval/README.md); model upgrades follow the [model-release playbook](docs/articles/model-release-playbook.md).
3. **Learning** — per-codebase memory that compounds across runs.
4. **Economics** — per-run cost accounting and risk×cost dispatch decisions.
5. **Provenance** — signed, replayable records of every autonomous change.

Marketing is held to the same standard: [#1264](https://github.com/RapierCraftStudios/ForgeDock/issues/1264) gates our own launch on measured cost-per-issue benchmarks — no estimated claims.

---

## Show your support

Using ForgeDock in your pipeline? Add the badge — each one is a backlink and a signal to other developers:

```markdown
[![Built with ForgeDock](https://raw.githubusercontent.com/RapierCraftStudios/ForgeDock/main/assets/built-with-forgedock.svg)](https://github.com/RapierCraftStudios/ForgeDock)
```

[![Built with ForgeDock](assets/built-with-forgedock.svg)](https://github.com/RapierCraftStudios/ForgeDock)

---

## Star History

<div align="center">

<a href="https://star-history.com/#RapierCraftStudios/ForgeDock&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=RapierCraftStudios/ForgeDock&type=Date&theme=dark" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=RapierCraftStudios/ForgeDock&type=Date" width="600" />
  </picture>
</a>

</div>

---

## Docs & community

- [GitHub Is Already Your Agents' Memory](docs/site/github-is-the-memory.md) — the canonical argument: why GitHub is the right place for agent memory, how FORGE annotations make it machine-readable, and how to adopt the protocol without ForgeDock
- [Getting Started in 5 Minutes](docs/site/getting-started.md)
- [How the Knowledge Graph Works](docs/site/how-it-works.md)
- [What Are Those FORGE Comments?](docs/site/annotations-explained.md) — 2-minute explainer for annotations you meet in the wild
- [FORGE Annotation Protocol](docs/spec/forge-protocol-v1.md) — the open standard for AI context passing (CC-BY-4.0)
- [ForgeDock vs. Manual Claude Code Workflows](docs/site/vs-manual-workflows.md)
- [ForgeDock vs. DeepWiki, AGENTS.md, and Cursor Memories](docs/comparison.md)
- [Command Learning Path](docs/site/command-learning-path.md) — which commands to learn first
- [Complete Command Reference](docs/site/command-reference.md)
- [Troubleshooting & Recovery](docs/site/troubleshooting.md)
- [Pipeline Eval Scorecards](docs/eval/README.md) — per-release published results for every model/Claude Code upgrade
- [Model-Release Upgrade Playbook](docs/articles/model-release-playbook.md) — how to validate a new model before adopting it

**Contributing:** PRs welcome — every change goes through a PR, tested against 3+ scenarios, using conventional commits (`fix(command):`, `feat(command):`). **License:** [AGPL-3.0](LICENSE) — free to use, modify, and distribute; network use of modifications must be open-sourced under the same license. Commercial licenses are available for proprietary use — see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

<div align="center">
<br />
<p>Built and dogfooded in production by <a href="https://github.com/RapierCraftStudios">RapierCraft Studios</a>.</p>
</div>
