# Agent Workflow Feature Catalog

## Purpose and scope

This document describes the complete committed Agent Workflow feature surface.
It is a product-level catalog rather than a command reference: related CLI,
dashboard, MCP, API, daemon, and package capabilities are grouped into coherent
features with their operating boundaries.

The catalog covers the open-source framework only. Personal assistants, private
fleet topology, credentials, customer data, machine-specific overlays, and
private product scoring belong outside this repository.

## Product surfaces

| Surface | Description |
| --- | --- |
| CLI | `agentflow` exposes project setup, orchestration, execution, inspection, governance, learning, evaluation, storage, and release operations. |
| Dashboard | Local web control plane for work, runs, approvals, projects, learning, providers, evaluations, governance, readiness, and operational evidence. |
| MCP server | `agentflow-mcp` makes the same governed agents and workflows available to Codex, VS Code, Cursor, and other MCP clients. |
| Worker | Durable stage executor with leasing, fencing, provider capability admission, governed actions, and receipts. |
| Learning daemon | Supervised evidence collection, proposal generation, approval application, routing optimization, queue repair, and repository maintenance. |
| Model gateway | Optional authenticated provider gateway with usage accounting, health checks, offline receipts, and bounded upstream behavior. |
| Reusable bundle | Versioned agents, workflows, schemas, migrations, compatibility metadata, and signed bundle lifecycle tools. |
| Project template | Portable project-local configuration, context, decisions, schedules, policies, and evaluation directories. |

## Orchestration and workflow construction

### Natural-language orchestration

- Classifies a goal before selecting a reusable or dynamic workflow.
- Chooses the narrowest workflow and specialist set that can satisfy the goal.
- Preserves the original acceptance contract through every handoff.
- Supports adaptive, exhaustive, and explicitly trusted execution profiles.
- Returns bounded progress, terminal status, artifacts, and durable receipts.
- Prevents duplicate work through project-scoped work intents and run
  deduplication.

### Dynamic multi-handoff workflows

- Constructs a directed acyclic stage graph from a natural-language goal.
- Selects reusable workflow archetypes and specialist agents.
- Supports parallel branches, joins, dependencies, retry policies, verifiers,
  finalizers, and approval gates.
- Allows bounded stage insertion, removal, repetition, reordering, and context
  tuning while protecting mandatory controls.
- Records construction rationale and validates graph safety before execution.
- Exposes horizontal and radial workflow diagrams, run overlays, handoffs, and
  saved graph presets.

### Workflow reuse and continuation

- Fingerprints tasks and source evidence to detect exact reusable results.
- Recommends fresh execution, result reuse, or checkpoint continuation.
- Resumes unfinished workflows into immutable replacement runs.
- Links replacement, repair, retry, and supersession history.
- Keeps completed, failed, blocked, cancelled, dismissed, and superseded
  history without leaving resolved items in the actionable queue.

## Reusable workflows

| Workflow | Feature description |
| --- | --- |
| `accessibility-review` | Audits accessibility barriers, prioritizes remediation, and verifies regression coverage. |
| `architecture-decision` | Compares architectural options and records a reviewable decision with consequences. |
| `build-feature` | Plans, creates, verifies, packages, and delivers a usable feature; planning alone cannot satisfy BUILD. |
| `ci-triage` | Classifies CI failures, isolates the cause, prepares a correction, and verifies affected checks. |
| `data-migration` | Designs, previews, approves, executes, and verifies reversible schema or data migrations. |
| `debug-failure` | Reproduces, diagnoses, repairs, and verifies a confirmed test, build, CI, or runtime failure. |
| `dependency-upgrade` | Inventories, assesses, upgrades, verifies, and prepares rollback evidence for dependencies. |
| `incident-response` | Triages, contains, diagnoses, recovers, and documents operational or security incidents. |
| `investigate-issue` | Performs read-only investigation when evidence does not yet justify a repair workflow. |
| `maintain-context` | Refreshes compact project context, decisions, and reusable memory. |
| `model-improvement` | Diagnoses quality, cost, routing, context, retrieval, evaluation, prompt, or fine-tuning opportunities. |
| `performance-investigation` | Establishes a baseline, isolates bottlenecks, applies a scoped optimization, and compares results. |
| `product-discovery` | Converts a product problem into evidence-backed scope, success measures, and roadmap candidates. |
| `production-readiness` | Reviews frontend, site quality, UX, security, operations, and launch readiness in one governed pass. |
| `provider-smoke` | Verifies one provider can return valid structured output without requesting unsafe actions. |
| `review-pr` | Reviews code changes for correctness, risk, UX, security, and missing verification. |
| `roadmap-curation` | Reviews daemon suggestions and records only explicitly approved product-roadmap items. |
| `security-audit` | Assesses secrets, permissions, dependencies, privacy, threats, and deployment risk. |
| `ship-release` | Checks release readiness, prepares evidence and notes, and coordinates deployment approval. |
| `wide-open-automation` | Runs maximum-autonomy automation only for projects that explicitly enable it, with receipts and non-bypassable safety controls. |

