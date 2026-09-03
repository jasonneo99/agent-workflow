# Governed Server Mode

Agent Workflow is local-first by default. The normal developer workflow remains
CLI commands, MCP over stdio, the local dashboard, local workers, and local
enterprise storage.

Governed server mode is the future opt-in path for teams that want a shared
Agent Workflow runtime on a trusted network. This contract defines the boundary
before any remote workflow execution endpoint is added.

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
AGENTFLOW_SERVER_ALLOWED_ORIGINS=http://127.0.0.1:17888
```

Inspect the current posture without enabling server mode:

```bash
npm run server-readiness
npm run server-readiness -- --json
npm run server-projects
npm run server-projects -- --json
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

## Deployment Topologies

Local-only:

- Default for individual developers.
- CLI, MCP stdio, dashboard, worker, and storage run on one machine.
- No server-mode env vars required.

Single-developer LAN preview:

- Explicit server-mode opt-in.
- Token auth required.
- Registered projects only.
- Useful for testing mobile or another editor on the same trusted network.

Team shared runtime:

- Explicit server-mode opt-in.
- Reverse proxy with TLS and identity recommended.
- Registered project roots on the server host.
- Role enforcement enabled for approval and execution actions.
- Worker pools scoped by project.
- Backup readiness and restore drills run before adoption.

## Readiness Checklist

Before adding remote execution endpoints:

- [x] Add a read-only server-mode readiness command.
- [x] Add dashboard visibility for server bind, auth mode, project registration,
      and exposed endpoint classes.
- [x] Add registered-project previews that expose project ids without arbitrary
      path execution.
- [ ] Add project id based routing for future remote execution requests.
- [ ] Require auth for all mutation endpoints.
- [ ] Require role capability checks for all mutation endpoints.
- [ ] Require idempotency keys for all mutation endpoints.
- [ ] Record remote actor details in action receipts.
- [ ] Keep MCP stdio as the recommended IDE path for local use.
- [ ] Document reverse-proxy/TLS guidance without bundling internet-facing
      defaults.
