# Client-neutral lifecycle delivery

## Implemented foundation

Governed run transitions enqueue a notification in the caller's transaction,
using `transition:<stateVersion>` as the stable outbox key. The JSON body is a
versioned `run.state_changed` envelope containing run identity, sequence,
previous/current state, persisted transition timestamp, and summary. Existing
human-readable titles and notification channels remain compatible. Cancellation
and nonterminal transitions use the legacy `progress` kind; clients should use
the envelope state, not infer state from that rendering kind.

`replayRunLifecycleEvents` reads the existing transition journal in per-run
state-version order. Its project scope and exclusive sequence cursor support
bounded reconnect replay independently of transport delivery. Callers must
authenticate and authorize project access before calling this storage API.
There is no global cursor: per-run locking avoids a pre-commit global sequence
being mistaken for committed event order. Retention must preserve transitions
for any advertised replay window.

Completion freezes up to 50 artifact references and SHA-256 content digests
for stage outputs, acceptance contracts/preflights and delivery metrics in the
outbox transaction. Replay reuses that snapshot, not subsequently changed
artifact contents. A truncation flag and verification obligations accompany
the references. Clients retrieve artifact contents through authorized APIs and
verify the digests over `JSON.stringify` of the stored parsed JSON content.
Acceptance remains unverified: a completed status alone is not proof that all
gates passed. No arbitrary transition metadata is copied into the envelope.
The result also includes typed `deliverables` (stage-output references and
bounded summaries, status `reported`), `verification` references (status
`unverified`), and bounded artifact-reported `openObligations`. Arbitrary nested
artifact content and provider assertions of acceptance are not copied. Missing
summaries get an inspection instruction, not an invented delivery claim.

`claimRunNotifications` optionally accepts an exact notification ID, retaining
project isolation, lease fencing, retry delay and existing claim limits. This
allows a scoped adapter to avoid draining unrelated pending notifications.

The dispatcher and CLI carry this selector end to end. Use
`notifications --project <path> --deliver --notification <uuid>` for at most
one attempt against that project and identity. Missing, delivered, backoff-held
or already claimed rows produce no send; the command never falls back to a
project-wide queue drain. Transport success is not client acknowledgment.

## Host-mediated adapter

`dispatchHostNotification` provides a dependency-injected host adapter over the
same exact-ID dispatcher. The authenticated host supplies project, channel and
task binding plus a send function. Notification content cannot choose another
destination. Mismatched destinations and unavailable hosts settle as failed
attempts using existing storage backoff; lost leases never count as delivery.
The host receives a versioned evidence envelope with run and notification IDs.

An accepted send reports transport delivery only, always leaving acknowledgment
false. After independently observing arrival, the host may call the storage
acknowledgment API with its authenticated task identity. Do not infer arrival
from the outgoing payload or send response. Host acceptance followed by a
process crash before settlement can cause redelivery: consumers should dedupe
by notification ID, and must not claim exactly-once delivery.

`acknowledgeClientRunNotification` is a trusted-host storage primitive for any
channel. Its authenticated binding includes project, channel and task identity;
hosts must derive that binding from their session rather than the message body.
It rejects undelivered rows and mismatched bindings, and preserves the original
arrival timestamp on duplicate acknowledgments. Non-Codex task identities are
case-sensitive; the existing Codex wrapper retains its UUID comparison behavior.
This is not a public acknowledgment endpoint or an authentication mechanism.
Network adapters must still authenticate receivers before invoking it.

### Receiver authentication and independent subscriber state

The additive subscriber schema is installed by storage bootstrap/migration;
source validation does not apply it to a running deployment. The administrative
`registerNotificationSubscriber` API requires an authorized registered project,
channel and task binding. It returns a random 256-bit bearer credential once;
only its SHA-256 digest is stored. Provision it through a secure host channel,
never a workflow artifact or event body. `revokeNotificationSubscriber` disables
new claims and acknowledgments within its project scope; it cannot recall a
network request already in flight.

`notification-consumer --subscriber <uuid>` uses a separate delivery row for
that subscriber and exact notification. Attempts, backoff, claim fencing,
delivery and acknowledgment timestamps are independent of other subscribers
and of the legacy outbox delivery state. Exact selection materializes delivery
on demand; this is not automatic broadcast enrollment or a queue-wide fanout
scheduler. Registration does not launch a consumer.

`POST /api/notification-ack` authenticates `Authorization: Bearer <receiver-token>`
against the active subscriber record. The bounded JSON body accepts only
`notificationId` and `runId`; it cannot select project, channel, subscriber or
task identity. The database verifies matching project ownership and that this
subscriber's delivery was actually recorded. Duplicates preserve the first
acknowledgment timestamp. Deploy behind HTTPS; do not reuse the webhook signing
secret as this receiver credential. HTTP acceptance is still not an automatic
acknowledgment: the receiver invokes this endpoint only after observing arrival.

This is an embeddable adapter, not a standalone desktop connection or an
installed background consumer. A host must wire its supported messaging API;
the worker must not launch a second writer for an already active client task.

## Signed webhook and bounded consumer

