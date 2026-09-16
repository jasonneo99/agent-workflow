# Authoritative Workflow Run State

Agent Workflow persists one authoritative lifecycle for every run:

`queued -> leased -> running -> completed | blocked | failed | cancelled`

Only the storage transition function may change `workflow_runs.status`. It locks
the run row, validates the edge, increments `state_version`, writes an immutable
`workflow_run_transitions` row, and emits a `workflow_run_transition` receipt in
the same transaction. Repeating an idempotency key for the same target is a
no-op; reusing it for another target is rejected. Terminal states are immutable.

## Fencing and recovery

Every task claim increments the run's monotonic `lease_epoch`. The epoch is also
stored as the claimed task's fencing token. Stage start and terminal writes must
match both the task lease and the run's current `lease_owner`, `lease_epoch`, and
expiry. A restarted, expired, or superseded worker therefore cannot mutate the
run or publish a terminal task result.

Only one task in a run may be leased or running at a time. This deliberately
serializes mutation authority even when a worker pool processes many different
runs concurrently. Lease recovery requeues the expired task and clears run
ownership without moving the run backward. The next claim increments the epoch
again; a run already in `running` remains `running`.

Retries of `failed`, `blocked`, or `cancelled` runs create a new replay run.
They never rewrite the terminal run's audit history. Dismissal is audit metadata,
not another lifecycle state.

## Migration and rollback

`agentflow migrate-storage` adds the version and lease columns plus the
transition ledger. Existing `dismissed` run rows are mapped to `cancelled`, and
every existing run receives an idempotent same-state backfill event at version
zero. Existing API fields remain unchanged. Run-detail responses add optional
`stateVersion`, `leaseEpoch`, `leaseOwner`, and `leaseExpiresAt` fields; consumers
such as Jarvis may ignore them and should treat `leased` as active work.

Before rollout, back up PostgreSQL and run the migration once. Canary one
deterministic workflow and verify its transition receipts are ordered and its
final state is terminal. Rollback the application build if needed, but retain
the additive columns and ledger so historical evidence is not destroyed.
