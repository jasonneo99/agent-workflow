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
- Dashboard workflow graph view for agent, subagent, stage, approval, policy, and context-budget connections.
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
  - Done: verify release readiness after recent dashboard and model-improvement improvements with the read-only release checker and dry-run release prep.
  - Done: run the real signed patch release prep for the next package version.
  - Done: publish `0.2.4` through GitHub Actions Trusted Publishing.
  - Next: continue the distributed worker-pool controls now that installed users can get the latest dashboard and model-improvement work.

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

- [x] Dashboard graph and mind-map visualization.
  - Done: add `/workflow-graph` and `/api/workflow-graph` for browser and machine-readable workflow connection inspection.
  - Done: show stages, primary agents, subagents, context budgets, approvals, policy status, and Mermaid output.
  - Done: add an optional visual mind-map layout for agent connections, suitable for screenshots, docs, and non-technical workflow review.
  - Done: add filter controls for agent category, approval requirement, and policy status when workflows grow beyond quick scanning.
  - Done: add a screenshot/export-friendly graph capture flow for docs and project handoffs.
  - Done: add a lightweight SVG network map mode with workflow, stage, primary-agent, subagent, current-run, and historical-run nodes.
  - Done: add reusable screenshot assets and a local regeneration command for the graph and mind-map views.
  - Done: make network-map nodes inspectable by linking stages to the Stage Matrix and runs to run details.
  - Done: improve network-map label placement near graph edges for dense workflows.
  - Done: add focused graph run-status filters for active runs, failed runs, exact statuses, and definition-only snapshots.
  - Done: reshape the network map into a layered neural-style developer view with workflow input, stage layer, agent layer, and run outputs.
  - Done: add high-contrast cinematic neural styling to make the network map feel like a developer command surface while staying inspectable.
  - Done: size network-map nodes by incoming request count so frequently invoked agents, stages, and run outputs stand out.
  - Done: reshape the network map into a radial web with transparent nodes and color carried by stroke/glow.
  - Done: add network-map orientation controls so developers can switch between horizontal and radial web layouts.
  - Done: overlay per-stage run health so the graph can show which workflow step tends to fail, stall, or complete.
  - Done: add stage-click run filtering so clicking a stage can focus recent runs and failures for that workflow step.
  - Done: add a stage-level "suggest fix" action that prepares a targeted debug workflow from the focused failure history.
  - Done: tag suggested fix runs with source workflow/stage metadata and show related debug-run outcomes in the focused stage panel.
  - Done: link completed suggested-fix runs to tagged source-workflow reruns for verification.
  - Done: calculate and display visual before/after stage-health deltas between the source history and verification reruns.
  - Done: add a compact graph legend/state explainer for developer onboarding and screenshot readability.
  - Done: add a graph handoff export that saves the selected graph URL, filters, and current health summary beside project reports.
  - Done: add a small recent graph exports panel so developers can reopen or share prior graph handoffs from the dashboard.
  - Done: add an optional dashboard-safe graph export viewer route so developers can inspect saved handoff Markdown without leaving the browser.
  - Done: add lightweight export lifecycle actions such as copyable CLI commands and project-local prune guidance without deleting files implicitly.
  - Done: polish graph handoff ergonomics after user testing, then close this visualization milestone.

- [x] Optional model-improvement workflow pack.
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
  - Done: document the model boundary: keep GPU training infrastructure, model registries, private datasets, and large model artifacts outside the core open source package.

## Phase 5: Governed Distribution

Goal: support controlled sharing and operation across teams after the reliability
foundation is complete.

- [x] Trusted bundle registry.
  - [x] Add a local trusted bundle registry file for discovery, install guidance, version visibility, and signer fingerprints.
  - [x] Add CLI and dashboard visibility for registry entries and local installed-bundle status.
  - [x] Add dry-run-by-default project-local bundle version pinning.
  - [x] Add reviewed upgrade/rollback command plans without automatic code installation.
  - [x] Add a dashboard action to generate lifecycle plans from the Bundles page.

