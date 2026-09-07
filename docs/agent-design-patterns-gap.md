# Agent Design Pattern Gap Analysis

This document maps common AI agent design patterns to Agent Workflow's current
architecture and identifies practical gaps. It is based on a reference design
sheet covering single-shot, ReAct, planner-executor, reflexive, verifier-gated,
and combined production agent architectures.

## Executive Summary

Agent Workflow is already closest to the combined production architecture:
planner, specialist executors, policy-gated tools, persistent memory, verifier
stages, receipts, dashboard observability, and feedback-driven improvement. The
next quality gains should come from making those loops more explicit and
measurable, not from adding more generic agents.

The highest-value gaps are:

- explicit pattern selection per workflow stage
- stronger verifier-gated promotion before autonomous changes expand
- redacted remote request audit logs for governed server mode
- clearer feedback and evaluation loops for local/BYO model routing
- dashboard views that explain why the orchestrator chose a pattern, model,
  agent, approval path, or fallback

## Pattern Fit

| Pattern | Current Fit | Existing Capability | Gap |
| --- | --- | --- | --- |
| Single-shot agent | Strong for simple local tasks | Direct agent tasks, deterministic mock provider, compact briefs | Need clearer routing when a user request should stay single-shot instead of becoming a workflow. |
| ReAct agent | Partial | Worker stages can request policy-checked commands and file writes, then continue from receipts | Missing a first-class observe-act loop model with bounded iterations and explicit stop reasons. |
| Planner-executor agent | Strong | `workflow-orchestrator`, `task-triager`, workflow YAML stages, specialist agents, worker queue | Need explicit stage-level pattern metadata so workflows can declare when a stage is planner, executor, verifier, or reflexive. |
| Reflexive agent | Partial to strong | Learning daemon, feedback inbox, preference scorecards, tuning proposals, agent improvement patches | Needs tighter eval-backed promotion so self-improvements can be applied only when representative holdout evidence passes. |
| Verifier-gated agent | Strong | `test-engineer`, `security-reviewer`, quality gates, approval inbox, policy engine, evaluation gates | Need verifier results shown as promotion blockers or enablers in every improvement surface. |
| Combined production architecture | Strong locally | Durable storage, queue, artifacts, receipts, policy snapshots, MCP, dashboard, worker pools | Governed server mode needs request audit logs, rate controls, and clearer operator boundaries before broader remote use. |

## Current Architecture Strengths

- **Planner-executor structure**: reusable workflow YAML already separates
  planning, implementation, verification, documentation, and packaging.
- **Specialized agents**: agent cards are role-specific and portable across
  model providers and IDE clients.
- **Verifier gates**: tests, quality reports, eval gates, approvals, and
  policy checks already prevent most unsafe automatic side effects.
- **Durable memory**: run history, artifacts, receipts, indexed summaries,
  feedback, scorecards, and learning files create reusable local state.
- **Context efficiency**: project context is indexed and compiled into compact
  briefs rather than pasted wholesale into every model request.
- **Provider neutrality**: local, BYO, OpenAI, Bedrock, Kiro, and mock providers
  sit behind common routing and reporting surfaces.
- **Local-first safety**: project files, private context, learning state, and
  approvals stay local unless a user explicitly exports or enables server mode.

## Gaps To Close

### 1. Explicit Stage Pattern Metadata

Workflow stages now include optional provider-neutral pattern metadata so
tooling can reason about expected control flow:

```yaml
pattern:
  type: planner | executor | react | reflexive | verifier | finalizer | single-shot
  max_iterations: 3
  requires_verifier: true
  promotion_gate: evaluation
```

The built-in workflows use this metadata, and the workflow graph, dashboard
stage matrix, Mermaid output, network hover text, and graph handoff exports can
show how the workflow is intended to operate.

### 2. Bounded ReAct Loops

Agent Workflow now records bounded ReAct loop receipts when a `react` stage
requests a local command or file write. Each receipt records:

- goal
- observation source
- action requested
- policy decision
- result receipt
- stop reason
- max iteration budget

This is useful for debugging, CI triage, docs refresh, and safe local repair
tasks.

### 3. Verifier-First Self-Improvement

The learning daemon can generate recommendations, patch previews, holdout
evals, and promotion queues. The next step is to make promotion evidence the
default decision layer:

- candidate patch
- representative holdout tasks
- baseline behavior
- candidate behavior
- pass/warn/fail score
- rollback hash
- promotion receipt

This keeps autonomous improvement practical without letting the system rewrite
shared behavior based only on weak signals.

### 4. Remote Request Audit Logs

Governed server mode now has auth, project-id routing, idempotency, request
size limits, and rate limits. It still needs append-only redacted request logs
for server-mode operations:

- request id
- actor and role
- auth method and outcome
- rate-limit decision
- idempotency key hash
- project id
- workflow id
- execute versus dry-run
- status and run id if queued

Logs must not store secrets, prompts, raw source, provider responses, or
artifact bodies.

### 5. Pattern-Aware Dashboard Explanation

The dashboard should tell users why a workflow used a given pattern:

- why the request became a workflow instead of a single agent task
- why a stage was verifier-gated
- why a local model was or was not used
- why an approval was required
- why the daemon did or did not promote a recommendation

This improves trust and reduces confusion around approvals, daemon autonomy,
and model routing.

## Recommended Next Implementation Order

1. Add redacted remote request logs for server-mode hardening.
2. Strengthen verifier-first promotion summaries across learning and model
   improvement pages.
3. Add pattern explanations to dashboard run details and workflow graph.

## Open Source Boundary

These improvements belong in Agent Workflow because they are generic developer
workflow infrastructure. They should remain independent of private product
agent engines, customer-specific prompts, private datasets, production ranking
logic, and domain-specific automation rules.
