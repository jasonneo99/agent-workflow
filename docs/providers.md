# Provider Matrix

Portable Agent Workflows keeps workflow and agent definitions provider-neutral. Runtime model behavior is selected by `DEFAULT_MODEL_PROVIDER`.

The recommended cost-control path is `local` for an on-machine runtime such as
Ollama, LM Studio, or llama.cpp-compatible servers. Use `byo` when the model
endpoint is remote, team-hosted, or an enterprise OpenAI-compatible gateway.
Kiro, Codex, OpenAI, and Bedrock are optional environments/adapters, not
requirements.

On macOS, Ollama can be made restart-durable without coupling it to the Agent
Workflow worker supervisor. Run `npm run local-model:launchd:install` after the
runtime is installed, then inspect the executable, service state, endpoint,
catalog, selected model, logs, and restart guidance with
`npm run local-model:status -- --json` or Runtime Monitor. The dedicated plist
runs a repository-owned wrapper that resolves the stable Homebrew executable on
every start, so upgrades do not pin a stale versioned path.
Non-secret local runtime selections may be kept in
`.agent-workflow/runtime.env`; the CLI and both LaunchAgent installers load it
after `.env`. Never put credentials in this file.
If an Ollama release cannot complete GPU discovery on a pre-release macOS
version, install the service with `OLLAMA_LLM_LIBRARY=cpu npm run
local-model:launchd:install` as a compatibility fallback. Re-test and remove the
override after upgrading Ollama because CPU inference is slower than Metal.

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

Use the local LLM setup checklist when a developer wants one focused readiness
answer instead of reading several panels:

```bash
npm run agentflow -- local-llm-checklist --project /path/to/project
```

The checklist verifies the localhost/OpenAI-compatible endpoint, the selected
catalog-backed tier models, auto-routing visibility, low-risk holdout
promotion, and whether at least one recent route receipt shows local routing was
actually selected. It also summarizes local smoke outcomes over time: total
smoke runs, first true local success, latest outcome, latest skipped/fallback or
failure reason, and the recommended model download or routing fix. The same
report is exposed on `/model-improvement` and
`/api/local-llm-checklist?project=/path/to/project`.

After setup looks close, run one low-risk smoke to create real route evidence:

```bash
npm run agentflow -- local-llm-smoke --project /path/to/project
```

The smoke queues a single `provider-smoke` fast-tier stage, runs only that
project-scoped stage, exports the run, and refreshes the checklist. It does not
approve local routing by itself; if local is not ready or not eligible, the
receipt explains whether local was skipped or a hosted provider was selected.

Use the guided setup action when you want Agent Workflow to inspect the common
local runtime ports and write a project-local setup report:

```bash
npm run agentflow -- local-llm-setup-guide --project /path/to/project --write
```

The guide probes Ollama, LM Studio, vLLM, llama.cpp server, and any configured
`LOCAL_MODEL_BASE_URL`. It writes only
`.agent-workflow/model-improvement/local-llm-setup-guide.*` unless the checklist
has healthy evidence and you pass `--approved --write`; only then can it add
`.agent-workflow/tuning/local-model-routing-note.*` as reviewed project-local
routing guidance. It never edits `.env`, shared workflows, reusable agents, or
project source.

For model-specific local download guidance, run:

```bash
npm run agentflow -- local-llm-download-recommendations --project /path/to/project --write
```

This combines detected hardware, the live local runtime catalog, recent project
task mix, smoke outcomes, and cost-savings goals into
`.agent-workflow/model-improvement/local-llm-download-recommendations.*`. It
recommends starter downloads and configuration hints, but it does not pull
models, edit provider settings, or promote local routing.

To turn those recommendations into a reviewed installation plan, run:

```bash
npm run agentflow -- local-llm-install-plan --project /path/to/project --write
npm run agentflow -- local-llm-install-plan --project /path/to/project --model qwen2.5-coder:7b --write
```

The plan writes Markdown, JSON, and a shell script under
`.agent-workflow/model-improvement/`. The script contains the exact download,
verification, and benchmark commands, but Agent Workflow does not execute it.
Downloads, provider-setting changes, and disk-heavy actions stay operator
approved.

Before downloading more models, inspect local cache and disk pressure:

```bash
npm run agentflow -- local-llm-inventory --project /path/to/project --write
```

The inventory checks common Ollama, LM Studio, Hugging Face, vLLM, and
llama.cpp cache roots, combines that with runtime catalog and recent
benchmark/route evidence, and writes
`.agent-workflow/model-improvement/local-llm-inventory.*`. It is read-only: it
does not delete model files or change provider settings.

When inventory flags stale unrecommended model cache entries, write a reviewed
cleanup plan before removing anything:

```bash
npm run agentflow -- local-llm-prune-plan --project /path/to/project --write
```

The prune plan writes `.agent-workflow/model-improvement/local-llm-prune-plan.*`
with explicit runtime/cache cleanup commands and reclaim estimates. It does not
execute deletes; run only the commands you intentionally approve.

To compare storage growth, prune decisions, and local-vs-hosted routing over
time, append compact trend snapshots:

```bash
npm run agentflow -- local-llm-cache-trends --project /path/to/project --write
```

Trend snapshots write `.agent-workflow/model-improvement/local-llm-cache-trends.*`
with aggregate cache, disk, prune, and route counts only. They avoid storing
model file contents, prompt text, or provider secrets.

To estimate savings from local routing, append cost ledger snapshots:

```bash
npm run agentflow -- local-llm-cost-ledger --project /path/to/project --write
```

