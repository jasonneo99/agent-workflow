# Agent Design Pattern Architecture Status

This document maps common AI agent design patterns to Agent Workflow's current
architecture and records the status of practical gaps identified from a
reference design sheet covering single-shot, ReAct, planner-executor,
reflexive, verifier-gated, and combined production agent architectures.

Status: the five pattern-specific gaps from the original analysis are closed as
of 2026-09-24. The sections below retain the original categories while recording
their implemented outcomes. Remaining architecture work is tracked separately in
[`roadmap.md`](roadmap.md#current-execution-priority).

## Executive Summary

Agent Workflow is already closest to the combined production architecture:
planner, specialist executors, policy-gated tools, persistent memory, verifier
stages, receipts, dashboard observability, and feedback-driven improvement. The
next quality gains should come from operating and calibrating those loops with
representative evidence, not from adding more generic agents.

The original highest-value gaps are now implemented:

- workflow stages declare provider-neutral pattern metadata
- autonomous promotion requires verifier, holdout, rollback, and policy evidence
- governed server mode writes append-only redacted request audit events
- local/BYO model changes flow through feedback, evaluation, and promotion gates
- workflow graph and stage views explain selected patterns and their control flow

## Pattern Fit

| Pattern | Current Fit | Existing Capability | Outcome |
| --- | --- | --- | --- |
| Single-shot agent | Strong for simple local tasks | Direct agent tasks, deterministic mock provider, compact briefs | Routing remains explicit through triage and dynamic workflow construction; the dashboard explains the selected stage pattern. |
| ReAct agent | Strong and bounded | Worker stages request policy-checked commands and file writes, then continue from receipts | ReAct stages record bounded observe-act iterations, policy decisions, results, and explicit stop reasons. |
| Planner-executor agent | Strong | `workflow-orchestrator`, `task-triager`, workflow YAML stages, specialist agents, worker queue | Stage-level metadata declares planner, executor, verifier, reflexive, finalizer, ReAct, or single-shot behavior. |
| Reflexive agent | Strong and governed | Learning daemon, feedback inbox, preference scorecards, tuning proposals, agent improvement patches | Representative holdout evidence, rollback hashes, and evaluation gates control promotion. |
| Verifier-gated agent | Strong | `test-engineer`, `security-reviewer`, quality gates, approval inbox, policy engine, evaluation gates | Promotion surfaces expose verifier evidence as a blocker or enabler rather than an advisory result. |
| Combined production architecture | Strong locally and governed remotely | Durable storage, queue, artifacts, receipts, policy snapshots, MCP, dashboard, worker pools | Server mode enforces auth, project routing, request limits, rate controls, idempotency, redacted audit events, and operator boundaries. |

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

## Closure Evidence

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

The learning daemon generates recommendations, patch previews, holdout evals,
and promotion queues. Promotion evidence is the default decision layer and
records:

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

Governed server mode has auth, project-id routing, idempotency, request size
limits, rate limits, and append-only redacted request audit events for
server-mode operations:

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

The workflow graph and stage detail surfaces tell users why a workflow used a
given pattern, including:

- why the request became a workflow instead of a single agent task
- why a stage was verifier-gated
- why a local model was or was not used
- why an approval was required
- why the daemon did or did not promote a recommendation

This improves trust and reduces confusion around approvals, daemon autonomy,
and model routing.

## Remaining Architecture Work

The pattern gaps above are closed. The remaining architecture work is
operational proof and maintainability work rather than missing pattern support:

1. Accumulate sustained guarded-autonomy baselines, fault drills, and a reviewed
   promotion canary before expanding authority.
2. Complete a maintenance-window two-host promotion and rollback drill to prove
   recovery without split-brain writes or lost receipts.
3. Continue extracting the five oversized production modules without weakening
   the source-size ratchet or their focused contracts.
4. Resume Codex MCP transport diagnosis only when a fresh client-owned stdio
   lifecycle failure provides reproducible evidence.

The authoritative order and exit gates live in
[`roadmap.md`](roadmap.md#current-execution-priority).

## Open Source Boundary

These improvements belong in Agent Workflow because they are generic developer
workflow infrastructure. They should remain independent of private product
agent engines, customer-specific prompts, private datasets, production ranking
logic, and domain-specific automation rules.
