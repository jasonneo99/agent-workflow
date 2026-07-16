# Tellara Agent Workflow Context

Tellara is an AI-native story operations platform for media teams. It is tenant- and property-scoped, with AI Staff, story creation, package publishing/syndication, public rendering, personalization, customer-managed AI provider credentials, plugin/SDK/MCP foundations, and local development tooling.

## Operating Principles

- Treat tenant, property, role, invite-only auth, provider credential, audit, publishing, plugin, MCP, and support-access boundaries as fail-closed product boundaries.
- Prefer the current checkout, docs, checklists, tests, and live repo state over memory.
- Do not add local-only roadmap, diagnostic, or dashboard surfaces to the production-oriented app.
- Preserve unrelated dirty work. Use narrow staging or isolated worktrees for risky branch, merge, deployment, or broad implementation work.
- Lead Tellara positioning with AI-native story operations when product framing is relevant.

## Canonical Project Sources

- `AGENTS.md`: project operating rules and named local specialist guidance.
- `docs/checklists/038-prioritized-feature-completion-backlog.md`: roadmap progress source of truth.
- `docs/checklists/README.md`: checklist index.
- `docs/architecture-principles.md`: architectural guardrails.
- `docs/database.md` and `docs/migration-projection-discipline.md`: database and migration direction.
- `docs/local-development.md`: local development guide.
- `docs/dev-infrastructure-runbook.md` and `docs/dev-eks-cost-control-runbook.md`: Dev/AWS operations.

## Local Specialists

- Nash: Architecture Steward for major implementation planning, post-change drift checks, and pre-merge/PR review.
- Vega: Product Visionary for roadmap, positioning, customer problem, and product tradeoffs.
- Mira: UX Design Agent for product surfaces, workflows, accessibility, trust, and assistant interfaces.
- Sloane: Security Specialist for auth, tenant/property isolation, audit, secrets, provider, plugin, MCP, publishing, and infra risk.

Use these roles as advisory checks inside workflow outputs. They do not replace implementation ownership, tests, auth checks, or verification.

## Verification Bias

Default to focused verification first, then broaden when risk increases. `pnpm verify` is the default pre-push gate, but it is intentionally heavy.
