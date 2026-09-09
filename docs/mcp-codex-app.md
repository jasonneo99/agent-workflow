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

## Transport Troubleshooting

If Codex reports `Transport closed`, the local Agent Workflow services may
still be healthy while Codex's private stdio connection to the MCP subprocess is
gone. Restart the Codex app or the current Codex task to create a fresh MCP
subprocess.

If this repeats during an approval call, use the CLI fallback for the exact
approval or run id instead of broad approvals. That preserves the approval
receipt while avoiding a stale Codex-owned MCP pipe:

```bash
npm run agentflow -- approvals --status pending --run <run-id>
npm run agentflow -- approvals --approve-execute <approval-id> --actor "Your Name" --actor-role approver
```

Then record the recurrence as an MCP transport issue rather than treating it as
a dashboard, provider, storage, or worker outage.

The MCP server writes best-effort lifecycle breadcrumbs to:

```text
.agent-workflow/runtime/mcp/stdio.log
.agent-workflow/runtime/mcp/launcher.log
```

Those logs record launcher resolution, start, connect, stdin close, stdout
errors, uncaught exceptions, process exit events, metadata-only
`agentflow_approvals` start/result events, and command spans for MCP-launched
CLI work. Approval diagnostics include action type, approval id, run id,
project hash, actor hash, exit code, timeout state, and output byte counts.
Command spans include operation name, command hash, child PID, timeout, exit
state, and output byte counts. They do not include command text, note text,
prompt bodies, provider keys, database URLs, storage secrets, or artifacts.

Run an end-to-end launcher smoke check from the repo:

```bash
npm run runtime-monitor -- --check-mcp
```

MCP tool output is compacted by default for stdio stability. Set
`AGENTFLOW_MCP_MAX_OUTPUT_CHARS` only when a client can safely handle larger
responses; for full logs, rerun the printed CLI fallback command in a terminal.

Open `/server-readiness` in the dashboard for the same MCP Pipeline status and
the Codex / IDE Reload Guidance callout. Zero active MCP processes is normal
between Codex tool calls because Codex starts the stdio server on demand. If
the smoke check passes but Codex still reports `Transport closed`, restart the
Codex app or task so Codex creates a fresh private stdio subprocess.

## Tools

