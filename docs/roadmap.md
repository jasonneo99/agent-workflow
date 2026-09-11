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

It should not absorb private product intelligence from any consuming project or
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
- Agent design-pattern gap analysis covering single-shot, ReAct, planner-executor, reflexive, verifier-gated, and combined production architectures.

## Milestone Map

Ultimate goal: make Agent Workflow a portable, local-first, open-source
developer operating layer for AI agents. A developer should be able to connect
Codex, Cursor, VS Code, CLI, MCP, local models, OpenAI, Bedrock, or BYO model
gateways; point Agent Workflow at a project; and get repeatable agentic
development workflows that understand project-local context, route work to the
right specialists and models, manage approvals safely, reduce tokens and cost,
learn from outcomes, and improve over time without exporting private project
intelligence by default.

These milestones organize the detailed roadmap items below:

1. **Portable Core**
   - Workstreams: reusable agent cards, reusable workflow definitions, project
     templates, CLI commands, MCP tools, provider-neutral schemas, workflow
     authoring, bundle compatibility, and IDE onboarding.
   - Current status: core is usable and versioned; keep future changes
     provider-neutral and portable across Codex, Cursor, VS Code, CLI, and MCP.

2. **Enterprise Local Runtime**
   - Workstreams: Postgres/pgvector, Redis, object storage, durable runs,
     tasks, approvals, receipts, artifacts, memory, indexes, project registry,
     and bootstrap/doctor tooling.
   - Current status: local enterprise storage is the default serious workflow;
     simple flat-file mode remains an opt-in lightweight path.

3. **Developer Dashboard**
   - Workstreams: dashboard home, runs, queue, approvals, projects, agents,
     providers, model catalog, learning, graph, settings, governance, server
     readiness, screenshots, action feedback, and visual polish.
   - Current status: dashboard is broad and useful; continue prioritizing
     action clarity, fewer confusing lists, and decision-ready status surfaces.

4. **Safe Autonomy**
   - Workstreams: action policies, approval inbox, always-approved local rules,
     approval autopilot, backlog radar, daemon-safe cleanup, stale-run repair,
     deployment/autonomy approvals, and high-risk human gates.
   - Current status: low/medium local developer side effects can be automated
     by policy; high-risk, destructive, provider, server, network, production,
     and private-data actions stay gated.

5. **Model Intelligence Layer**
   - Workstreams: provider adapters, live model catalogs, auto tier routing,
     local/BYO/OpenAI/Bedrock/Kiro support, model policy selection, cost and
     quality reporting, fallback behavior, and provider-specific overrides.
   - Current status: model selection can use live catalogs and policy scoring;
     next improvement is stronger holdout evidence before expanding local or
     cheaper routing thresholds.

6. **Local Learning Daemon**
   - Workstreams: learning reports, proposal inbox, apply-approved mode,
     workflow-shape optimizer, project discovery, daemon heartbeat/status,
     approval autopilot integration, and owned learning files.
   - Current status: daemon can observe, propose, and autonomously update
     Agent Workflow-owned local learning state across registered projects.

7. **Self-Improving Agent System**
   - Workstreams: agent-improvement reports, YAML patch previews, holdout eval
     scoring, promotion queues, rollback/source-hash evidence, project-local
     agent cards, and owner-controlled auto-apply.
   - Current status: recommendations, patches, evals, promotions, rollback
     receipts, and owner-controlled project-local auto-apply exist; next
     improvement is stronger promotion evidence and review UX before any
     broader shared-agent or research-driven automation.

8. **Multi-Project / Multi-Machine State Plane**
   - Workstreams: shared storage migration, shared host/LAN/Tailscale state plane,
     project alias merge, object artifact proof, offline fallback, background
     sync, cross-machine path mapping, and switch-over evidence.
   - Current status: shared storage can be proven as primary while localhost
     storage remains fallback-only; continue hardening sync and recovery proof.

9. **Governed Server Mode**
   - Workstreams: authenticated HTTP mode, registered project ids, request
     envelopes, route previews, queue endpoint, approval/action envelopes,
     auth hardening, rate limits, redacted audit logs, network binding defaults,
     and reverse-proxy/TLS guidance.
   - Current status: queueing is gated and approval/action preview exists;
     next improvement is the mutation-disabled remote approval/action endpoint
     behind explicit server-mode/auth/role/idempotency/receipt gates.

10. **Production-Ready Developer Workflow**
    - Workstreams: one-command dev startup, LaunchAgent durability, worker
      supervision, run-and-watch, onboarding docs, local smoke tests, dashboard
      feedback, and default recommended workflow.
    - Current status: local dev startup and durable supervision are usable;
      keep reducing setup ambiguity and stuck-process confusion.

11. **Trust, Recovery, And Distribution**
    - Workstreams: signed bundles, trusted registry, npm publishing, release
      checks, scrubbed examples, screenshots, backup/restore, disaster recovery,
      bundle lifecycle planning, and contribution boundaries.
    - Current status: package distribution and trust primitives exist; keep
      release/readiness evidence and recovery proof easy to verify.

12. **Ecosystem Fit**
    - Workstreams: Codex, Cursor, VS Code, CLI, MCP stdio, future hosted/server
      clients, local models, OpenAI, Bedrock, BYO gateways, and open-source docs
      for integration examples.
    - Current status: MCP/client integrations work but need continued transport
      diagnostics and reload guidance for Codex-side stdio failures.

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
  - Milestone: 11 Release Trust
  - Priority: low
  - Produce safe synthetic examples for docs.
  - Validate committed examples in CI so private data patterns do not drift into documentation fixtures.

- [x] Versioned agent/workflow bundle manifests.
  - Track bundle version, source, checksum, compatibility, and migration notes.
  - Support safer sharing across teams and IDE clients.

- [x] Named execution policy profiles for local, staging, and production targets.
  - Provide reusable command/write/autonomy presets.
  - Preserve dry-run and explicit-write defaults for risky operations.
  - Persist the selected profile and immutable resolved policy snapshot with each run without requiring separate storage per target environment.

- [x] Live provider model catalog routing.
  - Support `MODEL=auto` for OpenAI, BYO/OpenAI-compatible gateways, and Bedrock so tier models are selected from the live model catalog available to the user's key, local endpoint, or AWS profile.
  - Support `AGENTFLOW_MODEL_POLICY` so users can choose lowest-cost, balanced, best-coding, or maximum-reasoning catalog selection without pinning provider-specific model IDs.
  - Keep exact per-tier model overrides for pinned reproducible runs.
  - Show selected tier models and catalog status in provider checks and dashboard surfaces without hard-coding release-specific model IDs into workflow definitions.
  - Explain auto model selection in `/model-catalog` and `/api/model-catalog`, including provider availability, override source, estimated cost class, policy score, tier fit, and top catalog candidates.

