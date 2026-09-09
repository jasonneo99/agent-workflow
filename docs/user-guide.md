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
npm run migrate-storage
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
BYO_MODEL_NAME=auto
BYO_MODEL_API_KEY=not-required
```

Use OpenAI only when you intentionally want direct OpenAI API execution:

```env
DEFAULT_MODEL_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=auto
```

## 2. Smoke Test

Run the full local smoke test:

```bash
npm run smoke
```

This verifies Docker services, workflow definitions, queueing, storage, receipts, artifacts, and worker execution.

`npm run bundle-manifest` prints the versioned reusable agent/workflow bundle manifest. Run `npm run bundle-manifest -- --write` after changing shared files under `agents/` or `workflows/`; `npm run validate` checks the committed manifest checksum.

`npm run agentflow -- bundle-compat` checks the committed bundle against the
current runtime, Node.js, MCP requirements, and migration notes. Use
`--runtime-version`, `--node-version`, or `--mcp-version` to test another target
environment before sharing a bundle.

`npm run agentflow -- bundle-upgrade-preview --project /path/to/project`
previews migration notes and safe actions for a project without changing files.
When available, it reads `.agent-workflow/bundle-state.json`; otherwise use
`--from-version` and `--from-checksum` to compare against a known source bundle.
`npm run agentflow -- definition-migrations --project /path/to/project`
adds concrete definition changes, upgrade steps, validation commands, and
rollback guidance from the shared migration catalog.
After reviewing the preview, run
`npm run agentflow -- bundle-adopt --project /path/to/project --force` to record
the current bundle as the new local baseline.

The dashboard bundles page shows the same adoption readiness checks in one
place:

```bash
npm run dashboard
# open /bundles?project=/path/to/project
```

Use it to inspect bundle trust, runtime compatibility, upgrade status,
definition migration guidance, lifecycle command plans, and mock-provider
contract-test readiness without changing project files unless you explicitly
write a reviewed lifecycle plan.

## 3. Use From An MCP Client

Agent Workflow can run from VS Code, Cursor, Codex, or another MCP-capable client. The client only launches the local MCP server; model/provider selection stays in Agent Workflow's `.env`.

See [MCP Client Setup](mcp-clients.md) for config examples.

## 3a. Local-First Versus Server Mode

The recommended developer workflow is local-first: the CLI, MCP stdio server,
dashboard, worker, and enterprise storage run on the developer machine. This is
the safest default for Codex, VS Code, Cursor, and other local agent clients
because project files, provider credentials, and action approvals stay local.

Future governed server mode is an explicit opt-in path for teams that want a
shared Agent Workflow runtime on a trusted network. Binding the dashboard to a
network interface is not enough to enable server mode. Server mode requires a
separate contract for authentication, registered project ids, role checks,
project policy rechecks, idempotency, audit receipts, and safe network/storage
boundaries.

Read [Governed Server Mode](server-mode.md) before exposing Agent Workflow
outside one local machine.

Inspect the current local readiness posture:

```bash
npm run server-readiness
npm run server-readiness -- --json
npm run server-readiness -- --project /path/to/project
npm run server-projects
npm run server-projects -- --json
npm run server-resolve-project -- --project-id <project-id>
npm run server-request-preview -- --project-id <project-id> --workflow review-pr --task "Review the current changes"
npm run server-route-preview -- --project-id <project-id> --workflow review-pr --task "Review the current changes"
npm run server-approval-preview -- --project-id <project-id> --approval-id <approval-id> --decision approve-and-execute
```

The command is read-only. It reports server-mode opt-in state, bind/port, auth
mode, whether a token is configured, allowed origins, enterprise service
reachability, registered projects, role enforcement, endpoint classes, and
recommended next commands. It does not enable server mode or expose remote
workflow execution. `server-projects` previews the project IDs future
server-mode clients should send instead of raw filesystem paths; local roots are
hidden unless `--include-roots` is explicitly provided. `server-resolve-project`
resolves a single registered project id and rejects path-shaped input.
`server-request-preview` validates the future remote request envelope, including
project id, workflow id, actor role, auth posture, and idempotency, but never
queues a workflow. `server-route-preview` turns a valid preview envelope into
an internal dry-run route and command preview while still refusing blocked
requests. `POST /api/server-queue` accepts the same registered-project request
shape with bearer-token or OIDC-proxy auth. It previews by default and only
queues when `execute=true`, `AGENTFLOW_SERVER_MODE=1`, and
`AGENTFLOW_SERVER_ENABLE_QUEUE=1`. Executed queue requests record actor, role,
auth method, project id, workflow id, and idempotency details as run receipts;
repeat requests with the same idempotency key reuse the existing run. The queue
endpoint also enforces `AGENTFLOW_SERVER_MAX_BODY_BYTES` and
`AGENTFLOW_SERVER_RATE_LIMIT_PER_MINUTE` before queueing.
`server-approval-preview` and `/api/server-approval-preview` provide the same
dry-run contract for future approval decisions and action execution. They check
registered project ownership, actor role capability, separation of duties,
policy recheck posture, auth, and idempotency without mutating approval state.
`server-approval-action` and `POST /api/server-approval-action` validate the
future remote approval/action endpoint contract with the same checks plus
request limits and rate limiting. The endpoint is mutation-disabled in this
release, so it records dry-run evidence but does not approve, reject, execute,
dismiss, or add always-approved rules.

`server-approval-action-plan` and `/api/server-approval-action-plan` show the
per-decision receipt, idempotency replay, and rollback-evidence checklist that
must be implemented before `AGENTFLOW_SERVER_ENABLE_APPROVAL_ACTIONS=1` can
mutate approval state. Use it when deciding whether a server-mode approval
client is ready to move beyond preview-only behavior.

`server-approval-action-test-adapter` and
`/api/server-approval-action-test-adapter` exercise the same contract with
fixture approvals in memory. They prove duplicate idempotency-key replay returns
the original receipt shape and does not run a simulated side effect twice.
Nothing live is approved, executed, dismissed, written, or sent over the
network.

See [Governed Server Mode](server-mode.md#local-verification-walkthrough) for a
copyable end-to-end local smoke test.

### Shared Storage Migration Planning

Use `storage-migrate` when you want to move local enterprise storage to a
trusted shared state-plane host such as a LAN or Tailscale machine running
Postgres, Redis, and MinIO.

Preview the current machine to a shared host without copying data:

```bash
npm run storage-migrate -- --target-host ${AGENTFLOW_SHARED_STORAGE_HOST}
```

Write a reviewed operator package:

```bash
npm run storage-migrate -- --target-host ${AGENTFLOW_SHARED_STORAGE_HOST} --write-plan
```

That writes Markdown, JSON, and a guarded shell script under
`.agent-workflow/migrations/`. Reports redact credentials. The generated shell
script still requires source and target environment variables and exits unless
`AGENTFLOW_EXECUTE_STORAGE_MIGRATION=1` is set.

You can also set a reusable shared state-plane host in `.env`:

```bash
AGENTFLOW_SHARED_STORAGE_HOST=storage.example.internal
```

Then run:

```bash
npm run storage-migrate -- --write-plan
```

Use the Tailscale MagicDNS name or IP that actually reaches the storage ports.
On some networks a `.local` hostname resolves to a LAN address while the
Agent Workflow services are exposed only over Tailscale.

Use explicit target URLs when the shared host does not use the default local
developer ports:

```bash
npm run storage-migrate -- \
  --target-database-url postgres://agentflow:agentflow@${AGENTFLOW_SHARED_STORAGE_HOST}:15432/agentflow \
  --target-redis-url redis://${AGENTFLOW_SHARED_STORAGE_HOST}:16379 \
  --target-object-storage-endpoint http://${AGENTFLOW_SHARED_STORAGE_HOST}:19000 \
  --target-object-storage-bucket agentflow-artifacts \
  --write-plan
```

The first supported execution shape is copy into an empty target. Merge-safe
migration is intentionally preview-only until project/run id mapping, artifact
verification, rollback, and destination-preservation checks are implemented.
If source and target resolve to the same storage endpoints, the plan is blocked;
that usually means the current machine is already using the shared state plane.
If the target already contains Agent Workflow rows, copy mode is blocked too.
Use a merge preview to inspect old local storage against an existing shared
target without overwriting newer shared history:

```bash
npm run storage-migrate -- --mode merge-preview --write-plan
```

The merge-preview package includes Markdown and JSON preflight evidence plus a
non-executing shell script that explains why a merge-safe importer is required.

For an existing shared target, the next proof step is a row-level merge
manifest:

```bash
npm run agentflow -- storage-merge-manifest \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url postgres://agentflow:agentflow@${AGENTFLOW_SHARED_STORAGE_HOST}:15432/agentflow \
  --write
```

`storage-merge-manifest` is read-only. It maps projects by `root_uri`, keeps
existing shared project ids as the destination identity, and counts source-only,
existing, conflicting, and project-id-rewrite rows for projects, indexed files,
index state, workflow runs, workflow tasks, action receipts, approvals,
artifacts, and memory items. Use this before any future write-capable merge
importer.

Dry-run the reviewed manifest before writing:

```bash
npm run agentflow -- storage-merge-import \
  --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url postgres://agentflow:agentflow@${AGENTFLOW_SHARED_STORAGE_HOST}:15432/agentflow
```

After backing up both databases, execute the insert-only merge:

```bash
npm run agentflow -- storage-merge-import \
  --manifest .agent-workflow/migrations/storage-merge-manifest-YYYY-MM-DDTHH-MM-SS.json \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url postgres://agentflow:agentflow@${AGENTFLOW_SHARED_STORAGE_HOST}:15432/agentflow \
  --execute
```

The importer does not overwrite shared storage. Existing/conflicting target
rows are skipped, while source-only historical runs, tasks, receipts,
approvals, artifacts, memory, and index rows are inserted with project ids
rewritten through `root_uri` when needed.

Post-merge evidence classifies the conflicts that remain after an insert-only
merge. `projects` conflicts are critical because an operator must choose the
canonical project record before shared storage is considered proven primary.
`project_files` and `project_index_state` conflicts are refreshable index/cache
evidence; regenerate project indexes on shared storage after switch-over rather
than overwriting durable history.
`action_approvals` conflicts are warnings when source-only approvals are gone
and matching durable run, task, receipt, artifact, and memory evidence has no
conflicts. In that case shared storage preserves the target approval lifecycle
state and still surfaces the drift for audit.

Inspect post-merge evidence:

```bash
npm run agentflow -- storage-project-conflicts \
  --source-database-url postgres://agentflow:agentflow@127.0.0.1:15432/agentflow \
  --target-database-url "$DATABASE_URL"
