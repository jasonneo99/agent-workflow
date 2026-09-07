# Provider Matrix

Portable Agent Workflows keeps workflow and agent definitions provider-neutral. Runtime model behavior is selected by `DEFAULT_MODEL_PROVIDER`.

The recommended cost-control path is `local` for an on-machine runtime such as
Ollama, LM Studio, or llama.cpp-compatible servers. Use `byo` when the model
endpoint is remote, team-hosted, or an enterprise OpenAI-compatible gateway.
Kiro, Codex, OpenAI, and Bedrock are optional environments/adapters, not
requirements.

For copyable examples covering Ollama, LM Studio, vLLM, LiteLLM, OpenAI, Bedrock, Kiro, VS Code, Cursor, and Codex, see [Integration Examples](integration-examples.md).

## Providers

| Provider | Use when | Required config |
| --- | --- | --- |
| `auto` | Smart per-stage routing across configured providers | one or more configured providers |
| `mock` | Deterministic local workflow, CI, storage, and receipt testing | none |
| `local` | On-machine Ollama, LM Studio, or llama.cpp-compatible runtime | optional `LOCAL_MODEL_BASE_URL`, optional `LOCAL_MODEL_NAME`, optional `LOCAL_MODEL_API_KEY` |
| `byo` | Bring your own hosted or enterprise model gateway | `BYO_MODEL_BASE_URL`, optional `BYO_MODEL_NAME`, optional `BYO_MODEL_API_KEY` |
| `openai` | OpenAI Responses API execution | `OPENAI_API_KEY`, optional `OPENAI_MODEL` |
| `openai-compatible` | Legacy BYO-compatible env names | `OPENAI_COMPATIBLE_BASE_URL`, optional `OPENAI_COMPATIBLE_MODEL`, optional `OPENAI_COMPATIBLE_API_KEY` |
| `bedrock` | AWS Bedrock models | AWS credentials, optional `BEDROCK_MODEL`, `AWS_REGION` |
| `kiro` | Optional Kiro CLI adapter | Kiro CLI login or `KIRO_API_KEY`, optional `KIRO_AGENT` |

## Auto And Adaptive Routing

Set `DEFAULT_MODEL_PROVIDER=auto` when you want Agent Workflow to choose the provider per stage. The workflow or agent assigns a model tier (`fast`, `standard`, or `reasoning`) from the request shape, then auto routing checks configured providers and selects a ready provider for that tier. Bedrock is included only when the AWS credential chain works, so expired SSO sessions do not silently become the default route.

```env
DEFAULT_MODEL_PROVIDER=auto
AGENTFLOW_AUTO_PROVIDERS=local,byo,bedrock,openai,openai-compatible,kiro
AGENTFLOW_FALLBACK_PROVIDER=openai
AGENTFLOW_QUALITY_THRESHOLD=0.62
AGENTFLOW_MODEL_POLICY=best-coding
```

If `AGENTFLOW_AUTO_PROVIDERS` is omitted, the built-in order prefers local/BYO providers for cheaper stages, OpenAI for reasoning stages, and Bedrock whenever AWS credentials are valid. Preview the current tier routing:

```bash
npm run agentflow -- provider-use auto --check
```

Adaptive routing remains provider-neutral. If no per-tier provider is configured and `DEFAULT_MODEL_PROVIDER` is not `auto`, every stage uses `DEFAULT_MODEL_PROVIDER`. To save cost while preserving quality with explicit tier routing, route cheaper stages to local/BYO models and harder stages to stronger providers:

```env
DEFAULT_MODEL_PROVIDER=auto
AGENTFLOW_ROUTING_MODE=adaptive
AGENTFLOW_PROVIDER_FAST=local
AGENTFLOW_PROVIDER_STANDARD=local
AGENTFLOW_PROVIDER_REASONING=openai
AGENTFLOW_FALLBACK_PROVIDER=openai
AGENTFLOW_QUALITY_THRESHOLD=0.62
```

Per-tier model overrides are supported where the provider supports model names:

```env
LOCAL_MODEL_FAST=llama3.1:8b
LOCAL_MODEL_STANDARD=qwen2.5-coder:14b
LOCAL_MODEL_REASONING=deepseek-r1:32b

BYO_MODEL_FAST=llama3.1:8b
BYO_MODEL_STANDARD=qwen2.5-coder:14b
BYO_MODEL_REASONING=deepseek-r1:32b

OPENAI_MODEL=auto
OPENAI_MODEL_FAST=
OPENAI_MODEL_STANDARD=
OPENAI_MODEL_REASONING=

BEDROCK_MODEL=auto
BEDROCK_MODEL_FAST=
BEDROCK_MODEL_STANDARD=
BEDROCK_MODEL_REASONING=
```

For catalog-backed providers, `MODEL=auto` refreshes the provider model list
available to your key, profile, or local endpoint and selects tier models by
capability class. OpenAI uses `/v1/models`, BYO/OpenAI-compatible gateways use
their `/models` endpoint, and Bedrock uses `ListFoundationModels` for the
configured AWS region. This lets new model releases appear in the dashboard and
route selection without a package update. Pin per-tier model variables only
when you need exact run reproducibility.

`AGENTFLOW_MODEL_POLICY` controls how catalog-backed providers choose among
available models:

| Policy | Behavior |
| --- | --- |
| `lowest-cost` | Prefer efficient models wherever possible, even for many standard stages. |
| `balanced` | Prefer capable mid-cost models and reserve high-reasoning models for reasoning stages. |
| `best-coding` | Default for developer workflows; prefer code-specialized models for implementation stages. |
| `maximum-reasoning` | Prefer the strongest available models across tiers. |

Open `/model-catalog` in the dashboard when you want to inspect the live
selection logic. The page refreshes provider catalogs from configured OpenAI,
BYO/OpenAI-compatible, and Bedrock sources, then explains the fast, standard,
and reasoning choices with provider availability, override source, estimated
cost class, policy score, tier fit, and top ranked candidates. The matching JSON
endpoint is `/api/model-catalog`.

Each worker stage records a `model_route` receipt with the selected provider, requested tier, routed tier, estimated cost tier, latency, quality score, and fallback usage. Low-quality outputs can retry through `AGENTFLOW_FALLBACK_PROVIDER`.

When prior project feedback includes revised or rejected runs, Agent Workflow adds compact preference notes to the compiled brief and conservatively promotes fast stages to standard. The quality report shows both the requested tier and the routed tier so the tuning remains auditable.

The `/model-improvement` dashboard includes Local Provider Evidence for this
same route data. Use it before expanding local routing: it compares local/BYO
stage volume, fallback rate, feedback quality, latency, and avoided hosted calls
against hosted provider history for the selected project.

Switch the default provider stored in `.env`:

```bash
npm run agentflow -- provider-use byo --check
npm run agentflow -- provider-use openai --check
npm run agentflow -- provider-use kiro --check
npm run agentflow -- model-use OpenAI --check
```

Manual `.env` switching works too:

```env
DEFAULT_MODEL_PROVIDER=byo
BYO_MODEL_BASE_URL=http://localhost:11434/v1
BYO_MODEL_NAME=auto
BYO_MODEL_API_KEY=not-required
```

In any MCP-capable client, natural-language requests like these should route to `agentflow_provider_use`:

```text
Use Agent Workflow to update my model to BYO.
Use Agent Workflow to update my model to OpenAI.
Use Agent Workflow to update my model to Kiro.
```

## Mock

```bash
DEFAULT_MODEL_PROVIDER=mock npm run provider-check
DEFAULT_MODEL_PROVIDER=mock npm run smoke
```

The mock provider does not call a model. It is the default for CI-safe tests.

## OpenAI

```bash
DEFAULT_MODEL_PROVIDER=openai \
OPENAI_API_KEY=... \
OPENAI_MODEL=auto \
npm run provider-check
```

The OpenAI provider uses the Responses API with structured JSON schema output.
When `OPENAI_MODEL=auto`, provider checks and the Providers dashboard show the
current fast, standard, and reasoning model selections from the live catalog.

Run a one-stage provider contract smoke:

```bash
DEFAULT_MODEL_PROVIDER=openai npm run provider-smoke
```

## BYO