## Phase 2: Evaluation And Personalization

Goal: improve quality and cost while keeping personalization auditable and portable.

- [x] Evaluation harness for comparing providers, tiers, and prompts.
  - Compare quality, fallback, latency, estimated cost, and feedback outcomes.
  - Support synthetic benchmark projects and project-local private evals.

- [x] Local LLM / first-class local model provider and hybrid routing.
  - Milestone: 5 Model Intelligence Layer
  - Priority: high
  - Add an explicitly selected local inference provider for runtimes such as
    Ollama or llama.cpp while preserving the existing OpenAI-compatible path.
  - Keep hosted providers, including OpenAI, as the default; local inference is
    an opt-in privacy, offline, and cost-control tier rather than an automatic
    replacement.
  - Start with low-risk, read-only workloads such as summarization,
    classification, log triage, and routine reports. Do not use local model
    output to bypass deterministic authorization, approval, or command policy.
  - Extend provider checks, live model discovery, tier routing, dashboard
    visibility, and evaluation reports to distinguish local runtime readiness,
    model availability, latency, quality, energy use, fallback, and avoided API
    cost.
  - Validate with representative scrubbed evals and require reviewed promotion
    evidence before any project enables automatic local routing.
  - Done: add `DEFAULT_MODEL_PROVIDER=local` as a first-class OpenAI-compatible
    adapter with `LOCAL_MODEL_*` configuration, Ollama-compatible localhost
    defaults, auto-routing priority, dashboard provider controls, docs, examples,
    and provider tests.
  - Done: add local-provider evaluation and savings evidence to
    `/model-improvement` and usage summaries, comparing local/BYO stage volume,
    latency, feedback quality, fallback rate, hosted baselines, and avoided
    hosted calls before expanding local routing beyond low-risk stages.
  - Done: add `local-holdout-comparison` as an explicit local LLM versus hosted
    baseline comparison runner that reuses private model-improvement eval cases,
    writes only project-local Agent Workflow comparison files, and documents the
    promotion boundary before project owners raise local routing risk thresholds.
  - Done: add a dashboard action on `/candidate-comparisons` that writes the
    local-vs-hosted holdout comparison plan for a selected project without
    editing provider settings or shared workflow definitions.
  - Done: add `local-holdout-results` plus a `/candidate-comparisons`
    dashboard action to persist local-vs-hosted pass/fail promotion evidence
    under project-local model-improvement files.
  - Done: add `local-holdout-promote` and a `/candidate-comparisons` approval
    control that consumes captured holdout result evidence and writes reviewed
    project-local low-risk local-routing threshold notes.
  - Done: feed reviewed low-risk local-routing threshold notes into automatic
    route selection through compiled project tuning context, with route-reason
    telemetry when local is selected or skipped.
  - Done: surface local-holdout routing decisions, promotion status, evidence
    suites, recent local route volume, and fallback rates in `/model-improvement`
    and `/candidate-comparisons` trend summaries.
  - Done: add route-receipt trend aggregation so local-selected, local-skipped,
    hosted-selected, and hosted-fallback decisions can be compared by workflow,
    stage, agent, provider, and tier in `/model-improvement` and
    `/candidate-comparisons`.
  - Done: add a focused `local-llm-checklist` CLI, `/api/local-llm-checklist`,
    and `/model-improvement` panel that verify the local model endpoint,
    selected model catalog entry, routing visibility, holdout promotion state,
    and first low-risk route receipt.
  - Done: add `local-llm-smoke` plus a `/model-improvement` checklist action
    that queues one safe fast-tier `provider-smoke` stage, processes it, exports
    the run, and reports whether local was selected, skipped, or replaced by
    hosted routing.
  - Done: add local smoke outcome evidence to the checklist, JSON API, and
    `/model-improvement`, including smoke run history, first true local success,
    latest skipped/fallback/failure reason, and a recommended model download or
    routing fix.
  - Done: add `local-llm-setup-guide` plus `/model-improvement` actions that
    probe configured local, Ollama, LM Studio, vLLM, and llama.cpp-compatible
    endpoints, write project-local setup evidence, and write reviewed
    project-local routing notes only after local checklist evidence is healthy.
  - Done: add model-specific local download recommendations from detected
    hardware, runtime catalog, task mix, quality history, and cost-savings goals.
  - Done: add optional measured local benchmark receipts that run tiny
    summarization and code-review prompts against installed local candidates and
    compare latency and rubric quality before smoke promotion.
  - Done: add a local model installation assistant that turns recommendations
    into reviewed runtime-specific commands while preserving operator approval
    for downloads, provider setting changes, and disk-heavy actions.
  - Done: add local model disk/cache inventory so the dashboard can show
    installed model size, last-used evidence, prune candidates, and storage
    pressure before recommending more downloads.
  - Done: add reviewed local model prune plans that convert inventory prune
    candidates into explicit runtime-specific cleanup commands without deleting
    anything automatically.
  - Done: add local model cache trend history so storage growth, prune decisions,
    and local-vs-hosted usage can be compared over time.
  - Done: add optional local model cost ledger estimates that combine avoided
    hosted calls, benchmark latency, and cache storage cost into a per-project
    savings trend.
  - Done: add savings-aware local routing recommendations that suggest where
    local models should expand, hold, or retreat based on quality, fallback,
    latency, and cost-ledger trend evidence.
  - Done: add reviewed routing-note patch plans from savings-aware local routing
    recommendations so approved expand/retreat decisions can update
    project-local tuning notes without touching shared provider defaults.
  - Done: add an approval-aware apply step for reviewed local routing-note plans
    that appends selected notes to `.agent-workflow/tuning/routing-preferences.md`
    with rollback receipts.
  - Done: add dashboard visibility for applied local routing-note receipts so
    operators can see active local-routing preferences, skipped duplicates, and
    rollback hashes from `/model-improvement`.
  - Done: add tests for local routing-note plan application, including duplicate
    skipping, required approval for writes, and dashboard receipt parsing.
  - Done: add a compact model-routing decision timeline that combines
    recommendation, note-plan, application receipt, and later quality outcome
    into one operator view.
  - Done: add persisted local routing decision snapshots so the timeline can
    compare decisions over time instead of only the current dashboard projection.
  - Done: add holdout-backed local-routing promotion thresholds so expanded
    local routing uses representative task evidence before broader adoption.
  - Done: add a dashboard drilldown that shows why a local route was selected
    or skipped for each recent stage, including threshold, readiness, and
    fallback evidence.
  - Done: add route-level feedback prompts from the drilldown so users can mark
    a local-selected, local-skipped, hosted-fallback, or hosted-selected decision
    as helpful or costly without leaving the dashboard.
  - Done: feed route-decision feedback into savings-aware routing
    recommendations so repeated "costly" or "helpful" signals change expand,
    hold, and retreat suggestions before new routing notes are proposed.
  - Done: show route-feedback influence directly beside each savings-aware
    routing recommendation so operators can see which helpful/costly signals
    changed the recommendation.
  - Done: add CLI smoke coverage for route-decision feedback recording and
    project-local learning artifact writes.
  - Done: add a dedicated macOS local-model LaunchAgent with a stable runtime
    resolver, loopback-only binding, isolated logs, crash/login restart policy,
    upgrade-safe refresh commands, and Runtime Monitor visibility. Keep the
    dashboard, worker lanes, and learning daemon under the existing Agent
    Workflow supervisor so model-runtime failures remain isolated.
  - Done: remove versioned Homebrew Node paths from the main macOS LaunchAgent;
    a stable `/bin/zsh` wrapper now resolves Node at service start so dashboard,
    worker, and learning-daemon recovery survives Node and package upgrades.
  - Done: extract savings-aware routing recommendation scoring into a pure
    library module with unit tests for helpful/costly feedback influence.
  - Done: feed route-decision feedback summaries into the local learning daemon
    report so the daemon can prioritize repeated costly routing decisions across
    projects.
  - Done: use route-feedback costly and helpful group summaries to generate low-risk
    learning proposals for routing retreat/expand review across projects.
  - Done: add a dedicated owned-state writer that refreshes route-feedback
    recommendation files from approved learning proposals without shelling out
    or changing provider settings.
  - Done: add focused tests for autonomous route-feedback recommendation refresh
    receipts and skipped-action accounting.

