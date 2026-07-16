# Codex App MCP Install

This project includes a local stdio MCP server that exposes the portable agent workflow CLI to Codex.

## Install

Install dependencies once:

```bash
cd "/Users/jasonmiller/Projects/Agent Workflow"
npm install
```

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-workflow]
command = "npm"
args = ["run", "-s", "mcp"]
cwd = "/Users/jasonmiller/Projects/Agent Workflow"
startup_timeout_sec = 120
```

Restart the Codex app after changing MCP configuration.

## Tools

- `agentflow_doctor`: check definitions and local enterprise services.
- `agentflow_validate`: validate agent and workflow files.
- `agentflow_list`: list available agents and workflows.
- `agentflow_index_project`: index a project into compact durable context.
- `agentflow_compile`: compile a workflow brief without queueing work.
- `agentflow_run_workflow`: queue an enterprise workflow run.
- `agentflow_worker`: execute queued stage tasks.
- `agentflow_status`: inspect recent runs or a specific run.
- `agentflow_artifacts`: inspect run artifacts.
- `agentflow_export_run`: export Markdown and JSON run reports.
- `agentflow_provider_check`: check selected model provider.
- `agentflow_provider_smoke`: run a minimal provider contract smoke workflow.

## Tellara Example

After Docker services are running, ask Codex:

```text
Use the agent-workflow MCP to index /Users/jasonmiller/Projects/media-ai-startup, run the review-change workflow for "Review the billing catalog changes", process 6 worker tasks, and export the run.
```

The MCP server reuses the existing CLI and `.env`, so provider, storage, and project policies remain in one place.
