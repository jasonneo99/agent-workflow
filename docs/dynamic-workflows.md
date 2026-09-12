# Dynamic workflows

Agent Workflow can construct a validated workflow DAG at runtime from a natural-language goal. The orchestrator chooses the closest reusable archetype, binds registered agents, routing tiers, context budgets, acceptance criteria, approval gates, and verification, then hashes the complete definition. The run stores that definition, its version and hash, the policy hash, and the construction rationale so replay does not depend on later registry changes.

Preview a deterministic plan without writing run state:

```bash
DEFAULT_MODEL_PROVIDER=mock npm run agentflow -- dynamic-plan \
  --project templates/project \
  --task "Create me a local web app that tracks release readiness" \
  --json
```

Queue the generated workflow against enterprise storage:

```bash
npm run agentflow -- dynamic-run \
  --project /path/to/project \
  --task "Create me a local web app that does X"
```

The reusable catalog includes web app, API service, data migration, failure debugging, security hardening, release, code review, documentation, model improvement, maintenance, and product discovery archetypes. Plans may add, remove, repeat, reorder, or parallelize stages, but validation rejects missing verification, invalid graph dependencies, policy-hash drift, missing agents, and attempts to remove mandatory controls. Project policy remains authoritative; a dynamic definition cannot expand command/write permissions or disable receipt and approval requirements.

## Durable handoffs

Every dependency edge creates a durable handoff packet with sender/receiver agents, source/destination stages, artifacts, a context summary, acceptance criteria, lifecycle timestamps, retry events, and receipt links. Handoffs move through `proposed`, `accepted`, `rejected`, `retrying`, and `completed`/`failed` states with validated transitions. The run JSON endpoint includes full handoff history. The existing workflow graph network view renders the packets on their actual dependency edges, including status, duration, artifacts, retries, and parallel branches while retaining horizontal, radial, and full-screen views.

## Learning boundary

Completed dynamic runs can produce evidence-backed recommendations to parallelize independent stages, remove redundant handoffs, strengthen acceptance criteria, add UX/test/security/approval coverage, or tune routing and context. Structural, permission, verification, and high-risk boundary changes remain review-only. Automatic application is limited to explicitly enabled, low-risk routing/context changes in project policy. Recurring shapes must enter an approved, versioned-template promotion path before becoming reusable defaults.

## Deployment

Run `npm run migrate-storage` before queueing dynamic workflows against an existing database. The migration is additive. Existing static definitions remain valid because dynamic DAG, routing, and acceptance fields are backward-compatible.

The enterprise Compose stack uses verified multi-architecture image references, including a dated MinIO release, with optional `AGENTFLOW_POSTGRES_IMAGE`, `AGENTFLOW_REDIS_IMAGE`, and `AGENTFLOW_MINIO_IMAGE` overrides documented in `.env.example`. If service startup fails after an intentional image upgrade, restore those verified values, run `docker compose -f infra/docker-compose.yml pull`, start the stack, and confirm it with `npm run doctor`.