- [x] Dashboard run comparison view.
  - Compare runs by workflow, stage, agent, provider, tier, quality, fallback, and feedback.
  - Highlight regressions and improvement candidates.

- [x] Tuning proposal approval history.
  - Track which proposals were accepted, rejected, applied, reverted, or superseded.
  - Feed future scorecards without auto-promoting risky behavior.

- [x] Shared evaluation patterns, private product scoring.
  - Keep generic quality and routing mechanics public.
  - Keep product-specific ranking, customer-derived feedback, and domain heuristics private.

- [x] Local learning report.
  - Goal: continually improve local developer workflows from approved feedback, run history, failures, routing outcomes, evaluation evidence, and optional user-approved research notes.
  - Principle: maximize safe autonomy for observation, reports, scoring, proposal generation, and Agent Workflow-created learning state; require approval for dangerous, behavior-changing, networked, reusable-bundle, command, provider, production, or private-data actions.
  - Done: document the local-first architecture in [Local Learning Daemon](local-learning-daemon.md), then add the read-only `learning-report` CLI, `/learning` dashboard page, and `/api/learning-report` JSON endpoint.
  - Done: use local learning proposal outcomes to drive daemon observe/propose/apply-approved design.

- [x] Local learning proposal inbox.
  - Generate learning proposals from run, feedback, failure, routing, tuning, and eval evidence.
  - Write reviewable proposal and approval inbox files that Agent Workflow created and owns under `.agent-workflow/learning/`.
  - Expose the inbox in the dashboard, CLI, and MCP without applying changes.

- [x] Local learning daemon observe/propose mode.
  - Build on the read-only learning report with bounded one-shot and long-running observe/propose modes.
  - Write Agent Workflow-created latest report, proposal inbox, and daemon heartbeat/status files only under `.agent-workflow/learning/`.
  - Expose daemon status in the dashboard, CLI, and MCP.

- [x] Local learning approved-application planning.
  - Prepare apply-ready plans from already approved learning proposals without applying source, provider, reusable bundle, command, network, or export changes.
  - Expose `learning-application-plan` in CLI, dashboard, API, and MCP.
  - Write only Agent Workflow-created application plan files under `.agent-workflow/learning/`.

- [x] Local learning apply-approved mode.
  - Let the daemon prepare application plans on a schedule for approved proposals.
  - Default `learning-daemon` to `apply-approved` so it autonomously refreshes Agent Workflow-owned learning reports, proposal state, workflow-shape recommendation files, application plan files, and low/medium-risk project-local optimization overlays.
  - Default durable supervision to `AGENTFLOW_LEARNING_SCOPE=all-projects`, so one local daemon iterates every registered project and writes each project's own learning state.
  - Default the autonomous apply threshold to low/medium risk; high-risk proposals still require approval.
  - Keep `apply-approved` local-state-only: it does not execute shell commands, run tools, edit source, change providers, promote shared reusable definitions, call networks, or export private data.
  - Keep dangerous, behavior-changing, networked, reusable-bundle, command, provider, production, and private-data actions approval-gated.
  - Done: add durable local restart support by supervising the learning daemon inside `npm run dev:agentflow` and offering a macOS LaunchAgent install path.
  - Done: add Settings-page LaunchAgent status, install/refresh/uninstall actions, and stdout/stderr log links for local macOS durability.
  - Done: explain project-scoped learning daemon status in the dashboard and add a Learning-page action to make the selected project the durable daemon target.
  - Start local-only; make server mode an explicit future deployment posture.

- [x] Governed local filesystem discovery.
  - Done: add `discover-projects` CLI dry-run, `/discovery` dashboard page, and `/api/discovery` JSON endpoint for marker-based project discovery without content indexing.
  - Done: add explicit adoption flow with `adopt-discovered-projects` and dashboard candidate actions for initialization, registration, and indexing.
  - Add an explicit local discovery/index plan for roots outside registered projects, with opt-in include roots, default secret/cache/system excludes, dry-run preview, and project registration before content indexing.
  - On macOS, use Spotlight metadata as an optional discovery accelerator for likely code/document roots before falling back to filesystem traversal.
  - Keep whole-drive discovery local-first and auditable; never export private file contents, secrets, model artifacts, photos, mail stores, backups, or ignored directories by default.

- [x] Local learning workflow shape optimizer.
  - Analyze run history, failures, feedback, routing/cost data, eval evidence, and indexed project context.
  - Recommend adding, removing, splitting, collapsing, or gating workflow stages and proposing new agent types.
  - Default to autonomous refresh of Agent Workflow-owned learning artifacts under `.agent-workflow/learning/`, with a dashboard switch for approval-first review.
  - Prefer project-local workflow overlays before shared workflow or reusable agent changes.
  - Keep shared `workflows/*.yaml`, reusable agents, provider settings, project source, and tuning application approval-gated.