```

Use `storage-project-conflicts` when the evidence report shows critical
`projects` conflicts. It is read-only and produces a compact source/target
comparison plus a decision-record template.

After review, record the decision as local migration evidence:

```bash
npm run agentflow -- storage-project-decision \
  --root /path/to/project \
  --action preserve-target-project \
  --source-project-id <source-id> \
  --target-project-id <target-id> \
  --note "Reviewed source/target metadata; shared target is canonical."
```

```bash
npm run storage-merge-evidence
npm run object-artifact-proof
npm run object-artifact-proof -- --enumerate-buckets
```

`object-artifact-proof -- --verify` and `--enumerate-buckets` use local MinIO
Client (`mc`) when present and fall back to Docker `minio/mc` when Docker is
available. The report prints the verifier mode so switch-over evidence is
auditable even on machines without a local `mc` install.
`npm run bootstrap-storage` uses the same path to ensure the configured object
bucket exists.

Inspect fallback posture:

```bash
npm run offline-fallback
```

When shared storage is healthy, local Docker storage can stay stopped. If shared
storage is down, start local fallback services with
`docker compose -f infra/docker-compose.yml up -d`, switch the environment to
localhost storage URLs, run offline work, and sync back with the same merge
manifest/import flow when shared storage returns. Background auto-sync is a
future enhancement; today the sync path is explicit and auditable.

The Server Readiness dashboard includes a Primary State Plane panel for this
operator view. It summarizes whether shared host/shared storage is the primary state
plane, whether localhost storage is fallback-only, how many offline sync items
are pending, and which warning rows are informational rather than blockers.

You can also record the fallback lifecycle so the dashboard keeps an operator
queue:

```bash
npm run offline-fallback -- --record start-local --note "Shared storage unavailable"
npm run offline-fallback -- --record offline-run --project /path/to/project --run-id <run-id>
npm run offline-fallback -- --record sync-back --note "Ready to merge back into shared storage"
npm run offline-sync
npm run offline-sync -- --scheduler-check
npm run offline-sync -- --scheduler-check --scheduler-execute
npm run offline-sync -- --execute
```

For a supervised local install, `learning-daemon --offline-sync-execute` or
`AGENTFLOW_OFFLINE_SYNC_AUTO_EXECUTE=1` lets the daemon run the same insert-only
sync when both localhost fallback storage and shared storage are reachable. The
dashboard shows whether the scheduler is in `dry-run` or `execute` mode.

After a migration copy, compare durable source and target state:

```bash
npm run storage-verify -- --target-host ${AGENTFLOW_SHARED_STORAGE_HOST}
npm run storage-verify -- --target-host ${AGENTFLOW_SHARED_STORAGE_HOST} --json
```

`storage-verify` checks service reachability and compares durable table counts
and fingerprints for agents, workflows, projects, project files, index state,
workflow runs, workflow tasks, action receipts, approvals, artifacts, and memory
items. It is read-only. If source and target are the same shared storage plane,
the report returns `attention` instead of pretending it verified a migration
copy.

The same verification summary appears on the dashboard Server page:

```bash
npm run dashboard
open http://127.0.0.1:17888/server-readiness
```

The Server page also lists generated operator packages from
`.agent-workflow/migrations/` under Storage Migration Plans, including generated
time, blocked/ready status, warning count, markdown report path, and guarded
script path. Use `/api/storage-migrations` for the same metadata as JSON.

## 3b. Optional Codex Plugin

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
It also records `.agent-workflow/bundle-state.json`, which gives future
`bundle-upgrade-preview` runs a local baseline for migration notes and checksum
drift checks.

Enterprise mode is the default:

```bash
npm run init-project -- --project /path/to/project --profile enterprise
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

After a baseline exists, run an incremental refresh to process only changed,
staged, untracked, renamed, or deleted files:

```bash
npm run index-project -- --project /path/to/project --max-files 100 --incremental
```

For CI or pre-merge checks, pass the base commit explicitly:

```bash
npm run index-project -- --project /path/to/project --max-files 100 --incremental --since-commit origin/main
```

For local development, keep an incremental index loop running in a terminal:

```bash
npm run index-project -- --project /path/to/project --incremental --watch --interval-ms 10000
```

`run-and-watch`, `agent-task`, dashboard run actions, and MCP workflow tools use
incremental indexing automatically after the first successful baseline. Use
`--full-index` when you intentionally want to rebuild the stored context from
scratch, for example after changing include/exclude patterns.

Compiled briefs show a `Why selected` line for each indexed source summary.
Use those explanations to tune `--source-token-budget`, `--source-max-files`,
and project include/exclude patterns without guessing why context was loaded.

For large repos, start with a compact non-refined pass:

```bash
npm run index-project -- --project /path/to/project --max-files 100
```

Use provider-refined summaries only for smaller or targeted passes:

```bash
npm run index-project -- --project /path/to/project --max-files 40 --refine
```

## 5A. Discover Local Projects

Use `discover-projects` when you want Agent Workflow to find candidate projects
before deciding what to initialize or index:

```bash
npm run agentflow -- discover-projects --roots ~/Projects --spotlight auto
npm run agentflow -- discover-projects --roots ~/Projects,/Volumes/Work --max-depth 6 --max-candidates 300 --write
```

On macOS, `--spotlight auto` uses Spotlight metadata when `mdfind` is available,
then falls back to filesystem marker discovery. The command reads directory
names and marker files such as `package.json`, `pyproject.toml`, `go.mod`,
`AGENTS.md`, `.agent-workflow`, and `.git`; it does not index project contents.

For a whole-drive preview on macOS:

```bash
npm run agentflow -- discover-projects --roots / --spotlight auto --max-depth 6 --max-candidates 300 --write
```

Review the candidates before initializing or indexing. Default excludes skip
system, cache, dependency, backup, photo library, and private runtime
directories. Written reports stay under `.agent-workflow/discovery/` in the
Agent Workflow repo.

After review, adopt candidates explicitly. Dry-run first:

```bash
npm run agentflow -- adopt-discovered-projects --roots ~/Projects --all --index
npm run agentflow -- adopt-discovered-projects --roots ~/Projects --paths /path/to/project --initialize --index
```

Then add `--write` when you want Agent Workflow to act:

```bash
npm run agentflow -- adopt-discovered-projects --roots ~/Projects --paths /path/to/project --initialize --index --write
```

Initialization writes project-local Agent Workflow files. Indexing registers an
initialized project in local storage and stores compact source summaries. A
candidate must have `.agent-workflow/project.yaml` before content indexing runs.

The dashboard exposes the same dry-run report at:

```text
http://127.0.0.1:17888/discovery
http://127.0.0.1:17888/api/discovery
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

## 7. Preview Workflow Graphs

Before queueing work, inspect the workflow graph, stage patterns, agents,
subagents, context budgets, approval points, and selected policy profile:

```bash
npm run agentflow -- workflow-graph \
  --workflow build-feature \
  --project /path/to/project
```

Print machine-readable JSON or a renderable Mermaid flowchart:

```bash
npm run agentflow -- workflow-graph -w ship-release -p /path/to/project --json
npm run agentflow -- workflow-graph -w ship-release -p /path/to/project --mermaid
```

Use `--policy-profile staging` or `--policy-profile production` to preview
whether stricter execution policy would require approvals or block stages before
you run the workflow.

The local dashboard exposes the same inspection surface at
`/workflow-graph?workflow=build-feature&project=/path/to/project`. Use it when
you want a browser-readable graph of workflow stages, primary agents, subagents,
context budgets, approval points, pattern metadata, and policy fit before
spending live model tokens. Stage patterns classify work as single-shot,
planner, executor, ReAct, reflexive, verifier, or finalizer behavior, with
promotion gates where a stage feeds approval, evaluation, policy, or release
decisions. ReAct stages emit `react_loop_receipt` artifacts when they request
local commands or file writes, recording the observation source, action request,
policy decision, result receipt, iteration budget, and stop reason. Add
`&view=mind-map` to switch the dashboard visualization to a
presentation-friendly agent connection map, or `&view=network` for a high-
contrast neural-web SVG map. Network Map defaults to a horizontal developer
layout, and its orientation buttons can switch to `orientation=radial` for a
circular web with workflow core, stage ring, agent ring, and recent run-history
orbit. In the network map, luminous signal paths show stage-to-agent and
agent-to-run relationships, transparent nodes glow by type or status, stage
nodes are labeled by stage name, and node size grows with incoming request count
so heavily used agents, stages, and runs stand out. A compact explainer below
the map describes layer direction, solid and dashed signal paths, health rings,
and click targets for onboarding and screenshots. When selected runs include
task-level stage history, stage nodes also show a health ring for completed,
failed, queued/running, and cancelled task outcomes. Click a stage node to focus
recent run/task history for that workflow step, use **Suggest Fix** to queue a
targeted `debug-failure` run from that stage history, or click a run node to
open the run detail page, so the visual becomes a lightweight inspection
surface. Use `runScope=all-projects`, or the **All Stored Runs** quick action,
to include matching workflow runs from every registered project instead of only
the selected project. The selected project still provides the workflow policy
and graph definition, while run history expands across projects for portfolio-
level debugging and usage review. Suggested fix runs are tagged with their
source workflow and stage, so
the focused panel can show the stage health signal beside any related debug-run
outcomes on later visits. After a suggested fix completes, use **Rerun Source**
to queue the original workflow as a tagged verification run for before/after
stage-health comparison. The focused panel summarizes that comparison with
after-signal, completed-rate, failed-rate, and active-rate delta cards. Use
**Export Handoff** to save a Markdown and JSON snapshot of the selected graph
URL, filters, totals, pattern mix, run list, focused-stage deltas, and
stage-health summary under `.agent-workflow/exports/graphs/`. The dashboard also
shows a Recent Graph
Handoffs panel with prior project-local exports, their saved graph URLs, and the
Markdown/JSON paths for reopening or sharing a graph state during review. Click
**View** beside an export to inspect the saved Markdown handoff directly in the
dashboard. The Recent Graph Handoffs panel also includes copyable lifecycle
commands to inspect export storage, list recent files, preview stale prune
candidates, and package the graph handoff folder without deleting anything
implicitly. Use **Graph Presets** to save the current workflow, view,
orientation, filters, run scope, and run limit to project-local
`.agent-workflow/graph-presets.json`. Saved presets can be reopened or removed
from the graph page without editing shared workflows or global settings. Use
`runLimit=0` for definition-only diagrams or
raise the limit up to `250` when you want more historical runs in the graph. Use
the run-status quick links for developer triage: All Stored Runs shows matching
workflow history across every registered project, Active Runs shows
queued/running work for the selected project, Failed Runs turns the map into a
debugging surface, and Definition Only hides run history for clean architecture
snapshots. The page
also includes filters for agent category, approval requirement, and policy
status so larger workflows stay scannable. Add `&capture=1` for a clean
screenshot/print view that hides the dashboard navigation and form controls
while preserving the selected workflow, view, run limit, run status, and
filters.

![Workflow network map](assets/screenshots/dashboard-workflow-network.png)

![Workflow mind map](assets/screenshots/dashboard-workflow-mind-map.png)

Regenerate the committed dashboard screenshots after intentional visual changes:

```bash
npm run screenshots:dashboard
```

## 8. Editor Schema Validation

Agent Workflow ships JSON Schemas for reusable agents, workflows, project
config, schedules, and bundle state. List the schema paths:

```bash
npm run agentflow -- schemas
```

Write YAML schema associations for VS Code or Cursor:

```bash
npm run agentflow -- schemas --project /path/to/project --write-vscode
```

This merges `.vscode/settings.json` without removing existing settings. The
schema files stay in the shared Agent Workflow install, while project-specific
configuration remains in the target project's `.agent-workflow/` directory.

## 9. Run Workflows From CLI

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

The dashboard Agents page shows the same effective roster:

```bash
npm run dashboard
open "http://127.0.0.1:17888/agents?project=/path/to/project"
```

Run a project-local specialist exactly like a built-in agent:

```bash
npm run agentflow -- agent-task project-reviewer \
  --project /path/to/project \
  --task "Review this implementation against local architecture decisions"
