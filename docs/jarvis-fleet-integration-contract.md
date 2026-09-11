# Jarvis ↔ Fleet Management Integration Contract

Version 1.0 defines the boundary between Jarvis Voice, Jarvis Orchestrator,
Agent Workflow, and Fleet Control. It does not deploy or enable a network
listener.

## Responsibilities

- Jarvis Voice captures intent and presents bounded status. It never converts
  natural language directly into a shell command.
- Jarvis Orchestrator resolves registered projects, workflows, and agents on
  the trusted Agent Workflow host.
- Agent Workflow enforces authentication, roles, project policy, approval
  gates, idempotency, Redis reservations, and durable receipts.
- Fleet Control remains a separate downstream boundary for signed, allowlisted
  host actions over the trusted fleet network.

## Operations

| Operation | Endpoint | Role | Boundary |
| --- | --- | --- | --- |
| Fleet health | `GET /api/server-readiness` | viewer | Bounded, redacted, read-only health |
| High-risk approval inbox | `GET /api/server-high-risk-approvals` | viewer | Authenticated, open high-risk cards, bounded redaction, no mutation |
| Submit work | `POST /api/server-queue` | requester | Registered project ID, allowlisted workflow, idempotency key, queue gate, receipt |
| Approval action | `POST /api/server-approval-action` | approver/executor | Ownership, role, separation of duties, policy recheck, Redis lease, receipt |
| Progress | `GET /api/runs` | viewer | Bridge-filtered project scope, bounded pagination, redaction |

The machine-readable contract is available from
`GET /api/jarvis-fleet-contract` and `agentflow jarvis-fleet-contract --json`.

## Envelope

Every Jarvis request carries a version, request ID, registered project ID,
operation, actor, actor role, client idempotency key, and UTC request time.
Raw shell commands, arbitrary filesystem paths, credentials, unbounded output,
and policy overrides are forbidden.

Fleet Management's existing `/workflow` bridge accepts `execute: false` for a
route-only canary and retains its existing execution behavior for deployed
Jarvis callers. Preview responses expose only status, resolved project/workflow,
route readiness, checks, and whether a run was queued.

## Approval Behavior

Low-risk work may enter the ordinary governed queue when its project policy and
server gates allow it. High-risk actions are shown to the user as approvals;
Jarvis must not infer approval from conversational context or decide them
automatically. Duplicate approval requests serialize through the shared Redis
lease and reuse durable receipts.

The read-only approval inbox returns approval and run IDs, registered project
identity, workflow/action context, bounded target and rationale text, risk
reasons, and a local dashboard path. It omits payloads, idempotency keys,
filesystem roots, and every decision or execution control.

## Rollout

1. Expose authenticated read-only health through the existing Heimdall bridge.
2. Canary queue preview with execution disabled and verify redaction.
3. Enable one low-risk idempotent workflow and verify execution plus replay.
4. Surface high-risk approvals in Jarvis without deciding them.
5. Canary one explicit decision and verify the Redis lease and receipts.
6. Keep Fleet Control execution separately signed and allowlisted.
