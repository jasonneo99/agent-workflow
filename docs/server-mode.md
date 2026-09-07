# Governed Server Mode

Agent Workflow is local-first by default. The normal developer workflow remains
CLI commands, MCP over stdio, the local dashboard, local workers, and local
enterprise storage.

Governed server mode is the future opt-in path for teams that want a shared
Agent Workflow runtime on a trusted network. This contract defines the boundary
before any remote workflow execution endpoint is added.

The recommended shared setup has two separate planes:

- Control plane: Agent Workflow CLI, MCP, dashboard, worker, and future
  authenticated HTTP endpoints.
- State plane: shared Postgres, Redis, and MinIO running on a trusted
  LAN/Tailscale host, such as a local machine named Hulk.

Client machines should not talk directly to the backing services unless they are
trusted developer machines with explicit environment configuration. Normal IDE
clients should continue to use MCP stdio or authenticated Agent Workflow
endpoints so project registration, policy, roles, idempotency, and receipts stay
in the loop.

## Goals

- Keep local developer setup simple and private by default.
- Allow a team-controlled Agent Workflow runtime to serve approved projects.
- Prevent arbitrary network callers from executing workflows, commands, file
  writes, or lifecycle actions.
- Preserve project-local policy, role checks, approval gates, idempotency, and
  audit receipts for every remote mutation.
- Avoid exposing Postgres, Redis, MinIO, provider credentials, or project files
  directly to the network.

## Non-Goals

- Hosted SaaS operation.
- A production product-agent runtime.
- Multi-tenant customer automation.
- Private product prompts, customer data, schemas, scoring rules, or domain
  policy.
- GPU training infrastructure, model registries, private datasets, or large
  model artifacts.

## Default Posture

Server mode must not be enabled by starting the dashboard with a different host
alone. Binding the dashboard to `0.0.0.0` is not the same thing as enabling a
shared workflow server.

Required opt-in controls:

```env
AGENTFLOW_SERVER_MODE=1
AGENTFLOW_SERVER_BIND=127.0.0.1
AGENTFLOW_SERVER_AUTH=token
AGENTFLOW_SERVER_TOKEN=...
AGENTFLOW_SERVER_ENABLE_QUEUE=0
AGENTFLOW_SERVER_ALLOWED_ORIGINS=http://127.0.0.1:17888
AGENTFLOW_SERVER_MAX_BODY_BYTES=64000
AGENTFLOW_SERVER_RATE_LIMIT_PER_MINUTE=60
```

Inspect the current posture without enabling server mode:

```bash
npm run server-readiness
npm run server-readiness -- --json
npm run server-projects
npm run server-projects -- --json
npm run server-resolve-project -- --project-id <project-id>
npm run server-request-preview -- --project-id <project-id> --workflow review-pr --task "Review the current changes"
npm run server-route-preview -- --project-id <project-id> --workflow review-pr --task "Review the current changes"
```

Recommended default binding stays loopback:

```env
AGENTFLOW_SERVER_BIND=127.0.0.1
```

LAN binding should require an explicit value and a visible readiness warning:

```env
AGENTFLOW_SERVER_BIND=0.0.0.0
```

## Authentication

No anonymous HTTP mutation endpoints should exist.

Supported auth shapes:

- Local bearer token for small trusted teams.
- OIDC-aware reverse proxy for teams that already have identity infrastructure.
- Read-only dashboard pages may stay unauthenticated only when bound to
  loopback.

Every authenticated request should resolve an actor:

```json
{
  "actor": "jason@example.com",
  "actorRole": "operator",
  "authMethod": "bearer-token",
  "requestId": "req_..."
}
```

Secrets must never be printed in the dashboard, CLI output, receipts, exports,
or logs. Provider keys remain in local environment/configuration owned by the
server operator.

## Project Registration

Remote requests must not accept arbitrary project paths.

Server mode should require explicit project registration:

```yaml
server:
  enabled: true
  projects:
    - id: truckoutfittersunlimited
      root: /Users/jasonmiller/Projects/truckoutfittersunlimited
      display_name: Truck Outfitters Unlimited
      policy_profile: local
```