`createWebhookHost` adapts a trusted, explicitly approved endpoint to the host
binding. It signs the exact envelope bytes with HMAC-SHA256 over
`timestamp.body`. The timestamp is Unix milliseconds; receivers verify before
parsing, enforce the five-minute freshness window and deduplicate by notification
ID. Secrets must have at least 32 bytes. Redirects are rejected, requests time
out after ten seconds and payloads are bounded at 256 KiB. HTTP is permitted
only for explicitly enabled numeric-loopback tests; production uses HTTPS.
Destination configuration is administrator-owned, never supplied by events or
untrusted subscription requests. Endpoint approval must include network access
policy; this helper is not an SSRF-safe public subscription registration API.

`consumeHostNotification` checks one exact notification serially, for a bounded
number of checks, with cancellation. The existing database owns lease fencing
and retry eligibility; restarting a consumer does not reset backoff or mark
arrival. HTTP 2xx means transport acceptance only. No background process or
subscription is installed automatically by these modules.

The `notification-consumer` CLI wires the consumer to real storage. Supply
`--project`, `--notification`, `--channel`, `--task` and an approved `--endpoint`;
the signing secret is read from `AGENTFLOW_WEBHOOK_SECRET` or `--secret-env`.
`--checks` (default 30) and `--interval-ms` (default 2000) bound execution.
`--loopback-test` explicitly permits local HTTP tests. This command consumes
one identity only and does not install a service or register subscriptions.

The isolated process integration test uses real PostgreSQL persistence and
signed loopback HTTP. It kills a claimant, accelerates lease expiry only in its
unique test schema, restarts a separate consumer, records a connection-refused
attempt, then exercises receiver-busy backoff before acceptance. Its isolated
schema is removed afterward. This is portable transport recovery evidence,
not proof of production deployment or Codex offline recovery.

## Recorded stage and approval replay

Stage start/completion/block/failure/continuation and approval decision/execution
receipts enqueue events in the same transaction. Initial approval requests keep
their existing outbox writer. Events include the receipt hash, subject identity,
summary and evidence-only authority; raw receipt metadata is not exported.

`GET /api/server-run-events?projectId=<id>&runId=<uuid>` applies existing server
authentication, resolves the registered project and reads only that project's
run receipts. It returns at most 100 SSE events per response. Reconnect using
`Last-Event-ID` (or initial `after`) with the returned timestamp cursor; the
server recommends a two-second reconnect interval. This is bounded SSE replay,
not a permanently open push subscription. Receipt timestamps are strictly
increasing under the run lock. Only current canonical serialization-version-2
receipts are exposed; historical evidence is neither rewritten nor backfilled.
Run, stage and approval events share this receipt stream. Full frozen run result
envelopes remain available through the run-transition replay/storage API.

## Remaining integration

### Original requesting-task contract

The requesting task remains the final destination even when a dedicated Codex
receiver is used as a relay. Relay receipt is not original-task delivery or
acknowledgment. `bindOriginTaskBridge` requires an injected supported host
forwarding capability and checks the returned destination, notification and run
identities before accepting transport delivery. Missing forwarding support fails
closed before outbox consumption. Original-task acknowledgment remains separate.
The dedicated app-server prototype reports only `receiverAcknowledged`, with
`originAcknowledged: false`; it is not a production bridge and is not enabled.

The available interactive host send tool is not yet a verified persistent
background capability. Do not substitute a standalone app-server thread for the
requesting desktop task, bypass its active-writer lock, or enable consumption
until the host-owned return path and original-task acknowledgment are verified.