- [x] Distributed worker pools.
  - Support bounded concurrency, project isolation, worker health, and safe task leasing.
  - Done: define worker identity, lease ownership, and heartbeat visibility before adding multi-worker execution.
  - Done: add explicit expired-lease recovery so interrupted worker tasks can be safely requeued by policy.
  - Done: add project-scoped worker filters and bounded concurrency settings before enabling true multi-worker pools.
  - Done: add a multi-worker heartbeat registry so the dashboard can show all active worker lanes, not just the most recent local daemon.
  - Done: add worker-pool defaults to project config so local workers can inherit project-specific limits, concurrency, lease timeouts, and scope.
  - Done: add named worker-pool supervision profiles for starting multiple lanes from one command.

- [ ] Governed server mode.
  - Keep local-only CLI, MCP stdio, dashboard, worker, and storage as the default developer workflow.
  - Add an explicit authenticated HTTP/server mode for teams that want a shared Agent Workflow runtime on a trusted network.
  - Define auth, project registration, role enforcement, audit receipts, and network binding defaults before exposing workflow execution remotely.
  - Document LAN/shared deployment risks and provide secure defaults that do not expose dev Postgres, Redis, MinIO, or project files accidentally.
  - Next: design the server-mode contract after artifact lifecycle and backup/restore governance are further along.

- [ ] Team roles and separation of duties.
  - Distinguish operators, approvers, workflow authors, and auditors.
  - Done: add project-local role definitions and record actor roles on approval decisions and execution receipts.
  - Done: add read-only role enforcement previews before blocking actions by role.
  - Done: add opt-in role enforcement gates for approval and execution actions.
  - Done: add dashboard and CLI role visibility with recent approval decisions grouped by recorded actor role.
  - Done: add optional separation-of-duties checks for projects that want to flag or block the same actor approving and executing the same action.
  - Next: add role-focused dashboard filters and exportable audit snapshots after user testing.

- [ ] Artifact lifecycle governance.
  - [x] Add read-only artifact inventory across registered projects with counts, size estimates, age buckets, artifact kinds, and run associations.
  - [x] Add dashboard, JSON API, and CLI visibility for conservative lifecycle hints without pruning or deleting artifacts.
  - [x] Add dashboard and CLI visibility for artifacts that are safe to prune, should be retained for audit, or need human review.
  - [x] Generate dry-run prune plans with exact artifact ids, URIs, reasons, and estimated storage recovered.
  - [x] Keep legal-hold and retention settings project-local in `.agent-workflow/project.yaml`; default to no automatic deletion.
  - [x] Add project-local retention policy settings and lifecycle receipt previews before any destructive prune execution.
  - [x] Add approved lifecycle action queue plumbing that records approval receipts and still defaults to no deletion.
  - [x] Add no-op lifecycle execution receipts for approved prune actions without deleting or modifying artifacts.
  - [x] Add guarded archive/restore previews and no-op receipts before any prune/delete path.
  - [ ] Record lifecycle execution receipts for skipped items before allowing destructive actions.
  - [ ] Require explicit approval and policy recheck for any write/delete operation against local files or object storage.
  - Next: add skipped-item lifecycle receipts and policy recheck summaries before any destructive archive/prune/delete path.

- [ ] Backup, restore, and disaster-recovery validation.
  - Provide documented recovery procedures and automated restore verification.
  - Next best after lifecycle action queue: add a read-only backup inventory and restore drill report for local enterprise storage.

## Contribution Boundary

Before adding a roadmap item, classify it:

- Shared platform IP: orchestration, context, routing, safety, observability, evaluation, MCP/IDE integration.
- Private product IP: domain prompts, product scoring, customer data, schemas, authorization, production action policy.

Only shared platform IP belongs in this open-source roadmap. Product-specific learnings should be generalized before promotion.