Remote clients should reference project ids, not raw filesystem paths:

```json
{
  "projectId": "truckoutfittersunlimited",
  "workflow": "review-pr",
  "task": "Review the current changes"
}
```

The server must resolve the registered project root locally, load that
project's `.agent-workflow/project.yaml`, and reject unknown ids.

## Roles

Server mode should reuse project-local role definitions:

- `operator`: queues runs and executes approved local actions.
- `approver`: approves or rejects pending actions.
- `workflow_author`: reviews workflow and bundle definition changes.
- `auditor`: reads evidence, reports, receipts, and exports.

Remote mutation endpoints must check role capability before they check action
policy. Role checks do not replace project policy; they add a human governance
layer before policy and approval gates.

## Endpoint Classes

Read-only endpoints may expose safe summaries:

- provider readiness without secret values
- project registration status
- run status, queue status, and worker health
- artifacts metadata
- backup readiness
- bundle trust and compatibility
- workflow graphs
- role previews and audit summaries

Mutation endpoints require authentication, role checks, idempotency keys,
project policy rechecks, and receipts:

- queue workflow run
- run specialist agent
- run orchestrated task
- process worker batch
- recover expired leases
- approve or reject action
- execute approved action
- generate lifecycle plan
- write reviewed project-local plan files

Remote prune/delete remains unavailable until explicit destructive execution is
implemented and reviewed. Current lifecycle deletion behavior remains disabled
by default.

## Audit Receipts

Every remote mutation should record:

- actor and actor role
- auth method
- request id
- idempotency key
- source address or trusted proxy actor claim
- project id and resolved project root hash
- selected policy profile
- policy snapshot hash
- action payload hash
- approval id when applicable
- result status

Receipts must be enough for an auditor to answer: who requested it, who
approved it, what project policy was in force, what action was attempted, and
what happened.

## Network And Storage Boundaries

Do not expose backing services directly:

- Postgres should bind to localhost or a private container network.
- Redis should bind to localhost or a private container network.
- MinIO should bind to localhost or a private container network.
- Provider credentials stay in server-local `.env` or secret management.
- Project files are reachable only through registered project ids and governed
  actions.

For team use, place the Agent Workflow server behind a trusted reverse proxy
that handles TLS and identity. The project should document this as an operator
responsibility rather than shipping a broad internet-facing default.

## Reverse Proxy And TLS Guidance

Agent Workflow does not bundle an internet-facing deployment default. If a team
chooses to expose server mode beyond loopback, the recommended pattern is:

- Keep Agent Workflow bound to `127.0.0.1` or a private container network.
- Terminate TLS at a team-managed reverse proxy such as Cloudflare Access,
  Tailscale Funnel/Serve, Caddy, nginx, Traefik, or an internal ingress.
- Require identity at the proxy before traffic reaches Agent Workflow.
- Forward a stable actor claim, such as `x-agentflow-actor` or
  `x-forwarded-email`, only from the trusted proxy.
- Strip incoming client-supplied actor headers before adding trusted headers.
- Rate limit mutation endpoints and keep request body limits small.
- Keep Postgres, Redis, MinIO, provider keys, and project files off the public
  network.

OIDC-aware proxy mode expects the proxy to authenticate the user and forward an
actor header:

```env
AGENTFLOW_SERVER_AUTH=oidc-proxy
```

Bearer-token mode is appropriate only for small trusted local networks:

```env
AGENTFLOW_SERVER_AUTH=token
AGENTFLOW_SERVER_TOKEN=<long-random-token>
```

In both modes, real queueing should stay disabled until the operator has
reviewed registered projects, role policy, backups, and worker scope:

```env
AGENTFLOW_SERVER_ENABLE_QUEUE=0
```

## Deployment Topologies

Local-only:

- Default for individual developers.
- CLI, MCP stdio, dashboard, worker, and storage run on one machine.
- No server-mode env vars required.

IDE clients:

