# Agent Workflow Roadmap

This roadmap keeps Agent Workflow moving toward reusable shared platform IP while keeping product-specific agent engines private.

## Direction

Agent Workflow should become the portable, local-first developer agent
operations layer for any project:

- reusable agents and workflows
- project-local context
- provider-neutral model routing
- durable runs, receipts, artifacts, and exports
- feedback memory and preference scorecards
- safe tuning proposal workflows
- optional model-improvement orchestration
- MCP, CLI, dashboard, and IDE control surfaces

The current center of gravity is local developer use cases: planning,
implementation support, code review, debugging, UX/security passes, evaluation
evidence, provider comparison, context hygiene, and cost optimization around
developer workflows. It is not currently a production product-agent runtime.

It should not absorb private product intelligence from Tellara or any other
product. Domain prompts, customer workflows, scoring heuristics, schemas,
production policy, and customer-derived learning should remain project-local or
private.

## Current Baseline

Completed foundations:

- Enterprise storage with Postgres, pgvector, Redis, and object storage.
- BYO model/provider abstraction with OpenAI-compatible gateways, OpenAI, Bedrock, Kiro, and mock mode.
- Reusable agent and workflow definitions.
- Project onboarding profiles.
- Context indexing and compact brief compilation.
- Run receipts, artifacts, exports, dashboard, and MCP tools.
- Cost/quality reports, feedback memory, preference scorecards, and tuning proposals.
- Opt-in project-local tuning overlays under `.agent-workflow/tuning/`.
- Open-source boundary and shared-IP comparison docs.

## Phase 1: Shared Platform Hardening

Goal: make the reusable platform safer and easier to adopt without requiring private product context.

- [x] Approval queue for generated tuning overlays.
  - Create project-local approval queues from selected tuning proposals.
  - Require explicit human approval before proposals become approved overlay inputs.
  - Generate reviewable patch-plan files for approved proposals.
  - Apply reviewed patch-plan items into project-local tuning notes.
  - Teach future brief compilation to read applied project-local tuning notes with conservative context caps.

- [x] Export redaction and scrubbed report tooling.
  - Remove secrets, customer data, private prompts, private schemas, tenant context, and high-risk freeform artifact details from scrubbed exported reports.
  - Preserve workflow shape, statuses, stage outcomes, and artifact metadata for shareable debugging.

- [x] Scrubbed synthetic example fixtures for docs.
  - Produce safe synthetic examples for docs.
  - Validate committed examples in CI so private data patterns do not drift into documentation fixtures.

- [x] Versioned agent/workflow bundle manifests.
  - Track bundle version, source, checksum, compatibility, and migration notes.
  - Support safer sharing across teams and IDE clients.

- [x] Named execution policy profiles for local, staging, and production targets.
  - Provide reusable command/write/autonomy presets.
  - Preserve dry-run and explicit-write defaults for risky operations.
  - Persist the selected profile and immutable resolved policy snapshot with each run without requiring separate storage per target environment.

## Phase 2: Evaluation And Personalization

Goal: improve quality and cost while keeping personalization auditable and portable.

- [x] Evaluation harness for comparing providers, tiers, and prompts.
  - Compare quality, fallback, latency, estimated cost, and feedback outcomes.
  - Support synthetic benchmark projects and project-local private evals.

- [x] Dashboard run comparison view.
  - Compare runs by workflow, stage, agent, provider, tier, quality, fallback, and feedback.
  - Highlight regressions and improvement candidates.

- [x] Tuning proposal approval history.
  - Track which proposals were accepted, rejected, applied, reverted, or superseded.
  - Feed future scorecards without auto-promoting risky behavior.

- [x] Shared evaluation patterns, private product scoring.
  - Keep generic quality and routing mechanics public.
  - Keep product-specific ranking, customer-derived feedback, and domain heuristics private.

## Phase 3: Distribution And Enterprise Adoption

Goal: make Agent Workflow easy to install, operate, and govern across projects.

- [x] First-class IDE onboarding for VS Code, Cursor, and Codex.
  - Generate MCP config snippets.
  - Validate local server/provider readiness.
  - Explain model-provider ownership clearly.

- [x] Package/install story beyond cloning the repo.
  - Provide a cleaner local install path for users who want the CLI and MCP server.
  - Keep repo-based development workflow available.

- [x] Multi-project governance.
  - Inspect registered projects, storage health, provider settings, and policy drift.
  - Support enterprise teams that operate many repositories.

- [x] Signed or trusted workflow bundles.
  - Prepare for sharing agent/workflow packs without silently accepting untrusted behavior.

