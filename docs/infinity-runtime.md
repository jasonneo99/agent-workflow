# Suspend/resume runtime design

Status: initial local core slice. This document does not authorize live
self-repair, service activation, deployment, or a replacement for existing
workflow governance.

## Purpose

Agent Workflow needs to stop holding a process open while an agent waits for a
tool, build, approval, timer, child agent, or other external event. The
suspend/resume runtime models one agent as a durable thread and executes it in
bounded slices:

1. lease one stable input message for a thread;
2. load that thread's state and conversation;
3. run at most one model completion;
4. atomically persist the input, completed model turn, processed input ID, and
   optional pending tool dispatch;
5. end the slice without waiting for external work.

Any process with the same stores can later resume the thread. The first slice
uses in-memory stores so the ordering and transaction contract can be tested
before adding durable infrastructure.

## Boundaries

- This runtime is an execution layer beneath workflows. It does not replace
  project policy, approval decisions, executor verification/retry behavior,
  authority leases, or hash-chained action receipts.
- `run_notifications` remains the canonical outbound callback and approval
  outbox. The input queue introduced here is inbound resume delivery. The two
  must not be merged merely because both contain messages.
- DF-RESTART-01A continues to own originating-task callback delivery states,
  project isolation, retries, restart behavior, and true acknowledgment.
  Transport acceptance is not acknowledgment.
- An approval may resume a thread only after the canonical approval decision
  and its true acknowledgment have been recorded. The resume input uses a
  stable ID derived from that canonical event; it never infers approval from a
  transport exit or notification body.
- Live self-repair remains disabled. The runtime has no daemon activation,
  repair dispatch, provider, AWS, or deployment behavior.

## Core contracts

### Input queue

`ThreadInputQueue` provides per-thread FIFO leasing with explicit `ack` and
`nack`. Messages carry a stable `id`, destination `threadId`, typed `kind`,
payload, and creation time. Redelivery is expected. Queue delivery is not the
idempotency authority; the thread state store is.

The local queue serializes messages for a thread while allowing different
threads to lease and execute concurrently. A durable queue adapter is deferred
until the local lifecycle is accepted.

### Conversation and state stores

`ConversationStore` reads ordered conversation entries. `ThreadStateStore`
reads lifecycle state, revision, processed input IDs, and a pending tool
dispatch. `SliceStore` combines them with one atomic `commitSlice` operation.

The atomic boundary is mandatory: conversation entries and the processed input
ID must become visible together. Implementations that independently append a
conversation and later update idempotency state are invalid because a crash
between those writes can duplicate a model turn.

The initial `InMemorySliceStore` implements all three contracts with cloned
values and revision fencing. A later PostgreSQL adapter should transact these
records with the existing workflow run and receipt stores rather than create a
second source of workflow truth.

### Thread and slice lifecycle

A thread is `ready`, `running`, `suspended`, or `completed`. The initial runtime
uses `suspended` to mean that no model completion is consuming compute and the
thread is waiting for another input or for a pending tool dispatch to start.

`SuspendResumeRuntime.processNext(threadId)` is guarded by an in-process
per-thread lock. It first retries any committed pending dispatch, then leases
one input. Already processed IDs are acknowledged and skipped without calling
the model. For a new input it calls the model exactly once and rejects more
than one tool call. The completed turn is committed before external dispatch.

A failed dispatch remains in thread state. A later slice retries that stable
tool-call ID without rerunning the model. Tool-side idempotency and result
delivery are part of the next slice of implementation.

### Receipts

The core exposes a `SliceReceiptSink` and emits ordered facts for slice start,
atomic commit, duplicate skip, dispatch success/failure, and suspension. The
in-memory recorder is test evidence only. Executor integration must translate
these facts into the existing per-run hash-chained action receipts; it must not
introduce a parallel receipt chain.

## History representation

The first slice stores typed user input, tool results, assistant messages, and
assistant tool calls. Every entry has its own stable ID and the source input
ID. Synthetic tool calls for asynchronous event streams are deliberately not
implemented yet. Their next-step contract must:

- mark the assistant call as synthetic in typed metadata;
- preserve history order;
- reject a second result for an already answered tool call; and
- never disguise an event as user text.

## Failure and restart model

- A queue lease is acknowledged only after the slice commit succeeds.
- A model or commit failure nacks the input for redelivery.
- A dispatch failure does not rerun the model; the committed pending dispatch
  is retried by a later slice.
- Process affinity is absent from the interfaces. Restart correctness requires
  replacing the in-memory queue/store with durable adapters and is not claimed
  by this initial implementation.
- Revision fencing rejects stale commits within the local store. Distributed
  fencing will reuse Agent Workflow's existing lease/fencing mechanisms during
  executor integration.

## Initial integration point

The existing workflow executor remains authoritative. Integration should wrap
one provider/tool boundary at a time: construct a thread from the existing run
and stage identity, persist slice receipts through `recordRunAction`, and route
only canonical tool/approval results back into the input queue. The executor's
policy checks occur before tool dispatch and its verification/retry behavior
remains unchanged.

No executor source is changed in this first slice. That keeps the pluggable
runtime independently testable and avoids mixing the new scheduling model with
the active DF-RESTART and continuation work already present in the tree.

## Acceptance and measurements

This slice can prove bounded model calls, per-thread FIFO order, cross-thread
parallelism, atomic conversation/idempotency commits, redelivery skipping,
commit-before-dispatch, dispatch retry without model replay, and zero additional
model calls while suspended.

It cannot yet prove overnight approval resumption, restart recovery, durable
queue behavior, executor policy/receipt integration, or live memory at fleet
scale. Measurements must be taken from Agent Workflow's implementation and
reported with the adapter and sample size; external benchmark numbers are not
Agent Workflow targets.

## Next implementation slice

Add the asynchronous tool contract and synthetic event representation with
focused ordering and idempotency tests. That slice may proceed without owner
approval if it remains local and synthetic. PostgreSQL queue/store selection,
executor activation, service restart, deployment, or any live self-repair
requires a separate reviewed step under existing policy.
