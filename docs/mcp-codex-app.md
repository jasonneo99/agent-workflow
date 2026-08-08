# Codex App MCP Install

For VS Code, Cursor, and generic MCP client setup, see [MCP Client Setup](mcp-clients.md).

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
- `agentflow_run_and_watch`: index, queue, process, export, and summarize a workflow run.
- `agentflow_agent_task`: run one specialist agent directly and export the result.
- `agentflow_preset`: run a named workflow preset such as `tellara-ux-pass`.
- `agentflow_orchestrate`: route a natural-language task to agents and workflows.
- `agentflow_summarize_run`: print a decision-ready run summary.
- `agentflow_schedule`: run due project schedules or dry-run due schedules.
- `agentflow_worker`: execute queued stage tasks.
- `agentflow_status`: inspect recent runs or a specific run.
- `agentflow_artifacts`: inspect run artifacts.
- `agentflow_export_run`: export Markdown and JSON run reports.
- `agentflow_provider_check`: check selected model provider.
- `agentflow_provider_use`: switch or update selected model provider in `.env`.
- `agentflow_provider_smoke`: run a minimal provider contract smoke workflow.

## Tellara Example

After Docker services are running, ask Codex:

```text
Use the agent-workflow MCP to run-and-watch the review-pr workflow for /Users/jasonmiller/Projects/media-ai-startup with task "Review the billing catalog changes".
```

```text
Use the agent-workflow MCP to have Mira do a UX pass on /Users/jasonmiller/Projects/media-ai-startup and export the result.
```

```text
Use the agent-workflow MCP to run the tellara-ux-pass preset and summarize the top 3 fixes.
```

```text
Use the agent-workflow MCP to orchestrate /Users/jasonmiller/Projects/truckoutfittersunlimited for "Review the production site UX, SEO, mobile experience, and launch risks".
```

The MCP server reuses the existing CLI and `.env`, so provider, storage, and project policies remain in one place.

## Provider Switching

Ask Codex:

```text
Use Agent Workflow to update my model to OpenAI.
```

```text
Use Agent Workflow to update my model to Kiro.
```
