# Documentation

Start here if you are deciding how to install, configure, or run Agent Workflow.

## Recommended Reading Order

1. [User Guide](user-guide.md): install, configure a provider, initialize a project, run workflows, inspect results.
2. [Provider Matrix](providers.md): BYO model setup, OpenAI, Bedrock, OpenAI-compatible legacy config, and optional Kiro CLI adapter.
3. [MCP Client Setup](mcp-clients.md): use the same local workflow server from VS Code, Cursor, Codex, or another MCP-capable client.
4. [Integration Examples](integration-examples.md): copyable model-provider and IDE/client examples.
5. [Agent Roster](agent-roster.md): built-in agents and automatic agents.
6. [Architecture](architecture.md): runtime, storage, indexing, safe actions, and model portability.
7. [Open Source Boundary](open-source-boundary.md): what belongs in the framework versus private product agent engines.
8. [Autonomy Policy](autonomy.md): what each autonomy level allows.
9. [Profiles](profiles.md): enterprise, simple, and project-specific initialization profiles.
10. [Tellara Integration](tellara-integration.md): Tellara-specific setup and examples.
11. [Codex MCP Install](mcp-codex-app.md): Codex-specific MCP setup. Use [MCP Client Setup](mcp-clients.md) for generic clients.

## Fast Path

```bash
git clone https://github.com/jasonneo99/agent-workflow.git
cd agent-workflow
npm install
cp .env.example .env
npm run setup
npm run provider-check
docker compose -f infra/docker-compose.yml up -d
npm run doctor
npm run bootstrap-storage
npm run validate
```

Then initialize a target project:

```bash
npm run onboard-project -- --project /path/to/project --profile enterprise --write
npm run agentflow -- run-and-watch production-readiness \
  --project /path/to/project \
  --task "Review production readiness, UX, SEO, mobile experience, security, and launch risks" \
  --index-max-files 100 \
  --worker-limit 6
npm run agentflow -- quality-report --run <run-id>
npm run agentflow -- feedback --run <run-id> --rating accepted --note "Good production-readiness scope"
npm run agentflow -- preference-scorecard --project /path/to/project
npm run agentflow -- tuning-proposals --project /path/to/project
npm run agentflow -- apply-tuning-proposals --project /path/to/project --ids all
npm run agentflow -- apply-tuning-proposals --project /path/to/project --ids tune-001,tune-004 --write
```

## BYO Model Config

For local models, hosted gateways, enterprise routers, LiteLLM, vLLM, LM Studio, Ollama, or any OpenAI-compatible chat-completions endpoint:

```env
DEFAULT_MODEL_PROVIDER=byo
BYO_MODEL_BASE_URL=http://localhost:11434/v1
BYO_MODEL_NAME=llama3.1
BYO_MODEL_API_KEY=not-required
```

Run:

```bash
npm run provider-check
```

## Client Model

The editor or agent client is only the control surface. The model provider lives in Agent Workflow's `.env`.

- Terminal: run `npm run agentflow -- ...`
- VS Code: configure `.vscode/mcp.json`
- Cursor: configure `.cursor/mcp.json`
- Codex: configure `~/.codex/config.toml` or install the optional personal plugin
