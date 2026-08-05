# Security Policy

## Supported Versions

ForgeDock is distributed as an npm package. We support the latest published version on npm. If you are running an older version, please update to the latest before reporting a vulnerability.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a vulnerability in ForgeDock — including issues that could allow malicious repositories to execute arbitrary commands, expose credentials, or bypass intent guards — please report it privately:

1. **GitHub Security Advisories (preferred)**: Use [GitHub's private vulnerability reporting](https://github.com/RapierCraftStudios/ForgeDock/security/advisories/new) to submit a report confidentially.

2. **Email**: If you prefer, email the maintainers via the contact listed on the [GitHub profile](https://github.com/RapierCraftStudios).

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce (include relevant `forge.yaml` config, command invocation, and runtime/version details)
- Whether the issue involves controller-key custody, artifact verification, host capabilities, leases, or portable evidence
- Whether you have a proposed fix

### What to expect

- **Acknowledgement**: Within 48 hours
- **Assessment**: Within 5 business days
- **Fix timeline**: Coordinated with you based on severity

We will credit you in the release notes unless you prefer to remain anonymous.

## Controller keys and trust assumptions

The typed ForgeDock controller is the only authority for workflow transitions, publication, verification gates, review, merge, and closure. Controller signing keys are installation-specific Ed25519 keys held by an OS-protected or hardware-backed key store and are never placed in repositories, bundles, logs, model context, provider credentials, GitHub App credentials, or model sessions. Provider/API credentials and GitHub App installation credentials are separate from controller identity and MUST NOT be reused as signing keys.

Rotation requires a protected transition record linking the retiring and replacement public keys. On loss or suspected compromise, protected publication and key-dependent gates stop, the key is revoked/retired, and a new identity is created unless a verifiable transition establishes continuity. Historical signatures remain checkable with archived public keys, but current revocation freshness is not guaranteed offline. A signature proves integrity of signed bytes and exact subject/run/action/SHA binding; it does not prove that a trusted controller made a correct decision or that external claims were true.

The controller fails closed when a required key, signature, chain predecessor, capability, compare-and-swap/fencing guarantee, exact reviewed SHA, or current policy check is absent, malformed, stale, or unverifiable. Models, local state, event consumers, leases, host comments, and imported material cannot authorize a host mutation or become a competing live controller.

## Portable evidence limitations

Portable bundles contain public verification material and bounded artifacts/events, never private keys, provider credentials, GitHub App credentials, lease secrets, workspace contents, or session transcripts. Offline verification can check canonical bytes, digests, signatures, bindings, and observed chain links, but cannot establish current repository state, current host policy, fresh revocation status, or that an unanchored final tail was never deleted. Imported bundles are archival evidence and must be revalidated before use; they never authorize publication, review, merge, closure, or lease acquisition.

The normative details, compatibility states, and size limits are maintained in [`docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md`](docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md). These assumptions do not change the private reporting channels above.

## Scope

ForgeDock includes the legacy markdown command surface and the ForgeDock Next typed controller. The primary security surface areas are:

- **`bin/forgedock.mjs`** — the npm installer that symlinks commands into `~/.claude/commands/` (always global; `--global` is accepted for backward compatibility but has no effect)
- **`commands/*.md`** — prompt specs that instruct Claude Code agents to run `gh`, `git`, and shell commands
- **`forge.yaml`** — project configuration that influences which repos and branches agents target
- **ForgeDock Next controller, host adapters, and protected evidence** — typed transitions, exact repository/SHA bindings, capability gates, lease fencing, and the controller-key custody boundary described in [`docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md`](docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md)

Vulnerabilities in Claude Code itself should be reported to [Anthropic](https://www.anthropic.com/security).