## Agent roster

### Core coordination

| Agent | Responsibility |
| --- | --- |
| `workflow-orchestrator` | Interprets goals, selects workflow shape, assigns specialists, and owns final coherence. |
| `task-triager` | Classifies work, risk, workflow, and specialist needs. |
| `context-curator` | Keeps durable project context compact, current, and useful. |

### Development specialists

| Agent | Responsibility |
| --- | --- |
| `technical-architect` | Designs implementation approaches that fit the existing system. |
| `implementation-agent` | Performs scoped local changes and verification from an approved plan. |
| `frontend-engineer` | Implements and reviews user-facing web experiences. |
| `backend-engineer` | Implements and reviews APIs, services, jobs, and integrations. |
| `database-engineer` | Designs schemas, queries, migrations, compatibility, locking, and recovery. |
| `test-engineer` | Derives verification from acceptance criteria and reports proven, disproven, and unmeasured results. |
| `ci-debugger` | Diagnoses failing checks and prepares focused corrections. |
| `security-reviewer` | Reviews code, configuration, dependencies, permissions, secrets, and trust boundaries. |
| `model-improvement-diagnostician` | Chooses among context, prompt, routing, evaluation, retrieval, and fine-tuning remedies. |
| `eval-curator` | Converts approved feedback and failures into scrubbed local evaluation cases. |
| `routing-optimizer` | Recommends provider, model-tier, fallback, and promotion changes from evidence. |

### Product specialists

| Agent | Responsibility |
| --- | --- |
| `product-strategist` | Converts goals and constraints into product direction and measurable scope. |
| `ux-reviewer` / Mira | Reviews usability, accessibility, workflow clarity, polish, and user trust. |

### Operations specialists

| Agent | Responsibility |
| --- | --- |
| `docs-maintainer` | Keeps documentation, changelogs, and decisions aligned with verified work. |
| `pr-preparer` | Packages implementation and review evidence into PR and release-ready summaries. |
| `release-manager` | Coordinates release readiness and go/no-go evidence. |

### Automatic agents

| Agent | Responsibility |
| --- | --- |
| `auto-test-runner` | Runs configured verification after changes. |
| `auto-docs-update` | Proposes or applies relevant documentation updates. |
| `auto-memory-summarizer` | Converts completed runs into compact reusable memory. |
| `auto-ci-triage` | Watches CI evidence and prepares targeted diagnosis. |
| `auto-release-check` | Runs scheduled or requested release-readiness checks. |
| `auto-wide-open-executor` | Executes explicitly enabled maximum-autonomy work within policy. |

## Model providers and routing

### Provider adapters

- Deterministic `mock` provider for tests and contract validation.
- Loopback `local` provider for Ollama, LM Studio, llama.cpp-compatible, and
  related OpenAI-compatible runtimes.
- Remote or enterprise `byo` gateway support.
- OpenAI API, Codex CLI with ChatGPT authentication, Anthropic, AWS Bedrock,
  Muse, Kiro, and legacy OpenAI-compatible adapters.
- Provider catalog discovery, readiness probes, bounded inference checks,
  response normalization, usage capture, timeout enforcement, and error
  classification.

### Model selection

- `fast`, `standard`, and `reasoning` tiers.
- Provider-specific automatic model discovery and tier selection.
- Explicit provider/model overrides for reproducibility.
- Per-tier environment overrides and selection policies such as lowest cost,
  balanced, best coding, and maximum reasoning.
- Capability-aware worker admission so a task is leased only to a worker that
  can execute its provider and operating-system requirements.

