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
tool-call ID without rerunning the model. `AsyncToolDispatcher` starts a tool
and returns after registration. Its bounded `emit` callback later places a
stable result or event ID on the thread queue; it does not keep a slice alive.

### Receipts

The core exposes a `SliceReceiptSink` and emits ordered facts for slice start,
atomic commit, duplicate skip, dispatch success/failure, and suspension. The
in-memory recorder is test evidence only. Executor integration must translate
these facts into the existing per-run hash-chained action receipts; it must not
introduce a parallel receipt chain.

## History representation

The runtime stores typed user input, tool results, assistant messages, and
assistant tool calls. Every entry has its own stable ID and the source input
ID. Asynchronous event streams use `tool_event` inputs. The runtime expands
each event into an assistant `async_event` tool call marked `synthetic: true`,
followed by exactly one result for that synthetic call. This contract:

- marks the assistant call as synthetic in typed metadata;
- preserves history order;
- rejects a second ordinary result for an already answered tool call; and
- never disguise an event as user text.

## Agent threads

`AgentThreadCoordinator.spawnThread` creates a child with an immutable parent
identity and sends the initial request only to the child queue. Child history
is never copied into the parent. `reportToParent` sends one explicit summary as
an inter-thread queue message. Both operations emit slice receipts.

## Failure and restart model

- A queue lease is acknowledged only after the slice commit succeeds.
- A model or commit failure nacks the input for redelivery.
- A dispatch failure does not rerun the model; the committed pending dispatch
  is retried by a later slice.
- `LocalJsonSliceStore` and `LocalJsonInputQueue` atomically replace mode-0600
  JSON snapshots. Reconstructing every runtime, queue and store object resumes
  saved threads and skips redelivery without a resident waiting process.
- The JSON adapters are intentionally local single-writer adapters. They prove
  restart behavior, not safe multi-process leasing. Production multi-worker
  operation must use the durable queue design below.
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

`GovernedRuntimeDispatcher` is the initial integration seam. Its authority port
runs before side effects, then selects either the existing executor or existing
approval outbox. Both receive the stable result-event identity that must resume
the thread. `ExistingReceiptChainSink` maps slice facts to the current receipt
writer rather than creating another chain. These ports allow surgical wiring
after the ongoing changes in those files settle.

`OriginCallbackBridge` enqueues through the existing `run_notifications`
outbox. It resumes a thread only when DF-RESTART-01A reports authenticated
originating-task acknowledgment. A successful transport process, accepted
queue write, or `delivered` transport state is deliberately insufficient.

## Durable queue decision

The production adapter should be PostgreSQL because Agent Workflow already
operates durable local PostgreSQL, fencing tokens, and transactional receipts.
It should add a dedicated inbound table, not reuse outbound
`run_notifications`:

- stable unique `(thread_id, input_id)` identity;
- FIFO sequence allocated transactionally per thread;
- `FOR UPDATE SKIP LOCKED` leasing with owner, fencing token, and expiry;
- atomic state/history commit plus input acknowledgment in one transaction;
- expired-lease recovery without treating transport acceptance as processing;
- project/run foreign keys and bounded payload sizes; and
- receipt insertion in the same transaction as the state transition.

This remains an inbound queue. `run_notifications` remains the outbound
callback and approval notification source of truth. AWS queues are neither a
dependency nor a deployment recommendation.

## Acceptance and measurements

The runtime now proves bounded model calls, per-thread FIFO order, cross-thread
parallelism, atomic conversation/idempotency commits, redelivery skipping,
commit-before-dispatch, dispatch retry without model replay, synthetic event
ordering, child-context isolation, local restart recovery, policy-before-side-
effect routing, receipt-chain compatibility, and zero additional model calls
while suspended.

It does not yet claim production multi-process queue leasing, live executor
activation, an overnight wall-clock soak, or live memory at fleet scale.
Measurements must be taken from Agent Workflow's implementation and reported
with the adapter and sample size; external benchmark numbers are not Agent
Workflow targets.

## Activation boundary

The bound-executor integration runs as a shadow canary by default. Set
`AGENTFLOW_SUSPEND_RESUME_CANARY=off` to roll back runtime recording while the
existing workflow executor continues unchanged. `authoritative` is a reserved
mode: it is only eligible after a real executor canary, both approval outcomes,
restart recovery, rollback, and receipt-chain verification pass independent
acceptance. The current scheduler remains authoritative until that promotion is
made explicitly.

The owner authorized local storage, executor, and service activation on October
25, 2026. The additive PostgreSQL inbound queue is installed, bound-executor
dispatches register stable runtime threads, executor outcomes enter the inbound
queue, and approval status changes emit stable synthetic events through a
database trigger. Policy, approvals, workflow lifecycle, and
`run_notifications` remain authoritative; this is a shadow canary and does not
replace workflow scheduling yet.

Promotion from shadow canary to authoritative scheduling requires clean live
PostgreSQL adapter tests through the application connection, an overnight
approval soak, and explicit rollback evidence. The live schema, fresh-database
bootstrap, restart recovery, competing-lease fencing, and approval trigger have
been validated locally. Activation remains shadow-only until the soak and
rollback gates are satisfied. Live self-repair remains paused.
