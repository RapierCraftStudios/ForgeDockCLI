# Verifiable Workflow Authority and Portability

<a id="vwa-status"></a>
## Status, scope, and conformance

**Normative architecture contract — protected-evidence profile 1.** This document freezes the required security, compatibility, and byte-level behavior for future ForgeDock protected workflows. The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as in RFC 2119 and RFC 8174.

This is a documentation-only contract. The currently implemented `forgedock.artifact/v2` is structural JSON transported with `JSON.stringify` and Base64url. It is unsigned, has no authenticated sequence or controller identity, and is reconciled using timestamps. It MUST be reported as `LEGACY_UNPROTECTED`; this document does not retroactively protect it. Protected envelopes, controller keys, capabilities, host discovery, events, distributed fencing, and bundle import/export described below are requirements for later implementation, not claims about current behavior.

Only the typed ForgeDock controller authorizes workflow transitions, publication, review decisions, merge, closure, and other host side effects. Models, Pi or another model runtime, tools, events, local state, leases, and imported evidence can provide inputs or preconditions; none can make an authoritative decision.

Stable section anchors:

- [Threat model](#vwa-threat-model)
- [Algorithm suite and canonical bytes](#vwa-algorithm-suite)
- [Protected artifact envelope](#vwa-protected-envelope)
- [Verification states](#vwa-verification-states)
- [Controller identity](#vwa-controller-identity)
- [Semantic capabilities](#vwa-semantic-capabilities)
- [Canonical subjects and host conformance](#vwa-subject-host)
- [Workflow events](#vwa-events)
- [Distributed leases](#vwa-leases)
- [Portable bundles](#vwa-bundles)
- [Compatibility](#vwa-compatibility)
- [Limits](#vwa-limitations)
- [Conformance vectors](#vwa-test-vectors)
- [Rejected alternatives](#vwa-rejected-alternatives)

<a id="vwa-threat-model"></a>
## Threat model and authority boundaries

| Surface | Classification and trust boundary | Attacker capability considered | Protected asset / required response |
|---|---|---|---|
| Typed controller and its policy/verification code | Trusted computing base after installed-code integrity and configuration approval | Trigger races, supply malformed inputs, replay calls, crash between operations, or exploit policy ambiguity | Sole transition and side-effect authority; validate every boundary and fail closed |
| Model workers, Pi/model runtime, provider responses, prompts, tools, and transcripts | Untrusted, bounded reasoners outside the authority boundary | Prompt injection, fabricated evidence, stale output, data exfiltration attempts, arbitrary tool arguments | Never receive signing keys or unrestricted host mutation credentials; outputs are schema-checked proposals only |
| Controller key store and signing component | Trusted narrow service, separate from model/runtime | Key theft, substitution, rollback, deletion, misuse after rotation | Private signing keys, continuity, and revocation; isolate, audit, and stop signing on uncertainty |
| Host adapter and host APIs | Adapter code is trusted only after conformance; network and returned host content are untrusted | Reorder/edit/delete comments, stale reads, ambiguous repository names, API downgrade, non-atomic writes | Canonical subject binding, durable evidence, exact SHA review/merge, and CAS guarantees |
| GitHub issue/PR content for the GitHub adapter | Durable semantic record, but content and availability are not intrinsically trusted | Authorized users/apps may edit/delete/replay content; outage or pagination may hide it | Verify protected bytes and chain before authoritative use; preserve human-readable record |
| Local SQLite, caches, worktrees, process state, sessions, logs, and configuration | Operational input/cache, not durable semantic authority | Rollback, deletion, tampering, stale snapshots, concurrent writers | Rebuild from host evidence; never authorize from cache alone; secrets remain outside artifacts/bundles |
| Leases and clocks | Coordination preconditions, not workflow authority | Delay heartbeat, skew clocks, partition workers, resurrect stale owners | Host-atomic fencing and expected-value CAS; block split brain |
| Workflow events and consumers | Untrusted/replayable notifications and projections | Drop, duplicate, reorder, forge consumer state, mishandle unknown versions | Consumers checkpoint and detect gaps; events cannot authorize anything |
| Exported/imported bundles and parsers | Untrusted archival input outside live authority | Zip/path tricks, duplicate keys, oversized/deep data, signature/key substitution, secret smuggling | Bounded deterministic parser, offline trust report, archival-only namespace |
| Controller operator and trusted key administrator | Administrative trust root, not proof that signed claims are true | Misconfiguration, incorrect approval, malicious or compromised signer | Auditable identity policy and revocation; signatures prove provenance, not correctness |

Trust boundaries are crossed at model invocation/output, filesystem and process tools, key-service calls, adapter requests/responses, local-state reads, event delivery, lease CAS, and bundle parsing. The controller MUST revalidate typed data at each crossing. A host account, model provider, runtime session, or signed worker response MUST NOT be treated as controller identity.

<a id="vwa-algorithm-suite"></a>
## Protected-evidence algorithm suite 1

The suite identifier is exactly `forgedock.protection/1;JCS-SHA256-Ed25519`. Unknown identifiers MUST produce `UNSUPPORTED_VERSION / ALGORITHM_UNKNOWN`; there is no algorithm fallback.

### Restricted JSON and deterministic bytes

All protected objects MUST be parsed as UTF-8 JSON and canonicalized with RFC 8785 JSON Canonicalization Scheme (JCS), with these stricter profile rules:

1. Input MUST be valid UTF-8 without a BOM. Lone surrogates, replacement caused by decoding, duplicate object member names, non-JSON tokens, trailing data, and unescaped U+0000 through U+001F MUST be rejected before canonicalization.
2. Values are limited to objects, arrays, strings, booleans, null, and integers in `[-9007199254740991, 9007199254740991]`. Floating point, negative zero, exponent notation, NaN, Infinity, and integers outside that range MUST be rejected. Protocol counters that may exceed this range are decimal strings as specified below.
3. Strings MUST already be Unicode NFC. Implementations MUST validate but MUST NOT silently normalize. JSON escaping and object-key ordering are exactly RFC 8785 (UTF-16 code-unit order).
4. Canonical output is the exact RFC 8785 serialization encoded as UTF-8, with no BOM, whitespace, or trailing newline. Base64url means RFC 4648 URL-safe encoding with no `=` padding. Hex is lowercase.

A parser that cannot prove these restrictions conformantly MUST reject protected input.

### Hashes, domain separation, and signatures

`SHA256(x)` is SHA-256 over bytes `x`. A digest text is `sha256:` plus 64 lowercase hex digits. Ed25519 is pure Ed25519 from RFC 8032 (not Ed25519ph or Ed25519ctx), with a 32-byte public key and 64-byte signature.

For protected artifact profile 1:

```text
payloadBytes   = JCS_UTF8(payload)
contentDigest  = "sha256:" + hex(SHA256(payloadBytes))
signedView     = envelope with members "envelopeDigest" and "signature" absent
signedBytes    = JCS_UTF8(signedView)
signatureInput = ASCII("FORGEDOCK\0PROTECTED-ARTIFACT\0V1\0") || signedBytes
envelopeDigest = "sha256:" + hex(SHA256(signatureInput))
signature      = base64url(Ed25519.Sign(privateKey, signatureInput))
```

`\0` in the pseudocode above denotes a single zero byte, not two printable characters. The domain is 32 bytes: hex `464f524745444f434b0050524f5445435445442d415254494641435400563100`. Payload digest, envelope digest, and signature cover different explicitly named byte strings. No rendered Markdown, marker wrapper, transport Base64, timestamp chosen by the host, or mutable host metadata is in these inputs.

Verification order MUST be: bounded transport parse; restricted JSON/schema/version checks; recompute canonical payload and `contentDigest`; reconstruct `signedView`; recompute `envelopeDigest`; resolve and validate key lifecycle/trust anchor; verify Ed25519 signature; compare all semantic bindings; validate predecessor/sequence; check duplicate/fork/replay; then evaluate operation-specific policy. Reconciliation MUST occur only after this sequence.

Other signed protocol objects use the same restricted JCS, key rules, and Ed25519 primitive, but distinct ASCII domains defined in their sections. A signature from one protocol cannot be replayed into another.

<a id="vwa-protected-envelope"></a>
## Protected artifact envelope 1

Protection is a separately versioned wrapper around semantic content. `payload` remains a complete `forgedock.artifact/v2` object; an envelope MUST NOT alter the v2 payload schema or imply that an unwrapped copy is protected.

| Member | Required value and binding |
|---|---|
| `schema` | Exact `forgedock.protected-envelope/v1` |
| `suite` | Exact suite identifier above |
| `repository` | Canonical repository identity from [subject rules](#vwa-subject-host) |
| `subject` | Canonical issue or PR identity; MUST belong to `repository`; payload legacy subject/slug MUST resolve to this exact identity |
| `runId` | Non-empty controller-issued run ID; byte-equal to payload `runId` |
| `artifactId` | Byte-equal to payload `id` |
| `artifactKind` | Byte-equal to payload `kind` |
| `action` | One action from the capability vocabulary; exact decision represented by this artifact |
| `reviewedSha` | 40- or 64-character lowercase full Git object ID for review/merge-bound evidence; otherwise `null`. Abbreviations forbidden |
| `sequence` | Unsigned 64-bit integer encoded as shortest decimal string matching `0|[1-9][0-9]*`; first is `0`, each successor is prior plus one |
| `predecessor` | `null` only at sequence `0`; otherwise exact prior envelope digest |
| `keyId` | Controller public identifier |
| `payload` | Complete semantic artifact object |
| `contentDigest` | Digest of canonical payload bytes |
| `envelopeDigest` | Digest of `signatureInput` |
| `signature` | Base64url 64-byte Ed25519 signature |

The controller MUST bind the exact repository, subject, run, artifact, action, and reviewed SHA into every envelope. For `review.record` and `merge.execute`, `reviewedSha` is REQUIRED and MUST equal the freshly read full PR head. For issue-only decisions it MUST be `null`. Any mismatch with request context, payload, capability, host read-back, or predecessor is rejection, not a warning.

Sequences are per `(repository, subject, runId)`. A publisher MUST first verify the observed chain tip, allocate exactly `tip.sequence + 1`, set `predecessor` to the tip digest, sign, publish, read back the exact bytes, and confirm a host CAS/uniqueness precondition where concurrent publication is possible. Reuse of `(subject, runId, sequence)`, artifact ID, envelope digest, capability nonce, or a previously consumed one-shot action is replay. Two valid successors to one predecessor are a fork. A missing predecessor or nonconsecutive sequence is a gap. Duplicate identical transport copies MAY be coalesced for display, but MUST be recorded as duplicate observations and MUST NOT count as new decisions.

Envelope major versions and payload versions are independent. Unknown envelope major or suite is unsupported even if the payload is readable. A known envelope carrying an unknown payload version MAY display envelope metadata but cannot become authoritative. `createdAt` is signed payload evidence, never authenticated ordering; sequence and predecessor provide ordering. Timestamp/latest-kind selection MUST NOT resolve protected conflicts or mixed sets.

<a id="vwa-verification-states"></a>
## Closed verification results

A verifier MUST return exactly one state and one reason from this table, plus non-authoritative diagnostics. No ad-hoc success-like state is permitted.

| State | Allowed reasons | Meaning at protected gates |
|---|---|---|
| `VERIFIED_AUTHORITATIVE` | `ACTIVE_KEY_AND_COMPLETE_CHAIN` | The only state that may satisfy a current protected gate |
| `VERIFIED_HISTORICAL` | `RETIRED_KEY_VALID_AT_SIGNING`, `LOST_PRIVATE_KEY_PUBLIC_HISTORY_VALID` | Read/audit only; not a new current authorization |
| `LEGACY_UNPROTECTED` | `V2_NO_PROTECTED_ENVELOPE` | Read/display/migrate only |
| `MALFORMED` | `INVALID_UTF8`, `INVALID_JSON`, `DUPLICATE_MEMBER`, `JSON_PROFILE_VIOLATION`, `SCHEMA_INVALID`, `ENCODING_INVALID`, `RESOURCE_LIMIT` | Deny |
| `UNSUPPORTED_VERSION` | `ENVELOPE_MAJOR_UNKNOWN`, `PAYLOAD_VERSION_UNKNOWN`, `ALGORITHM_UNKNOWN`, `EVENT_MAJOR_UNKNOWN`, `CAPABILITY_VERSION_UNKNOWN`, `CONSTRAINT_UNKNOWN` | Deny |
| `INVALID_CRYPTOGRAPHY` | `CONTENT_DIGEST_MISMATCH`, `ENVELOPE_DIGEST_MISMATCH`, `SIGNATURE_INVALID`, `KEY_ID_MISMATCH` | Deny |
| `BINDING_MISMATCH` | `REPOSITORY_MISMATCH`, `SUBJECT_MISMATCH`, `RUN_MISMATCH`, `ARTIFACT_MISMATCH`, `ACTION_MISMATCH`, `SHA_MISMATCH`, `AUDIENCE_MISMATCH` | Deny |
| `INCOMPLETE_CHAIN` | `PREDECESSOR_MISSING`, `SEQUENCE_GAP`, `TAIL_ANCHOR_REQUIRED`, `HOST_READ_INCOMPLETE` | Deny |
| `CONFLICT` | `FORK_DETECTED`, `SEQUENCE_COLLISION`, `MIXED_TRUST_CONFLICT`, `SPLIT_BRAIN` | Deny |
| `REPLAYED` | `ENVELOPE_REPLAY`, `ARTIFACT_ID_REPLAY`, `NONCE_CONSUMED`, `DUPLICATE_ACTION` | Deny |
| `IDENTITY_UNVERIFIABLE` | `KEY_UNKNOWN`, `TRUST_ROOT_MISSING`, `IDENTITY_HISTORY_GAP`, `KEY_NOT_YET_VALID`, `KEY_OUTSIDE_VALIDITY` | Deny |
| `IDENTITY_REVOKED` | `KEY_COMPROMISED_AT_SIGNING`, `KEY_REVOKED_RETROACTIVELY` | Deny |
| `CAPABILITY_DENIED` | `ACTION_UNKNOWN`, `EXPIRED`, `NOT_YET_VALID`, `CLOCK_UNCERTAIN`, `CONSTRAINT_FAILED`, `DELEGATION_BROADENED`, `DELEGATION_DEPTH`, `ISSUER_MISMATCH` | Deny |
| `HOST_UNSUPPORTED` | `DISCOVERY_UNKNOWN`, `GUARANTEE_ABSENT`, `GUARANTEE_CONTRADICTED`, `CAS_UNAVAILABLE`, `FRESHNESS_UNPROVABLE` | Deny |

When several failures apply, the verifier MUST use this precedence: resource-safe parse/profile; version/schema; cryptography; identity; binding; chain/conflict/replay; capability/time; host guarantee. It MAY report secondary diagnostics, but state/reason are determined by the first category. All states except `VERIFIED_AUTHORITATIVE` fail closed for current publish, review, merge, transition, and distributed-coordination gates.

<a id="vwa-controller-identity"></a>
## Controller identity and key lifecycle

A controller signing key MUST be generated as an Ed25519 key using an operating-system CSPRNG inside the signing component. The private seed MUST be non-exportable where platform facilities allow, encrypted at rest otherwise, readable only by the controller identity service, excluded from logs/crash dumps/backups unless the backup is separately encrypted and access controlled, and never passed through prompts, model tools, worker environments, bundles, or host comments. A model-provider token, GitHub App key/token, OAuth token, SSH key, or user credential MUST NOT be reused as a signing key.

At first installation the controller creates its initial key and derives two public identifiers; both use raw 32-byte Ed25519 public-key bytes:

```text
controllerId = "fdcontroller:v1:" + base64url(SHA256(ASCII("FORGEDOCK\0CONTROLLER\0V1\0") || initialPublicKey))
keyId        = "fdkey:v1:" + base64url(SHA256(ASCII("FORGEDOCK\0CONTROLLER-KEY\0V1\0") || currentPublicKey))
```

`controllerId` remains stable across a verified rotation chain; each key has a different `keyId`. A new installation without continuity MUST receive a new controller ID and MUST NOT impersonate the lost one. A trusted identity history MUST publish the raw public key, key ID, controller ID, validity interval, status, predecessor key ID, rotation statement digest, and trust-root signature. Publication MAY use repository policy/configuration and durable host evidence, but trust is established only by an operator-approved root or a valid continuity chain to one. Merely finding a key beside an artifact is not trust anchoring.

| Lifecycle event | Required behavior | Historical result |
|---|---|---|
| Generation/activation | CSPRNG generation; atomic protected storage; publish and approve public record before signing | Active in-range signatures can be `VERIFIED_AUTHORITATIVE` |
| Planned rotation | Old key signs a domain-separated `FORGEDOCK\0KEY-ROTATION\0V1\0` JCS statement containing old/new IDs, new public key, activation time, and sequence; trust root records it; old key stops new signing | Old in-range signatures become `VERIFIED_HISTORICAL / RETIRED_KEY_VALID_AT_SIGNING`; new key may be current |
| Voluntary retirement | Publish signed retirement with effective time; retain public key/history permanently; destroy or archive private key under policy | Before-effective signatures are historical; later signatures are `IDENTITY_UNVERIFIABLE / KEY_OUTSIDE_VALIDITY` |
| Private-key loss, no compromise evidence | Stop signing; rotate from an approved trust root (not an unverifiable continuity claim); preserve public history | Existing valid signatures are `VERIFIED_HISTORICAL / LOST_PRIVATE_KEY_PUBLIC_HISTORY_VALID`; no new authority from lost key |
| Suspected/confirmed compromise | Immediately stop key; publish root-authorized revocation with `compromisedFrom` and scope; rotate | At/after compromise is `IDENTITY_REVOKED / KEY_COMPROMISED_AT_SIGNING`; policy may use `KEY_REVOKED_RETROACTIVELY` for all signatures |
| Public history/trust-root loss | Do not infer identity from artifacts or host account | `IDENTITY_UNVERIFIABLE / TRUST_ROOT_MISSING` or `IDENTITY_HISTORY_GAP` |

Revocation overrides retirement and cryptographic validity. Identity records themselves MUST use restricted JCS, explicit versions, monotonic history sequence, predecessor digest, and the identity/rotation domain. Backup restoration MUST prevent key/history rollback; uncertain rollback blocks signing. Public identity and revocation history MUST remain available for as long as protected evidence is retained.

<a id="vwa-semantic-capabilities"></a>
## Semantic capabilities

Capabilities constrain controller delegation to a bounded executor. They do not replace controller policy and are never bearer authority for a worker to call the host directly. The profile is `forgedock.capability/v1`; its signature input is `ASCII("FORGEDOCK\0CAPABILITY\0V1\0") || JCS_UTF8(capability without signature)`.

| Field | Requirement |
|---|---|
| `schema`, `suite`, `capabilityId`, `keyId` | Exact versions/suite; globally unique controller ID; signing key |
| `issuer` | Controller installation identity |
| `audience` | Exact executor instance/worker grant ID; wildcards forbidden |
| `repository`, `subject`, `runId` | Exact canonical bindings; no omitted/broader run |
| `action` | Exactly one action from the vocabulary below |
| `sha` | Exact lowercase full SHA for SHA-applicable actions; otherwise `null` |
| `constraints` | Object whose keys are registered for this action; empty object allowed |
| `notBefore`, `expiresAt` | UTC RFC 3339 seconds with `Z`; `notBefore < expiresAt`; maximum lifetime 15 minutes |
| `nonce` | 128-bit CSPRNG value encoded as 22-character unpadded Base64url; globally one-shot |
| `parentDigest`, `delegationDepth` | Parent capability digest or `null`; integer 0–2 |
| `signature` | Controller/delegator signature over all preceding fields |

Exact action vocabulary and SHA rules:

| Action | `sha` requirement |
|---|---|
| `artifact.publish` | Exact commit SHA when the artifact asserts code/review state; otherwise `null` |
| `branch.publish` | Exact commit SHA being published |
| `pull-request.create` | Exact proposed head SHA |
| `review.read` | Exact frozen PR head SHA |
| `review.record` | Exact reviewed PR head SHA |
| `merge.execute` | Exact reviewed and expected PR head SHA |
| `issue.close` | `null` |
| `issue.decompose` | `null` |
| `lease.acquire` | `null` |
| `lease.heartbeat` | `null` |
| `lease.release` | `null` |
| `bundle.export` | `null` |

Unknown actions MUST be denied. Registered constraints are: `expectedHostVersion`, `expectedHeadSha`, `expectedBaseSha`, `expectedLeaseFence`, `maxBytes`, `allowedPathPrefixes`, `requiredChecks`, and `mergeMethod`. Each has a typed action-specific schema; an unknown key, wrong type, or inapplicable constraint is `CAPABILITY_DENIED / CONSTRAINT_FAILED` (or `UNSUPPORTED_VERSION / CONSTRAINT_UNKNOWN` when the name is unknown), never ignored.

The controller MUST evaluate issuer, audience, bindings, action, exact SHA, constraints, lifecycle, and time immediately before use. Time comes from a monotonic deadline paired with an authenticated wall-clock sample. More than 30 seconds uncertainty/skew yields `CLOCK_UNCERTAIN`; there is no expiry grace. Consumption MUST atomically persist `(issuer, nonce, action, subject, runId)` before or in the same CAS transaction as the side effect. Crash uncertainty is treated as consumed until host read-back proves the idempotent result. A second use is `NONCE_CONSUMED`.

Delegation is optional and narrowing-only: a child MUST retain issuer/repository/subject/run/action, use a more specific audience, equal SHA, a validity interval inside the parent, constraints at least as restrictive, a fresh nonce, parent digest, and parent depth plus one. It cannot remove required checks, increase limits, widen paths, alter merge method, or exceed depth 2. The controller validates the complete parent chain. Any incomparable or broader child is denied. Only the controller or a controller-designated narrow signing service may sign; model processes never hold that key.

Presenting a capability to a worker or including one in an event does not grant direct host authority. The worker can return a proposal to the controller; the controller owns evaluation and mutation. Workers MUST NOT receive unrestricted mutation credentials.

<a id="vwa-subject-host"></a>
## Canonical subject identity and host conformance

### Identity normalization

A host adapter MUST first obtain the host's stable instance ID and immutable repository ID from an authenticated API; display names alone are insufficient. Canonical identities are:

```text
repository = "fdrepo:v1:" + pct(hostInstanceId) + ":" + pct(repositoryId)
subject    = repository + ":" + ("issue" | "pr") + ":" + shortestDecimal(number)
```

`hostInstanceId` is the adapter-declared immutable ID (for public GitHub, exactly `github.com`; for an enterprise instance, its API-reported immutable instance ID), lowercased only when the host declares it DNS-case-insensitive. `repositoryId` is the host's immutable opaque ID, not `owner/name`; decimal IDs use shortest decimal. `number` is positive. `pct` encodes UTF-8 bytes outside `[A-Za-z0-9._~-]` as uppercase `%HH`; literal `%` and `:` are encoded. Inputs MUST be valid NFC, and percent escapes are decoded once then re-encoded. Issue and PR are distinct even on hosts that share numbers. Owner/repository slug and URL are signed display evidence but MUST resolve to the same immutable IDs before use. Rename or transfer does not change canonical repository identity; instance/repository mismatch blocks the operation.

### Capability discovery

Before a dependent operation, the adapter MUST return and the controller MUST validate a signed or authenticated `forgedock.host-capabilities/v1` response containing `adapterName`, `adapterVersion`, `hostInstanceId`, `repositoryId`, `discoveredAt`, `expiresAt`, and booleans/details for `durablePublishReadBack`, `immutableFullHeadSha`, `reviewFreshRead`, `mergeExpectedHeadAtomic`, `coordinationCas`, `monotonicFence`, `eventCursor`, and documented size limits. Cache validity MUST NOT exceed 10 minutes. Unknown major, missing/contradictory fields, repository mismatch, stale response, or weaker behavior observed at run time blocks the operation.

| Operation | Minimum adapter guarantee | Required conformance evidence / failure |
|---|---|---|
| Protected artifact publication | Atomic create or idempotency key; exact-byte durable storage; immediate authoritative read-back; stable locator; explicit size limit | Contract test publishes, reads, compares digest, retries, and detects edit/delete. Absent read-back: `GUARANTEE_ABSENT` |
| Review | Immutable full PR-head SHA; fresh authenticated head read before and after review; diff/checks bound to that SHA | Fixture changes head between reads and invalidates verdict. Abbreviation/eventual-only read: `FRESHNESS_UNPROVABLE` |
| Merge | Atomic expected-head precondition, exact reviewed full SHA, required checks/policy read freshly | Race fixture proves changed head cannot merge. Check-then-merge without precondition is unsupported |
| Distributed coordination | Linearizable compare-and-swap on lease record and authoritative mutation precondition; monotonic fence retained/compared | Two-client stale-owner test. Missing CAS/fence: `CAS_UNAVAILABLE` |
| Event projection | Stable cursor or controller sequence persistence and duplicate-safe read | Gap/replay/unknown-event tests; this is not mutation authority |

GitHub remains durable semantic truth for the GitHub adapter, subject to verified read-back and the stated deletion limitation. Another host may conform through its adapter. Absence, contradiction, unknown data, or expiry MUST block the dependent operation and MUST NOT silently degrade. An explicitly configured `local-only` lease MAY coordinate processes sharing one transactional store, but MUST identify itself as non-distributed and cannot satisfy cross-machine guarantees.

<a id="vwa-events"></a>
## Workflow events

Events are reports of controller decisions and observations. The schema is `forgedock.workflow-event/v1` with: `eventId` (globally unique), `eventType` (registered string), `controllerId`, `controllerSequence` (shortest unsigned-64 decimal string, increasing by one per controller installation), `occurredAt` (UTC RFC 3339 seconds), canonical `repository` and `subject`, `runId`, `correlationId` (one command/workflow), `causationId` (prior event/command ID or `null`), `decisionArtifactDigest` (or `null` for observations), and typed `data`.

For one controller sequence defines total emission order; `causationId` defines causal edges across controllers/runs. Timestamps never override either. Duplicate `eventId` with identical canonical bytes is ignored after recording delivery; the same ID with different bytes is conflict. Consumers MUST checkpoint `(controllerId, controllerSequence, eventId)` atomically with projection updates, accept replay idempotently, buffer bounded out-of-order delivery, and stop/checkpoint as gapped when the next sequence is missing. They MUST rebuild projections by replay from a trusted checkpoint or verified artifacts rather than invent missing decisions.

Unknown major versions MUST be quarantined and stop that controller stream. Unknown `eventType` in a known major MUST be retained and skipped only by consumers declaring forward-compatible projection behavior; security/authority consumers MUST stop. Unknown event data fields MAY be retained but cannot affect authority.

Events MAY drive timelines, notifications, and rebuildable views. They MUST NOT carry a usable private key, grant/consume a capability, advance workflow state, acquire a lease, or authorize host mutation. Replaying an event only replays a report; the typed controller decision and verified artifact remain the semantic source.

<a id="vwa-leases"></a>
## Distributed leases and fencing

A distributed lease record is `(repository, subject, runId, ownerId, leaseId, fence, acquiredAt, heartbeatAt, expiresAt, version)`. `leaseId` is 128 CSPRNG bits; `fence` and `version` are unsigned 64-bit shortest decimal strings. The host's linearizable CAS service is the coordination authority; local SQLite mirrors are caches.

1. **Acquire:** read the authoritative record and host time. If absent or expired, CAS expected version/absence to a new owner, new lease ID, `fence = previous fence + 1` (or `1`), and bounded expiry. Read back exact record before work.
2. **Heartbeat:** before one-third of TTL elapses, CAS the exact owner/lease/fence/version to a later expiry and incremented version. It MUST NOT change fence. Failure or ambiguous timeout suspends side effects until read-back proves ownership.
3. **Expiry:** host authoritative time determines expiry. Client wall clocks are advisory. TTL MUST be at least three times measured worst-case API latency plus 30-second skew budget; uncertainty beyond budget blocks acquisition/mutation.
4. **Release:** CAS exact owner/lease/fence/version to a released tombstone retaining the fence. Release is idempotent only after read-back and never lowers/reuses a fence.
5. **Stale takeover:** only after authoritative expiry; use CAS and increment fence. The stale owner permanently loses even if it later resumes.

Every authoritative mutation during a lease MUST carry canonical subject/run, exact `expectedLeaseFence`, expected host object version/head where applicable, and a one-shot capability. The host adapter MUST atomically reject a lower/noncurrent fence in the same operation or an inseparable CAS transaction. Checking a lease and mutating later is insufficient.

If two owners appear current, equal fence has conflicting contents, sequence overflows, host reads disagree, or a partition makes ownership uncertain, state is `CONFLICT / SPLIT_BRAIN`: all affected side effects stop, evidence is surfaced, and controller reconciliation is required. Last writer does not win. A host without linearizable CAS and mutation fencing cannot claim distributed coordination; only explicitly labeled `local-only` coordination in one shared transactional store is permitted, with no cross-machine claim.

<a id="vwa-bundles"></a>
## Portable evidence bundles

A profile-1 bundle is one restricted-JCS document with `schema: "forgedock.bundle/v1"`, `suite`, canonical `bundleId`, `exportedAt`, `repository`, `subjects`, `manifest`, and `entries`. It is not a ZIP/tar file. Canonical bundle bytes are `JCS_UTF8(bundle without manifest.bundleDigest)`. `manifest.bundleDigest` is SHA-256 of those bytes; transport MAY compress only outside this format and decompressed bytes are subject to all limits.

Required entries are: manifest entry inventory (`type`, logical ID, digest, byte length); every protected envelope and semantic payload; explicit subject/run chain order and observed host locators; controller public identity/rotation/retirement/revocation history; trust-root references (not assumed trusted); and host read-back evidence/capability snapshot. Verified workflow events MAY be included as explicitly non-authoritative projection aids. Entries are arrays sorted by `(type, logicalId, digest)`; subjects and chains use canonical identity then run/sequence order. Logical IDs are protocol IDs, never filesystem paths.

Importers MUST reject duplicate JSON members, duplicate logical IDs with different bytes, duplicate manifest entries, digest/length mismatch, unknown major/suite, unsorted input, path-like IDs containing `..`, slash, backslash, NUL or absolute/drive prefixes, and trailing data. Parsers MUST enforce all of these limits before expensive cryptography:

- 64 MiB maximum canonical bundle bytes and 128 MiB maximum decompressed transport;
- 10,000 artifacts, 100,000 optional events, 1,024 identity records, 1,000 subjects/runs, and 120,000 total entries;
- 2 MiB per artifact/payload/event, 1 MiB per string, 64 object/array nesting depth, 100,000 object members, and 1,000,000 total array items;
- at most 16 signature/identity-chain verification steps per artifact and 100,000 signature checks total.

Bundles MUST exclude private keys/seeds, credentials/tokens/cookies, provider or GitHub App credentials, environment dumps, session files/transcripts, `forge.yaml` or other configuration, local database/worktree data, raw logs, prompts containing secrets, and unrestricted host responses. Exporters MUST use an allowlist, not redaction as the primary control.

Offline verification MUST validate deterministic bytes, every digest/signature/binding/chain, identity lifecycle at signing time, revocation, host evidence, duplicates and limits, and return the closed result per entry plus bundle completeness and explicit trust roots supplied/accepted/missing. It MUST distinguish cryptographic validity from trusted identity and host completeness. Network enrichment MAY be offered separately and recorded.

Import is fail-closed and transactional into a read-only archival namespace keyed by bundle digest. Invalid entries do not partially import. Imported data MUST NOT populate live artifact reconciliation, run state, controller identity/key stores, capability nonce stores, leases, event authority checkpoints, host caches used for mutation, or mutation queues. A user may inspect or compare it; it never becomes competing live authority.

<a id="vwa-compatibility"></a>
## Compatibility and operation matrix

“Proceed” below means at a **protected** gate. Existing software may continue an explicitly configured legacy-only workflow during migration, but MUST label it unprotected and MUST NOT claim this contract's guarantees.

| Observed set | Parse / trust label | Read, display, archival import | Publish / review / merge | Live reconciliation |
|---|---|---|---|---|
| Unwrapped `forgedock.artifact/v2` only | Parse if structural; `LEGACY_UNPROTECTED` | Yes, conspicuous unprotected label | No at protected gates; legacy policy only | Legacy reader may reconstruct with explicit warning; never protected authority |
| Protected-only, complete, active trusted identity | `VERIFIED_AUTHORITATIVE` | Yes | Yes only with fresh capability/host/lease operation gates | Yes, by verified sequence/predecessor, never timestamp |
| Protected-only, retired/lost private key history | `VERIFIED_HISTORICAL` | Yes | No current action | Audit reconstruction only |
| Mixed protected and legacy, no conflict | Each item keeps its own label; set is mixed | Yes, labels preserved | Only verified protected evidence may satisfy protected gate; legacy contributes no authority | Protected chain only; no silent upgrade |
| Mixed with semantic conflict | `CONFLICT / MIXED_TRUST_CONFLICT` | Display both and import archival | No | No timestamp/latest-kind resolution |
| Malformed/profile/limit failure | `MALFORMED` | Quarantine diagnostics; no normal import | No | No |
| Incomplete, gapped, or forked protected set | `INCOMPLETE_CHAIN` or `CONFLICT` | Read intact entries with warning; archival import if bundle itself valid and marked incomplete | No | No authoritative projection |
| Unknown/untrusted identity or algorithm | `IDENTITY_UNVERIFIABLE` or `UNSUPPORTED_VERSION` | Opaque/quarantined display; archival import only if safe parser understands container | No | No |
| Valid bytes but replayed ID/nonce/action | `REPLAYED` | Display duplicate/replay evidence | No | Coalesce identical display copy only; no decision |
| Known envelope with unsupported payload version | `UNSUPPORTED_VERSION / PAYLOAD_VERSION_UNKNOWN` | Envelope metadata only | No | No |
| Unsupported host guarantees | `HOST_UNSUPPORTED` | Existing evidence remains readable | Dependent operation no | Read-only projection only |

Malformed/unverifiable protected data MUST NOT cause fallback to a nearby legacy copy. Mixed input never inherits protection, and created timestamps, comment order, and “latest artifact of kind” never resolve protected conflicts.

<a id="vwa-limitations"></a>
## Security guarantees and prominent limitation

> **IMPORTANT — UNANCHORED FINAL-TAIL DELETION:** Signatures and predecessor chains detect unauthorized mutation, substitution, replay, forks, and gaps that are visible relative to an observed predecessor or external checkpoint. They **cannot prove that an unanchored final tail was never deleted**. If an attacker removes the last protected envelope(s) and no trusted later envelope, transparency checkpoint, independent receipt, or host audit anchor commits to that tail, the remaining prefix can still verify.

A protected chain is tamper evidence, not proof of host availability or completeness. Signatures prove that a key signed bytes; they do not prove the signer/controller was correct, uncompromised, policy-conformant, or that model-provided claims in a signed payload are true. Capabilities bound to actions do not prove an action succeeded. Leases reduce races only where host CAS/fencing conforms. Bundles preserve observed evidence, not live authority. Operators requiring stronger completeness MUST create independently retained signed tip checkpoints/receipts; absent a required anchor, result is `TAIL_ANCHOR_REQUIRED`.

<a id="vwa-test-vectors"></a>
## Fixed conformance vectors

All text below is ASCII unless noted. Implementations MUST copy bytes literally; code fences have no trailing newline in the value.

### C1 — restricted JCS and payload digest (positive)

Input JSON: `{ "b":2, "a":1 }`

Canonical UTF-8 bytes (13 bytes):

```text
{"a":1,"b":2}
```

Hex: `7b2261223a312c2262223a327d`

`SHA256(canonical bytes)` MUST be:

```text
43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777
```

Therefore `contentDigest` is `sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777`.

### C2 — Ed25519 primitive (positive, RFC 8032 test 1)

This validates the suite primitive independently of envelope construction.

```text
seed = 9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60
publicKey = d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a
message = (zero bytes)
signature = e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155
            5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b
result = valid
```

The signature is the concatenation of the two displayed signature lines (64 bytes). Protected envelopes never sign an empty message; they sign the domain plus canonical `signedView` exactly as specified above.

### C3 — JSON/profile negatives

| Mutation/input | Required result |
|---|---|
| `{"a":1,"a":1}` | `MALFORMED / DUPLICATE_MEMBER` |
| `{"a":1.0}` | `MALFORMED / JSON_PROFILE_VIOLATION` |
| UTF-8 BOM followed by `{}` | `MALFORMED / INVALID_UTF8` |
| string containing decomposed `e` + U+0301 | `MALFORMED / JSON_PROFILE_VIOLATION` (not silently normalized) |
| C1 with one byte changed from ASCII `2` to `3` while retaining C1 digest | `INVALID_CRYPTOGRAPHY / CONTENT_DIGEST_MISMATCH` |

### C4 — binding, chain, identity, and replay negatives

Starting from any otherwise valid protected fixture, make exactly the named mutation and re-sign only where stated:

| Mutation | Required result |
|---|---|
| Change request repository, subject, run ID, action, or reviewed SHA without changing envelope | respectively `REPOSITORY_MISMATCH`, `SUBJECT_MISMATCH`, `RUN_MISMATCH`, `ACTION_MISMATCH`, or `SHA_MISMATCH` under `BINDING_MISMATCH` |
| Remove sequence 4 while presenting 3 then 5 | `INCOMPLETE_CHAIN / SEQUENCE_GAP` |
| Present two correctly signed sequence-5 successors of sequence 4 | `CONFLICT / FORK_DETECTED` |
| Present identical envelope twice | second observation `REPLAYED / ENVELOPE_REPLAY`; display may coalesce |
| Reuse a consumed capability nonce | `REPLAYED / NONCE_CONSUMED` |
| Valid signature with absent trust root/key | `IDENTITY_UNVERIFIABLE / TRUST_ROOT_MISSING` or `KEY_UNKNOWN` as applicable |
| Valid signature made in a key's retirement-valid interval | `VERIFIED_HISTORICAL / RETIRED_KEY_VALID_AT_SIGNING` |
| Signature at/after `compromisedFrom` | `IDENTITY_REVOKED / KEY_COMPROMISED_AT_SIGNING` |
| Unknown constraint name | `UNSUPPORTED_VERSION / CONSTRAINT_UNKNOWN` |
| Mixed legacy copy conflicts with verified protected semantics | `CONFLICT / MIXED_TRUST_CONFLICT` |
| Delete the final envelope with no external tip anchor | remaining prefix may verify; report completeness limitation, and if policy requires anchor use `INCOMPLETE_CHAIN / TAIL_ANCHOR_REQUIRED` |

Whitespace and object-member reordering that canonicalize to C1 MUST retain C1's digest. Any mutation of canonical signed bytes without a new valid signature MUST be `SIGNATURE_INVALID` unless an earlier-precedence digest error applies.

<a id="vwa-rejected-alternatives"></a>
## Rejected alternatives

- **Global trust-score merge authority:** rejected because an aggregate score obscures exact intent, policy, evidence, and SHA gates. Only typed controller policy can decide merge.
- **Mandatory DID or UCAN:** rejected as a portability and deployment dependency. The profile has narrow controller identities/capabilities and may later map to DID/UCAN without requiring them.
- **Blockchain or mandatory external artifact storage:** rejected because host-native durable semantic records and portable offline bundles are sufficient for the baseline. External transparency/checkpoint services may strengthen tail completeness but are not required.
- **Model-held signing keys:** rejected because prompt injection or runtime compromise would become controller authority. Models never receive signing keys or unrestricted host credentials.
- **Last-write-wins comment locks:** rejected because comment order/editability is not atomic coordination and permits split brain. Distributed coordination requires host CAS plus monotonic fencing.

<a id="vwa-conformance-evidence"></a>
## Implementation evidence rule

A follow-on slice MUST link its authoritative issue to the exact anchors it implements and to executable conformance evidence. Prose, a checked box, a successful model response, or structural v2 tests are insufficient. The slice remains pending until positive/negative vectors, adapter race tests, and operation-specific fail-closed tests pass. The tracker is [`IMPLEMENTATION.md`](IMPLEMENTATION.md).