### Adaptive routing

- Rules-based routing from a structured Agent Intent Representation header.
- Exact agent/task-class comparison evidence and reviewed route preferences.
- Quality, success, fallback, latency, cost, freshness, and minimum-sample
  gates.
- Local holdout promotion with hosted fallback boundaries.
- Independent provider-smoke ordering.
- Circuit state, quota fallback controls, and explicit rollback to fixed
  routing.
- No route change from stale, malformed, thin, or unapproved evidence.

## Durable execution and recovery

### Queue and worker lifecycle

- PostgreSQL-backed workflow runs, stages, handoffs, artifacts, feedback, and
  action receipts.
- Ordered and parallel stage execution with dependency-aware claims.
- Named worker identity, heartbeats, capability advertisement, and fair
  multi-project scheduling.
- Task leases, lease renewal, expiry recovery, fencing tokens, and authoritative
  lifecycle transitions.
- Project execution locks and resource-level serialization for conflicting
  writes.
- Idempotency keys and side-effect reservation before dispatch.

### Governed action loop

- Bounded ReAct-style action iterations.
- Policy-checked commands, file reads, full writes, and hash-pinned surgical
  patches.
- Exact write paths, byte limits, command timeouts, output truncation, and
  preimage verification.
- Approval interruption and audited continuation.
- Action results, before/after evidence, validation, stop reasons, and receipts.
- Environmental verification-failure attribution and bounded retry.

### Recovery features

- Expired-lease recovery and stale-run reconciliation.
- Checkpoint resume into a new immutable run.
- Failed-stage retry without rewriting source history.
- One-click governed repair for blocked runs.
- Context refresh and root-repair workflows for recoverable evidence gaps.
- Provider failure triage and health-checked retry.
- Explicit skip for operator-reviewed blockers.
- Supersession and dismissal of obsolete queue items while retaining history.

## Governance, policy, and autonomy

- Project-scoped autonomy and policy profiles.
- Separate command, read, write, network, approval, provider, and platform
  boundaries.
- Low-to-high daemon trust ceilings that never bypass policy or validation.
- Exact approval rules with risk, command prefix, file pattern, byte, actor,
  expiration, and recurrence constraints.
- Approval backlog, triage, bulk decisions, autopilot for eligible actions, and
  interruption recovery.
- High-risk approval API for authenticated fleet clients.
- Immutable policy snapshots and drift detection.
- Read-only governance reports with remediation guidance.
- Wide-open automation only after explicit project opt-in.
- Repository-wide open-source/private boundary validation.

## Context intelligence

### Project indexing

- Stack-aware onboarding and project configuration.
- Deterministic file summaries and compact project maps.
- Full, bounded, incremental, commit-relative, and watch-mode indexing.
- Deleted-file detection and summary reuse for unchanged content.
- Project discovery through configured roots and optional Spotlight, followed by
  explicit adoption.

### Context Gateway

- Routes large source reads through cited summaries and exact excerpts.
- Risk- and token-aware source selection.
- Project-isolated, content-addressed cache with expiry and symlink-escape
  protection.
- Exact-read escape hatches for high-risk or insufficient evidence.
- Shadow observation before enforcement.
- Versioned calibration, thresholds, holdouts, regression gates, and promotion.
- Host adapters and hooks for Claude Code, Cursor, and Codex.
- Governed code generation from a specification and cited reference files.

### Memory graph

- Project goals, tasks, decisions, results, and evidence nodes.
- Typed links and cost-bounded graph walking.
- Confidence, supersession, deterministic IDs, serialization, and safe
  degradation when storage is unavailable.

## Learning and autonomous improvement

### Local learning daemon

- One-project or all-project supervised operation.
- Durable target selection and LaunchAgent supervision.
- Evidence collection from runs, feedback, evaluations, providers, queue state,
  cost, latency, and context routing.
- Independent lanes with separate trust ceilings for evidence, optimization,
  action execution, runtime maintenance, repository stewardship, CI, security,
  recovery, and training discovery.
- Quiet hours, event wakeups, budgets, backpressure, fair scheduling, and event
  cursors.
- Compacted, health-checked, duplicate-resistant action receipts.

### Learning proposals and application

- Prompt, context-budget, route, workflow-shape, and agent-improvement
  recommendations.
