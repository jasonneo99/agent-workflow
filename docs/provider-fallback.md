# Durable Provider Fallback

Agent Workflow owns provider fallback inside the workflow engine. Assistant clients,
MCP callers, and dashboards submit one idempotent workflow request; they must not
retry prompts or choose replacement credentials themselves.

## Failure policy

Failures are classified as `provider_outage`, `rate_limited`,
`model_unavailable`, `authentication`, `account_quota`, `configuration`, or
`unknown`. Outages and rate limits receive a bounded retry. Model unavailability
advances to the next configured candidate. Authentication and configuration
failures stop immediately and are never silently routed.

Account quota exhaustion is a visible policy condition. It advances only when
`allowQuotaFallback` is explicitly true and the next candidate has both
`fleetApproved: true` and a non-empty `dataPolicy`. This proves policy intent; it
does not provision credentials or approve a new data processor.

```env
AGENTFLOW_PROVIDER_FALLBACK_POLICY={"chains":{"openai":[{"provider":"local","model":"example-model","fleetApproved":true,"dataPolicy":"private-local"},{"provider":"anthropic","fleetApproved":true,"dataPolicy":"approved-hosted"}]},"maxRetries":1,"circuitFailureThreshold":3,"circuitCooldownMs":60000,"allowQuotaFallback":false}
```

`AGENTFLOW_FALLBACK_PROVIDER` remains the compatibility setting for one quality
fallback provider. The JSON policy controls execution failures. Circuit state is
stored as metadata in `.agent-workflow/runtime/provider-circuits.json` by default;
it contains provider/model labels, failure counts, and timestamps, never prompts,
responses, credentials, or provider error bodies.

Every attempt has a deterministic SHA-256 identity bound to run ID, task ID,
provider, model, and bounded attempt number. Successful and failed `model_route`
receipts report the requested route, actual provider/model, classification,
fallback use, latency, and attempts. The same `StageExecutionInput` is reused for
every attempt, preserving the workflow task and downstream action idempotency
boundary.

## Assistant client contract

A compatible assistant calls the existing authenticated queue endpoint exactly
once per user intent:

```http
POST /api/server-queue
Authorization: Bearer <server token>
Content-Type: application/json

{
  "projectId": "<registered project id>",
  "workflow": "<allowed workflow id>",
  "task": "<bounded task text>",
  "actor": "<registered actor>",
  "actorRole": "<authorized role>",
  "idempotencyKey": "<stable client-generated key>",
  "execute": true
}
```

The caller retains the same idempotency key when reconnecting or checking the
result. Agent Workflow selects providers, applies retry/fallback policy, records
receipts, and exposes the provider actually used. Provider credentials, fleet
approval, and data-policy configuration remain operator-owned private settings.