- [x] Local learning agent definition improvement loop.
  - Use the learning daemon to inspect reusable and project-local agents by role, workflow usage, failures, feedback, routing/cost signals, eval evidence, and project context.
  - Generate role-specific improvement candidates for agent prompts, capabilities, approval boundaries, context budgets, and validation expectations.
  - Write only Agent Workflow-owned recommendation artifacts by default: `.agent-workflow/learning/agent-improvement-report.json` and `.agent-workflow/learning/agent-improvement-recommendations.md`.
  - Expose the loop through `agent-improvement-report`, `/api/agent-improvement-report`, the `/learning` dashboard, and MCP.
  - Done: add `agent-improvement-patches`, `/api/agent-improvement-patches`, MCP patch previews, schema validation, source hashes, rollback references, and dashboard links for exact YAML patch review without editing agent files.
  - Done: add holdout eval scoring with `agent-improvement-evals`, `/api/agent-improvement-evals`, MCP, daemon refresh, dashboard promotion scores, pass/warn/fail gates, representative task coverage, source-hash rollback evidence, and future auto-apply readiness.
  - Done: add candidate promotion queues and receipts with `agent-improvement-promotions`, `/api/agent-improvement-promotions`, MCP, daemon refresh, dashboard visibility, source-hash preservation, superseded stale items, and approval/rejection receipt files.
  - Done: add `agent-improvement-apply`, MCP apply wrapper, daemon `apply-approved` integration, dashboard status counters, schema/source-hash checks, and rollback receipts for applying approved agent YAML promotions within the configured risk threshold.
  - Done: add an owner-controlled project-local agent-card auto-apply setting so the daemon can apply only holdout-passing, auto-ready, source-hash-current project-local YAML promotions within the configured risk threshold.
  - Keep unapproved or high-risk reusable agent changes, new agent types, tool privileges, broader autonomy, web/model research, and signed/released bundle promotion gated by explicit owner control.

- [x] Local learning proposal-to-action receipts.
  - Record an append-only local history when proposals become application plans, when planned actions are superseded, and when users reject a planned action.
  - Expose receipts in CLI, dashboard, API, and MCP.
  - Write only Agent Workflow-owned receipt files under `.agent-workflow/learning/`.
  - Done: add receipt health reporting, duplicate daemon-open receipt detection, and backup-first compaction through CLI, JSON API, and the `/learning` dashboard.

- [x] Daemon stale MCP session hygiene.
  - Detect Agent Workflow MCP processes from the current checkout and group them into launch sessions.
  - Preserve the newest MCP session while marking only old duplicate sessions as low-risk auto-cleanable candidates.
  - Keep open-source defaults preview-only; allow owners to opt into `auto-low-risk` cleanup with env settings.
  - Write Agent Workflow-owned cleanup receipts under `.agent-workflow/learning/` and surface daemon cleanup status in the dashboard.

- [x] Daemon stale run reconciliation.
  - Detect queued/running parent workflow runs whose child tasks are already terminal, with no queued, running, or failed child tasks remaining.
  - Let the learning daemon automatically repair safe Agent Workflow bookkeeping by completing mixed completed/cancelled runs or cancelling all-cancelled runs, then write `stale_run_reconciled` receipts.
  - Expose preview/execute through `runtime-monitor --reconcile-stale-runs`, JSON runtime monitor output, and the dashboard Runtime Monitor panel.

- [x] Local feedback inbox.
  - Group recent unreviewed runs across one project or all registered projects into probably accept, probably revise, and probably reject buckets.
  - Show task summary, stage completion, quality/fallback/latency signals, key findings, failures, and recommended next action before asking for feedback.
  - Expose feedback triage in CLI, dashboard, and JSON API while recording feedback through the existing local feedback artifact/memory path.
  - Done: add a bulk review screen where suggested ratings and notes can be edited, unchecked, and submitted together.

## Phase 3: Distribution And Enterprise Adoption

Goal: make Agent Workflow easy to install, operate, and govern across projects.

- [x] First-class IDE onboarding for VS Code, Cursor, and Codex.
  - Generate MCP config snippets.
  - Validate local server/provider readiness.
  - Explain model-provider ownership clearly.
  - Done: add metadata-only MCP lifecycle logging for stdio transport start, connect, close, and exit events so client pipe failures can be distinguished from Agent Workflow service outages.
  - Done: add a packaged MCP launcher that resolves the local repo, prefers the compiled MCP server when available, writes metadata-only launcher events, and avoids logging secrets.
  - Done: add runtime-monitor MCP pipeline readiness with plugin, launcher, repo, built-server, recent lifecycle events, dashboard status, and `npm run runtime-monitor -- --check-mcp` smoke verification.
  - Recorded: recurring Codex-side `Transport closed` failures can still happen at approval calls after the launcher smoke check passes, because Codex owns the private stdio subprocess and can retain a stale pipe while Agent Workflow services remain healthy.
  - Done: add Codex/IDE reload guidance to runtime-monitor CLI output, dashboard Runtime Monitor, MCP docs, and client docs when launcher smoke passes but the client still reports `Transport closed`.
  - Done: add dedicated MCP approval-call diagnostics that correlate `agentflow_approvals` invocations with launcher lifecycle events, stderr/output byte counts, exit status, timeout state, client reload guidance, and CLI fallback receipts without logging secrets or prompt/artifact bodies.
  - Done: compact MCP tool responses by default and include CLI fallback guidance when output is truncated, reducing stdio payload pressure during large approval or review responses.
  - Done: add a runtime-monitor MCP recovery package that writes metadata-only JSON, a human runbook, and a safe local helper script under `.agent-workflow/runtime/mcp/recovery/`, plus dashboard and CLI actions to regenerate it after transport failures.
  - Done: add metadata-only MCP command span logging for launched CLI operations, including operation name, command hash, child PID, timeout, exit state, and output byte counts without logging prompt text, command text, secrets, or output bodies.

- [x] Package/install story beyond cloning the repo.
  - Provide a cleaner local install path for users who want the CLI and MCP server.
  - Keep repo-based development workflow available.
  - Done: keep macOS LaunchAgent plists free of `.env` secrets; the supervisor reads local config at runtime instead of embedding provider, database, Redis, or object-storage credentials into launchd metadata.
  - Done: verify release readiness after recent dashboard and model-improvement improvements with the read-only release checker and dry-run release prep.
  - Done: run the real signed patch release prep for the next package version.
  - Done: publish `0.2.4` through GitHub Actions Trusted Publishing.
  - Follow-up: distributed worker-pool controls are now tracked under governed server mode and ecosystem fit.

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
  - Done: return approval-required notices with approval ids and CLI/MCP/dashboard next steps in workflow, worker, dashboard, and run summary contexts.
  - Done: expose approve, reject, execute, and function-style always-approve decisions through the MCP approval tool so clients can ask in the current chat and then act.
  - Done: add CLI, MCP, API, and dashboard management for listing and removing project-local always-approved rules.
  - Done: add approval autopilot for local developer setups that approve and execute policy-allowed low/medium executable side effects while keeping high-risk, destructive, provider, server, network, deployment, and autonomy actions human-gated.
  - Done: let the learning daemon run approval autopilot on each `apply-approved` tick when enabled, with dashboard-visible on/off, risk threshold, executed, and skipped counters.
  - Done: add approval backlog radar in CLI, MCP, JSON API, dashboard, and daemon heartbeat to surface pending, approved-but-not-executed, failed, stale, and autopilot-blocked items.
  - Done: add approval backlog triage categories and dashboard next-action guidance so watched-and-attempted failures are grouped by missing tool, command failure, ready-to-execute work, stale review, manual decision, historical audit trail, or needs-review state.
  - Done: add dashboard bulk triage actions for retrying failed missing-tool approvals and dismissing reviewed command failures through the same policy-rechecked approval execution/dismissal receipt paths.
  - Done: separate active approval work from historical failed approval evidence in the dashboard, including retry-ready missing-tool failures when the executable is now available.
  - Done: add a reviewed/not-actionable bulk dashboard action for old failed approval rows so noisy historical failures can be dismissed without deleting audit receipts.

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