```

List available presets:

```bash
npm run agentflow -- preset --list
```

Run a natural-language orchestration:

```bash
npm run agentflow -- orchestrate \
  --project /path/to/project \
  --task "Review this project and identify release risks"
```

Preview the plan before running it:

```bash
npm run agentflow -- orchestrate \
  --project /path/to/project \
  --task "Review this project and identify release risks" \
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

## 10. Schedules

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

## 11. Dashboard

Start the recommended local developer supervisor:

```bash
npm run dev:agentflow
```

This starts the dashboard when port `17888` is free, starts the background
worker, starts the local learning daemon, and writes a supervisor heartbeat to
`.agent-workflow/runtime/supervisor-heartbeat.json`. Local Docker storage starts
only when configured storage URLs are localhost. If you are pointed at shared
storage, such as shared host over Tailscale, local storage stays stopped unless you set
`AGENTFLOW_START_LOCAL_STORAGE=1`.

Stop the supervised dashboard, worker, and learning daemon:

```bash
npm run dev:agentflow:stop
```

This leaves Docker services alone. If local Docker storage is running and you do
not need localhost fallback, stop it with `docker compose -f infra/docker-compose.yml stop`.

On macOS, install Agent Workflow as a durable per-user LaunchAgent when you want
it to start at login and restart after crashes or terminal closes:

```bash
npm run dev:agentflow:launchd:install
```

The LaunchAgent runs the same `dev:agentflow` supervisor, so it manages the
dashboard, worker lanes, learning daemon, and local Docker storage only when the
configured storage URLs are localhost or `AGENTFLOW_START_LOCAL_STORAGE=1`.
Its plist invokes a repository-owned wrapper through macOS `/bin/zsh`; that
wrapper resolves the current stable `node` executable on every start instead of
pinning a versioned Homebrew Cellar path. Refreshing after an upgrade therefore
does not depend on the previous Node installation remaining present.
The LaunchAgent intentionally does not embed `.env` secrets in its plist; the
supervisor reads `.env` from the repo at runtime. Launch logs are written under
`.agent-workflow/runtime/launchd/`. Uninstall it with:

```bash
npm run dev:agentflow:launchd:uninstall
```

Keep local inference in a separate failure domain. After Ollama is installed,
create its dedicated Agent Workflow LaunchAgent with:

```bash
npm run local-model:launchd:install
npm run local-model:status -- --json
```

The wrapper resolves the current stable Homebrew Ollama symlink each time it
starts, avoiding a versioned Cellar path after upgrades. It binds only to the
loopback host configured by `LOCAL_MODEL_BASE_URL`, logs under
`.agent-workflow/runtime/local-model/`, and remains isolated from the main
dashboard, workers, and learning-daemon supervisor. Refresh it after changing
the endpoint. `npm run local-model:launchd:uninstall` removes the service but
leaves downloaded models intact.

The Settings page shows the LaunchAgent label, plist path, PID, launch run
count, and log links. Use **Install / Refresh** after changing `.env`,
upgrading Agent Workflow, or changing the durable project. Use **Uninstall** to
return to terminal-only supervision.

When shared storage contains runs created on another host, keep local project
actions pointed at the checkout on the current machine with a project path map:

```bash
AGENTFLOW_PROJECT_PATH_MAP=/remote/projects=/local/projects
```

Agent Workflow also auto-detects the common `/home/<user>` to `/Users/<user>`
case when the mapped checkout exists. The stored `root_uri` is preserved for
audit history; only local config reads, approved command cwd, approved file
writes, and stale-input checks use the resolved local path.

The Learning page is project-scoped. A selected project can show historical
learning evidence while its daemon status says `missing` if the durable
supervisor is pinned to a different project. By default the durable supervisor
uses `AGENTFLOW_LEARNING_SCOPE=all-projects`, so one daemon iterates every
registered local project and writes each project's own
`.agent-workflow/learning/` heartbeat and reports. Use **Watch All Projects** to
restore that mode, or **Watch This Project** to pin the daemon to only the
selected project.

Set `AGENTFLOW_LEARNING_DAEMON=0` before installing or launching if you want the
dashboard and worker without the local learning loop.

Open:

```text
http://127.0.0.1:17888
```

Manual mode is still available. Start only the local run dashboard with:

```bash
npm run agentflow -- dashboard
```

Then start a background worker in a second terminal:

```bash
npm run worker:daemon
```

The daemon continuously processes queued stages and writes a heartbeat to `.agent-workflow/runtime/worker-heartbeat.json`. The dashboard uses that heartbeat to show whether the worker is running, stale, stopped, or missing.

Workers can be named for lease ownership visibility:

```bash
npm run worker -- --watch --limit 6 --worker-id local-dev
```

Workers can also be scoped to one project and allowed to claim a bounded number
of stages concurrently:

```bash
npm run worker -- --watch \
  --project /path/to/project \
  --limit 12 \
  --concurrency 3 \
  --worker-id local-dev
```

Projects can store their preferred local worker defaults in
`.agent-workflow/project.yaml`:

```yaml
execution:
  worker_pool:
    worker_id: local-dev
    limit: 6
    concurrency: 1
    lease_seconds: 900
    interval_ms: 2000
    project_scoped: true
    default_profile: local
    profiles:
      local:
        description: Default single-lane local developer worker pool.
        lanes:
          - id: default
      split-review:
        description: Separate implementation and review lanes for local development.
        lanes:
          - id: implementation
            worker_id: implementation-lane
            limit: 6
            concurrency: 2
          - id: review
            worker_id: review-lane
            limit: 3
            concurrency: 1
```

Then a worker can use those defaults with:

```bash
npm run worker -- --watch --project /path/to/project
```

Explicit flags override project defaults. Use `--all-projects` only when you
want to load a project's worker defaults but allow the worker to claim from the
global queue.

Start the dashboard and every lane from a named profile with one supervisor
command:

```bash
AGENTFLOW_PROJECT=/path/to/project \
AGENTFLOW_WORKER_POOL_PROFILE=split-review \
npm run dev:agentflow
```

The supervisor starts one worker process per lane, writes lane heartbeats, and
restarts lanes if a managed worker process exits while the supervisor is still
running.

`--limit` is the maximum number of stages a worker tick may process. `--concurrency`
is how many of those stages may run at the same time, capped at `16` for local
developer safety. A project-scoped worker only claims stages whose run belongs
to that project root, which keeps queues isolated when the same local storage is
serving multiple repositories.

Multiple workers can run side by side when you want separate local lanes:

```bash
npm run worker -- --watch --worker-id frontend-lane --project /path/to/site --concurrency 2
npm run worker -- --watch --worker-id review-lane --project /path/to/api --concurrency 1
```

When a worker claims a stage, enterprise storage records the worker id and a
lease expiration timestamp. The Queue page shows the current running stage,
owning worker, and lease deadline so interrupted work is easier to diagnose.
The Settings page shows the active worker's project scope and concurrency from
the heartbeat file. When multiple workers write heartbeats, it also lists the
discovered worker lanes from `.agent-workflow/runtime/workers/`.

Recover tasks owned by interrupted workers after their lease expires:

```bash
npm run agentflow -- recover-leases
npm run agentflow -- recover-leases --run <workflow-run-id>
```

The command only requeues `running` tasks whose `lease_expires_at` timestamp is
already in the past. It writes an audit receipt for each affected run. The Queue
page shows **Recover Expired Leases** when expired leases are present.

Dashboard and JSON endpoints:

```text
/api/runs
/api/settings
/api/workflow-graph
/api/bundle-lifecycle-plan
/api/server-readiness
/api/server-projects
/api/server-project?projectId=<project-id>
/api/server-request-preview?projectId=<project-id>&workflow=<workflow-id>&task=<task>
/api/server-route-preview?projectId=<project-id>&workflow=<workflow-id>&task=<task>
/api/server-approval-preview?projectId=<project-id>&approvalId=<approval-id>&decision=<decision>
/api/server-queue
/api/server-request-log
/api/role-audit-export
/role-audit?file=<snapshot.md>
/api/queue
/api/projects
/api/agents?project=<project-root>
/api/run?id=<run-id>
/api/quality?id=<run-id>
```

