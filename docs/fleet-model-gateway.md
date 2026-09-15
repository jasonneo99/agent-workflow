# Fleet Model Gateway

The fleet model gateway is an authenticated OpenAI-compatible pass-through that
records token metadata without retaining prompt or response bodies. Run it on a
private, TLS-terminated network endpoint and point fleet clients at its `/v1`
base URL.

This is an optional portable service. Installing Agent Workflow does not start
it, change provider routing, open a listener, generate credentials, or enroll a
client. Operators must explicitly run the gateway command and supply its local
environment. Real host identities, network topology, TLS/ACL configuration,
credentials, client routing, and deployment receipts belong in a private
companion repository rather than this open-source project.

## Configuration

Keep all credentials outside Git:

```bash
export AGENTFLOW_MODEL_GATEWAY_UPSTREAM_URL="https://provider.example/v1"
export AGENTFLOW_MODEL_GATEWAY_UPSTREAM_API_KEY="..."
export AGENTFLOW_MODEL_GATEWAY_CLIENT_TOKENS='{"workstation-a":"...","worker-b":"..."}'
export AGENTFLOW_MODEL_GATEWAY_OBSERVER_TOKENS='{"dashboard":"..."}'
export AGENTFLOW_MODEL_GATEWAY_CLIENT_POLICIES='{"workstation-a":{"allowedModels":["example-model"],"requestsPerMinute":60,"dailyTokenBudget":1000000}}'
export AGENTFLOW_MODEL_GATEWAY_PRICING='{"example-model":{"inputPerMillionUsd":1,"outputPerMillionUsd":4}}'
export AGENTFLOW_MODEL_GATEWAY_HOST="127.0.0.1"
export AGENTFLOW_MODEL_GATEWAY_PORT="18080"
npm run model-gateway
```

Use one random token per fleet computer. Terminate TLS and authenticate network
membership before the gateway; never expose the default HTTP listener directly
to the public internet.

Clients may attach `x-agentflow-project`, `x-agentflow-workflow`,
`x-agentflow-run`, and `x-agentflow-stage`. Values are bounded metadata labels.
The ledger contains token counts, model, latency, status, client ID, and a SHA-256
request correlation hash salted by its random request ID. It never contains
request or response bodies or client tokens.

Requests and upstream responses are both size-bounded; responses default to a
25 MB limit configurable with `AGENTFLOW_MODEL_GATEWAY_MAX_RESPONSE_BYTES`.
Absolute-form request targets are rejected so a client cannot redirect the
configured upstream credential to another origin.

Authenticated clients can probe `/healthz`. Per-client policies can independently
restrict models, requests per minute, and daily tokens. The gateway rejects over-
budget or disallowed traffic before contacting the upstream provider. Optional
pricing produces estimates only; provider billing remains authoritative.

Native Agent Workflow provider calls are mirrored into the same ledger by
default, including retries, failures, and fallbacks. Set
`AGENTFLOW_FLEET_USAGE_DIRECT=false` only to opt out. Direct receipts contain
hashed project identity and bounded run metadata, never prompts or outputs.
Token totals are measured when the provider adapter returns usage; configured
model pricing produces estimates only.

Agent Workflow includes dated default estimates for its active GPT-5.6 and
Claude model routes. `AGENTFLOW_MODEL_GATEWAY_PRICING` overrides individual
model entries when provider prices or negotiated rates differ. The dashboard
labels these values as estimates; provider invoices remain authoritative.

## Authoritative fleet reporting

The gateway host can be the authoritative usage source without sharing or
mounting its raw JSONL ledger. Configure a separate observer token and let
dashboards read:

```http
GET /_agentflow/usage/summary?limit=100&since=2026-01-01T00:00:00.000Z
Authorization: Bearer <observer token>
```

The summary returns fleet-wide totals for the requested time window plus at
most 500 recent metadata-only receipts. Observer credentials cannot proxy model
calls or upload node receipts. Configure a dashboard with the exact private
endpoint and its observer credential:

```bash
export AGENTFLOW_FLEET_USAGE_SUMMARY_URL="https://private-gateway.example/_agentflow/usage/summary"
export AGENTFLOW_FLEET_USAGE_SUMMARY_TOKEN="..."
```

The dashboard labels the authoritative source explicitly. If it is unavailable,
the dashboard visibly falls back to its local ledger rather than presenting
local data as fleet-wide data.

Local inference and temporarily offline nodes can upload batches of no more
than 100 receipts using their existing per-node token:

```http
POST /_agentflow/usage/receipts
Authorization: Bearer <node token>
Content-Type: application/json

{"receipts":[{"version":1,"id":"<stable receipt id>","observedAt":"<ISO timestamp>","clientId":"<authenticated node id>","provider":"local","inputTokens":0,"cachedInputTokens":0,"reasoningTokens":0,"outputTokens":0,"totalTokens":0,"latencyMs":0,"status":"completed","requestHash":"<correlation hash>"}]}
```

The authenticated node identity must exactly match every receipt. Stable
receipt IDs make repeated delivery idempotent. Requests, labels, numeric fields,
body size, and batch size are validated before any ledger append.

```bash
npm run model-gateway:report
```

Offline clients can retain the same metadata-only JSON or JSONL receipts and
import them idempotently after reconnecting:

```bash
npm run model-gateway:import -- ./offline-usage.jsonl
```

The report is fleet-observed usage. Reconcile it with provider billing because
calls that bypass the gateway cannot be observed. Keep local-model or direct
provider fallback available for outages and import its metadata receipts after
connectivity returns.