- [x] Pattern-aware workflow execution.
  - Done: add [Agent Design Pattern Gap Analysis](agent-design-patterns-gap.md) to document how Agent Workflow maps to single-shot, ReAct, planner-executor, reflexive, verifier-gated, and combined production architectures.
  - Done: add optional stage metadata for single-shot, planner, executor, ReAct, reflexive, verifier, and finalizer behavior.
  - Done: annotate built-in reusable workflows with provider-neutral pattern metadata.
  - Done: expose stage pattern and promotion-gate metadata in CLI graph reports, Mermaid output, dashboard stage matrix, network hover text, and graph handoff exports.
  - Done: add bounded ReAct loop receipts that record observation, action request, policy decision, result receipt, iteration budget, and stop reason for ReAct-stage local commands and file writes.
  - Done: add dashboard explanations for stage pattern, promotion gate, verifier expectation, ReAct iteration budget, and approval path in graph and mind-map views.
  - Done: add run-detail dashboard explanations for why a workflow shape, model tier, provider, or fallback path was selected, using existing route receipts and run evidence.
  - Keep pattern metadata provider-neutral and safe for reusable open-source workflow bundles.

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
  - Done: add an all-stored-runs graph scope that includes matching workflow history across registered projects.
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
  - Done: add project-local graph presets so developers can save, reopen, and delete useful graph/filter/run-scope combinations.
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
  - Treat shared storage as the state plane for server mode: a trusted LAN/Tailscale host such as shared host can run Postgres, Redis, and MinIO while client machines keep using CLI, MCP, and IDE integrations.
  - Keep the Agent Workflow control plane separate from backing services: clients talk to MCP/CLI or authenticated Agent Workflow HTTP endpoints, not directly to Postgres, Redis, MinIO, or project files.
  - Define auth, project registration, role enforcement, audit receipts, and network binding defaults before exposing workflow execution remotely.
  - Document LAN/shared deployment risks and provide secure defaults that do not expose dev Postgres, Redis, MinIO, or project files accidentally.
  - Done: document the governed server-mode contract with secure local-first defaults, opt-in controls, auth requirements, project registration, endpoint classes, role checks, and audit receipt requirements.
  - Done: add a read-only server-mode readiness command, JSON API, and dashboard page before any remote execution endpoints.
  - Done: add registered-project previews for future server-mode clients that use project ids and hide local roots by default.
  - Done: add project id resolution for future server-mode routing that rejects path-shaped input and resolves only registered project ids.
  - Done: publish bounded, host-safe roadmap snapshots from each registered checkout during onboarding and indexing; retain the latest validated snapshot in shared state and expose authenticated project-id reads with explicit current, stale, missing, and invalid states.
  - Done: make canonical roadmap snapshots preserve multiline checklist titles, expose accurate captured/returned/truncation metadata and bounded pagination, and publish complete section aggregates for roadmaps larger than the returned item window.
  - Done: add an authenticated request-envelope preview for future remote execution requests before implementing mutation endpoints.
  - Done: add a guarded project-id routing adapter behind the same preview checks, still dry-run-by-default.
  - Done: add an authenticated queueing endpoint with dry-run as the default and real queueing gated by explicit server-mode environment flags.
  - Done: record remote actor, role, auth method, project id, workflow id, and idempotency details in queue receipts.
  - Done: document reverse-proxy/TLS guidance without bundling public-network deployment defaults.
  - Done: document MCP stdio as the recommended IDE path for Codex, VS Code, Cursor, and local clients.
  - Done: add shared-storage host detection and a dry-run migration operator package for LAN/Tailscale state-plane services.
  - Done: add target count/fingerprint verification for shared-storage migration proof.
  - Done: add dashboard visibility for shared-storage verification reports on the Server Readiness page.
  - Done: add dashboard visibility for generated shared-storage migration plan artifacts on the Server Readiness page.
  - Done: add a read-only row-level merge manifest that maps projects by `root_uri`, preserves target project ids, and classifies source-only, existing, conflicting, and project-id-rewrite rows before any shared-storage merge.
  - Done: add an insert-only merge importer that dry-runs by default and executes only from a reviewed row-level manifest with explicit `--execute`.
  - Done: add post-merge evidence on Server Readiness with latest merge manifest, backup folder, persisted import result when available, remaining source-only rows, and shared-primary readiness.
  - Done: add offline fallback health on Server Readiness and CLI guidance for shared-online, local-fallback-ready, local-fallback-stopped, and offline-blocked postures.
  - Done: add a local offline sync queue with CLI/dashboard actions to record fallback start, offline runs, sync-back intent, and synced queue items.
  - Done: add an explicit offline sync reconciler command/dashboard action that detects localhost and shared storage health, writes merge/import evidence, and marks queued fallback items synced after an insert-only execution.
  - Done: add daemon-triggered dry-run scheduling for the offline sync reconciler, with persisted scheduler status and dashboard readiness visibility.
  - Done: add opt-in daemon execute mode for insert-only offline sync reconciliation, with scheduler mode visibility in CLI receipts and the Server Readiness dashboard.
  - Done: add object-backed artifact proof for recent artifact rows, with optional `mc` verification and dashboard visibility on Server Readiness.
  - Done: add dashboard project path mapping so shared storage can keep a registered project under one host path while the current machine uses a mounted/local checkout path, with `AGENTFLOW_PROJECT_PATH_MAP` support and automatic Linux-home to macOS-home detection.
  - Done: add project identity grouping and a dry-run project alias merge plan so operators can preview canonical targets, source aliases, impacted rows, warnings, and rollback guidance before consolidating duplicate host-path project rows.
  - Done: add full source/target bucket enumeration with missing-key counts, sample deltas, and a dry-run object mirror plan.
  - Done: allow object artifact proof and bucket enumeration to fall back to Docker `minio/mc` when local MinIO Client is not installed, with verifier mode shown in CLI and dashboard output.
  - Done: have `bootstrap-storage` ensure the configured object-storage bucket exists through the same native-or-Docker MinIO verifier path.
  - Done: add a Shared State Plane proof roll-up on Server Readiness and `/api/server-readiness` that combines shared host/shared reachability, shared endpoint detection, post-merge evidence, storage parity, object proof, offline sync queue health, local fallback posture, and server controls.
  - Done: add explicit approved object mirror execution for MinIO artifacts, dry-run-first, with approval, role, idempotency, and receipt controls before any real object copy.
  - Done: add a server mutation-control matrix in CLI, JSON API, and Server Readiness that distinguishes remote mutation endpoints from local dashboard operator actions and audits auth, role, idempotency, gates, and receipts.
  - Done: add dedicated MCP approval-call diagnostics that correlate `agentflow_approvals` invocations with launcher lifecycle events, stderr/output byte counts, exit status, timeout state, client reload guidance, and CLI fallback receipts without logging secrets or prompt/artifact bodies.
  - Done: detect missing or changed legacy agent/workflow definitions referenced by historical runs/tasks in the storage merge manifest, preserving current target definitions and surfacing readability warnings instead of overwriting shared bundle definitions blindly.
  - Done: add cross-machine project-root aliasing for local config reads, approved command cwd, approved file writes, stale-input checks, and dashboard readiness when shared storage contains host-specific project roots.
  - Done: classify approval-only lifecycle drift as a non-blocking warning when matching durable run, task, receipt, artifact, and memory evidence is already preserved.
  - Done: allow shared-primary proof to pass with visible non-blocking warnings for refreshable index/cache rows and approval lifecycle drift.
  - Done: add a concise Server Readiness operator note showing shared host/shared storage as the primary state plane, localhost storage as fallback-only, pending offline queue items, and non-blocking warning evidence.
  - Done: finish the offline fallback background sync loop with opt-in daemon execution for insert-only reconciliation when shared host and localhost fallback storage are both reachable.
  - Done: add a dedicated Auth Hardening roll-up to Server Readiness and `/api/server-readiness`, summarizing server exposure, auth, origins, project-id routing, role enforcement, and remote mutation gates.
  - Done: add configurable request-size and per-actor/IP rate-limit controls to `/api/server-queue`, mutation-control reporting, Auth Hardening, docs, and `.env.example`.
  - Done: add audit-friendly remote request logs with redacted request envelopes, rate-limit decisions, auth outcomes, CLI/API inspection, Server Readiness visibility, docs, and `.env.example`.
  - Done: add preview-only authenticated remote approval/action envelopes with registered project ids, approval ownership checks, role gates, idempotency posture, policy rechecks, separation-of-duties checks, redacted request auditing, CLI/API access, and mutation-control matrix visibility before exposing any local approval POST route remotely.
  - Done: promote the approval/action envelope into a mutation-disabled remote endpoint contract with `server-approval-action`, `POST /api/server-approval-action`, auth checks, role and separation-of-duties checks, policy recheck, client idempotency requirement, request limit, rate limit, redacted audit event, docs, `.env.example`, and mutation-control matrix visibility.
  - Done: add the per-action receipt, duplicate-idempotency replay, rollback-evidence, CLI/API, dashboard, and docs implementation plan needed before `AGENTFLOW_SERVER_ENABLE_APPROVAL_ACTIONS=1` can safely mutate approval state.
  - Done: implement the remote approval/action mutation contract against a local test adapter first, proving decision receipts, execution receipts, duplicate idempotency reuse, and rollback evidence without live side effects.
  - Done: implement storage-backed remote approval/action mutation behind the disabled-by-default server gate, reusing local approval executors and refusing live side effects unless durable receipts, idempotency replay, policy recheck, and rollback evidence all pass.
  - Done: add a shared Redis-backed reservation/lease for approval-action idempotency so multiple server processes serialize the same new request before any local executor starts; use atomic `SET NX PX`, owner-checked release, bounded lease TTL, hashed keys, and fail-closed behavior when coordination is unavailable or contended.
  - Done: expand the learning daemon from one durable target to governed multi-project scheduling with project-local enable/disable, pause, mode, and run-limit policy; skip unavailable or paused targets; retain project heartbeats; and write JSON/Markdown fleet scheduling receipts on every tick.
  - Done: define the authenticated Jarvis/Fleet Management integration contract for inspecting daemon fleet health, submitting governed work, surfacing high-risk approvals, preserving registered project identity, and keeping Fleet Control as a separately signed execution boundary; expose it through CLI and JSON API reports.
  - Done: add an authenticated read-only Jarvis bridge canary for bounded daemon fleet health. Agent Workflow publishes canonical project-id/name scheduling, mode, limit, heartbeat freshness, status, and bounded errors without roots; Fleet Management reuses its existing bearer-authenticated Heimdall bridge at `/daemon/fleet-health` and strips any unexpected root fields.
  - Done: canary a low-risk Jarvis work submission through Fleet Management's existing `/workflow` bridge and Agent Workflow server queue with execution disabled. The bridge now accepts an explicit preview flag while preserving its deployed default, resolves `fleet-config` by registered project ID, permits only its configured `review-pr` workflow, returns a bounded route-ready response, creates no run, and records repeat requests under the same redacted idempotency-key hash.
  - Done: execute one explicitly authorized low-risk `fleet-config` `review-pr` canary through the governed server queue. Two authenticated submissions with idempotency hash `1d11d3e44d894de6` resolved to the single run `e04b8c49-042a-4262-a451-33c9507fbabb`; the first wrote durable queue receipt `db://workflow_runs/e04b8c49-042a-4262-a451-33c9507fbabb/server_queue_request/server-queue-1d11d3e44d894de6bb9f2111`, the second was recorded as a reuse, the standing daemon completed all three read-only stages, and the existing bounded status command exposed the completed run without filesystem paths.
  - Done: add authenticated `GET /api/server-high-risk-approvals` for bounded, open, high-risk approval cards; classify with the existing approval-autopilot policy, redact host paths and secret-shaped values, include local approval-dashboard paths, and expose no decision or execution operation. Fleet Management now proxies the contract at `/approvals/high-risk`; Jarvis voice has a read-only tool and Control Center Activity renders the cards in red. An isolated canary proved unauthenticated `401`, authenticated `200`, no root leakage, and a correctly empty current inbox.
  - Done: deploy and validate the cumulative roadmap-pagination plus read-only approval-card release on Heimdall; confirm Fleet bridge, Jarvis voice, and Control Center rendering with a clearly labeled synthetic high-risk approval; reject the canary without execution; preserve the pagination release as rollback; and keep remote approval mutation and execution disabled.
  - Done: promote the accumulated Agent Workflow feature batch with multi-project daemon governance, learning-to-roadmap controls, whole-computer Spotlight discovery, MCP session diagnostics, live neuron-style graph animation, and ten focused reusable workflows.
  - Done: enforce explicit all-project daemon mode and run-limit caps so project settings can only make a run more restrictive; validate an observe-only 13-project canary with zero autonomous applications.
  - Done: add a bounded read-only `/api/workflow-graph-events` SSE feed with stable snapshot ids, heartbeats, browser reconnect/backoff, and polling fallback; validate three distinct snapshots from a deterministic no-write workflow run.
  - Next: add resumable event cursors and targeted stage deltas so reconnecting graph clients can avoid full snapshot replay while preserving bounded polling compatibility.

