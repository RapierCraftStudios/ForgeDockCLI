<!-- SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Changelog

## Unreleased

### Added

- Provider-neutral typed ForgeDock runtime with durable v2 workflow artifacts, guarded state transitions, isolated worktrees, deterministic verification, GitHub projection, reconciliation, and resumable verification checkpoints.
- ForgeDock-branded Pi terminal with lazily activated semantic workflow tools, supervised parallel issue workers, visible nested reviewer agents, and recommended multiple-choice human checkpoints.
- Source-pinned ForgeDock Pi fork and packaged runtime staging with explicit provenance and fork policy.
- Isolated live GitHub lifecycle probes covering investigation, Build Packet creation, build, verification, PR publication, parallel independent review, merge, closure, and cleanup.
- Evidence-backed orchestration DAGs with deterministic topological batching, priority ordering, conflict claims, and authoritative prerequisite admission.
- Natural-language ForgeDock Next configuration updates in a managed `forge.yaml` section.
- `FORGE.md` project guidance plus token-bounded, Obsidian-compatible `devdocs/` memory retrieval with anchors, links, and backlinks.

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

### Fixed

- GitHub App credential refresh now uses a packaged cross-platform Node helper instead of passing Windows paths through Bash.
- Windows legacy verification now uses file URLs for dynamic ESM imports and path-aware orphan-symlink ownership checks.
