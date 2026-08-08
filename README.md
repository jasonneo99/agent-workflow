# Agent Workflow

Portable, model-agnostic agent workflows for any codebase. Define reusable AI agent teams and multi-stage workflows, plug in any model provider, and run structured automation across your projects.

## What it does

- **22 specialist agents** — architecture, frontend, backend, security, UX, testing, docs, and more
- **8 composable workflows** — build features, review PRs, debug failures, check production readiness
- **BYO model first** — use any OpenAI-compatible model gateway, plus optional OpenAI, Bedrock, or Kiro adapters
- **Cost-optimized routing** — fast models for simple tasks, reasoning models for complex ones
- **Durable execution** — queued stages, receipts, artifacts, and exportable reports

## Quick Start

```bash
git clone https://github.com/jasonneo99/agent-workflow.git
cd agent-workflow
npm install
npm run setup
```

The interactive setup walks you through provider selection and configuration. Once complete:

```bash
# Verify your provider is working
npm run provider-check

# Initialize agent workflow in your project
npm run init-project -- --project /path/to/your/project

# Run your first workflow (dry run)
npm run agentflow -- orchestrate --project /path/to/your/project --task "Review code quality" --dry-run

# Run it for real
npm run agentflow -- orchestrate --project /path/to/your/project --task "Review code quality"
```

## Providers

| Provider | Models | Config |
|----------|--------|--------|
| `mock` | None (deterministic) | No config needed |
| `byo` | Any OpenAI-compatible gateway | `BYO_MODEL_BASE_URL` + `BYO_MODEL_NAME` |
| `openai` | GPT-4o, GPT-5.5 | `OPENAI_API_KEY` |
| `bedrock` | Nova Pro/Lite, Claude, Llama, Mistral | AWS credentials |
| `openai-compatible` | Legacy BYO-compatible alias | `OPENAI_COMPATIBLE_BASE_URL` + model name |
| `kiro` | Optional Kiro CLI adapter | `kiro-cli login` or `KIRO_API_KEY` |

Switch providers by changing `DEFAULT_MODEL_PROVIDER` in `.env`:

```bash
# BYO model gateway: Ollama, LM Studio, vLLM, LiteLLM, internal routers, etc.
DEFAULT_MODEL_PROVIDER=byo
BYO_MODEL_BASE_URL=http://localhost:11434/v1
BYO_MODEL_NAME=llama3.1
BYO_MODEL_API_KEY=

# AWS Bedrock
DEFAULT_MODEL_PROVIDER=bedrock
BEDROCK_MODEL=amazon.nova-pro-v1:0
AWS_REGION=us-east-1

# Kiro CLI
DEFAULT_MODEL_PROVIDER=kiro
KIRO_CLI_BIN=kiro-cli
KIRO_AGENT=

# OpenAI
DEFAULT_MODEL_PROVIDER=openai
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o
```

For a fresh install, BYO can be configured either through `npm run setup` or by manually adding those four `BYO_*` lines to `.env`. After that, `npm run provider-check` verifies that the endpoint is reachable and the model is available.

## Model Tier Routing

Agents are assigned cost tiers (`fast`, `standard`, `reasoning`). The provider automatically routes to the right model:

| Tier | Use case | Default routing behavior |
|------|----------|--------------------------|
| `fast` | Triage, docs, test running | Provider adapter chooses a low-cost/low-effort path where supported |
| `standard` | Implementation, frontend, backend | Provider adapter uses its configured default model |
| `reasoning` | Architecture, security, UX review | Provider adapter chooses higher effort/capability where supported |

Override per-tier models where the provider supports it, such as `BEDROCK_MODEL_FAST`, `BEDROCK_MODEL_STANDARD`, and `BEDROCK_MODEL_REASONING`.

## Architecture

```
agents/          — Reusable agent cards (YAML)
workflows/       — Multi-stage workflow definitions (YAML)
packages/        — Runtime: model providers, context compiler, workflow engine
apps/cli/        — CLI interface
apps/worker/     — Background task processor
apps/mcp/        — MCP server for IDE integration
infra/           — Docker Compose for enterprise storage (Postgres, Redis, MinIO)
templates/       — Project initialization templates
```

## Commands

```bash
npm run setup                  # Interactive onboarding
npm run provider-check         # Verify model provider
npm run validate               # Validate agent/workflow definitions
npm run doctor                 # Check local services

# Project operations
npm run init-project -- -p .   # Install agent workflow into a project
npm run index-project -- -p .  # Index project files for context
npm run compile -- -w build-feature -p . -t "task"  # Compile a workflow brief

# Workflow execution (requires enterprise storage)
npm run agentflow -- orchestrate -p . -t "task"     # Auto-plan and run
npm run agentflow -- run build-feature -p . -t "task"  # Run specific workflow
npm run agentflow -- agent-task security -p . -t "task"  # Run single agent
npm run worker -- --limit 6    # Process queued tasks

# Inspection
npm run status                 # List recent runs
npm run artifacts -- -r <id>   # View run artifacts
npm run agentflow -- dashboard # Start local web dashboard
```

## Enterprise Storage

For durable execution with run history, a dashboard, and artifact storage:

```bash
docker compose -f infra/docker-compose.yml up -d
npm run migrate-storage
npm run bootstrap-storage
npm run doctor
```

For file-based output only (no Docker required), use `--profile simple` during project init.

## Adding Your Own Agents

Create a YAML file in your project's `.agent-workflow/agents/` directory:

```yaml
id: my-specialist
display_name: My Specialist
category: development
purpose: Do a specific thing well.
model_tier: standard    # fast | standard | reasoning
autonomy: 3
use_when:
  - relevant keyword
can:
  - specific_capability
outputs:
  schema: structured_summary
prompt: |
  Your agent instructions here.
```

## Adding Workflows

Create a YAML file in `workflows/`:

```yaml
id: my-workflow
name: My Custom Workflow
description: What this workflow does.
lead: workflow-orchestrator
stages:
  - id: analyze
    agent: technical-architect
    goal: Understand the problem.
    context:
      max_tokens: 4000
    output: analysis
  - id: implement
    agent: implementation-agent
    goal: Make the changes.
    context:
      max_tokens: 6000
    output: change_summary
```

## Cost Optimization

- **Model tier routing** — fast agents use cheap models, reasoning agents use capable ones
- **Delta indexing** — only re-indexes files that changed since last run
- **Conditional skipping** — orchestration skips redundant steps when prior steps found nothing
- **Persistent memory** — stores findings so future runs skip re-discovering known-good areas
- **Batched workflows** — `production-readiness` runs 4 specialist reviews in one pass with shared context

## Contributing

1. Fork the repo
2. Create a feature branch
3. Run `npm run validate` and `npm run typecheck` before submitting
4. Open a PR with a clear description of what changed and why

## License

MIT