`/api/server-request-log` and `agentflow server-request-log` show redacted
append-only audit events for governed `/api/server-queue` requests. They keep
request status, auth outcome, rate-limit decision, project id, workflow id, and
run id evidence while hashing task text, actor, idempotency key, local root,
client address, origin, and user-agent values.

Run detail pages:

```text
/settings
/workflow-graph
/queue
/providers
/roles
/role-audit?file=<snapshot.md>
/server-readiness
/projects
/agents
/project?root=<project-root>
/runs
/run?id=<run-id>
```

The dashboard uses a left navigation rail for the main control surfaces: Dashboard, Queue, Projects, Agents, Runs, Evaluations, Graph, Governance, Roles, Backup, Server, Artifacts, Providers, and Settings. The Agents page shows shared reusable agents, project-local agents from `.agent-workflow/agents`, and the effective roster for the selected project. The home page includes System Health cards for the supervisor, worker, queue, selected provider, enterprise storage, known projects, and the latest failed run. The Needs Attention panel turns those signals into direct next actions. The Roles page can export the active role filters as local Markdown and JSON audit snapshots, then reopen recent snapshots without leaving the dashboard.

![Dashboard home](assets/screenshots/dashboard-home.png)

The Settings page shows safe local runtime details: selected provider summary, enterprise service reachability, supervisor heartbeat, worker heartbeat, bundle manifest checksum, storage configuration presence, and useful local commands. It does not print secret values.

![Dashboard settings](assets/screenshots/dashboard-settings.png)

The Server page shows the same read-only server-mode readiness report as the
CLI. It is useful before experimenting with shared team operation because it
calls out loopback versus network binding, auth posture, registered projects,
role enforcement, endpoint classes, auth-hardening blockers, storage
reachability, and safe next commands.

The dashboard home page and Settings page include Local Supervisor and Background Worker status. Settings also includes macOS LaunchAgent status when running on macOS. If the LaunchAgent is missing, use **Install / Refresh** or run `npm run dev:agentflow:launchd:install`. If the supervisor says `missing`, `stopped`, or `stale`, run `npm run dev:agentflow` from the Agent Workflow repo. If only the worker is stale and you are in manual mode, run `npm run worker:daemon`. If a previous worker was interrupted while a stage was running, open `/queue` and use Requeue Running before processing again.

MCP clients use a separate stdio subprocess. If Codex, VS Code, Cursor, or
another client reports `Transport closed`, restart that client or task to create
a fresh MCP subprocess after checking Agent Workflow's side of the pipe. Run
`npm run runtime-monitor -- --check-mcp`, or open `/server-readiness` and use
the MCP Pipeline smoke action. Check `.agent-workflow/runtime/mcp/stdio.log` and
`.agent-workflow/runtime/mcp/launcher.log` for lifecycle breadcrumbs such as
launcher resolution, start, connect, stdin close, stdout error, and exit. These
logs are metadata-only and avoid `.env` values, provider keys, database URLs,
storage secrets, prompt bodies, and artifacts.

When the transport closes during an approval decision, prefer a narrow CLI
fallback scoped to the exact run or approval id:

```bash
npm run agentflow -- approvals --status pending --run <run-id>
npm run agentflow -- approvals --approve-execute <approval-id> --actor "Your Name" --actor-role approver
```

This keeps the workflow receipt trail intact while avoiding a stale
client-owned stdio connection.

When the active provider exposes a models endpoint, the Info page also lists available models and lets you update the active model without editing `.env` manually. The selector writes the provider-specific model variable, such as `OPENAI_MODEL`, `LOCAL_MODEL_NAME`, `BYO_MODEL_NAME`, `OPENAI_COMPATIBLE_MODEL`, or `BEDROCK_MODEL`. For OpenAI, `OPENAI_MODEL=auto` refreshes the live model catalog and chooses tier models automatically; exact `OPENAI_MODEL_*` values are only needed for pinned reproducible runs. Local runtimes use `LOCAL_MODEL_BASE_URL` and default to `http://localhost:11434/v1` for Ollama-compatible OpenAI endpoints. Model changes apply to new workflow tasks; restart long-running workers if they were already active.

The Providers page gives model/provider controls their own workspace. Use it to inspect the selected provider, update selectable model names, and tune provider routing by tier. It renders from local config first so the dashboard stays fast; run `npm run provider-check` when you want full live provider validation.

![Providers and model routing](assets/screenshots/dashboard-providers.png)

Open `/model-catalog` when you want to see why `auto` chose a model. It
refreshes live catalogs from configured providers and shows provider readiness,
model counts, tier selections, override source, estimated cost class, policy
score, tier fit, and top candidate rankings. Use `/api/model-catalog` for the
same data as JSON.

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
- checkpoint controls for resuming unfinished stages or replaying a run from stored run metadata

![Run detail page](assets/screenshots/dashboard-run-detail.png)

The dashboard home page includes a Usage & Performance panel across recent runs. It summarizes run status, routed model stages, provider/cost/tier mix, average latency, estimated compact prompt tokens, and estimated tokens saved by loading compiled briefs instead of the full indexed project context. These token values are planning estimates, not provider billing records.

Mock provider runs are excluded from Usage & Performance cost metrics by default because they are test-only and not cost comparable. Use the Include Mock/Test Runs toggle when debugging workflow mechanics, CI, smoke tests, or queue/worker behavior.

The Projects page lists known projects from local enterprise storage. It shows each project's indexed files, indexed token estimate, memory count, run counts, latest run, and last index time. Open a project to inspect context files, recent runs, indexed summaries, memory, and project-scoped quick actions such as Index Project, UX Pass, Review, Production Readiness, and Maintain Context.

![Projects page](assets/screenshots/dashboard-projects.png)

The Queue page shows queued, running, and failed workflow runs that need attention. Use Process Worker Batch to run the next available stages when no daemon is running, Recover Expired Leases to unlock only tasks whose worker lease has elapsed, Requeue Running to manually unlock all running stages for a run, Resume Checkpoint to preserve completed stages while requeueing unfinished or failed stages, Retry Failed to requeue only failed stages, and Cancel to stop queued or running work. Use Dismiss after reviewing a failure that should leave the active queue; this changes the run and all unfinished tasks to `dismissed` while preserving history, artifacts, and an audit receipt. Bulk dismissal requires explicit confirmation and can be filtered to one project path.

![Queue control panel](assets/screenshots/dashboard-queue.png)

The Approvals page shows pending, approved, and rejected agent-requested actions. When `require_approval_for_external_actions` is true, allowed command and file-write requests are written to the inbox instead of executed immediately. Approval decisions record receipts, but they do not bypass project policy.

Project-local team roles live in `.agent-workflow/project.yaml`:

```yaml
team:
  enforcement: preview
  default_actor_role: operator
  separation_of_duties:
    mode: off
    prevent_same_actor_approval_execution: true
  roles:
    operator:
      description: Runs local workflows and executes approved local actions.
      can_request_approvals: true
      can_execute_approved_actions: true
    approver:
      description: Reviews and decides pending approvals.
      can_approve_actions: true
      can_reject_actions: true
    workflow_author:
      description: Reviews or edits reusable/project-local workflow definitions.
      can_author_workflows: true
    auditor:
      description: Reviews evidence, receipts, exports, and governance reports.
      read_only: true
```

Approval decisions and execution receipts record the actor role for audit
visibility. The CLI and dashboard also show read-only role previews, such as
`approval decision expects approver` or `execution expects operator`, before any
role-based blocking exists. Role recording is intentionally lightweight in this
release; policy enforcement remains controlled by action policy, approval
requirements, and human review.

Open `/roles` in the dashboard to inspect project-local team configuration,
enforcement mode, role capabilities, recent approval decisions grouped by role,
and the latest approval activity. Filter by project, role, approval status, or
action type when you need a focused local audit view. `/api/roles` exposes the
same filtered data for local automation or IDE integrations.

Add `--export` to write a local Markdown and JSON audit snapshot under
`.agent-workflow/exports/roles/`. Use `--out <dir>` when you want a different
export location.

Projects that want role checks to block mismatched approval actions can opt in:

```yaml
team:
  enforcement: enforce
```

In `enforce` mode, request, approve, reject, and execute approval actions must
use a configured role with the matching capability. Action policy still applies
after role checks; roles do not bypass command or file-write guardrails.

Projects can also opt into separation-of-duties checks. `preview` records a
warning when the same actor approves and executes an action. `enforce` blocks
that execution and asks for a different executor. The default is `off` so
existing local workflows keep running after upgrades.

```yaml
team:
  separation_of_duties:
    mode: preview
    prevent_same_actor_approval_execution: true
```

CLI equivalents:

```bash
npm run agentflow -- approvals
npm run agentflow -- approvals --status all
npm run agentflow -- approvals --approve <approval-id> --actor "Your Name" --actor-role approver --note "Looks safe"
npm run agentflow -- approvals --approve-execute <approval-id> --actor "Your Name" --actor-role approver --note "Looks safe"
npm run agentflow -- approvals --auto-approve-execute --max-risk medium
npm run agentflow -- approvals --auto-approve-execute --max-risk medium --dry-run
npm run agentflow -- approvals --always <approval-id> --always-scope exact --actor "Your Name" --actor-role approver
npm run agentflow -- approvals --always <approval-id> --always-scope broad --actor "Your Name" --actor-role approver
npm run agentflow -- approvals --execute <approval-id> --actor "Your Name" --actor-role operator
npm run agentflow -- approvals --dismiss <approval-id> --actor "Your Name" --actor-role operator --note "Out of date"
npm run agentflow -- approvals --reject <approval-id> --actor "Your Name" --actor-role approver --note "Not needed"
npm run agentflow -- approval-rules --project /path/to/project
npm run agentflow -- approval-rules --project /path/to/project --remove <rule-id> --actor "Your Name"
npm run agentflow -- roles --project /path/to/project --limit 50
npm run agentflow -- roles --project /path/to/project --role approver --status approved
npm run agentflow -- roles --project /path/to/project --action local_command
npm run agentflow -- roles --project /path/to/project --role approver --status approved --export
npm run agentflow -- roles --project /path/to/project --json
```