- [x] High priority: shared storage migration utility.
  - This is now the state-plane implementation path for governed server mode, not a detached storage feature.
  - Done: derive shared storage endpoints from configured URLs or explicit host overrides.
  - Done: add a dry-run-first `storage-migrate` command for moving existing local enterprise storage into a shared LAN/Tailscale storage host such as shared host.
  - Done: write reviewed operator packages with Markdown, JSON, and a guarded shell script that requires explicit execution opt-in.
  - Done: add target count and compact fingerprint verification for projects, workflow runs, tasks, approvals, receipts, artifacts, memory, indexed files, index state, and registry definitions.
  - Done: block copy-empty-target plans when the destination already contains Agent Workflow rows, and direct users to merge preview instead.
  - Done: add a merge-preview preflight summary with sampled project-root overlap, durable row counts, table diffs, and non-executing operator scripts.
  - Done: add a row-level merge manifest command for existing shared targets that maps projects through `root_uri`, preserves existing destination project ids, and identifies rows that need safe project-id rewriting.
  - Done: support executable insert-only merge mode by executing only a reviewed merge manifest, preserving existing destination rows, and rewriting dependent project ids safely.
  - Done: add post-merge evidence and offline fallback diagnostics plus a local sync queue so operators know when local resources can stay stopped and what fallback work needs to be merged back.
  - Done: back up both source and destination Postgres databases before any write, with clear rollback instructions, blocking execution when `pg_dump` cannot create both dumps.
  - Done: detect missing legacy agent/workflow definitions referenced by historical runs and preserve readability without overriding current bundle definitions blindly.
  - Done: mirror object-storage artifacts from local MinIO to destination MinIO through an explicit `object_mirror` approval that uses `mc mirror --overwrite=false`, stores no credentials in approval payloads, and records execution receipts.
  - Done: add a post-merge switch-over proof checklist that samples historical durable tables from the latest manifest, surfaces remaining conflicts/project-id rewrites, checks backup/import evidence, and calls out missing object bucket parity before recommending shared storage as primary.
  - Done: allow `object-artifact-proof --write` to persist Markdown/JSON object parity evidence into the migration evidence directory for switch-over checks.
  - Done: allow object proof verification and bucket enumeration to use Docker `minio/mc` fallback when the local `mc` binary is missing.
  - Done: ensure the configured object-storage bucket during `bootstrap-storage` so an empty but valid shared state plane is ready for future artifacts.
  - Done: include deterministic representative row samples for projects, historical runs, artifacts, approvals, receipts, memory, indexed files, and index state in new merge manifests and the Server Readiness switch-over proof.
  - Done: classify remaining switch-over conflicts as canonical project blockers, durable history blockers, or refreshable index/cache rows in CLI and Server Readiness evidence.
  - Done: add a read-only `storage-project-conflicts` resolver preview that compares source/target project metadata, linked row counts, config hashes, and decision-record templates.
  - Done: add an operator decision recorder for canonical project choices so shared-primary proof can reference reviewed conflict decisions without overwriting target rows.
  - Done: add a dashboard action for reviewing and recording project-conflict decisions from Server Readiness.
  - Done: add cross-machine project-root aliasing so approvals created on shared host/Linux paths can resolve to this Mac's local project checkout for policy/autopilot checks and local execution cwd, while preserving stored `root_uri` audit history.
  - Done: classify approval-only lifecycle drift as a non-blocking warning when durable outcome rows are preserved, and keep refreshable project index/cache conflicts visible without blocking shared-primary proof.
  - Done: regenerate shared-storage project indexes for the projects shown in warning samples.
  - Done: publish the shared-primary/fallback operator note on Server Readiness and in the server-mode/user guide docs.
  - Done: finish the offline fallback background sync loop and dashboard reconciliation state, with opt-in daemon execution mode for insert-only sync.
  - Follow-up: authenticated server-mode hardening continues under governed server mode after local/shared storage fallback proof.
  - Keep destructive or overwrite behavior unavailable unless a future explicit capability flag and backup confirmation are added.

