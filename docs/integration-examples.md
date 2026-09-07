# Integration Examples

Agent Workflow has two separate integration layers:

1. The model provider configured in `.env`.
2. The client surface that calls Agent Workflow through CLI or MCP.

You can mix and match them. For example, Cursor can call Agent Workflow over MCP while Agent Workflow uses a first-class local Ollama model, OpenAI, AWS Bedrock, or an enterprise LiteLLM gateway.

## Model Provider Examples

### Mock

Use this for local workflow validation, CI, docs testing, and queue/storage checks without model calls.

```env
DEFAULT_MODEL_PROVIDER=mock
```

```bash
npm run provider-check
npm run smoke
```

### Local: Ollama

Use this when Ollama exposes an OpenAI-compatible endpoint on your machine.

```env
DEFAULT_MODEL_PROVIDER=local
LOCAL_MODEL_BASE_URL=http://localhost:11434/v1
LOCAL_MODEL_NAME=auto
LOCAL_MODEL_API_KEY=not-required
```

```bash
npm run provider-check
npm run provider-smoke
```

### Local: LM Studio

Use this when LM Studio's local server is running.

```env
DEFAULT_MODEL_PROVIDER=local
LOCAL_MODEL_BASE_URL=http://localhost:1234/v1
LOCAL_MODEL_NAME=auto
LOCAL_MODEL_API_KEY=not-required
```

```bash
npm run provider-check
```

### BYO: vLLM

Use this for a self-hosted vLLM OpenAI-compatible server.

```env
DEFAULT_MODEL_PROVIDER=byo
BYO_MODEL_BASE_URL=http://localhost:8000/v1
BYO_MODEL_NAME=auto
BYO_MODEL_API_KEY=not-required
```

```bash
npm run provider-check
```

### BYO: LiteLLM Or Enterprise Gateway

Use this for a team or enterprise model router. The gateway can route to OpenAI, Anthropic, Gemini, Bedrock, local models, or internal models while Agent Workflow only sees one OpenAI-compatible endpoint.

```env
DEFAULT_MODEL_PROVIDER=byo
BYO_MODEL_BASE_URL=https://llm-gateway.example.com/v1
BYO_MODEL_NAME=auto
BYO_MODEL_API_KEY=<gateway-api-key>
```

```bash
npm run provider-check
```

### Adaptive Cost-Saving Mix

Use this when you want cheap local/default execution for most stages and stronger reasoning only where needed.

```env
DEFAULT_MODEL_PROVIDER=auto
AGENTFLOW_AUTO_PROVIDERS=local,byo,bedrock,openai,openai-compatible,kiro
AGENTFLOW_FALLBACK_PROVIDER=openai
AGENTFLOW_QUALITY_THRESHOLD=0.62
AGENTFLOW_MODEL_POLICY=best-coding
```

Run `npm run agentflow -- provider-use auto --check` to preview which provider will be used for `fast`, `standard`, and `reasoning` stages. If AWS SSO is active, Bedrock can participate in the route; if it is expired, auto routing skips Bedrock and reports the checked providers in the route reason.

For explicit tier routing, use:

```env
DEFAULT_MODEL_PROVIDER=auto
AGENTFLOW_ROUTING_MODE=adaptive
AGENTFLOW_PROVIDER_FAST=local
AGENTFLOW_PROVIDER_STANDARD=local
AGENTFLOW_PROVIDER_REASONING=openai
AGENTFLOW_FALLBACK_PROVIDER=openai
AGENTFLOW_QUALITY_THRESHOLD=0.62

LOCAL_MODEL_BASE_URL=http://localhost:11434/v1
LOCAL_MODEL_NAME=qwen2.5-coder:14b
LOCAL_MODEL_FAST=llama3.1:8b
LOCAL_MODEL_STANDARD=qwen2.5-coder:14b
LOCAL_MODEL_REASONING=deepseek-r1:32b

OPENAI_API_KEY=<openai-api-key>
OPENAI_MODEL=auto
OPENAI_MODEL_REASONING=
```

Every stage records routing and quality metadata in its artifacts.

### OpenAI

Use this when you want Agent Workflow to call the OpenAI Responses API directly.

```env
DEFAULT_MODEL_PROVIDER=openai
OPENAI_API_KEY=<openai-api-key>
OPENAI_MODEL=auto
```

```bash
npm run provider-check
npm run provider-smoke
```