The ledger writes `.agent-workflow/model-improvement/local-llm-cost-ledger.*`
with avoided hosted stage estimates, fallback cost, cache storage estimates,
benchmark latency, and net savings. The defaults are intentionally simple;
override them with `AGENTFLOW_COST_LEDGER_FAST_USD_PER_STAGE`,
`AGENTFLOW_COST_LEDGER_STANDARD_USD_PER_STAGE`,
`AGENTFLOW_COST_LEDGER_REASONING_USD_PER_STAGE`, and
`AGENTFLOW_COST_LEDGER_LOCAL_STORAGE_USD_PER_GB_MONTH` for your provider rates.

To decide where local routing should expand, hold, or retreat, generate
savings-aware routing recommendations:

```bash
npm run agentflow -- local-llm-routing-recommendations --project /path/to/project --write
```

The recommendation report writes
`.agent-workflow/model-improvement/local-llm-routing-recommendations.*` and uses
route receipts, quality, fallback rate, latency, cache pressure, and cost-ledger
evidence. Route-decision feedback from the dashboard drilldown also feeds this
score: repeated costly signals can block expansion or recommend retreat, while
repeated helpful signals can strengthen low-risk local trial candidates. The
same summarized signal appears on `/learning` so the daemon can prioritize
routing improvements across projects. It is advisory: it does not edit provider
settings, routing notes, or workflow definitions.

To turn expand/retreat recommendations into reviewable project-local routing
notes:

```bash
npm run agentflow -- local-llm-routing-note-plan --project /path/to/project --write
```

That writes `.agent-workflow/tuning/local-routing-note-plan.*`. It prepares
draft notes for `.agent-workflow/tuning/routing-preferences.md` but does not
modify live routing, provider settings, shared workflows, reusable agents, or
project source.

After reviewing the note plan, apply selected notes with an explicit approval:

```bash
npm run agentflow -- apply-local-llm-routing-note-plan --project /path/to/project --ids all --approved --write
```

The apply step appends selected notes to
`.agent-workflow/tuning/routing-preferences.md`, writes before/after hash
receipts to `.agent-workflow/tuning/local-routing-note-application.*`, and skips
already-applied notes.

The `/model-improvement` dashboard then surfaces **Applied Local Routing Notes**
with active preference markers, selected/applied/skipped ids, rollback guidance,
and before/after hashes.

It also shows **Model Routing Decision Timeline**, which links recommendations,
reviewed note plans, applied receipts, current fallback/quality evidence, and
estimated savings in one compact table.

Capture compact history for that timeline when you want before/after routing
evidence:

```bash
npm run agentflow -- local-llm-routing-decision-snapshot --project /path/to/project --write
```

The snapshot log lives in
`.agent-workflow/model-improvement/local-routing-decision-snapshots.*`, appends
only when the decision hash changes, and keeps prompts, model outputs, secrets,
and source content out of the persisted record.

After a recommended model is installed and listed by the runtime, collect small
local-only benchmark receipts:

```bash
npm run agentflow -- local-llm-benchmarks --project /path/to/project --write
npm run agentflow -- local-llm-benchmarks --project /path/to/project --execute --write
```

The first command writes the benchmark plan. The second sends tiny
summarization and code-review prompts to the local OpenAI-compatible endpoint
only, records latency and simple rubric scores, and writes
`.agent-workflow/model-improvement/local-llm-benchmark-receipts.*`. Hosted
models are not called by this benchmark.

After a local holdout loop starts, `/model-improvement` and
`/candidate-comparisons` also show Local Holdout Routing. Use that panel to see
whether captured results and promotion files are present, whether low-risk
local routing is approved, which holdout suites supplied evidence, whether the
promotion threshold block passed, and whether recent local routes are falling
back too often. Adaptive routing honors the project-local local route only when
the promotion is approved, the local endpoint is available, and the persisted
holdout thresholds still pass.

The same pages show **Local Route Decision Drilldown** for recent stages. It
turns route receipts into practical explanations for local-selected,
local-skipped, hosted-fallback, and hosted-selected outcomes, including the
threshold/readiness reason and next action for each workflow stage. Use the
row-level Helpful, Costly, and Neutral buttons to capture whether the routing
choice matched operator intent. The same signal can be recorded from the CLI:

```bash
npm run agentflow -- local-route-feedback \
  --project /path/to/project \
  --workflow build-feature \
  --stage verify \
  --agent auto-test-runner \
  --provider local \
  --tier fast \
  --class local-selected \
  --rating helpful \
  --note "fast and good enough for this verification pass"
```

Savings-aware local routing recommendations read those route-decision feedback
events before proposing expand, hold, or retreat changes. Repeated costly
feedback blocks expansion or recommends retreat for matching route groups,
while repeated helpful feedback can strengthen low-risk local trial candidates
when quality, fallback, and savings evidence are already acceptable.
That scoring logic lives in the model-provider package so CLI, dashboard, MCP,
and future daemon surfaces can share the same recommendation behavior.

Before raising local routing beyond low-risk read-only stages, generate a
local-vs-hosted holdout comparison plan. It reuses the existing private
model-improvement eval cases, defaults to `openai/standard` as the hosted
baseline and `local/fast` as the local candidate, and writes only project-local
Agent Workflow files when `--write` is used:

```bash
npm run agentflow -- model-improvement-plan --project /path/to/project --write
npm run agentflow -- local-holdout-comparison --project /path/to/project --write
npm run agentflow -- local-holdout-results --project /path/to/project --write
npm run agentflow -- local-holdout-promote --project /path/to/project --approved --write
```

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
