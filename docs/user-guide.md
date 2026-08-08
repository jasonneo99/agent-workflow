# Agent Workflow User Guide

This guide covers installation, MCP client setup, project setup, CLI usage, and common examples.

## 1. Install Agent Workflow

Clone the repo and install dependencies:

```bash
git clone git@github.com:jasonneo99/agent-workflow.git
cd "/Users/jasonmiller/Projects/Agent Workflow"
cp .env.example .env
npm install
```

Start the default enterprise services:

```bash
docker compose -f infra/docker-compose.yml up -d
npm run doctor
npm run bootstrap-storage
npm run validate
```

The default first-run provider should be `mock`:

```env
DEFAULT_MODEL_PROVIDER=mock
```

Use OpenAI only when you intentionally want live model execution:

```env
DEFAULT_MODEL_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.5
```

## 2. Smoke Test

Run the full local smoke test:

```bash
npm run smoke
```

This verifies Docker services, workflow definitions, queueing, storage, receipts, artifacts, and worker execution.

## 3. Use From An MCP Client

Agent Workflow can run from VS Code, Cursor, Codex, or another MCP-capable client. The client only launches the local MCP server; model/provider selection stays in Agent Workflow's `.env`.

See [MCP Client Setup](mcp-clients.md) for config examples.

## 3a. Optional Codex Plugin

Agent Workflow is packaged as a personal Codex plugin. Install or reinstall it with:

```bash
/Applications/ChatGPT.app/Contents/Resources/codex plugin add agent-workflow@personal
```

Then start a new Codex task or restart Codex so the plugin skill and MCP tools are loaded.

The plugin provides:

- Codex skill: `/Users/jasonmiller/plugins/agent-workflow/skills/agent-workflow/SKILL.md`
- MCP launcher: `/Users/jasonmiller/plugins/agent-workflow/scripts/run-agent-workflow-mcp.sh`
- MCP manifest: `/Users/jasonmiller/plugins/agent-workflow/.mcp.json`
- Plugin manifest: `/Users/jasonmiller/plugins/agent-workflow/.codex-plugin/plugin.json`

## 4. Add Agent Workflow To A Project

Enterprise mode is the default:

```bash
npm run init-project -- --project /path/to/project --profile enterprise
```

Tellara has a dedicated profile:

```bash
npm run init-project -- --project /Users/jasonmiller/Projects/media-ai-startup --profile tellara
```

This installs:

```text
AGENTS.md
.agent-workflow/project.yaml
.agent-workflow/context.md
.agent-workflow/commands.md
.agent-workflow/decisions.md
.agent-workflow/schedules.yaml
.agent-workflow/agents/*.yaml
```

Keep reusable agents and workflows in Agent Workflow. Keep project-specific context in the consuming project.

## 5. Index Project Context

Index a project into compact durable summaries:

```bash
npm run index-project -- --project /path/to/project --max-files 100
```

For large repos, start with a compact non-refined pass:

```bash
npm run index-project -- --project /Users/jasonmiller/Projects/media-ai-startup --max-files 100
```

Use provider-refined summaries only for smaller or targeted passes:

```bash
npm run index-project -- --project /path/to/project --max-files 40 --refine
```

## 6. Available Workflows

Current workflow ids:

```text
build-feature
debug-failure
maintain-context
provider-smoke
review-pr
ship-release
wide-open-automation
```

Use `review-pr` for reviewing local changes, PR-like work, or risk-sensitive areas.

## 7. Run Workflows From CLI

Run one specialist agent directly:

```bash
npm run agentflow -- agent-task ux-reviewer \
  --project /Users/jasonmiller/Projects/media-ai-startup \
  --task "Have Mira do a UX pass on the current Tellara changes" \
  --index-max-files 100
```

Common agent aliases include:

```text
Mira, ux, ux-pass -> ux-reviewer
security -> security-reviewer
frontend -> frontend-engineer
backend -> backend-engineer
database, db -> database-engineer
tests -> test-engineer
ci -> ci-debugger
docs -> docs-maintainer
release -> release-manager
product -> product-strategist
architect -> technical-architect
```