- [x] Team roles and separation of duties.
  - Distinguish operators, approvers, workflow authors, and auditors.
  - Done: add project-local role definitions and record actor roles on approval decisions and execution receipts.
  - Done: add read-only role enforcement previews before blocking actions by role.
  - Done: add opt-in role enforcement gates for approval and execution actions.
  - Done: add dashboard and CLI role visibility with recent approval decisions grouped by recorded actor role.
  - Done: add optional separation-of-duties checks for projects that want to flag or block the same actor approving and executing the same action.
  - Done: add role-focused CLI, JSON API, and dashboard filters for project, role, status, and action type.
  - Done: add exportable local Markdown and JSON role audit snapshots from the filtered CLI report.
  - Done: add dashboard-triggered role audit snapshot exports that preserve the active role filters.
  - Done: add a recent role audit snapshot panel and dashboard-safe Markdown viewer for local audit exports.
  - Done: add role-audit smoke coverage for JSON reports and exported Markdown/JSON snapshots, then close the milestone with the current ergonomics accepted.

- [x] Artifact lifecycle governance.
  - [x] Add read-only artifact inventory across registered projects with counts, size estimates, age buckets, artifact kinds, and run associations.
  - [x] Add dashboard, JSON API, and CLI visibility for conservative lifecycle hints without pruning or deleting artifacts.
  - [x] Add dashboard and CLI visibility for artifacts that are safe to prune, should be retained for audit, or need human review.
  - [x] Generate dry-run prune plans with exact artifact ids, URIs, reasons, and estimated storage recovered.
  - [x] Keep legal-hold and retention settings project-local in `.agent-workflow/project.yaml`; default to no automatic deletion.
  - [x] Add project-local retention policy settings and lifecycle receipt previews before any destructive prune execution.
  - [x] Add approved lifecycle action queue plumbing that records approval receipts and still defaults to no deletion.
  - [x] Add no-op lifecycle execution receipts for approved prune actions without deleting or modifying artifacts.
  - [x] Add guarded archive/restore previews and no-op receipts before any prune/delete path.
  - [x] Record lifecycle execution receipts for skipped items before allowing destructive actions.
  - [x] Add policy recheck summaries to lifecycle no-op and skipped receipts.
  - [x] Add explicit destructive-action capability flags and policy recheck gates before any write/delete operation against local files or object storage.
  - [x] Add real archive execution behind disabled-by-default capability flags and approval rechecks.
  - [x] Add real restore execution behind disabled-by-default capability flags and approval rechecks.
  - [x] Require explicit approval and policy recheck for any prune/delete operation against local files or object storage.
  - Follow-up: backup, restore, and disaster-recovery validation now owns recovery proof.