## Phase 4: Reliable Workflow Operations

Goal: make long-running, partially automated workflows recoverable, observable,
and safe under real development conditions.

Priority order: checkpointed resume and replay, human action approvals, and CI
evaluation gates should land first because they close the largest operational
trust gaps.

- [ ] Checkpointed resume and deterministic replay.
  - In progress: dashboard and CLI controls can resume unfinished stages from the last completed checkpoint.
  - In progress: new runs persist workflow snapshots, and replay can queue a fresh run from stored task, provider settings, policy snapshot, workflow snapshot, and compiled context.
  - In progress: resume and replay warn when project config, execution policy, bundle checksum, workflow definition, or selected source file hashes differ from queued run evidence.
  - Done: retried command and file-write actions use deterministic idempotency keys, skip duplicate side effects, and record reuse receipts that point to the original artifacts.

- [x] Human approval inbox for agent-requested actions.
  - Done: centralize pending command and file-write approvals in storage, CLI, JSON API, and dashboard.
  - Done: show each proposed action, rationale, policy decision, and payload hash.
  - Done: support approve once and reject decisions with receipt audit trails.
  - Done: execute approved local commands and file writes with current project policy rechecked and normal action receipts preserved.
  - Done: add narrowly scoped reusable approval rules for low-risk allowed actions.
  - Done: extend the same inbox shape to deployment and autonomy approvals.

- [x] Evaluation gates and regression budgets.
  - Done: define project-local quality, latency, fallback, and cost thresholds.
  - Done: compare candidate runs against a pinned or supplied baseline.
  - Done: return machine-readable pass or fail results for CI.
  - Done: block bundle promotion when a protected metric regresses through the optional release gate hook.

- [x] OpenTelemetry-compatible observability.
  - Done: export run, stage, model-route, command, file-write, and rejection spans from durable run evidence.
  - Done: correlate workflow runs with provider requests, artifacts, and action receipts.
  - Done: report queue delay, stage/model latency, fallback use, quality, compact prompt token estimates, receipts, artifacts, and failures.
  - Done: keep prompt and artifact payload export disabled by default.
  - Future extension: add optional OTLP collector/exporter wiring for teams that want live telemetry streams.

- [ ] Incremental and event-driven context indexing.
  - Refresh only files changed since the last indexed commit.
  - Support filesystem-watch and CI-triggered indexing.
  - Explain why each retrieved source was included in a compiled brief.
  - Detect stale summaries, renamed files, and deleted sources.

- [ ] Workflow authoring and compatibility tooling.
  - Add JSON Schema and editor validation for agents, workflows, policies, and schedules.
  - Provide a dry-run graph showing stages, dependencies, permissions, and context budgets.
  - Add bundle compatibility checks and definition migrations.
  - Add contract tests for custom agents, workflows, and provider adapters.

- [ ] Optional model-improvement workflow pack.
  - Diagnose whether a quality issue is best handled by context, prompts, routing, eval coverage, retrieval, or model fine-tuning.
  - Prepare scrubbed eval cases and provider-specific fine-tune datasets only from explicitly approved project-local feedback.
  - Orchestrate provider fine-tune jobs and candidate model comparisons when a project opts in and supplies its own provider credentials.
  - Promote routing changes only after baseline-versus-candidate evaluation evidence is recorded.
  - Keep GPU training infrastructure, model registries, private datasets, and large model artifacts outside the core open source package.

## Phase 5: Governed Distribution

Goal: support controlled sharing and operation across teams after the reliability
foundation is complete.

- [ ] Trusted bundle registry.
  - Support bundle discovery, installation, version pinning, upgrade previews, and rollback.

- [ ] Distributed worker pools.
  - Support bounded concurrency, project isolation, worker health, and safe task leasing.

- [ ] Team roles and separation of duties.
  - Distinguish operators, approvers, workflow authors, and auditors.

- [ ] Artifact lifecycle governance.
  - Add configurable retention, archival, deletion receipts, and legal-hold-aware controls.

- [ ] Backup, restore, and disaster-recovery validation.
  - Provide documented recovery procedures and automated restore verification.

## Contribution Boundary

Before adding a roadmap item, classify it:

- Shared platform IP: orchestration, context, routing, safety, observability, evaluation, MCP/IDE integration.
- Private product IP: domain prompts, product scoring, customer data, schemas, authorization, production action policy.

Only shared platform IP belongs in this open-source roadmap. Product-specific learnings should be generalized before promotion.
