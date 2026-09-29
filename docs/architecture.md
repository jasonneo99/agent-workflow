# Architecture

Portable Agent Workflows is enterprise-first and file-compatible.

For a comparison against common agent design patterns such as single-shot,
ReAct, planner-executor, reflexive, verifier-gated, and combined production
agent systems, see [Agent Design Pattern Gap Analysis](agent-design-patterns-gap.md).

## Source Of Truth

- `agents/**/*.yaml`: reusable specialist and automatic agent cards
- `workflows/**/*.yaml`: reusable workflow graphs
- `templates/project`: files copied into a consuming project
- `.agent-workflow/project.yaml`: project-level autonomy, context, and policy settings

Workflow stages may declare a provider-neutral `pattern` block. Pattern metadata
classifies each stage as `single-shot`, `planner`, `executor`, `react`,
`reflexive`, `verifier`, or `finalizer`, with optional iteration limits,
verifier requirements, promotion gates, and stop conditions. The runtime keeps
the metadata portable while the graph, dashboard, handoff exports, and learning
daemon use it to explain workflow shape and identify optimization opportunities.

For `react` stages, worker-requested local commands and file writes also emit
bounded ReAct loop receipts. These receipts record the stage goal, observation
source, requested action, policy decision, result artifact or approval id,
iteration count, configured iteration budget, stop reason, promotion gate, and
verifier requirement. They are evidence-only by default; policy and approval
controls remain the authority for whether an action can run.

## Runtime Path

1. The CLI or MCP server receives a task.
2. The workflow registry loads YAML definitions.
3. The project adapter loads `AGENTS.md` and `.agent-workflow/`.
4. The context compiler creates a compact task brief, including approved project-local tuning notes when present.
5. The policy engine checks autonomy and approval requirements.
6. The compiled brief is persisted as a run artifact.
7. The runner delegates to provider adapters with the brief plus prior stage receipts.
8. Receipts, summaries, embeddings, and artifacts are persisted.

## Requester And Intervention Path

Runs may carry a requester identity and a delivery channel. These fields are
coordination metadata, not authentication credentials and not a grant of
authority.

1. CLI, MCP, Studio, or another client supplies an optional requester and
   channel when it queues a run.
2. The storage layer persists the requester with the immutable run and writes
   approval, blocked, failed, or informational messages to the
   `run_notifications` outbox.
3. A channel adapter delivers an outbox item and records the delivery result.
   Dashboard-only delivery remains visible locally; external adapters are
   optional deployment concerns.
4. A conversational approval reply is resolved against one exact approval id,
   rechecked through the normal role and policy gates, and then resumes a saved
   checkpoint when work remains.

The portable framework owns the outbox contract, delivery receipts, and reply
semantics. Product-specific push services, private host names, personal device
identities, and secret wiring belong in a private companion or deployment
overlay. A channel label must never be treated as proof of user identity by
itself.

## Bounded Discovery And Recovery

Provider output uses structured requests as the executable contract. A stage
that lacks an exact source path may request a bounded project-relative path
search and then request exact file reads. It must not claim that a search,
read, command, or write occurred unless the matching structured request and
receipt exist.

The worker separates recovery budgets by failure class:

- verification retries handle eligible failed test or validation commands;
- file-mutation retries handle stale preimages and structural patch races;
- refreshed provider output may explicitly supersede a stale mutation when it
  no longer requests that write;
- discoverable internal source/context gaps may trigger bounded re-indexing and
  one governed continuation rather than asking the operator for information
  already present in the project.

All retries remain bounded, preserve prior evidence, and pass through the same
project policy. Recovery does not broaden write paths, commands, provider
access, network authority, or approval thresholds.

## Outcome And Continuation Contract

Run state and delivery state are related but distinct. A completed graph means
all stages reached terminal state; it does not by itself prove that the user
requested outcome was delivered.

Studio derives a presentation contract such as `in_progress`, `needs_input`,
`failed`, `incomplete`, `delivered`, or `advisory_complete`. For delivery work,
the contract may consider governed product writes and successful verification
artifacts from the selected run plus its bounded `sourceRunId` ancestry.
Continuation lineage is immutable: an older run points to its replacement, and
the UI redirects the operator to the continuation that owns current work.

Artifact presence is only a minimum signal. Acceptance still requires evidence
to be relevant to the requested files, behavior, and verification contract.
Unrelated writes or successful diagnostic commands must not make a delivery
accept-ready. Physical acceptance, deployment, publication, and external side
effects remain separate evidence gates.

## Project Identity And Consolidation

The dashboard may group registrations that appear to describe the same logical
project, but path heuristics are presentation hints only. Durable consolidation
is an explicit storage transaction:

1. identify exact source and target project registrations;
2. create and verify a database backup outside the transaction;
3. lock both registrations;
4. merge colliding indexed-file and memory keys deterministically;
5. re-parent runs, index state, memory, and performance baselines;
6. remove only the obsolete registration; and
7. retain workflow history, receipts, and artifacts.

Filesystem location, username, operating system, or a familiar directory name
must not serve as the canonical project identity. Cross-host identity needs an
explicit stable project key or operator-confirmed mapping.

The `mock` provider gives deterministic local workflow execution. The recommended live-provider path is `byo`, which points at any OpenAI-compatible model gateway with `DEFAULT_MODEL_PROVIDER=byo`. OpenAI, Anthropic Claude, Bedrock, OpenAI-compatible legacy env names, and Kiro CLI are optional adapters behind the same `executeStage` contract.

## Artifacts

Artifacts are durable JSON records linked to workflow runs and tasks.

- `compiled_brief`: the compiled project/workflow context created at queue time
- `react_loop_receipt`: per-action evidence for bounded ReAct stages
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
- deployment and autonomy approvals use the same inbox as run-level decision records, but do not execute deployment commands
- approval decisions record receipts; approval does not bypass command or write policy
- writable paths are limited by `allowed_write_paths` and `blocked_write_paths`
- file writes must stay inside the project root and below `max_write_bytes`
- every accepted file write records a receipt with before/after hashes

The optional `trusted-personal` profile reduces friction for a single trusted
operator's local development work. It does not convert local trust into
external authority: push, deploy, publish, outbound communication, spend,
credential changes, destructive deletion, and authority expansion still need
their explicit policy and approval gates. The profile is opt-in and must not be
selected implicitly for shared, remote, staging, or production environments.

## Enterprise Storage

Postgres stores durable records. pgvector stores semantic memory. Redis coordinates transient work. Object storage holds large artifacts. This keeps workflow state queryable, auditable, and scalable without forcing every project repo to carry large context files.

Enterprise mode is the default. Simple mode skips these services and only compiles workflow briefs from files.

## Model Portability

Agent cards and workflows are provider-neutral. Provider adapters translate the compiled brief into the selected model surface: BYO OpenAI-compatible gateway, OpenAI Responses API, AWS Bedrock, Kiro CLI, or future adapters. Editor clients such as VS Code, Cursor, and Codex are control surfaces only; they do not own the provider configuration.
