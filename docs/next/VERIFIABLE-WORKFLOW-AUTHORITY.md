# Verifiable Workflow Authority & Portability

<a id="status"></a>

**Status:** normative architecture contract for the Verifiable Workflow Authority & Portability milestone  
**Profile:** `forgedock.protected/v1`  
**Scope:** documentation-only contract; implementation, cryptographic dependencies, and persisted-format migrations are follow-up work.

This document is the sole normative source for protected workflow evidence. The architecture brief, implementation tracker, security policy, source interfaces, and future adapters are projections or implementations of this contract. The terms **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, and **MAY** are normative.

<a id="terminology-invariants"></a>
## 1. Terminology and invariants

- **Controller** means the typed ForgeDock controller process and its policy, state-transition, verification, publication, review, merge, and closure code. A model, event consumer, host, lease store, local database, or imported bundle is not a controller.
- **Artifact** is a durable semantic record such as Intent, Investigation, Build Packet, Build Result, Review Verdict, or Outcome. **Event** is an observation of a controller decision, not an artifact that can make the decision.
- **Protected evidence** is a `forgedock.protected/v1` envelope whose canonical bytes, digest, predecessor link, signature, and bindings verify under this document. Existing `forgedock.artifact/v2` records are **legacy-unprotected** evidence.
- **Subject** identifies the exact repository object or run to which an artifact, event, grant, lease, or decision applies. A repository name alone is not a subject.
- **Live authority** is the controller's current, policy-checked ability to cause a transition or host mutation. Portable material, local state, leases, and model output never become live authority merely by being readable or signed.

<a id="authority-boundary"></a>
### 1.1 Non-negotiable authority boundary

The typed controller alone authorizes workflow transitions, publication, verification gates, review verdict acceptance, merge, and closure. It MUST validate the current state, policy, subject, SHA, capabilities, leases, and required evidence before causing a side effect. Models MAY propose content or a decision input, but MUST NOT receive controller signing keys or authoritative host-mutation rights. Events report decisions after the controller commits them and can never authorize a decision. GitHub is durable semantic truth for the GitHub adapter; SQLite, process state, sessions, bundles, and leases are operational or archival aids.

<a id="threat-model"></a>
## 2. Threat model and trust boundaries

<a id="trusted-components"></a>
### 2.1 Trusted components

1. **Typed controller:** trusted to enforce state transitions, policy, exact bindings, verification gates, delegation checks, and host-side effects. Its executable release, configuration policy, and controller-key custody are trusted inputs to an installation.
2. **Controller key custody:** a separately managed OS-protected key store, hardware-backed store, or equivalent operator-controlled secret boundary is trusted to keep private keys unavailable to models and ordinary artifact readers. The key store is trusted for secrecy, not for workflow policy.
3. **Conforming host adapter:** trusted only for the guarantees it advertises and passes in the adapter conformance suite. GitHub remains the semantic authority for GitHub objects; the adapter does not gain permission to invent ForgeDock decisions.
4. **Cryptographic verification implementation:** trusted to implement the specified canonicalization, digest, signature, and comparison rules without accepting malformed alternatives.
5. **Operator policy and repository identity configuration:** trusted as the configured policy input, subject to controller validation and durable recording.

<a id="untrusted-inputs"></a>
### 2.2 Untrusted inputs

Issue and PR bodies, comments, labels, Git refs and contents, model prompts and outputs, provider metadata, tool results, host API responses, local SQLite rows, session transcripts, lease records, imported bundles, event consumers, configuration supplied by a repository, clocks, and all artifact payloads are untrusted data until validated. A valid signature authenticates bytes from a controller key; it does not make the payload's claims true or grant the payload authority.

<a id="attacker-capabilities"></a>
### 2.3 Attacker capabilities

The threat model permits an attacker to edit or delete unprotected comments, alter local state, replay or reorder envelopes and grants, provide malformed or oversized JSON, forge model output, control a model/provider session, compromise a host adapter response, race workers, acquire stale leases, present a different repository or SHA, export or import bundles, and obtain old public verification material. An attacker MAY know public keys and all canonicalization rules. The baseline does **not** promise safety after compromise of the controller process, its active private key, the host's own administrative authority, or the repository owner account; those incidents require key retirement and host remediation.

<a id="protected-assets"></a>
### 2.4 Protected assets

