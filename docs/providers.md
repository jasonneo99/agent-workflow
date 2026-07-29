# Provider Matrix

Portable Agent Workflows keeps workflow and agent definitions provider-neutral. Runtime model behavior is selected by `DEFAULT_MODEL_PROVIDER`.

## Providers

| Provider | Use when | Required config |
| --- | --- | --- |
| `mock` | Deterministic local workflow, CI, storage, and receipt testing | none |
| `openai` | OpenAI Responses API execution | `OPENAI_API_KEY`, optional `OPENAI_MODEL` |
| `openai-compatible` | Local/self-hosted/OpenAI-compatible chat-completions APIs | `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL`, optional `OPENAI_COMPATIBLE_API_KEY` |
| `bedrock` | AWS Bedrock models | AWS credentials, optional `BEDROCK_MODEL`, `AWS_REGION` |
| `kiro` | Kiro/AWS credential chain over Bedrock | AWS/Kiro credentials, optional `KIRO_MODEL`, `KIRO_REGION` |

Switch the default provider stored in `.env`:

```bash
npm run agentflow -- provider-use openai --check
npm run agentflow -- provider-use kiro --check
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
OPENAI_MODEL=gpt-5.5 \
npm run provider-check
```

The OpenAI provider uses the Responses API with structured JSON schema output.

Run a one-stage provider contract smoke:

```bash
DEFAULT_MODEL_PROVIDER=openai npm run provider-smoke
```

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

Run a one-stage provider contract smoke:

```bash
DEFAULT_MODEL_PROVIDER=openai-compatible \
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1 \
OPENAI_COMPATIBLE_MODEL=<model-name> \
OPENAI_COMPATIBLE_API_KEY=local \
npm run provider-smoke
```

The provider smoke project allows no commands and no file writes. It verifies provider JSON contract behavior without giving the model local action privileges.

## Bedrock

```bash
DEFAULT_MODEL_PROVIDER=bedrock \
AWS_REGION=us-east-1 \
BEDROCK_MODEL=us.anthropic.claude-sonnet-4-20250514-v1:0 \
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

Kiro uses the same Bedrock runtime path with Kiro-specific environment fallbacks:

- `KIRO_MODEL` falls back to `BEDROCK_MODEL`, then the default Bedrock model.
- `KIRO_REGION` falls back to `AWS_REGION`, then `BEDROCK_REGION`, then `us-east-1`.

If the provider check fails with an AWS credentials message, refresh SSO and retry:

```bash
aws sso login
DEFAULT_MODEL_PROVIDER=kiro npm run provider-check
```

If you use a named SSO profile, include it:

```bash
aws sso login --profile tellara-new-admin
AWS_PROFILE=tellara-new-admin DEFAULT_MODEL_PROVIDER=kiro npm run provider-check
```

When Kiro cannot load AWS credentials, Agent Workflow will ask you to refresh SSO or switch back to OpenAI:

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
