# AGENTS.md

This repository is the shared Portable Agent Workflows kit. It defines reusable agents, automatic agents, workflows, policies, and project templates that can be used from Codex, Claude Code, Cursor, Aider, or any other agent-aware tool.

## Project Context

- Reusable agent cards live in `agents/**/*.yaml`.
- Reusable workflows live in `workflows/**/*.yaml`.
- Project templates live in `templates/project/`.
- Runtime packages live in `packages/`.
- Developer-facing CLI lives in `apps/cli/`.
- Enterprise storage and local services live in `infra/`.

## Agent Roster

Core agents:

- `workflow-orchestrator`: routes tasks, delegates to specialists, and owns final workflow coherence.
- `task-triager`: classifies work and selects the right workflow.
- `context-curator`: keeps project context compact and current.

Development agents:

- `technical-architect`: plans implementation approaches.
- `implementation-agent`: performs scoped local edits and verification.
- `frontend-engineer`: handles frontend and UI implementation.
- `backend-engineer`: handles APIs, services, and jobs.
- `database-engineer`: handles schemas, migrations, and queries.
- `test-engineer`: adds and runs focused tests.
- `ci-debugger`: diagnoses failing checks and builds.
- `security-reviewer`: reviews auth, permissions, secrets, dependencies, and deployment risk.

Product agents:

- `product-strategist`: turns goals and market constraints into product direction.
- `ux-reviewer`: Mira, the reusable UX/product-surface reviewer for workflow clarity, accessibility, polish, and trust.

Operations agents:

- `docs-maintainer`: updates docs, changelogs, and decision logs.
- `pr-preparer`: prepares PR summaries, review notes, and test evidence.
- `release-manager`: coordinates release readiness and go/no-go checks.

Automatic agents:

- `auto-test-runner`: runs configured verification.
- `auto-docs-update`: updates relevant docs after changes.
- `auto-memory-summarizer`: writes compact reusable memory from completed work.
- `auto-ci-triage`: watches CI and prepares targeted diagnosis.
- `auto-release-check`: checks release readiness.
- `auto-wide-open-executor`: runs trusted maximum-autonomy automation when explicitly enabled.

## Workflows

- `build-feature`: plan, implement, verify, document, and package a feature.
- `review-pr`: review changes for bugs, risks, missing tests, UX, and security.
- `debug-failure`: reproduce, diagnose, fix, and verify a failure.
- `ship-release`: check readiness and prepare release approval.
- `maintain-context`: refresh project context and reusable memory.
- `wide-open-automation`: run trusted automation with explicit maximum autonomy.

## Autonomy

Autonomy is project-scoped. `wide-open` is allowed only when the project config sets:

```yaml
policies:
  allow_wide_open: true
```

Even wide-open agents must write receipts for actions.

## Commands

```bash
npm install
npm run validate
docker compose -f infra/docker-compose.yml up -d
npm run doctor
npm run migrate-storage
npm run bootstrap-storage
npm run index-project -- --project templates/project
npm run compile -- --workflow build-feature --project templates/project --task "..." --source-token-budget 3000 --source-max-files 20
npm run exec-command -- --project templates/project --run <workflow-run-id> -- npm run validate
npm run list
npm run compile -- --workflow build-feature --project templates/project --task "Add audit logging"
npm run worker -- --limit 6
npm run status
npm run artifacts -- --run <workflow-run-id>
```

Use `DEFAULT_MODEL_PROVIDER=mock` for deterministic local validation. Use `DEFAULT_MODEL_PROVIDER=openai` only when `OPENAI_API_KEY` is configured.

Worker-requested commands and file writes must pass `.agent-workflow/project.yaml` action policy before execution.
File writes must be project-relative, allowed by `allowed_write_paths`, and recorded as receipts.

Use `npm run init-project -- --project /path/to/project --profile enterprise` for the default enterprise profile. Use `--profile simple` only when the user explicitly wants flat files without local services.

## Working Rules

- Prefer changing YAML definitions over duplicating instructions in code.
- Keep agent prompts compact and role-specific.
- Keep workflow stages narrow and auditable.
- Treat project-local context as the source of truth for project-specific facts.
- Preserve portability across model providers.
