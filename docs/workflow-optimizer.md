# Workflow Optimizer And Shared-Brain Contracts

The workflow optimizer supplies provider-neutral primitives for event wakeups, project budgets, quiet hours, backpressure, duplicate suppression, explainable ranking, historical shadow simulation, auditable promotion/rollback/regression receipts, and bounded fleet health summaries.

Recommendations may cover stages, handoffs, context, routing, and evaluations. High-risk recommendations remain deferred for review and these contracts never grant new permissions.

Jarvis sends a versioned, non-executable intent envelope. Agent Workflow converts that intent into policy-checked plans and actions. Status responses contain bounded counts and summaries and explicitly exclude raw memory. Personal adapters and real Fleet topology live in the separately access-controlled private companion repository.

## Operational integration

- Daemon ticks ingest durable events derived from failed runs, reviewed route feedback, completed evaluations, stale approval pressure, and degraded fallback rates.
- Registered projects are ordered through the fairness scheduler before each fleet tick. Exhausted budgets, quiet hours, and backpressure remain hard scheduling gates.
- Ranked recommendations create persisted optimizer approval records. Low-risk items may be auto-approved; medium and high-risk behavior changes remain pending.
- `/learning` exposes the optimizer control plane. `/api/optimizer-status` returns its bounded JSON representation.
- Authenticated clients use `POST /api/server-shared-brain/intent` for non-executable previews and `GET /api/server-shared-brain/status` for privacy-safe state. Both fail closed without the configured server bearer token.

The integration canary covers ask, plan, execute, observe, approve, recover, and summarize paths as well as invalid authentication, expired signatures, non-allowlisted Fleet operations, and non-executable conversational intent.
