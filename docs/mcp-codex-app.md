# Codex App MCP Install

For VS Code, Cursor, and generic MCP client setup, see [MCP Client Setup](mcp-clients.md).

This project includes a local stdio MCP server that exposes the portable agent workflow CLI to Codex.

## Install

Install dependencies once:

```bash
cd /absolute/path/to/agent-workflow
npm install
```

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-workflow]
command = "npm"
args = ["run", "-s", "mcp"]
cwd = "/absolute/path/to/agent-workflow"
startup_timeout_sec = 120
```

Restart the Codex app after changing MCP configuration.

## Tools

- `agentflow_doctor`: check definitions and local enterprise services.
- `agentflow_validate`: validate agent and workflow files.
- `agentflow_list`: list available agents and workflows.
- `agentflow_onboard_project`: analyze a project and recommend or write tailored Agent Workflow config.
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
- `agentflow_quality_report`: inspect cost mix, routing, fallback use, latency, and quality scores.
- `agentflow_feedback`: record accepted, revised, or rejected feedback for a run.
- `agentflow_preference_scorecard`: aggregate feedback and routing performance by workflow, stage, agent, provider, and tier.
- `agentflow_tuning_proposals`: generate reviewable prompt, context-budget, and routing tuning suggestions.
- `agentflow_queue_tuning_approvals`: dry-run or write a project-local approval queue for selected tuning proposals.
- `agentflow_tuning_approvals`: list, approve, or reject project-local tuning approval queue items.
- `agentflow_generate_tuning_patches`: dry-run or write reviewable patch-plan files from approved tuning proposals.
- `agentflow_apply_tuning_proposals`: dry-run or write selected tuning proposals into project-local `.agent-workflow/tuning/` overlays.
- `agentflow_artifacts`: inspect run artifacts.
- `agentflow_export_run`: export Markdown and JSON run reports.
- `agentflow_provider_check`: check selected model provider.
- `agentflow_provider_use`: switch or update selected model provider in `.env`.
- `agentflow_provider_smoke`: run a minimal provider contract smoke workflow.

## Examples

After Docker services are running, ask Codex:

```text
Use the agent-workflow MCP to run-and-watch the review-pr workflow for /path/to/project with task "Review the current changes".
```

```text
Use the agent-workflow MCP to have Mira do a UX pass on /path/to/project and export the result.
```

```text
Use the agent-workflow MCP to run-and-watch the production-readiness workflow for /path/to/project and summarize the top 3 fixes.
```

```text
Use the agent-workflow MCP to orchestrate /path/to/project for "Review the production site UX, SEO, mobile experience, and launch risks".
```

The MCP server reuses the existing CLI and `.env`, so provider, storage, and project policies remain in one place.

## Provider Switching

Ask Codex:

```text
Use Agent Workflow to update my model to BYO.
```

```text
Use Agent Workflow to update my model to OpenAI.
```

```text
Use Agent Workflow to update my model to Kiro.
```
