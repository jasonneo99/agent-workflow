# Chat Mode

Chat Mode makes Agent Workflow behave like a conversational assistant instead of
a batch job queue: it works through problems on its own, and when it genuinely
cannot proceed, it asks *you* — the person who requested the run — in plain
language instead of parking the run in a queue nobody opens.

Four behaviors define it:

1. **Requester-aware runs.** Every run records who asked for it and how to reach
   them. Blocked runs and approval requests notify that requester instead of
   sitting silently.
2. **Self-healing.** Transient failures (stale file hashes, read races) retry
   with a fresh re-read before they ever block a run.
3. **Trusted-personal policy.** A built-in policy profile for a single trusted
   owner: ordinary dev work is pre-authorized; hard gates remain for
   push, deploy, external sends, spend, and deletes.
4. **Conversational permissions.** Approvals become a direct question to the
   requester; `approve`/`reject` resumes or cancels the run.

## Requester-aware runs

`run`, `dynamic-run`, and `agent-task` accept two flags:

```bash
npm run agentflow -- run my-workflow \
  --project /path/to/project \
  --task "Refactor the auth module" \
  --requester "Jason" \
  --requester-channel cli
```

When the flags are omitted, the CLI defaults sensibly:

| Source | Requester | Channel |
| --- | --- | --- |
| `AGENTFLOW_REQUESTER` env | its value | `AGENTFLOW_REQUESTER_CHANNEL` if set |
| `USER` / `LOGNAME` env | OS username | `cli` |
| `CODEX_THREAD_ID` env | OS username | `codex` |
| `AGENTFLOW_NOTIFY_COMMAND` env | OS username | `command` |
| none of the above | unset | `dashboard` |

The requester and channel are stored on the `workflow_runs` row
(`infra/init.sql`; existing databases pick the columns up through
`migrate-storage`, which runs the additive migration in
`packages/storage/src/postgres.ts`).

When a run blocks or an action approval is requested, the storage layer queues a
row in the `run_notifications` outbox (channel, kind, title, body) and emits a
Postgres `LISTEN/NOTIFY` on `agentflow_runtime_events`. Notification recording
never throws: a failure is logged and the workflow proceeds. Run
`agentflow migrate-storage` once on existing databases to create the
`run_notifications` table and the `requester` columns.

### Delivery

Delivery is intentionally separate from recording. The framework records the
*intent* to notify; a bridge performs the actual delivery. The daemon loop
drains the outbox each cycle via `deliverRunNotifications()`:

| Channel | Delivery |
| --- | --- |
| `codex` | Callback into the originating Codex thread (existing `deliverCodexWorkflowCallback`) |
| `command` (or any channel when a bridge is configured) | Pipes the notification JSON on stdin to `AGENTFLOW_NOTIFY_COMMAND` |
| `dashboard`, `cli` (no bridge configured) | Marked delivered; visible in the dashboard and via `agentflow notifications` |

The bundled bridge is `scripts/notify-requester.py`. It reads the notification
JSON from stdin and delivers through every backend it can:

1. **Phone push** via a deployment-supplied relay implementing
   `POST /mobile/notify` — active when both the relay URL and
   `AGENTFLOW_SERVER_TOKEN` are set.
2. **macOS Notification Center** on the machine running the daemon — always
   available, no secrets needed.

