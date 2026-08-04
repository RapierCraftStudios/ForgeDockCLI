# Security Policy

## Supported versions

ForgeDock is distributed as an npm package. Security fixes target the latest published version. Please reproduce against the latest version when practical, but report a suspected vulnerability even if upgrading is not safe or the affected version is older.

## Reporting a vulnerability

**Do not report vulnerabilities through public GitHub issues, discussions, pull requests, workflow artifacts, logs, or portable evidence bundles.**

Use one of these private channels:

1. **Preferred:** [GitHub private vulnerability reporting](https://github.com/RapierCraftStudios/ForgeDock/security/advisories/new).
2. **Email:** contact the maintainers through the address listed on the [RapierCraft Studios GitHub profile](https://github.com/RapierCraftStudios).

Do not include live controller private keys, provider/GitHub tokens, cookies, user data, or repository secrets. Use synthetic credentials and redact raw logs. If safe, include:

- impact, attack preconditions, and whether a model, repository contributor, host user/app, local process, or imported bundle is the attacker;
- exact ForgeDock package/commit, Node version, operating system, model runtime and adapter version, model/provider class, host type/instance, and relevant host-adapter capability response;
- affected canonical repository/subject/run/action and exact full SHA using synthetic or redacted identifiers;
- minimal configuration and invocation, observed verification state/reason, key lifecycle state, lease fence/CAS state, and reproduction steps;
- whether publication, review, merge, closure, replay prevention, bundle parsing, or secret isolation was bypassed; and
- a proposed fix or disclosure constraints, if any.

We aim to acknowledge reports within 48 hours and provide an initial assessment within five business days. Remediation and coordinated disclosure timing depend on severity and deployment impact. We credit reporters unless anonymity is requested.

## Security architecture and assumptions

ForgeDock is not only a set of Markdown command specifications. Its security surfaces include the typed workflow controller and transition policy, model/runtime boundary, workspace tools, artifact codecs and reconciliation, Git/worktree/process services, controller identity and key store, SQLite/local state, host adapters and credentials, semantic capabilities, review/merge freshness checks, workflow events, leases/fencing, portable-bundle parsers, configuration, the terminal/CLI, legacy commands, and package installation.

The normative future protected-evidence and portability contract is [Verifiable Workflow Authority and Portability](docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md). The currently implemented `forgedock.artifact/v2` format is structurally validated but unsigned; it must not be reported as cryptographically protected. The contract defines future required behavior and does not imply that protected envelopes, controller signing, capabilities, distributed leases, events, or bundles are already implemented.

Core assumptions are:

- The typed controller alone authorizes transitions, publication, review decisions, merge, closure, and host mutation. Models and Pi/other runtimes are untrusted bounded inputs, not authority.
- GitHub is durable semantic truth for the GitHub adapter, but host content and availability can be modified, deleted, reordered, stale, or unavailable. Local databases, worktrees, sessions, events, leases, and bundles are operational, projection, coordination, or archival aids.
- A protected operation must fail closed if canonical bytes, identity trust, exact repository/subject/run/action/SHA binding, capability/replay checks, chain continuity, or its required host read-back/freshness/CAS guarantee cannot be verified.
- Host adapters and their authenticated capability discovery are part of the trusted computing base only after conformance. A check-then-act adapter without atomic expected-head/CAS behavior cannot safely emulate that guarantee.
- Cryptography proves provenance and mutation evidence under its assumptions; it does not prove the correctness or truth of signed model-provided claims, controller policy, signer behavior, host completeness, or availability.

## Controller key handling

Future controller signing keys must be generated from an operating-system CSPRNG and isolated in a narrow controller identity/signing component. Private keys must never enter prompts, model tools, worker environments, host comments, logs, session files, portable bundles, or ordinary configuration. Model-provider tokens, GitHub App/user/OAuth credentials, SSH keys, and other host credentials must never be reused as signing keys.

Private material should be non-exportable where available and otherwise encrypted at rest with least-privilege access. Backups require separate encryption, access control, rollback protection, and recovery testing. Public identity history, rotations, retirements, and revocations must be durably retained for historical verification. Rotation must preserve signed continuity or use an approved trust root. Suspected compromise requires immediate signing stop and scoped, effective-time revocation; simple key loss requires stop/rotation and retention of the public history. Restoring an uncertain or rolled-back key store must fail closed.

Never attach real key material to a vulnerability report. A report about key handling should use a synthetic test identity and describe storage provider, lifecycle state, and access boundary.

## In-scope vulnerability classes

Reports are in scope when they can cause or materially increase risk of:

- typed transition, verification, publication, review, merge, closure, or decomposition policy bypass;
- prompt/model/runtime output becoming direct controller or host-mutation authority;
- workspace, symlink, process, command, or worktree confinement escape;
- credential, signing-key, sensitive configuration, or private repository data exposure;
- canonicalization disagreement, duplicate-key confusion, signature/digest substitution, algorithm/version downgrade, key-ID or trust-root substitution, rotation/revocation bypass, or identity-history rollback;
- repository, host instance, immutable repository ID, issue/PR, run, artifact, action, audience, capability, lease fence, or reviewed full-SHA binding bypass;
- capability broadening, unknown-constraint fail-open behavior, expiry/clock bypass, delegation escalation, nonce reuse, duplicate side effect, or replay acceptance;
- accepting malformed, mixed, gapped, forked, replayed, unsupported, legacy-unprotected, or otherwise unverifiable evidence at a protected gate;
- stale review/check data, non-atomic expected-head merge, publication without exact read-back, false host-capability claims, or check-then-act/CAS races;
- lease takeover, heartbeat/release race, fencing rollback, stale-owner mutation, split brain, or falsely claiming local coordination as distributed;
- workflow event ordering/gap/unknown-version defects that allow an event or projection to authorize a decision;
- portable-bundle path/duplicate/parser confusion, decompression or resource exhaustion, trust-root substitution, secret inclusion, partial import, or imported evidence entering live reconciliation/identity/lease/mutation state;
- installer, dependency, package, terminal/CLI, `forge.yaml`, legacy command, or adapter behavior that crosses a documented authority or confidentiality boundary.

Provider/runtime vulnerabilities independent of ForgeDock should also be reported to the applicable provider, but report ForgeDock integration failures here when our grants, validation, credential handling, or fail-closed boundary is involved.

## Portable evidence and diagnostics

Exports must be allowlisted, deterministic, bounded, and secret-free. They must exclude private keys, all credentials/tokens/cookies, environment dumps, sessions/transcripts, configuration files, local databases/worktrees, prompts containing secrets, and raw logs. Imported bundles are untrusted input: verify limits, encoding, digest/signature chains, identity/revocation history, exact bindings, duplicates, and trust roots before transactional import into a read-only archival namespace. Imported data must never become live controller identity, a lease/capability, reconciliation input, or mutation authority.

Share only the minimum diagnostic data needed for a report. Prefer hashes, synthetic fixtures, adapter versions, closed verification states/reasons, and redacted host receipts over raw workflow content.

## Limits of protected evidence

Signatures and predecessor chains can detect unauthorized mutation, substitution, replay, forks, and observed gaps. **They cannot prove that an unanchored final tail was never deleted.** If the final protected records are removed and no trusted later artifact, independent receipt, transparency checkpoint, or host audit anchor commits to them, the remaining prefix can still verify. See the normative [security guarantees and limitation](docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md#vwa-limitations).

This limitation is distinct from compromise: signatures also do not guarantee host availability/completeness, signer correctness, controller policy correctness, or the truth of signed claims. Reports that demonstrate a gap between the documented guarantee and implementation remain welcome.