`OPENAI_MODEL=auto` refreshes available models from the live OpenAI catalog and
chooses a model per tier. Use exact `OPENAI_MODEL_FAST`,
`OPENAI_MODEL_STANDARD`, or `OPENAI_MODEL_REASONING` values only when you need
reproducible pinned runs.

### AWS Bedrock

Use this when you want direct Bedrock execution through the AWS SDK credential chain.

```env
DEFAULT_MODEL_PROVIDER=bedrock
AWS_REGION=us-east-1
AWS_PROFILE=<optional-profile>
BEDROCK_MODEL=auto
BEDROCK_MODEL_FAST=
BEDROCK_MODEL_STANDARD=
BEDROCK_MODEL_REASONING=
```

```bash
aws sso login --profile <optional-profile>
npm run provider-check
```

### Kiro CLI Adapter

Use this only when you intentionally want Kiro CLI as the provider adapter. It is optional and not required for VS Code, Cursor, Codex, or BYO model usage.

```env
DEFAULT_MODEL_PROVIDER=kiro
KIRO_CLI_BIN=kiro-cli
KIRO_API_KEY=<optional-headless-api-key>
KIRO_AGENT=
KIRO_TIMEOUT_MS=600000
```

```bash
kiro-cli login
npm run provider-check
```

### Legacy OpenAI-Compatible

Use this for older installs that already use `OPENAI_COMPATIBLE_*`. Prefer `local` for on-machine runtimes and `byo` for new remote or enterprise gateways.

```env
DEFAULT_MODEL_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
OPENAI_COMPATIBLE_MODEL=auto
OPENAI_COMPATIBLE_API_KEY=not-required
```

```bash
npm run provider-check
```

## Client And IDE Examples

The client only calls Agent Workflow. It does not define the model provider. Provider selection stays in Agent Workflow's `.env`.

### Terminal

```bash
cd /absolute/path/to/agent-workflow
npm run agentflow -- run-and-watch production-readiness \
  --project /path/to/project \
  --task "Review production readiness, UX, SEO, mobile experience, security, and launch risks" \
  --index-max-files 100 \
  --worker-limit 6
```

### VS Code

Add this to `.vscode/mcp.json` in the workspace or to your VS Code user MCP config.

```json
{
  "servers": {
    "agentWorkflow": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "-s", "mcp"],
      "cwd": "/absolute/path/to/agent-workflow"
    }
  }
}
```

Prompt example:

```text
Use Agent Workflow to orchestrate this workspace for production readiness and summarize the exported report.
```

### Cursor

Add this through Cursor Settings > Tools & Integrations > MCP Tools, or place it in `.cursor/mcp.json`.

```json
{
  "mcpServers": {
    "agentWorkflow": {
      "command": "npm",
      "args": ["run", "-s", "mcp"],
      "cwd": "/absolute/path/to/agent-workflow"
    }
  }
}
```

Prompt example:

```text
Use Agent Workflow to have Mira do a UX pass on this app and export the result.
```

### Codex

Add this to `~/.codex/config.toml`.

```toml
[mcp_servers.agent-workflow]
command = "npm"
args = ["run", "-s", "mcp"]
cwd = "/absolute/path/to/agent-workflow"
startup_timeout_sec = 120
```

Prompt example:

```text
Use Agent Workflow to run-and-watch review-pr on this project for "Review the current changes".
```

### Other MCP Clients

Use the same local stdio command if your client supports MCP server configuration.

```json
{
  "command": "npm",
  "args": ["run", "-s", "mcp"],
  "cwd": "/absolute/path/to/agent-workflow"
}
```

## Common Combinations

| Client | Provider | Use case |
| --- | --- | --- |
| Terminal | `mock` | Validate installation and workflows without model calls |
| Terminal | `local` with Ollama | Local/offline development loops |
| VS Code | `byo` with LiteLLM | Team gateway with centralized model routing |
| Cursor | `local` with LM Studio | Local model experimentation in an IDE |
| Cursor | `openai` | Direct OpenAI-backed agent workflows |
| Codex | `byo` | Codex as client, external model gateway as provider |
| Any MCP client | `bedrock` | AWS-native enterprise environments |
| Any MCP client | `kiro` | Kiro CLI as an intentional provider adapter |

## Validate A Complete Setup

```bash
npm run provider-check
docker compose -f infra/docker-compose.yml up -d
npm run doctor
npm run bootstrap-storage
npm run validate
npm run onboard-project -- --project /path/to/project --write
npm run agentflow -- run-and-watch provider-smoke \
  --project templates/project \
  --task "Return a concise provider contract smoke result. Do not request commands. Do not request file writes." \
  --worker-limit 1
```
