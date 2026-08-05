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
4. Repository, canonical subject, run, action, action-specific revision binding, and registered publication target are exact; a nearby or abbreviated value is not equivalent. Actions registered without a revision binding carry no placeholder SHA.
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
- **Controller ↔ host/GitHub:** adapter operations are typed requests with exact subject, run, action, action-specific revision bindings when the action has one, and the complete registered publication target when applicable. A successful HTTP/API response is not a decision and MUST be checked before it is recorded as one.
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
- `reviewedSha` has one canonical location: `payload.reviewedSha` for protected `ReviewVerdict/review.record` and `MergeRequest/merge.request`. The verifier extracts that member, and the controller MUST require the same full lowercase SHA in the signature input, capability, requested operation, and freshly observed host head. No second SHA field is authoritative. A legacy v2 `payload.headSha` is readable only as legacy evidence and is never silently mapped into a protected artifact.
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

`canonicalSubjectBytes` is the exact UTF-8 JCS encoding of `subject`. For `ReviewVerdict/review.record` and `MergeRequest/merge.request`, `reviewedSha-or-empty` is computed only by extracting `payload.reviewedSha`; it MUST equal the capability, requested operation, and fresh host head. For all other registered pairs it is the empty string and any reviewed-SHA member is rejected. The Ed25519 signature is over `signatureInput`; `signature` is unpadded base64url of the 64-byte signature. The controller MUST verify the digest before the signature and MUST verify the requested repository, subject, run, action, and reviewed SHA against the current operation, not merely against the artifact itself.

<a id="verification"></a>
### 3.4 Verification algorithm and result states

Verification is deterministic and returns one primary state plus structured diagnostics. It MUST perform profile/shape and canonical parsing checks, then digest, key/trust status, signature, binding, chain, time, and policy checks. `incomplete` has one narrow meaning: a required field is absent from the artifact being verified (including its own `predecessor` member when the sequence requires one). A missing predecessor artifact, missing sequence member, duplicate/conflicting append, or non-contiguous set is never `incomplete`; it is `chain-gap`. An unavailable trust root/replay store/host proof is `unverifiable`. A verifier MUST choose the first applicable primary state using this precedence: `malformed`, `incomplete`, `unsupported`, `invalid-signature`, `wrong-binding`, `chain-gap`, `expired`, `revoked`, `unverifiable`, then `verified`.

| Primary state | Meaning | Protected authorization |
| --- | --- | --- |
| `verified` | Correct protected profile, canonical bytes, digest, trusted non-revoked key, signature, bindings, chain context, and validity | May be considered by the controller, subject to current policy and host checks |
| `legacy-unverified` | Structurally readable v2 artifact with no protected proof | Evidence only; never authorizes a protected action |
| `malformed` | Invalid JSON, duplicate keys, invalid canonical data, invalid field shape, or illegal encoding | Reject and quarantine; no authorization |
| `incomplete` | A required field is absent from this artifact itself, including its own required predecessor or reviewed SHA | No authorization; do not guess or repair silently |
| `unsupported` | Unknown profile version, kind/action pair, constraint, key algorithm, or schema extension | No authorization; preserve bytes for inspection |
| `invalid-signature` | Digest or Ed25519 signature does not verify for the declared input | Reject; treat as possible tampering |
| `wrong-binding` | Artifact is validly signed but repository, subject, run, action, or exact reviewed SHA does not match the requested operation | Reject for that operation |
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

A capability is not a free-standing semantic record. It is a controller-issued canonical envelope with exactly the common top-level fields `profile`, `capabilityId`, `delegationId`, `body`, and `proof`; unknown fields are rejected. Its `body` contains exactly the common fields governed by the semantic-body table below (including the registered conditional presence of `runId`) plus the action-specific members registered in this section. Only `pr.publish` carries `publicationTarget`; revision-member presence remains governed by the closed matrix. This `merge.request` example carries `reviewedSha`:

```json
{
  "profile": "forgedock.capability/v1",
  "capabilityId": "cap_...",
  "delegationId": "del_...",
  "body": {
    "issuer": "fdck_...",
    "audience": "worker:...",
    "action": "merge.request",
    "subject": { "type": "github.pr", "repo": "owner/name", "number": 18 },
    "runId": "run_...",
    "reviewedSha": "0123456789abcdef0123456789abcdef01234567",
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
  "audience": "worker:...",
  "action": "pr.publish",
  "subject": { "type": "github.issue", "repo": "owner/name", "number": 90 },
  "runId": "run_...",
  "sourceSha": "89abcdef0123456789abcdef0123456789abcdef",
  "publicationTarget": {
    "publicationId": "pub_...",
    "lifecycle": "create",
    "headRepo": "owner/name",
    "headRef": "refs/heads/forgedock/issue-90",
    "baseRepo": "owner/name",
    "baseRef": "refs/heads/main",
    "buildResultId": "art_...",
    "buildResultDigest": "sha256:...",
    "publicationVersion": 1,
    "remoteRefPrecondition": { "state": "absent" },
    "prPrecondition": { "state": "unallocated" }
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

The action-specific revision-binding matrix is exhaustive. Each of the 11 actions appears exactly once:

| Action | `reviewedSha` | `sourceSha` | Revision binding |
| --- | --- | --- | --- |
| `artifact.append` | Forbidden | Forbidden | None |
| `artifact.read` | Forbidden | Forbidden | None |
| `issue.comment` | Forbidden | Forbidden | None |
| `issue.label` | Forbidden | Forbidden | None |
| `pr.publish` | Forbidden | Required | Verified BuildResult source revision |
| `review.record` | Required | Forbidden | Protected artifact reviewed revision |
| `merge.request` | Required | Forbidden | Protected artifact reviewed revision |
| `lease.acquire` | Forbidden | Forbidden | None |
| `lease.heartbeat` | Forbidden | Forbidden | None |
| `lease.release` | Forbidden | Forbidden | None |
| `bundle.export` | Forbidden | Forbidden | None |

A required revision member MUST be present as an exact 40-character lowercase hexadecimal commit SHA. A forbidden member MUST be absent, not `null`, empty, or a placeholder. Missing required members, present forbidden members, unknown members, and actions absent from this matrix are default-deny. For a no-revision action, the authoritative revision binding is the explicit semantic state **no revision**, represented by the absence of both revision members; no SHA is invented.

`publicationTarget` is required only for `pr.publish` and forbidden for every other action. It is a closed object with exactly `publicationId`, `lifecycle`, `headRepo`, `headRef`, `baseRepo`, `baseRef`, `buildResultId`, `buildResultDigest`, `publicationVersion`, `remoteRefPrecondition`, and `prPrecondition`:

- `publicationId` is a controller-generated opaque identity whose authoritative registry entry is immutably bound to the exact repository, run, originating issue or pre-existing PR, head repository/ref, and base repository/ref. This identity remains stable when a create operation allocates a PR number.
- `lifecycle` is exactly `create` or `reuse`. `create` requires a `github.issue` subject and a registry entry with no allocated PR; `reuse` requires a `github.pr` subject whose repository and number exactly equal the PR already registered for `publicationId`. A controller MAY register a pre-existing PR only after an authenticated fresh read has bound its exact identity and tuple before capability issuance. A create result atomically completes the registry mapping with one allocated canonical PR subject; it never changes the capability subject.
- `headRepo` and `baseRepo` are canonical repository identities. `headRef` and `baseRef` are exact fully qualified `refs/heads/...` names with no shorthand, symbolic ref, revision expression, or case alias. `baseRepo` MUST equal the capability subject repository. The tuple is compared in full; branch-only discovery is forbidden.
- `buildResultId` and `buildResultDigest` identify the one controller-selected, verified BuildResult for the same repository and run. Its `payload.headSha` MUST equal `sourceSha`. `publicationVersion` is a positive safe integer allocated monotonically by an atomic controller CAS for `publicationId`; the registry binds that version to the BuildResult identity, digest, and `sourceSha`.
- `remoteRefPrecondition` is exactly `{ "state": "absent" }` or `{ "state": "sha", "sha": "<full-lowercase-SHA>" }`. It records the expected remote head immediately before any push or selection; the desired postcondition is always `sourceSha`.
- `prPrecondition` is exactly `{ "state": "unallocated" }` for `create`, or `{ "state": "existing", "headSha": "<full-lowercase-SHA>" }` for `reuse`. The latter is the required existing-PR head precondition before any push or PR update; a different current head is a conflict before mutation.

The canonical publication coordination-key object under [§8](#leases) has exactly `repository`, `runId`, `resourceKind`, and `claim`. The first two equal `body.subject.repo` and `body.runId`, `resourceKind` is exactly `pr-publication`, and the closed `claim` has exactly `publicationId`, `headRepo`, `headRef`, `baseRepo`, and `baseRef` copied from `publicationTarget`. `constraints.coordinationKey` is that object's domain-separated hash. Every `pr.publish` capability MUST carry this non-null key; `null`, a key derived only from a branch, or a key omitting any tuple member is denied. Competing publication revisions for the same `publicationId` therefore share one fencing domain.

`capabilityId` and `delegationId` are distinct, globally unique opaque identifiers generated by the controller. They are never derived from attacker-controlled display text, and a `(capabilityId, delegationId)` pair may be issued only once in the authoritative issuance/revocation store. `body.issuer` MUST be a trusted controller key ID, `proof.keyId` MUST equal it, and the proof MUST be an Ed25519 signature over:

```text
UTF8("ForgeDock-Capability-Signature-v1\0") ||
UTF8(profile) || 0x00 || UTF8(capabilityId) || 0x00 ||
UTF8(delegationId) || 0x00 || UTF8(JCS(body))
```

The signature binds every present body field, including the selected revision member, complete publication target when applicable, nonce, parent, audience, subject, run, validity interval, coordination key, and constraints. Because body shape validation rejects forbidden and unknown members before signature acceptance, the proof is accepted only for the exact permitted field set and therefore also binds the absence of forbidden revision and publication members. The controller verifies the exact canonical envelope, trusted issuer lifecycle, issuance record, signature, action-specific field presence, and parent lineage **before** policy evaluation or nonce consumption. An issuer string alone, a copied key ID, an unsigned object, or a bundle-contained issuance record is never proof of issuance. The configured trust root/checkpoint, not the capability itself, authenticates the issuer key.

The semantic body has these rules:

| Field | Rule |
| --- | --- |
| `issuer` | Trusted controller `keyId`; an unknown, revoked, or non-controller issuer is denied |
| `audience` | Exact controller installation, adapter, worker identity, and session where applicable; wildcard audience is forbidden |
| `action` | One closed action above |
| `subject` | Exact canonical subject, or an explicitly registered subject set; aliases and URLs are not equivalent |
| `runId` | Exact run binding; absent only for explicitly read-only, non-run-scoped actions |
| `reviewedSha` | Required only for `review.record` and `merge.request`; it MUST equal `payload.reviewedSha` in the registered protected artifact, the controller-requested operation, every capability in the delegated lineage, and the freshly observed host head |
| `sourceSha` | Required only for `pr.publish`; it MUST equal the exact full lowercase `BuildResult.payload.headSha` from the controller-selected, verified BuildResult for the same run and repository, and the value in the controller request, every capability in the delegated lineage, and the durable operation record |
| `publicationTarget` | Required only for `pr.publish`; the complete closed target, BuildResult reference/version, lifecycle, ref tuple, and remote/PR preconditions defined above MUST equal the controller request, delegated lineage, authoritative publication registry, host request, and durable operation record |
| `issuedAt`, `expiresAt` | UTC instants; `issuedAt < expiresAt`, bounded by controller policy; expired or excessive lifetime is denied |
| `parentCapabilityId`, `depth` | Null/zero only for an original grant; otherwise exact parent and depth increment, maximum depth 3 |
| `nonce` | Unique random value bound by the proof and issuance record |
| `oneShot` | Boolean; if true, atomic consumption is required before or with the controller decision |
| `constraints` | Registered, closed constraints; they include the exact canonical coordination-key set when the action is lease-dependent, and `pr.publish` always requires its non-null publication key |

For `review.record` and `merge.request`, the controller MUST freshly read the protected PR head at the action boundary and deny a stale or unequal `reviewedSha`; this capability rule does not change [§3.1](#envelope) or add a revision member to any other protected artifact. For `pr.publish`, `sourceSha` and `publicationTarget` are capability, request, delegation, and host-operation scope only. They are not protected artifact payload members, are not added to the `forgedock.protected/v1` envelope or signature input, and do not broaden the protected kind/action registry.

Delegation is a strict subset operation: a child MUST preserve issuer scope, action, subject, run, and the action's exact revision binding while narrowing audience, validity, constraints, or permissions only as registered. Thus every ancestor and child MUST preserve the same permitted revision field name and exact value, or preserve the explicit no-revision state; a child MUST NOT add, remove, rename, or change that binding. A `pr.publish` child additionally MUST preserve every `publicationTarget` member and the exact publication coordination key. A child is signed by the issuing controller and names its authenticated parent. The controller records lineage and rejects cycles, reused IDs, duplicate semantic issuance, and a child whose interval, audience, key set, revision binding, publication target, or other scope is outside its parent.

One-shot replay consumption is an atomic compare-and-set in the authoritative replay store. The controller first authenticates the envelope and confirms issuance, then reserves the nonce and commits the decision. For a host mutation, `operationId = SHA-256(UTF8("ForgeDock-Capability-Operation-v1\0") || UTF8(capabilityId) || 0x00 || UTF8(nonce))` (lowercase hex) remains the host idempotency key. Its immutable authoritative operation record MUST bind the exact subject, run, action, and revision binding: `reviewedSha` plus its value, `sourceSha` plus its value, or the explicit no-revision state. For `pr.publish`, that record additionally binds every `publicationTarget` member, the coordination key/owner token/fencing sequence, and the expected controller publication-registry version. The host request carries the same scope.

A `pr.publish` operation record starts without a result and may be completed exactly once. Its result has exactly `prSubject`, `immutablePrRef`, `headRepo`, `headRef`, `baseRepo`, `baseRef`, `sourceSha`, `runMarker`, and `publicationReceipt`. `prSubject` is the canonical returned `github.pr` subject. `immutablePrRef` is exactly `{ "hostInstanceId": "...", "resourceType": "github.pr", "resourceId": "..." }`, where the non-empty `resourceId` is the host's immutable API identity rather than a URL or title. `runMarker` is exactly `{publicationId, runId, operationId, publicationVersion, sourceSha}` with values from the frozen operation. The remaining members exactly match `publicationTarget` and the fenced receipt defined in §6.2.

For `create`, the controller atomically records that returned PR and immutable reference against `publicationId`; for `reuse`, both MUST exactly equal the capability subject and existing registry mapping. A completion naming another PR/reference, branch, base, source SHA, run marker, publication identity/version, or operation ID conflicts and is never accepted as reconciliation.

A success, failure, or indeterminate host result is durably associated with the original operation. Replay, retry, or reconciliation with a different subject, run, action, revision field/value, publication target, coordination fence, or attempted revision for a no-revision operation is denied and MUST NOT create a new mutation. After an indeterminate mutation the grant is never released or retried with a new key; the controller reconciles the original operation before retry and a completed operation returns its original result. A crash leaves an unambiguous consumed/committed/reconcile state. Non-one-shot capabilities still require an authenticated issuance record, exact binding, expiry, and the same conflict checks for any durable operation record.

Unknown constraints, unavailable issuer or issuance records, absent replay state, clock uncertainty beyond configured skew, unsupported delegation, an unknown field, a missing exact subject, required revision, publication target, or publication coordination key, or a present forbidden revision or publication target are default-deny conditions. Capability possession never authorizes merge, publication, review, closure, or a transition without the typed controller's committed decision.

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

Every host adapter MUST expose a canonical, controller-authenticated discovery envelope. The response contains `profile: forgedock.host-discovery/v1`, `adapterId`, `adapterVersion`, `hostInstanceId`, exact endpoint and repository binding, supported subject types and operations, exact-SHA behavior, comment/artifact limits, event properties, compare-and-swap/lease properties, `issuedAt`, `validFrom`, `expiresAt`, a strictly increasing host capability `epoch`, the controller's fresh random `challenge`, and `proof` signed by a configured adapter/host trust root. The proof covers the complete JCS body; a discovery time alone is insufficient. The controller rejects a response with a wrong challenge, host/endpoint/repository/adapter binding, unknown signer, non-increasing rollback epoch, revoked signer, `now < validFrom`, `now >= expiresAt`, or age beyond the configured maximum. A fresh challenge is required before each protected operation class (or a documented maximum-age probe tied to that operation); cached evidence never crosses its expiry or host epoch. Stale, replayed, downgraded, missing, or unverifiable discovery is `unverifiable` and its advertised guarantee is unavailable, not inferred from an unrelated successful API call.

An adapter conformance suite MUST test canonical subject round trips, repository ownership, exact full-SHA lookup, stale-head detection, idempotency keys, response-to-request binding, pagination/completeness, error classification, size limits, signed challenge discovery, expiry, replay, epoch rollback/downgrade, and host-instance binding. For PR publication it additionally MUST test exact issue/PR lifecycle identity, full head/base tuple selection, immutable returned PR references, required fencing/CAS, and atomic source-SHA preconditions. It MUST distinguish permission denied, not found, conflict, rate limit, stale revision, unsupported guarantee, and indeterminate network result. An indeterminate mutation result is reconciled by its original idempotency key, exact subject, complete publication target when applicable, and action-specific revision binding before retry; the controller MUST NOT blindly duplicate a side effect.

Minimum guarantees are:

| Operation | Mandatory host guarantee | If unavailable |
| --- | --- | --- |
| Publish artifact | Durable write or idempotent mutation, exact subject/run association, returned immutable reference, and read-after-write verification | Do not claim published or proceed on an unverified result |
| Publish PR | One fenced, linearizable publication protocol bound to the exact subject/run, complete `publicationTarget`, BuildResult identity/version, `sourceSha`, operation ID, and coordination token/sequence; CAS at every push, create, reuse, update, and finalization boundary; an exact canonical returned PR subject plus immutable host reference and run marker; and a fenced fresh result receipt | Discovery marks protected PR publication unsupported and the controller denies it before the first external mutation |
| Record review | Read the exact full reviewed SHA and prove the head remains that SHA immediately before/after recording | Review is stale/unverifiable; do not approve or merge |
| Merge | Host-enforced source/base/head identity, current checks/policy, idempotent merge result, controller-approved exact SHA, and—when lease-dependent—an atomic current coordination-key/token/fencing-sequence check at the host mutation linearization point | Merge is denied; a comment or event cannot substitute. An adapter without host fencing is unsupported for lease-dependent merge |
| Compare-and-swap coordination | Atomic expected-version/sequence update with owner fencing and durable conflict result | Distributed lease/coordination is unsupported; do not run multi-writer coordination |
| Lease-dependent publish/review/mutation | The host MUST atomically validate the canonical coordination key, owner token, fencing epoch, exact operation ID, and current policy at the external mutation linearization point | Deny the mutation; the current GitHub surface is unsupported for this guarantee unless an adapter layer supplies it |

For `pr.publish`, discovery MUST explicitly advertise the complete fenced protocol below. The controller MUST derive `sourceSha`, `buildResultId`, and `buildResultDigest` only from one controller-selected, verified BuildResult for the same run/repository and MUST allocate `publicationVersion` by CAS. It then acquires the required publication coordination key and freezes the operation record with the exact owner token and fencing sequence. Before the first external mutation, the retained workspace commit and selected source ref MUST equal `sourceSha`, the publication registry MUST still be at the requested version and BuildResult, and fresh host state MUST satisfy both target preconditions. Any failure releases no authorization for mutation.

The protocol has these linearization requirements:

1. **Remote source boundary.** A push MUST be a host-enforced compare-and-swap from the exact `remoteRefPrecondition` (including expected absence) to `sourceSha`. Selection without a push MUST atomically compare the ref to `sourceSha`. In either case the same call MUST validate the full head/base tuple, publication coordination key, live owner token/fencing sequence, operation ID, publication version, and BuildResult identity. A preflight read followed by an unconditional push or branch selection is non-conforming.
2. **Create boundary.** `create` MUST atomically validate the issue subject, still-unallocated `publicationId`, exact head/base tuple, remote head `sourceSha`, operation/fence/version scope, and absence of a conflicting target before allocating one PR. The mutation MUST write host-protected metadata containing the exact `publicationId`, `runId`, `operationId`, `publicationVersion`, and `sourceSha` (the **run marker**) and return the canonical `github.pr` subject plus an immutable host PR reference. Discovery by head branch alone, choosing the first result, or accepting another base is forbidden.
3. **Reuse/update boundary.** `reuse` MUST address the exact registered repository/PR number, not discover by branch. Before any push or PR update, the host MUST atomically compare `prPrecondition.headSha` and the registered tuple/run marker. At reuse or update it MUST atomically revalidate that exact PR identity, head/base tuple, remote and PR head `sourceSha`, operation/fence/version scope, and protected run marker. A same-SHA PR with another number, base, run marker, or publication identity is a conflict.
4. **Finalization boundary.** After create, reuse, or update, the adapter MUST perform a fresh atomic comparison of the exact returned PR identity/reference, tuple, run marker, remote head, and PR head against the frozen operation. It then returns a closed `publicationReceipt` with exactly `hostInstanceId`, `hostEpoch`, `publicationGeneration`, `operationId`, `publicationId`, `publicationVersion`, `buildResultId`, `buildResultDigest`, `prSubject`, `immutablePrRef`, `headRepo`, `headRef`, `baseRepo`, `baseRef`, `sourceSha`, `runMarker`, `fencingSequence`, `observedAt`, and `proof`. `proof` is the configured adapter/host trust root's signature over the complete JCS receipt body excluding `proof`; every other value MUST equal the operation and fresh observation. The host/adapter MUST keep that publication generation fenced from every ref or PR mutation until the controller CAS commits the exact receipt against the same pending publication version. A changed ref, PR head, target, BuildResult/version, operation ID, or fence aborts finalization and cannot be recorded as published.

Every boundary MUST reject a stale fence or competing valid source revision before mutation. The same operation ID, immutable target, preconditions, and fence apply to first execution, retry, and reconciliation; a retry may advance only the original protocol state and cannot repeat a completed boundary. If the host surface cannot atomically compare all required state at a boundary, cannot prevent intervening target changes through finalization, or cannot return the immutable receipt, discovery MUST mark protected PR publication unsupported and the controller MUST deny the capability before the first push, PR creation, or update. Separate read-before/read-after calls, post-mutation mismatch detection, ordinary idempotency alone, and a per-capability nonce without the shared publication fence do not satisfy this guarantee.

A known mismatch or lost race produces no mutation at the affected boundary. An indeterminate transport result remains associated with the original operation ID and is reconciled only through the host's fenced operation state and immutable receipt. A protected adapter MUST NOT perform a wrong-source or wrong-target mutation and later classify it merely as failure/indeterminate; such behavior is non-conforming and disables protected PR publication. No result is reported as published until the controller has committed the exact receipt.

GitHub comments, labels, checks, and webhooks report durable facts or requests. None is an authority path. The controller alone interprets them and commits a transition.

### 6.3 Focused capability and publication conformance vectors

In these vectors, `A = 0123456789abcdef0123456789abcdef01234567` and `B = 89abcdef0123456789abcdef0123456789abcdef`. Unless a row says otherwise, the envelope, proof, lineage, BuildResult, host discovery, policy, and replay evidence are valid. “No mutation” means no new external side effect may be created; reconciliation may only inspect or return the result of the original operation.

| Vector | Input condition | Required authorization and mutation outcome |
| --- | --- | --- |
| Non-revision absence accepted | `issue.comment` has neither `reviewedSha` nor `sourceSha` | Capability shape is authorized for policy evaluation; the comment mutation may occur after the controller decision |
| Non-revision field forbidden | `artifact.read` includes `reviewedSha: A` (the same result applies to `sourceSha` or `publicationTarget`) | Deny before policy and nonce consumption; no mutation |
| Required review revision missing | `review.record` or `merge.request` omits `reviewedSha` | Deny as incomplete capability scope; no review or merge mutation |
| Required publication scope missing | `pr.publish` omits `sourceSha`, `publicationTarget`, or its non-null publication coordination key | Deny as incomplete capability scope; no push, PR creation, reuse update, or publication claim |
| Review/merge head stale | A valid review/merge lineage carries `reviewedSha: A`, but the fresh PR head is `B` | Deny as wrong/stale binding; no review or merge mutation |
| BuildResult source mismatch | `pr.publish` carries `sourceSha: B`, but the selected verified BuildResult reference in `publicationTarget` has `payload.headSha: A` | Deny before host mutation; no push or PR mutation |
| Delegated publication mismatch | Parent `pr.publish` carries `sourceSha: A` and one target/key; the child removes, renames, or changes the SHA, any target member, or the key | Reject the child lineage before policy and nonce consumption; no host mutation |
| First PR creation | A `create` capability has an exact `github.issue` subject, unallocated `publicationId`, valid absent/current remote precondition, tuple, BuildResult/version, source `A`, and live fence | Atomically establish/select remote `A`, create exactly one PR for that tuple, write the exact run marker, return and register its canonical PR subject/immutable reference, and commit only its fenced receipt |
| Exact PR reuse | A `reuse` capability names registered PR 18, its full tuple/run marker and existing-head precondition match, and the fenced remote/PR head is `A` | Address PR 18 directly, return its immutable reference, and commit only a receipt that remains bound to PR 18, the run, tuple, operation, version, and `A` |
| Wrong-base same-SHA candidate | The target names PR 18 and base `refs/heads/main`, but branch-only discovery offers a same-`A` PR for `refs/heads/release` or PR 18 freshly reports that wrong base | Reject as wrong target before create/reuse/update; do not select another candidate and make no mutation |
| Wrong-number same-SHA candidate | The registered reuse target is PR 18, but discovery/result names PR 19 with the same tuple and `A` | Reject as wrong identity; no mutation or registry/result completion for PR 19 |
| Existing PR precondition race | Reuse target PR 18 was bound with existing head `A`, but it is `B` at the first publication boundary | Atomic precondition fails before push or PR update; no mutation under this operation |
| Remote race at mutation | Preflight observed the requested remote-ref state for source `A`, but the ref changes to `B` before push, selection, create, or update | The boundary CAS rejects before its mutation; no PR is created/updated from `B` and no publication receipt is issued |
| Competing valid revisions | Capabilities for `A` and `B` share a `publicationId`, but only one has the current publication version and highest live fence | Only the current version/fence may cross a mutation boundary; the stale operation conflicts before mutation and cannot reconcile through the winner's result |
| Head moves during finalization | After the operation's fresh result check for `A` but before controller receipt commit, another operation attempts to move the remote or PR head to `B` | The held publication fence rejects the move, or finalization aborts before controller commit; an adapter unable to enforce this is discovered as unsupported before the first mutation |
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

A lease protects one canonical coordination key. The key is a JCS object encoded as UTF-8 and hashed as `sha256:hex(SHA-256(UTF8("ForgeDock-Coordination-Key-v1\0") || keyBytes))`; it contains repository, canonical subject or run, resource kind, and a normalized resource claim. Path claims use `/`, remove `.` segments, reject `..`, repeated separators, backslashes, and case aliases, and treat a claim and its ancestor as overlapping. A run-scoped key and a path/component key are distinct. The exact key hash/set MUST be present in the capability constraints and delegated children may only narrow it; a lease request for another or overlapping key is denied.

A lease has a unique unguessable authenticated owner token, expiry, heartbeat interval, safe integer fencing sequence, and request records. The coordination store retains a durable high-water mark per canonical key after release, expiry, deletion, restart, restore, and takeover. It initializes that mark to `0` and atomically allocates `max(highWaterMark, currentRecord.sequence) + 1`; it MUST detect rollback and MUST NOT reset or reuse an epoch (overflow is a terminal `unverifiable` error). Acquisition is an atomic CAS from no live lease (or an expired lease) to `(owner, token, sequence, expiry)`, while retaining the high-water mark.

- **Acquire:** the request carries a unique idempotency key bound to controller, audience, owner, and canonical key. The host durably stores the result. A retry or lost-response reconciliation returns the original token, sequence, expiry, or an unambiguous terminal result; it never creates a second lease for the same request.
- **Heartbeat:** each request carries the exact key, authenticated owner token, current sequence, and a strictly increasing owner heartbeat generation plus unique request ID. The host atomically rejects generations at or below the retained generation, retains deduplication results through failover, and rejects old/replayed generations after takeover. A duplicate is idempotent only when its complete request matches the stored result.
- **Expiry:** an owner that cannot heartbeat before host-observed expiry loses authority. Clock use is from the coordination host; clients MUST allow configured bounded skew and MUST NOT extend a lease from a stale local clock.
- **Release:** is idempotent for the current token/sequence and has an idempotency key; the high-water mark and deduplication records remain. An old owner cannot release a successor lease.
- **Stale takeover:** after host-observed expiry, a new owner atomically increments the durable fencing epoch. The old owner is fenced from subsequent writes even if its process continues.
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
| Incomplete protected set, missing key/predecessor/reviewed SHA | Partial display with a gap | Missing field on an artifact: `incomplete`; missing chain member/link: `chain-gap`; unavailable trust evidence: `unverifiable` | Denied; no silent repair or upgrade |
| Correctly shaped but unknown profile/action/constraint | Preserve for inspection | `unsupported` | Denied |
| Signed data with wrong digest/signature | Preserve for investigation | `invalid-signature` | Denied |
| Valid signature but wrong repository/subject/run/action/SHA/publication target | Read as signed evidence | `wrong-binding` | Denied for the requested operation |
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

For run `run_demo`, the controller emits a genesis `Investigation` at sequence 0 with `predecessor: null`. It then emits a `BuildResult` at sequence 1 whose predecessor is the exact digest of sequence 0. A `ReviewVerdict` at sequence 2 names the exact PR subject and full head SHA in both its payload and signature input. The controller verifies canonical bytes, each digest, the trusted active key, sequence links, exact subject/run/SHA, and current host head before allowing a merge request.

If sequence 1 is absent from a bundle, sequence 2's signature can still be mathematically valid, but the run reports `chain-gap` and cannot claim complete protected history. If the PR head changes after review, the same signed verdict reports `wrong-binding` for the new head and cannot authorize merge. If only the final sequence 2 artifact is deleted without an authenticated checkpoint, the remaining prefix verifies but the deletion is not provable.

A portable export contains the manifest, the three exact artifact members, the public key and lifecycle record, and a checkpoint naming sequence 2/digest. Offline verification can establish the signed chain through sequence 2; import still remains archival, and a live controller must re-check the current PR head and policy before merge.

<a id="implementation-boundary"></a>
## 14. Implementation boundary and evidence gate

This milestone changes only documentation. Future implementation slices MUST cite the stable anchors above, add conformance tests and concrete vectors before claiming interoperability, and preserve the controller-only authority rule. No slice is complete because a format parses or a signature verifies in isolation: it must demonstrate binding, failure, replay, chain, host, and recovery behavior applicable to its section.
