# MCP Client Setup

Agent Workflow can be used from any MCP-capable client. The MCP server is local stdio and reuses this repo's CLI, `.env`, provider config, storage config, project policies, and workflow definitions.

For model-provider pairings and copyable end-to-end examples, see [Integration Examples](integration-examples.md).

## Install Once

Install the compiled package without cloning:

```bash
npm install --global @jasonneo99/agent-workflow
agentflow-setup
agentflow ide-onboard --project /path/to/project --write --check
```

The standalone MCP executable is `agentflow-mcp`. IDE onboarding resolves its installed compiled entrypoint to an absolute Node command, avoiding IDE shell `PATH` differences.

For repository development:

```bash
git clone https://github.com/jasonneo99/agent-workflow.git
cd agent-workflow
npm install
cp .env.example .env
npm run setup
npm run provider-check
```

## Generate And Validate Workspace Setup

Preview ready-to-use snippets for all supported IDEs:

```bash
npm run ide-onboard -- --project /path/to/project
```

Safely merge them into `.vscode/mcp.json`, `.cursor/mcp.json`, and the trusted project's `.codex/config.toml`:

```bash
npm run ide-onboard -- --project /path/to/project --write
```

Existing unrelated JSON servers and settings are preserved. An existing Codex `agent-workflow` table is left unchanged. Add `--client vscode`, `--client cursor`, or `--client codex` to configure one surface. Add `--check` to probe enterprise storage and the configured provider in addition to checking project context and reusable definitions.

```bash
npm run ide-onboard -- --project /path/to/project --client codex --check
```

Add YAML schema validation for Agent Workflow files in VS Code or Cursor:

```bash
npm run agentflow -- schemas --project /path/to/project --write-vscode
```

Codex CLI, its IDE extension, and the desktop app share MCP configuration on the same host. Project-scoped `.codex/config.toml` is loaded only for trusted projects, so reload the IDE and trust the workspace after installation.

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
Use Agent Workflow to onboard this project, write the recommended config, then tell me the next command to run.
```

```text
Use Agent Workflow to add editor schema validation to this workspace.
```

```text
Use Agent Workflow to run-and-watch the build-feature workflow for "Add audit logging."
```

For review requests from Codex, VS Code, or Cursor, prefer run-and-watch behavior. The MCP `agentflow_run_workflow` tool now processes worker stages by default; use `queueOnly=true` only when a separate worker is already running.

## Notes

- The MCP client is only the control surface. The model provider is configured in Agent Workflow's `.env`.
- BYO works the same from VS Code, Cursor, Codex, terminal, or automation.
- Keep reusable agents and workflows in Agent Workflow. Keep project-specific context in each target project's `AGENTS.md` and `.agent-workflow/`.