- Ranked evidence, confidence, expected benefit, risk, and rollback notes.
- Governed inboxes and explicit approval/rejection history.
- Patch-plan generation, dry runs, project-local overlays, validation, and
  receipts.
- Shared-agent promotions require stronger evidence than local tuning.
- Recommendations can be simulated in shadow mode before enforcement.

### Repository stewardship

- Source-size inventory and non-regression ratchet.
- Hygiene, duplication, and credential-shaped material scanning.
- Policy-allowed low/medium-risk maintenance with before/after hashes and
  verification.
- Exact-file maintenance commits without staging unrelated user work.
- High-risk trust-boundary changes remain approval-gated.

### Training discovery

- Rotating official/public source discovery.
- Deduplication, quarantine of instruction-like external content, source-health
  evidence, and governed proposal decisions.
- Holdout evaluation before any shared agent behavior is promoted.

## Evaluation, quality, and feedback

- Synthetic and project-local evaluation suites across cases, providers, model
  tiers, and prompt variants.
- Expected status, minimum quality, maximum fallback, latency, and baseline
  regression gates.
- Optional private scoring profiles and case weighting without exporting the
  scoring rules.
- Hidden reliability evaluation in a separate process.
- Accepted, revised, and rejected run feedback.
- Bulk feedback review and feedback inbox.
- Preference scorecards by workflow, stage, agent, provider, and tier.
- Outcome Accuracy: completion, expected-result acceptance, feedback coverage,
  first-pass acceptance, calibrated quality, mismatch detection, fallback use,
  and latency budgets.
- Lifecycle-aware scoring: blocked work cannot receive a passing quality score.
- Provider comparison, candidate comparison, holdout promotion, and auditable
  routing recommendations.
- See [Outcome Accuracy And Provider Fallback Contracts](outcome-accuracy.md)
  for the detailed feature contract.

## Local-model operations

- Runtime readiness and setup guidance.
- Model download recommendations and reviewed installation plans.
- Disk/cache inventory, trends, prune candidates, and storage warnings.
- Local smoke tests and tiny benchmark plans.
- Quality, latency, fallback, and cost evidence.
- Local-versus-hosted holdout comparison and explicit promotion.
- Savings-aware routing recommendations and decision snapshots.
- Project-local route notes and operator feedback.
- Hosted-provider fallback retained for policy, secrets, commands, production,
  and other high-risk work.

## Dashboard and operator experience

### Primary pages

| Area | Pages and capabilities |
| --- | --- |
| Home | Operational overview, workflow throughput, run health, duration, provider mix, daemon activity, approvals, recent runs, and work launch. |
| Work | Studio, queue, approvals, approval rules, runs, run details, and unified activity. |
| Projects | Managed projects, discovery, adoption, indexing, aliases, governance, and per-project detail. |
| Learning | Diagnostics, daemon settings, training proposals, evaluations, feedback, model improvements, comparisons, context efficiency, and roadmap. |
| Providers | Readiness, configuration guidance, model catalog, route evidence, and usage. |
| Governance | Policy health, role audit, artifact lifecycle, bundles, backups, storage, and remediation. |
| Workflow graph | Definition and run graphs, radial/horizontal layouts, handoffs, filters, presets, Mermaid export, and full-screen presentation. |
| System readiness | Storage, runtime, provider, workers, services, MCP cleanup, fleet health, and grouped drill-downs. |
| Settings | Theme, runtime controls, local services, mutation controls, and project configuration. |

### Dashboard behavior

- Light theme by default with selectable persistent dark mode.
- Human-readable primary navigation with grouped sections.
- JSON endpoints for machine inspection.
- Poll coalescing and bounded report loading.
- Browser-local recent dashboard actions.
- Live run progress, numbered stage timelines, worker ownership, recovery chains,
  approval level changes, and fixed follow-up actions.
- Seven-day throughput and operational charts.
- Full 25-route SLA canary with persisted warm-process measurements.

## Observability and performance

- OpenTelemetry-compatible stage spans and aggregate metrics.
- Direct provider usage without prompt bodies.
- Queue delay, model latency, command time, file-write time, approval wait,
  retries, orchestration overhead, useful parallelism, quality, fallback, token,
  and latency-budget metrics.
- Secret and host-path redaction.
- OTLP configuration that can export to one or more collector destinations.
- Local run and route receipts remain the source of truth when an external
  observability destination is unavailable.
