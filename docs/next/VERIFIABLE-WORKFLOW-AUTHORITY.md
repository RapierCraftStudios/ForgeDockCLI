# Verifiable Workflow Authority & Portability

**Status:** normative design contract; documentation-only milestone  
**Profile:** `forgedock.protected/v1` (the protected profile is not `forgedock.artifact/v2`)  
**Audience:** implementers of ForgeDock artifact, host, runtime, lease, event, and bundle adapters  
**Normative language:** **MUST**, **MUST NOT**, **SHOULD**, and **MAY** have their usual requirements meaning.  

This document is the sole normative source for the verifiable-workflow trust contract. The projections in [`IMPLEMENTATION.md`](IMPLEMENTATION.md), [`../forgedock-next.html`](../forgedock-next.html), and [`../../SECURITY.md`](../../SECURITY.md) summarize or link here; they do not redefine bytes, authority, or failure semantics.

<a id="purpose"></a>
## 1. Purpose, scope, and invariants

ForgeDock coordinates software delivery through typed state, bounded workers, SHA-anchored review, and durable GitHub artifacts. This contract freezes the security and compatibility rules that future runtime work MUST implement before protected artifacts, delegated capabilities, distributed leases, or portable bundles are enabled.

This document specifies:

- trust boundaries and attacker assumptions;
- protected artifact bytes, digests, signatures, sequencing, and verification results;
- controller identity and key lifecycle;
- semantic capabilities and delegation;
- canonical subjects and host adapter conformance;
- controller events and distributed leases;
- portable, offline-verifiable bundles;
- compatibility and tamper-evidence limits.

It does **not** implement cryptography, change the current v2 schema or codec, add dependencies, migrate existing data, or grant a model, runtime, host, GitHub, local database, session, bundle, or lease authority over workflow transitions.

The following invariants apply throughout:

1. The typed ForgeDock controller alone decides transitions, verification gates, publication, review disposition, merge eligibility, issue closure, and decomposition.
2. GitHub is durable semantic truth for the GitHub adapter. SQLite, process state, sessions, bundles, and leases are operational or archival aids unless the controller has separately committed a decision to GitHub.
3. Models and runtimes receive no signing private keys and no unmediated authoritative host mutation rights.
4. Repository, canonical subject, required run, action, complete action-specific request scope, action-specific revision binding, exact protected decision identity/currentness when applicable, and registered publication target are exact; a nearby or abbreviated value is not equivalent. Actions registered without a revision binding carry no placeholder SHA.
5. Missing, unsupported, stale, replayed, conflicting, or unverifiable trust evidence fails closed for the protected action while remaining inspectable as evidence where safe.

<a id="threat-model"></a>
## 2. Threat model and trust boundaries

### 2.1 Trusted components and protected assets

The trust root is the controller identity and its explicitly configured trust-root records. The following are trusted only within the stated boundary:

| Component | Trusted for | Not trusted for |
| --- | --- | --- |
| **Typed controller** | Validating inputs, selecting transitions, applying policy, holding or invoking the controller signing key, committing host mutations, fencing workers, and recording decisions | Correctness of an unverified external claim; it MUST fail closed when required evidence is absent |
| **Controller key store / trust-root store** | Confidentiality and controlled use of controller private keys; authenticated public-key and lifecycle records | Workflow decisions, model instructions, or arbitrary key substitution |
| **Host adapter** | Conforming translation between canonical subjects and a host API, and reporting host guarantees and results | Authorizing a transition; host responses are evidence until the controller validates them |
| **GitHub** | Durable issue/PR/comment/check content and exact-revision references for the GitHub adapter | ForgeDock authority merely because a comment, label, webhook, or event exists |
| **Model runtime / model** | Bounded reasoning and edits inside an explicitly granted workspace and tool set | Secrets, signing keys, controller transitions, merge, publication, closure, or claims not backed by controller evidence |
| **Local state** | Rebuildable indexes, leases, checkpoints, process supervision, and caches | Semantic truth when it conflicts with a committed host artifact |
| **Portable bundle** | Public, exported, archival evidence and verification metadata | Live authority, current policy, or permission to mutate a repository |

Protected assets are controller private keys, trust-root records, exact workflow decisions, artifact integrity and provenance, action-specific revision bindings and publication targets, capability nonces and replay state, lease ownership/fencing state, and the confidentiality of credentials, sessions, worktree secrets, and private repository data.

### 2.2 Untrusted inputs and attacker capabilities

The controller MUST treat issue and PR text, comments, labels, webhook payloads, Git contents, artifact markers, model output, runtime events, host responses, local databases, lease records, imported bundles, clocks supplied by callers, public keys, and prior artifacts as untrusted input until validated against this contract and current policy.

An attacker may:

- modify, reorder, duplicate, omit, replay, or fabricate unprotected artifacts, comments, labels, events, bundles, and host responses;
- supply malformed JSON, ambiguous Unicode, invalid numbers/times, unknown fields/actions/constraints, wrong repository or subject, stale or wrong SHA, forged predecessor links, or an untrusted key;
- steal or lose local operational state, race workers, replay a one-shot capability, present a stale lease, or create a split-brain host adapter;
- control a model prompt, model output, runtime process, worker workspace, network path, or non-secret repository content;
- delete an unanchored final artifact tail, suppress delivery of events, or provide an incomplete key/trust history.

