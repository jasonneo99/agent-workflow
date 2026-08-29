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
  - Next: prepare the next signed npm/GitHub package release so recent dashboard and model-improvement improvements reach installed users.

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

- [x] Checkpointed resume and deterministic replay.
  - Done: dashboard and CLI controls can resume unfinished stages from the last completed checkpoint.
  - Done: new runs persist workflow snapshots, and replay can queue a fresh run from stored task, provider settings, policy snapshot, workflow snapshot, and compiled context.
  - Done: resume and replay warn when project config, execution policy, bundle checksum, workflow definition, or selected source file hashes differ from queued run evidence.
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

- [x] Incremental and event-driven context indexing.
  - Done: refresh only files changed since the last indexed commit after a baseline exists.
  - Done: detect renamed and deleted sources and prune stale stored summaries.
  - Done: expose incremental defaults through CLI, dashboard-triggered runs, and MCP tools.
  - Done: explain why each retrieved source was included in a compiled brief.
  - Done: support lightweight local watch polling and CI-triggered `--since-commit` indexing.

- [x] Workflow authoring and compatibility tooling.
  - Done: add JSON Schema and editor validation for agents, workflows, project policies, and schedules.
  - Done: provide a dry-run graph showing stages, dependencies, permissions, approvals, agents, and context budgets.
  - Done: add a standalone bundle compatibility report for runtime, Node.js, MCP requirements, and migration notes.
  - Done: add read-only project bundle upgrade previews with applicable migration notes and safe next actions.
  - Done: add project bundle-state recording during onboarding/adoption.
  - Done: add explicit bundle adoption recording after reviewed upgrades.
  - Done: add definition migration and rollback guidance for changed bundle contracts.
  - Done: add contract tests for custom agents, workflows, and provider adapters.
  - Done: add dashboard visibility for bundle compatibility, migration guidance, and contract-test readiness.

- [ ] Optional model-improvement workflow pack.
  - Done: add reusable agents and a `model-improvement` workflow to diagnose whether a quality issue is best handled by context, prompts, routing, eval coverage, retrieval, or model fine-tuning.
  - Done: add dashboard visibility for scorecard health, eval gaps, routing recommendations, and promotion readiness.
  - Done: prepare scrubbed eval cases and provider-specific fine-tune dataset plans only from explicitly approved project-local feedback.
  - Done: orchestrate plan-only provider fine-tune job plans and candidate model comparisons when a project opts in and supplies its own provider credentials.
  - Done: add dashboard visibility for candidate comparison plans, generated suite files, baseline/candidate variants, and promotion gates.
  - Done: surface candidate comparison outcomes, leader, quality delta, latency delta, and gate readiness after evaluations run.
  - Done: recommend keep-baseline, run-more-evals, or reviewed-routing-note promotion actions only after baseline-versus-candidate evaluation evidence is recorded.
  - Done: generate reviewed project-local routing-note patch plans from promotion recommendations without automatically changing live routing.
  - Done: add dashboard follow-up actions for promotion note plans while preserving dry-run-by-default behavior.
  - Done: surface written promotion note plan files in the dashboard for review and sharing.
  - Done: add an end-to-end model-improvement walkthrough with sample local evidence, screenshots, and expected command output.
  - Done: add synthetic candidate-comparison screenshot assets for npm, GitHub, and docs.
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
