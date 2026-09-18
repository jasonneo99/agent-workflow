# Workflow Root-Repair Playbook

Agent Workflow repairs queue incidents from evidence. A visible status is a
symptom, not a diagnosis. The orchestrator and learning daemon use this order:

1. Reconcile the parent run with its authoritative child tasks. If every child
   is terminal, advance the parent through any required lifecycle states to the
   derived terminal status. Do not create replacement work for bookkeeping lag.
2. Search for a newer equivalent or lineage-linked completion. Preserve the
   immutable source history and dismiss only work proven to be superseded.
3. Confirm that a worker can resolve the project checkout before it claims the
   stage. A host that cannot access a checkout relinquishes it and excludes that
   project for the current sweep so an eligible host can claim it.
4. Separate external prerequisites from internal failures. Pending approval,
   missing permission, credentials, quota, or an explicit user decision must be
   surfaced; they are not cured by blind retries.
5. Verify provider recovery with one bounded real inference request. Login,
   process health, or credential presence alone does not prove inference works.
   Shared local CLI providers must serialize launches across processes.
6. Treat incomplete planning detail as a finding to carry forward unless it is
   a real prerequisite. Planning agents should not block implementation merely
   because the requested deliverable does not exist yet.
7. Create at most one idempotent repair for a lineage, preserve completed
   checkpoints, and follow it to a verified terminal result. Record the root
   cause class, evidence, repair action, verification, and recurrence guard.

## Durable repair classes

- `stale-parent-state`: derive the parent status from child tasks and reconcile
  it idempotently.
- `worker-project-unavailable`: check checkout availability before claim and
  let a compatible worker take the work.
- `provider-recovered` / `provider-inference-recovered`: gate replay on real
  inference and prevent blind provider-recovery loops.
- `provider-cli-contention`: serialize shared CLI launches and resolve the
  executable before workers spawn.
- `review-evidence-gap`: refresh governed project evidence and replay the same
  review contract with checkpoint lineage.
- `planning-deliverable-gap`: continue with the gap as a finding when no real
  external prerequisite exists.
- `build-feature` / `debug-failure`: require governed writes and executed
  verification for delivery, or diagnose the recorded causal failure.

Every terminal repair produces a `workflow_repair_learning` receipt and a
project-local memory item. Successful strategies are reinforced, unsuccessful
ones are marked to avoid blind repetition, and in-progress successors remain
under observation. Receipts contain portable classifications and evidence, not
credentials, host identities, private topology, or personal project data.
