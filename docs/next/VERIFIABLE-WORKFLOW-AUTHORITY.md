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
4. Repository, canonical subject, run, action, and reviewed full-SHA bindings are exact; a nearby or abbreviated value is not equivalent.
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

Protected assets are controller private keys, trust-root records, exact workflow decisions, artifact integrity and provenance, reviewed SHA bindings, capability nonces and replay state, lease ownership/fencing state, and the confidentiality of credentials, sessions, worktree secrets, and private repository data.

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
- **Controller ↔ host/GitHub:** adapter operations are typed requests with exact subject, run, action, and SHA bindings. A successful HTTP/API response is not a decision and MUST be checked before it is recorded as one.
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
- `sequence` is a non-negative integer. A run's first protected artifact is sequence `0` and has predecessor `null`; every later artifact has sequence previous plus one and a predecessor digest.
- `createdAt` is an RFC 3339 UTC instant with seconds and `Z` (fractional seconds are permitted only to exactly three, six, or nine digits and are preserved as text). The controller's trusted clock supplies it.
- `subject` is the canonical identity in [§7](#subjects). `action` is from the closed vocabulary in [§5](#capabilities).
- `reviewedSha` is required in the payload for review and merge-related actions and is a lowercase, exactly 40-character Git SHA-1 or exactly 64-character SHA-256 value as required by the host. The controller MUST reject abbreviations and case variants.
- `digest` and `signature` are integrity fields, not input to their own digest.

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

A run is an append-only logical sequence, but storage systems MAY deliver artifacts out of order. Sequence `0` is the genesis artifact: its `predecessor` MUST be `null`, its `sequence` MUST be `0`, and its `runId` establishes the sequence. Sequence `n > 0` MUST carry the exact digest of sequence `n-1` in `predecessor`; a missing, duplicated, conflicting, or non-contiguous link yields `chain-gap` even if each isolated signature is valid.

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

`canonicalSubjectBytes` is the exact UTF-8 JCS encoding of `subject`, and `reviewedSha-or-empty` is the exact lowercase SHA when the action requires one, otherwise the empty string. The Ed25519 signature is over `signatureInput`; `signature` is unpadded base64url of the 64-byte signature. The controller MUST verify the digest before the signature and MUST verify the requested repository, subject, run, action, and reviewed SHA against the current operation, not merely against the artifact itself.

<a id="verification"></a>
### 3.4 Verification algorithm and result states

Verification is deterministic and returns one primary state plus structured diagnostics. It MUST perform profile/shape and canonical parsing checks, then digest, key/trust status, signature, binding, chain, time, and policy checks. A verifier MAY report multiple diagnostics but MUST choose the first applicable primary state using this precedence: `malformed`, `incomplete`, `unsupported`, `invalid-signature`, `wrong-binding`, `chain-gap`, `expired`, `revoked`, `unverifiable`, then `verified`.

| Primary state | Meaning | Protected authorization |
| --- | --- | --- |
| `verified` | Correct protected profile, canonical bytes, digest, trusted non-revoked key, signature, bindings, chain context, and validity | May be considered by the controller, subject to current policy and host checks |
| `legacy-unverified` | Structurally readable v2 artifact with no protected proof | Evidence only; never authorizes a protected action |
| `malformed` | Invalid JSON, duplicate keys, invalid canonical data, invalid field shape, or illegal encoding | Reject and quarantine; no authorization |
| `incomplete` | Required field, predecessor, key record, chain member, reviewed SHA, or required evidence is absent | No authorization; do not guess or repair silently |
| `unsupported` | Unknown profile version, action, constraint, key algorithm, or schema extension | No authorization; preserve bytes for inspection |
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

`keyId` is a stable public identifier derived only from the canonical public key:

```text
publicKeyBytes = raw 32-byte Ed25519 public key
keyId = "fdck_" + lowercase(base32-crockford(SHA-256(UTF8("ForgeDock-Key-Id-v1\0") || publicKeyBytes)))[0:26]
```

The Crockford alphabet is `0123456789abcdefghjkmnpqrstvwxyz`, with no separators or check symbols; the displayed identifier is lower case.

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

A capability record has exactly these semantic fields:

| Field | Rule |
| --- | --- |
| `issuer` | Trusted controller `keyId`; an unknown, revoked, or non-controller issuer is denied |
| `audience` | Exact controller installation, adapter, or worker identity; wildcard audience is forbidden |
| `action` | One closed action above |
| `subject` | Exact canonical subject, or an explicitly registered subject set; aliases and URLs are not equivalent |
| `runId` | Exact run binding; absent only for explicitly read-only, non-run-scoped actions |
| `reviewedSha` | Exact full SHA for `review.record` and `merge.request`; no “latest” or abbreviation |
| `issuedAt`, `expiresAt` | UTC instants; `issuedAt < expiresAt`, bounded by controller policy; expired or excessive lifetime is denied |
| `delegation` | Parent capability ID, depth, and attenuation record; absent for an original controller grant |
| `nonce` | Unique random value within the issuer/audience/action scope |
| `oneShot` | Boolean; if true, atomic consumption is required before the action |
| `constraints` | Registered, closed semantic constraints only; unknown names or values deny |

Delegation is a strict subset operation: a child MUST preserve issuer/audience scope, action, subject, run, reviewed SHA, and expiry or narrow them; it MAY reduce constraints and permissions but MUST NOT broaden any field. Each delegation increments depth; maximum depth is 3, and a missing or invalid parent makes the child unverifiable. The controller records lineage and rejects cycles, reused delegation IDs, and a child whose interval is outside its parent.

One-shot replay consumption is an atomic compare-and-set operation in the authoritative replay store: reserve nonce, validate all capability and current-policy conditions, commit consumption with the controller action, or release the reservation on a failed precondition. A crash must leave an unambiguous consumed/not-consumed record; an unavailable or non-atomic replay store returns `unverifiable` and denies the action. Duplicate use, a nonce with a different semantic body, and a stale reservation are denied. Non-one-shot capabilities still expire and remain subject to exact binding and policy.

Unknown constraints, unavailable issuer records, absent replay state, clock uncertainty beyond configured skew, unsupported delegation, and missing exact subject/SHA values are default-deny conditions. Capability possession never authorizes merge, publication, review, closure, or a transition without the typed controller's committed decision.

<a id="subjects"></a>
## 6. Canonical subjects and host adapter conformance

### 6.1 Subject identity

A subject is a typed object, not a URL or display name. Canonical subject objects use lower-case `type` and exact normalized repository identity:

- repository: `{ "type": "github.repo", "repo": "owner/name" }`;
- issue: `{ "type": "github.issue", "repo": "owner/name", "number": N }`;
- pull request: `{ "type": "github.pr", "repo": "owner/name", "number": N }`;
- commit: `{ "type": "git.commit", "repo": "owner/name", "sha": "full-lowercase-sha" }`.

For GitHub, `owner/name` is the host's canonical API identity, case-normalized to lower case only after the adapter confirms the repository; no URL, clone URL, `#number` shorthand, fork alias, organization alias, or display title is accepted as an equivalent subject. Numbers are positive JSON integers. A PR and an issue with the same number are different subjects. The subject is encoded with [§3.2](#canonical-bytes) and signed exactly.

### 6.2 Discovery and conformance

Every host adapter MUST expose a signed-or-authenticated capability discovery result with adapter name/version, host identity, supported subject types, supported operations, exact-SHA behavior, comment/artifact size limits, event delivery properties, compare-and-swap/lease properties, and discovery time. Unsupported or unknown capabilities MUST be treated as unavailable, not inferred from a successful unrelated API call.

An adapter conformance suite MUST test canonical subject round trips, repository ownership, exact full-SHA lookup, stale-head detection, idempotency keys, response-to-request binding, pagination/completeness, error classification, size limits, and capability discovery. It MUST distinguish permission denied, not found, conflict, rate limit, stale revision, unsupported guarantee, and indeterminate network result. An indeterminate mutation result is reconciled by idempotency key and exact subject before retry; the controller MUST NOT blindly duplicate a side effect.

Minimum guarantees are:

| Operation | Mandatory host guarantee | If unavailable |
| --- | --- | --- |
| Publish artifact/PR | Durable write or idempotent mutation, exact subject/run association, returned immutable reference, and read-after-write verification | Do not claim published or proceed on an unverified result |
| Record review | Read the exact full reviewed SHA and prove the head remains that SHA immediately before/after recording | Review is stale/unverifiable; do not approve or merge |
| Merge | Host-enforced source/base/head identity, current checks/policy, idempotent merge result, and controller-approved exact SHA | Merge is denied; a comment or event cannot substitute |
| Compare-and-swap coordination | Atomic expected-version/sequence update with owner fencing and durable conflict result | Distributed lease/coordination is unsupported; do not run multi-writer coordination |

GitHub comments, labels, checks, and webhooks report durable facts or requests. None is an authority path. The controller alone interprets them and commits a transition.

<a id="events"></a>
## 7. Controller events

Events are versioned reports of committed controller decisions. A protected event envelope has `eventProfile`, `eventType`, `eventId`, `runId`, `subject`, `sequence`, `occurredAt`, `causationId`, `correlationId`, `decisionRef`, and `data`, encoded with the canonical rules in [§3.2](#canonical-bytes). `eventType` is closed for each event profile; unknown fields or event types are quarantined, not guessed.

`eventId` is unique and immutable. `correlationId` identifies one workflow trajectory; `causationId` names the event or request that caused the decision, when present. `sequence` is the committed per-run event sequence, monotonically increasing from zero. `decisionRef` points to the controller's committed decision/artifact and MUST be resolved and binding-checked before a consumer presents the event as authoritative.

The controller MUST commit the decision before publishing its event. Consumers MUST:

1. verify profile, event identity, subject/run correlation, and decision reference;
2. apply events in sequence order, buffering a bounded gap and reconciling from durable artifacts when needed;
3. treat duplicate `eventId` or already-applied sequence as idempotent only when the bytes and decision reference match;
4. quarantine conflicting duplicates, gaps that cannot be reconciled, malformed events, and unknown versions/types;
5. preserve unknown events for forward-compatible replay without executing them.

Events can update a view model, notifications, or operational projections. They MUST NOT authorize a transition, mutation, publication, review, merge, closure, lease acquisition, or capability grant. A consumer receiving an event is never a substitute for asking the controller to evaluate current state and policy.

<a id="leases"></a>
## 8. Distributed leases and compare-and-swap

A lease protects one declared coordination key (for example, a run or exact expected-path claim), has a unique owner token, expiry, heartbeat interval, and monotonic fencing sequence. Acquisition is an atomic CAS from no live lease (or an expired lease) to `(owner, token, sequence + 1, expiry)`. The controller MUST persist the returned sequence and include both token and sequence in every heartbeat, release, state write, and host mutation that depends on the lease.

- **Acquire:** validate host capability and expected version; return one owner and one fencing sequence. A live conflicting owner returns `busy`, never last-write-wins.
- **Heartbeat:** renew only with exact key, owner token, and current sequence before expiry. A late or duplicate heartbeat is idempotent only when it matches the current record.
- **Expiry:** an owner that cannot heartbeat before expiry loses authority. Clock use is from the coordination host; clients MUST allow configured bounded skew and MUST NOT extend a lease from a stale local clock.
- **Release:** is idempotent for the current token/sequence; an old owner cannot release a successor lease.
- **Stale takeover:** after host-observed expiry, a new owner atomically increments the fencing sequence. The old owner is fenced from subsequent writes even if its process continues.
- **CAS writes:** every state/coordination write names the expected sequence/version. A mismatch returns `conflict` and the worker stops or reconciles; it does not overwrite.
- **Split brain:** if two owners believe they hold a lease, the host's higher valid fencing sequence wins. Writes from the lower sequence are rejected. If the host cannot enforce fencing, both writes are unsafe and the controller MUST stop protected coordination and report `unverifiable`.
- **Failures:** network ambiguity after acquisition or mutation requires reconciliation by idempotency key and sequence. It MUST NOT be resolved by a blind retry or local “last write wins.”

A host that exposes only local memory, best-effort locks, non-atomic comments, or last-write-wins records does not provide the required distributed guarantee. Single-process operation MAY use the existing local lease semantics when policy explicitly limits the scope to one process; it MUST NOT advertise that as cross-machine coordination.

<a id="bundles"></a>
## 9. Portable bundles

A portable bundle is a deterministic archival export, never a second live workflow authority. It contains:

1. a manifest with bundle profile/version, bundle ID, creation time, source host, root subject/run, artifact IDs, byte lengths, and SHA-256 digests;
2. protected artifacts and permitted legacy v2 evidence, each as exact canonical bytes;
3. public controller keys and lifecycle/trust metadata needed for offline verification (never private keys);
4. predecessor/chain evidence, checkpoint/anchor references, and host references for exact SHA and decision context;
5. a bundle-level digest and controller signature over the manifest and ordered member digests.

The bundle digest is domain-separated from artifact digests:

```text
bundleDigest = "sha256:" + lowercase(hex(SHA-256(
  UTF8("ForgeDock-Bundle-Digest-v1\0") || manifestBytes || 0x00 ||
  UTF8(memberName || "\0" || memberDigest) for each member in manifest order
)))
bundleSignatureInput = UTF8("ForgeDock-Bundle-Signature-v1\0") || UTF8(bundleDigest) || UTF8(bundleId)
```

The Ed25519 signature covers `bundleSignatureInput`; `manifestBytes` is the canonical manifest JSON and member names/digests are the exact ordered values. The deterministic encoding is a ZIP archive with fixed member names sorted by UTF-8 byte order, UTF-8 manifest JSON using [§3.2](#canonical-bytes), fixed Unix epoch timestamps, no extra fields, no compression for canonical member bytes, and no platform-specific permissions. A later implementation MUST publish the exact archive profile and test vectors before claiming interoperability. The bundle profile's hard limits are: 64 MiB total uncompressed bytes, 8 MiB manifest, 1 MiB per artifact, 100,000 members, and 100 MiB maximum compressed input accepted for decompression safety; adapters MAY impose lower limits.

Bundles MUST exclude private keys, provider tokens, GitHub App credentials, OAuth/SSH credentials, cookies, session transcripts, environment files, worktree secrets, unredacted model prompts containing secrets, and operational lease tokens. Export MUST fail or redact deterministically when exclusion cannot be proven. Public repository content is not automatically safe; the exporter applies the configured sensitivity policy.

Offline verification checks archive structure, limits, member digests, manifest signature, public-key lifecycle, artifact canonical bytes, signatures, bindings, chain/checkpoint evidence, and legacy status without network access. Missing trust metadata, missing predecessor members, stale/revoked keys, or an absent anchor are reported rather than repaired. Offline verification cannot establish current host state, current merge policy, current repository contents, or current revocation status beyond the included trust snapshot.

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
| Incomplete protected set, missing key/predecessor/reviewed SHA | Partial display with a gap | `incomplete`, `chain-gap`, or `unverifiable` as applicable | Denied; no silent repair or upgrade |
| Correctly shaped but unknown profile/action/constraint | Preserve for inspection | `unsupported` | Denied |
| Signed data with wrong digest/signature | Preserve for investigation | `invalid-signature` | Denied |
| Valid signature but wrong repository/subject/run/action/SHA | Read as signed evidence | `wrong-binding` | Denied for the requested operation |
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