- Use MCP over stdio for Codex, VS Code, Cursor, and other local editors.
- Keep model/provider selection in the Agent Workflow `.env`, not in each
  editor prompt.
- Prefer `agentflow_run_and_watch`, `agentflow_agent_task`, and
  `agentflow_orchestrate` for local developer workflows.
- Use HTTP server mode only when a team intentionally wants a shared runtime
  with registered projects, auth, role checks, and audit receipts.

Single-developer LAN preview:

- Explicit server-mode opt-in.
- Token auth required.
- Registered projects only.
- Useful for testing mobile or another editor on the same trusted network.

Team shared runtime:

- Explicit server-mode opt-in.
- Reverse proxy with TLS and identity recommended.
- Registered project roots on the server host.
- Shared storage host for durable state, for example Postgres, Redis, and MinIO
  on a LAN/Tailscale machine such as Hulk.
- Client machines use connection strings only when intentionally configured as
  trusted operators; otherwise they call MCP stdio or authenticated Agent
  Workflow server endpoints.
- Role enforcement enabled for approval and execution actions.
- Worker pools scoped by project.
- Backup readiness and restore drills run before adoption.

Shared storage host:

- Run Postgres, Redis, and MinIO on a trusted LAN/Tailscale host.
- Keep service ports private to trusted machines or a private network.
- Use stable DNS or hostnames, for example a Tailscale MagicDNS name or IP,
  instead of hard-coded local LAN IPs. Confirm the chosen name reaches the
  storage ports; `.local` names may resolve to LAN addresses that are not
  serving Agent Workflow storage.
- Store local developer `.env` files with shared service URLs only on trusted
  clients.
- Run a storage migration dry-run before moving local history into shared
  storage.
- Verify migrated projects, runs, artifacts, approvals, receipts, memory, and
  index state before switching daily workflows to the shared host.

Plan the migration without copying data:

```bash
npm run storage-migrate -- --target-host 100.78.183.30
```

Write a reviewed operator package:

```bash
npm run storage-migrate -- --target-host 100.78.183.30 --write-plan
```

That writes Markdown, JSON, and a guarded shell script under
`.agent-workflow/migrations/`. The generated script exits unless
`AGENTFLOW_EXECUTE_STORAGE_MIGRATION=1` is set and still expects source/target
connection details to be supplied as environment variables. This keeps the open
source process dry-run-first and avoids committing secrets into migration files.

For repeated use, set the shared state-plane host once:

```bash
AGENTFLOW_SHARED_STORAGE_HOST=100.78.183.30
```

Then `npm run storage-migrate -- --write-plan` infers the target URLs from that
host unless explicit target URLs are supplied.
If source and target resolve to the same storage endpoints, the plan is blocked;
that usually means the current machine is already using the shared state plane.
If the target already contains Agent Workflow rows, `copy-empty-target` is also
blocked because restoring a full database dump could overwrite or collide with
newer shared history. Use merge preview instead:

```bash
npm run storage-migrate -- --mode merge-preview --write-plan
```

Merge preview is read-only. It compares durable table counts, sampled project
roots, and source/target differences, then writes a non-executing operator
package that describes the future merge-safe import path.

Before building or running any write-capable merge, generate a row-level merge
manifest:

```bash
npm run agentflow -- storage-merge-manifest \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url postgres://agentflow:agentflow@100.78.183.30:15432/agentflow \
  --write
```

The manifest is still read-only. It maps projects by `root_uri`, preserves
existing target project ids, classifies source-only rows, existing rows,
conflicts, and dependent rows that would need project-id rewriting across
projects, indexed files, index state, runs, tasks, receipts, approvals,
artifacts, and memory. It also reports legacy agent/workflow definition
references from historical runs and tasks:

- Missing source definitions that are not present in the target registry are
  insert-only candidates.
- Changed definitions with the same id keep the current target registry row;
  the importer does not downgrade or overwrite reusable bundle definitions.
- Unresolved historical references are shown as readability warnings so an
  operator can inspect run outputs, workflow snapshots, or artifacts.