- Performance baseline, comparison, regression budgets, storage hot-path
  indexes, HTTP workload harnesses, and dashboard SLA reports.

## Multi-project and fleet features

- Registered-project inventory with canonical identity and root URI.
- Duplicate-name detection, alias decisions, and merge planning.
- Multi-project daemon targeting and fair worker scheduling.
- Host checkout, platform, provider, and worker capability boundaries.
- Fleet health without false critical status from disabled, paused, ephemeral,
  remote, or unavailable-on-host projects.
- Authenticated one-goal server orchestration with idempotency and bounded SSE
  progress.
- Read-only project, queue, roadmap, readiness, routing, request-log, and
  mutation-control APIs.
- Shared-brain intent envelopes are non-executable; separately signed and
  allowlisted adapters are required for fleet actions.
- Versioned client-capability negotiation keeps orchestration authoritative.

## Artifacts, offline operation, and backup

- Compiled briefs, model routes, stage outputs, commands, writes, verification,
  reports, and exported run artifacts.
- Object-storage mirror evidence and artifact lifecycle inspection.
- Offline receipt import with idempotent synchronization.
- Explicit offline fallback planning without silent authority expansion.
- Backup freshness, checksums, restore readiness, and non-destructive restore
  drills.
- Artifact and receipt redaction for portable examples and external sharing.

## Storage and migration

- Enterprise profile using PostgreSQL with pgvector, Redis, and MinIO.
- Simple profile for file-based compilation without local services.
- Idempotent schema bootstrap and ordered migrations.
- Hot-path indexes for queue, recovery, receipts, artifacts, and activity.
- Shared-host endpoint derivation and bounded database pools.
- Storage migration planning, same-target protection, non-empty-target checks,
  verification fingerprints, conflict inspection, and merge manifests.
- Project identity decisions and append-only migration evidence.
- Destructive reset and promotion actions remain explicit operator operations.

## Bundles, packaging, and releases

- Versioned agent/workflow bundle manifest with checksums.
- Detached Ed25519 signatures, trusted signer policy, and tamper detection.
- Compatibility checks for runtime, Node.js, MCP, definitions, and migrations.
- Bundle registry, project pins, adoption, upgrade preview, lifecycle plans, and
  rollback guidance.
- Definition migration catalog with validation and rollback notes.
- npm package containing compiled runtime, agents, workflows, templates,
  schemas, and command-line binaries.
- Atomic release preparation, package verification, release checks, and
  explicit publish boundary.

## IDE and client integration

- MCP tools for validation, context, orchestration, specialists, presets,
  workers, runs, artifacts, feedback, learning, evaluation, providers, and
  bundles.
- Stack-aware IDE onboarding and JSON Schema associations for YAML files.
- Support for terminal, Codex, VS Code, Cursor, Claude Code hooks, and other MCP
  clients.
- Conversation contract for bounded, scrubbed, project-scoped assistant
  requests.
- Stable client capability document and compatibility rejection for unsupported
  clients.

## Security and trust features

- Fail-closed policy evaluation and immutable policy hashes.
- Secret-shaped material detection and output redaction.
- Path traversal and symlink escape protection.
- Bounded provider and executor response bodies.
- No cross-origin gateway redirects or absolute-form target forwarding.
- Authentication for fleet and server mutation surfaces.
- Signed external executor snapshots bound to project, adapter, operation, and
  revision.
- Command allowlists, file allowlists, network gates, action approvals,
  idempotency, and rollback evidence.
- Security scans, dependency review, CI release gates, and repository boundary
  validation.

## Developer and contributor tooling

- Agent, workflow, project, schedule, bundle-state, and evaluation schemas.
- Definition validation and provider-independent contract tests.
- Deterministic mock execution and scrubbed examples.
- Type checking, full test suite, boundary validation, source-size ratchet, and
  release verification under `npm run check` and release checks.
- Enterprise smoke tests, provider smoke, dynamic planner canary, reliability
  baseline/gate, chaos controls, dashboard screenshots, and SLA canary.
- Reusable project templates and guided setup.
- Documentation for architecture, policies, providers, recovery, context,
  model improvement, performance, packaging, and releases.

## Runtime package index

This index maps every committed runtime package to its primary feature area.

