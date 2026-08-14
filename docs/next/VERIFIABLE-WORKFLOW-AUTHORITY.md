# Verifiable Workflow Authority

## Lease fencing and recovery (canonical contract)

Review gate validation: this contract addresses the finding reviewed at SHA
`e963e098d259375c1d693efc846e6c568bf7e5e7` and is validated against the
current target branch by the staging controller. Token-only local leases are
not an authority and are insufficient for recovery.

A lease has two independent proofs:

* `token` proves that the caller holds the current random ownership handle;
* `epoch` is a strictly increasing fencing generation authenticated by a
  retained checkpoint witness.

The witness is retained outside the rollbackable SQLite operational store. It
must verify a signed checkpoint, compare-and-advance monotonically before a
new or recovered lease is assigned, and support explicit higher-epoch
re-enrollment. A missing, malformed, invalid, divergent, or lower checkpoint
is not generation zero: it is `unverifiable`.

### Lifecycle

1. Verify the retained checkpoint before reading or changing a lease row.
2. For acquisition after expiry, advance the witness first, then persist the
   returned higher epoch in the SQLite row. A failed database commit consumes
   the epoch; it is never reused.
3. Restart and expired-row deletion preserve the SQLite maximum and cannot
   reset the witness sequence. A local row ahead of the witness is rollback or
   divergence and blocks the repository.
4. Re-enrollment is an authenticated operator/controller action accepting only
   a signed checkpoint strictly higher than the local maximum. It is never an
   automatic token refresh or inferred continuity.

### Fail-closed operation matrix

| Continuity | acquire | heartbeat | release | dependent mutation |
| --- | --- | --- | --- | --- |
| verified + current token | allowed | allowed | allowed | allowed after guard check |
| missing/invalid/divergent/rolled back | denied | denied | denied (row retained) | denied |
| valid higher re-enrollment | allowed with a still-higher epoch | allowed for the current lease | allowed for the current lease | allowed after a fresh guard check |

A release failure must not silently delete a lease. The typed continuity error
is retained for recovery status. Scheduler heartbeat failure aborts the worker
and suspends/blocks its dependents; no new dependent work is dispatched.

Every mutation-capable workflow receives a controller-owned `LeaseGuard` and
checks it immediately before run commits, workspace changes, artifact
appends, revision/PR publication, completion, and other dependent writes.
The UI, agent, random token, and SQLite row cannot authorize a transition or
write around this guard.

### Operations and retention

CLI and TUI repository factories require a configured retained witness and
fail explicitly when `FORGEDOCK_LEASE_WITNESS_PATH`,
`FORGEDOCK_LEASE_WITNESS_PUBLIC_KEY`, or
`FORGEDOCK_LEASE_WITNESS_PRIVATE_KEY` is absent or unusable. The checkpoint
file and verification key must be retained outside the SQLite backup/restore
scope, with restricted permissions and an operator-backed backup policy.
After suspected joint restore or checkpoint loss, stop coordination, inspect
recovery status, and perform signed higher-epoch re-enrollment before resuming.
Cross-machine/GitHub-backed coordination is not claimed; it remains a future
adapter behind the witness port.
