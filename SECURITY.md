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
- Steps to reproduce (include relevant `forge.yaml` config, command invocation, and Claude Code version)
- Whether you have a proposed fix

### What to expect

- **Acknowledgement**: Within 48 hours
- **Assessment**: Within 5 business days
- **Fix timeline**: Coordinated with you based on severity

We will credit you in the release notes unless you prefer to remain anonymous.

## Scope

ForgeDock is a set of markdown command specs that run inside Claude Code. The primary security surface areas are:

- **`bin/forgedock.mjs`** — the npm installer that symlinks commands into `~/.claude/commands/` (always global; `--global` is accepted for backward compatibility but has no effect)
- **`commands/*.md`** — prompt specs that instruct Claude Code agents to run `gh`, `git`, and shell commands
- **`forge.yaml`** — project configuration that influences which repos and branches agents target

Vulnerabilities in Claude Code itself should be reported to [Anthropic](https://www.anthropic.com/security).

## ForgeDock Next authority and evidence assumptions

The normative contract is [`docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md`](docs/next/VERIFIABLE-WORKFLOW-AUTHORITY.md). It is documentation-only until a later implementation slice lands with the tests and evidence named in [`docs/next/IMPLEMENTATION.md`](docs/next/IMPLEMENTATION.md). The legacy Claude/Markdown surface above remains compatibility context; it is not the complete modern trust model.

- The typed ForgeDock controller is the only authority for workflow transitions, publication, review gates, merge, decomposition, and closure. Models and runtimes are bounded workers and never receive controller signing keys or unmediated host mutation rights.
- Controller identities use ForgeDock-generated Ed25519 keys. Private keys belong in a protected OS keystore or externally unlocked encrypted store, are excluded from repositories, bundles, sessions, prompts, and logs, and are separate from provider credentials, model tokens, GitHub App keys, OAuth tokens, SSH keys, and deploy keys. Missing, inaccessible, lost, or revoked keys fail closed for protected signing and authorization; they are not silently replaced.
- Protected evidence is bound to the exact repository, canonical subject, run, action, and full reviewed SHA. Legacy v2 artifacts remain readable as `legacy-unverified`; structural validity, comments, labels, events, local state, or imported bundles do not authenticate or authorize a current action.
- Unknown actions or constraints, unavailable replay/coordination state, unsupported host guarantees, stale leases, chain gaps, invalid signatures, wrong bindings, expired or revoked trust, and otherwise unverifiable evidence fail closed. GitHub remains durable semantic truth for its adapter; local state and bundles are operational or archival aids.
- Portable bundles are limited evidence exports. They must exclude private keys, provider/GitHub credentials, sessions, cookies, environment files, and worktree secrets. Offline verification cannot prove current host state, current policy, or deletion of an unanchored final evidence tail; stronger deletion claims require an authenticated retained checkpoint or witness.

Reports involving key exposure, unauthorized controller signing, bypass of exact-SHA review or merge gates, capability replay, lease fencing/split-brain, secret leakage in bundles or sessions, or an adapter that falsely reports host guarantees are security vulnerabilities. Please use the private GitHub Security Advisory route or maintainer email above, include reproduction steps and affected version/commit, and do not publish credentials or sensitive repository content in a public issue. Use the same private route for documentation that could cause a future implementation to violate these fail-closed assumptions.
