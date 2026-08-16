# Agent Workflow User Guide

This guide covers installation, MCP client setup, project setup, CLI usage, and common examples.

## 1. Install Agent Workflow

Clone the repo and install dependencies:

```bash
git clone git@github.com:jasonneo99/agent-workflow.git
cd agent-workflow
cp .env.example .env
npm install
npm run setup
npm run provider-check
```

Start the default enterprise services:

```bash
docker compose -f infra/docker-compose.yml up -d
npm run doctor
npm run bootstrap-storage
npm run validate
npm run bundle-manifest
```

The default first-run provider should be `mock`:

```env
DEFAULT_MODEL_PROVIDER=mock
```

Use BYO when you want live model execution through a local, hosted, or enterprise OpenAI-compatible model gateway:

```env
DEFAULT_MODEL_PROVIDER=byo
BYO_MODEL_BASE_URL=http://localhost:11434/v1
BYO_MODEL_NAME=llama3.1
BYO_MODEL_API_KEY=not-required
```

Use OpenAI only when you intentionally want direct OpenAI API execution:

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

`npm run bundle-manifest` prints the versioned reusable agent/workflow bundle manifest. Run `npm run bundle-manifest -- --write` after changing shared files under `agents/` or `workflows/`; `npm run validate` checks the committed manifest checksum.

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

- Codex skill: `<plugin-root>/skills/agent-workflow/SKILL.md`
- MCP launcher: `<plugin-root>/scripts/run-agent-workflow-mcp.sh`
- MCP manifest: `<plugin-root>/.mcp.json`
- Plugin manifest: `<plugin-root>/.codex-plugin/plugin.json`

## 4. Add Agent Workflow To A Project

Preview tailored onboarding recommendations:

```bash
npm run onboard-project -- --project /path/to/project
```

Write a tailored `.agent-workflow/project.yaml` and support files:

```bash
npm run onboard-project -- --project /path/to/project --profile enterprise --write
```

This writes `AGENTS.md` when missing plus `.agent-workflow/project.yaml`, `context.md`, `commands.md`, `decisions.md`, and `schedules.yaml`. Existing files are skipped unless `--force` is provided.

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
npm run index-project -- --project /path/to/project --max-files 100
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
production-readiness
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
  --project /path/to/project \
  --task "Have Mira do a UX pass on the current app" \
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

Project-specific Tellara presets are available when that profile is useful:

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

Review a project in one command:

```bash
npm run agentflow -- run-and-watch review-pr \
  --project /path/to/project \
  --task "Review the current changes and summarize risks" \
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
  --project /path/to/project \
  --task "Investigate the latest test failure and propose fixes" \
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

Review a project:

```bash
npm run agentflow -- run review-pr --project /path/to/project --task "Review the current changes" --no-brief
npm run worker -- --limit 6
npm run status
```

Debug a failure:

```bash
npm run agentflow -- run debug-failure --project /path/to/project --task "Investigate the latest test failure" --no-brief
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
npm run export-run -- --run <run-id> --out /path/to/project/.agent-workflow/exports --scrub
```

Use `--scrub` before sharing exports outside a trusted local context. Scrubbed exports preserve workflow shape and status while redacting absolute paths, emails, common secret patterns, compiled briefs, prompts, command output, summaries, findings, schemas, tenant fields, and other high-risk freeform artifact fields.

See [Scrubbed Examples](examples/README.md) for synthetic Markdown and JSON exports that are safe to reference in docs or issue reports.

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

For the recommended local developer setup, also start a background worker in a second terminal:

```bash
npm run worker:daemon
```

The daemon continuously processes queued stages and writes a heartbeat to `.agent-workflow/runtime/worker-heartbeat.json`. The dashboard uses that heartbeat to show whether the worker is running, stale, stopped, or missing.

Open:

```text
http://127.0.0.1:17888
```

JSON endpoints:

```text
/api/runs
/api/info
/api/queue
/api/projects
/api/run?id=<run-id>
/api/quality?id=<run-id>
```

Run detail pages:

```text
/info
/queue
/projects
/project?root=<project-root>
/run?id=<run-id>
```

The Info page shows safe local runtime details: selected model provider, model name/base URL when applicable, whether API keys are configured, enterprise service reachability, registry counts, bundle manifest checksum, storage configuration presence, and useful local commands. It does not print secret values.

The dashboard home page and Info page include Background Worker status. If it says `missing`, `stopped`, or `stale`, run `npm run worker:daemon` from the Agent Workflow repo. If a previous worker was interrupted while a stage was running, open `/queue` and use Requeue Running before processing again.

When the active provider exposes a models endpoint, the Info page also lists available models and lets you update the active model without editing `.env` manually. The selector writes the provider-specific model variable, such as `OPENAI_MODEL`, `BYO_MODEL_NAME`, `OPENAI_COMPATIBLE_MODEL`, or `BEDROCK_MODEL`. Model changes apply to new workflow tasks; restart long-running workers if they were already active.

If `DEFAULT_MODEL_PROVIDER=auto`, the Info page shows an auto routing preview for `fast`, `standard`, and `reasoning` stages. It also shows an available-provider status table with safe details for each provider: whether required config exists, whether an API key or auth path is configured, the selected model, base URL, AWS profile/region, and readiness details. The preview uses the same readiness checks as worker execution, including AWS Bedrock checks, so Bedrock appears in the route only when AWS credentials are currently usable.

The Info page also includes routing controls. They write safe, non-secret values back to `.env`: `DEFAULT_MODEL_PROVIDER`, `AGENTFLOW_AUTO_PROVIDERS`, `AGENTFLOW_PROVIDER_FAST`, `AGENTFLOW_PROVIDER_STANDARD`, `AGENTFLOW_PROVIDER_REASONING`, `AGENTFLOW_FALLBACK_PROVIDER`, and `AGENTFLOW_QUALITY_THRESHOLD`. Use `auto` for a tier to let the priority list decide, or choose a concrete provider to force that tier.

The detail page shows:

- run status, project, workflow, and task
- decision-ready summary
- cost, routing, fallback, latency, and quality metrics
- estimated compact prompt tokens and indexed-context tokens avoided
- stage results
- receipts
- artifact JSON viewers
- fixed follow-up buttons
- worker controls for processing the next batch or running until complete with a bounded timeout

The dashboard home page includes a Usage & Performance panel across recent runs. It summarizes run status, routed model stages, provider/cost/tier mix, average latency, estimated compact prompt tokens, and estimated tokens saved by loading compiled briefs instead of the full indexed project context. These token values are planning estimates, not provider billing records.

Mock provider runs are excluded from Usage & Performance cost metrics by default because they are test-only and not cost comparable. Use the Include Mock/Test Runs toggle when debugging workflow mechanics, CI, smoke tests, or queue/worker behavior.

The Projects page lists known projects from local enterprise storage. It shows each project's indexed files, indexed token estimate, memory count, run counts, latest run, and last index time. Open a project to inspect context files, recent runs, indexed summaries, memory, and project-scoped quick actions such as Index Project, UX Pass, Review, Production Readiness, and Maintain Context.

The Queue page shows queued, running, and failed workflow runs that need attention. Use Process Worker Batch to run the next available stages when no daemon is running, Requeue Running to unlock stages left running after an interrupted worker, Retry Failed to requeue failed stages, and Cancel to stop queued or running work.

The dashboard home page includes a Run Workflow panel. Select a workflow, project path, and task, then queue the run from the browser. The run detail link is returned immediately; process queued stages with `npm run worker -- --limit 6`. Enable Run and watch to process a bounded worker pass in the browser request; tune the worker limit and timeout fields for short local runs.

Queued and running run-detail pages auto-refresh every five seconds. Use Process Next Batch for a single worker tick, or Run Until Complete for a bounded watch pass.

If an agent asks for a command or file write outside the project policy, Agent Workflow records an action rejection receipt and artifact. The blocked action is not executed. Rejected optional actions do not fail the stage by themselves; allowed commands that run and exit nonzero still fail the stage.

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

## 10. MCP Prompt Examples

After adding the MCP server to VS Code, Cursor, Codex, or another MCP-capable client, use prompts like:

```text
Use Agent Workflow to run-and-watch review-pr on this project for "Review the current changes" and return the exported report.
```

```text
Use Agent Workflow to have Mira do a UX pass on this app and export the report.
```

```text
Use Agent Workflow to orchestrate this project for production readiness, UX, SEO, mobile experience, security, and launch risks.
```

```text
Use Agent Workflow to update my model provider to BYO and run a provider check.
```

```text
Use Agent Workflow to run debug-failure for the latest failed test run, inspect artifacts, and summarize next fixes.
```

```text
Use Agent Workflow to maintain project context after these recent architecture changes.
```

```text
Use Agent Workflow to index this repo and run build-feature for "Add audit logging".
```

## 11. MCP Tools

MCP clients can call these tools:

```text
agentflow_doctor
agentflow_validate
agentflow_list
agentflow_onboard_project
agentflow_index_project
agentflow_compile
agentflow_run_workflow
agentflow_run_and_watch
agentflow_agent_task
agentflow_summarize_run
agentflow_schedule
agentflow_worker
agentflow_status
agentflow_quality_report
agentflow_feedback
agentflow_preference_scorecard
agentflow_tuning_proposals
agentflow_artifacts
agentflow_export_run
agentflow_provider_check
agentflow_provider_use
agentflow_provider_smoke
```

`agentflow_run_workflow` processes worker stages by default when called through MCP so Codex, Cursor, and VS Code do not leave runs stuck in `queued`. Pass `queueOnly=true` only when you intentionally want to queue work for a separately running worker.

Tool definitions and input schemas live in:

```text
apps/mcp/src/index.ts
```

## 12. Storage And Reset

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

## 13. Provider Checks

Check the configured provider:

```bash
npm run provider-check
```

Run a provider contract smoke test:

```bash
npm run provider-smoke
```

## 14. Adaptive Routing

The `run-and-watch`, `agent-task`, `preset`, `orchestrate`, `summarize-run`, `onboard-project`, project-local agents, schedules, dashboard commands, adaptive model routing, quality scoring, and cost/quality reporting are now implemented.

Adaptive routing lets Agent Workflow start with cheaper BYO/local models, promote hard stages to stronger models, retry low-quality outputs through a fallback provider, and record which agent/model combinations produce the best accepted results.

Configure it with:

```bash
DEFAULT_MODEL_PROVIDER=auto
AGENTFLOW_AUTO_PROVIDERS=byo,bedrock,openai,openai-compatible,kiro
AGENTFLOW_FALLBACK_PROVIDER=openai
AGENTFLOW_QUALITY_THRESHOLD=0.62
```

Or configure explicit tier routing:

```bash
DEFAULT_MODEL_PROVIDER=byo
AGENTFLOW_ROUTING_MODE=adaptive
AGENTFLOW_PROVIDER_FAST=byo
AGENTFLOW_PROVIDER_STANDARD=byo
AGENTFLOW_PROVIDER_REASONING=openai
AGENTFLOW_FALLBACK_PROVIDER=openai
AGENTFLOW_QUALITY_THRESHOLD=0.62
```

Each worker stage records:

```text
- per-stage selected provider/model and reason
- estimated cost, latency, and retry count
- output quality score and acceptance status
- fallback model used when the first provider fails or returns weak output
- durable preference notes that shaped the result
```

## 15. Feedback Memory

Record whether a run was useful:

```bash
npm run agentflow -- feedback --run <run-id> --rating accepted --note "Good scope and routing"
npm run agentflow -- feedback --run <run-id> --rating revised --note "Needed more frontend context"
npm run agentflow -- feedback --run <run-id> --rating rejected --note "Wrong files were prioritized"
```

The dashboard run page also includes Accept, Mark Revised, and Reject buttons. Feedback is stored as a normal receipt/artifact and as compact project memory, so future routing and personalization can use it without adding project-local prompt bloat.

Compiled briefs include recent feedback as adaptive preference notes. If prior feedback includes revised or rejected outcomes, adaptive routing conservatively promotes fast stages to standard and records that decision in the `model_route` receipt and quality report. Compiled briefs also include approved project-local tuning notes from `.agent-workflow/tuning/agent-notes.md`, `context-budget-notes.md`, and `routing-preferences.md` with a small context cap.

## 16. Preference Scorecard

Aggregate feedback by workflow, stage, agent, provider, and model tier:

```bash
npm run agentflow -- preference-scorecard --project /path/to/project --limit 25
```

The dashboard run page also shows a compact scorecard for the run's project. Use it to find combinations that repeatedly need revision, fallback often, or produce low quality scores.

## 17. Tuning Proposals

Turn scorecard findings into reviewable prompt, context-budget, and routing suggestions:

```bash
npm run agentflow -- tuning-proposals --project /path/to/project --limit 25
```

The dashboard run page also shows a compact tuning proposal panel for the run's project. These are reviewable hints, not automatic edits.

## 18. Apply Tuning Proposals

Create project-local overlays from selected tuning proposals without changing shared reusable agents or workflows:

```bash
npm run agentflow -- queue-tuning-approvals --project /path/to/project --ids all
npm run agentflow -- queue-tuning-approvals --project /path/to/project --ids all --write
npm run agentflow -- tuning-approvals --project /path/to/project
npm run agentflow -- tuning-approvals --project /path/to/project --approve tune-001 --reviewer "Your Name" --note "Looks safe"
npm run agentflow -- generate-tuning-patches --project /path/to/project
npm run agentflow -- generate-tuning-patches --project /path/to/project --write
npm run agentflow -- apply-tuning-patches --project /path/to/project
npm run agentflow -- apply-tuning-patches --project /path/to/project --write
npm run agentflow -- apply-tuning-proposals --project /path/to/project --ids all
npm run agentflow -- apply-tuning-proposals --project /path/to/project --approved
npm run agentflow -- apply-tuning-proposals --project /path/to/project --ids tune-001,tune-004 --write
```

Without `--write`, the command is a dry run and prints the files it would create. With `--write`, Agent Workflow writes:

- `.agent-workflow/tuning/proposals.md`: human-readable selected proposals and patch hints.
- `.agent-workflow/tuning/proposals.json`: structured overlay data for IDEs, MCP clients, dashboards, or future automation.
- `.agent-workflow/tuning/approval-queue.md`: human-readable proposal approval queue.
- `.agent-workflow/tuning/approval-queue.json`: structured approval queue with pending, approved, and rejected decisions.
- `.agent-workflow/tuning/patches/`: reviewable patch-plan files generated only from approved proposals.
- `.agent-workflow/tuning/applied-patches.md`: applied local tuning-note ledger.
- `.agent-workflow/tuning/agent-notes.md`, `context-budget-notes.md`, and `routing-preferences.md`: project-local notes grouped by patch kind.

Use `queue-tuning-approvals` to stage recommendations for review, `tuning-approvals` to approve or reject selected proposal ids, `generate-tuning-patches` to create reviewable patch-plan files, and `apply-tuning-patches` to write project-local tuning notes that future compiled briefs will read. Use `apply-tuning-proposals --approved` only when you also want overlay files for external tools or manual review.

The dashboard tuning panel includes a Dry Run Apply button. The MCP tools `agentflow_queue_tuning_approvals`, `agentflow_tuning_approvals`, `agentflow_generate_tuning_patches`, `agentflow_apply_tuning_patches`, and `agentflow_apply_tuning_proposals` expose the same behavior for Codex, VS Code, Cursor, or any MCP-capable client.

## 19. Recommended Next Improvement

The next best improvement is production, staging, and local policy profiles. See the [Roadmap](roadmap.md) for the shared-platform implementation sequence.
