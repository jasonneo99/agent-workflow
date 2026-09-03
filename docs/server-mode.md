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
artifacts, and memory. Treat a clean manifest as the prerequisite evidence for
future merge execution.

Then prove the reviewed manifest can be imported without writing rows:

```bash
npm run agentflow -- storage-merge-import \
  --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url postgres://agentflow:agentflow@100.78.183.30:15432/agentflow
```

When the dry-run looks correct and both databases are backed up, the explicit
operator command is:

```bash
npm run agentflow -- storage-merge-import \
  --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url postgres://agentflow:agentflow@100.78.183.30:15432/agentflow \
  --execute
```

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
fallback health. Automatic background sync is planned separately so the default
open-source behavior stays explicit and auditable.

Record fallback intent and offline runs in the local sync queue:

```bash
npm run offline-fallback -- --record start-local --note "Hulk unavailable; use localhost storage"
npm run offline-fallback -- --record offline-run --project /path/to/project --run-id <run-id>
npm run offline-fallback -- --record sync-back --note "Merge localhost rows back to shared storage"
```

The Server page exposes the same queue with buttons to record local fallback,
record sync needed, and mark queue items synced after the merge manifest/import
path has completed.

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
- [x] Add a shared-storage host profile for LAN/Tailscale state-plane services.
- [x] Add a dry-run shared-storage migration and verification workflow.
- [ ] Require auth for all remaining mutation endpoints.
- [ ] Require role capability checks for all remaining mutation endpoints.
- [ ] Require idempotency keys for all remaining mutation endpoints.
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