This contract does not claim to protect a compromised controller process, a compromised trusted key store, a correctly authorized controller action, the contents of a repository that the host itself serves incorrectly, or deletion of unanchored evidence. Compromise or suspected compromise of a controller key requires retirement/revocation and incident handling under [§4](#identity).

<a id="boundaries"></a>
### 2.3 Boundary rules

- **Controller ↔ model/runtime:** task grants are capabilities for bounded work, not workflow authority. Runtime events are reports; only controller code may commit a transition or host mutation.
- **Controller ↔ host/GitHub:** adapter operations are typed requests with exact subject, required run, action, complete registered action-specific request/content scope, action-specific revision and current-decision bindings when applicable, and the complete registered publication target when applicable. A successful HTTP/API response is not a decision and MUST be checked before it is recorded as one.
- **Controller ↔ local state:** local state may accelerate recovery, but reconstruction MUST prefer validated durable artifacts and MUST NOT infer an authorization from a cache-only record.
- **Controller ↔ portable bundle:** import produces archival evidence and a verification report. It never joins the live run, replaces current policy, or competes with GitHub.
- **Controller ↔ trust root:** key lookup and lifecycle status are prerequisites for protected verification. The controller MUST NOT silently substitute a provider key, GitHub App credential, model token, or unknown key.

<a id="envelope"></a>
## 3. Protected artifact profile

### 3.1 Envelope fields and versions

A protected artifact is a UTF-8 canonical JSON object with exactly these top-level fields. Implementations MUST reject unknown top-level fields in `forgedock.protected/v1`; extensions require a new profile version.

```json
{
  "profile": "forgedock.protected/v1",
  "kind": "ReviewVerdict",
  "id": "art_01J...",
  "runId": "run_01J...",
  "subject": { "type": "github.pr", "repo": "rapiercraftstudios/forgedockcli", "number": 18 },
  "action": "review.record",
  "sequence": 3,
  "createdAt": "2026-08-03T16:01:12Z",
  "producer": { "role": "reviewer", "runtime": "pi" },
  "payload": { "reviewedSha": "0123456789abcdef0123456789abcdef01234567", "disposition": "approve" },
  "predecessor": "sha256:...",
  "digest": "sha256:...",
  "keyId": "fdck_...",
  "signature": "base64url-without-padding..."
}
```

`profile`, `kind`, `id`, `runId`, `subject`, `action`, `sequence`, `createdAt`, `producer`, `payload`, `predecessor`, `digest`, `keyId`, and `signature` are required. `producer` is descriptive provenance, not authority; it MUST NOT contain a secret. `payload` is action-specific but MUST have a registered schema for the `kind` and `action`. An artifact with no protected fields is a legacy artifact, not a protected artifact.

- `profile` is the exact profile identifier above. Legacy `forgedock.artifact/v2` remains readable but is never upgraded by parsing.
- `id` and `runId` are opaque, globally unique, non-empty identifiers; their canonical string is signed.
- `sequence` is an integer in the inclusive range `0..9007199254740991` (the safe IEEE-754 integer range). A run's first protected artifact is sequence `0` and has predecessor `null`; every later artifact has sequence previous plus one and a predecessor digest. Larger, fractional, negative, exponent-form, or otherwise non-safe counters are invalid. This same bound applies to event and lease counters.
- `createdAt` is an RFC 3339 UTC instant with seconds and `Z` (fractional seconds are permitted only to exactly three, six, or nine digits and are preserved as text). The controller's trusted clock supplies it.
- `subject` is the canonical identity in [§6](#subjects). `action` and `kind` MUST be an allowed pair in the closed registry below; an unknown or mismatched pair is `unsupported`.
- `reviewedSha` has one canonical location: `payload.reviewedSha` for protected `ReviewVerdict/review.record` and `MergeRequest/merge.request`. The verifier extracts that member, and the controller MUST require the same full lowercase SHA in the signature input, capability, requested operation, and freshly observed host head. For review and merge authorization, equality of SHA alone is insufficient: the capability and operation also bind the exact protected decision artifact identity/digest and authenticated current-decision chain defined in §5. No second SHA field is authoritative. A legacy v2 `payload.headSha` is readable only as legacy evidence and is never silently mapped into a protected artifact.
- `payload` schemas are closed, bounded, and secret-free. They MUST NOT contain credentials, tokens, cookies, session or prompt transcripts, raw model output, environment values, worktree secrets, or unbounded repository dumps. The controller validates and rejects a violation before signing or durable publication; it MUST NOT sign a sanitized object while retaining a claim about the rejected original.
- `digest` and `signature` are integrity fields, not input to their own digest.

#### Protected kind/action registry

The registry is part of `forgedock.protected/v1`; implementations MUST reject every pair not listed here and MUST use the named schema and SHA rule:

| `kind` | Allowed `action` | Required payload shape |
| --- | --- | --- |
| `Intent`, `Investigation`, `BuildPacket`, `BuildResult`, `Outcome` | `artifact.append` | Closed, bounded action schema; no reviewed SHA unless explicitly registered by a later profile |
| `ReviewVerdict` | `review.record` | Closed verdict/disposition/check schema; exactly one `payload.reviewedSha` |
| `MergeRequest` | `merge.request` | Closed merge-request schema; exactly one `payload.reviewedSha` |
| Any listed kind | `artifact.read`, `bundle.export` | Read/export request schema only; never a mutation authorization |

`forgedock.protected/v1` does not register a `payload.supersedes` member. Review supersession and the current-decision pointer are authenticated controller decision scope under §5, outside the protected artifact bytes. Adding a supersession member to a protected payload requires a new protected profile.

The controller MUST reject a listed action paired with the wrong kind, an unknown kind, an extra payload member, or a schema extension without a new profile. Each schema's required/optional members, bounds, and conformance vectors are versioned with this registry.

<a id="canonical-bytes"></a>
### 3.2 Canonical bytes

The canonical representation is **RFC 8785 JSON Canonicalization Scheme (JCS)** with these profile constraints, frozen as one byte-level rule:

1. Serialize one JSON value, encoded as UTF-8 without a BOM and without a trailing newline.
2. Object member names are sorted by JCS UTF-16 code-unit ordering. Duplicate names are invalid. Arrays retain schema-defined order; they are never sorted implicitly.
3. Strings use JCS escaping: the required short escapes are used for backspace, tab, newline, form feed, and carriage return; other controls use lowercase `\u00xx`, quotation mark and reverse solidus are escaped, and other Unicode characters are emitted directly. Invalid Unicode scalar sequences are invalid.
4. Numbers use JCS/ECMAScript finite-number serialization. NaN, positive/negative infinity, implementation-specific numeric values, and non-finite values are invalid; negative zero canonicalizes as `0`. Profile schemas SHOULD use integers or strings for security-sensitive values.
5. An absent optional member is omitted. `null` is distinct from absent and is permitted only where that field's profile schema explicitly permits it. No default is inserted during canonicalization.
6. Times are strings, as above; no local timezone, alternate precision, or numeric epoch is equivalent. Hashes, identifiers, actions, repository names, and SHAs use their specified exact case.

For an artifact, define `unsignedBody` as the envelope with `digest` and `signature` omitted. Define:

```text
bodyBytes = UTF8(JCS(unsignedBody))
digest = "sha256:" + lowercase(hex(SHA-256(UTF8("ForgeDock-Artifact-Digest-v1\0") || bodyBytes)))
```

The literal domain string is ASCII and the separator is one zero byte. The digest field MUST equal this result. Re-serializing parsed data with ordinary `JSON.stringify`, adding whitespace, changing member order, normalizing a time, or replacing absent with `null` changes the bytes and MUST fail verification.

<a id="signatures"></a>
### 3.3 Sequencing, genesis, and signature scope

A run is an append-only logical sequence, but storage systems MAY deliver artifacts out of order. Sequence `0` is the genesis artifact: its `predecessor` MUST be `null`, its `sequence` MUST be `0`, and its `runId` establishes the sequence. Sequence `n > 0` MUST carry the exact digest of sequence `n-1` in `predecessor`; a missing chain member, duplicated sequence, competing predecessor, or non-contiguous link yields `chain-gap` even if each isolated signature is valid. The controller MUST serialize protected publication with an atomic append CAS on `(runId, lastSequence, lastDigest)`. The host publication MUST be idempotent by artifact ID/digest. If a competing append is observed, the controller marks the run `unverifiable` and blocks protected actions; it MUST NOT choose whichever branch a read happened to return.

The signature input is domain-separated and binds all authority-relevant identity:

```text
signatureInput =
  UTF8("ForgeDock-Artifact-Signature-v1\0") ||
  UTF8(profile) || 0x00 ||
  UTF8(digest) || 0x00 ||
  UTF8(runId) || 0x00 ||
  UTF8(canonicalSubjectBytes) || 0x00 ||
  UTF8(action) || 0x00 ||
  UTF8(sequence-as-ASCII-decimal) || 0x00 ||
  UTF8(reviewedSha-or-empty) || 0x00 ||
  UTF8(predecessor-or-"genesis")
```

`canonicalSubjectBytes` is the exact UTF-8 JCS encoding of `subject`. For `ReviewVerdict/review.record` and `MergeRequest/merge.request`, `reviewedSha-or-empty` is computed only by extracting `payload.reviewedSha`; it MUST equal the capability, requested operation, and fresh host head. For all other registered pairs it is the empty string and any reviewed-SHA member is rejected. The Ed25519 signature is over `signatureInput`; `signature` is unpadded base64url of the 64-byte signature. The controller MUST verify the digest before the signature and MUST verify the requested repository, subject, run, action, reviewed SHA when applicable, exact decision artifact identity/digest when applicable, and current non-superseded decision chain against the current operation, not merely against an artifact in isolation.

<a id="verification"></a>
### 3.4 Verification algorithm and result states

Verification is deterministic and returns one primary state plus structured diagnostics. It MUST perform profile/shape and canonical parsing checks, then digest, key/trust status, signature, binding, chain, time, and policy checks. `incomplete` has one narrow meaning: a field required by the applicable registered kind/action schema is absent from the artifact being verified (including its own `predecessor` member when the sequence requires one). `payload.reviewedSha` is required only by `ReviewVerdict/review.record` and `MergeRequest/merge.request`; its absence is valid for every registered schema that forbids it and MUST NOT be diagnosed as incomplete or filled with a placeholder. A missing predecessor artifact, missing sequence member, duplicate/conflicting append, or non-contiguous set is never `incomplete`; it is `chain-gap`. An unavailable trust root/replay store/host proof is `unverifiable`. A verifier MUST choose the first applicable primary state using this precedence: `malformed`, `incomplete`, `unsupported`, `invalid-signature`, `wrong-binding`, `chain-gap`, `expired`, `revoked`, `unverifiable`, then `verified`.

| Primary state | Meaning | Protected authorization |
| --- | --- | --- |
| `verified` | Correct protected profile, canonical bytes, digest, trusted non-revoked key, signature, bindings, chain context, and validity | May be considered by the controller, subject to current policy and host checks |
| `legacy-unverified` | Structurally readable v2 artifact with no protected proof | Evidence only; never authorizes a protected action |
| `malformed` | Invalid JSON, duplicate keys, invalid canonical data, invalid field shape, or illegal encoding | Reject and quarantine; no authorization |
| `incomplete` | A field required by the applicable kind/action schema is absent from this artifact itself, including its own required predecessor or, only for the two registered review/merge schemas, `payload.reviewedSha` | No authorization; do not guess or repair silently |
| `unsupported` | Unknown profile version, kind/action pair, constraint, key algorithm, or schema extension | No authorization; preserve bytes for inspection |
| `invalid-signature` | Digest or Ed25519 signature does not verify for the declared input | Reject; treat as possible tampering |
| `wrong-binding` | Artifact is validly signed but repository, subject, run, action, applicable exact reviewed SHA, decision identity/currentness, or other registered request scope does not match the requested operation | Reject for that operation |
| `chain-gap` | Required predecessor is missing, duplicated, altered, or sequence is not contiguous | No complete-history claim or protected authorization requiring the chain |
| `expired` | Artifact or capability is outside its validity interval according to the trusted controller clock | No authorization; archival verification may still report signature validity |
| `revoked` | Signing key, capability issuer, or relevant trust record is retired/revoked at the applicable time | No current authorization; historical evidence may retain a “was valid before revocation” diagnostic |
| `unverifiable` | Required trust root, replay state, host evidence, or other verification dependency is unavailable | Fail closed; do not turn inability to check into success |

For this profile, an artifact is valid at its creation time unless its registered action schema or an explicitly declared validity record supplies an expiry. A verifier applies that declared interval and the trusted controller clock; a capability's `expiresAt` never extends the artifact's validity. Thus `expired` is a distinct result for time-bounded protected evidence or authorization, not a reason to infer an expiry for ordinary v2 data.

Legacy v2 parsing is intentionally read-only. A v2 artifact can be displayed as `legacy-unverified`, but parsing, reposting, or bundling it MUST NOT add a protected signature or make it `verified`.

<a id="identity"></a>
## 4. Controller identity and key lifecycle

### 4.1 Generation, storage, and identifiers

A ForgeDock controller identity is generated by ForgeDock using a controller-owned Ed25519 keypair. Generation MUST use the operating system or an approved cryptographically secure random source; a model, provider, GitHub App, repository, or imported bundle MUST NOT generate or select the active private key.

The private key MUST be stored in a protected OS keystore or an encrypted file whose decryption secret is supplied out-of-process (for example, an OS credential store or operator secret). It MUST be permission-restricted, excluded from repositories and bundles, and unavailable to model/runtime tool grants. Private-key export is disabled by default. If the key is missing, locked, corrupt, or inaccessible, protected signing and any action requiring the controller identity fail closed; the controller MUST NOT create an unannounced replacement and continue the same run.

`keyId` uses an unambiguous fixed-width hexadecimal derivation from the canonical public key:

```text
publicKeyBytes = exactly the raw 32-byte Ed25519 public key
keyId = "fdck_" + lowercase(hex(SHA-256(
  UTF8("ForgeDock-Key-Id-v1\0") || publicKeyBytes
)))
```

`hex` is exactly 64 lowercase ASCII hexadecimal characters, most-significant byte first, with no padding removal, separators, alternate encodings, or truncation. Implementations MUST include vectors covering a public key beginning with zero bytes and a normal key; the hash input and output length above are the vector contract.

The trust record binds `keyId`, algorithm (`Ed25519`), canonical public key, controller installation or operator scope, `activatedAt`, and lifecycle status. Public identifiers are not GitHub App installation IDs, OAuth identities, provider names, model IDs, DIDs, or account aliases.

### 4.2 Rotation, loss, retirement, and historical verification

Rotation creates a signed or otherwise authenticated lifecycle record that names the old key, new key, activation instant, and predecessor trust record. New artifacts use the new key after activation. The old public key and lifecycle records remain available for historical verification. Rotation MUST NOT rewrite old artifacts or make an old signature appear newly issued.

On suspected compromise, the operator MUST revoke/retire the key in the trust root, stop protected signing, and record the effective time and reason. Retirement is a planned end-of-use state; revocation means signatures MUST NOT authorize current work. Historical verification MAY report an artifact as cryptographically valid at its creation time while its authorization result is `revoked` under current policy. A verifier MUST apply the documented revocation effective time and MUST NOT invent retroactive timestamps.

Key loss is not proof of compromise. It still prevents new signatures with that identity. Recovery requires an authenticated operator procedure to restore the key or explicitly initialize a new identity; it MUST NOT silently fork a live run. If the required historical public key or lifecycle record is unavailable, verification is `unverifiable`, not `invalid-signature`.

Controller signing keys are separate from model-provider API keys, OAuth tokens, GitHub App private keys, installation tokens, SSH keys, and repository deploy keys. None may be reused as a ForgeDock signing key, and a controller key MUST NOT be sent to a model or host adapter.

<a id="capabilities"></a>
## 5. Capabilities and delegation

Capabilities authorize a bounded request to the controller; they do not bypass controller policy or turn a worker into an authority. The closed action vocabulary is:

`artifact.append`, `artifact.read`, `issue.comment`, `issue.label`, `pr.publish`, `review.record`, `merge.request`, `lease.acquire`, `lease.heartbeat`, `lease.release`, and `bundle.export`.

Unknown actions are rejected by default. An implementation MAY support a new action only in a new contract/profile version with explicit tests and policy; it MUST NOT interpret an unknown action as read-only or as its closest known action.

A capability is not a free-standing semantic record. It is a controller-issued canonical envelope with exactly the common top-level fields `profile`, `capabilityId`, `delegationId`, `body`, and `proof`; unknown fields are rejected. Its `body` contains exactly the common fields `issuer`, `audience`, `action`, `subject`, `runId`, `issuedAt`, `expiresAt`, `parentCapabilityId`, `depth`, `nonce`, `oneShot`, and `constraints`, plus only the revision and request-scope members registered for that action in the closed matrix below. Every action requires `runId`; an implementation needing a repository-wide read/export grant MUST mint a distinct later profile rather than omit or invent run scope. Revision-member presence remains governed by the same matrix. This `merge.request` example carries `reviewedSha` and the exact current approving decision scope (values abbreviated only for readability):

```json
{
  "profile": "forgedock.capability/v1",
  "capabilityId": "cap_...",
  "delegationId": "del_...",
  "body": {
    "issuer": "fdck_...",
    "audience": "aud_...",
    "action": "merge.request",
    "subject": { "type": "github.pr", "repo": "owner/name", "number": 18 },
    "runId": "run_...",
    "reviewedSha": "0123456789abcdef0123456789abcdef01234567",
    "mergeDecision": {
      "mergeRequestArtifactId": "art_merge_...",
      "mergeRequestArtifactDigest": "sha256:...",
      "approvingReviewArtifactId": "art_review_...",
      "approvingReviewArtifactDigest": "sha256:...",
      "approvingDisposition": "approve",
      "currentDecisionDigest": "sha256:..."
    },
    "issuedAt": "2026-08-03T16:01:12Z",
    "expiresAt": "2026-08-03T16:11:12Z",
    "parentCapabilityId": null,
    "depth": 0,
    "nonce": "base64url-random",
    "oneShot": true,
    "constraints": { "coordinationKey": null }
  },
  "proof": { "keyId": "fdck_...", "signature": "base64url-without-padding" }
}
```

A `pr.publish` body instead has the same common fields, carries `sourceSha` and the closed `publicationTarget`, and never carries `reviewedSha`. First creation is authorized against the originating issue because no PR number exists yet:

```json
{
  "issuer": "fdck_...",
  "audience": "aud_...",
  "action": "pr.publish",
  "subject": { "type": "github.issue", "repo": "owner/name", "number": 90 },
  "runId": "run_...",
  "sourceSha": "89abcdef0123456789abcdef0123456789abcdef",
  "publicationTarget": {
    "publicationId": "pub_...",
    "lifecycle": "create",
    "originSubject": { "type": "github.issue", "repo": "owner/name", "number": 90 },
    "registryRunId": "run_...",
    "hostAuthorityId": "host-authority-...",
    "sourceRefPolicy": {
      "profile": "forgedock.source-ref-policy/v1",
      "policyVersion": 3,
      "policyDigest": "sha256:...",
      "decision": "allow",
      "headRepo": "owner/name",
      "headRef": "refs/heads/forgedock/issue-90"
    },
    "headRepo": "owner/name",
    "headRef": "refs/heads/forgedock/issue-90",
    "baseRepo": "owner/name",
    "baseRef": "refs/heads/main",
    "buildResultId": "art_...",
    "buildResultDigest": "sha256:...",
    "publicationVersion": 1,
    "remoteRefPrecondition": { "state": "absent" },
    "prPrecondition": { "state": "unallocated", "expectedMarkerState": "absent" }
  },
  "issuedAt": "2026-08-03T16:01:12Z",
  "expiresAt": "2026-08-03T16:11:12Z",
  "parentCapabilityId": null,
  "depth": 0,
  "nonce": "base64url-random",
  "oneShot": true,
  "constraints": { "coordinationKey": "sha256:..." }
}
```

The action-specific scope matrix is exhaustive. Each of the 11 actions appears exactly once, requires `runId`, and has exactly the named request-scope member; every other request-scope member is forbidden:

| Action | `runId` | `reviewedSha` | `sourceSha` | Required request scope |
| --- | --- | --- | --- | --- |
| `artifact.append` | Required | Forbidden | Forbidden | `artifactAppend` |
| `artifact.read` | Required | Forbidden | Forbidden | `artifactRead` |
| `issue.comment` | Required | Forbidden | Forbidden | `issueComment` |
| `issue.label` | Required | Forbidden | Forbidden | `issueLabel` |
| `pr.publish` | Required | Forbidden | Required | `publicationTarget` |
| `review.record` | Required | Required | Forbidden | `reviewDecision` |
| `merge.request` | Required | Required | Forbidden | `mergeDecision` |
| `lease.acquire` | Required | Forbidden | Forbidden | `leaseAcquire` |
| `lease.heartbeat` | Required | Forbidden | Forbidden | `leaseHeartbeat` |
| `lease.release` | Required | Forbidden | Forbidden | `leaseRelease` |
| `bundle.export` | Required | Forbidden | Forbidden | `bundleExport` |

A required revision member MUST be present as an exact 40-character lowercase hexadecimal commit SHA. A forbidden member MUST be absent, not `null`, empty, or a placeholder. Missing required members, present forbidden members, a missing/extra/wrong action-scope member, unknown members, and actions absent from this matrix are default-deny. For a no-revision action, the authoritative revision binding is the explicit semantic state **no revision**, represented by the absence of both revision members; no SHA is invented.

The non-publication request scopes are closed as follows:

- `artifactRead` has exactly `artifactId` and `artifactDigest` and authorizes retrieval of only those exact protected bytes after subject/run equality and digest verification.
- `issueComment` has exactly `bodyDigest` and `bodyByteLength`. The length is a non-negative safe integer and `bodyDigest = "sha256:" + lowercase(hex(SHA-256(UTF8("ForgeDock-Issue-Comment-Body-v1\0") || exactCommentUTF8Bytes)))`. The controller and host request carry the exact bounded UTF-8 bytes, recompute both values before mutation, and reject normalization, truncation, template expansion, or substitution.
- `issueLabel` has exactly `mutation` and `labels`. `mutation` is `add`, `remove`, or `set`; `labels` is a non-empty, sorted, duplicate-free array of exact host-canonical label names. The host request and postcondition MUST equal that exact operation and complete array; adding an implicit workflow label is a different authorization.
- `reviewDecision` has exactly `reviewArtifactId`, `reviewArtifactDigest`, `reviewDisposition`, and `supersedesDecisionDigest`. It identifies the complete protected `ReviewVerdict/review.record` being recorded. Its subject/run/action/`payload.reviewedSha`/disposition and digest MUST equal the capability and request. `supersedesDecisionDigest` is authenticated controller decision scope, not a protected-artifact payload member; it is `null` only when authenticated workflow state proves no prior review decision, otherwise it MUST equal the current non-superseded ReviewVerdict digest immediately before recording. The atomic record boundary compares the current-decision pointer to this value and installs this artifact as the new current decision, or performs no mutation.
- `mergeDecision` has exactly `mergeRequestArtifactId`, `mergeRequestArtifactDigest`, `approvingReviewArtifactId`, `approvingReviewArtifactDigest`, `approvingDisposition`, and `currentDecisionDigest`. The merge-request members identify the complete protected `MergeRequest/merge.request`; the approving members identify one complete protected `ReviewVerdict/review.record` with the same subject, run, and `reviewedSha`; `approvingDisposition` MUST be exactly `approve`; and `currentDecisionDigest` MUST equal `approvingReviewArtifactDigest`. At the merge mutation boundary the controller MUST authenticate its decision history and current-decision pointer and prove that this approval is current, non-superseded, non-revoked, and policy-eligible. A later same-SHA verdict, including `request_changes`, invalidates the scope even though the PR head is unchanged.
- `leaseAcquire` has exactly `coordinationKey`, `requestId`, and `ownerId`; `leaseHeartbeat` has exactly `coordinationKey`, `requestId`, `ownerTokenDigest`, `fencingSequence`, and `heartbeatGeneration`; and `leaseRelease` has exactly `coordinationKey`, `requestId`, `ownerTokenDigest`, and `fencingSequence`. Values equal the canonical key and §8 request, and the host authenticates the actual secret owner token and recomputes its digest outside model-visible bytes.
- `bundleExport` has exactly `bundleId`, `manifestDigest`, and `members`; `members` is the exact ordered array of closed `{ "artifactId": "...", "artifactDigest": "..." }` entries. Export may read and emit only those exact verified members and the manifest whose digest is bound here.

Every scope above, including exact content bytes where a scope carries a digest, MUST be frozen before issuance and carried unchanged through every parent/child capability, controller decision/request, operation record, adapter/host request, idempotency lookup, result/postcondition, retry, and reconciliation. The trusted boundary recomputes digests and rejects a substitution before mutation or disclosure. Possessing a capability for one comment, label set, artifact, lease request, decision artifact, or export member set never authorizes another under the same capability, nonce, or operation ID.

`artifactAppend` is required only for `artifact.append` and forbidden for every other action. It is a closed object with exactly `artifactProfile`, `artifactKind`, `artifactId`, `payloadDigest`, `artifactDigest`, `expectedSequence`, and `predecessor`. `artifactProfile` is exactly `forgedock.protected/v1`; `artifactKind` is exactly one appendable kind registered in §3.1; `artifactId` is the exact new protected artifact ID; `expectedSequence` is a safe integer; and `predecessor` is exactly `null` for sequence zero or the expected prior artifact digest. `payloadDigest` is `"sha256:" + lowercase(hex(SHA-256(UTF8("ForgeDock-Artifact-Payload-v1\0") || UTF8(JCS(payload)))))` for the closed, schema-validated payload. `artifactDigest` is the exact §3.2 `digest` computed from the complete frozen `unsignedBody`; it therefore binds `profile`, `kind`, `id`, `runId`, `subject`, `action`, `sequence`, controller-supplied `createdAt`, complete `producer`, `payload`, `predecessor`, and `keyId`, not only the payload.

Before capability issuance, signing, nonce consumption, append CAS, or publication, the controller MUST freeze `bodyBytes`, require every envelope member to equal the controller/request scope (including capability `subject` and `runId` and action `artifact.append`), recompute both digests, and require the requested artifact's `digest` to equal `artifactAppend.artifactDigest`. The capability, every delegated child, controller request, immutable operation record, host request, and reconciliation request MUST preserve all seven values; the immutable operation record additionally stores the exact `bodyBytes`. Any envelope or metadata substitution—including another subject, run, `createdAt`, producer, kind, payload, sequence, or predecessor—under the same capability or `operationId` is a conflict before signing or mutation, not a second append attempt.

`publicationTarget` is required only for `pr.publish` and forbidden for every other action. It is a closed object with exactly `publicationId`, `lifecycle`, `originSubject`, `registryRunId`, `hostAuthorityId`, `sourceRefPolicy`, `headRepo`, `headRef`, `baseRepo`, `baseRef`, `buildResultId`, `buildResultDigest`, `publicationVersion`, `remoteRefPrecondition`, and `prPrecondition`:

- `publicationId` is a controller-generated opaque identity whose authoritative registry entry is immutably bound to the stable host authority, exact repository, run, originating issue or pre-existing PR, signed source-ref policy, head repository/ref, and base repository/ref. This identity remains stable when a create operation allocates a PR number.
- `originSubject` and `registryRunId` are copied exactly from the authoritative registry record. `registryRunId` MUST equal capability `runId`, the selected BuildResult run, every delegated child, the frozen operation, and every host request. For `create`, capability `subject` MUST equal `originSubject`, which MUST be a `github.issue`; for `reuse`, capability `subject` MUST equal the registered `prSubject`, while `originSubject` remains the immutable originating issue or pre-existing PR. These equalities are checked at registration, issuance, delegation, operation freeze, replay/reconciliation, and every host boundary.
- `lifecycle` is exactly `create` or `reuse`. `create` requires the exact originating `github.issue` subject and a registry entry with no allocated PR; `reuse` requires a `github.pr` subject whose repository and number exactly equal the PR already registered for `publicationId`. A controller MAY register a pre-existing PR only through the typed authenticated registry/marker transaction defined below. A create result atomically completes the registry mapping with one allocated canonical PR subject; it never changes `originSubject` or the capability subject.
- `hostAuthorityId` is the stable identity from fresh authenticated discovery and MUST equal the registry, checkpoint, reservation, dedicated source-ref key, operation, request, marker, immutable PR reference, and receipt. The configured authority registry MUST enforce one globally shared authority/lease namespace for each authenticated `(endpoint, trustRoot, repository)` and MUST reject configuration, registration, or issuance if the same physical endpoint/repository is assigned multiple authority IDs. It never substitutes ephemeral `hostInstanceId`.
- `sourceRefPolicy` is a closed object with exactly `profile`, `policyVersion`, `policyDigest`, `decision`, `headRepo`, and `headRef`. `profile` is `forgedock.source-ref-policy/v1`; `policyVersion` is a positive safe integer; `policyDigest` is `"sha256:" + lowercase(hex(SHA-256(UTF8("ForgeDock-Source-Ref-Policy-v1\0") || UTF8(JCS(configuredPolicyBody)))))` for the exact schema-validated policy body at that version; `decision` is exactly `allow`; and its repository/ref equal the adjacent target members. The controller derives and signs this normalized decision from current authenticated policy before issuance. Registry, delegation, operation, host request, every boundary, receipt, and reconciliation preserve it exactly; a changed/unknown policy or non-allow decision denies before mutation.
- `headRepo` and `baseRepo` are canonical repository identities. `headRef` and `baseRef` are exact fully qualified `refs/heads/...` names with no shorthand, symbolic ref, revision expression, or case alias. Both repositories MUST equal the capability subject repository and the repository in fresh authenticated discovery; protected publication to any fork or other repository is unsupported in this profile. Credentials MUST be scoped to that discovered repository and MUST NOT push source bytes elsewhere. The canonical physical pairs `(hostAuthorityId, headRepo, headRef)` and `(hostAuthorityId, baseRepo, baseRef)` MUST differ. `headRef` MUST match the signed `sourceRefPolicy` and controller-configured closed source-ref namespace/allowlist for that host and repository; that allowlist MUST exclude every configured base, default, release, protected, or otherwise host-protected ref, including `baseRef`. Canonical aliases are resolved before comparison. The tuple is compared in full; branch-only discovery is forbidden. Registration, registry reservation, capability issuance/delegation, operation freeze, and every remote/create/reuse/finalization boundary MUST repeat these checks before mutation.
- `buildResultId` and `buildResultDigest` identify the one controller-selected, verified BuildResult for the same repository and run. That BuildResult's signed canonical `subject` MUST equal `originSubject` exactly; reuse under a PR capability does not weaken or remap this provenance check. Its `payload.headSha` MUST equal `sourceSha`. `publicationVersion` is a positive safe integer allocated monotonically by an atomic controller CAS for `publicationId`; the registry binds that version to the BuildResult identity, digest, canonical subject, and `sourceSha`.
- `remoteRefPrecondition` is exactly `{ "state": "absent" }` or `{ "state": "sha", "sha": "<full-lowercase-SHA>" }`. It records the expected remote head immediately before any push or selection; the desired postcondition is always `sourceSha`.
- `prPrecondition` is exactly `{ "state": "unallocated", "expectedMarkerState": "absent" }` for `create`, or `{ "state": "existing", "headSha": "<full-lowercase-SHA>", "prState": "OPEN", "expectedRunMarker": <complete-marker> }` for `reuse`. The reuse form carries the exact authenticated current marker defined below, not marker text or selected fields. A different current head, marker, or PR state—including `CLOSED`, `MERGED`, an unknown state, or an unavailable state—is a conflict before mutation. Only reconciliation of an operation whose receipt was already controller-committed while the PR was `OPEN` may return that earlier result after the PR becomes terminal.

A protected PR run marker is a closed object with exactly `profile`, `body`, and `proof`. `profile` is `forgedock.pr-run-marker/v1`. `body` has exactly `hostAuthorityId`, `immutablePrRef`, `publicationId`, `runId`, `operationId`, `publicationVersion`, `sourceSha`, `issuedAt`, and `predecessorDigest`; `hostAuthorityId` is stable across adapter restart/failover and equals the target and immutable reference; the first marker has `predecessorDigest: null`, and a replacement names the digest of the prior complete marker. `proof` is exactly `{ "keyId": "...", "algorithm": "Ed25519", "signature": "<unpadded-base64url>" }`, where `keyId` is active for the configured host marker-signing service under the adapter/host trust root and:

```text
markerSignatureInput =
  UTF8("ForgeDock-PR-Run-Marker-Signature-v1\0") ||
  UTF8(profile) || 0x00 || UTF8(JCS(body))
markerDigest = "sha256:" + lowercase(hex(SHA-256(
  UTF8("ForgeDock-PR-Run-Marker-Digest-v1\0") || UTF8(JCS(completeMarker))
)))
```

`immutablePrRef` has the shape defined for publication results below and is included in the signed body. Marker bytes are immutable and retained as an append-only history. The host stores an authenticated current-marker pointer in metadata that ordinary repository/PR writers cannot modify and replaces that pointer only by atomic compare-and-replace of the complete expected marker to the complete new marker in the same fenced transaction as the PR/ref update. PR bodies, comments, labels, checks, branch names, commit messages, webhooks, and other ordinary GitHub text are never a protected marker or evidence that one exists. If the host cannot provide this protected metadata and CAS, protected PR publication is unsupported.

The **authoritative publication registry** is durable semantic state in a configured controller/host trust boundary, never SQLite, a session, a workspace, or a rebuildable cache. Each registry record is a closed object with exactly `profile`, `body`, and `proof`; `profile` is `forgedock.publication-registry/v1`. Its `body` has exactly `registryId`, `registryVersion`, `previousRecordDigest`, `publicationId`, `runId`, `originSubject`, `lifecycle`, `hostAuthorityId`, `sourceRefPolicy`, `headRepo`, `headRef`, `baseRepo`, `baseRef`, `buildResultId`, `buildResultDigest`, `sourceSha`, `publicationVersion`, `allocationState`, `prSubject`, `immutablePrRef`, `prState`, `currentRunMarker`, `sourceRefReservationId`, `targetReservationId`, `pendingPublication`, `tombstone`, and `committedAt`. `registryVersion` starts at `1`. The genesis record alone has `previousRecordDigest: null`; every later record has version exactly predecessor version plus one and names the predecessor's `registryRecordDigest`. `allocationState` is `unallocated` or `allocated`; `prSubject`, `immutablePrRef`, `prState`, and `currentRunMarker` are `null` only while unallocated, except that the authenticated pending overlay may carry provisional values as defined in §6.2. `pendingPublication` is `null` or that closed overlay. `tombstone` is `null` for a live record or exactly `{ "reason": "terminal-release"|"unallocated-abort"|"pending-abort", "tombstonedAt": "...", "releasedReservationIds": ["..."] }`; tombstoning never deletes history or lowers a high-water mark. These are the only permitted nulls or fields.

Registry `proof` is exactly `{ "keyId": "...", "algorithm": "Ed25519", "signature": "<unpadded-base64url>" }`. The trusted registry transaction—not its caller or signer—assigns `committedAt` from its authenticated clock immediately before signing. The signature is over `UTF8("ForgeDock-Publication-Registry-Record-v1\0") || UTF8(profile) || 0x00 || UTF8(JCS(body))`. Define `completeRegistryRecord = {profile,body,proof}` and:

```text
registryRecordDigest = "sha256:" + lowercase(hex(SHA-256(
  UTF8("ForgeDock-Publication-Registry-Digest-v1\0") ||
  UTF8(JCS(completeRegistryRecord))
)))
```

The digest is external record identity and is not a member of the record, so it is not self-referential; it covers the proof as well as the signed body. Every CAS names the exact current `(registryId, registryVersion, registryRecordDigest)` and writes version plus one with `previousRecordDigest` equal to that digest. A pending overlay's expected digest always names its predecessor ready record; boundaries name the independently computed digest of the current pending record. A completed operation/result separately names the final completed record version/digest. `proof.keyId` MUST have been active at `committedAt` for historical validity **and** MUST be currently active and non-revoked whenever that record is used for capability issuance, registration, publication, takeover, reconciliation, or another current authorization. Revocation preserves archival verification but immediately denies current use.

An independently retained checkpoint is a closed `{profile,body,proof}` object with `profile: forgedock.publication-registry-checkpoint/v1`. Its body has exactly `registryId`, `publicationId`, `hostAuthorityId`, `highestRegistryVersion`, `highestRecordDigest`, `highestPublicationVersion`, `liveReservationIds`, `releasedReservationIds`, and `checkpointedAt`; `hostAuthorityId` equals every record and reservation in the checkpointed publication; reservation arrays are sorted unique opaque IDs. Its proof has the same closed proof shape and signs `UTF8("ForgeDock-Publication-Registry-Checkpoint-v1\0") || UTF8(profile) || 0x00 || UTF8(JCS(body))`. Historical validation checks activity at trusted `checkpointedAt`; every current authorization additionally requires that checkpoint signer to remain non-revoked. The trusted checkpoint transaction supplies `checkpointedAt`, requires a currently active signer, and atomically advances—never lowers—each numeric/digest high-water value and retained reservation history. For the GitHub adapter, every record and checkpoint MUST be durably anchored through authenticated host-protected metadata; if the native surface cannot supply it, a trusted adapter service is required and discovery reports the native surface unsupported. The store enforces unique current `publicationId`, physical source ref, immutable PR, and complete head/base tuple and retains predecessor records, checkpoints, tombstones, operation records, and reservation history across deletion, restart, restore, and failover.

The registry chain and checkpoint MUST detect a restored/rolled-back record, missing tail, reset version, fork, or resurrected reservation. Missing, unavailable, unverifiable, rolled-back, forked, revoked-for-current-use, or unexplained registry/host-marker-conflicting evidence denies capability issuance and every publication boundary. The sole permitted temporary registry/marker difference is the exact expected-old/proposed-new state and completed-boundary cursor authenticated by one current pending generation; any other difference denies. Recovery reconstructs from registry history, protected markers, durable host operation state, and committed receipts; cache-only mappings never authorize reuse.

Registration of an unmarked pre-existing PR is the controller-only suboperation `forgedock.pr-registration/v1`, not a twelfth capability action and never worker authority. Its `originSubject` and `prSubject` MUST be the same exact pre-existing canonical PR subject, and its repository/run/BuildResult bindings follow the publication rules above. The request is a closed object with exactly `profile`, `body`, and `proof`. `profile` is `forgedock.pr-registration/v1`; `body` has exactly `operationId`, `controllerDecisionId`, `controllerDecisionDigest`, `publicationId`, `originSubject`, `runId`, `prSubject`, `immutablePrRef`, `hostAuthorityId`, `sourceRefPolicy`, `headRepo`, `headRef`, `baseRepo`, `baseRef`, `sourceSha`, `buildResultId`, `buildResultDigest`, `publicationVersion`, `expectedPrHeadSha`, `expectedRemoteRefSha`, `expectedPrState`, `expectedMarkerState`, `expectedRegistryVersion`, `expectedRegistryRecordDigest`, `coordinationKey`, `ownerTokenDigest`, and `fencingSequence`. `expectedPrState` is `OPEN`, both expected SHA values equal `sourceSha`, and `expectedMarkerState` is `absent`. `controllerDecisionId`/digest resolve to the controller's committed registration decision and exact request scope. `operationId` is lowercase hex SHA-256 over `UTF8("ForgeDock-PR-Registration-Operation-v1\0") || UTF8(JCS(body-without-operationId))`. `proof` is exactly `{ "keyId": "...", "algorithm": "Ed25519", "signature": "<unpadded-base64url>" }`, its key is a currently active controller key, and it signs `UTF8("ForgeDock-PR-Registration-Request-Signature-v1\0") || UTF8(profile) || 0x00 || UTF8(JCS(body))`. The registry verifies the proof, active controller trust, committed decision reference/digest, and exact body before any marker, reservation, or registry mutation; endpoint reachability or an unsigned “controller-only” assertion is never authorization.

The immutable operation record stores the exact authenticated request plus state `pending`, `completed`, `failed`, or `indeterminate`; a closed success result has exactly `profile`, `operationId`, `registryVersion`, `registryRecordDigest`, `prSubject`, `immutablePrRef`, `runMarker`, `registeredAt`, and `proof`. Its profile is `forgedock.pr-registration-result/v1`; trusted host/registry transaction time supplies `registeredAt`; and `proof` is exactly `{ "keyId": "...", "algorithm": "Ed25519", "signature": "<unpadded-base64url>" }` and signs `UTF8("ForgeDock-PR-Registration-Result-v1\0") || UTF8(profile) || 0x00 || UTF8(JCS(result-without-proof))`. The result signer must be currently active for use. Failed/indeterminate state records the exact failed boundary/classification and is reconciled only by the original request/operation ID; it never authorizes reuse. Retry/recovery uses only that operation ID and exact bytes.

Under the source-ref fence, one host/registry linearization transaction MUST compare the complete authenticated request and controller decision, current registry version/digest, remote ref SHA, exact PR identity/reference/head/base tuple, `OPEN` state, marker absence, reservations, stable host authority, source policy, and live fence. The actual secret lease owner token is supplied over the authenticated controller-to-registry channel, MUST authenticate the current lease owner, and MUST hash to `ownerTokenDigest`; the transaction also compares its fencing sequence. Only then does it uniquely reserve the immutable PR/tuple/ref, install the first marker, commit the allocated registry record/checkpoint, and complete the operation result together. Any mismatch or indeterminate atomic result creates no later `reuse` authority and is reconciled by the same operation ID. The first `reuse` capability allocates a higher publication version and carries the registration marker. An existing marker may be adopted only by the publication identity it names.

A source-ref reservation record is closed with exactly `reservationId`, `hostAuthorityId`, `headRepo`, `headRef`, `publicationId`, `status`, and `fencingSequence`; a physical-target reservation additionally carries `immutablePrRef` or `null`, `baseRepo`, and `baseRef`. `status` is `live` or `released`; its authenticated external digest/history is retained. Registry reservation IDs MUST resolve to records whose stable authority/repository/ref and publication equal the target, dedicated key, checkpoint, and registry; mismatches or multiple live records for one physical tuple are conflicts.

The stable source-ref reservation and coordination domain is independent of `publicationId`, `runId`, issue/PR number, base branch, adapter process, and failover instance. It uses the dedicated §8 profile `forgedock.coordination-key/pr-source-ref/v1`, whose stable `hostAuthorityId` identifies one configured physical host authority across adapter restarts/failover. `constraints.coordinationKey` is that profile's dedicated hash, and its repository/ref values MUST equal `publicationTarget`. Before capability issuance the registry MUST atomically reserve this physical source ref for `publicationId`, or prove the existing reservation names that same identity; a competing publication receives no capability. Every publication touching the ref MUST acquire that exact key before workspace/source selection and retain it through completed-record/receipt commit or pending recovery. The remote boundary atomically verifies reservation and fence. Changing run, issue, publication, base, adapter instance, or process cannot create another domain.

An allocated reservation remains owned while its registered PR is `OPEN` and may be released by an authenticated `terminal-release` tombstone only after fresh terminal-state confirmation and no pending generation. An unallocated reservation may be reclaimed after lease expiry by one atomic `unallocated-abort` transaction only if a higher fence proves: no pending or completed publication operation exists, no PR/immutable-ref/tuple or marker was allocated, the remote ref still equals its recorded precondition (or an authenticated rollback restored it), and no host mutation occurred. The transaction fences the old owner, commits the tombstone/checkpoint, and releases the reservation while retaining all history. A pending generation uses only §6.2 transfer or `pending-abort`. Stale capabilities fail the updated registry/fence CAS. If any no-mutation/rollback proof is unavailable, the reservation remains fail-closed rather than being silently released.

`capabilityId` and `delegationId` are distinct, globally unique opaque identifiers generated by the controller. They are never derived from attacker-controlled display text, and a `(capabilityId, delegationId)` pair may be issued only once in the authoritative issuance/revocation store. `body.issuer` MUST be a trusted controller key ID, `proof.keyId` MUST equal it, and the proof MUST be an Ed25519 signature over:

```text
UTF8("ForgeDock-Capability-Signature-v1\0") ||
UTF8(profile) || 0x00 || UTF8(capabilityId) || 0x00 ||
UTF8(delegationId) || 0x00 || UTF8(JCS(body))
```

The signature binds every present body field, including the selected revision member, complete action-specific request scope, nonce, parent, audience, subject, run, validity interval, coordination key, and constraints. Because body shape validation rejects missing, forbidden, and unknown members before signature acceptance, the proof is accepted only for the exact permitted field set and therefore also binds the absence of every forbidden revision or request-scope member. An issuer string alone, a copied key ID, an unsigned object, or a bundle-contained issuance record is never proof of issuance. The configured trust root/checkpoint, not the capability itself, authenticates the issuer key.

At every authorization boundary, the controller MUST authenticate and traverse the complete root-to-leaf capability lineage before policy evaluation, operation creation, nonce consumption, disclosure, or mutation. For every ancestor and the leaf, it MUST obtain the exact envelope and current lifecycle record from the authoritative issuance/revocation store; verify the issuance identity, canonical shape, signature, and issuer against the configured trust root and current issuer lifecycle; use trusted controller time to require `issuedAt <= now < expiresAt`; and verify current non-revocation. It MUST also verify an acyclic chain with exact parent IDs and depth increments, all registered subset rules, and every child interval statically contained within its parent's interval. Missing, unavailable, revoked, expired, cyclic, rolled-back, inconsistently linked, invalidly signed, or otherwise unverifiable lineage evidence denies the descendant.

Current lifecycle validation of every lineage member is independent of static child-interval containment. Revoking an ancestor immediately invalidates every descendant for new authorization, even when the descendant's signature, interval, and scope remain valid in isolation. A trusted controller-only recovery path MAY inspect and reconcile durable work already started under the original immutable operation, but ancestor or leaf expiry/revocation MUST NOT become new presenter authority, authorize a changed request, or disclose a result to an unauthenticated or currently unauthorized caller.

The signed `audience` is an opaque, controller-generated, globally unique, never-reassigned identifier for an immutable authoritative audience registration. That registration binds the exact controller installation, adapter, worker, session, and non-secret authentication binding; display names and caller-supplied request fields are not registrations. At every authorization boundary, the controller MUST derive the complete presenter binding from its authenticated channel/session state, obtain the current registration and session from authoritative controller-side state, and compare the derived installation/adapter/worker/session/authentication binding exactly with the signed audience registration. An absent, expired, revoked, unavailable, reassigned, or mismatched registration/session, a caller-asserted audience or identity, or possession of the capability alone denies authorization.

The semantic body has these rules:

| Field | Rule |
| --- | --- |
| `issuer` | Trusted controller `keyId`; an unknown, revoked, or non-controller issuer is denied |
| `audience` | Opaque identifier of the current immutable controller-side audience registration whose complete installation/adapter/worker/session/authentication binding MUST equal the authenticated presenter; wildcard, reassigned, descriptive, or caller-asserted audiences are forbidden |
| `action` | One closed action above |
| `subject` | Exact canonical subject, or an explicitly registered subject set; aliases and URLs are not equivalent |
| `runId` | Required for every action in this profile and equal across issuance, lineage, controller decision/request, operation, host request/result, retry, and reconciliation |
| action request scope | Exactly the one member registered by the closed action-scope matrix; its complete bytes and any exact content bytes/digests MUST match at every boundary |
| `artifactAppend` | Required only for `artifact.append`; all seven members, the computed complete-artifact digest, and exact frozen unsigned body MUST equal the schema-validated artifact, delegated lineage, controller/host request, append CAS, and immutable operation record |
| `reviewedSha` | Required only for `review.record` and `merge.request`; it MUST equal `payload.reviewedSha` in the exact registered request artifact, the exact current decision scope, controller-requested operation, every capability in the delegated lineage, and the freshly observed host head |
| `reviewDecision`, `mergeDecision` | Required only for their corresponding action and MUST bind the exact protected artifact IDs/digests, subject/action/disposition/supersession chain, and authenticated current-decision pointer defined above; merge additionally requires the current non-superseded disposition `approve` |
| `sourceSha` | Required only for `pr.publish`; it MUST equal the exact full lowercase `BuildResult.payload.headSha` from the controller-selected, verified BuildResult for the same run, repository, and exact `originSubject`, and the value in the controller request, every capability in the delegated lineage, and the durable operation record |
| `publicationTarget` | Required only for `pr.publish`; the complete closed target, stable host authority, signed source-ref policy, origin subject, registry run, BuildResult subject/reference/version, lifecycle, ref tuple, and remote/PR preconditions defined above MUST equal the controller request, delegated lineage, authoritative publication registry, host request, and durable operation record |
| `issuedAt`, `expiresAt` | UTC instants; `issuedAt < expiresAt`, bounded by controller policy; expired or excessive lifetime is denied |
| `parentCapabilityId`, `depth` | Null/zero only for an original grant; otherwise exact parent and depth increment, maximum depth 3 |
| `nonce` | Unique random value bound by the proof and issuance record |
| `oneShot` | Boolean; if true, atomic consumption and the capability/nonce operation formula apply; if false, every invocation requires the controller-issued logical request ID, reusable operation formula, and complete-request digest defined below |
| `constraints` | Registered, closed constraints; they include the exact canonical coordination-key set when the action is lease-dependent, and `pr.publish` always requires its non-null source-ref key |

For `review.record` and `merge.request`, the controller MUST freshly read the protected PR head and authenticated current-decision pointer/chain at the action boundary. It denies a stale or unequal `reviewedSha`, substituted decision artifact, superseded/revoked verdict, or merge scope whose current disposition is not `approve`; this capability rule does not change [§3.1](#envelope) or add a revision member to any other protected artifact. For `pr.publish`, `sourceSha` and `publicationTarget` are capability, request, delegation, and host-operation scope only. They are not protected artifact payload members, are not added to the `forgedock.protected/v1` envelope or signature input, and do not broaden the protected kind/action registry.

Delegation is a strict subset operation: a child MUST preserve issuer scope, action, subject, required run, the action's exact revision binding, and the complete registered request-scope member while narrowing audience, validity, constraints, or permissions only as registered. Audience narrowing MUST name another immutable audience registration through an authoritative controller-registered delegation/subset relation; opaque IDs, display text, or caller assertions do not establish that relation. The actual presenter MUST match the leaf's complete audience registration, while every ancestor registration remains authenticated lineage and subset evidence. Thus every ancestor and child MUST preserve the same permitted revision field name and exact value, or preserve the explicit no-revision state; a child MUST NOT add, remove, rename, or change that binding or substitute request bytes/content. An `artifact.append` child additionally MUST preserve every `artifactAppend` member. Review/merge children preserve every decision identity, digest, disposition, and supersession/current-pointer member. A `pr.publish` child additionally MUST preserve every `publicationTarget` member—including `hostAuthorityId`, `sourceRefPolicy`, `originSubject`, and `registryRunId`—and the exact source-ref coordination key; issuance/delegation repeats the subject/run, BuildResult-subject, trusted-head-repository, unequal physical head/base, and configured source-namespace checks. A child is signed by the issuing controller and names its authenticated parent. The controller records lineage and rejects cycles, reused IDs, duplicate semantic issuance, and a child whose interval, audience registration/relation, key set, revision binding, publication target, or other scope is outside its parent.

For `oneShot: true`, replay consumption is an atomic compare-and-set in the authoritative replay store. After completing the lineage and presenter checks above, the controller reserves the nonce and commits the decision. Every one-shot action, including reads and exports, preserves the existing formula `operationId = SHA-256(UTF8("ForgeDock-Capability-Operation-v1\0") || UTF8(capabilityId) || 0x00 || UTF8(nonce))` (lowercase hex). The controller creates its immutable authoritative operation record before disclosure or mutation; for a host mutation, that operation ID is also the host idempotency key.

For each complete logical invocation of a `oneShot: false` capability, the controller MUST issue a globally unique `logicalRequestId`; callers cannot choose or reuse it to describe new work. Reusable invocation metadata is controller request/operation metadata and does not change the capability envelope. The reusable operation ID is separately domain-separated and is lowercase hex:

```text
operationId = SHA-256(
  UTF8("ForgeDock-Reusable-Capability-Operation-v1\0") ||
  UTF8(capabilityId) || 0x00 || UTF8(nonce) || 0x00 || UTF8(logicalRequestId)
)
```

Before creating that reusable operation, the controller MUST freeze a closed, action-specific `completeFrozenLogicalRequest` with no omitted or implicit authority-bearing values. It contains the exact capability identity (`capabilityId` and `delegationId`) and nonce; `logicalRequestId`; signed audience-registration ID and complete registered non-secret authenticated presenter binding; canonical subject; required run; action; a tagged revision binding carrying `reviewedSha` and its value, `sourceSha` and its value, or explicit **no revision**; and the named complete registered action-scope value. It also contains the exact content bytes in their required canonical representation or every contract-required canonical byte binding/digest/length, as applicable; protected decision identities/digests/disposition and authenticated currentness/supersession observations; and all applicable publication target, registry/checkpoint/generation, reservation, coordination-key, authenticated owner-token binding, and fencing data. The controller computes:

```text
logicalRequestDigest = "sha256:" + lowercase(hex(SHA-256(
  UTF8("ForgeDock-Reusable-Capability-Logical-Request-v1\0") ||
  UTF8(JCS(completeFrozenLogicalRequest))
)))
```

The authoritative operation store enforces immutable `(capabilityId, logicalRequestId)` identity. Its first-use CAS records the exact `operationId`, `logicalRequestDigest`, and complete frozen request. An exact-ID/exact-digest replay, after current lineage and presenter authorization succeeds, MAY only resume reconciliation or return the original result; it creates no new side effect or result. Reuse of that logical request ID with another operation ID, another digest, or any changed request byte is denied before disclosure or mutation. A fresh controller-issued logical request ID under a reusable grant creates a distinct operation ID and MAY produce a distinct result only while the leaf, every ancestor, presenter registration/session, required authoritative stores, trusted time, and policy are currently valid.

For both one-shot and reusable operations, the immutable authoritative operation record MUST bind the exact subject, required run, action, revision binding (`reviewedSha` plus its value, `sourceSha` plus its value, or the explicit no-revision state), and exact complete request-scope member from the matrix. For content-digest scopes, it also binds the exact validated content bytes supplied to the host. For `artifact.append`, that record additionally binds the exact canonical unsigned artifact bytes and verified `artifactDigest`; any envelope substitution conflicts before signing, nonce consumption, or append. For review/merge, it binds the protected request and decision artifact IDs/digests, disposition, complete supersession/current-pointer scope, and fresh boundary observation. For `pr.publish`, it additionally binds the stable host authority, source-ref policy, source-ref reservation, coordination key/owner token/fencing sequence, expected registry record/version/digest, and durable publication generation. A reusable record also stores its logical request ID and digest. The host request, result, retry, and reconciliation carry the same scope and operation identity.

A `pr.publish` operation record starts without a result and may be completed exactly once. Its mutable status projection is CAS-bound to the immutable request and has exactly `status`, `pendingRegistryVersion`, `pendingRegistryRecordDigest`, `failure`, and `updatedAt`. `status` is `frozen`, `pending`, `succeeded`, `failed`, `indeterminate`, or `recovery-required`; pending fields are null only before pending entry or after a proved no-mutation abort, and `failure` is null except for exactly `{ "boundary": "preflight"|"remoteSource"|"prAllocation"|"prUpdate"|"markerReplace"|"finalization"|"completion", "classification": "conflict"|"denied"|"unsupported"|"indeterminate", "observedAt": "..." }`. Trusted controller/adapter time supplies `updatedAt`, and every status/cursor change is durable and idempotent by the original operation ID. Only `succeeded` has a result. Its result has exactly `prSubject`, `immutablePrRef`, `prState`, `hostAuthorityId`, `sourceRefPolicy`, `headRepo`, `headRef`, `baseRepo`, `baseRef`, `sourceSha`, `runMarker`, `publicationReceipt`, `completedRegistryVersion`, and `completedRegistryRecordDigest`. The last two members identify the completed registry record committed after receipt verification and are distinct from the pending-record version/digest inside `publicationReceipt`. `prSubject` is the canonical returned `github.pr` subject. `immutablePrRef` is exactly `{ "hostAuthorityId": "...", "resourceType": "github.pr", "resourceId": "..." }`, where `hostAuthorityId` equals the stable target/discovery authority and the non-empty `resourceId` is immutable within that host authority's authenticated resource namespace rather than a URL or title. Ephemeral `hostInstanceId` is permitted only in discovery and receipt freshness metadata; it is never part of PR identity, registry uniqueness, marker identity, or equality across restart/failover. `prState` MUST be `OPEN`. `runMarker` is the complete authenticated marker defined above and its body values come from the frozen operation and returned immutable reference. The remaining members exactly match `publicationTarget` and the fenced receipt defined in §6.2.

For `create`, the controller atomically records that returned PR and immutable reference against `publicationId`; capability subject MUST still equal registry `originSubject`. For `reuse`, both MUST exactly equal the capability subject and existing registry mapping. In both lifecycles capability/request/BuildResult run MUST equal registry `runId`/target `registryRunId`. A completion naming another PR/reference or PR state, branch, base, source SHA, run marker, publication identity/version, or operation ID conflicts and is never accepted as reconciliation.

A success, failure, or indeterminate host result is durably associated with the original operation. Replay, retry, or reconciliation with a different subject, run, action, revision field/value, any request-scope field/content, decision artifact/currentness, publication target, coordination fence, or attempted revision for a no-revision operation is denied and MUST NOT create a new mutation. After an indeterminate mutation, the operation is never retried under a new operation ID or reusable `logicalRequestId`; the controller reconciles the original immutable request before retry, and a completed operation returns only its original result to a currently authorized presenter. A genuinely distinct reusable invocation requires a fresh controller-issued logical request ID and cannot be used to evade reconciliation of uncertain work. A crash leaves an unambiguous consumed/committed/reconcile state. Reusable capabilities still require current validation of the complete lineage and presenter, exact request/digest binding, and the same conflict checks at every durable operation and disclosure boundary.

Unknown constraints, unavailable issuer, issuance/revocation, audience-registration, authenticated-session, or replay/operation records, absent replay state, clock uncertainty beyond configured skew, a revoked or expired lineage member, unsupported delegation, an unknown field, a missing exact subject/run, required revision, required action-scope member/content, or source-ref coordination key, or a present forbidden revision or request-scope member are default-deny conditions. Capability possession never authorizes merge, publication, review, closure, disclosure, or a transition without the typed controller's committed decision and a currently authenticated matching presenter.

<a id="subjects"></a>
## 6. Canonical subjects and host adapter conformance

### 6.1 Subject identity

A subject is a typed object, not a URL or display name. Canonical subject objects use lower-case `type` and exact normalized repository identity:

- repository: `{ "type": "github.repo", "repo": "owner/name" }`;
- issue: `{ "type": "github.issue", "repo": "owner/name", "number": N }`;
- pull request: `{ "type": "github.pr", "repo": "owner/name", "number": N }`;
- commit: `{ "type": "git.commit", "repo": "owner/name", "sha": "full-lowercase-sha" }`.

For GitHub, `owner/name` is the host's canonical API identity, case-normalized to lower case only after the adapter confirms the repository; no URL, clone URL, `#number` shorthand, fork alias, organization alias, or display title is accepted as an equivalent subject. Numbers are positive safe JSON integers in `1..9007199254740991`; larger values are invalid. A PR and an issue with the same number are different subjects. The subject is encoded with [§3.2](#canonical-bytes) and signed exactly.

### 6.2 Discovery and conformance

Every host adapter MUST expose a canonical, controller-authenticated discovery envelope. The response contains `profile: forgedock.host-discovery/v1`, `adapterId`, `adapterVersion`, stable configured `hostAuthorityId`, ephemeral `hostInstanceId`, exact endpoint and repository binding, supported subject types and operations, exact-SHA behavior, comment/artifact limits, event properties, compare-and-swap/lease properties, `issuedAt`, `validFrom`, `expiresAt`, a strictly increasing host capability `epoch`, the controller's fresh random `challenge`, and `proof` signed by a configured adapter/host trust root. The proof covers the complete JCS body; a discovery time alone is insufficient. The controller rejects a response with a wrong challenge, host/endpoint/repository/adapter binding, unknown signer, non-increasing rollback epoch, revoked signer, `now < validFrom`, `now >= expiresAt`, or age beyond the configured maximum. A fresh challenge is required before each protected operation class (or a documented maximum-age probe tied to that operation); cached evidence never crosses its expiry or host epoch. Stale, replayed, downgraded, missing, or unverifiable discovery is `unverifiable` and its advertised guarantee is unavailable, not inferred from an unrelated successful API call.

An adapter conformance suite MUST test canonical subject round trips, repository ownership, exact full-SHA lookup, stale-head detection, idempotency keys, response-to-request binding, pagination/completeness, error classification, size limits, signed challenge discovery, expiry, replay, epoch rollback/downgrade, and authenticated host-authority binding while treating host instance only as freshness metadata. For PR publication it additionally MUST test exact issue/PR lifecycle identity and `OPEN` state, full head/base tuple selection, immutable returned PR references, authenticated marker storage/replacement, durable registry and rollback evidence, source-ref/physical-target uniqueness, pending-generation takeover, required fencing/CAS, atomic source-SHA preconditions, and receipt signer/domain/challenge/epoch verification. It MUST distinguish permission denied, not found, conflict, rate limit, stale revision, unsupported guarantee, and indeterminate network result. An indeterminate mutation result is reconciled by its original idempotency key, exact subject, complete publication target when applicable, and action-specific revision binding before retry; the controller MUST NOT blindly duplicate a side effect.

Minimum guarantees are:

| Operation | Mandatory host guarantee | If unavailable |
| --- | --- | --- |
| Publish artifact | Durable append CAS matching all seven `artifactAppend` members, the exact canonical unsigned artifact bytes and verified complete-artifact digest, exact envelope/capability subject/run/action association, immutable idempotency record, returned immutable reference, and read-after-write verification | Do not sign or claim published, consume the nonce, or proceed on an unverified/substituted result |
| Publish PR | One fenced, linearizable publication protocol bound to the exact subject/run, stable host authority, trusted discovered repository, complete signed-policy `publicationTarget`, authenticated registry/reservations, BuildResult identity/digest/subject/version, `sourceSha`, operation ID/generation, and stable source-ref coordination token/sequence; CAS at every applicable create or combined reuse/finalization boundary; an exact `OPEN` canonical returned PR subject plus stable immutable host reference and authenticated run marker; and a domain-separated, challenge/epoch-bound fresh result receipt | Discovery marks protected PR publication unsupported and the controller denies it before the first external mutation |
| Read artifact / export bundle | Return only the exact artifact ID/digest or exact manifest/member set in the signed action scope, with run/subject and response digest verification | Deny disclosure/export; never broaden to repository contents or another artifact/member set |
| Comment / label mutation | Recompute the exact comment-byte digest/length or compare the exact label mutation/list from the signed action scope at the host mutation boundary and bind the durable result to that operation | Deny before mutation; no template expansion, truncation, implicit label, or substituted body/list |
| Record review | Read the exact full reviewed SHA and current decision pointer, compare the bound ReviewVerdict ID/digest/disposition and controller-scoped prior-decision digest, and atomically install it as current while proving the head remains that SHA | Review is stale/unverifiable; do not record, approve, or merge |
| Merge | Host-enforced source/base/head identity, current checks/policy, idempotent result, exact MergeRequest identity/digest, exact current non-superseded approving ReviewVerdict identity/digest/disposition/chain at the same SHA, and—when lease-dependent—an atomic current coordination-key/token/fencing-sequence check at the host mutation linearization point | Merge is denied; an old same-SHA approval, comment, or event cannot substitute. An adapter without host fencing is unsupported for lease-dependent merge |
| Compare-and-swap coordination | Atomic expected-version/sequence update with owner fencing and durable conflict result | Distributed lease/coordination is unsupported; do not run multi-writer coordination |
| Lease-dependent publish/review/mutation | The host MUST atomically validate the canonical coordination key, owner token, fencing epoch, exact operation ID, and current policy at the external mutation linearization point | Deny the mutation; the current GitHub surface is unsupported for this guarantee unless an adapter layer supplies it |

For `pr.publish`, discovery MUST explicitly advertise the complete fenced protocol below. The controller MUST derive `sourceSha`, `buildResultId`, and `buildResultDigest` only from one controller-selected, verified BuildResult whose repository/run equal capability subject repository, capability `runId`, target `registryRunId`, and registry `runId`, and whose signed canonical subject equals target/registry `originSubject`; for create, capability subject also MUST equal that origin subject. Target `hostAuthorityId` MUST equal fresh discovery and the globally unique configured authority for the endpoint/trust-root/repository. Both target repositories MUST equal the capability/discovery repository; forks and otherwise untrusted head repositories are denied. It MUST reject a physically equal head/base pair, a sourceRefPolicy mismatch, or a head ref outside the configured source namespace before reservation or capability issuance. It allocates `publicationVersion` by registry CAS, acquires the exact dedicated source-ref key, and freezes the operation record with the complete signed `sourceRefPolicy`, owner token, and fencing sequence. Before the first external mutation, the retained workspace commit and selected local source ref MUST equal `sourceSha`; current signer lifecycle, registry record/digest/checkpoint, reservations, BuildResult identity/digest/subject, publication version, subject/run/host-authority bindings, source policy/namespace, trusted repository, unequal physical refs, and prior marker MUST still equal the frozen request; and fresh host state MUST satisfy both target preconditions including `OPEN` for reuse. The controller then CASes one exact ready registry predecessor to one pending generation. A preflight failure may use the authenticated `unallocated-abort` path in §5; it never releases mutation authority.

A pending-publication value is either `null` or a closed object with exactly `state`, `operationId`, `publicationVersion`, `publicationGeneration`, `expectedReadyRegistryVersion`, `expectedReadyRegistryRecordDigest`, `hostAuthorityId`, `hostEpoch`, `discoveryChallenge`, `ownerTokenDigest`, `fencingSequence`, `expectedRemoteRefPrecondition`, `expectedPriorMarkerDigest`, `provisionalPrSubject`, `provisionalImmutablePrRef`, `proposedRunMarker`, `boundaryStatus`, and `failure`. `state` is `pending`, `receipt-ready`, `abort-ready`, or `recovery-required`. `expectedPriorMarkerDigest` is null only for create marker absence; otherwise it is the §5 digest of the complete expected marker. The three provisional members are null until allocation/marker construction and thereafter exact; `proposedRunMarker` is the complete marker, and once `markerReplace` is `completed` its digest MUST equal the protected host current-marker pointer until the final CAS commits top-level registry allocation and `currentRunMarker`. `boundaryStatus` is exactly `{ "remoteSource": S, "prAllocation": S, "prUpdate": S, "markerReplace": S, "finalization": S }`, where each `S` is `not-started`, `not-applicable`, `completed`, `failed`, or `indeterminate`; completed boundaries never regress or repeat. `failure` is null or exactly `{ "boundary": "remoteSource"|"prAllocation"|"prUpdate"|"markerReplace"|"finalization", "classification": "conflict"|"denied"|"indeterminate"|"unsupported", "observedAt": "..." }`.

A registry record is **ready** exactly when `tombstone` is `null`, `pendingPublication` is `null`, its chain/version/digest/checkpoint and reservations are current and verified, and its allocation tuple is internally complete: either (a) `allocationState` is `unallocated` and `prSubject`, `immutablePrRef`, `prState`, and `currentRunMarker` are all `null`, or (b) `allocationState` is `allocated`, those four members are all non-null, `prState` is `OPEN`, and their subjects/references/marker equal the registered target. No operation status is named `ready`; it is this exact registry predicate. A tombstoned record, a record with any other null combination, terminal/unknown PR state, pending overlay, stale checkpoint, or reservation mismatch is not ready. `expectedReadyRegistryVersion` and `expectedReadyRegistryRecordDigest` MUST identify the exact predecessor satisfying this predicate; the pending CAS consumes that tuple and writes version plus one.

The overlay's expected version/digest identify the ready predecessor and never the containing record. The current pending record's independently computed `(registryVersion, registryRecordDigest)` is supplied beside the overlay in every CAS, host request, receipt, and takeover record. Each mutating host boundary MUST atomically update both its durable operation cursor and the signed pending registry overlay in the same trusted adapter/registry transaction as the ref/PR/marker mutation; therefore a crash cannot leave an unrepresented staged mutation. The exact overlay permits only its recorded expected-old/provisional-new marker divergence. A surface unable to provide this atomicity is unsupported. The generation remains authoritative across controller crash, lease expiry, registry/adapter restart, and failover.

The protocol has these linearization requirements:

1. **Remote source boundary (create only).** Before touching a ref for `create`, one host transaction MUST reject equal canonical physical head/base refs and revalidate stable host authority, trusted head repository, signed source-ref policy/allowlist, exact `originSubject`/run equalities, BuildResult subject, and current registry signer/checkpoint. A push is a host-enforced CAS from exact `remoteRefPrecondition` (including absence) to `sourceSha`; selection without push atomically compares the ref to `sourceSha`. The same transaction validates the complete tuple, current pending record version/digest, unique reservations, exact dedicated source-ref key, owner/fence, generation, operation/version, and BuildResult, then advances `boundaryStatus.remoteSource` with the ref change. A reservation owned by another publication is rejected before changing the ref. `reuse` MUST NOT move its source ref at this separate boundary; its `remoteSource` cursor remains `not-started` until the combined reuse/update boundary below. A preflight read followed by an unconditional push/selection is non-conforming.
2. **Create boundary.** `create` MUST atomically prove capability subject equals registry/target `originSubject`, all capability/request/BuildResult/registry run IDs match, the publication remains unallocated, physical head/base refs differ, source namespace remains allowed, remote head is `sourceSha`, marker is absent, and operation/fence/version/generation/current pending digest and reservations match. In one transaction it allocates exactly one `OPEN` PR, reserves its immutable reference/tuple, constructs and appends the marker, CASes current marker absent-to-new, records all provisional values, and marks allocation/marker boundaries completed. Discovery by branch, first result, or another base is forbidden. Any mismatch leaves ref/PR/marker/registry cursor unchanged at this boundary.
3. **Combined reuse/update boundary.** `reuse` addresses the exact registered PR/reference, never branch discovery, and this is its sole source-ref mutation linearization point. On entry the host atomically compares both the remote ref and PR head to the frozen prior values (`remoteRefPrecondition` and `prPrecondition.headSha`, normally old revision `A`), plus the complete expected marker, exact PR/reference/`OPEN`/tuple, current pending version/digest, stable authority, signed source policy, unequal refs, BuildResult subject, subject/run bindings, reservations, operation/fence/version/generation, and still-`not-started` reuse cursors. In that one fenced transaction it CASes the ref from the expected prior SHA to desired `sourceSha` (for example `B`), proves the bound PR now resolves to `B`, appends/replaces the marker with the proposed `B` marker, records provisional values, and advances `remoteSource`, `prUpdate`, and `markerReplace` to `completed`. The prior `A` checks are preconditions; `B` is a postcondition and is not required before this transaction. Retry/takeover recognizes the transaction only by its authenticated operation/generation and completed cursors, so an external move to `B` cannot be mistaken for this operation's work. Any unexpected `C`, stale/copied marker, another PR/base/publication, terminal PR, duplicate reservation, or scope mismatch produces no mutation.
4. **Finalization boundary.** The adapter freshly and atomically compares returned PR identity/reference, `OPEN`, tuple, current marker, reservations, current pending record, remote/PR heads, subject/run, source namespace, unequal refs, BuildResult, and operation/fence. It advances finalization to completed and state to `receipt-ready` in a new signed pending record and durably binds one receipt to that exact record. The closed `publicationReceipt` has exactly `profile`, `hostAuthorityId`, `hostInstanceId`, `sourceRefPolicy`, `hostEpoch`, `discoveryChallenge`, `publicationGeneration`, `pendingRegistryVersion`, `pendingRegistryRecordDigest`, `operationId`, `publicationId`, `originSubject`, `runId`, `publicationVersion`, `buildResultId`, `buildResultDigest`, `prSubject`, `immutablePrRef`, `prState`, `headRepo`, `headRef`, `baseRepo`, `baseRef`, `sourceSha`, `runMarker`, `fencingSequence`, `observedAt`, and `proof`. `profile` is `forgedock.publication-receipt/v1`, `prState` is `OPEN`, and `proof` is exactly `{ "keyId": "...", "algorithm": "Ed25519", "signature": "<unpadded-base64url>" }`. The signature is:

```text
publicationReceiptSignatureInput =
  UTF8("ForgeDock-Publication-Receipt-Signature-v1\0") ||
  UTF8(profile) || 0x00 || UTF8(JCS(receipt-without-proof))
```

The proof key MUST have been active at trusted adapter-supplied `observedAt` and MUST be currently non-revoked when the receipt authorizes completion. `hostAuthorityId`, ephemeral `hostInstanceId`, epoch, and challenge equal fresh authenticated discovery, and `sourceRefPolicy` equals the exact frozen target/registry/operation policy. The pending version/digest identify the exact `receipt-ready` registry record, not its predecessor or later completed record. The controller verifies shape, bytes, domain, signer lifecycle, epoch/challenge, full target/subject/run/operation binding, cursor, and durable generation, then atomically CASes that pending tuple to a final registry record with `pendingPublication: null`, committed allocation/marker/result, successor version/digest, and advanced checkpoint. It stores that final tuple as `completedRegistryVersion`/`completedRegistryRecordDigest` in the operation result. A prior challenge, revoked key, or missing/inconsistent operation state is denied. Crash reconciliation obtains fresh discovery and may re-attest only the same durable completed generation; an old receipt alone cannot commit.

The host/adapter MUST keep that pending generation fenced from every source-ref or PR mutation until the controller atomically CAS-commits the exact receipt, current marker, registry version, and completed state. A changed ref, PR head/state, target, marker, BuildResult/version, operation ID, registry digest, or fence aborts finalization and cannot be recorded as published.

Lease expiry never clears or supersedes a pending publication generation. The expired owner loses write authority, but unrelated operations remain fenced. A takeover owner with a higher source-ref fencing sequence MUST first authenticate and reconcile the exact durable pending generation. It then atomically either (a) commits an already receipt-ready result after fresh re-attestation, (b) transfers that same generation to its new owner-token digest/sequence and resumes only incomplete idempotent boundaries, or (c) marks it `abort-ready` only when the host atomically proves no publication mutation occurred or atomically rolls back all of that generation's mutations before releasing reservations. Transfer appends an authenticated takeover record to the immutable operation history; it does not change operation ID, target, version, source, or completed boundaries, and the old owner is fenced. `abort-ready` releases nothing by itself: one final CAS from the exact current pending version/digest MUST commit a `pending-abort` tombstone, authenticated rollback/no-mutation evidence, updated checkpoint, operation failure state, and reservation releases together. If exact reconciliation/transfer/abort proof is unavailable, the generation enters a fail-closed `recovery-required` condition and continues to block source-ref/PR mutation; it is never treated as expired authorization or a free target.

Every boundary MUST reject a stale fence or competing valid source revision before mutation. The same operation ID, immutable target, preconditions, and pending generation apply to first execution, retry, takeover, and reconciliation; except for the authenticated pending-generation transfer above, the frozen scope cannot change. A retry may advance only the original protocol state and cannot repeat a completed boundary. If the host surface cannot atomically compare all required state at a boundary, cannot prevent intervening target changes through finalization, or cannot return and freshly re-attest the immutable receipt, discovery MUST mark protected PR publication unsupported and the controller MUST deny the capability before the first push, PR creation, or update. Separate read-before/read-after calls, post-mutation mismatch detection, ordinary idempotency alone, and a per-capability nonce or publication-ID-only fence do not satisfy this guarantee.

A known mismatch or lost race produces no mutation at the affected boundary. An indeterminate transport result remains associated with the original operation ID/generation and is reconciled only through authenticated registry history, protected host marker state, the host's fenced operation state, and a fresh immutable receipt. A protected adapter MUST NOT perform a wrong-source or wrong-target mutation and later classify it merely as failure/indeterminate; such behavior is non-conforming and disables protected PR publication. No result is reported as published until the controller has committed the exact receipt.

GitHub comments, labels, checks, and webhooks report durable facts or requests. None is an authority path. The controller alone interprets them and commits a transition.

### 6.3 Focused capability and publication conformance vectors

In these vectors, `A = 0123456789abcdef0123456789abcdef01234567` and `B = 89abcdef0123456789abcdef0123456789abcdef`. Unless a row says otherwise, the envelope, proof, lineage, audience registration, authenticated presenter, BuildResult, host discovery, policy, and replay evidence are valid and current. “No mutation” means no new external side effect may be created; reconciliation may only inspect or return the result of the original operation.

| Vector | Input condition | Required authorization and mutation outcome |
| --- | --- | --- |
| Non-revision absence accepted | `issue.comment` has required `runId` and exact `issueComment` scope but neither `reviewedSha` nor `sourceSha` | Capability shape is authorized for policy evaluation; only the digest-bound comment bytes may be submitted after the controller decision |
| Valid no-revision protected artifact | A schema-valid signed `BuildResult/artifact.append` omits `payload.reviewedSha` and both capability revision members as required by its registered schemas | Artifact verification may return `verified`; absence is not `incomplete`, and no placeholder SHA is introduced |
| Non-revision field forbidden | `artifact.read` includes `reviewedSha: A` (the same result applies to `sourceSha`, `artifactAppend`, or `publicationTarget`) | Deny before policy and nonce consumption; no mutation |
| Artifact append content substitution | A valid `artifact.append` capability binds `BuildResult`, artifact ID `art_A`, payload/artifact digests `D1`/`AD1`, sequence 4, predecessor `P`, and exact unsigned bytes; request/retry supplies another kind, ID, payload, digest, sequence, or predecessor | Deny before signing, nonce consumption, append CAS, or host mutation; reconciliation may inspect only the original exact append operation |
| Artifact append envelope substitution | The same operation preserves payload and six legacy append values but changes artifact `subject`, `runId`, `createdAt`, `producer`, action, `keyId`, or any other unsigned-envelope byte | Recomputed `artifactDigest`/body bytes conflict; deny before signing or append and create no alternate artifact under that operation ID |
| Comment/label/read/export substitution | A valid capability binds comment digest `D1`, label operation/list `L1`, artifact ID/digest `R1`, or export manifest/member set `E1`, but the controller/host/retry supplies different bytes, operation/list, artifact, or members under the same capability/operation ID | Recompute/compare the complete action scope and deny before host mutation, disclosure, or export; reconciliation may return only the original scoped result |
| Run-scope substitution | Any action omits required `runId` or a child/request/host operation changes run `R1` to `R2` while preserving other fields | Deny shape or binding before nonce consumption, read, export, or mutation |
| Fully active delegated lineage | Root, intermediate ancestors, and leaf all have available authoritative issuance/revocation records, valid signatures and current issuers, exact acyclic parent/depth/subset links, intervals containing trusted `now`, and no revocation | Lineage authorization succeeds and may proceed to presenter validation and policy; no ancestor is inferred from leaf validity alone |
| Revoked capability ancestor | An intermediate or root capability is currently revoked while the descendant remains independently well-formed, unexpired, and unconsumed | Descendant authorization is immediately denied before policy, operation creation, nonce consumption, disclosure, or mutation; controller-only recovery may inspect only an already-started immutable operation |
| Expired or unavailable capability ancestor | An ancestor is expired at trusted controller time, or its issuance/revocation record, signature evidence, issuer lifecycle, or parent link is missing or unavailable | Treat the lineage as unauthorized or unverifiable and deny the descendant before policy, operation creation, nonce consumption, disclosure, or mutation |
| Two reusable logical invocations | One currently valid `oneShot: false` capability is used for two complete requests with fresh controller-issued logical request IDs `L1` and `L2` | The reusable operation formula produces distinct operation IDs; each request/digest is independently recorded and, if both complete, returns a distinct operation-bound result record rather than aliasing either invocation to the other |
| Exact reusable replay | A retry presents the same `capabilityId`, `logicalRequestId`, operation ID, logical request digest, complete frozen request bytes, and currently authenticated lineage/presenter as the first invocation | Perform no second side effect; only resume the original reconciliation or return the original result |
| Mismatched reusable request-ID reuse | A request reuses `L1` but changes any frozen request byte, digest, subject/run/action, audience/presenter binding, revision state, action scope/content, decision/currentness value, publication data, coordination data, or fence | Deny before disclosure or mutation; do not overwrite the immutable tuple, create an alternate result, or reconcile it as the original request |
| Exact authenticated audience session | The signed opaque audience resolves to a current immutable registration and the controller-derived authenticated installation/adapter/worker/session/authentication binding exactly matches it | Presenter validation succeeds and authorization may continue; capability possession and request text contribute no identity evidence |
| Stolen or unauthenticated audience presentation | A valid envelope is presented from another session, or the registered/presenting session is expired, revoked, missing, unavailable, or supplied only as caller-asserted audience/worker/session fields | Deny before policy, operation creation, nonce consumption, read/export disclosure, or mutation, including denial of any stored result |
| Required review revision missing | `review.record` or `merge.request` omits `reviewedSha` | Deny as incomplete capability scope; no review or merge mutation |
| Protected-v1 ReviewVerdict compatibility | A schema-valid `ReviewVerdict/review.record` contains its registered verdict/disposition/check fields and `payload.reviewedSha` but no `payload.supersedes` | Evaluate it under the unchanged `forgedock.protected/v1` payload schema; omission is not `incomplete`. A `payload.supersedes` member is an unregistered extra member and is rejected; authenticated controller decision scope separately carries the prior/current-decision binding |
| Required publication scope missing | `pr.publish` omits `sourceSha`, `publicationTarget`, or its non-null source-ref coordination key | Deny as incomplete capability scope; no push, PR creation, reuse update, or publication claim |
| Equal physical head/base ref | A create/reuse target resolves head and base to the same physical `(hostAuthorityId, repo, ref)`, including aliases such as both naming `refs/heads/main` | Reject at registration/reservation and again at issuance, freeze, and every host boundary; no remote ref, PR, marker, registry allocation, or receipt mutation |
| Disallowed source namespace | `headRef` is a default/protected/base/release ref or falls outside the configured source-ref allowlist | Deny before reservation/capability issuance; if policy changed after issuance, every boundary denies before remote mutation |
| Create issue/run confused deputy | Capability subject is issue 91 but registry/target `originSubject` is issue 90, or capability/request/BuildResult run differs from registry/target run | Deny issuance/delegation/freeze or the atomic boundary, whichever first observes it; no ref, PR, marker, registry-generation, or receipt mutation |
| Review/merge head stale | A valid review/merge lineage carries `reviewedSha: A`, but the fresh PR head is `B` | Deny as wrong/stale binding; no review or merge mutation |
| Same-SHA approval superseded | Merge scope binds approving verdict V1 at `A`, then an authenticated controller decision transition records V2 at the same `A` with `request_changes`, comparing the prior current-decision pointer to `digest(V1)` and advancing it to `digest(V2)` | V1 is no longer the current decision; deny merge before mutation even if its capability is unexpired, reusable, or unconsumed and the host head remains `A` |
| Decision artifact substitution | A review/merge request preserves `reviewedSha: A` but changes the bound verdict or merge-request artifact ID/digest, disposition, controller-scoped prior-decision digest, or current-decision digest | Deny as wrong binding before review/merge mutation; another same-SHA artifact is not equivalent |
| BuildResult source mismatch | `pr.publish` carries `sourceSha: B`, but the selected verified BuildResult reference in `publicationTarget` has `payload.headSha: A` | Deny before host mutation; no push or PR mutation |
| BuildResult origin-subject mismatch | Target/registry origin is issue 90, but the selected valid BuildResult has the same repository/run/source SHA and signed canonical subject issue 91 | Deny before reservation/capability issuance or, if later observed, before host mutation; no push or PR mutation |
| Host-authority or source-policy mismatch | Target, registry, checkpoint, reservation, dedicated key, discovery, or receipt disagree on `hostAuthorityId`, or exact `sourceRefPolicy` bytes/allow decision differ | Deny before mutation and do not derive an alternate coordination domain; duplicate authority IDs for one endpoint/repository are a configuration error |
| Untrusted head repository | `headRepo` names a fork or repository other than the capability repository and fresh authenticated discovery repository, even though the BuildResult/source SHA are valid | Deny before source bytes are pushed or selected; no ref, PR, marker, registry, or receipt mutation |
| Retained workspace/source mismatch | A valid `pr.publish` capability and selected BuildResult require `A`, but the retained workspace HEAD or selected local source ref resolves to `B` | Deny before remote CAS/push, PR creation, reuse/update, marker write, or publication claim; no external mutation |
| Delegated publication mismatch | Parent `pr.publish` carries `sourceSha: A` and one target/key; the child removes, renames, or changes the SHA, any target member, or the key | Reject the child lineage before policy and nonce consumption; no host mutation |
| First PR creation | A `create` capability subject equals registry `originSubject`, all run bindings match, the publication is unallocated, head/base physical refs differ, head is source-allowlisted, and preconditions/BuildResult/version/source `A`/fence are valid | Atomically establish/select remote `A`, create exactly one `OPEN` PR for that tuple, install the marker, advance the pending cursor, return/register its canonical PR/reference, and commit only its fresh fenced receipt plus completed registry digest |
| Unmarked pre-existing PR registration | A closed controller-signed `forgedock.pr-registration/v1` request and committed decision bind an exact unclaimed `OPEN` PR, immutable ref, stable authority/policy, remote/PR head `A`, absent marker, BuildResult/run/tuple, registry digest, actual authenticated owner token, and fence | One transaction verifies controller and lease-owner proofs, compares every precondition, reserves identities, installs marker, commits registry/checkpoint, and completes the typed result; only a later higher-version `reuse` capability may issue |
| Untrusted registration caller | A worker/adapter submits a shape-valid registration body with a self-chosen operation/owner-token digest but no valid current controller proof/decision, or cannot present the actual lease owner token matching that digest/fence | Host/registry rejects before marker, reservation, registry, or PR mutation; a signed success result cannot be used to bootstrap missing request authority |
| Registration race | After registration's fresh read at `A`, the remote/PR head moves to `B`, PR closes, marker appears, or registry/fence changes before linearization | Atomic registration fails with no marker, reservation, registry allocation, or later reuse authority; retry/reconciliation uses only the same operation ID/exact request |
| Exact PR reuse/update | A `reuse` capability names registered `OPEN` PR 18, its full tuple, remote/PR prior head `A`, and exact prior marker for version 1/source `A` match, and version 2 validly publishes `B` | At the combined reuse boundary, atomically compare prior `A` and marker, CAS ref/PR to desired `B`, replace the marker, advance all three cursors, and commit only the receipt bound to PR 18 and `B`; `B` is required only as the transaction postcondition |
| Reuse unexpected-C race | Reuse expects prior `A`, but before its combined boundary either remote or PR head becomes unexpected `C` (including an external move to desired `B` without this operation's cursor) | Prior-state CAS fails and creates no mutation; external `B` is not adopted as operation completion without its authenticated generation/cursors |
| Crash after combined reuse | The host commits the atomic `A` to `B` ref/PR/marker transaction and its pending cursors, then the controller crashes before finalization | Takeover observes the same operation/generation with all three cursors complete, does not compare the PR back to `A` or repeat the push, and resumes finalization against postcondition `B` |
| Stale or copied marker | Reuse expects PR 18's authenticated marker `M1`, but the current marker is absent, is `M2`, has invalid proof, or was copied from another immutable PR | Reject the marker CAS before push or PR update; no mutation or publication receipt |
| Terminal PR reuse | Reuse names PR 18 and all tuple/head/marker values match, but fresh state is `CLOSED`, `MERGED`, unknown, or unavailable | Conflict before push/update/marker replacement; no publication success. Only an already controller-committed receipt may be returned by completed-operation reconciliation |
| Wrong-base same-SHA candidate | The target names PR 18 and base `refs/heads/main`, but branch-only discovery offers a same-`A` PR for `refs/heads/release` or PR 18 freshly reports that wrong base | Reject as wrong target before create/reuse/update; do not select another candidate and make no mutation |
| Wrong-number same-SHA candidate | The registered reuse target is PR 18, but discovery/result names PR 19 with the same tuple and `A` | Reject as wrong identity; no mutation or registry/result completion for PR 19 |
| Existing PR precondition race | Reuse target PR 18 was bound with existing head `A`, but it is `B` at the first publication boundary | Atomic precondition fails before push or PR update; no mutation under this operation |
| Remote race at mutation | Preflight observed the requested remote-ref state for source `A`, but the ref changes to `B` before push, selection, create, or update | The boundary CAS rejects before its mutation; no PR is created/updated from `B` and no publication receipt is issued |
| Different publications share one source ref | P1/run R1 reserves a physical ref; P2/run R2 with another base derives the same `forgedock.coordination-key/pr-source-ref/v1` bytes/hash and attempts registration/reservation | P2 conflicts before capability issuance and receives no mutation authority; changing run/publication/base/adapter instance cannot change the key |
| Generic coordination compatibility | Existing participants canonicalize the same generic `{repository,scope,resourceKind,claim}` key while another input adds a generic `profile` field or uses the `...Generic-v1` hash domain | Conforming participants retain the exact `ForgeDock-Coordination-Key-v1` bytes/hash; the altered generic form is rejected, while dedicated `pr-source-ref` remains a separate additive domain |
| Already-issued stale source-ref operation | Two operations were issued before a reservation/fence ownership change, but only P1 now owns the physical ref and highest fence | Every P2 boundary rejects current reservation/fence before mutation; P2 cannot move P1's remote or PR head |
| Concurrent duplicate PR registration | Two publication IDs concurrently attempt to register the same immutable pre-existing PR or complete head/base tuple | The registry unique-index/marker CAS commits at most one identity; the loser observes conflict and receives no capability or mutation authority |
| Registry genesis/digest agreement | Two conforming stores receive the same version-1 record (`previousRecordDigest: null`) and proof, then the same successor | Both compute identical domain-separated complete-record digests; successor version is 2 and predecessor equals genesis digest. Any other null/version/digest is rejected |
| Ready predecessor accepted | A live verified registry record has `pendingPublication: null`, `tombstone: null`, current reservations/checkpoint, and exactly one complete valid unallocated or allocated tuple | Its exact version/digest may be consumed by one pending-generation CAS, which writes version plus one and records that tuple as `expectedReady...` |
| Invalid ready tuple | A proposed predecessor is tombstoned/pending, has stale reservations/checkpoint, or mixes `allocationState: unallocated` with a non-null PR member (or allocated with a null/terminal member) | It is not ready; reject pending entry before mutation and do not populate an expected-ready tuple by inference |
| Immutable reference survives failover | Fresh discovery changes ephemeral instance from I1 to I2 while stable authority H and immutable resource ID R are unchanged | Registry/marker/result equality remains `{hostAuthorityId:H, resourceId:R}` and recovery proceeds; I1/I2 is freshness metadata, not PR identity |
| Registry rollback or loss | A local cache presents an older publication version, or authenticated chain/checkpoint evidence is unavailable, rolled back, forked, or conflicts with a marker outside the exact pending overlay | Deny capability issuance and every mutation/reconciliation claim until authenticated recovery; do not recreate ownership from PR text or cache state |
| Revoked registry signer | A record was validly signed before revocation, but its signer is revoked when issuance, registration, boundary execution, or takeover requests current authority | Historical verification may report prior validity; current operation is `revoked` and causes no capability or mutation. Caller-supplied/backdated `committedAt` is rejected |
| Competing valid revisions | Capabilities for `A` and `B` share a `publicationId`, but only one has the current publication version and highest live fence | Only the current version/fence may cross a mutation boundary; the stale operation conflicts before mutation and cannot reconcile through the winner's result |
| Head moves during finalization | After the operation's fresh result check for `A` but before controller receipt commit, another operation attempts to move the remote or PR head to `B` | The held publication fence rejects the move, or finalization aborts before controller commit; an adapter unable to enforce this is discovered as unsupported before the first mutation |
| Crash after each publication boundary | For create remote source/allocation and finalization, and for the combined reuse ref/PR/marker boundary, the controller crashes immediately after the host transaction | Registry overlay and durable operation cursor already record the exact completed boundary/provisional state; takeover never repeats it and only resumes the next idempotent boundary or reconciles receipt/abort |
| Lease expires with pending generation | The owner expires after a publication boundary but before completed-record CAS, and a higher-sequence owner takes over | Expiry grants no mutation. The successor must reconcile and fresh-receipt commit, transfer/resume the exact generation, or prove atomic rollback/abort; otherwise `recovery-required` continues fencing the source ref/PR |
| Unallocated preflight abort | A reserved create is rejected before pending state/PR/marker/ref mutation because workspace source mismatches, discovery is unsupported, or capability expires | After lease expiry a higher-fence transaction proves no operation/host mutation and unchanged remote precondition, commits `unallocated-abort`, releases reservations, and retains checkpoint/history; absent proof remains fenced |
| Stale or ambiguous receipt | A receipt lacks the closed proof fields/domain, names a prior host epoch/challenge, uses an untrusted/revoked key, or its `pendingRegistryVersion`/digest does not name the exact receipt-ready generation | Deny completed-record CAS and publication claim. Reconciliation requires current discovery and fresh re-attestation of the same durable generation; no new mutation |
| Pending versus completed digest | A valid receipt names pending record `(V,D)`, but an operation result substitutes `(V,D)` for the required successor `completedRegistryVersion`/digest or names an unrelated final record | Deny result completion; only CAS from exact pending `(V,D)` may supply and checkpoint the distinct completed successor tuple |
| Atomic guarantee unavailable | The adapter can only read then push/create/update, discover by branch, or detect a wrong head after mutation | Discovery reports protected PR publication unsupported; deny before push or PR mutation |
| PR result mismatch | A create/reuse result names another PR/tuple/run marker or head `B` while the frozen operation requires `A` | The linearizable boundary rejects without a wrong-target or wrong-source mutation. Post-mutation detection alone is a conformance failure, never an authorized failure/indeterminate outcome |
| Conflicting replay/reconciliation | An operation is bound to `sourceSha: A` and one subject/target/fence (equivalently `reviewedSha: A` or no revision), but reconciliation requests `B`, another PR/base/ref/version/fence, changes the revision field, or adds a revision to no-revision state | Deny the conflicting request; inspect or return only the original scoped result and create no new mutation |

<a id="events"></a>
## 7. Controller events

Events are versioned reports of committed controller decisions. A protected event envelope has exactly `eventProfile`, `eventType`, `eventId`, `runId`, `subject`, `sequence`, `occurredAt`, `causationId`, `correlationId`, `decisionRef`, `decisionDigest`, `data`, `keyId`, `digest`, and `signature`. Define `unsignedEvent` as that object without `digest` and `signature`; `eventDigest = "sha256:" + lowercase(hex(SHA-256(UTF8("ForgeDock-Event-Digest-v1\0") || UTF8(JCS(unsignedEvent)))))`. The signature input is `UTF8("ForgeDock-Event-Signature-v1\0") || UTF8(eventDigest) || 0x00 || UTF8(eventId) || 0x00 || UTF8(decisionRef) || 0x00 || UTF8(decisionDigest)`. All fields, including event type, sequence, and the complete `data` value, are therefore covered. `decisionRef` and `decisionDigest` MUST resolve to the committed controller decision, and `data`/`eventType` MUST equal the controller's deterministic event projection recorded in the decision-to-event index; a matching reference with altered type or data is invalid. The publisher key and lifecycle are checked against the configured trust root, not the event itself. Authenticated transport MAY add defense in depth but never replaces the proof.

`eventId` is unique and immutable. `correlationId` identifies one workflow trajectory; `causationId` names the event or request that caused the decision, when present. `sequence` is a safe integer committed by an atomic per-run allocator/CAS. The durable store MUST enforce uniqueness of `(runId, sequence)` and `(runId, eventId)`. The controller commits the decision and a deterministic event/outbox record together, then publishes that exact record; a crash before delivery is recovered by replaying the outbox, never by inventing a new sequence or data value.

Consumers MUST verify the canonical envelope, trusted publisher, digest, signature, profile, event identity, subject/run correlation, decision reference and digest, and current event lifecycle before projection. They MUST apply events in sequence order, buffer a bounded gap, and reconcile from the durable decision-to-event index. Duplicate `eventId` or sequence is idempotent only when the complete signed bytes and decision reference match. Conflicting duplicates, unauthenticated or replayed events, gaps that cannot be reconciled, malformed events, and unknown versions/types are quarantined before views or notifications. Unknown events may be retained for forward-compatible replay but MUST NOT execute.

Events can update a view model, notifications, or operational projections. They MUST NOT authorize a transition, mutation, publication, review, merge, closure, lease acquisition, or capability grant. A consumer receiving an event is never a substitute for asking the controller to evaluate current state and policy.

<a id="leases"></a>
## 8. Distributed leases and compare-and-swap

A lease protects one versioned canonical coordination key. The pre-existing **generic** wire contract remains unchanged: `genericKey` is a closed object with exactly `repository`, `scope`, `resourceKind`, and `claim`; `scope` is exactly one canonical subject or `{ "runId": "..." }`, and `claim` is the resource-kind-specific normalized claim. It has no `profile` member. Its frozen bytes/hash remain:

```text
coordinationKeyBytes = UTF8(JCS(genericKey))
coordinationKeyHash = "sha256:" + lowercase(hex(SHA-256(
  UTF8("ForgeDock-Coordination-Key-v1\0") || coordinationKeyBytes
)))
```

Implementations MUST NOT emit or accept the removed experimental `forgedock.coordination-key/generic/v1` object or `ForgeDock-Coordination-Key-Generic-v1` domain; doing so would create a second lease namespace for the same generic resource. `pr-source-ref` is an additive explicit physical-resource exception and MUST NOT use or be accepted as the generic contract. Its key is the closed object:

```json
{
  "profile": "forgedock.coordination-key/pr-source-ref/v1",
  "repository": "owner/name",
  "resourceKind": "pr-source-ref",
  "claim": {
    "hostAuthorityId": "host-authority-...",
    "headRepo": "owner/name",
    "headRef": "refs/heads/forgedock/..."
  }
}
```

`repository` and `claim.headRepo` are the same canonical repository. `hostAuthorityId` is a configured immutable identity for one physical host authority and remains identical across adapter processes, instances, epochs, restarts, and failover; ephemeral discovery `hostInstanceId`, subject, run, issue/PR, publication ID, base, and owner are forbidden. Its exact hash is:

```text
sourceRefKeyBytes = UTF8(JCS(sourceRefKey))
sourceRefKeyHash = "sha256:" + lowercase(hex(SHA-256(
  UTF8("ForgeDock-Coordination-Key-PR-Source-Ref-v1\0") || sourceRefKeyBytes
)))
```

The registry reservation, capability constraint, lease, durable operation, takeover, and every host boundary MUST use those same source-ref bytes and hash and MUST require their repository/ref/host authority to equal the publication target, registry, checkpoint, marker, immutable reference, and fresh discovery configuration. The authenticated authority registry enforces one `hostAuthorityId` for each physical endpoint/trust-root/repository; a duplicate authority ID mapping for that endpoint or a mismatched target is rejected before reservation, so authority partitioning cannot create parallel keys. Thus different runs/publications/bases for one physical ref hash identically and contend before capability issuance. Path claims in the generic contract use `/`, remove `.` segments, reject `..`, repeated separators, backslashes, and case aliases, and treat a claim and ancestor as overlapping. Generic run-scoped and path/component keys remain distinct. The exact key hash/set MUST be present in capability constraints; delegated children may only narrow it, and another/overlapping key is denied.

A lease has a unique unguessable authenticated owner token, expiry, heartbeat interval, safe integer fencing sequence, and request records. The coordination store retains a durable high-water mark per canonical key after release, expiry, deletion, restart, restore, and takeover. It initializes that mark to `0` and atomically allocates `max(highWaterMark, currentRecord.sequence) + 1`; it MUST detect rollback and MUST NOT reset or reuse an epoch (overflow is a terminal `unverifiable` error). Acquisition is an atomic CAS from no live lease (or an expired lease) to `(owner, token, sequence, expiry)`, while retaining the high-water mark.

- **Acquire:** the request carries a unique idempotency key bound to controller, audience, owner, and canonical key. The host durably stores the result. A retry or lost-response reconciliation returns the original token, sequence, expiry, or an unambiguous terminal result; it never creates a second lease for the same request.
- **Heartbeat:** each request carries the exact key, authenticated owner token, current sequence, and a strictly increasing owner heartbeat generation plus unique request ID. The host atomically rejects generations at or below the retained generation, retains deduplication results through failover, and rejects old/replayed generations after takeover. A duplicate is idempotent only when its complete request matches the stored result.
- **Expiry:** an owner that cannot heartbeat before host-observed expiry loses authority. Clock use is from the coordination host; clients MUST allow configured bounded skew and MUST NOT extend a lease from a stale local clock.
- **Release:** is idempotent for the current token/sequence and has an idempotency key; the high-water mark and deduplication records remain. An old owner cannot release a successor lease.
- **Stale takeover:** after host-observed expiry, a new owner atomically increments the durable fencing epoch. The old owner is fenced from subsequent writes even if its process continues.
- **Pending-publication takeover:** lease expiry does not release a §6.2 pending publication generation, its source-ref reservation, or its physical-target reservation. The successor MUST reconcile and atomically commit, transfer, or safely abort that exact generation under §6.2 before any unrelated mutation; absent proof, `recovery-required` remains fenced.
- **CAS writes and host mutations:** every dependent write names the exact canonical key, token, sequence, and operation id. The host MUST atomically validate them at the external mutation linearization point and return `conflict` for a lower epoch. A later local CAS cannot undo an already accepted GitHub mutation. The current GitHub surface is therefore unsupported for lease-dependent publish/review/merge unless an adapter layer supplies this host-side check.
- **Split brain:** if two owners believe they hold a lease, the host's higher valid fencing sequence wins; lower-sequence writes are rejected. If the host cannot enforce fencing at the mutation, both writes are unsafe and the controller MUST stop protected coordination and report `unverifiable`.
- **Failures:** network ambiguity after acquire, heartbeat, release, or mutation requires reconciliation by the original idempotency key and sequence. It MUST NOT be resolved by a blind retry, release of an indeterminate grant, or local “last write wins.”

<a id="bundles"></a>
## 9. Portable bundles

A portable bundle is a deterministic archival export, never a second live workflow authority. It contains:

1. `manifest.json`, whose exact canonical schema includes `profile`, `bundleId`, `createdAt`, source host, root subject/run, trust-root identifier, checkpoint references, and an ordered `members` array;
2. protected artifacts as exact UTF-8 JCS bytes and legacy v2 evidence as the exact original marker/decoded bytes, never silently normalized or upgraded;
3. public controller keys and lifecycle/trust metadata as evidence only (never private keys);
4. predecessor/chain evidence, checkpoint/anchor references, and host references for exact SHA and decision context;
5. exactly one `signature.json` containing the bundle digest, signer key ID, and controller signature.

The manifest's top-level fields are exactly `profile`, `bundleId`, `createdAt`, `sourceHost`, `rootSubject`, `rootRunId`, `trustRootId`, `checkpoints`, and `members`; each has a registered type and `checkpoints`/`members` retain array order. Each `members` entry is exactly `{name,type,length,digest}`. `length` is a non-negative safe integer with no leading-zero decimal representation, and `digest` is a lowercase SHA-256 digest of the exact member bytes. Names are restricted normalized ASCII relative paths with `/`, no empty, `.` or `..` component, and no ambiguity. The archive entry set MUST equal the members plus the two fixed control entries `manifest.json` and `signature.json`, one-to-one. Duplicate names, duplicate members, unlisted entries, omitted entries, path aliases, and control entries in `members` are rejected.

The bundle digest is domain-separated from artifact digests and binds the complete manifest and every listed member in the ordered array:

```text
bundleDigest = "sha256:" + lowercase(hex(SHA-256(
  UTF8("ForgeDock-Bundle-Digest-v1\0") || manifestBytes || 0x00 ||
  UTF8(member.name) || 0x00 || UTF8(member.type) || 0x00 ||
  UTF8(decimal(member.length)) || 0x00 || UTF8(member.digest)
  for each member in manifest.members order
)))
bundleSignatureInput = UTF8("ForgeDock-Bundle-Signature-v1\0") ||
  UTF8(bundleDigest) || 0x00 || UTF8(bundleId) || 0x00 || UTF8(manifestDigest)
```

`manifestBytes` is JCS and `manifestDigest = "sha256:" + lowercase(hex(SHA-256(UTF8("ForgeDock-Bundle-Manifest-Digest-v1\0") || manifestBytes)))`; the signature covers `bundleSignatureInput`. `decimal(member.length)` is the ASCII base-10 representation without a sign, exponent, or leading zero (except zero). `members` is sorted by UTF-8 name bytes and the archive uses that same order. The exact ZIP profile is: `manifest.json` first, listed members in manifest order, `signature.json` last; UTF-8 flag `0x0800`; store method (`0`) for every member; CRC-32 and uncompressed/compressed sizes equal the member bytes in both local and central headers; DOS timestamp `00:00:00, 1980-01-01` in both local and central headers; zero extra/comment fields; no data descriptors; fixed version-needed 10 and fixed version-made-by/platform fields; fixed zero internal/external attributes, disk, and offsets derived only from the prescribed order; and no permissions or host-specific metadata. The Unix epoch is not used because it is not DOS-representable. Any deviation is invalid. Conformance vectors MUST include duplicate and extra-entry archives before interoperability is claimed. Hard limits are 64 MiB total uncompressed bytes, 8 MiB manifest, 1 MiB per artifact, 100,000 members, and 100 MiB maximum compressed input accepted for decompression safety; adapters MAY impose lower limits.

Bundles MUST exclude private keys, provider tokens, GitHub App credentials, OAuth/SSH credentials, cookies, session transcripts, environment files, worktree secrets, unredacted model prompts containing secrets, and operational lease tokens. Protected members MUST be emitted byte-for-byte or omitted; they MUST NOT be redacted while retaining a protected digest/signature claim. If a protected member cannot be proven secret-free, export fails or omits it and reports `chain-gap`/incomplete evidence; it never emits a falsely verifiable replacement. Redaction is permitted only for explicitly unprotected legacy evidence, which receives a distinct bundle-only `redacted-legacy-unverified` status (not one of the protected artifact states in [§3.4](#verification)) and is not part of the protected chain. Public repository content is not automatically safe; the exporter applies the configured sensitivity policy before signing or publishing.

Offline verification starts with a preconfigured trust root or an independently authenticated controller checkpoint supplied outside the bundle. Included keys, lifecycle records, and checkpoints may extend that already trusted historical chain but MUST NOT bootstrap trust. Without that anchor, the result is `unverifiable` (or a separate cryptographically-valid-but-untrusted diagnostic), never `verified`. Verification checks the exact archive set, limits, member lengths/digests, manifest and bundle signature, trusted key lifecycle, artifact canonical bytes, signatures, bindings, chain/checkpoint evidence, and legacy status without network access. Missing trust metadata, missing predecessor members, stale/revoked keys, expired discovery, or an absent anchor are reported rather than repaired. Offline verification cannot establish current host state, current merge policy, current repository contents, or current revocation status beyond the independently anchored trust snapshot.

Import stores the bundle under an archival ID and returns per-member states from [§3.4](#verification). It MUST detect duplicate IDs with conflicting bytes, conflicting subjects/runs, invalid signatures, stale checkpoints, and bundle-vs-live differences. Imported evidence MAY be linked to a live run for human review, but it never replaces current GitHub truth, grants capabilities, satisfies a current exact-SHA gate by itself, or becomes competing live authority. A controller may re-verify against the live host before using it.

<a id="compatibility"></a>
## 10. Compatibility and authorization matrix

The protected profile is additive and distinct. No parser silently rewrites a v2 artifact, and structural readability is not authenticity.

| Artifact set | Read/display | Verification status | Protected authorization |
| --- | --- | --- | --- |
| Structurally valid legacy v2 only | Yes, read-only | `legacy-unverified` | Denied; may inform migration or a human |
| Valid new protected set, trusted key and complete chain | Yes | `verified` | Allowed only after current binding, policy, host, and replay checks |
| Mixed legacy v2 and protected artifacts | Yes, with each member labeled | Protected members verify independently; legacy members remain `legacy-unverified`; missing links can be `chain-gap` | Legacy evidence cannot satisfy a protected gate; the controller may require a complete protected chain |
| Malformed JSON/marker, invalid shape, duplicate keys | Quarantine raw bytes where safe | `malformed` | Denied |
| Incomplete protected set: a field required by its applicable registered kind/action schema is absent | Partial display with a gap | Missing required field on an artifact: `incomplete`; missing chain member/link: `chain-gap`; unavailable trust evidence: `unverifiable`. `payload.reviewedSha` is required only for `ReviewVerdict/review.record` and `MergeRequest/merge.request`; its absence is valid for schemas that forbid it | Denied only when the applicable schema is incomplete; no silent repair, placeholder, or upgrade |
| Correctly shaped but unknown profile/action/constraint | Preserve for inspection | `unsupported` | Denied |
| Signed data with wrong digest/signature | Preserve for investigation | `invalid-signature` | Denied |
| Valid signature but wrong repository/subject/run/action/applicable revision/current decision/request scope/publication target | Read as signed evidence | `wrong-binding` | Denied for the requested operation |
| Valid historical data with expired interval or revoked trust | Read with lifecycle context | `expired` or `revoked` | Denied for current authorization; historical evidence may remain reportable |
| Data whose required trust/replay/host check cannot run | Read if structurally safe | `unverifiable` | Denied |

A compatibility reader MAY project legacy artifacts to a modern view, but that view MUST retain the legacy trust state. A migration is a new controller action that emits new protected artifacts with new IDs, links the source as legacy evidence, and passes current policy; it is not an in-place authentication of old bytes.

<a id="tamper-limits"></a>
## 11. Tamper evidence and deletion limits

A valid digest and signature detect unauthorized mutation of the signed bytes. A valid predecessor chain detects a detectable omission or reorder when the verifier has an authenticated successor, checkpoint, or expected sequence. Neither proves that an attacker did not delete the final unanchored tail: if the attacker removes the newest records and no retained artifact or external observer names them, the remaining prefix can still verify.

Stronger deletion claims require an authenticated anchor such as a controller-signed checkpoint committed to durable GitHub, an independently retained bundle manifest, or an external append-only witness. The anchor MUST include the run, subject, last sequence, last digest, and anchor time, and its trust/retention policy must be stated. Even an anchor proves only what it covers; it does not prove that arbitrary repository history or host content was never deleted.

<a id="rejected"></a>
## 12. Rejected alternatives

- **Global trust-score merge authority:** rejected because an aggregate score is not an exact subject/SHA decision, obscures policy, and creates a second authority path. The typed controller and explicit evidence gates remain authoritative.
- **Mandatory DID/UCAN:** rejected because ForgeDock needs a small controller identity and exact local/host bindings, not mandatory global identifier or delegation infrastructure. The capability model here can be adapted later without requiring it.
- **Blockchain or mandatory external storage:** rejected because durable GitHub artifacts and optional signed checkpoints meet the current product boundary without imposing availability, cost, or privacy dependencies. Stronger anchoring may be configured but is not required for every run.
- **Model-held signing keys:** rejected because it would let untrusted model output mint authority and would expose keys through prompts, tools, or transcripts. Only the controller owns signing operations.
- **Last-write-wins comment locks:** rejected because comments are not atomic coordination and cannot fence stale workers. Leases require host CAS, monotonic sequence, and owner fencing.

<a id="worked-example"></a>
## 13. Worked verification sequence

For run `run_demo`, the controller emits a genesis `Investigation` at sequence 0 with `predecessor: null`. It then emits a `BuildResult` at sequence 1 whose predecessor is the exact digest of sequence 0. A `ReviewVerdict` at sequence 2 names the exact PR subject and full head SHA in both its payload and signature input. The controller verifies canonical bytes, each digest, the trusted active key, sequence links, exact subject/run/SHA, and current host head before recording the verdict. A later merge capability additionally binds the exact MergeRequest and that ReviewVerdict IDs/digests and proves the approval remains the current non-superseded decision at the merge boundary.

If sequence 1 is absent from a bundle, sequence 2's signature can still be mathematically valid, but the run reports `chain-gap` and cannot claim complete protected history. If the PR head changes after review, the same signed verdict reports `wrong-binding` for the new head and cannot authorize merge. If a later verdict supersedes that approval at the same SHA, the old verdict still verifies historically but is not current and cannot authorize merge. If only the final sequence 2 artifact is deleted without an authenticated checkpoint, the remaining prefix verifies but the deletion is not provable.

A portable export contains the manifest, the three exact artifact members, the public key and lifecycle record, and a checkpoint naming sequence 2/digest. Offline verification can establish the signed chain through sequence 2; import still remains archival, and a live controller must re-check the current PR head and policy before merge.

<a id="implementation-boundary"></a>
## 14. Implementation boundary and evidence gate

This milestone changes only documentation. Future implementation slices MUST cite the stable anchors above, add conformance tests and concrete vectors before claiming interoperability, and preserve the controller-only authority rule. No slice is complete because a format parses or a signature verifies in isolation: it must demonstrate binding, failure, replay, chain, host, and recovery behavior applicable to its section.