Treat a clean manifest as the prerequisite evidence for future merge execution.

Then prove the reviewed manifest can be imported without writing rows:

```bash
npm run agentflow -- storage-merge-import \
  --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url postgres://agentflow:agentflow@100.78.183.30:15432/agentflow
```

When the dry-run looks correct, the explicit operator command is:

```bash
npm run agentflow -- storage-merge-import \
  --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url postgres://agentflow:agentflow@100.78.183.30:15432/agentflow \
  --execute
```

Execute mode creates source and target `pg_dump --format=custom` backups under
the migration output directory before any target write transaction begins. If
either dump fails or `pg_dump` is unavailable, the importer returns `blocked`
and inserts no rows. Each backup folder also includes `ROLLBACK.md` with
`pg_restore --clean --if-exists` guidance. Keep these dump files private because
they may contain project paths, run history, artifacts, approvals, and receipts.

The importer is insert-only. It imports missing source registry rows without
overwriting shared definitions, inserts source-only projects and history, maps
overlapping projects through `root_uri`, rewrites dependent project ids, and
skips existing/conflicting target rows.

After a merge, inspect local evidence:

```bash
npm run storage-merge-evidence
```

The dashboard Server page also shows Post-Merge Evidence with the latest merge
manifest, latest persisted import result when available, latest backup folder,
remaining source-only rows from the latest manifest, and whether the shared
storage plane is proven enough for normal primary use.

`storage-merge-evidence` also includes a switch-over proof checklist. It reads
the latest saved manifest, import result, backup folder, and object proof;
summarizes historical durable tables such as runs, artifacts, approvals,
receipts, memory, indexed files, and index state; shows representative row
samples from new merge manifests; classifies conflicts as canonical project
blockers, durable history blockers, or refreshable index/cache rows; and keeps
shared-primary status in attention when critical conflicts, unresolved legacy
definitions, stale imports, missing backups, or unrecorded object bucket parity
remain. Use
`object-artifact-proof --enumerate-buckets --verify --write` to persist object
bucket proof into the same migration evidence directory.
Non-blocking warnings, such as refreshable project index/cache conflicts or
approval lifecycle drift after matching durable run evidence has been preserved,
remain visible without preventing shared storage from being treated as the
primary state plane.

When the Server Readiness page reports the primary state plane as ready, treat
Hulk/shared storage as the normal Agent Workflow state plane. Local Docker
Postgres, Redis, and MinIO can stay stopped during normal work and should be
started only for explicit offline fallback. The Primary State Plane panel keeps
the operator summary short: shared host reachability, local fallback posture,
pending offline queue items, proof status, and any non-blocking warning evidence.

When the switch-over proof reports critical `projects` conflicts, inspect the
source and shared project records before deciding the canonical record:

```bash
npm run agentflow -- storage-project-conflicts \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url "$DATABASE_URL"
```

The project-conflict preview is read-only. It compares names, profiles, config
hashes, timestamps, and linked row counts, then emits an operator decision
record template such as preserve-target or manual-review.

After review, record the local migration-evidence decision without modifying
either database:

```bash
npm run agentflow -- storage-project-decision \
  --root /path/to/project \
  --action preserve-target-project \
  --source-project-id <source-id> \
  --target-project-id <target-id> \
  --note "Reviewed source/target metadata; shared target is canonical."
```

## Shared State Plane Proof

Server Readiness includes a read-only Shared State Plane roll-up that answers
the operator question before exposing server mode more broadly: is shared
storage ready to be treated as the primary state plane?

The roll-up combines:

- Hulk/shared storage reachability.
- Whether configured storage points at a shared, non-loopback host.
- Latest post-merge manifest, import, and backup evidence.
- Durable Postgres table count and fingerprint parity.
- Object-backed artifact proof and optional bucket enumeration.
- Offline fallback sync queue health.
- Local fallback posture.
- Server-mode bind, auth, and control readiness.

The dashboard exposes it on `/server-readiness`; the JSON API includes it as
`statePlaneProof`:

```bash
curl http://127.0.0.1:17888/api/server-readiness
```