Project-local agents live in `.agent-workflow/agents/*.yaml`. List built-in plus project agents with:

```bash
npm run list -- --project /path/to/project
```

Run a project-local specialist exactly like a built-in agent:

```bash
npm run agentflow -- agent-task project-reviewer \
  --project /path/to/project \
  --task "Review this implementation against local architecture decisions"
```

Run a named preset:

```bash
npm run agentflow -- preset tellara-ux-pass
```

List available presets:

```bash
npm run agentflow -- preset --list
```

Current Tellara presets:

```text
tellara-ux-pass
tellara-pr-review
tellara-test-triage
tellara-maintain-context
tellara-frontend-pass
```

Override the task or project when needed:

```bash
npm run agentflow -- preset tellara-ux-pass \
  --task "Do a UX pass focused on the onboarding and command center flows"
```

Run a natural-language orchestration:

```bash
npm run agentflow -- orchestrate \
  --project /Users/jasonmiller/Projects/truckoutfittersunlimited \
  --task "Review the production site UX, SEO, mobile experience, and launch risks"
```

Preview the plan before running it:

```bash
npm run agentflow -- orchestrate \
  --project /Users/jasonmiller/Projects/truckoutfittersunlimited \
  --task "Review the production site UX, SEO, mobile experience, and launch risks" \
  --dry-run
```

The easiest path is `run-and-watch`. It indexes the project, queues the workflow, processes worker tasks until the run completes or fails, exports Markdown and JSON reports, and prints the final status.

Review Tellara in one command:

```bash
npm run agentflow -- run-and-watch review-pr \
  --project /Users/jasonmiller/Projects/media-ai-startup \
  --task "Review billing catalog changes" \
  --index-max-files 100 \
  --worker-limit 6
```

Build a feature in one command:

```bash
npm run agentflow -- run-and-watch build-feature \
  --project /path/to/project \
  --task "Add audit logging" \
  --index-max-files 100 \
  --worker-limit 6
```

Debug a failure in one command:

```bash
npm run agentflow -- run-and-watch debug-failure \
  --project /Users/jasonmiller/Projects/media-ai-startup \
  --task "Investigate pnpm test failures from run 17cbcb8d-4a18-421b-9950-8afc0a782fce" \
  --index-max-files 100 \
  --worker-limit 6
```

Useful options:

```text
--skip-index
--index-max-files <number>
--refine-index
--force-refine
--worker-limit <number>
--interval-ms <number>
--timeout-ms <number>
--out <dir>
--source-token-budget <number>
--source-max-files <number>
```

Manual lower-level commands are still available when you want to control each step yourself.

Build a feature:

```bash
npm run agentflow -- run build-feature --project /path/to/project --task "Add audit logging" --no-brief
npm run worker -- --limit 6
npm run status
```

Review Tellara:

```bash
npm run agentflow -- run review-pr --project /Users/jasonmiller/Projects/media-ai-startup --task "Review billing catalog changes" --no-brief
npm run worker -- --limit 6
npm run status
```

Debug a failure:

```bash
npm run agentflow -- run debug-failure --project /Users/jasonmiller/Projects/media-ai-startup --task "Investigate pnpm test failures from run 17cbcb8d-4a18-421b-9950-8afc0a782fce" --no-brief
npm run worker -- --limit 6
```

Maintain project context:

```bash
npm run agentflow -- run maintain-context --project /path/to/project --task "Update durable project context after architecture changes" --no-brief
npm run worker -- --limit 6
```

Export a run:

```bash
npm run export-run -- --run <run-id> --out /path/to/project/.agent-workflow/exports
```

Inspect a specific run with artifacts:

```bash
npm run agentflow -- status --run <run-id> --artifacts
```

Summarize a run into a decision-ready report:

```bash
npm run agentflow -- summarize-run --run <run-id>
```

JSON summary:

```bash
npm run agentflow -- summarize-run --run <run-id> --json
```

## 8. Schedules

Projects can define disabled-by-default schedules in:

```text
.agent-workflow/schedules.yaml
```

Example schedule:

```yaml
schedules:
  - id: weekly-context-maintenance
    enabled: true
    every_minutes: 10080
    workflow: maintain-context
    task: "Update durable project context, decisions, and command notes."
    index_max_files: 100
    worker_limit: 6
```

Dry-run due schedules:

```bash
npm run agentflow -- schedule --project /path/to/project --dry-run
```

Run due schedules once:

```bash
npm run agentflow -- schedule --project /path/to/project
```

Run due schedules continuously:

```bash
npm run agentflow -- schedule --project /path/to/project --watch --interval-ms 60000
```

Schedule state is stored in `.agent-workflow/schedule-state.json`.

## 9. Dashboard

Start the local run dashboard:

```bash
npm run agentflow -- dashboard
```

Open:

```text
http://127.0.0.1:17888
```

JSON endpoints:

```text
/api/runs
/api/run?id=<run-id>
```

Run detail pages:

```text
/run?id=<run-id>
```

The detail page shows:

- run status, project, workflow, and task
- decision-ready summary
- stage results
- receipts
- artifact JSON viewers
- fixed follow-up buttons

Follow-up buttons are local-only actions backed by existing Agent Workflow commands:

- `Summarize Run`
- `Debug Failure`
- `Ask Mira`
- `Frontend Pass`
- `Maintain Context`

The dashboard home also includes Tellara presets:

- `UX Pass`
- `PR Review`
- `Test Triage`
- `Maintain Context`
- `Frontend Pass`

These actions still use the project `.agent-workflow/project.yaml` policy and create normal run receipts and artifacts.

## 10. Use From Codex

After installing the plugin, start a new Codex task and use prompts like:

```text
Use Agent Workflow to run-and-watch review-pr on Tellara for "Review billing catalog changes" and return the exported report.
```

```text
Use Agent Workflow to have Mira do a UX pass on Tellara and export the report.
```

```text
Use Agent Workflow to run the tellara-ux-pass preset and summarize the top 3 fixes.
```

```text
Use Agent Workflow to orchestrate this for Truck Outfitters Unlimited: review the production site UX, SEO, mobile experience, and launch risks.
```

```text
Use Agent Workflow to run debug-failure on Tellara for the failed pnpm test run, inspect artifacts, and summarize next fixes.
```

```text
Use Agent Workflow to maintain Tellara context after these recent architecture changes.
```

```text
Use Agent Workflow to index this repo and run build-feature for "Add audit logging".
```

## 9. MCP Tools

Codex can call these MCP tools through the plugin:

```text
agentflow_doctor
agentflow_validate
agentflow_list
agentflow_index_project
agentflow_compile
agentflow_run_workflow
agentflow_run_and_watch
agentflow_agent_task
agentflow_summarize_run
agentflow_schedule
agentflow_worker
agentflow_status
agentflow_artifacts
agentflow_export_run
agentflow_provider_check
agentflow_provider_smoke
```

Tool definitions and input schemas live in:

```text
/Users/jasonmiller/Projects/Agent Workflow/apps/mcp/src/index.ts
```

## 11. Storage And Reset

Reset local enterprise run history:

```bash
npm run reset-storage
npm run bootstrap-storage
```

Remove Docker volumes too:

```bash
npm run services:reset
docker compose -f infra/docker-compose.yml up -d
npm run bootstrap-storage
```

## 12. Provider Checks

Check the configured provider:

```bash
npm run provider-check
```

Run a provider contract smoke test:

```bash
npm run provider-smoke
```

## 13. Recommended Next Improvement

The `run-and-watch`, `agent-task`, `preset`, `orchestrate`, `summarize-run`, project-local agents, schedules, and dashboard commands are now implemented.

The next best improvement is a project onboarding command that detects a repo's stack, writes a tailored `.agent-workflow/project.yaml`, proposes project-local agents, and performs a safe dry-run before any live workflow runs.

The target output should include:

```text
- detected package manager, framework, test commands, and lint/typecheck commands
- recommended context excludes and blocked write paths
- suggested project-local agents
- dry-run validation status
- next recommended workflow command
```