- `agentflow_doctor`: check definitions and local enterprise services.
- `agentflow_validate`: validate agent and workflow files.
- `agentflow_contract_test`: verify reusable definitions, project-local agents, and provider adapter output shape.
- `agentflow_bundle_manifest`: print or write the versioned reusable agent/workflow bundle manifest.
- `agentflow_bundle_compat`: check bundle runtime, Node.js, MCP compatibility, and migration notes.
- `agentflow_bundle_upgrade_preview`: preview project bundle migration notes and safe upgrade actions without changing files.
- `agentflow_bundle_adopt`: record the current reusable bundle as adopted by a project.
- `agentflow_definition_migrations`: preview definition contract changes, validation, and rollback guidance.
- `agentflow_list`: list available agents and workflows.
- `agentflow_schemas`: list JSON Schemas or write VS Code/Cursor YAML validation settings.
- `agentflow_onboard_project`: analyze a project and recommend or write tailored Agent Workflow config.
- `agentflow_discover_projects`: dry-run local project discovery across governed roots without indexing file contents.
- `agentflow_adopt_discovered_projects`: explicitly initialize and/or index discovered candidate projects; dry-run unless `write` is true.
- `agentflow_index_project`: index a project into compact durable context; pass `incremental` to refresh only changed files after a baseline exists.
- `agentflow_compile`: compile a workflow brief without queueing work.
- `agentflow_workflow_graph`: inspect workflow stages, dependencies, agents, policy fit, approvals, and context budgets without queueing work.
- `agentflow_run_workflow`: run a workflow and process worker stages by default; set `queueOnly=true` only when you want to leave work queued for a separate worker. It incrementally indexes by default unless `skipIndex` is true.
- `agentflow_run_and_watch`: incrementally index, queue, process, export, and summarize a workflow run; pass `fullIndex` for a clean context refresh.
- `agentflow_agent_task`: incrementally index, run one specialist agent directly, and export the result.
- `agentflow_preset`: run a named workflow preset such as `tellara-ux-pass`.
- `agentflow_orchestrate`: route a natural-language task to agents and workflows.
- `agentflow_summarize_run`: print a decision-ready run summary.
- `agentflow_schedule`: run due project schedules or dry-run due schedules.
- `agentflow_worker`: execute queued stage tasks.
- `agentflow_status`: inspect recent runs or a specific run.
- `agentflow_approvals`: list, approve, approve-and-execute, reject, execute, dismiss, add always-approve rules, or run approval autopilot for agent-requested actions.
- `agentflow_approval_rules`: list or remove project-local always-approved shell/fswrite rules.
- `agentflow_approval_backlog`: inspect missed, stale, warning, and failed approval items without changing them.
- `agentflow_request_approval`: create deployment or autonomy approval requests in the shared inbox.
- `agentflow_quality_report`: inspect cost mix, routing, fallback use, latency, and quality scores.
- `agentflow_gate`: evaluate a run against project-local quality, latency, fallback, and cost gates.
- `agentflow_observe`: export OpenTelemetry-compatible spans and metrics for a run.
- `agentflow_feedback`: record accepted, revised, or rejected feedback for a run.
- `agentflow_preference_scorecard`: aggregate feedback and routing performance by workflow, stage, agent, provider, and tier.
- `agentflow_tuning_proposals`: generate reviewable prompt, context-budget, and routing tuning suggestions.
- `agentflow_queue_tuning_approvals`: dry-run or write a project-local approval queue for selected tuning proposals.
- `agentflow_tuning_approvals`: list, approve, or reject project-local tuning approval queue items.
- `agentflow_generate_tuning_patches`: dry-run or write reviewable patch-plan files from approved tuning proposals.
- `agentflow_apply_tuning_patches`: dry-run or write project-local tuning notes from reviewed patch-plan items.
- `agentflow_apply_tuning_proposals`: dry-run or write selected tuning proposals into project-local `.agent-workflow/tuning/` overlays.
- `agentflow_agent_improvement_apply`: dry-run or apply approved agent YAML promotions with source-hash checks, schema validation, risk thresholds, and rollback receipts.
- `agentflow_artifacts`: inspect run artifacts.
- `agentflow_export_run`: export Markdown and JSON run reports, with optional scrubbed sharing mode.
- `agentflow_provider_check`: check selected model provider.
- `agentflow_provider_use`: switch or update selected model provider in `.env`.
- `agentflow_provider_smoke`: run a minimal provider contract smoke workflow.

When a tool response says `Approval required`, the requested side effect is
waiting for a human decision in the current client. Surface the one-line summary
and approval id to the user, then ask whether to approve and execute now,
approve only, reject, always approve the exact function call, always approve the
broad function family, execute an already approved action, or dismiss a stale
approved action. Call `agentflow_approvals` with `approveAndExecute`, `approve`,
`reject`, `always` plus `alwaysScope`, `execute`, or `dismiss` after the user
decides. Prefer `approveAndExecute` for local inline approvals. The workflow may
still complete other stages while that side effect stays skipped.

For local developer setups that enable approval autopilot, Codex can call
`agentflow_approvals` with `autoApproveExecute=true` and `maxRisk=medium` to
approve and execute eligible low/medium pending side effects after Agent
Workflow rechecks project policy. High-risk actions remain in the approval
inbox.

## Examples

After Docker services are running, ask Codex:

```text
Use the agent-workflow MCP to run-and-watch the review-pr workflow for /path/to/project with task "Review the current changes".
```

```text
Use the agent-workflow MCP to show the Mermaid workflow graph for build-feature in /path/to/project.
```

```text
Use the agent-workflow MCP to write VS Code schema validation settings for /path/to/project.
```

For Codex review requests such as "ask Nash to review this", prefer `agentflow_run_workflow` or `agentflow_run_and_watch` without `queueOnly`. That prevents the run from staying queued after the MCP call returns.

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