When a workflow, worker, dashboard action, or MCP call creates a required
approval, Agent Workflow reports it back in that same context with the approval
id and next commands. Pending approvals are side-effect gates: the workflow may
continue around them, but the requested command, file write, deployment
decision, artifact lifecycle action, or autonomy change remains skipped until
you approve it. MCP clients such as Codex, VS Code, and Cursor should present
the returned approval id to the user, ask whether to approve and execute now,
approve only, reject, always approve the exact function call, always approve the
broad function family, or execute or dismiss an already approved action, then
call `agentflow_approvals` with the selected decision. For local inline
approvals, `approveAndExecute` is the recommended default for executable side
effects. Use approve-only when approval and execution should be handled by
different people or tools.

Deployment and autonomy approvals use the same inbox. They record a human
decision for a risky operation, but they do not execute a local command by
themselves. Run the actual deployment or autonomy-changing command separately
under project policy after approval.

```bash
npm run agentflow -- request-approval \
  --project /path/to/project \
  --type deployment \
  --target production \
  --actor-role operator \
  --rationale "Release candidate passed checks and needs owner approval."

npm run agentflow -- request-approval \
  --project /path/to/project \
  --type autonomy \
  --target "wide-open for local maintenance only" \
  --actor-role operator \
  --rationale "Owner-approved maintenance window for trusted local automation."
```

Use narrowly scoped approval rules for recurring low-risk local actions that should still be policy controlled but do not need a fresh click every time. Rules live in `.agent-workflow/project.yaml`, are included in each run's immutable policy snapshot, and only match actions that already pass `allowed_commands` or `allowed_write_paths` plus the blocklists.

For local developer setups that want more autonomy, approval autopilot can scan
pending approvals and already-approved unexecuted actions, then approve and
execute eligible low/medium local side effects:

```env
AGENTFLOW_APPROVAL_AUTOPILOT=on
AGENTFLOW_APPROVAL_AUTOPILOT_MAX_RISK=medium
```

When `AGENTFLOW_APPROVAL_AUTOPILOT=on`, the learning daemon runs the same
approval autopilot sweep on every `apply-approved` tick. Use
`AGENTFLOW_APPROVAL_AUTOPILOT=off` or the dashboard Learning settings when you
want observe-first approval review instead.

Autopilot still rechecks project policy, role gates, executable action type,
blocked command/path patterns, file byte limits, and secret-looking paths before
anything runs. Deployment decisions, autonomy changes, destructive prune,
provider/server/network commands, blocked policy actions, and high-risk items
remain human-gated. Already-approved stale file writes are also held for fresh
review so an old approval cannot overwrite newer docs or source.

Use the backlog radar when approvals look stuck or the dashboard shows warning
states:

```bash
npm run agentflow -- approval-backlog --project /path/to/project
npm run agentflow -- approval-backlog --status pending
npm run agentflow -- approval-backlog --status failed
npm run agentflow -- approval-backlog --stale-minutes 30 --json
```

The report includes pending, approved-but-not-executed, failed, stale, and
autopilot-blocked items. Pass `--status` to inspect the same status bucket as
the dashboard tab. The learning daemon writes the same warning/error counts into
its heartbeat so the Learning page can surface missed approval work.

The dashboard Approvals page can add these rules from a pending approval. It
shows function-style choices because agents request tool/function side effects,
not just raw strings. Use **Always shell** for the same command, **Always shell
prefix \*** for command families such as `shell npm run *`, **Always fswrite**
for the same file write, and **Always fswrite\*** for future file-write requests.
`fswrite*` still only applies to file writes that pass `allowed_write_paths`,
`max_file_write_bytes`, and blocklists. Adding a rule can approve the current
request, but already queued workflow runs keep their original policy snapshot;
future runs pick up the new project config.

Use the dashboard **Always Approved** page or `approval-rules` command to audit
and remove rules later. Removing a rule edits only that project's
`.agent-workflow/project.yaml`, validates the updated config, and makes future
matching actions ask for approval again unless another rule still matches.

```yaml
actions:
  allowed_commands:
    - npm test
    - npm run lint
  allowed_write_paths:
    - .agent-workflow/notes/**
  approval_rules:
    - id: local-tests
      description: Auto-execute the standard local test command.
      action_type: local_command
      target: npm test
      effect: auto_execute
    - id: workflow-notes
      description: Auto-execute small workflow note writes.
      action_type: file_write
      target: .agent-workflow/notes/**
      effect: auto_execute
      max_bytes: 4096
```

Keep approval rules exact and boring. A rule can reduce repeated approvals, but it should not be used to approve broad command families, deployment commands, secret-touching files, or production actions.

While the Queue page is open, a browser Web Worker watches `/api/queue` and refreshes the view only when task progress changes. It polls active queues every two seconds and backs off to ten seconds when idle. This watcher is read-only; the managed server-side worker remains responsible for claiming and executing tasks.

The dashboard home page includes a Run Workflow panel. Select a workflow, project path, and task, then queue the run from the browser. The run detail link is returned immediately; process queued stages with `npm run worker -- --limit 6`. Enable Run and watch to process a bounded worker pass in the browser request; tune the worker limit, worker concurrency, and timeout fields for short local runs.

Executor adapters are documented in [executor-adapters.md](executor-adapters.md). They provide opt-in, immutable, exact-revision routing for fixed registered operations; remote routing remains disabled by default.

Queued and running run-detail pages auto-refresh every five seconds. Use Process Next Batch for a single worker tick, Run Until Complete for a bounded watch pass, Resume Checkpoint to continue from the last completed stage, or Replay Run to create a fresh queued run from the source run's stored task, policy, provider overrides, workflow snapshot, and compiled context. Resume and replay actions run a stale-input check first. The check warns when project config, execution policy, bundle checksum, workflow definition, or selected source files differ from the evidence captured when the run was queued. Legacy runs created before input snapshots show a limited-check warning instead of pretending the inputs are known.

When a retried stage asks for the same successful command or file write again, Agent Workflow uses a deterministic action idempotency key to avoid repeating the side effect. The worker records a `local_command_reused` or `file_write_reused` receipt that points back to the original action artifact, preserving the audit trail without duplicating the command or write.

CLI equivalents:

```bash
npm run agentflow -- resume-run --run <id>
npm run agentflow -- resume-run --run <id> --include-failed
npm run agentflow -- replay-run --run <id>
```

If an agent asks for a command or file write outside the project policy, Agent Workflow records an action rejection receipt and artifact. The blocked action is not executed. Rejected optional actions do not fail the stage by themselves; allowed commands that run and exit nonzero still fail the stage.

Follow-up buttons are local-only actions backed by existing Agent Workflow commands:

- `Summarize Run`
- `Debug Failure`
- `Ask Mira`
- `Frontend Pass`
- `Maintain Context`

Dashboard actions use the project `.agent-workflow/project.yaml` policy and
create normal run receipts and artifacts.

## 12. MCP Prompt Examples

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

## 13. MCP Tools

MCP clients can call these tools:

```text
agentflow_doctor
agentflow_validate
agentflow_contract_test
agentflow_list
agentflow_schemas
agentflow_bundle_compat
agentflow_bundle_upgrade_preview
agentflow_bundle_adopt
agentflow_definition_migrations
agentflow_onboard_project
agentflow_index_project
agentflow_compile
agentflow_workflow_graph
agentflow_run_workflow
agentflow_run_and_watch
agentflow_agent_task
agentflow_summarize_run
agentflow_schedule
agentflow_worker
agentflow_status
agentflow_approvals
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

## 14. Storage And Reset

Reset local enterprise run history:

```bash
npm run reset-storage
npm run bootstrap-storage
```

Remove Docker volumes too:

```bash
npm run services:reset
docker compose -f infra/docker-compose.yml up -d
npm run migrate-storage
npm run bootstrap-storage
```

## 15. Provider Checks

Check the configured provider:

```bash
npm run provider-check
```

Run a provider contract smoke test:

```bash
npm run provider-smoke
```

## 16. Adaptive Routing

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

## 17. Feedback Memory

Record whether a run was useful:

```bash
npm run agentflow -- feedback --run <run-id> --rating accepted --note "Good scope and routing"
npm run agentflow -- feedback --run <run-id> --rating revised --note "Needed more frontend context"
npm run agentflow -- feedback --run <run-id> --rating rejected --note "Wrong files were prioritized"
```

The dashboard run page also includes Accept, Mark Revised, and Reject buttons. Feedback is stored as a normal receipt/artifact and as compact project memory, so future routing and personalization can use it without adding project-local prompt bloat.

Use the feedback inbox when you want to review recent unscored runs across one project or every registered project:

```bash
npm run agentflow -- feedback-inbox --limit 50
npm run agentflow -- feedback-inbox --project /path/to/project --limit 50
```

The dashboard page `/feedback-inbox` groups unreviewed runs into probably accept, probably revise, and probably reject buckets. Each row includes task summary, stage completion, quality/fallback/latency signals, key findings, failures, recommended next action, and per-row feedback controls. These buckets are suggestions only; the stored learning signal is still the feedback rating and note you choose.

Use **Bulk Review** from `/feedback-inbox` to review suggested ratings and notes in one table. Rows are checked by default so you can quickly submit the obvious items, but you can uncheck any row, change its rating, or edit its note before recording feedback.

Compiled briefs include recent feedback as adaptive preference notes. If prior feedback includes revised or rejected outcomes, adaptive routing conservatively promotes fast stages to standard and records that decision in the `model_route` receipt and quality report. Compiled briefs also include approved project-local tuning notes from `.agent-workflow/tuning/agent-notes.md`, `context-budget-notes.md`, and `routing-preferences.md` with a small context cap.

## 18. Preference Scorecard

Aggregate feedback by workflow, stage, agent, provider, and model tier:

```bash
npm run agentflow -- preference-scorecard --project /path/to/project --limit 25
```

The dashboard run page also shows a compact scorecard for the run's project. Use it to find combinations that repeatedly need revision, fallback often, or produce low quality scores.

## 19. Evaluation Gates

Evaluation gates turn run quality, latency, fallback, and cost signals into a
machine-readable pass/fail result. The default project template includes
`.agent-workflow/evaluation-gates.yaml`.

```bash
npm run agentflow -- gate --run <candidate-run-id> --project /path/to/project
npm run agentflow -- gate --run <candidate-run-id> --baseline-run <baseline-run-id> --project /path/to/project --json
```

Gate failures exit with code `2`, so CI can distinguish a regression from a
tooling failure.

```yaml
version: 1
id: local-developer-quality
thresholds:
  allowed_statuses:
    - completed
  minimum_average_quality: 0.7
  maximum_quality_failures: 0
  maximum_fallbacks: 1
  maximum_average_latency_ms: 30000
  maximum_high_cost_stages: 1