| Package | Primary capability |
| --- | --- |
| `agent-registry` | Agent, workflow, project, schedule, and bundle schema registry. |
| `bundle-trust` | Signing, verification, trust policy, compatibility, and upgrades. |
| `cli-smoke` | Packaged CLI smoke validation. |
| `client-capabilities` | Versioned client/runtime capability negotiation. |
| `context-calibration` | Context threshold evidence, holdouts, and regression gates. |
| `context-compiler` | Compiled briefs, section budgets, AIR headers, and tuning notes. |
| `context-gateway` | Governed read routing, caching, evidence, and enforcement. |
| `context-host-adapters` | Claude, Cursor, and Codex host hooks. |
| `context-selector` | Risk-, relevance-, and token-aware source selection. |
| `contract-tests` | Definition and provider contract validation. |
| `conversation-contract` | Bounded assistant conversation parsing and redaction. |
| `daemon-control` | Daemon lanes, trust ceilings, and mutable control contract. |
| `dashboard` | Shared dashboard-domain helpers and operational reporting. |
| `dashboard-report-cache` | Durable bounded dashboard snapshots. |
| `definition-migrations` | Reusable definition upgrade and rollback catalog. |
| `dynamic-workflow` | Archetype selection, construction, mutation, and validation. |
| `evaluation` | Evaluation suites, scoring, gates, comparison, and ranking. |
| `executor-adapters` | Signed external execution contracts and adapters. |
| `failure-triage` | Provider and executor failure classification and retry decisions. |
| `fleet-model-gateway` | Authenticated provider gateway, usage, health, and receipts. |
| `governance` | Cross-project health, drift, roles, artifacts, and remediation. |
| `governed-codegen` | Policy-bound generation from specifications and references. |
| `guarded-autonomy` | Promotion evidence, canary decisions, and rollback gates. |
| `ide-onboarding` | Editor/MCP onboarding and schema setup. |
| `idempotency-lease` | Idempotency and lease coordination primitives. |
| `learning-evidence` | Normalized learning evidence and health. |
| `learning-governance` | Learning approval, application, and promotion boundaries. |
| `learning-proposals` | Ranked prompt, context, route, and workflow recommendations. |
| `local-tools` | Governed local file and command operations. |
| `model-providers` | Provider adapters, routing, prompts, quality, and telemetry. |
| `observability` | OpenTelemetry-compatible spans, metrics, and redaction. |
| `perf-harness` | Performance summaries and regression comparisons. |
| `policy-engine` | Profiles, action policy, risk, approvals, and snapshots. |
| `project-indexer` | Full and incremental source indexing. |
| `reliability-control` | Run ownership, fencing, state transitions, and SLOs. |
| `reliability-evaluator` | Isolated hidden candidate evaluation. |
| `reliability-suite` | Baselines, manifests, failure matrix, and reliability reports. |
| `repository-maintenance` | Hygiene/security scan, size ratchet, and scoped commits. |
| `reuse-engine` | Result reuse, continuation, and source-evidence fingerprints. |
| `roadmap-planner` | Roadmap extraction and next-item planning. |
| `roadmap-snapshot` | Bounded roadmap publication and freshness classification. |
| `run-reporter` | Run exports, cost/quality, outcome accuracy, and tuning history. |
| `runtime-root` | Packaged and development runtime-path resolution. |
| `schema-registry` | Discoverable JSON Schema resources. |
| `storage` | PostgreSQL persistence, migrations, queueing, receipts, and graph data. |
| `training-discovery` | Official-source discovery, quarantine, and proposal lifecycle. |
| `workflow-engine` | Compilation, queue execution, action loop, recovery, and telemetry. |
| `workflow-inspector` | Workflow graph and policy inspection. |
| `workflow-optimizer` | Event-driven optimization, budgets, simulation, and receipts. |

## Feature maturity and evidence rules

- A feature is **implemented** when committed source and focused tests establish
  its contract.
- A feature is **locally validated** only when its relevant checks ran
  successfully in the current checkout.
- A feature is **deployed locally** only after the supervised local runtime was
  restarted onto that source.
- A feature is **production ready** only when the target environment's external
  acceptance, credentials, integrations, and rollback requirements are also
  verified.
- A roadmap proposal or uncommitted parallel edit is not a shipped feature and
  is intentionally excluded from this catalog until merged.