To wire it into the daemon, set the env var where the daemon gets its
environment (on macOS, the launchd plist's `EnvironmentVariables`):

```xml
<key>AGENTFLOW_NOTIFY_COMMAND</key>
<string>/path/to/agent-workflow/scripts/notify-requester.py</string>
```

then unload/reload the launchd job so the new environment takes effect. When
`AGENTFLOW_NOTIFY_COMMAND` is set, new runs default to the `command` channel so
notifications actually reach you instead of sitting in the dashboard. Every
bridge invocation is appended to `~/.agent-workflow/notify-bridge.log` for
debugging.

Delivered notifications are appended to the run's action receipts
(`action_type = "requester_notified"`) so the audit trail shows exactly what
the requester was told.

## Self-healing

File-mutation retries (stale preimage hashes from read races) use a dedicated
budget, separate from the verify-command budget:

- Default 4 retries, max 6, override with `AGENTFLOW_FILE_MUTATION_RETRY_BUDGET`.
- Each retry re-reads the file and re-attempts the mutation before the stage
  is allowed to block.

The verify-command budget (`AGENTFLOW_VERIFY_RETRY_BUDGET`, default 2, max 5)
is unchanged. Both are bounded: self-healing means the framework tries harder
on transient failures, not that it retries forever.

## Trusted-personal policy

The built-in `trusted-personal` profile is for a single trusted owner working
on their own machine. It pre-authorizes ordinary development work so runs stop
asking about routine steps:

- Autonomy level 3 (run local commands and tests), wide-open operation allowed.
- All write paths allowed except `.git/**`, `node_modules/**`, and `.env*`.
- Dev commands (`npm`, `git`, `node`, `npx`, `tsc`, `vitest`, and friends)
  pre-authorized.
- Approvals still required for external actions (push, deploy, outbound
  sends, spend); receipts required for everything.
- Blocked commands: `git push`, `git reset --hard`, `git clean -f`,
  destructive `git checkout`, `sudo`, and `rm -rf` outside scoped paths.

Select it per run or per project:

```bash
npm run agentflow -- run my-workflow --project /path/to/project \
  --task "..." --policy-profile trusted-personal
```

```yaml
# .agent-workflow/project.yaml
execution:
  policy_profile: trusted-personal
```

See [Autonomy Policy](autonomy.md) for the full profile list.

## Conversational permissions

When a run needs approval, the requester gets a notification (phone push,
Mac notification, Codex thread, or dashboard) and answers in plain words:

```bash
# list pending notifications
npm run agentflow -- notifications

# answer one, the way you would in chat
npm run agentflow -- reply <approval-id> approve
npm run agentflow -- reply <approval-id> reject --note "not yet, finish the tests first"
```

Approving decides the pending approval and resumes the blocked run
(`resumeBlockedRunAfterResolvedApprovals`); rejecting leaves the run parked.
The `approvals` command still works for the full queue view.

Studio uses this same reply contract. Run headers identify the requester and
channel, approval buttons post through the shared conversational reply handler,
and an approval reply resumes the saved run checkpoint. Studio does not
auto-approve and does not maintain a second approval path. Blocked runs without
an approval show the recorded blocker plus a specific response prompt; internal
source-discovery gaps retain the bounded automatic retry action.

Delivery status is lineage-aware. Verification-only continuations may reuse
governed file-write and successful command evidence from their recorded
`sourceRunId` ancestry, while the visible Changes and Tests panes remain scoped
to the selected run. Deduplicated retries redirect to the continuation that owns
the logical work instead of leaving the requester on stale immutable history.

Project registrations from another host path are canonicalized by the server
for selection. Physical consolidation is a separate, transactional storage
maintenance action: create a database backup first, merge conflicting indexed
file and memory keys, re-parent durable runs and performance baselines, and only
then remove the obsolete project row. This never deletes workflow history.

## Environment reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENTFLOW_REQUESTER` | `USER`/`LOGNAME` | Who is notified when a run blocks |
| `AGENTFLOW_REQUESTER_CHANNEL` | `cli` (`codex` with `CODEX_THREAD_ID`, `command` with `AGENTFLOW_NOTIFY_COMMAND`) | How the requester is reached |
| `AGENTFLOW_NOTIFY_COMMAND` | unset | Bridge executable receiving notification JSON on stdin; bundled: `scripts/notify-requester.py` (phone push + macOS notification) |
| `AGENTFLOW_SERVER_TOKEN` | unset | Bearer token enabling the phone-push backend in the bundled bridge |
| `AGENTFLOW_PUSH_RELAY_BASE_URL` | unset | Base URL of the phone-push relay (must expose `POST /mobile/notify`); when unset the bridge skips phone push |
| `AGENTFLOW_FILE_MUTATION_RETRY_BUDGET` | `4` (max `6`) | Stale-hash retry budget |
| `AGENTFLOW_VERIFY_RETRY_BUDGET` | `2` (max `5`) | Verify-command retry budget |

## Security boundaries

**Requester and actor strings are routing metadata, not authenticated
identities.** `requester`, `requester_channel`, and the `actor` recorded on
approval decisions exist so the framework can route notifications to the right
human and keep an audit trail. They are set from CLI flags and environment
variables, and anyone with local CLI access can supply any value. Do not treat
them as a security principal.

The actual authorization boundary for approvals is local machine access plus
knowledge of the unpredictable approval UUID: `decideActionApproval` only
transitions a `pending` approval, and the `reply` command resolves an approval
by its ID. This matches the threat model of a single-user personal machine.
On shared or networked deployments, put authentication in front of the
CLI/API; do not rely on requester strings.

**Notification `delivered` means handed to the bridge, not seen by the human.**
When the daemon drains the outbox, a notification is marked `delivered` once
the configured bridge executable exits 0 — i.e. it accepted the payload. That
confirms the phone-push relay or Notification Center received it, not that the
requester read it. Delivery receipts are transport evidence, not read receipts.

**The bundled bridge keeps no private infrastructure in the tree.**
`scripts/notify-requester.py` ships with no push-relay URL baked in; set
`AGENTFLOW_PUSH_RELAY_BASE_URL` (and `AGENTFLOW_SERVER_TOKEN`) in your deployment
environment. The bridge log records notification metadata (id, kind, truncated
title, delivery outcome) — never message bodies.


## Partner conversation interface

Partner is one conversation and composer. Useful work updates, blockers, next
steps and exact decisions appear inside the chat, with no separate activity,
queue-item or suggestion panels. Selecting work adds its chronological history
at that point in the conversation without granting action authority.

The work trail grows from recorded agent starts, file reads and writes, command
starts and results, stage outcomes and approval events. Each step can expand to
show its agent, stage, timestamp and bounded summary. A current, unexpired worker
lease drives the working indicator; historical starts never keep it spinning.
Completion retains the trail and is separate from acceptance. An unavailable
feed keeps existing steps and shows a reconnecting state.

The authenticated read-only history endpoint uses the owning project's existing
receipts. Stable event identities and timestamp/ID cursors prevent duplicates
across polling, pagination and reconnects. Pages hold 80 events, the browser keeps
the latest 400, and the run link exposes the preserved full history. Command
output bodies, source contents and approval payloads are not loaded by this
projection. Live observations never become user instructions or approval grants.

Recent chats and unfinished drafts are saved in the current browser. Storage is
bounded to eight conversations, 48 turns and 96,000 text characters per thread.
It is local history, not cross-device synchronization. If browser storage is
unavailable, the interface says so and retains the current tab's state. Starting
a new chat creates a new conversation identity and clears the previous selection
and decision. Reloading never resends an interrupted request.
Restored approval payloads are review-only: a fresh server proposal is required
before inline consent. If history trimming removes the full displayed action,
its inline approval control is also disabled.

The composer remains editable during a reply. Follow-ups are sent in order with
the settled conversation history, within the existing server context budget.
An unconfirmed result stops the unsent queue. An explicit retry retains the same
request body and idempotency key; it does not refund an uncertain execution claim.
Replies support text, lists, code and safe links through DOM text nodes. A saved
transcript is display/context data, never approval authority.

Two controls have different effects:

- **Stop waiting** aborts the browser's wait and ignores late replies. An action
  already sent may still finish; its recorded run is the source of truth.
- **Stop this run** requests cancellation of one explicitly selected active
  run through the existing owning-project controller and role checks. It leaves
  other queue items and history intact; in-flight commands may take time to stop.

An inline approval appears only with a complete displayed action, an unexpired
proposal, and matching conversation and selected run. Execution still rechecks
the live owning project, role, payload, receipt and one-use claim. An executed
instruction remains separate from acceptance of the requested product outcome.

Conversation replies continue through the registered Queue Partner agent and its
configured provider. The interface does not substitute a separate browser agent
or bypass Agent Workflow to perform work. Progress comes from recorded agent
activity; this version does not claim incremental model-token streaming.

## Repair admission and verification

Partner checks source ownership and executable behavioral test recipes before
reserving a repair worker. Discovering paths, allowing a whole project suite, or
passing a whitespace check does not grant a newly generated focused command.
`actions.verification_recipes` declares exact source paths, test paths, literal
commands and outputs. A declaration grants no permission: current command policy,
blocked patterns, interpreter approval and source mutation gates still apply.
The initial recipe format permits no project output paths; scoped commands use
disposable scratch and redirected Python caches. This is write containment, not
network, credential or read isolation. Recipe source and fixtures still need
substantive review. Native/device acceptance uses its separate governed paths.

A missing recipe or current baseline produces one `partner_recovery_admission`
approval tied to the original project, family, task digest, per-file manifest,
source hash, raw configuration hash and resolved policy hash. Concurrent unchanged
checks reuse it without another worker, receipt or notification. Its full payload
discloses persistent literal command additions and exact interpreter approval
rules. Applying it requires the usual attributed human decision, role/separation
checks, live execution claim, exact intent, idle family and intact receipt chain.
It does not change blocked patterns, source write paths, risk thresholds, retry
budgets, original acceptance, native authority or deployment permission.

An explicitly disclosed decision can tolerate another executed human-approved
recipe addition in the same project only through the exact configuration/policy
hash transition, applied artifact and verified receipt chain. Unrecorded edits,
foreign grants and source drift still require fresh review. If admission audit
recording fails, the executor restores its exact policy preimage when possible;
otherwise it preserves the uncertain outcome for explicit reconciliation.

Current-baseline ownership uses the existing immutable legacy enrollment and
checks the reviewed source hash again at capture. Historical continuity remains
unverified. Existing original contracts cannot be replaced through admission.
The coordinator records governed repair candidates, then uses a separate verifier
with the unchanged original requirements. An enrolled source does not start
another discovery actor. Source tests, native behavior, installed usability and
human acceptance remain distinct gates.

Declared unittest and Node recipes require complete collection evidence, at
least one passing executed case and zero skipped, cancelled or todo cases.
Unknown or truncated output is unverified even when the process exits zero.
Structured verification must reference every scoped recipe; a whitespace receipt
cannot substitute for the tests. Process exit and verification status are stored
separately in the executed command evidence.

When a response mixes reads with command or mutation requests, the next model
turn receives an explicit record of the requests that the read step did not
execute or queue. The model can restate or withdraw them after reviewing source;
the executor never silently carries stale effects forward. Existing executed
receipts, idempotency and retry limits still govern a restated request.

Resolving an approval preserves its decision and execution result even when a
managed run cannot use generic checkpoint recovery. That specific storage refusal
hands continuation back to the existing coordinator without replaying terminal
work. Unrelated storage errors still propagate.

An explicitly approved read-only assessment can further restrict its literal
command set and per-command timeout, including for a blocked predecessor. Those
bounds enter the fresh frozen child policy; the persistent project policy stays
unchanged. Invalid bounds, foreign tests and broader recipes fail closed.

For controlled rollout, local plan control may set `sourceRunIds` in normal mode.
It restricts new admissions to already-enrolled original sources and narrows
history reads. It grants no authority or cancellation, retains global ownership
and capacity checks, and excludes new dependency/interrupted-child recovery in
that restricted pass. Queue expansion follows inspection of the canary evidence.

Queue Partner answers short status questions directly from the current scoped
queue observation, without invoking a conversation provider or requesting a
workflow action. It reports recorded states and blockers while keeping product
acceptance separate. Each chat request shares one queue observation across its
read paths; action paths retain their owning-project and current-state checks.

Other questions receive complete structured queue evidence within the
conversation contract's per-turn limit. The selected item comes first, omitted
items are marked explicitly, and the bounded evidence turn retains up to four
prior conversation turns. A large queue cannot create an oversized history
message or cut a JSON record in half.