Use this for local models, hosted model gateways, enterprise routers, LiteLLM, vLLM, LM Studio, Ollama, and other OpenAI-compatible chat-completions endpoints.

There are two setup paths:

```bash
# Guided setup
npm run setup
```

Or manually add the provider to `.env`:

```bash
DEFAULT_MODEL_PROVIDER=byo
BYO_MODEL_BASE_URL=http://localhost:11434/v1
BYO_MODEL_NAME=auto
BYO_MODEL_API_KEY=not-required
```

Then verify it:

```bash
npm run provider-check
```

Run a one-stage provider contract smoke:

```bash
DEFAULT_MODEL_PROVIDER=byo \
BYO_MODEL_BASE_URL=http://localhost:11434/v1 \
BYO_MODEL_NAME=auto \
BYO_MODEL_API_KEY=local \
npm run provider-smoke
```

## OpenAI-Compatible

`openai-compatible` remains available for older installs. Prefer `byo` for new setups.

```bash
DEFAULT_MODEL_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 \
OPENAI_COMPATIBLE_MODEL=auto \
OPENAI_COMPATIBLE_API_KEY=not-required \
npm run provider-check
```

This provider uses the OpenAI chat-completions shape and requests `response_format: { "type": "json_object" }`.
`npm run provider-check` calls the endpoint's models API and shows the tier models selected from the catalog.

Examples:

```bash
# Ollama, when the selected model is available locally and the OpenAI-compatible endpoint is enabled.
DEFAULT_MODEL_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 \
OPENAI_COMPATIBLE_MODEL=auto \
OPENAI_COMPATIBLE_API_KEY=ollama \
npm run provider-check

# LM Studio or another local gateway.
DEFAULT_MODEL_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1 \
OPENAI_COMPATIBLE_MODEL=auto \
OPENAI_COMPATIBLE_API_KEY=local \
npm run provider-check
```

Not every OpenAI-compatible endpoint supports JSON mode equally. If a model wraps JSON in prose, the adapter attempts to extract the first JSON object. If the model cannot produce the required fields reliably, use `mock` for workflow tests or `openai` for strict structured output.

Run a one-stage provider contract smoke:

```bash
DEFAULT_MODEL_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 \
OPENAI_COMPATIBLE_MODEL=auto \
OPENAI_COMPATIBLE_API_KEY=local \
npm run provider-smoke
```

The provider smoke project allows no commands and no file writes. It verifies provider JSON contract behavior without giving the model local action privileges.

## Bedrock

```bash
DEFAULT_MODEL_PROVIDER=bedrock \
AWS_REGION=us-east-1 \
BEDROCK_MODEL=auto \
npm run provider-check
```

Bedrock uses the AWS SDK credential chain. If your credentials come from SSO, refresh them first:

```bash
aws sso login
```

Run a one-stage provider contract smoke:

```bash
DEFAULT_MODEL_PROVIDER=bedrock npm run provider-smoke
```

## Kiro

```bash
DEFAULT_MODEL_PROVIDER=kiro npm run provider-check
```

Kiro uses the supported Kiro CLI path:

- `KIRO_CLI_BIN` defaults to `kiro-cli`.
- `KIRO_API_KEY` enables Kiro headless mode for CI or unattended use.
- `KIRO_AGENT` optionally selects a Kiro custom agent.
- `KIRO_TIMEOUT_MS` defaults to ten minutes.

Install Kiro CLI:

```bash
curl -fsSL https://cli.kiro.dev/install | bash
```

Interactive auth:

```bash
kiro-cli login
DEFAULT_MODEL_PROVIDER=kiro npm run provider-check
```

Headless auth:

```bash
export KIRO_API_KEY=...
DEFAULT_MODEL_PROVIDER=kiro npm run provider-check
```

When Kiro cannot authenticate, Agent Workflow will ask you to run `kiro-cli login`, set `KIRO_API_KEY`, or switch back to OpenAI:

```bash
npm run agentflow -- provider-use openai --check
```

Switch `.env` to Kiro:

```bash
npm run agentflow -- provider-use kiro --check
```

Switch back to OpenAI:

```bash
npm run agentflow -- provider-use openai --check
```
