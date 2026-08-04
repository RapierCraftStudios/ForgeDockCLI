<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Changelog

## Unreleased

### Added

- Provider-neutral typed ForgeDock runtime with durable v2 workflow artifacts, guarded state transitions, isolated worktrees, deterministic verification, GitHub projection, reconciliation, and resumable verification checkpoints.
- ForgeDock-branded Pi terminal with lazily activated semantic workflow tools, supervised parallel issue workers, visible nested reviewer agents, and evidence-backed human decision checkpoints.
- Source-pinned ForgeDock Pi fork and packaged runtime staging with explicit provenance and fork policy.
- Isolated live GitHub lifecycle probes covering investigation, Build Packet creation, build, verification, PR publication, parallel independent review, merge, closure, and cleanup.
- Evidence-backed orchestration DAGs with deterministic priority ordering, claim-derived serialization edges, streaming ready-set dispatch, authoritative prerequisite admission, and real P2/P3 concern batching into one batch issue/work-on unit.
- Automatic minimal `forge.yaml` bootstrap on normal parent-terminal launch, plus natural-language ForgeDock Next configuration with live-catalog model alias resolution and one setting for all worker/reviewer subagents.
- `FORGE.md` project guidance plus token-bounded, Obsidian-compatible `devdocs/` memory retrieval with anchors, links, and backlinks.
- Native session-scoped background controller tasks for direct work/review runs, with task IDs, bounded log inspection, passive completion notices, cancellation, and shutdown cleanup—without another runtime dependency.
- A dependency-free, pi-native decision interview inspired by pi-ask: tabbed single/multi/preview questions, evidence-backed recommendations, number-key selection, inline custom answers, question/option notes, dirty-dismiss protection, and a Submit/Elaborate/Cancel review step.

### Changed

- `forgedock` now launches the provider-neutral terminal; the legacy entry point remains available as `forgedock-legacy` during cutover.
- Long-term devdocs memory is explicitly reference-only and selectively retrieved; it cannot authorize actions or override current user intent and typed contracts.
- Required verification failures remain failed even when identical failures exist on the base revision; baseline comparison is retained only as non-regression evidence.
- Medium-or-higher review findings block delivery by default.
- Successful merges remove their remote delivery branch.
- Verification is serialized per machine, bounds Node test fanout, and terminates complete subprocess trees on timeout or cancellation to prevent orphaned Node workers and resource storms.
- Bundled subagent artifacts use temp storage and are excluded from delivery diffs; specialist routing now uses token boundaries to avoid accidental fanout from substrings such as `RapierCraft` or `metadata`.
- Automatic review remediation refuses changes outside the frozen Build Packet instead of widening scope and emitting oversized operational-artifact failure comments.
- npm publication now reconciles already-published versions and retries version metadata pushes against current `main` rather than wedging after a concurrent push.
- Direct terminal work/review runs background by default while orchestration children remain synchronously owned by their worker, preserving typed dependency and nested-review lifetimes.

### Fixed

- Controllers and verification commands now cross an explicit environment boundary that removes inherited Pi subagent role/routing variables. Windows verification also resolves Git Bash deterministically instead of depending on whether headed `npx forgedock` inherited Git Bash, WSL, or System32 first on PATH.
- Interrupted orchestration nodes at `building` now recover their deterministic worktree and frozen Build Packet automatically. The supervisor retains a native same-session DAG resume tool that retries only failed/blocked nodes, preserves completed nodes, and no longer offers build runs a verification-only resume path.
- `/orchestrate` no longer presents static topological phases as “batches” or launches them as a barrier chain. Batch now means an efficiency work unit that aggregates compatible findings; DAG nodes stream as their own predecessors complete, and successful batch completion projects Outcomes to and closes every member issue.
- Delivery and review worktrees now install their own lockfile-pinned dependencies before agents or verification run, preventing false baseline/build failures from missing modules.
- Process-verifier tests use isolated leases so ForgeDock can verify its own test suite without recursively waiting on the outer machine-wide verification lock.
- BuildResult acceptance evidence now carries controller-observed issue body, labels, and prerequisite-admission Outcomes/timestamps, so independent reviewers can verify GitHub-metadata and dependency-ordering criteria instead of treating repository checks as evidence.
- GitHub App credential refresh now uses a packaged cross-platform Node helper instead of passing Windows paths through Bash.
- Windows legacy verification now uses file URLs for dynamic ESM imports and path-aware orphan-symlink ownership checks.
- Pull request publication now emits a bounded compact handoff instead of duplicating large durable artifacts into the PR body, reuses an existing branch PR idempotently, and can resume the publication checkpoint without replaying build or verification.
- Workflow controllers and nested reviewers no longer carry fixed wall-clock lifetimes. Long-running healthy work remains active until completion or explicit cancellation, while owner disconnects still release reviewer listeners and verification-command and short transport-handshake timeouts remain bounded.
- Standalone read-only review runs no longer mask recoverable issue-delivery runs or project issue workflow labels; resuming `work-on` reuses the PR and retains its automatic remediate–verify–republish–re-review loop.
- Nested-review transport no longer inherits Node/Undici's hidden response-header wall-clock limit: the local bridge uses an explicitly abortable timeout-free HTTP request. Orchestration also marks observed in-flight workflow labels for resume on the first worker invocation instead of intentionally failing once before retrying.
- Read-only reviewer probes of missing optional paths are treated as negative evidence rather than fatal process errors, including inside isolated `pi-subagents` children after a schema-valid review has been submitted. Operationally failed specialists retry in fresh context without discarding successful peer reviews. Ordinary reviewer errors remain capped at one retry, while transient WebSocket/network failures receive up to three fresh retries. Repeated attempts now append a new durable failed Outcome when the cause changes instead of leaving an older failure reason as misleading semantic memory.