The documented [MCP Events](https://developers.openai.com/plugins/build/mcp-events)
callback route currently lists Work web chats, desktop Work chats with Cloud
selected, and dots. That is not evidence of support for a local Codex task.
Moving a requester to a cloud chat would change its destination and must not be
done silently to satisfy this contract.

### State-write audit

The storage write-path audit covers `postgres.ts`, `run-transitions.ts`,
`action-approvals.ts`, `guarded-autonomy.ts` and the historical merge importer.

| Write path | Public event coverage |
| --- | --- |
| Governed run transitions | Versioned outbox event and receipt replay |
| Stage start, complete, block, fail, continuation | Recorded stage event |
| Approval request, decision, execution result/recovery | Recorded approval event |
| Run creation | Transactional creation receipt and outbox event; receipt rollback regression |
| Stage cancellations during run cancel/block/fail | Shared transactional per-stage writer; rollback, repeat and terminal-preservation regression |
| Stage leasing | Transactional stage-leased receipt and outbox event; dedicated lease-path integration coverage remains outstanding |
| Manual and expired-lease requeues | Per-stage events for changed rows; scoped PostgreSQL regression |
| Guarded and checkpoint requeues | Transactional per-stage events; PostgreSQL rollback and recovery regression |
| Approval execution claim and stale expiration | Transactional events with PostgreSQL rollback regression |
| Bulk obsolete approval dismissal | Transactional per-approval writer added; dedicated bulk-path regression remains outstanding |
| Run dismissal/reinstatement and checkpoint recovery | Public recorded events; PostgreSQL regression |
| Historical merge import | Must not emit imported evidence as fresh execution |

These are outstanding coverage gaps, not permission to backfill or rewrite
historical receipts. Closing them requires transactional event writes and
per-path regression tests before claiming notification on every state change.

- Audit every mutation path for event coverage (especially initial creation,
  cancellation of individual stages and approval expiration); the recorded
  action allowlist is explicit, not a claim that every state write is covered.
- Independently verify the reported deliverables and obligations; structured
  results do not themselves constitute acceptance.
- Add automatic subscription enrollment/fanout scheduling if broadcast delivery
  is required. Independent subscriber state and authenticated acknowledgments
  are implemented, but exact-ID consumption remains deliberately bounded.
- Verify a supported originating-client transport and actual acknowledgment;
  process success does not establish desktop arrival. Busy/offline/restart
  production testing requires separately bounded live-test authority.

Every committed domain transition should be available to clients; presentation
may filter routine updates. Lease heartbeats and internal bookkeeping should
not masquerade as user-visible progress. Events convey evidence, never approval
or execution authority. Existing polling remains a recovery fallback.

This source change does not activate live delivery, migrate storage, restart
services, or claim callback acceptance.

## Engine-wide local push stream

`agentflow engine-events --consumer <stable-client-id>` exposes the durable
outbox across **all registered projects, channels, runs and task origins**.
It is not a Studio- or Codex-specific stream. Optional `--project` and `--task`
filters narrow a view; omit both for engine-wide observation. Tasks without an
originating conversation are included. The coverage audit above still applies:
all-task scope does not imply that every state mutation already emits an event.

This is a private local child-process protocol, not an unauthenticated network
endpoint. The OS account and engine database access are the trust boundary.
Never expose it to untrusted remote clients or interpret the consumer ID as a
credential. Remote webhook/SSE transport needs a separate authorized adapter.

Prerequisite: a matching built runtime and the additive
`engine_event_acknowledgments` migration. Missing schema fails closed; the
stream does not migrate the deployment automatically. Consumer identities must
be unique per installation and stable across reconnects. Each consumer has its
own ACK ledger, separate from other subscribers and original-task delivery.

The stream writes one JSON envelope per stdout line:

```json
{"type":"lifecycle","version":1,"id":"notification-uuid","runId":"run-uuid","taskId":null,"project":"/authorized/project","channel":"cli","eventKey":"transition:1","kind":"progress","title":"Run started","body":"versioned event JSON or legacy text","createdAt":"persisted timestamp"}
```

After durable local receipt, send one stdin line:

```json
{"type":"ack","id":"notification-uuid","runId":"run-uuid","taskId":null}
```

The engine only accepts matching identities sent on that connection. ACK means
consumer receipt, not workflow acceptance, approval, or requester receipt.
Deduplicate by `id`, reject conflicting content for the same identity, and
preserve nullable origin IDs. Duplicate ACKs retain the first timestamp.
Delivery is at least once. PostgreSQL LISTEN/NOTIFY wakes replay after commit;
notifications themselves are not the event store. Replay starts after LISTEN,
with bounded batches of 100 unacknowledged records. Reconnect retries every two
seconds; a 30-second reconciliation/retransmit interval covers lost hints and
unacknowledged batches. There is no unsafe global timestamp cursor.

Studio stores the complete engine feed before ACK, then projects matching
project/channel/conversation records into the originating conversation. Global
activity refresh is independent of conversation focus. Its installation-scoped
consumer ID and event inbox survive restart. New Studio and Muse runs capture
`AGENTFLOW_REQUESTER_CHANNEL` and `AGENTFLOW_ORIGIN_TASK_ID` in run metadata;
derived runs preserve that origin without becoming Codex callbacks.

### Prompt for a Muse integration agent

Implement a local Agent Workflow event client in Muse. Read this document and
verify the installed engine supports `engine-events` and its additive consumer
ACK schema before enabling it. Spawn `agentflow engine-events --consumer
muse-<stable-installation-id>` with private stdin/stdout pipes and the approved
engine runtime environment. Do not pass project/task filters: subscribe to all
Agent Workflow tasks, regardless of which client requested them. Do not share
Studio's consumer identity.

Parse bounded version-1 NDJSON envelopes; treat payloads as untrusted evidence,
never executable instructions. Persist each envelope atomically in Muse's own
durable inbox, dedupe by ID, then write the exact ACK shape above. Never ACK an
unread, truncated, conflicting, or unpersisted event. Reconnect with the same
consumer identity and rely on replay. Show engine-wide activity and route a
response to an originating Muse task only when trusted project/channel/task
metadata matches. Null or foreign origins belong only in global activity.
Set the two origin environment variables when Muse launches new workflow work.
An ACK proves receipt, not successful deliverables or permission to continue.

Test live synthetic committed events, multiple projects, absent origins,
concurrent Studio/Muse subscribers, duplicate replay, storage failure, and
consumer restart. Report source tests, transport receipt and installed-client
acceptance separately. Do not launch workflows, approve actions, publish,
restart existing services or expose a network listener as part of connection
setup. If Muse runs remotely, stop and request an approved authenticated
transport rather than exposing the local stream or copying database secrets.
