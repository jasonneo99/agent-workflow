# Portable Agent Workflows

A model-agnostic workflow kit for sharing reusable development agents across projects while keeping project-specific context inside each project.

The platform separates three concerns:

- reusable agents, subagents, policies, and workflows live in this repository
- each project provides a small `AGENTS.md` plus `.agent-workflow/` context files
- the runner compiles only the relevant context for a task, then records auditable workflow runs

## Recommended Developer Workflow

Enterprise mode is the default local workflow:

```bash
git clone git@github.com:jasonneo99/agent-workflow.git
cd agent-workflow
cp .env.example .env
npm install
docker compose -f infra/docker-compose.yml up -d
npm run smoke
```

The worker uses the deterministic `mock` provider by default. That is the safest first smoke test because it validates queueing, context compilation, storage, and receipts without spending model tokens or editing template files.

To opt into live OpenAI execution:

```bash
export DEFAULT_MODEL_PROVIDER=openai
export OPENAI_API_KEY="..."
export OPENAI_MODEL=gpt-5.5
npm run worker -- --limit 1
```

Run the smoke workflow with a live provider only when you intentionally want the model to perform allowed project actions:

```bash
AGENTFLOW_SMOKE_PROVIDER=openai npm run smoke
```

Live workers can request allowed project file writes. When testing against `templates/project`, inspect generated files and reset any example feature output before committing the template.

To reset local enterprise storage and remove persisted smoke runs:

```bash
npm run reset-storage
npm run bootstrap-storage
```

To remove Docker volumes too:

```bash
npm run services:reset
docker compose -f infra/docker-compose.yml up -d
npm run bootstrap-storage
```

The long-form workflow behind `npm run smoke` is:

```bash
npm run doctor
npm run bootstrap-storage
npm run validate
npm run index-project -- --project templates/project
npm run compile -- --workflow build-feature --project ./templates/project --task "Smoke test portable agent workflow"
npm run agentflow -- run build-feature --project templates/project --task "Smoke test portable agent workflow" --no-brief
DEFAULT_MODEL_PROVIDER=mock npm run worker -- --limit 12
npm run status
```

In a real project:

```bash
npm run init-project -- --project /path/to/project --profile enterprise
npm run index-project -- --project /path/to/project
npm run agentflow -- run build-feature --project /path/to/project --task "Add audit logging"
npm run worker -- --limit 6
npm run status
```

`init-project` writes `AGENTS.md` plus `.agent-workflow/` files, skips existing files unless `--force` is passed, and prints the next recommended commands.

The simpler flat-file workflow is available when a user does not want local services:

```bash
npm run init-project -- --project /path/to/project --profile simple
npm run doctor -- --simple
```

## Use From Another Project

Keep this repository as the shared workflow platform, then install lightweight project context into each consuming repository:

```bash
cd /Users/jasonmiller/Projects/Agent\ Workflow
npm run init-project -- --project /path/to/your-app --profile enterprise
```

In the consuming project, edit:

```text
AGENTS.md
.agent-workflow/project.yaml
.agent-workflow/context.md
.agent-workflow/commands.md
.agent-workflow/decisions.md
```

Back in this workflow repository, index and run against that project:

```bash
npm run index-project -- --project /path/to/your-app
npm run agentflow -- run build-feature --project /path/to/your-app --task "Describe the work" --no-brief
npm run worker -- --limit 6
npm run agentflow -- status --run <workflow-run-id> --artifacts
```

The reusable agents and workflows stay here. Project-specific context stays in the consuming project.

Tellara has a dedicated profile:

```bash
npm run init-project -- --project /Users/jasonmiller/Projects/media-ai-startup --profile tellara
```

See `docs/tellara-integration.md`.

## Architecture

```text
developer tool or model
  -> project AGENTS.md
  -> agentflow CLI or MCP server
  -> workflow engine
  -> context compiler
  -> policy engine
  -> specialist and automatic agents
  -> project files, tests, GitHub, Linear, Slack, deploy tools
```

## Storage Model

The source files in this repository are portable. Enterprise operation uses:

- Postgres as the system of record
- pgvector for semantic memory and file summaries
- Redis for queues, locks, rate limits, and short-lived cache
- object storage for transcripts, screenshots, logs, rendered artifacts, and large outputs

Local development should run the full stack with Docker Compose:

```bash
docker compose -f infra/docker-compose.yml up
```

This is the default workflow. It gives the platform durable workflow runs, receipts, semantic memory, queues, cached summaries, and object storage for large artifacts.

Default local ports avoid common service collisions:

- Postgres: `15432`
- Redis: `16379`
- MinIO: `19000`
- MinIO console: `19001`

Seed the enterprise registry after services are healthy:

```bash
npm run migrate-storage
npm run bootstrap-storage
```

## Providers

Provider adapters live in `packages/model-providers/`.

- `mock`: deterministic local execution for workflow and storage testing
- `openai`: live Responses API execution, enabled with `DEFAULT_MODEL_PROVIDER=openai`
- `openai-compatible`: local, self-hosted, or gateway chat-completions APIs, enabled with `DEFAULT_MODEL_PROVIDER=openai-compatible`

The provider contract returns a short summary plus a structured artifact. The worker stores that result as an action receipt.

Queued runs store a compiled workflow brief as an artifact. Each stage receives that brief plus prior stage receipts, and every stage output is stored as a `stage_output` artifact.

See `docs/providers.md` for configuration examples.

To verify that the selected live provider can execute the workflow contract without allowing commands or file writes:

```bash
npm run provider-smoke
```

`provider-smoke` creates a temporary project with no allowed local actions, runs one `provider-smoke` workflow stage, and verifies that a `stage_output` artifact was created.

## Project Indexing

Index project files into compact summaries:

```bash
npm run index-project -- --project /path/to/project
```

Optionally refine summaries with the selected provider:

```bash
npm run index-project -- --project /path/to/project --refine
npm run index-project -- --project /path/to/project --refine --force-refine --max-files 5
```

Refined summaries are cached by content hash. Unchanged files are reused unless `--force-refine` is set.

Inspect indexed files:

```bash
npm run project-files -- --project /path/to/project
```

The compiled brief includes indexed summaries when they exist, which keeps source context compact and reusable.

Limit indexed context during compile or run:

```bash
npm run compile -- --workflow build-feature --project /path/to/project --task "..." --source-token-budget 3000 --source-max-files 20
npm run agentflow -- run build-feature --project /path/to/project --task "..." --source-token-budget 3000 --source-max-files 20
```

The selector ranks indexed summaries by overlap with the task, workflow stages, and selected agent roles, then fits the best matches into the token budget.

## Worker And Status

Run a fixed batch:

```bash
npm run worker -- --limit 6
```

Run continuously:

```bash
npm run worker:watch
```

Inspect recent runs:

```bash
npm run status
```

Inspect a specific run:

```bash
npm run agentflow -- status --run <workflow-run-id>
npm run agentflow -- status --run <workflow-run-id> --artifacts
```

Export a portable run report:

```bash
npm run export-run -- --run <workflow-run-id>
```

Reports are written to `exports/runs/<workflow-run-id>.md` and `.json`. The `exports/` directory is ignored by Git.

## Safe Local Actions

Projects define allowed commands and writable paths in `.agent-workflow/project.yaml`. Allowed commands are commands for the consuming project root, not management commands for this shared workflow repository.

Execute an allowed command and record a receipt/artifact against a run:

```bash
npm run exec-command -- --project /path/to/project --run <workflow-run-id> -- npm run typecheck
```

Commands are executed without a shell, shell metacharacters are rejected, and output is truncated according to project policy.

Worker stages can also request commands through provider output. The worker executes only commands allowed by project policy, records each command as a `local_command` receipt plus `command_output` artifact, and fails the stage if a requested command is rejected or exits nonzero.

Worker stages can also request file writes through provider output. The worker accepts only project-relative paths allowed by `allowed_write_paths`, rejects blocked paths such as `.env` and `.git/**`, caps write size with `max_write_bytes`, and records each write as a `file_write` receipt plus artifact.

Inspect artifacts for a run:

```bash
npm run artifacts -- --run <workflow-run-id>
npm run artifacts -- --run <workflow-run-id> --kind stage_output
npm run artifacts -- --uri db://workflow_tasks/<task-id>/output --json
```

## Autonomy

Agents use explicit autonomy levels:

- `0`: advisory only
- `1`: draft artifacts
- `2`: edit local files
- `3`: run local commands and tests
- `4`: update external systems with approval
- `5`: trusted scheduled automation
- `wide-open`: project owner explicitly allows all local and external actions supported by configured tools

`wide-open` exists because some users want maximum automation, but it is never implicit. A project must opt in through `.agent-workflow/project.yaml`. The enterprise template opts in; the simple template does not.

## Project Contract

Each consuming project should include:

```text
AGENTS.md
.agent-workflow/
  project.yaml
  context.md
  commands.md
  decisions.md
```

`AGENTS.md` stays short and points the agent toward project-local context plus this shared workflow platform.