regression_budgets:
  maximum_quality_drop: 0.1
  maximum_average_latency_increase_ms: 10000
  maximum_fallback_increase: 1
  maximum_high_cost_stage_increase: 1
```

Use shared gates for generic developer workflow health. Keep product-specific
ranking rubrics, customer-derived thresholds, and private scoring logic inside
the project that owns them.

## 20. Observability

Use `observe` to export OpenTelemetry-compatible spans and metrics for a stored
workflow run. The export includes run, stage, model-route, command, file-write,
and rejection spans plus summary metrics for queue delay, model latency,
quality, fallbacks, receipts, and artifacts.

```bash
npm run agentflow -- observe --run <run-id>
npm run agentflow -- observe --run <run-id> --json
```

The dashboard run page includes an Observability panel and an `OTEL JSON` link.
Prompt text and artifact payload bodies are not exported by default; use regular
run artifacts locally when you need trusted detailed debugging. String metadata
attributes are truncated and common secret-shaped values are redacted before export.

## 21. Tuning Proposals

Turn scorecard findings into reviewable prompt, context-budget, and routing suggestions:

```bash
npm run agentflow -- tuning-proposals --project /path/to/project --limit 25
```

The dashboard run page also shows a compact tuning proposal panel for the run's project. These are reviewable hints, not automatic edits.

## 22. Apply Tuning Proposals

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

The dashboard Model Improve page includes an Applied Tuning Overlay panel. It shows whether `.agent-workflow/tuning/proposals.json` exists, when it was generated, which proposal ids were selected, and the proposal-kind mix. "Applied" in this panel means Agent Workflow wrote project-local tuning state for future tools to inspect. If the selected proposals are `feedback_needed`, no prompt, routing, or model-tier behavior has changed yet; Agent Workflow is preserving the signal that more approved feedback or evaluation evidence is needed before changing behavior.

The same page also includes a Feedback Capture panel. It lists recent completed or failed runs that do not have feedback yet, then lets you record accepted, revised, or rejected feedback with one short note. Each target includes the task, stage completion count, quality/fallback/latency signals, key findings, failures, and recommended next action so the feedback is based on evidence instead of a bare run id. Use the selector at the top for a deliberate single feedback entry, or use the per-row Accept, Revise, and Reject controls when the evidence makes the decision obvious. This uses the same `feedback` recorder as the CLI and MCP tool, so dashboard feedback immediately contributes to preference scorecards, tuning proposals, workflow-shape recommendations, and local learning daemon evidence.

The dashboard tuning panel includes a Dry Run Apply button. The learning daemon can also write safe project-local tuning overlays automatically when autonomous local mode is enabled. The MCP tools `agentflow_queue_tuning_approvals`, `agentflow_tuning_approvals`, `agentflow_generate_tuning_patches`, `agentflow_apply_tuning_patches`, and `agentflow_apply_tuning_proposals` expose the same behavior for Codex, VS Code, Cursor, or any MCP-capable client.

## 23. Local Learning Report

Use `learning-report` to inspect what the future local learning daemon can
learn without allowing it to change anything. It reads local run history,
feedback, failures, routing outcomes, and evaluation evidence, then reports
safe automatic actions, approval boundaries, evaluation gaps, repeated failure
patterns, and cost/routing opportunities.

```bash
npm run agentflow -- learning-report --project /path/to/project
npm run agentflow -- learning-report --project /path/to/project --json
npm run agentflow -- learning-proposals --project /path/to/project
npm run agentflow -- learning-proposals --project /path/to/project --write
npm run agentflow -- learning-approvals --project /path/to/project
npm run agentflow -- learning-approvals --project /path/to/project --approve learn-001 --reviewer "Your Name" --note "Looks useful"
npm run agentflow -- learning-daemon-status --project /path/to/project
npm run agentflow -- learning-daemon --all-projects --mode apply-approved --once
npm run agentflow -- learning-daemon --all-projects --mode apply-approved
npm run agentflow -- learning-daemon --project /path/to/project --once
npm run agentflow -- learning-daemon --project /path/to/project --mode observe --once
npm run agentflow -- learning-daemon --project /path/to/project --mode propose --once
npm run agentflow -- learning-daemon --project /path/to/project --mode apply-approved --once
npm run learning:daemon -- --project /path/to/project --mode propose
npm run learning:daemon -- --project /path/to/project --mode apply-approved
npm run agentflow -- learning-application-plan --project /path/to/project
npm run agentflow -- learning-application-plan --project /path/to/project --write
npm run agentflow -- learning-action-receipts --project /path/to/project
npm run agentflow -- learning-action-receipts --project /path/to/project --reject learn-action-001 --actor "Your Name" --note "Not worth doing"
npm run agentflow -- learning-workflow-shape --project /path/to/project --workflow build-feature
npm run agentflow -- learning-workflow-shape --project /path/to/project --workflow build-feature --write
npm run agentflow -- agent-improvement-report --project /path/to/project
npm run agentflow -- agent-improvement-report --project /path/to/project --write
npm run agentflow -- agent-improvement-report --project /path/to/project --agent ux-reviewer --json
npm run agentflow -- agent-improvement-patches --project /path/to/project
npm run agentflow -- agent-improvement-patches --project /path/to/project --write
npm run agentflow -- agent-improvement-patches --project /path/to/project --ids ux-reviewer --json
npm run agentflow -- agent-improvement-evals --project /path/to/project
npm run agentflow -- agent-improvement-evals --project /path/to/project --write
npm run agentflow -- agent-improvement-evals --project /path/to/project --ids ux-reviewer --json
npm run agentflow -- agent-improvement-promotions --project /path/to/project
npm run agentflow -- agent-improvement-promotions --project /path/to/project --write
npm run agentflow -- agent-improvement-promotions --project /path/to/project --approve promotion-patch-agent-ux-reviewer-improvement --reviewer "Your Name" --note "Approved after holdout eval review"
npm run agentflow -- agent-improvement-apply --project /path/to/project
npm run agentflow -- agent-improvement-apply --project /path/to/project --max-risk medium --write
npm run agentflow -- agent-improvement-apply --project /path/to/project --project-local-auto-ready --write
```

The daemon defaults to `apply-approved`, which autonomously refreshes
Agent Workflow-owned learning reports, proposal state, workflow-shape
recommendation files, application-plan files, and low/medium-risk
project-local optimization overlays. It also applies holdout-passing
project-local agent YAML promotions when the source hash, rollback evidence,
schema validation, auto-apply readiness, and configured risk threshold all pass.
Use `--mode observe` for read-mostly behavior or `--mode propose` for
proposal/inbox generation without application plans. The dashboard setting
**Auto-apply through** defaults to `medium`; set it to `low` for stricter review
or `high` only if you want maximum local autonomy. Turn off **Auto-apply passing
project-local agent-card improvements** to keep agent YAML promotion
review-first while the daemon continues refreshing recommendation files.

In the dashboard, open:

```text
http://127.0.0.1:17888/learning?project=/path/to/project
http://127.0.0.1:17888/api/learning-report?project=/path/to/project
http://127.0.0.1:17888/api/learning-proposals?project=/path/to/project
http://127.0.0.1:17888/api/learning-daemon-status?project=/path/to/project
http://127.0.0.1:17888/api/learning-application-plan?project=/path/to/project
http://127.0.0.1:17888/api/learning-action-receipts?project=/path/to/project
http://127.0.0.1:17888/api/learning-workflow-shape?project=/path/to/project&workflow=build-feature
http://127.0.0.1:17888/api/agent-improvement-report?project=/path/to/project
http://127.0.0.1:17888/api/agent-improvement-patches?project=/path/to/project
http://127.0.0.1:17888/api/agent-improvement-evals?project=/path/to/project
http://127.0.0.1:17888/api/agent-improvement-promotions?project=/path/to/project
```

`learning-proposals --write` creates local review files only under
`.agent-workflow/learning/`:

- `proposals.json`
- `proposals.md`
- `approval-inbox.json`
- `approval-inbox.md`
- `application-plan.json`
- `application-plan.md`
- `autonomous-application.json`
- `autonomous-application.md`
- `action-receipts.json`
- `action-receipts.md`
- `workflow-shape-proposals.json`
- `stage-recommendations.md`
- `agent-improvement-report.json`
- `agent-improvement-recommendations.md`
- `agent-improvement-patches.json`
- `agent-improvement-patches.md`
- `agent-improvement-evals.json`
- `agent-improvement-evals.md`
- `agent-improvement-promotions.json`
- `agent-improvement-promotions.md`
- `agent-improvement-promotion-receipts.json`
- `agent-improvement-promotion-receipts.md`
- `settings.json`

The workflow shape optimizer looks for repeated failures, expensive or slow
routes, missing feedback, missing eval evidence, and indexed-context pressure.
It recommends project-local workflow overlays first, including adding,
removing, splitting, collapsing, or gating stages and prototyping new local
agent types. The dashboard Learning page includes an Autonomous optimizer
switch. It defaults on, so each daemon tick may refresh only its own
learning-owned shape recommendation files. Turn it off for approval-first
review of those recommendations.

The agent definition improvement loop looks at reusable and project-local
agents by role, workflow usage, failures, feedback, routing/cost data, and eval
evidence. It recommends safer prompts, clearer capabilities, approval
boundaries, context-budget changes, and validation expectations. By default it
only writes Agent Workflow-owned recommendation files under
`.agent-workflow/learning/`; editing real agent YAML, adding new agent types,
expanding autonomy, or running web/model research remains approval-gated until
a later promotion phase. `agent-improvement-patches` creates exact proposed
YAML, source hashes, schema validation, rollback references, and diff previews
as learning-owned files without editing agent definitions.
`agent-improvement-evals` scores those patch previews against recent
representative tasks and checks schema validity, rollback hash freshness,
holdout coverage, risk boundaries, and local evidence support before anything
can become promotion-ready. `agent-improvement-promotions` turns passing evals
into an auditable promotion queue, preserves prior decisions when source hashes
still match, marks stale queue items superseded, and records approval/rejection
receipts. `agent-improvement-apply` is the separate YAML write step: it applies
approved promotions only when rollback hashes, schema validation, scope, and
the configured risk threshold all pass. The daemon's autonomous apply path is
narrower: it can apply only project-local, auto-apply-ready promotion items that
do not require approval. Shared agent cards still require explicit owner action.

When `learning-application-plan --write` or the daemon's `apply-approved` mode
turns approved or auto-approved proposals into local actions, Agent Workflow
records append-only proposal-to-action receipts. If a newer plan makes a planned action
obsolete, it appends a `superseded` receipt. If you decide a planned action
should not be followed, reject it from the CLI, dashboard, or MCP; rejection
also appends a receipt and does not execute or apply anything.

The MCP tools `agentflow_learning_report`, `agentflow_learning_proposals`, and
`agentflow_learning_approvals` expose the same flow for Codex, VS Code, Cursor,
or any MCP-capable client. `agentflow_learning_daemon_status` shows the current
heartbeat, and `agentflow_learning_daemon_tick` runs one bounded daemon tick.
`agentflow_learning_application_plan` prepares the approved follow-up plan
without applying source, provider, command, network, or export changes.
`agentflow_learning_workflow_shape` exposes the
workflow shape optimizer through MCP. `agentflow_learning_action_receipts`
lists or rejects planned learning actions. `agentflow_agent_improvement_report`
exposes the agent definition improvement report, and
`agentflow_agent_improvement_patches` exposes the validated YAML patch preview.
`agentflow_agent_improvement_evals` exposes holdout promotion scoring with
rollback evidence. `agentflow_agent_improvement_promotions` exposes the
promotion queue and decision receipts. `agentflow_agent_improvement_apply`
applies approved YAML promotions with source-hash checks and rollback receipts.

The learning flow may mutate local learning state that Agent Workflow created
and owns: its own files under `.agent-workflow/learning/` today and future
Agent Workflow-created `learning_*` database rows. In `apply-approved` mode it
can also apply project-local, risk-bounded, auto-ready agent YAML promotions
after holdout, hash, rollback, and schema checks. Provider changes,
private-data export, commands, source edits outside owned project-local agent
cards, shared reusable-definition changes, and risky agent changes remain
approval-gated by design. See [Local Learning Daemon](local-learning-daemon.md).

## 24. Model Improvement Workflow

Use `model-improvement` when a workflow is too expensive, too slow,
inconsistent, or producing answers that need too much manual correction. It
diagnoses whether the next fix should be context, prompts, routing, eval
coverage, retrieval, or provider-side fine tuning.

```bash
npm run agentflow -- run-and-watch model-improvement \
  --project /path/to/project \
  --task "Find the cheapest way to improve review-pr quality without losing security coverage"
