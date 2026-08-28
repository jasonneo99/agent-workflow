# Architecture

Portable Agent Workflows is enterprise-first and file-compatible.

## Source Of Truth

- `agents/**/*.yaml`: reusable specialist and automatic agent cards
- `workflows/**/*.yaml`: reusable workflow graphs
- `templates/project`: files copied into a consuming project
- `.agent-workflow/project.yaml`: project-level autonomy, context, and policy settings

## Runtime Path

1. The CLI or MCP server receives a task.
2. The workflow registry loads YAML definitions.
3. The project adapter loads `AGENTS.md` and `.agent-workflow/`.
4. The context compiler creates a compact task brief, including approved project-local tuning notes when present.
5. The policy engine checks autonomy and approval requirements.
6. The compiled brief is persisted as a run artifact.
7. The runner delegates to provider adapters with the brief plus prior stage receipts.
8. Receipts, summaries, embeddings, and artifacts are persisted.

The `mock` provider gives deterministic local workflow execution. The recommended live-provider path is `byo`, which points at any OpenAI-compatible model gateway with `DEFAULT_MODEL_PROVIDER=byo`. OpenAI, Bedrock, OpenAI-compatible legacy env names, and Kiro CLI are optional adapters behind the same `executeStage` contract.

## Artifacts

Artifacts are durable JSON records linked to workflow runs and tasks.

- `compiled_brief`: the compiled project/workflow context created at queue time
- `stage_output`: structured provider output for a completed stage

Inspect them with:

```bash
npm run artifacts -- --run <workflow-run-id>
```

## Project Index

The project index stores compact summaries in `project_files`.

1. `index-project` scans files allowed by `.agent-workflow/project.yaml`.
2. Each text file is hashed, token-estimated, and summarized.
3. Optional provider refinement can replace deterministic summaries with model-generated summaries.
4. Refined summaries are cached by content hash and reused for unchanged files.
5. `compile` and `run` rank stored summaries by task/workflow/agent relevance.
6. The best matches are included within the source-summary token budget.

## Safe Actions

Local commands and file writes are project-policy controlled.

- allowed and blocked command patterns live in `.agent-workflow/project.yaml`
- commands run without a shell
- shell metacharacters are rejected
- stdout/stderr are bounded
- every execution records an action receipt and command-output artifact
- worker stages may request commands, but the same project policy gate applies
- when policy requires approval, allowed action requests are stored in the approval inbox and are not executed immediately
- narrowly scoped approval rules can auto-execute recurring low-risk allowed actions while preserving receipts
- approval decisions record receipts; approval does not bypass command or write policy
- writable paths are limited by `allowed_write_paths` and `blocked_write_paths`
- file writes must stay inside the project root and below `max_write_bytes`
- every accepted file write records a receipt with before/after hashes

## Enterprise Storage

Postgres stores durable records. pgvector stores semantic memory. Redis coordinates transient work. Object storage holds large artifacts. This keeps workflow state queryable, auditable, and scalable without forcing every project repo to carry large context files.

Enterprise mode is the default. Simple mode skips these services and only compiles workflow briefs from files.

## Model Portability

Agent cards and workflows are provider-neutral. Provider adapters translate the compiled brief into the selected model surface: BYO OpenAI-compatible gateway, OpenAI Responses API, AWS Bedrock, Kiro CLI, or future adapters. Editor clients such as VS Code, Cursor, and Codex are control surfaces only; they do not own the provider configuration.
