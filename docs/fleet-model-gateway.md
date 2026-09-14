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
