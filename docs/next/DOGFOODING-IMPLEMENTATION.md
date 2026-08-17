# ForgeDock CLI dogfooding implementation

Scope: native ForgeDock Next on the `staging` branch only. This checklist is the
implementation ledger for the GitHub projection, resumability, observation
security, review policy, and live dogfooding work. It deliberately excludes the
legacy ForgeDock system.

## Baseline

- [x] Confirm the checkout is `staging` and preserve unrelated untracked files.
- [x] Confirm the native build and test baseline (`npm run build`, `npm run test:next`).
- [x] Capture the current live evidence in `.forgedock/orchestrate-watch.md`.
- [x] Re-run the full gate after the implementation slices; final gate is recorded below.

## P0 — durable review-finding projection

- [x] Define versioned semantic finding identity separately from rendered Markdown.
- [x] Add durable projection-plan and projection-receipt artifacts.
- [x] Persist candidate/adopted/drift outcomes in the durable projection receipt and authoritative issue snapshot; retain the generic pending/materialized admission lease for other projections.
- [x] Reconcile an existing GitHub issue by semantic marker after create/readback drift.
- [x] Return and persist canonical issue numbers from finding materialization.
- [x] Make stale-finding cleanup run before the completed receipt; the verdict cannot commit until that receipt exists, and cleanup remains idempotent.
- [x] Cover create/readback, concurrency/adoption, drift, duplicate/stale cleanup, and publication crash/resume paths.

## P0 — publication-only resume

- [x] Add an explicit finding-publication checkpoint.
- [x] Resume unfinished projections without starting another reviewer/model wave.
- [x] Persist final Review Verdict only after required projection receipts exist.
- [ ] Add restart tests for every remaining GitHub side-effect boundary; the review-finding publication boundary is covered.

## P0 — stateful observation security

- [x] Add per-stream terminal parser state across output chunks.
- [x] Fail closed after dropped chunks until an explicit lifecycle reset.
- [x] Preserve parser/masking state across identity refreshes and isolate sibling streams.
- [x] Add streaming credential masking with bounded holdback.
- [x] Remove raw dropped payload retention.
- [x] Add split-sequence, split-secret, dropped-stream, reset, and boundary tests.

## P1 — review quality and platform reliability

- [ ] Run the impact policy in shadow mode against real staging PRs.
- [ ] Enforce impact-gated issue projection only after the canary passes.
- [ ] Verify exact turn/tool budget accounting and truthful phase telemetry.
- [ ] Add deterministic context/index caching after correctness is stable.
- [ ] Exercise Windows/WSL, worktree cleanup, and process-family recovery.

## Live dogfood gate

- [ ] Use a fresh small native staging DAG, not the existing noisy batch as the success fixture.
- [ ] Exercise no-finding, blocking-finding, advisory-only, partial-publication, remediation, and crash/resume cases.
- [ ] Prove one canonical issue per logical finding and zero duplicate or premature closures.
- [ ] Prove publication resume performs no duplicate reviewer work.
- [ ] Prove final verdict, PR SHA, remediation, merge, parent closure, and cleanup.
- [ ] Complete three to five successful native staging runs.

## Release

- [x] Update the native implementation checklist and changelog.
- [ ] Commit the complete staging change set.
- [ ] Push `staging` and open a `staging` → `main` pull request.
- [ ] Pass CI and review the exact merge candidate.
- [ ] Merge to `main` and verify the resulting remote state.