The proof is intentionally read-only. It does not enable server mode, copy
objects, run a merge import, stop services, or expose mutation endpoints.

## Auth Hardening Checklist

The Server Readiness page includes an Auth Hardening panel that rolls the
server-mode controls into an operator checklist before shared use. The same
data appears in `/api/server-readiness` as `authHardening`.

The checklist reports:

- whether network exposure is paired with explicit server-mode opt-in
- whether bearer-token or OIDC-proxy auth is configured for remote mutation use
- whether browser origins are bounded for shared dashboard/API access
- whether clients can resolve registered project ids instead of filesystem paths
- whether role enforcement is ready for shared mutations
- whether remote mutation gates remain closed until reviewed

Local-only mode may show auth warnings because auth is not required for a
loopback developer workflow. Those warnings become blockers before remote
mutation endpoints are exposed on a shared network.

## Mutation Control Matrix

Before exposing any new server-mode mutation endpoint, inspect the shared
control matrix:

```bash
npm run agentflow -- server-mutation-controls
npm run agentflow -- server-mutation-controls --json
```

The same report appears on `/server-readiness` and at
`/api/server-mutation-controls`.

The matrix separates three surfaces:

- `read-only`: diagnostic endpoints that do not queue, approve, execute, copy,
  prune, or write state.
- `remote-mutation`: authenticated server-mode endpoints intended for shared
  runtimes. These must require registered project ids, role checks, explicit
  execution gates, client idempotency keys, and receipts.
- `local-mutation`: loopback dashboard or local operator actions. These are not
  remote server-mode APIs. If a team wants them remotely, add a dedicated
  governed endpoint instead of exposing the local dashboard POST route.

The initial governed remote mutation endpoint is `/api/server-queue`. It is
dry-run by default and queues work only when server mode is enabled, queue
execution is explicitly enabled, server auth accepts the request, the request
uses a registered `projectId`, the actor role passes checks, the client
provides an idempotency key, and the request body sets `execute=true`.

Successful queue mutations write a `server_queue_request` receipt. Repeated
requests with the same idempotency key reuse the existing workflow run.

Two lightweight server guardrails are enforced before queueing:

```env
AGENTFLOW_SERVER_MAX_BODY_BYTES=64000
AGENTFLOW_SERVER_RATE_LIMIT_PER_MINUTE=60
```

`AGENTFLOW_SERVER_MAX_BODY_BYTES` caps JSON mutation request bodies. The default
is intentionally small because remote clients should send a project id,
workflow id, task, actor, role, and idempotency key, not large source payloads.
`AGENTFLOW_SERVER_RATE_LIMIT_PER_MINUTE` applies to `/api/server-queue` per
actor/IP in the current process. Set it to a positive value for shared use; a
future multi-node server can replace this in-memory guard with a shared Redis
limiter.

`/api/server-approval-preview` is the matching dry-run contract for future
remote approval decisions and action execution. It accepts `projectId`,
`approvalId`, `decision`, `actor`, `actorRole`, and `idempotencyKey`, validates
them against registered project ids, role gates, separation-of-duties policy,
and approval policy rechecks, and records a redacted request-audit event. It is
preview-only; local dashboard forms, CLI approvals, and MCP approvals remain the
only mutation paths until a dedicated remote approval endpoint is reviewed.

Server queue requests also write a redacted append-only audit event:

```env
AGENTFLOW_SERVER_REQUEST_LOG=.agent-workflow/runtime/server/request-log.jsonl
```

The default path is local to the Agent Workflow checkout. Each JSONL row stores
request status, auth outcome, rate-limit decision, workflow id, project id, run
id when queued, and compact check statuses. It intentionally hashes actor,
task, idempotency key, client address, origin, user-agent, and local project
root values. Use this log to audit remote request behavior without retaining
prompt text, credentials, source payloads, or raw network identifiers.

Inspect the log:

```bash
npm run agentflow -- server-request-log
npm run agentflow -- server-request-log --json
curl http://127.0.0.1:17888/api/server-request-log
```

