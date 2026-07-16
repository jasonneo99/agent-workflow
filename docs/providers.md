# Provider Matrix

Portable Agent Workflows keeps workflow and agent definitions provider-neutral. Runtime model behavior is selected by `DEFAULT_MODEL_PROVIDER`.

## Providers

| Provider | Use when | Required config |
| --- | --- | --- |
| `mock` | Deterministic local workflow, CI, storage, and receipt testing | none |
| `openai` | OpenAI Responses API execution | `OPENAI_API_KEY`, optional `OPENAI_MODEL` |
| `openai-compatible` | Local/self-hosted/OpenAI-compatible chat-completions APIs | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL`, optional `OPENAI_COMPATIBLE_API_KEY` |

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
OPENAI_MODEL=gpt-5.5 \
npm run provider-check
```

The OpenAI provider uses the Responses API with structured JSON schema output.

## OpenAI-Compatible

```bash
DEFAULT_MODEL_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 \
OPENAI_COMPATIBLE_MODEL=<model-name> \
OPENAI_COMPATIBLE_API_KEY=not-required \
npm run provider-check
```

This provider uses the OpenAI chat-completions shape and requests `response_format: { "type": "json_object" }`.
`npm run provider-check` calls the endpoint's models API and verifies that `OPENAI_COMPATIBLE_MODEL` is listed.

Examples:

```bash
# Ollama, when the selected model is available locally and the OpenAI-compatible endpoint is enabled.
DEFAULT_MODEL_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 \
OPENAI_COMPATIBLE_MODEL=llama3.1 \
OPENAI_COMPATIBLE_API_KEY=ollama \
npm run provider-check

# LM Studio or another local gateway.
DEFAULT_MODEL_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1 \
OPENAI_COMPATIBLE_MODEL=<loaded-model> \
OPENAI_COMPATIBLE_API_KEY=local \
npm run provider-check
```

Not every OpenAI-compatible endpoint supports JSON mode equally. If a model wraps JSON in prose, the adapter attempts to extract the first JSON object. If the model cannot produce the required fields reliably, use `mock` for workflow tests or `openai` for strict structured output.