The protected assets are controller identity and signing-key continuity; integrity and provenance of artifacts and events; exact repository, subject, run, action, and reviewed-SHA bindings; workflow state and transition decisions; publication/review/merge/closure authorization; fencing against concurrent workers; secret material; and the ability to verify historical evidence offline without treating it as current authority.

<a id="trust-boundaries"></a>
### 2.5 Explicit boundaries

| Boundary | What crosses it | Required rule |
| --- | --- | --- |
| Controller ↔ model runtime | task, bounded context, proposal, output, events | The model gets least-authority tools and no signing key or authoritative mutation grant. Controller validation, not model output, selects the next action. |
| Controller ↔ host adapter | typed request and host result | The controller supplies exact subject/SHA and capability requirements; adapter conformance and CAS/fencing guarantees are checked before mutation. Host responses are untrusted until structurally and semantically validated. |
| Controller ↔ local state | checkpoints, leases, caches, sessions | Local state accelerates recovery and coordination but cannot override GitHub or protected evidence. Loss or corruption fails closed for required gates. |
| Controller ↔ portable bundle | exported/imported evidence and public verification material | A bundle is deterministic archival evidence. Import verifies and revalidates; it never installs a competing controller or authority. |
| Controller ↔ GitHub | durable artifact/comment/issue/PR operations | GitHub is semantic truth for the GitHub adapter, but a GitHub comment is not trusted merely because it exists: protected evidence and current controller policy still gate action. |

<a id="protected-envelope"></a>
## 3. Protected envelope, canonicalization, and verification

<a id="canonical-bytes"></a>
### 3.1 Canonical bytes

The protected profile uses canonical JSON, not `JSON.stringify` output and not a human Markdown projection.