The same summary appears on `/server-readiness` and under
`requestAudit` in `/api/server-readiness`.

Inspect local runtime and shared-host health:

```bash
npm run runtime-monitor
npm run runtime-monitor -- --json
```

The runtime monitor checks the configured shared storage host, localhost
fallback storage ports, Docker availability, common local development ports,
and Agent Workflow dashboard/worker/learning/MCP processes. When
`AGENTFLOW_SHARED_STORAGE_HOST` is set, the shared host is labeled as the
Hulk/state-plane monitor in the dashboard; otherwise Agent Workflow derives the
host from configured service URLs. This is read-only monitoring and does not
start, stop, expose, or mutate services.

Preview stale Agent Workflow MCP cleanup candidates:

```bash
npm run runtime-monitor -- --cleanup-mcp
```

Terminate the previewed candidates only after review:

```bash
npm run runtime-monitor -- --cleanup-mcp --confirm
```

## Project Alias Merge Preview

Shared storage can collect the same project under different host paths, such as
a Linux path on Hulk and a macOS path on a developer machine. Agent Workflow
groups those rows into logical project identities and exposes a dry-run merge
plan before any consolidation is allowed.

Inspect the plan from the CLI:

```bash
npm run agentflow -- project-alias-merge-plan
npm run agentflow -- project-alias-merge-plan --json
```

Or open the dashboard:

```bash
open http://127.0.0.1:17888/projects
```

The plan is read-only. It picks a canonical target row, lists source aliases,
estimates affected workflow runs, indexed files, memory rows, and active runs,
then records preflight and rollback guidance. Actual merge execution remains a
separate operator step because project file rows, memory summaries, and run
history need backup, de-duplication, and receipts.

## Cross-Machine Project Roots

Shared storage intentionally preserves the project root recorded by the host
that created a run. A project may therefore appear as `/home/jasonmiller/...`
from Hulk and `/Users/jasonmiller/...` from a Mac. Before reading
`.agent-workflow/project.yaml`, executing approved local commands, writing
approved local files, or stale-checking selected source files, Agent Workflow
resolves the stored root to an available checkout on the current machine.

The common Linux-home to macOS-home mapping is detected automatically when the
target checkout exists. For custom mounts or team machines, set an explicit
prefix map:

```bash
AGENTFLOW_PROJECT_PATH_MAP=/home/jasonmiller/Projects=/Users/jasonmiller/Projects
```

This mapping is local runtime behavior only. It does not rewrite historical
`root_uri` rows in shared storage, so receipts and audits still show where the
run or approval was originally created.

The cleanup matcher is intentionally narrow: it only targets MCP processes that
point at this checkout's `apps/mcp/src/index.ts`. The dashboard exposes the same
flow in Runtime Monitor with per-PID checkboxes and a required confirmation
checkbox, so operators can leave any active session alone.

Inspect object-backed artifact proof:

```bash
npm run object-artifact-proof
npm run object-artifact-proof -- --verify
npm run object-artifact-proof -- --enumerate-buckets
npm run object-artifact-proof -- --enumerate-buckets --verify --write
```

The default report scans recent artifact rows for object-storage references in
artifact content. Verification uses MinIO Client (`mc`) when available and falls
back to Docker `minio/mc` when Docker is available. If neither verifier is
available, or credentials are missing, the report stays metadata-only or blocked
with a clear verifier status. Bucket enumeration uses the same verifier, compares
source and target object keys, and prints a dry-run mirror plan for any source
keys missing from the target bucket. Set `AGENTFLOW_MC_DOCKER_IMAGE` to override
the Docker image used for the fallback.

`npm run bootstrap-storage` also checks the configured object-storage bucket and
creates it with `mc mb --ignore-existing` through the same native-or-Docker
verifier path. This keeps a freshly migrated shared storage host ready for future
artifact writes even when no object-backed artifacts exist yet.

Queue the reviewed mirror plan as an approval:

```bash
npm run object-artifact-proof -- --project /path/to/project --enumerate-buckets --queue-mirror-approval
```