- [x] Dashboard UX pass.
  - [x] Run `ux-reviewer` against the dashboard for developer usability, queue clarity, lifecycle pages, workflow graph readability, and provider/settings discoverability.
  - [x] Run `frontend-engineer` design pass against the dashboard visual system.
  - [x] Improve workflow graph labels, color semantics, and readability controls.
  - [x] Make queue status and worker health more prominent on the main dashboard.
  - [x] Improve provider/settings discoverability with stronger hierarchy and confirmation feedback.
  - [x] Group dashboard navigation into clearer operating areas.
  - [x] Add an Agents dashboard page that shows shared reusable agents, project-local agents, and the effective selected-project roster.
  - [x] Rerun `ux-reviewer` after dashboard hierarchy changes.
  - [x] Tighten grouped navigation consistency and make operations snapshot metrics more actionable.
  - [x] Run a final dashboard UX review after the grouped navigation and operations snapshot updates.
  - [x] Add clearer hover, focus, tooltip, and accessibility affordances to operations snapshot actions.
  - [x] Run a short visual QA pass on the dashboard home, providers, queue, and workflow graph pages after the latest interaction polish.
  - [x] Add a lightweight built-in dashboard icon set for grouped navigation, metric cards, status feedback, run dialogs, and common action buttons without adding runtime dependencies.
  - [x] Add shared dashboard action helpers so POST-heavy pages can preserve context with `returnTo`, flash feedback, and browser-local recent action history.
  - Follow-up: governed server mode owns the next shared-runtime milestone.

- [x] Backup, restore, and disaster-recovery validation.
  - [x] Add a read-only backup inventory and restore-drill readiness report for local enterprise storage.
  - [x] Add dashboard visibility for backup inventory and restore-drill status.
  - [x] Provide documented recovery procedures and automated restore verification.
  - Follow-up: governed server mode owns registered-project routing and shared-runtime readiness.

## Roadmap Task And Bug Register

This register records cross-cutting tasks and recurring defects that should stay
visible even when the detailed roadmap sections move around. The dashboard reads
this file directly, so roadmap updates automatically flow into `/roadmap` and
`/api/roadmap`.

- [x] Task: create a live roadmap dashboard with list and Gantt-style views.
  - Milestone: 3 Developer Dashboard
  - Priority: medium
  - Status: implemented as a read-only dashboard generated from `docs/roadmap.md`.
  - Scope: expose all checklist tasks, next actions, bugs, milestone links, and source line references without creating a second roadmap database.

- [ ] Bug: recurring Codex MCP transport closes during planning or approval calls.
  - Milestone: 12 Ecosystem Fit
  - Priority: high
  - Severity: high
  - Status: open
  - Permanent fix direction: add supervised and reconnectable MCP lifecycle diagnostics, keep stdio payloads compact, record exact launcher exit and stderr evidence, surface recovery actions in Runtime Monitor and Roadmap dashboards, and preserve CLI fallback receipts when the client-owned stdio pipe drops.
  - Current mitigation: Agent Workflow services continue running independently, the CLI fallback can complete local work, and restarting the Codex task/app creates a fresh private MCP subprocess.
  - Recovery package: `npm run runtime-monitor -- --check-mcp --write-mcp-recovery` writes `.agent-workflow/runtime/mcp/recovery/mcp-recovery.md`, `.agent-workflow/runtime/mcp/recovery/mcp-recovery.json`, and `.agent-workflow/runtime/mcp/recovery/mcp-client-recovery.sh` for repeatable local recovery without secrets or prompt bodies.
  - Done: surface the recovery package command and Runtime Monitor links directly on the Roadmap dashboard while this bug remains open.
  - Done: log metadata-only MCP command spans so runtime diagnostics can show whether the stdio pipe closed before, during, or after a launched Agent Workflow CLI operation.
  - Done: correlate a bounded lifecycle window into per-process MCP sessions with parent PID, start/end time, exit code, command-span counts, incomplete-command counts, and clean/crashed/incomplete/active outcomes; surface the summary and session table in Runtime Monitor JSON/UI and preserve it in recovery packages.
  - Boundary: Agent Workflow can detect, diagnose, record, and guide recovery, but Codex owns the private stdio transport and may still close it outside this repository.

- [x] Task: link every future roadmap task or bug to a milestone.
  - Milestone: 3 Developer Dashboard
  - Priority: high
  - Status: implemented
  - Rule: prefer an explicit `Milestone: N` detail line for new cross-cutting register items; the dashboard falls back to keyword inference for older roadmap checklist items.
  - Done: add roadmap milestone integrity counts, explicit/inferred/missing link status, an unlinked filter, and `roadmap-audit` CLI validation so new work stays connected to the milestone map.

- [x] Task: surface next best prioritized roadmap work on the dashboard home.
  - Milestone: 3 Developer Dashboard
  - Priority: medium
  - Status: implemented
  - Scope: show the top open roadmap tasks and bugs, critical/high counts, and quick links into list or Gantt roadmap views.

- [x] Task: add roadmap status editing from the dashboard.
  - Milestone: 3 Developer Dashboard
  - Priority: medium
  - Status: implemented
  - Scope: allow checklist-backed roadmap tasks and bugs to be marked done or reopened from `/roadmap` while keeping generated `Next:` rows read-only.

- [x] Task: add roadmap priority editing from the dashboard.
  - Milestone: 3 Developer Dashboard
  - Priority: medium
  - Status: implemented
  - Scope: allow checklist-backed roadmap tasks and bugs to set explicit `Priority:` values from `/roadmap` while preserving inferred priorities for older items.

## Contribution Boundary

Before adding a roadmap item, classify it:

- Shared platform IP: orchestration, context, routing, safety, observability, evaluation, MCP/IDE integration.
- Private product IP: domain prompts, product scoring, customer data, schemas, authorization, production action policy.

Only shared platform IP belongs in this open-source roadmap. Product-specific learnings should be generalized before promotion.