1. Every string is Unicode NFC, encoded as UTF-8, and escaped only as required by JSON (control characters, quotation mark, and reverse solidus); no BOM is permitted.
2. Object keys are unique. The outer envelope uses the field order in [§3.2](#envelope-sequence); every other object uses keys sorted by their UTF-8 byte sequence. Arrays retain semantic order. Whitespace between tokens is forbidden.
3. Numbers are finite integers in the permitted range (no exponent notation, `-0`, NaN, or Infinity). Timestamps are UTC RFC 3339 strings with seconds and `Z` (for example `2026-08-03T16:01:12Z`). SHA-256 digests are lowercase hexadecimal; public identifiers, key IDs, and signatures are unpadded base64url where their field says so.
4. `null`, booleans, strings, arrays, and objects are encoded by their ordinary JSON tokens. Unknown fields, duplicate keys, alternate encodings, and omitted required fields are invalid; an implementation MUST NOT silently canonicalize them.
5. `canonical(x)` means the exact UTF-8 bytes produced by these rules. A digest compares bytes, not parsed-object equivalence.

<a id="envelope-sequence"></a>
### 3.2 Envelope sequence and fields

A protected envelope is a JSON object with exactly these top-level fields, in this order:

```text
schema, kind, id, runId, subject, action, sequence, predecessor,
createdAt, controller, reviewedSha, payloadDigest, payload, signature
```

Field meanings and required values are:

| Field | Requirement |
| --- | --- |
| `schema` | Exactly `forgedock.protected/v1`. |
| `kind` | Closed artifact kind (`Intent`, `Investigation`, `BuildPacket`, `BuildResult`, `ReviewVerdict`, `Outcome`) or event kind defined by the event profile. Unknown kinds are unverifiable. |
| `id` | Stable unique envelope ID; immutable once published. |
| `runId` | Exact run ID for the controller trajectory; non-empty and bound into the signature. |
| `subject` | Canonical subject object from [§6](#subject-capabilities); exact repository and object binding is mandatory. |
| `action` | Closed action vocabulary from [§5](#delegation); no implicit action is inferred from `kind`. |
| `sequence` | Zero-based, contiguous sequence within `(controllerId, runId)`. |
| `predecessor` | `null` at sequence 0; otherwise the lowercase hex digest of the immediately prior protected envelope. |
| `createdAt` | Controller-observed creation time in the specified timestamp form. It is evidence time, not a trust decision. |
| `controller` | `{ "id": public-controller-id, "keyId": active-key-id }`. Both identifiers are bound to the signature. |
| `reviewedSha` | Full lowercase 40-hex Git SHA when review, merge, or a SHA-bound action applies; otherwise `null`. It MUST equal the SHA actually checked by the controller. |
| `payloadDigest` | Digest defined below, over the canonical payload only. |
| `payload` | Schema-validated semantic payload. It contains no private key or provider credential. |
| `signature` | `{ "alg": "Ed25519", "keyId": active-key-id, "value": base64url-signature }`; omitted only while forming signature input. |

<a id="digest-and-signature"></a>
### 3.3 Digest, predecessor, and signature formulas

Let `P = canonical(payload)`. Let `D = hex(SHA-256(UTF8("forgedock.payload/v1\0") || P))`. `payloadDigest` MUST equal `D`. Let `E0` be the envelope with `signature` omitted, with all other fields present and ordered as in §3.2. Let `ED = hex(SHA-256(UTF8("forgedock.envelope/v1\0") || canonical(E0)))`.

The signature input is the following UTF-8 byte sequence, with no surrounding JSON and no trailing newline:

```text
forgedock.signature/v1\0
repo=<canonical subject repository>
subject=<hex SHA-256 of canonical(subject)>
run=<runId>
action=<action>
reviewed-sha=<reviewedSha or empty string>
envelope=<ED>
```

Each line ends in `LF`, including the line containing `envelope`; the `\0` is one zero byte, not the two characters backslash and zero. The controller signs this exact input with the private key identified by `controller.keyId`. Verification MUST check the payload digest, envelope digest, signature, controller ID derivation, exact subject, run, action, and reviewed-SHA before accepting `valid`. A signature covers the complete envelope through `ED`; it does not authenticate external comments, mutable host state, or claims not represented in the envelope.

<a id="chain-rules"></a>
### 3.4 Chain and replay rules

A verifier groups envelopes by controller ID and run ID, requires sequence 0 through the observed maximum exactly once, checks each predecessor against the prior envelope digest, and rejects a fork, duplicate sequence, wrong run, wrong controller, or mismatched predecessor as `chain-gap`. A later valid envelope does not repair an earlier gap. An envelope ID or nonce is not a substitute for sequence continuity. Replays of an already accepted envelope are harmless reads; replayed grants and one-shot actions are denied as specified in §5.

<a id="verification-states"></a>
### 3.5 Verification result states

The result is one of these stable states, with no silent downgrade:

| State | Meaning | Read outcome | Authority/gate outcome |
| --- | --- | --- | --- |
| `valid` | Protected bytes, signature, bindings, and observed chain verify. | Read and display as protected evidence. | Eligible only for the specific policy gate and current subject/SHA; never automatically authorizes a new action. |
| `legacy-unprotected` | Readable `forgedock.artifact/v2` structural record without protected proof. | Read and label visibly as legacy. | Ineligible for a protected trust gate; may be context evidence. |
| `mixed/degraded` | Set contains both protected and legacy/unprotected members, or protected coverage is incomplete. | Read all structurally valid members and identify coverage. | Required protected gates fail closed until the set is complete and valid. |
| `malformed` | Bytes are not valid canonical/profile JSON, have duplicate/unknown fields, or fail structural schema. | Preserve raw input only for diagnostics; do not interpret its claims. | Deny. |
| `incomplete` | Required artifact/event, key-transition, or required sequence member is absent, without enough proof to call it a chain gap. | Show missing requirements. | Deny required gates and import as trusted evidence. |
| `unverifiable` | Required key, algorithm, signature, binding, or revocation material is unavailable or cryptographically fails. | Preserve bytes and reason. | Deny. |
| `chain-gap` | Sequence/predecessor continuity is broken, forked, duplicated, or a required predecessor is absent. | Read surrounding records with a gap warning. | Deny chain-dependent gates. |

<a id="controller-identity"></a>
## 4. Controller identity and key lifecycle

<a id="identity-generation"></a>
### 4.1 Generation and storage

An installation generates a fresh Ed25519 controller key pair using an approved operating-system or hardware cryptographic random source. The private key MUST be non-exportable where the platform supports that property, otherwise it MUST be encrypted at rest by an OS-protected secret and accessible only to the controller service under least privilege. Private keys MUST NOT be placed in repositories, issue bodies, bundles, logs, environment snapshots, model context, provider configuration, or GitHub App credentials.

The public controller identifier is deterministic:

```text
controllerId = "fdc1_" + base64url(SHA-256(UTF8("forgedock.controller-id/v1\0") || publicKeyBytes))
```

`publicKeyBytes` are the 32 raw Ed25519 public-key bytes. The key record publishes `controllerId`, `keyId`, algorithm, public key, creation time, status, and predecessor/transition references. A `keyId` is unique within the controller identity and is not a provider or GitHub credential identifier.

<a id="identity-rotation-loss"></a>
### 4.2 Rotation, loss, retirement, and historical verification

Rotation creates a new key and a protected key-transition record signed by both the retiring active key and the new key. The record binds old/new controller IDs and key IDs, effective time, reason, and sequence. The controller uses the new key only after the transition is durably published. A verifier may establish continuity through this record; absent a valid transition, the new key is a new controller identity.

If a private key is lost, the controller MUST stop protected publication and all key-dependent gates, generate a new identity, and record the loss. It MUST NOT recreate a key from an ID or silently claim continuity. If compromise is suspected, the key is revoked immediately in the authoritative key registry and retired from signing; future operations deny it. Retirement/revocation does not rewrite history: historical signatures remain verifiable against archived public material, while their current-trust status includes the revocation time and the verifier's freshness point. Offline verification MUST report that revocation freshness may be unknown.

Controller keys are never model-provider credentials, GitHub App installation/user credentials, OAuth tokens, deploy keys, or session secrets. Models never hold or select a signing key. A GitHub App may perform a host API call only through the controller's separately validated host boundary.

<a id="delegation"></a>
## 5. Delegated capability grants

Delegation constrains a controller-approved operation; it does not create a second authority. A grant is protected evidence with issuer, delegatee, subject, action, constraints, `notBefore`, `expiresAt`, depth, parent grant ID (if any), nonce, and `oneShot` fields. The exact action vocabulary is:

```text
artifact.append
artifact.verify
host.publish
host.review
host.merge
host.compareAndSwap
lease.acquire
lease.heartbeat
lease.release
bundle.export
bundle.import
```

No wildcard, unknown action, or action inferred from a free-form string is accepted. The issuer MUST be the active controller or an explicitly permitted attenuating delegate. `delegatee` is an exact runtime/worker identity, never a model name alone. The subject repository, object identity, run ID, action, and reviewed SHA (when applicable) MUST match the request exactly. A grant may narrow, never widen, its parent's subject, action set, paths, SHA, host operation, expiry, or resource limits.

`notBefore` and `expiresAt` are UTC times; expiry is exclusive and an absent time is invalid. Delegation depth starts at zero and is capped at two; a child grant has strictly less or equal scope and an earlier/equal expiry. Nonces are unique within `(issuer, delegatee, runId, action)` and are recorded before a one-shot operation is attempted using an atomic compare-and-swap. A used nonce is denied on every retry, including after a process restart. Repeated idempotent reads may use a non-one-shot grant; publication, review acceptance, merge, closure, and any host mutation MUST use one-shot grants or an equivalent controller-side decision record.

Unknown actions, fields, constraints, issuer/delegatee identities, expired grants, clock ambiguity beyond the configured skew, invalid bindings, excessive depth, missing attenuation, and replay all default to deny. A grant does not bypass current state, capability, SHA freshness, verification, lease, or human-approval policy.

<a id="subject-capabilities"></a>
## 6. Canonical subjects and host capabilities

<a id="canonical-subject"></a>
### 6.1 Subject identity

A subject is an object with exactly these fields:

```json
{"host":"github","repository":"owner/name","object":"issue|pull_request|run|artifact","number":0,"sha":null}
```

`host` is a lower-case adapter name. For GitHub, owner and repository are lower-case ASCII names joined by one `/`; no URL, `.git`, whitespace, alternate host, or abbreviated SHA is accepted. `object` is one of the listed values. `number` is a positive integer for issue/pull request and `null` otherwise. `sha` is a full lower-case 40-hex commit SHA for a SHA-bound object and `null` otherwise. The canonical subject is the canonical JSON bytes of this exact object. A run subject uses `object:"run"`, its exact repository, and its run ID in the enclosing `runId`; artifact subjects use `object:"artifact"` only when the artifact itself is the target. Repository, number, object, run ID, action, and reviewed SHA are never inferred from display text.

<a id="capability-discovery"></a>
### 6.2 Discovery and adapter conformance

A host adapter MUST expose a versioned capability document containing adapter name/version, canonical subject rules, supported action names, exact repository identity, read/write semantics, current-head and compare-and-swap support, durable artifact/comment behavior, review/check behavior, merge behavior, lease/fencing support, maximum request sizes, and an expiry or discovery time. The controller validates the document against the conformance suite and treats missing, stale, contradictory, or unknown capability fields as unsupported.

The minimum guarantees are:

| Operation | Mandatory guarantee before authorization |
| --- | --- |
| Publish | Authenticated write to the exact repository/subject, idempotency by protected envelope ID, read-after-write or verifiable response, and durable retrieval of the published bytes. |
| Review | Read of the exact PR and full head SHA, immutable evidence binding to that SHA, and detection of a head change before and after review. |
| Merge | Exact expected-head-SHA compare-and-swap at the host, current required checks/policy observation, and a durable result that identifies the merged SHA or denial. No “merge latest” operation qualifies. |
| Compare-and-swap coordination | Atomic expected-version/fencing comparison with a monotonic result; last-write-wins, best-effort update, or local-only locking does not qualify. |

Unsupported capabilities fail closed. The controller MUST NOT fall back to an implicit authority path, a model instruction, a comment lock, or an unverified adapter response. GitHub's durable semantic truth does not remove the need for exact SHA and controller policy checks.

<a id="workflow-events"></a>
## 7. Workflow events

<a id="event-envelope"></a>
### 7.1 Version, ordering, and correlation

A workflow event uses `forgedock.event/v1` and contains exactly: `schema`, `eventId`, `runId`, `sequence`, `correlationId`, `causationId`, `decisionRef`, `subject`, `type`, `occurredAt`, and `data`. `eventId`, `runId`, and `decisionRef` are exact identifiers; `correlationId` identifies one user/request trajectory and `causationId` points to the event or decision that caused this event. `type` is a versioned closed vocabulary; event data is bounded and contains no secret.

The controller assigns a contiguous zero-based sequence per run and emits an event only after the referenced controller decision and its required durable artifact are committed. A failure between commit and emission is reconciled by replaying the missing report from the decision record; it never rolls back or guesses a decision. Consumers order by `(runId, sequence)`, retain duplicate event IDs idempotently, and quarantine impossible sequence or correlation values.

Unknown minor event types MAY be stored and displayed as opaque observations. Unknown major schemas, malformed events, unknown required fields, or unbounded data MUST be quarantined and MUST NOT alter state. Consumers can update views from events, but an event, event order, or consumer acknowledgment can never authorize a transition, publish, review, merge, or closure.

<a id="leases"></a>
## 8. Leases, fencing, and compare-and-swap

<a id="lease-protocol"></a>
### 8.1 Protocol

A lease key is the exact coordination subject `(repository, runId, resource)`. Acquisition is an atomic CAS: if no unexpired record exists, or the existing record is expired according to the authoritative coordination clock, the host creates a new random holder token and increments a strictly monotonic `fencingSequence`; otherwise it returns the current holder/expiry without granting ownership. The operation includes an expected record version and returns the new version and fencing sequence.

A holder MUST heartbeat before expiry using its token, expected version, and fencing sequence. Heartbeat extends expiry only for the current token and sequence. Release is an atomic CAS for the current token and marks the record released; it never permits a late holder to release a replacement lease. Expiry is deny-by-default: a worker that cannot establish a fresh heartbeat MUST stop protected host mutations. Stale takeover is ordinary acquisition after authoritative expiry and always increments fencing sequence.

Every side effect guarded by a lease carries the fencing sequence. The host or coordination store rejects a request with a sequence lower than the current sequence, even if its token appears valid. A split-brain worker therefore receives a fencing failure, stops, and reconciles from durable controller/GitHub truth; it MUST NOT retry with a new guessed token or publish based on a local lease copy. If the store cannot provide atomic CAS, monotonic fencing, authoritative expiry, and read-after-write behavior, it is unsupported for multi-worker coordination. Single-process local leases may prevent accidental overlap but do not satisfy publish/merge coordination and cannot be represented as proof of distributed ownership.

Leases coordinate work; they do not determine workflow truth, approve a review, or authorize merge. GitHub remains durable semantic truth for GitHub objects. Lease loss, store unavailability, clock uncertainty, sequence regression, or conflicting holder records fail closed for the affected mutation and leave a diagnosable blocked state.

<a id="portable-bundles"></a>
## 9. Portable bundles

<a id="bundle-format"></a>
### 9.1 Contents and deterministic encoding

A `forgedock.bundle/v1` is a canonical JSON object with fields in this order: `format`, `controllerKeys`, `artifacts`, `events`, `transitions`, `chainTips`, and `manifest`. It is UTF-8 canonical JSON under §3.1, with arrays sorted by `(controllerId, runId, sequence, digest)` unless an array is explicitly a chain sequence, in which case sequence order is retained. No export timestamp, machine path, session ID, random ordering, compression metadata, or local database page is included. The manifest lists each entry's name, byte length, SHA-256 digest, subject, and verification state; manifest entries are sorted by UTF-8 name and the manifest digest covers all preceding content.

The ordered contents are:

1. public controller key records and valid key-transition/revocation records (never private keys);
2. protected and legacy artifacts, including their original canonical/raw bytes and source references;
3. versioned workflow events and decision references;
4. controller transitions needed to explain ordering and chain tips; and
5. the manifest and verification report, including missing predecessors, unknown keys, revocation-freshness limits, and compatibility states.

The hard limits are **16 MiB per bundle**, **1 MiB per entry**, **256 KiB per artifact or event payload**, and **64 KiB for any single string field**. Export MUST fail rather than truncate, omit silently, or split a bundle without a new manifest. Private keys, access tokens, cookies, provider credentials, GitHub App credentials, lease secrets, model prompts containing secrets, workspace contents, and session transcripts are excluded. A secret scan is a defense-in-depth check, not permission to export a secret if the scan is bypassed.

<a id="offline-import"></a>
### 9.2 Offline verification and import

Offline verification can check canonical bytes, digests, signatures, subject/run/SHA bindings, observed predecessor chains, and the included public-key history. It cannot establish current repository state, current branch head, host policy, current revocation status without a fresh authoritative registry, absence of an unanchored deleted tail, or that an issuer's external claims were true.

Import stores the bundle as archival evidence, rechecks size/encoding/signatures and all current local policy, and labels every member with its verification state. When connectivity returns, the controller MAY revalidate repository/SHA, host state, key retirement, and current policy; revalidation can downgrade trust and never upgrades malformed evidence. Imported artifacts/events MUST NOT be emitted as new live events, satisfy a missing current decision, acquire a lease, publish, review, merge, close, or become a competing controller. A bundle is a portable explanation of what was observed, not an authority source.

<a id="compatibility"></a>
## 10. Compatibility matrix

Existing v2 artifacts remain readable as explicitly degraded evidence. No reader may present readability as authenticity.

| Input set | Read | Verify result | Gate outcome | Import outcome |
| --- | --- | --- | --- | --- |
| Legacy `forgedock.artifact/v2` only | Structural fields/payload if valid | `legacy-unprotected` | Protected publish/review/merge/closure gates deny; non-authoritative context may be shown | Archive as legacy with warning; never upgrade in place |
| New protected set, complete chain and available active/historical keys | Protected fields and payload | `valid` | Eligible only when current subject, policy, capability, lease, and SHA checks also pass | Archive with verification report; revalidate current facts before use |
| Mixed protected and legacy members | All structurally valid members | `mixed/degraded` | Required protected set is incomplete; deny until every required member is protected and linked | Preserve both classes and degraded status |
| Malformed v2 or protected bytes | Raw bytes for diagnostics only | `malformed` | Deny | Quarantine; no parsing-based side effects |
| Structurally valid protected set missing required member/key/transition | Available records with missing marker | `incomplete` | Deny | Archive with explicit missing requirements |
| Protected bytes with absent/retired-unavailable key, bad signature, wrong binding, or unsupported algorithm | Bytes and failure reason | `unverifiable` | Deny | Preserve evidence and reason; no trust upgrade |
| Protected records with missing/wrong predecessor, duplicate sequence, fork, or skipped sequence | Records around the break | `chain-gap` | Deny chain-dependent gates | Archive with gap marker; later tail is not silently accepted |

A migration MAY render legacy records in the existing Markdown projection, but it MUST show the state label and MUST NOT synthesize a protected signature, predecessor, key transition, or current approval.

<a id="limitations"></a>
## 11. Limitations and failure semantics

Signatures detect unauthorized mutation of signed bytes and detect chain gaps that are visible in the observed set. They **cannot prove that an unanchored final tail was never deleted**: if the last available signed envelope is removed and no later anchored record or independent durable inventory exists, a verifier cannot distinguish deletion from an ordinary endpoint. Bundles have the same limitation and are not deletion-proof storage.

Signatures also do not prove that a trusted controller made a correct decision, that a model's evidence was truthful, that a host retained data, or that a revoked key was not used before revocation was recorded. Current gates therefore combine protected evidence with typed policy, exact SHA freshness, host capability guarantees, lease fencing, and current durable host reads. Any required guarantee that is absent, ambiguous, stale, malformed, or unverifiable fails closed.

<a id="rejected-alternatives"></a>
## 12. Rejected alternatives

- **Global trust-score merge authority:** rejected because a scalar score obscures exact evidence, bindings, policy, and SHA freshness; merge remains a typed controller decision with explicit gates.
- **Mandatory DID/UCAN:** rejected for this profile because it adds identity/delegation ecosystems and resolution dependencies without improving the required repository/run/SHA bindings. A future adapter may translate them only behind this contract.
- **Blockchain or mandatory external storage:** rejected because ordering, availability, cost, and deletion semantics would become a new authority dependency. GitHub and controller records remain the durable semantic boundary; bundles are archival.
- **Model-held signing keys:** rejected because a model/provider is untrusted input and must not be able to mint authority or hide key use inside a session.
- **Last-write-wins comment locks:** rejected because comments do not provide atomic ownership, fencing, or compare-and-swap semantics. Leases require monotonic fencing and CAS as defined in §8.

<a id="implementation-map"></a>
## 13. Implementation and evidence gates

This contract intentionally introduces no executable implementation, cryptographic dependency, runtime schema, adapter behavior, lease store, event bus, or persisted migration. Each future slice MUST link to the anchors below and remains incomplete until its named evidence exists. A passing prose review is not test evidence.

| Future slice | Contract anchors | Required evidence gate | Completion rule |
| --- | --- | --- | --- |
| Protected envelope, canonical bytes, digest, signature, chain verifier | [§3](#protected-envelope), [§3.1](#canonical-bytes), [§3.3](#digest-and-signature), [§3.4](#chain-rules) | Golden byte vectors, malformed/duplicate/unknown-field tests, signature and chain-gap tests, `git diff --check`, build and focused test output | Remains pending until vectors and failure-state tests pass. |
| Controller identity, rotation, loss, revocation, historical verification | [§4](#controller-identity) | Key custody integration tests, dual-sign transition tests, loss/revocation and historical offline verification tests, secret-leak scan | Remains pending until custody and lifecycle evidence is recorded. |
| Delegated capability grants and replay | [§5](#delegation) | Vocabulary/default-deny, attenuation/depth, time-bound, nonce CAS, one-shot replay, and restart tests | Remains pending until all deny cases and replay evidence pass. |
| Canonical subjects and host capability/conformance adapter | [§6](#subject-capabilities) | Subject canonicalization vectors; adapter conformance tests for publish, review, merge, and CAS; unsupported-host denial tests | Remains pending until every mandatory guarantee is executable and tested. |
| Versioned workflow event bus and stable view model | [§7](#workflow-events) | Ordering, duplicate, correlation, commit-before-event, unknown-major, unknown-minor, and consumer non-authority tests | Remains pending until event tests prove events cannot mutate authority. |
| Distributed lease coordination | [§8](#leases) | CAS race, heartbeat, expiry, stale takeover, monotonic fencing, split-brain, restart, and unsupported-host tests | Remains pending until multi-worker fencing evidence passes. |
| Portable bundle export/import and offline verification | [§9](#portable-bundles), [§9.1](#bundle-format), [§9.2](#offline-import) | Deterministic byte fixture, size/secret exclusion, offline limitation, import revalidation, and archival-only tests | Remains pending until export/import evidence is reproducible. |
| Legacy v2 read compatibility and protected migration gates | [§10](#compatibility), [§3.5](#verification-states) | Matrix fixtures for every row, v2 readability tests, mixed/degraded and malformed fail-closed tests | Remains pending until every observable read/verify/gate/import outcome is covered. |

This mapping is also projected into [`docs/next/IMPLEMENTATION.md`](IMPLEMENTATION.md). The architecture projection is [`docs/forgedock-next.html#artifacts`](../forgedock-next.html#artifacts), and security assumptions are [`SECURITY.md`](../../SECURITY.md).

<a id="documentation-boundary"></a>
## 14. Documentation-only boundary

For this milestone, the four documentation files freeze the contract only. They MUST NOT add runtime behavior, executable cryptography, new dependencies, source schemas, event or lease implementations, host adapter changes, bundle code, or persisted-format migrations. Subsequent issues implement one bounded slice at a time and must preserve the typed-controller authority boundary and the compatibility states in this document.
