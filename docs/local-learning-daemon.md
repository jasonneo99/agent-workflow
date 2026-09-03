# Local Learning Daemon

The local learning daemon is a proposed Agent Workflow background process that
continually improves developer workflows from local evidence while keeping
project data private and human control intact.

Its default stance is maximum safe autonomy: observe, summarize, score, compare,
prepare improvements, and mutate local learning state that Agent Workflow
created and owns. Owned local learning state means Agent Workflow-created files
under `.agent-workflow/learning/` and future Agent Workflow-created
`learning_*` database rows. It must stop for approval when a change could modify
project behavior, write reusable bundle definitions, execute commands, change
provider settings, or expose private data.

## Goals

- Improve developer workflow quality, cost, latency, and reliability over time.
- Learn from approved user feedback, run history, repeated failures, evaluation
  evidence, routing outcomes, and optional user-approved research notes.
- Keep project-specific context and personalization inside each project.
- Preserve provider neutrality across BYO, OpenAI, Bedrock, OpenAI-compatible,
  Kiro, and future adapters.
- Make learning auditable through receipts, proposals, scorecards, and
  dashboard history.

## Non-Goals

- Hosted SaaS learning.
- Production product-agent behavior.
- Tellara-specific prompts, scoring, customer workflows, schemas, or private
  policy.
- Silent edits to reusable agents, workflows, project code, or provider
  settings.
- Uploading private source, logs, feedback, or eval cases for external training.
- Bundling model registries, GPU training infrastructure, private datasets, or
  large model artifacts.

## Architecture

The daemon should run as a local process beside the existing dashboard, worker,
MCP server, and enterprise storage.

```text
local run history + receipts + feedback + evals + failures
        |
        v
learning observer -> signal distiller -> scorer -> proposal planner
        |                                      |
        v                                      v
local learning reports                  approval inbox
                                               |
                                               v
                                  project-local tuning notes
                                  or reusable bundle patch plans
```

Core components:

- **Learning observer**: reads run history, stage receipts, feedback artifacts,
  evaluation results, queue outcomes, provider routes, and failure patterns.
- **Signal distiller**: converts noisy evidence into compact, reusable learning
  signals such as repeated failing stages, high-cost routes, low-quality agent
  outputs, recurring user corrections, or missing eval coverage.
- **Impact scorer**: ranks signals by confidence, frequency, recency, developer
  impact, estimated savings, and risk.
- **Proposal planner**: prepares reviewable improvements for routing, context
  budgets, prompt notes, eval cases, workflow ergonomics, or dashboard guidance.
- **Approval gate**: sends any risky or behavior-changing proposal through the
  existing approval inbox before application.
- **Learning applier**: writes only approved project-local tuning notes or
  reviewed patch-plan files. It does not silently change reusable definitions.

## Autonomy Model

The daemon should be as autonomous as possible for safe local learning work.
Danger is defined by blast radius, reversibility, privacy exposure, and whether
the action changes behavior outside an ephemeral report.

| Action | Default |
| --- | --- |
| Read local run history, receipts, artifacts metadata, feedback, eval summaries, and queue status | Automatic |
| Detect repeated failures, slow stages, high-cost routes, stale context, and eval gaps | Automatic |
| Generate compact learning signals and scorecards | Automatic |
| Export local Markdown/JSON learning reports | Automatic |
| Create dry-run proposals for routing, context budgets, prompt notes, eval cases, or workflow improvements | Automatic |
| Write or update Agent Workflow-created proposal files under `.agent-workflow/learning/` | Automatic when project policy allows writes |
| Write or update future Agent Workflow-created `learning_signals`, `learning_proposals`, and learning status database rows | Automatic when using local Agent Workflow storage |
| Queue approval requests for proposed changes | Automatic |
| Write approved project-local tuning notes under `.agent-workflow/tuning/` | Approval required |
| Generate reusable bundle patch plans for `agents/`, `workflows/`, docs, or schemas | Approval required |
| Modify reusable agents, workflows, package code, docs, schemas, provider settings, or project source | Approval required |
| Run commands, tests, package scripts, or external tools | Approval required unless a project approval rule explicitly auto-executes it |
| Fetch web/model research | Approval or explicit opt-in required |
| Send private source, feedback, logs, prompts, eval cases, or artifacts to a network service | Blocked by default |
| Change production policy, deploy, delete, prune, archive, restore, or expose server mode | Explicit approval required |

