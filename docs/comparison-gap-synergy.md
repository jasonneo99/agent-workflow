# Comparison, Gap, And Synergy: Agent Workflow And Product Agent Engines

This document compares Agent Workflow with a private product agent engine such as Tellara's. It is intentionally written at the architecture and operating-model level so the open source project can benefit from reusable lessons without exposing private product logic.

## Executive Recommendation

Lean into shared IP for the agent operations layer, not the product intelligence layer.

Agent Workflow should become the reusable platform for:

- Agent execution and orchestration.
- Model-provider portability.
- Context indexing and brief compilation.
- Cost and quality routing.
- Receipts, artifacts, dashboards, and MCP tools.
- Feedback memory, scorecards, and safe tuning workflows.
- Safety policy, dry-run behavior, and approval gates.

Private product engines should keep ownership of:

- Domain-specific agent behavior.
- Product goals and ranking logic.
- Private schemas and authorization rules.
- Customer-specific workflows.
- Proprietary prompts, heuristics, scoring, and feedback.
- Production automation decisions that depend on private business context.

The strongest path is a layered model:

```text
Open/shared:  agent operating system, workflow runtime, provider abstraction, observability
Private:      product brain, domain policies, customer data, competitive heuristics
```

## Comparison

| Area | Agent Workflow | Private Product Agent Engine | Boundary |
| --- | --- | --- | --- |
| Purpose | Portable development-agent workflows for any project | Domain-specific automation and intelligence inside a product | Share the runtime, keep domain intelligence private |
| Users | Developers, maintainers, MCP clients, IDEs, CI-like automation | Product users, internal operators, customer-specific workflows | Public project optimizes developer operations |
| Context | `AGENTS.md`, `.agent-workflow/`, indexed source summaries, artifacts | Product data, tenant context, app state, customer behavior, domain entities | Keep private context in the product repo or service |
| Agents | Generic specialists such as architecture, frontend, UX, security, testing, docs | Product-specialized agents with domain goals and business rules | Generic agent contracts can be shared; private roles stay private |
| Workflows | Build, review, debug, production readiness, context maintenance, provider smoke tests | Product-specific workflows and automation paths | Share workflow mechanics, not private workflow intent |
| Memory | Feedback, scorecards, tuning proposals, route decisions, source summaries | Customer-derived memory, product outcomes, domain learning | Share memory patterns, not private memory content |
| Routing | Provider/tier selection by cost, quality, fallback, latency, and feedback | Product-aware model choice based on user value, risk, data sensitivity, and domain complexity | Share routing framework, keep business weighting private |
| Safety | Command allowlists, write path policies, dry-run defaults, receipts, explicit write flags | Product authorization, tenant boundaries, compliance, operational risk rules | Share safe-action primitives, keep product policy private |
| Observability | Run history, artifacts, exports, dashboard, MCP tools | Product analytics, customer success signals, internal operations telemetry | Share generic observability contracts, keep business telemetry private |
| Competitive Value | Lower cost, reusable developer workflows, model portability, operational discipline | Product experience, domain outcomes, proprietary automation quality | Open source should increase distribution without leaking moat |

## Gap Analysis

### Gaps In Agent Workflow

Agent Workflow is strong as a reusable agent runtime, but it still needs maturity in these areas:

- Approval queue for converting tuning overlays into reviewable patches.
- Stronger policy profiles for production, staging, and local-only automation.
- Better multi-project governance for enterprise teams.
- Richer evaluation harnesses for comparing model/provider results over time.
- More explicit redaction and export-scrubbing utilities.
- Signed or versioned agent/workflow bundles.
- Better dashboard controls for approving, replaying, and comparing runs.
- First-class package/install story for IDE users who do not want to clone the repo manually.

### Gaps In A Private Product Agent Engine

A private product engine can move faster in domain logic, but it should avoid rebuilding generic infrastructure:

- Durable workflow execution.
- Provider abstraction.
- Context summarization and token-budget controls.
- Generic developer-agent orchestration.
- Receipts and artifact storage.
- Feedback scorecards.
- Safe command and write policies.
- MCP and IDE integration.
- Cost/quality routing dashboards.

If a private product engine rebuilds these from scratch, it risks splitting focus between product intelligence and platform plumbing.

## Synergy Map

### High-Synergy, Safe To Share

These areas should flow into Agent Workflow because they improve the public framework without exposing product IP:

- Better provider routing abstractions.
- Safer write and command policies.
- Feedback capture and preference scorecards.
- Dry-run-first tuning workflows.
- Run summaries and decision-ready exports.
- MCP tool ergonomics.
- Dashboard workflow inspection.
- Context compaction and source relevance selection.
- Synthetic example projects that demonstrate patterns without private data.

### Medium-Synergy, Share Only After Generalizing

These ideas can be shared if scrubbed and converted into generic patterns:

- Product-readiness workflows inspired by private launch checks.
- UX-review heuristics rewritten as generic usability criteria.
- Security review checklists without private architecture assumptions.
- Routing recommendations expressed as generic cost/quality categories.
- Project profiles that use neutral names and synthetic policies.
- Failure triage patterns that do not reveal real incidents.

### Low-Synergy Or Private

These should stay out of the open source repo:

- Private product prompts.
- Domain-specific agent instructions.
- Customer-derived examples or feedback.
- Product scoring formulas.
- Authorization and tenant rules.
- Private schemas and workflows.
- Internal operational runbooks.
- Production incident details.

## Shared IP Recommendation

Yes, lean into shared IP, but make it platform IP.

The shared IP should be:

- Reusable across Tellara, Truck Outfitters Unlimited, and future projects.
- Useful without any private product context.
- Model-agnostic and IDE-agnostic.
- Safer and cheaper because improvements compound across projects.
- Documented as general operating practice, not product strategy.

Do not share product IP. Product IP should stay private when it affects:

- Why the product makes a decision.
- How the product ranks or scores outcomes.
- Which data the product considers important.
- How customers, tenants, assets, or workflows are modeled.
- What proprietary agent behavior creates competitive advantage.

## Practical Operating Model

Use a two-track development flow:

### Track 1: Shared Platform

Build in Agent Workflow when the improvement is generic:

- A new MCP tool.
- A safer policy primitive.
- A provider adapter.
- A workflow execution feature.
- A dashboard inspection tool.
- A context/token optimization.
- A generic feedback or evaluation mechanism.

### Track 2: Private Product Engine

Build in the private product when the improvement depends on domain specifics:

- Product-specific prompts.
- Customer workflow automation.
- Domain-aware scoring.
- Private data retrieval.
- Tenant-specific rules.
- Product UX decisions.
- Business-specific agent behavior.

After a private improvement proves useful, ask whether the pattern can be generalized. If yes, promote only the generic primitive to Agent Workflow.

## Decision Checklist

Before moving an idea from a private product into Agent Workflow, ask:

- Would this help a developer using an unrelated project?
- Can it be explained without private data, schemas, prompts, or business rules?
- Does it improve orchestration, safety, context, routing, cost, evaluation, or observability?
- Can examples be synthetic?
- Can the private product still keep its advantage after this is shared?
- Does it preserve the project-local boundary for `.agent-workflow/` context?

If the answer is mostly yes, it belongs in Agent Workflow. If the value depends on private domain knowledge, keep it in the product engine.

## Near-Term Shared IP Opportunities

The best next shared-platform investments are:

1. Approval queue for generated tuning overlays.
2. Redaction/scrubbing tools for exports and examples.
3. Versioned agent/workflow bundle manifests.
4. Evaluation harness for model/provider comparisons.
5. Dashboard comparison view for runs, costs, quality, and feedback.
6. Better onboarding for VS Code, Cursor, and Codex users.
7. Production/staging/local policy profiles.

These improve every future product integration while protecting the private logic that makes each product valuable.