```

The workflow uses `model-improvement-diagnostician`, `eval-curator`, and
`routing-optimizer`. It can propose scrubbed local eval cases and routing
changes, but private dataset export, provider fine-tune jobs, and candidate
promotion remain approval-gated and project-local. See
[Model Improvement Workflow](model-improvement.md).

After approving project-local tuning proposals, prepare scrubbed eval-case and
provider dataset-plan files:

```bash
npm run agentflow -- model-improvement-plan --project /path/to/project
npm run agentflow -- model-improvement-plan --project /path/to/project --write
npm run agentflow -- candidate-comparison-plan --project /path/to/project
npm run agentflow -- local-holdout-comparison --project /path/to/project
npm run agentflow -- local-holdout-results --project /path/to/project
npm run agentflow -- local-holdout-promote --project /path/to/project --approved
npm run agentflow -- local-llm-benchmarks --project /path/to/project
npm run agentflow -- local-llm-cache-trends --project /path/to/project --write
npm run agentflow -- local-llm-checklist --project /path/to/project
npm run agentflow -- local-llm-cost-ledger --project /path/to/project --write
npm run agentflow -- local-llm-setup-guide --project /path/to/project
npm run agentflow -- local-llm-download-recommendations --project /path/to/project
npm run agentflow -- local-llm-install-plan --project /path/to/project --write
npm run agentflow -- local-llm-inventory --project /path/to/project
npm run agentflow -- local-llm-prune-plan --project /path/to/project --write
npm run agentflow -- local-llm-routing-recommendations --project /path/to/project --write
npm run agentflow -- local-llm-routing-note-plan --project /path/to/project --write
npm run agentflow -- apply-local-llm-routing-note-plan --project /path/to/project --approved --write
npm run agentflow -- local-llm-smoke --project /path/to/project
npm run agentflow -- promotion-note-plan --project /path/to/project
```

The dry run prints the plan. With `--write`, files are written only under
`.agent-workflow/model-improvement/` for model-improvement plans, and under
`.agent-workflow/model-improvement/` plus `.agent-workflow/evaluations/` for
candidate comparison plans. `local-holdout-comparison` is the local LLM path:
it defaults to a hosted `openai/standard` baseline and a `local/fast` candidate
so project owners can collect holdout evidence before expanding local routing
beyond low-risk read-only developer stages.

Open `/candidate-comparisons?project=/path/to/project` in the dashboard to
generate a local holdout plan, inspect the written comparison plan, suite files,
baseline/candidate providers, evaluation outcomes, quality and latency deltas,
gate readiness, and promotion recommendations without running models. After a
comparison evals run, use **Capture Holdout Results** to write
`.agent-workflow/model-improvement/local-holdout-results.json` and `.md` as
project-local promotion evidence. If the captured decision is eligible for
review, **Approve Low-Risk Local Routing** writes a reviewed
`.agent-workflow/tuning/local-routing-threshold.json` plus
`.agent-workflow/tuning/routing-preferences.md`. Future adaptive or auto-routed
fast stages can use that compiled project-local note to prefer the local model
only when the recorded holdout thresholds still pass. The promotion records
minimum evidence suites, minimum quality delta, maximum latency regression, and
fallback boundaries alongside the evidence that satisfied them. Route receipts
explain when local was selected or skipped, and hosted fallback remains the
boundary for high-risk, policy, secret, command, and production work. After a
promotion note plan is written, the same page shows the review file status and
markdown preview.

Both `/model-improvement` and `/candidate-comparisons` show **Local Holdout
Routing** after this loop starts. That panel summarizes whether results and
promotion files exist, whether the project is approved for low-risk local
routing, which suites provided evidence, recent local-vs-hosted route volume,
and the current local fallback rate.

Those pages also include **Local Route Decision Drilldown**, which explains
each recent route group in operator terms: local selected, local skipped,
hosted fallback, or hosted selected. It combines the stage, agent, provider,
quality, latency, fallback count, holdout threshold summary, and next action so
you can see why a stage did or did not use the cheaper local path. Each row has
quick feedback actions so you can mark that routing decision as helpful,
costly, or neutral without leaving the page. Agent Workflow stores that signal
locally under `.agent-workflow/model-improvement/route-decision-feedback.*`.
Savings-aware local routing recommendations use the same feedback so repeated
costly decisions can block expansion or recommend retreat, while repeated
helpful decisions can strengthen low-risk local trial candidates.

The `/learning` dashboard also summarizes those route-feedback signals. This
lets the daemon treat repeated costly or helpful route decisions as learning
evidence alongside run history, failures, evaluation coverage, and tuning
proposal outcomes.

When route feedback repeats, `learning-proposals` creates low-risk
`route_feedback` proposals. These do not change live provider settings. They
tell the learning loop to refresh savings-aware routing recommendations and
prepare project-local routing-note plans only when evidence still supports the
change.

In `apply-approved` mode, the learning daemon can refresh the local routing
recommendation files directly from approved route-feedback proposals. That
writer updates Agent Workflow-owned model-improvement artifacts only; provider
settings, shared workflows, reusable agents, and project source still stay out
of the autonomous path.

The same pages also show **Route Receipt Trends**. This groups recent
`model_route` receipts by workflow, stage, agent, provider, tier, and route
class, so you can see whether local was selected, skipped because the endpoint
was unavailable, or replaced by hosted fallback before changing broader routing
defaults.

Use **Local LLM Setup Checklist** on `/model-improvement` when setup feels
ambiguous. It combines provider readiness, `/v1/models` catalog visibility,
selected tier models, auto-routing config, low-risk promotion status, and the
first local route receipt into one pass/warning/fail report. It also shows
local smoke history, including first true local success, latest skipped/fallback
or failure reason, and the next routing or model-download fix. From that panel,
use **Run Low-Risk Local Route Smoke** to queue one safe `provider-smoke`
fast-tier stage and create normal route receipt evidence without choosing a
separate workflow command.

Use **Guided Local Model Setup** on the same page, or run
`local-llm-setup-guide`, to detect Ollama, LM Studio, vLLM, llama.cpp server,
and any configured `LOCAL_MODEL_BASE_URL`. With `--write`, it writes a
project-local setup report under `.agent-workflow/model-improvement/`. With
`--approved --write`, it writes the additional local routing note only if the
checklist has a reachable local catalog, selected tier models, visible automatic
routing, and at least one true local-selected smoke receipt.

Use **Local Model Download Recommendations** on `/model-improvement`, or run
`local-llm-download-recommendations`, when you want concrete local model
downloads. It looks at detected hardware, local runtime catalog, recent task
mix, smoke history, and cost-savings goals, then writes only
`.agent-workflow/model-improvement/local-llm-download-recommendations.*` when
you pass `--write`. It stays advisory: downloading models, editing `.env`, and
changing shared provider defaults remain explicit operator actions.

Use **Local Model Installation Plan**, or run `local-llm-install-plan --write`,
to convert those recommendations into reviewed runtime-specific commands. The
plan writes `.md`, `.json`, and `.sh` files under
`.agent-workflow/model-improvement/` with download, verify, and benchmark
commands plus disk/risk notes. Agent Workflow does not run the download script
or edit provider settings for you.

Use **Local Model Disk Inventory**, or run `local-llm-inventory --write`,
before downloading more models. It checks common Ollama, LM Studio, Hugging
Face, vLLM, and llama.cpp cache roots, shows storage pressure, links installed
model evidence to recent route and benchmark receipts, and flags stale
unrecommended cache entries for prune review. It never deletes files.

Use **Local Model Prune Plan**, or run `local-llm-prune-plan --write`, after
inventory finds stale unrecommended cache entries. The plan writes reviewed
`.md`, `.json`, and `.sh` cleanup files under
`.agent-workflow/model-improvement/` with exact cache paths, reclaim estimates,
risk notes, and manual commands. Agent Workflow does not execute the cleanup
commands or delete local model files.

Use **Local Model Cache Trends**, or run `local-llm-cache-trends --write`, to
append a compact aggregate snapshot after model installs, prune reviews,
benchmarks, or routing changes. The trend file tracks cache size, free disk,
model count, prune candidates, reclaim estimates, and local-vs-hosted route
counts over time without storing model file contents, prompt text, or secrets.

Use **Local Model Cost Ledger**, or run `local-llm-cost-ledger --write`, to
estimate whether local routing is actually saving money for a project. It
combines local-selected route counts, hosted fallback counts, benchmark latency,
and model cache storage into a compact savings trend. The result is an estimate,
not a provider invoice; set `AGENTFLOW_COST_LEDGER_*` environment variables to
match your current provider and storage assumptions.

Use **Savings-Aware Local Routing**, or run
`local-llm-routing-recommendations --write`, to translate the local evidence
into expand, hold, or retreat recommendations per workflow stage and agent. The
report considers quality, fallback rate, latency, cache pressure, and estimated
savings. It writes advisory files only and does not change provider settings or
routing notes by itself.

Use `local-llm-routing-note-plan --write` after that when you want reviewable
project-local routing note plans. It selects expand and retreat recommendations,
writes `.agent-workflow/tuning/local-routing-note-plan.*`, and keeps shared
provider defaults, reusable workflows, reusable agents, and project source
unchanged.

Use `apply-local-llm-routing-note-plan --approved --write` only after reviewing
that plan. It appends selected notes to
`.agent-workflow/tuning/routing-preferences.md`, records before/after hashes in
`.agent-workflow/tuning/local-routing-note-application.*`, and skips notes that
were already applied.

The `/model-improvement` dashboard shows **Applied Local Routing Notes** after
that step, including applied/skipped note ids, active note markers, before/after
hashes, rollback text, and a compact preview of
`.agent-workflow/tuning/routing-preferences.md`.

The same page shows **Model Routing Decision Timeline**, a compact operator view
that connects each recommendation to its note-plan state, applied receipt, route
quality, fallback rate, and estimated savings.

Use **Routing Decision Snapshots**, or run
`local-llm-routing-decision-snapshot --write`, to persist compact timeline
history. The snapshot log compares the latest routing decision state with the
previous persisted state, tracks added/removed/changed items, and records the
net savings delta without storing prompt text, model outputs, API keys, or
project source.

Use **Local Benchmark Receipts** on `/model-improvement`, or run
`local-llm-benchmarks`, after at least one recommended model is installed. The
default mode writes the tiny benchmark plan; `--execute --write` calls only the
local OpenAI-compatible endpoint, records latency and simple rubric scores, and
writes `.agent-workflow/model-improvement/local-llm-benchmark-receipts.*` as
promotion evidence before smoke routing is expanded.

![Candidate comparisons dashboard](assets/screenshots/dashboard-candidate-comparisons.png)

![Promotion note files](assets/screenshots/dashboard-candidate-promotion-notes.png)

## 25. Recommended Next Improvement

The next improvement is proposal-to-action receipts: add append-only local
history when proposals become application plans, when planned actions are
superseded, and when users reject a planned action. See the [Roadmap](roadmap.md)
for the shared-platform implementation sequence.
### Tuning approval history

Approval queue writes now append lifecycle events to `.agent-workflow/tuning/approval-history.json` and a readable `approval-history.md`. Approvals, rejections, and written applications are recorded automatically. Record an explicit rollback or replacement without changing the queue:

```bash
npm run agentflow -- tuning-history --project /path/to/project
npm run agentflow -- tuning-history --project /path/to/project --record reverted --ids tune-001 --actor jason --note "Regressed quality"
npm run agentflow -- tuning-history --project /path/to/project --record superseded --ids tune-001 --related-proposal tune-004
```

History is append-only project metadata. It informs later review and scorecards but never applies or promotes a proposal by itself.
## Multi-project governance

Inspect every registered project without changing it:

```bash
agentflow governance
agentflow governance --health critical
agentflow governance --provider openai --policy-profile production --json
```

The report checks path and context availability, registered-versus-local configuration drift, current policy hashes against immutable recent run snapshots, provider/tier metadata, indexing, failed runs, and stale active runs. Critical findings cause exit code `2`, making the JSON report suitable for monitoring without granting remediation authority.

Temporary provider-smoke projects are excluded by default. Add `--include-ephemeral` when auditing test registrations themselves.

Open `/governance` in the dashboard for the same report with health, provider, and policy-profile filters. Open `/roles` for project team role configuration and recent approval decisions by role. `/api/governance` and `/api/roles` expose the stable JSON contracts. The MCP tool is `agentflow_governance`.

## Artifact lifecycle visibility

Inspect artifact storage without changing it:

```bash
agentflow artifact-lifecycle
agentflow artifact-lifecycle --project /path/to/project
agentflow artifact-lifecycle --kind stage_output --limit 100 --json
agentflow artifact-lifecycle --project /path/to/project --prune-plan
agentflow artifact-lifecycle --project /path/to/project --archive-plan
agentflow artifact-lifecycle --project /path/to/project --restore-plan
agentflow artifact-lifecycle --project /path/to/project --prune-plan --min-age-days 60 --min-bytes 50000 --json
agentflow artifact-lifecycle --project /path/to/project --prune-plan --queue-approvals
agentflow artifact-lifecycle --project /path/to/project --archive-plan --queue-archive-approvals
agentflow artifact-lifecycle --project /path/to/project --restore-plan --queue-restore-approvals
```

The report groups recent artifacts by project, artifact kind, age bucket, and
run status. It also estimates JSON payload size and emits conservative lifecycle
hints such as `retain for audit`, `retain until run reviewed`, or `candidate
for future prune plan`.

Open `/artifact-lifecycle` in the dashboard for the same read-only inventory.
`/api/artifact-lifecycle` exposes the JSON report for local automation. This
version does not delete, archive, or prune artifacts. Future prune-plan tooling
should cite exact artifact ids, explain each reason, record receipts, and require
explicit approval before any destructive action.

Add `--prune-plan` or enable **Show dry-run prune plan** in the dashboard to
preview exact candidate artifact ids, URIs, run links, reasons, and estimated
recoverable JSON storage. The plan is always `mode: dry-run`; it does not mutate
Postgres, object storage, or project files. By default, audit artifacts such as
action approvals, run feedback, command output, and file-write receipts are
excluded. Use `--include-audit` only for review planning, not automatic cleanup.

Each project can set its own lifecycle defaults in `.agent-workflow/project.yaml`:

```yaml
storage:
  artifact_lifecycle:
    retention_days: 30
    min_prune_bytes: 20000
    retain_audit_artifacts: true
    legal_hold: false
    require_approval_for_prune: true
    allow_archive_execution: false
    allow_restore_execution: false
    allow_prune_execution: false
