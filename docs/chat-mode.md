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

1. **Phone push** via Heimdall's `POST /mobile/notify` (APNs to your iOS
   devices) — active when `AGENTFLOW_SERVER_TOKEN` is set.
2. **macOS Notification Center** on the machine running the daemon — always
   available, no secrets needed.

To wire it into the daemon, set the env var where the daemon gets its
environment (on macOS, the launchd plist's `EnvironmentVariables`):

```xml
<key>AGENTFLOW_NOTIFY_COMMAND</key>
<string>/Users/jasonmiller/Projects/Agent Workflow/scripts/notify-requester.py</string>
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
| `JARVIS_HEIMDALL_BASE_URL` | unset | Base URL of the phone-push relay (must expose `POST /mobile/notify`); when unset the bridge skips phone push |
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
`JARVIS_HEIMDALL_BASE_URL` (and `AGENTFLOW_SERVER_TOKEN`) in your deployment
environment. The bridge log records notification metadata (id, kind, truncated
title, delivery outcome) — never message bodies.