Then approve and execute the `object_mirror` approval:

```bash
npm run agentflow -- approvals --approve-execute <approval-id> --actor "Your Name" --actor-role approver
```

Mirror execution uses MinIO Client with `mc mirror --overwrite=false`, so it
copies missing source objects into the target bucket without replacing target
objects. Approval payloads store endpoints, bucket names, sampled missing keys,
and counts only; access keys and secret keys are read from environment variables
at execution time and are not stored in receipts. The Server Readiness dashboard
shows the same flow when bucket enumeration finds missing target objects.

### Offline Fallback

Shared storage can be the normal primary state plane while localhost Docker
services stay stopped. If the shared host is unavailable, inspect fallback
readiness:

```bash
npm run offline-fallback
```

The current fallback mode is operator-driven: start local services, point the
environment at localhost, run offline work, then sync back through
`storage-merge-manifest` and `storage-merge-import` when shared storage returns.
The Server page shows both configured shared-storage health and localhost
fallback health, plus runtime-monitor evidence for Hulk/shared storage, local
listeners, Docker, and Agent Workflow background processes.

Record fallback intent and offline runs in the local sync queue:

```bash
npm run offline-fallback -- --record start-local --note "Hulk unavailable; use localhost storage"
npm run offline-fallback -- --record offline-run --project /path/to/project --run-id <run-id>
npm run offline-fallback -- --record sync-back --note "Merge localhost rows back to shared storage"
```

The Server page exposes the same queue with buttons to record local fallback,
record sync needed, and mark queue items synced after the merge manifest/import
path has completed.

When both localhost fallback storage and shared storage are reachable, prepare a
merge dry run:

```bash
npm run offline-sync
npm run offline-sync -- --scheduler-check
```

After reviewing the generated manifest/import result, execute the insert-only
sync and mark pending fallback queue items synced:

```bash
npm run offline-sync -- --execute
```

The learning daemon also runs the scheduler check by default. It prepares a
dry-run when pending offline queue items exist, localhost fallback storage is
reachable, shared storage is reachable, and the last scheduler run is older than
the configured interval. Use `offline-sync -- --execute` or the Server page
Execute Sync button for manual execution. Operator-owned installs can opt into
automatic insert-only reconciliation with `learning-daemon --offline-sync-execute`
or `AGENTFLOW_OFFLINE_SYNC_AUTO_EXECUTE=1`. This still uses the guarded
manifest/import path, preserves existing shared rows, and records a sync receipt
before marking fallback queue items synced. Disable daemon checks with
`learning-daemon --disable-offline-sync`.

After a reviewed copy, verify durable state without mutating either side:

```bash
npm run storage-verify -- --target-host 100.78.183.30
```

The verifier compares service reachability plus durable table counts and compact
fingerprints for registry definitions, projects, indexed files, index state,
runs, tasks, receipts, approvals, artifacts, and memory items.
The dashboard also shows this report on `/server-readiness` under Shared
Storage Verification.

Generated operator packages from `storage-migrate --write-plan` also appear on
the Server Readiness page under Storage Migration Plans. The dashboard reads
`.agent-workflow/migrations/` by default, shows each plan's generated time,
blocked/ready status, warning count, markdown report, and guarded script path,
and exposes the same metadata at `/api/storage-migrations`.

## Readiness Checklist

Before adding remote execution endpoints:

- [x] Add a read-only server-mode readiness command.
- [x] Add dashboard visibility for server bind, auth mode, project registration,
      and exposed endpoint classes.
- [x] Add registered-project previews that expose project ids without arbitrary
      path execution.
- [x] Add project id resolution that rejects path-shaped input and resolves
      only registered project ids.
- [x] Add an authenticated request-envelope preview for future remote execution
      requests before implementing mutation endpoints.
- [x] Add a guarded project-id routing adapter behind the same preview checks,
      still dry-run-by-default.
- [x] Add an authenticated queueing endpoint after route previews are reviewed,
      with dry-run as the default and real queueing behind an explicit env gate.
