# MCP Client Setup

Agent Workflow can be used from any MCP-capable client. The MCP server is local stdio and reuses this repo's CLI, `.env`, provider config, storage config, project policies, and workflow definitions.

For model-provider pairings and copyable end-to-end examples, see [Integration Examples](integration-examples.md).

## Install Once

```bash
git clone https://github.com/jasonneo99/agent-workflow.git
cd agent-workflow
npm install
cp .env.example .env
npm run setup
npm run provider-check
```

For BYO model usage, `.env` only needs a reachable OpenAI-compatible endpoint:

```env
DEFAULT_MODEL_PROVIDER=byo
BYO_MODEL_BASE_URL=http://localhost:11434/v1
BYO_MODEL_NAME=llama3.1
BYO_MODEL_API_KEY=not-required
```

## VS Code

Add a workspace config at `.vscode/mcp.json` in the project where you want to use Agent Workflow, or add it to your VS Code user MCP config.

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

Then run `MCP: List Servers` from the Command Palette and start `agentWorkflow`.

## Cursor

Add this through Cursor Settings > Tools & Integrations > MCP Tools, or place it in `.cursor/mcp.json` for a workspace-level setup.

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

Then enable the server in Cursor MCP settings.

## Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-workflow]
command = "npm"
args = ["run", "-s", "mcp"]
cwd = "/absolute/path/to/agent-workflow"
startup_timeout_sec = 120
```

Restart Codex after changing MCP configuration.

## Example Prompts

```text
Use Agent Workflow to orchestrate this project for "Review production readiness, UX, SEO, and launch risks."
```

```text
Use Agent Workflow to have the UX reviewer do a pass on this app and export the report.
```

```text
Use Agent Workflow to update my model provider to BYO and run a provider check.
```

```text
Use Agent Workflow to run-and-watch the build-feature workflow for "Add audit logging."
```

## Notes

- The MCP client is only the control surface. The model provider is configured in Agent Workflow's `.env`.
- BYO works the same from VS Code, Cursor, Codex, terminal, or automation.
- Keep reusable agents and workflows in Agent Workflow. Keep project-specific context in each target project's `AGENTS.md` and `.agent-workflow/`.