```

The CLI and dashboard use these project-local settings when a project is
selected. `--min-age-days`, `--min-bytes`, and the dashboard filter fields are
preview-only overrides; they do not edit project policy. When `legal_hold` is
true, prune-plan candidates are suppressed. Dry-run candidate rows include a
receipt preview so reviewers can see the action type, target URI, and metadata
that a future approved lifecycle action would need to record before any
destructive operation exists.

Use `--queue-approvals` after reviewing a dry-run prune plan to create pending
approval records for each candidate. The dashboard exposes the same action from
the Artifact Lifecycle page. These approvals record lifecycle intent and normal
audit receipts. Executing an approved `artifact_prune` approval records a
`lifecycle_skipped` receipt with the current policy recheck. The approval is
marked executed after the receipt is recorded, but no artifact is deleted,
archived, restored, or modified. Even if `allow_prune_execution` is enabled in
project policy, destructive prune/delete execution remains unavailable in this
version and fails closed behind the recorded skip receipt.

Use `--archive-plan` and `--restore-plan` to preview the recovery side of the
lifecycle process before any delete path exists. Archive plans use the same
conservative retention criteria as prune plans, but their approvals are
`artifact_archive` actions. When `allow_archive_execution` is enabled, executing
an approved archive approval copies the target artifact into an
`archived_artifact` snapshot, keeps the original artifact in place, records
restore metadata, and marks `destructiveExecutionAvailable: false`. Restore
plans only use archived artifact snapshots as candidates. When
`allow_restore_execution` is enabled, executing an approved restore approval
creates a copied `restored_artifact` snapshot from archived content, records
lineage back to the archive snapshot and original artifact URI, and never
overwrites an existing artifact row. Prune execution still records
`lifecycle_skipped` receipts because destructive prune/delete execution is not
implemented in this version.

The `allow_*_execution` flags are explicit capability switches. They default to
`false`. When a flag is disabled, executing an approved lifecycle action records
a `lifecycle_skipped` receipt with the policy recheck summary. When
`allow_archive_execution` is enabled, archive execution creates copied
`archived_artifact` snapshots only. When `allow_restore_execution` is enabled,
restore execution creates copied `restored_artifact` snapshots only. Prune and
delete implementations are intentionally not present yet; the current gate
requires an approval record, rechecks `require_approval_for_prune`, rechecks the
current lifecycle policy, and still records a skipped receipt instead of
deleting data.

## Backup and restore readiness

Inspect read-only backup inventory and restore-drill posture:

```bash
agentflow backup-report
agentflow backup-report --project /path/to/project
agentflow backup-report --project /path/to/project --json
npm run backup-report -- --project templates/project
agentflow restore-drill --project /path/to/project
agentflow restore-drill --project /path/to/project --json
npm run restore-drill -- --project templates/project
```

The report does not create backup files or mutate storage. It checks enterprise
service reachability, registered projects, run counts, indexed context, memory
items, recent artifact counts and bytes, `archived_artifact` snapshots,
`restored_artifact` snapshots, pending lifecycle approvals, and active queue
items. Use it before handoff, release prep, or cleanup planning to confirm that
there is enough local evidence to run an archive/restore drill without exposing
project files or deleting data.

Open `/backup-report` in the dashboard for the same read-only report. The JSON
endpoint is `/api/backup-report`.

Use `restore-drill` after archive and restore snapshots exist. It verifies
`restored_artifact -> archived_artifact -> original URI` lineage and compares
the copied restored content hash against the archived content hash. See
[Backup And Recovery](recovery.md) for the full recovery checklist.