- [x] Add a mutation-control matrix that audits remote mutation endpoints for
      auth, role checks, idempotency, execution gates, and receipts.
- [x] Add an Auth Hardening checklist to Server Readiness and JSON output so
      operators can see remaining server-mode blockers at a glance.
- [x] Add a shared-storage host profile for LAN/Tailscale state-plane services.
- [x] Add a dry-run shared-storage migration and verification workflow.
- [x] Require auth for currently implemented remote mutation endpoints.
- [x] Require role capability checks for currently implemented remote mutation
      endpoints.
- [x] Require idempotency keys for currently implemented remote mutation
      endpoints.
- [x] Record remote actor details in queue action receipts.
- [x] Keep MCP stdio as the recommended IDE path for local use.
- [x] Document reverse-proxy/TLS guidance without bundling internet-facing
      defaults.

## Local Verification Walkthrough

Start from the Agent Workflow repo with enterprise services running:

```bash
docker compose -f infra/docker-compose.yml up -d
npm run doctor
npm run bootstrap-storage
```

Inspect server-mode posture:

```bash
npm run server-readiness
```

Expected local-first result:

```text
Status: local-only
```

List registered project IDs without exposing local roots:

```bash
npm run server-projects
```

Grab one project ID for local testing:

```bash
PROJECT_ID=$(npm run -s server-projects -- --json | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const r=JSON.parse(s); process.stdout.write(r.projects[0]?.projectId || '');})")
echo "$PROJECT_ID"
```

Resolve that project ID without returning the root:

```bash
npm run server-resolve-project -- --project-id "$PROJECT_ID"
```

Preview a future request envelope:

```bash
npm run server-request-preview -- \
  --project-id "$PROJECT_ID" \
  --workflow review-pr \
  --task "Review the current changes" \
  --idempotency-key local-smoke-001
```

Preview the internal route without queueing work:

```bash
npm run server-route-preview -- \
  --project-id "$PROJECT_ID" \
  --workflow review-pr \
  --task "Review the current changes" \
  --idempotency-key local-smoke-001
```

Preview a future remote approval/action envelope without deciding or executing
the approval:

```bash
npm run server-approval-preview -- \
  --project-id "$PROJECT_ID" \
  --approval-id <approval-id> \
  --decision approve-and-execute \
  --actor local-smoke \
  --actor-role approver \
  --idempotency-key local-smoke-approval-001
```

The preview resolves the registered project id, verifies the approval belongs to
that project, checks the actor role for approve/reject/execute capability,
checks separation of duties for execution-like decisions, rechecks local command
or file-write policy when possible, and reports the auth/idempotency posture. It
does not approve, reject, execute, dismiss, or create an always-approve rule.

Preview the authenticated queue endpoint without queueing work:

```bash
curl -fsS -X POST http://127.0.0.1:17888/api/server-queue \
  -H "content-type: application/json" \
  -H "authorization: Bearer $AGENTFLOW_SERVER_TOKEN" \
  --data '{
    "projectId": "'$PROJECT_ID'",
    "workflow": "review-pr",
    "task": "Review the current changes",
    "actor": "local-smoke",
    "actorRole": "operator",
    "idempotencyKey": "local-smoke-queue-001"
  }'
```

Real queueing requires all of these to be true: `AGENTFLOW_SERVER_MODE=1`,
`AGENTFLOW_SERVER_ENABLE_QUEUE=1`, valid mutation auth, a registered project
id, a known workflow, a role with request capability, and a client-provided
idempotency key. Executed queue requests record actor, role, auth method,
project id, workflow id, and idempotency details as run receipts. Repeat
requests with the same idempotency key reuse the existing run.

Verify that path-shaped input is rejected:

```bash
npm run server-resolve-project -- --project-id ../templates/project
```

Expected result:

```text
Resolved: no
Reason: project id must not be a filesystem path
```

The preview commands may report `attention` while `AGENTFLOW_SERVER_MODE=0`.
That is correct: local-first mode is safe, but remote mutation endpoints would
require explicit server-mode opt-in and authentication.