Recommended daemon modes:

- `observe`: read evidence and write reports only.
- `propose`: write local learning proposals and queue approvals.
- `apply-approved`: apply only approved project-local tuning notes or patch
  plans.
- `wide-open-local`: maximum local automation for trusted owners, still bounded
  by project policy, blocked paths, receipt requirements, and danger gates.

`wide-open-local` is not a bypass. It should allow the daemon to keep working
without prompts for safe reversible work, but it must still stop for dangerous
changes.

## Storage Model

Use existing local enterprise storage first, with project-local file exports for
portable review.

Suggested tables:

### `learning_signals`

- `id`
- `project_id`
- `workflow_id`
- `stage_id`
- `agent_id`
- `signal_type`
- `source_run_ids`
- `source_artifact_uris`
- `confidence`
- `impact_score`
- `risk_level`
- `summary`
- `evidence_digest`
- `redaction_status`
- `created_at`

### `learning_proposals`

- `id`
- `project_id`
- `signal_ids`
- `proposal_type`
- `target_scope`
- `risk_level`
- `status`
- `approval_id`
- `rationale`
- `expected_benefit`
- `patch_plan_uri`
- `created_at`
- `updated_at`

### `learning_research_notes`

- `id`
- `project_id`
- `source_title`
- `source_url`
- `source_date`
- `summary`
- `approved_for_use`
- `created_at`

Project-local exports:

```text
.agent-workflow/learning/
  reports/
  signals.json
  proposals.json
  proposal-history.md
  research-notes.md
```

Project-local applied learning should continue to use existing tuning files:

```text
.agent-workflow/tuning/
  agent-notes.md
  context-budget-notes.md
  routing-preferences.md
```

## Privacy Boundaries

- The daemon reads local project evidence and writes local outputs by default.
- Web/model research is opt-in and should be stored as summarized local notes.
- Research prompts must not include private source, private feedback, customer
  data, secrets, proprietary prompts, or raw artifacts unless the user
  explicitly approves that transfer.
- Scrubbed exports may share workflow shape, stage status, quality/cost trends,
  and generic lessons, but not private project facts.
- Open-source Agent Workflow can learn reusable developer workflow patterns.
  Product-specific intelligence remains in the project or private system that
  owns it.

## Approval Flow

1. Daemon observes local evidence.
2. Daemon writes signals and a learning report automatically.
3. Daemon creates dry-run proposals automatically.
4. Daemon queues approvals for behavior-changing proposals.
5. User approves, rejects, defers, or asks for more eval evidence.
6. Approved proposals become patch plans or project-local tuning notes.
7. Application writes receipts and updates proposal history.
8. Future reports compare outcomes before and after the applied change.

Approval should be required when a proposal:

- changes reusable agent or workflow definitions
- changes model routing or provider settings
- changes project source files or docs outside `.agent-workflow/learning/`
- runs commands or tests
- uses network access
- promotes project-local learning into the shared bundle
- touches secrets, auth, deployment, storage lifecycle, or server mode

## Dashboard Surfaces

Add a **Learning** dashboard area with:

- Learning daemon status and heartbeat.
- Current mode: `observe`, `propose`, `apply-approved`, or
  `wide-open-local`.
- Latest learning report.
- Repeated failure patterns.
- Cost and latency savings opportunities.
- Routing recommendations.
- Eval coverage gaps.
- Proposal inbox with approve/reject/defer actions.
- Applied learning timeline.
- Privacy/export safety status.
- Research notes and whether they are approved for use.

## CLI Commands

Proposed commands:

```bash
agentflow learning-report --project /path/to/project
agentflow learning-proposals --project /path/to/project
agentflow learning-proposals --project /path/to/project --write
agentflow learning-approvals --project /path/to/project
agentflow learning-approvals --project /path/to/project --approve learn-001 --reviewer "Your Name"
agentflow learning-daemon-status --project /path/to/project
agentflow learning-daemon --project /path/to/project --mode observe --once
agentflow learning-daemon --project /path/to/project --mode observe
agentflow learning-daemon --project /path/to/project --mode propose
agentflow learning-daemon --project /path/to/project --mode apply-approved
agentflow learning-application-plan --project /path/to/project
agentflow learning-application-plan --project /path/to/project --write
```

Future approved-application and research commands:

```bash
agentflow learning-approve --project /path/to/project --ids learn-001
agentflow learning-reject --project /path/to/project --ids learn-002
agentflow learning-apply --project /path/to/project --approved --dry-run
agentflow learning-apply --project /path/to/project --approved --write
agentflow learning-research --project /path/to/project --from notes.md
```

## MCP Tools

Expose the same concepts to Codex, VS Code, Cursor, and other MCP clients:

- `agentflow_learning_report`
- `agentflow_learning_daemon_status`
- `agentflow_learning_daemon_tick`
- `agentflow_learning_proposals`
- `agentflow_learning_approvals`
- `agentflow_learning_application_plan`
- `agentflow_learning_apply`
- `agentflow_learning_research_notes`

MCP tools should default to read-only or dry-run output unless the project
policy and approval state allow writes.

## Phased Implementation Plan

### Phase 1: Read-Only Learning Report

- Status: implemented as a read-only CLI/API/dashboard slice.
- Add report builders over existing runs, feedback, evaluations, routing, and
  failure history.
- Add `learning-report --project`.
- Add dashboard Learning page with report cards and JSON endpoint.
- Keep Phase 1 non-mutating: it reads storage and returns a report, but does
  not write reports, proposals, tuning notes, or daemon state.

### Phase 2: Proposal Generation

- Status: implemented for local proposal generation and approval inbox; proposal
  application remains disabled.
- Add owned local learning storage through `.agent-workflow/learning/` files
  now and `learning_signals` / `learning_proposals` database rows later.
- Generate dry-run proposals automatically from the read-only learning report.
- Write `proposals.json`, `proposals.md`, `approval-inbox.json`, and
  `approval-inbox.md` under `.agent-workflow/learning/` when requested.
- Add proposal inbox visibility in the dashboard and MCP.
- Keep applications disabled.

### Phase 3: Approved Application

- Status: started with dry-run/saved application plans for approved learning
  proposals; application still routes through existing gates.
- Prepare next-step plans from approved learning proposals.
- Generate command suggestions for feedback, eval, debug, or tuning follow-up.
- Keep source, provider, reusable bundle, command, network, and export changes
  un-applied until explicit approval.
- Write Agent Workflow-created application plan files only under
  `.agent-workflow/learning/`.

### Phase 4: Daemon Mode

- Status: started with local `observe` / `propose` daemon modes, one-shot
  ticks, planning-only `apply-approved`, status heartbeat, dashboard status,
  and MCP status/tick wrappers.
- Add heartbeat, scheduling, stale detection, and bounded polling.
- Support `observe`, `propose`, and `apply-approved` modes.
- Add danger gates and approval requirements for risky changes.
- Add dashboard mode controls and privacy status.

### Phase 5: Research And Shared Learning

- Ingest user-approved research notes.
- Generate scrubbed open-source learning summaries.
- Support optional web/model research adapters without private data export.
- Keep product-specific learning project-local or private.

## First Implementation Slice

Start with Phase 1:

- `learning-report --project /path/to/project`
- `/learning` dashboard page
- `/api/learning-report`
- report sections for repeated failures, cost opportunities, eval gaps,
  feedback trends, and suggested next proposals
- no behavior-changing writes

This slice creates immediate value and keeps the autonomy model safe: the daemon
can learn and explain continuously before it is trusted to apply anything.

Phase 1 is intentionally read-only. Phase 2 adds proposal storage and a
dashboard approval inbox, while still keeping application disabled until
explicit user approval exists.
