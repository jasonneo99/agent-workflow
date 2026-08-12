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

- [ ] Export redaction and scrubbed example tooling.
  - Remove secrets, customer data, private prompts, private schemas, tenant context, and proprietary scoring from exported reports.
  - Produce safe synthetic examples for docs.

- [ ] Versioned agent/workflow bundle manifests.
  - Track bundle version, source, checksum, compatibility, and migration notes.
  - Support safer sharing across teams and IDE clients.

- [ ] Production, staging, and local policy profiles.
  - Provide reusable command/write/autonomy presets.
  - Preserve dry-run and explicit-write defaults for risky operations.

## Phase 2: Evaluation And Personalization

Goal: improve quality and cost while keeping personalization auditable and portable.

- [ ] Evaluation harness for comparing providers, tiers, and prompts.
  - Compare quality, fallback, latency, estimated cost, and feedback outcomes.
  - Support synthetic benchmark projects and project-local private evals.

- [ ] Dashboard run comparison view.
  - Compare runs by workflow, stage, agent, provider, tier, quality, fallback, and feedback.
  - Highlight regressions and improvement candidates.

- [ ] Tuning proposal approval history.
  - Track which proposals were accepted, rejected, applied, reverted, or superseded.
  - Feed future scorecards without auto-promoting risky behavior.

- [ ] Shared evaluation patterns, private product scoring.
  - Keep generic quality and routing mechanics public.
  - Keep product-specific ranking, customer-derived feedback, and domain heuristics private.

## Phase 3: Distribution And Enterprise Adoption

Goal: make Agent Workflow easy to install, operate, and govern across projects.

- [ ] First-class IDE onboarding for VS Code, Cursor, and Codex.
  - Generate MCP config snippets.
  - Validate local server/provider readiness.
  - Explain model-provider ownership clearly.

- [ ] Package/install story beyond cloning the repo.
  - Provide a cleaner local install path for users who want the CLI and MCP server.
  - Keep repo-based development workflow available.

- [ ] Multi-project governance.
  - Inspect registered projects, storage health, provider settings, and policy drift.
  - Support enterprise teams that operate many repositories.

- [ ] Signed or trusted workflow bundles.
  - Prepare for sharing agent/workflow packs without silently accepting untrusted behavior.

## Contribution Boundary

Before adding a roadmap item, classify it:

- Shared platform IP: orchestration, context, routing, safety, observability, evaluation, MCP/IDE integration.
- Private product IP: domain prompts, product scoring, customer data, schemas, authorization, production action policy.

Only shared platform IP belongs in this open-source roadmap. Product-specific learnings should be generalized before promotion.
