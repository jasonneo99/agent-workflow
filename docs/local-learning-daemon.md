# Local Learning Daemon

## Operator-pinned scoped repair

Automatic repair requires both `AGENTFLOW_WORKFLOW_AUTO_REPAIR=1` and a valid
operator-signed grant. Neither callback text, origin identity, nor that switch
alone authorizes repair. Missing or invalid configuration fails closed.

The operator's host config at `~/.config/agent-workflow/repair-authority.json`
supplies absolute `AGENTFLOW_REPAIR_GRANT_FILE` and
`AGENTFLOW_REPAIR_AUTHORITY_KEY_FILE` paths and pins the grant envelope's SHA-256
in `AGENTFLOW_REPAIR_GRANT_SHA256`. These are JSON property names; production
ignores similarly named environment variables because the CLI loads writable
project dotenv files. Protect this external config from project/worker writes.
Keep the
Ed25519 private signing key outside the project and agent-writable locations;
the runtime reads only the public key. The grant file is JSON with a `payload`
string and a base64 detached `signature` over those exact UTF-8 payload bytes.
The payload has version 1, enabled, projectRootUri, originTaskId, issuedAt,
expiresAt, and explicit runs containing runId and canonical taskHash. Its
lifetime is at most 24 hours. There are no wildcard project/run grants and no
runtime grant-issuing endpoint. Operator configuration is a trust boundary,
not a sandbox against arbitrary code running with the operator's OS identity.

Every attempt rereads the signed bytes. Revoke by removing or replacing the
grant, disabling repair, or changing the operator pin; an old signed file
cannot replace a differently pinned revision. Do not change the pin from a
callback. Existing action policy, approvals, ownership, finite reservations,
backoff and repair-of-repair refusal still apply. Issuing a grant does not
approve any pending action or automatically resume unrelated workflows.

`callback-continuation --run <id> --notification <id>` uses the host's
independently supplied `CODEX_THREAD_ID` and canonical database rows. It rejects
approval requests, stale/duplicate events and open approvals, records a durable
claim, and never dispatches or approves an action itself. The scoped daemon
continues eligible existing work through its normal gates. Hosts must not copy
receiver identity or operator trust settings from callback payloads. Transport
acceptance and acknowledgment remain distinct from continuation authority.

## Roadmap suggestions

Every daemon tick reads the project-relative roadmap configured as
`project.roadmap_path`. It combines unchecked Markdown tasks (`- [ ] ...`) with
ranked, evidence-backed learning proposals from that project's runs, failures,
evaluations, route feedback, and cost signals. Duplicate titles already present
in the roadmap are suppressed. The advisory next-work suggestions are written to:

- `.agent-workflow/learning/roadmap-suggestions.json`
- `.agent-workflow/learning/roadmap-suggestions.md`

The daemon records the roadmap path, status, open-item count, and suggestion
count in its heartbeat. The dashboard surfaces the same set on each project
page under **Suggested Next Work**, with evidence proposals linked to their
learning-inbox review. It never edits the roadmap or executes a suggested item;
a user or workflow must explicitly select the work.

Project pages provide three explicit decisions: **Add to roadmap**, **Defer**,
and **Dismiss**. Decisions are stored in
`.agent-workflow/learning/roadmap-suggestion-decisions.json`. Approved and
dismissed proposals are removed from later ranking; deferred proposals remain
eligible behind fresh evidence. Approved evidence proposals are appended to the
configured project roadmap with their priority, provenance, rationale, and a
bounded evidence summary. The Projects page shows suggestion counts, new
high-priority proposals produce an in-dashboard attention callout, and each
project page reports daemon heartbeat age and the configured per-project time
budget.

Learning proposals shown on the dashboard can be approved into the configured
project roadmap. This approval adds an unchecked item under `Agent Workflow
Suggestions`, records the proposal source and rationale, and marks the inbox
entry as already added. It does not queue, schedule, or execute the work, and it
does not change the proposal's separate learning-action approval status.

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
- Continuously inspect repository hygiene and security, including duplicated
  implementation blocks, oversized ownership surfaces, dynamic execution, and
  likely committed credentials.
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
- private project-specific prompts, scoring, customer workflows, schemas, or private
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
| Auto-approve and apply low/medium-risk project-local optimization overlays | Automatic by default |
| Queue approval requests for high-risk proposed changes | Automatic |
| Preview stale Agent Workflow MCP sessions from this checkout | Automatic |
| Terminate old duplicate Agent Workflow MCP sessions when `AGENTFLOW_DAEMON_CLEANUP_STALE_MCP=on` and `AGENTFLOW_MCP_CLEANUP_MODE=auto-low-risk` | Automatic, low-risk only |
| Reconcile queued/running workflow runs whose child tasks are already terminal | Automatic by default |
| Scan repository hygiene and security and write `.agent-workflow/learning/repository-maintenance-receipt.json` | Automatic every tick |
| Apply low/medium-risk, policy-allowed repository hygiene or security fixes | Automatic when enabled; every changed file, before/after hash, risk, and validation result must be visible in the receipt |
| Create a local commit containing only its validated maintenance edits | Automatic when enabled; record commit hash, message, and changed files in the receipt |
| Apply high-risk auth, permission, credential, deployment, or trust-boundary changes | Explicit approval required |
| Push, publish, deploy, merge, or rewrite Git history | Explicit approval required |

Visible maintenance commits are opt-in and require a policy-allowed validation
command to pass before Git stages the exact files written by executed daemon
approvals:

```bash
AGENTFLOW_DAEMON_MAINTENANCE_COMMITS=on
AGENTFLOW_DAEMON_MAINTENANCE_VALIDATION_COMMAND="npm run check"
```

The daemon never stages unrelated working-tree changes.
| Write high-risk project-local tuning, eval, workflow, source, provider, command, network, or export changes | Approval required |
| Generate reusable bundle patch plans for `agents/`, `workflows/`, docs, or schemas | Approval required |
| Modify reusable agents, workflows, package code, docs, schemas, provider settings, or project source | Approval required |
| Run commands, tests, package scripts, or external tools | Approval required unless a project approval rule explicitly auto-executes it |
| Fetch web/model research | Approval or explicit opt-in required |
| Send private source, feedback, logs, prompts, eval cases, or artifacts to a network service | Blocked by default |
| Change production policy, deploy, delete, prune, archive, restore, or expose server mode | Explicit approval required |

Recommended daemon modes:

- `apply-approved`: default autonomous local mode. Refresh Agent
  Workflow-owned reports, proposal state, workflow-shape recommendation files,
  application-plan files, and low/medium-risk project-local optimization
  overlays without changing project source, reusable workflows, reusable agents,
  providers, commands, networks, or exports.
- `observe`: read evidence and write reports only.
- `propose`: write local learning proposals and queue approvals.
- `wide-open-local`: maximum local automation for trusted owners, still bounded
  by project policy, blocked paths, receipt requirements, and danger gates.

`wide-open-local` is not a bypass. It should allow the daemon to keep working
without prompts for safe reversible work, but it must still stop for dangerous
changes.

### Stale MCP Cleanup

Codex, Cursor, and other IDE clients can leave old Agent Workflow MCP server
processes behind after restarts or interrupted sessions. The runtime monitor and
learning daemon can identify these as cleanup candidates without touching
unrelated processes.

The open-source default is preview-only:

```bash
AGENTFLOW_DAEMON_CLEANUP_STALE_MCP=off
AGENTFLOW_MCP_CLEANUP_MODE=preview
AGENTFLOW_MCP_STALE_MINUTES=60
```

To let the daemon clean up only low-risk candidates:

```bash
AGENTFLOW_DAEMON_CLEANUP_STALE_MCP=on
AGENTFLOW_MCP_CLEANUP_MODE=auto-low-risk
AGENTFLOW_MCP_STALE_MINUTES=60
```

Low-risk means the process is an Agent Workflow MCP command from the current
checkout, belongs to an older duplicate MCP session, and is older than the stale
threshold. The newest MCP session is preserved so the current IDE bridge is not
terminated.

Useful commands:

```bash
npm run runtime-monitor -- --cleanup-mcp
npm run runtime-monitor -- --cleanup-mcp --confirm
npm run runtime-monitor -- --cleanup-mcp --confirm --auto-low-risk
```

The daemon writes the latest audit receipt to:

```text
.agent-workflow/learning/mcp-cleanup-receipt.json
.agent-workflow/learning/mcp-cleanup-receipt.md
```

## Stale Run Reconciliation

Interrupted workers, retries, or cancelled downstream stages can leave a parent
workflow run marked `queued` or `running` after every child task is already in a
terminal state. The daemon treats that as Agent Workflow bookkeeping, not as
project behavior, and can repair it automatically.

The daemon only reconciles runs when there are no queued, running, or failed
child tasks left. Mixed completed/cancelled runs become `completed`.
All-cancelled runs become `cancelled`. Every repair writes a
`stale_run_reconciled` receipt.

The default is on:

```bash
AGENTFLOW_DAEMON_RECONCILE_STALE_RUNS=on
AGENTFLOW_STALE_RUN_RECONCILE_LIMIT=50
```

To run it manually:

```bash
npm run runtime-monitor -- --reconcile-stale-runs
npm run runtime-monitor -- --reconcile-stale-runs --confirm
```

The daemon writes the latest audit receipt to:

```text
.agent-workflow/learning/stale-run-reconciliation-receipt.json
.agent-workflow/learning/stale-run-reconciliation-receipt.md
```

## Agent Definition Improvement Loop

The daemon can also improve the agents themselves. The first open-source slice
is evidence collection and recommendation generation; it does not silently edit
canonical reusable agent cards.

The loop reads:

- reusable and project-local agent cards
- workflow stage and subagent references
- local run status, stage health, feedback counts, and cost/routing signals
- compact cost/quality reports and evaluation metadata when available

It writes Agent Workflow-owned learning artifacts:

```text
.agent-workflow/learning/agent-improvement-report.json
.agent-workflow/learning/agent-improvement-recommendations.md
.agent-workflow/learning/agent-improvement-patches.json
.agent-workflow/learning/agent-improvement-patches.md
.agent-workflow/learning/agent-improvement-evals.json
.agent-workflow/learning/agent-improvement-evals.md
.agent-workflow/learning/agent-improvement-promotions.json
.agent-workflow/learning/agent-improvement-promotions.md
.agent-workflow/learning/agent-improvement-promotion-receipts.json
.agent-workflow/learning/agent-improvement-promotion-receipts.md
.agent-workflow/learning/agent-improvement-apply-receipts.json
.agent-workflow/learning/agent-improvement-apply-receipts.md
```

Run it manually:

```bash
npm run agentflow -- agent-improvement-report --project /path/to/project
npm run agentflow -- agent-improvement-report --project /path/to/project --write
npm run agentflow -- agent-improvement-report --project /path/to/project --agent ux-reviewer --json
npm run agentflow -- agent-improvement-patches --project /path/to/project
npm run agentflow -- agent-improvement-patches --project /path/to/project --write
npm run agentflow -- agent-improvement-patches --project /path/to/project --ids ux-reviewer --json
npm run agentflow -- agent-improvement-evals --project /path/to/project
npm run agentflow -- agent-improvement-evals --project /path/to/project --write
npm run agentflow -- agent-improvement-evals --project /path/to/project --ids ux-reviewer --json
npm run agentflow -- agent-improvement-promotions --project /path/to/project
npm run agentflow -- agent-improvement-promotions --project /path/to/project --write
npm run agentflow -- agent-improvement-promotions --project /path/to/project --approve promotion-patch-agent-ux-reviewer-improvement --reviewer "Your Name" --note "Approved after holdout eval review"
npm run agentflow -- agent-improvement-apply --project /path/to/project
npm run agentflow -- agent-improvement-apply --project /path/to/project --max-risk medium --write
```

The same report is available in the dashboard on `/learning` and through MCP as
`agentflow_agent_improvement_report`. Patch previews are available as
`agentflow_agent_improvement_patches`. Holdout promotion scoring is available
as `agentflow_agent_improvement_evals`. Promotion queue decisions and receipts
are available as `agentflow_agent_improvement_promotions`. Approved promotion
application is available as `agentflow_agent_improvement_apply`.

The report recommends improvements to fields such as `prompt`, `can`,
`requires_approval`, `context_budget`, and `outputs`. Examples include adding
receipt expectations, stronger validation language, accessibility criteria for
UX agents, secret/auth checks for engineering and security agents, or clearer
selection rules for unused agents.

Safe autonomy for this loop:

- The daemon may refresh the report and recommendations during each learning
  tick.
- It may generate abstract research queries based on public role names such as
  "UX reviewer" or "test engineer".
- It must not include private source, logs, prompts, feedback, eval cases, or
  customer data in research prompts without explicit approval.

Agent YAML application is intentionally a separate step after promotion
scoring. `agent-improvement-apply` applies approved patch previews only when
the source hash still matches the rollback evidence, the proposed YAML validates
against the agent-card schema, and the promotion risk is within the selected
threshold. Dry-run mode is the default. `--write` updates the YAML and records
apply receipts.

The daemon may run this application step in `apply-approved` mode for
project-local promotions that are holdout-passing, auto-apply-ready, still
source-hash-current, and within the configured autonomy risk threshold. This is
controlled by `agentImprovementProjectLocalAutoApply` in
`.agent-workflow/learning/settings.json` or
`AGENTFLOW_AGENT_IMPROVEMENT_PROJECT_LOCAL_AUTO_APPLY=off`. Manual
`agent-improvement-apply --write` remains the explicit path for approved shared
agent YAML promotions. The daemon still stops or skips when the source hash
changed, schema validation fails, the item is not project-local auto-ready, or
the risk exceeds the configured threshold.

Approval remains required before the daemon:

- applies shared, unapproved, or high-risk agent YAML promotions
- expands tool permissions or autonomy beyond the configured threshold
- weakens safety boundaries
- promotes a candidate into a signed/released bundle

Patch previews include source-hash checks, schema validation, full proposed
YAML, a review diff, and rollback references. They are still learning-owned
artifacts; they do not edit agent files.

Holdout eval scoring compares patch previews against recent representative run
evidence before promotion. It checks schema validity, rollback source hashes,
minimum holdout task coverage, risk boundaries, and whether local feedback,
failure, or routing evidence supports the patch. The output marks each patch
`pass`, `warn`, or `fail`, then separates promotion readiness from apply
eligibility.

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
  action-receipts.json
  action-receipts.md
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
- Project path mapping when shared storage keeps a project under one host path
  and the current machine uses another local checkout path.
- Current mode: `observe`, `propose`, `apply-approved`, or
  `wide-open-local`.
- Latest learning report.
- Repeated failure patterns.
- Cost and latency savings opportunities.
- Route feedback signals from model-improvement drilldowns, including costly
  and helpful route groups the daemon can use to prioritize routing proposals.
- Low-risk learning proposals generated from repeated costly or helpful route
  feedback, pointing to routing recommendation refreshes before any provider or
  workflow setting changes are considered.
- A direct autonomous writer for approved route-feedback learning proposals that
  refreshes `.agent-workflow/model-improvement/local-llm-routing-recommendations.*`
  without shelling out, editing provider settings, or changing workflow YAML.
- Routing recommendations.
- Workflow-shape recommendations for adding, removing, splitting, collapsing,
  or gating stages.
- Suggested new local agent types when repeated evidence shows a missing role.
- Eval coverage gaps.
- Proposal inbox with approve/reject/defer actions.
- Applied learning timeline.
- Learning receipt health with duplicate daemon-open receipt counts,
  backup-first compaction, and the latest compaction backup path.
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
agentflow learning-daemon --all-projects --mode apply-approved --once
agentflow learning-daemon --all-projects --mode apply-approved
agentflow learning-daemon --project /path/to/project --once
agentflow learning-daemon --project /path/to/project --mode observe --once
agentflow learning-daemon --project /path/to/project --mode observe
agentflow learning-daemon --project /path/to/project --mode propose
agentflow learning-daemon --project /path/to/project --mode apply-approved
agentflow learning-application-plan --project /path/to/project
agentflow learning-application-plan --project /path/to/project --write
agentflow learning-action-receipts --project /path/to/project
agentflow learning-action-receipts --project /path/to/project --health
agentflow learning-action-receipts --project /path/to/project --compact
agentflow learning-action-receipts --project /path/to/project --reject learn-action-001 --actor "Your Name"
agentflow learning-workflow-shape --project /path/to/project --workflow build-feature
agentflow learning-workflow-shape --project /path/to/project --workflow build-feature --write
agentflow agent-improvement-apply --project /path/to/project
agentflow agent-improvement-apply --project /path/to/project --max-risk medium --write
```

`--all-projects` iterates the local project registry and writes each project's
own `.agent-workflow/learning/` report, inbox, application plan, shape
recommendations, and daemon heartbeat. A failed or unavailable project records a
failed heartbeat for that project without stopping the daemon for the rest.

Each project analysis also has an independent 120-second default budget. A
project that exceeds `AGENTFLOW_LEARNING_PROJECT_TIMEOUT_MS` is isolated while
its current operation settles; later cycles do not start overlapping work for
that project, and the remaining project fleet continues to receive heartbeats
and updates.

Each project governs its all-projects participation in
`.agent-workflow/learning/settings.json` with `daemonEnabled`, `daemonPaused`,
`daemonMode`, and `daemonRunLimit`. These controls are also available on the
Learning dashboard. Every tick writes `daemon-fleet-receipt.json` and
`daemon-fleet-receipt.md` under the supervisor project's learning directory,
listing scheduled, skipped, and failed projects.

When shared storage contains project roots from another machine, map those roots
to local checkouts before writing project-local learning files:

```bash
AGENTFLOW_PROJECT_PATH_MAP=/home/example/Projects=/Users/example/Projects
```

The dashboard also detects the common Linux-home to macOS-home mapping
automatically when the target checkout exists locally.

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
- `agentflow_learning_action_receipts`
- `agentflow_learning_workflow_shape`
- `agentflow_learning_apply`
- `agentflow_learning_research_notes`
- `agentflow_agent_improvement_apply`

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

- Status: implemented with dry-run/saved application plans for approved
  learning proposals and append-only proposal-to-action receipts; application
  still routes through existing gates.
- Prepare next-step plans from approved learning proposals.
- Generate command suggestions for feedback, eval, debug, or tuning follow-up.
- Keep source, provider, reusable bundle, command, network, and export changes
  un-applied until explicit approval.
- Write Agent Workflow-created application plan files only under
  `.agent-workflow/learning/`.
- Record append-only receipts when proposals become application plans, when
  planned actions are superseded, and when a user rejects a planned action.

### Phase 4: Daemon Mode

- Status: started with default autonomous local `apply-approved` mode, optional
  `observe` / `propose` modes, one-shot ticks, status heartbeat, dashboard
  status, and MCP status/tick wrappers.
- Add heartbeat, scheduling, stale detection, and bounded polling.
- Default to `apply-approved` autonomous local mode while still supporting
  `observe` and `propose`.
- Default autonomous apply threshold to low/medium risk; high-risk proposals
  remain approval-gated.
- Add danger gates and approval requirements for risky changes.
- Add dashboard mode controls and privacy status.
- Add workflow shape optimization that uses local run history, failures,
  feedback, routing/cost data, eval evidence, and project context to recommend
  adding, removing, splitting, collapsing, or gating workflow stages and
  prototyping new agent types.
- Default every daemon tick to autonomous refresh of
  Agent Workflow-owned learning artifacts:
  `.agent-workflow/learning/workflow-shape-proposals.json`,
  `.agent-workflow/learning/stage-recommendations.md`, and future
  `learning_stage_recommendations` rows.
- Provide a dashboard switch to turn autonomous recommendation-file refresh off
  for approval-first review.
- Keep shared `workflows/*.yaml`, reusable agents, provider settings, project
  source, commands, network calls, high-risk tuning/eval application, and
  private-data export approval-gated.

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

## Workflow supervision and self-healing

In `apply-approved` mode the daemon acts as a bounded workflow supervisor. Each
project tick first requeues unfinished stages whose worker leases expired. It
may then repair one recent blocked, failed, or falsely completed delivery run
per project at a time. A completed build is repairable when its stage artifacts
contain no governed product-write evidence or no executed verification evidence.
The daemon refreshes the registered project index, retrieves bounded exact
excerpts, carries forward the source task and supervisor finding, and queues a
governed `debug-failure` run. The source run receives a durable repair receipt
and remains available for audit.

Self-healing also covers delivery runs that stopped at read-only discovery or a
policy/authority mismatch. A repair must operate inside the current project
policy and is explicitly forbidden from editing policy to grant itself more
authority. It does not act when an approval is open, only auto-repairs runs
within 30 minutes of their finish time, permits only one active repair per project, prevents recursive
repair runs, and never bypasses command, write, network, secret, deployment, or
external-system gates. A genuine missing permission therefore remains blocked
with an exact approval or policy requirement instead of becoming false success.
Older history is an audit backlog and requires explicit operator review; the
daemon does not walk backward through it and manufacture new work.

### Queue Partner and bounded repair coordination

The `queue-partner` operations agent is the conversational role for explaining
family priorities, shared blockers, missing evidence and exact approval needs.
Its scheduling advice never grants execution authority. The
`queue-coordinator` CLI provides the bounded execution foundation: three repair
lanes and one independent acceptance verifier. Run without `--execute` for a
preview; `--initialize` creates additive reservation and immutable revision
storage. Explicitly authorized `--execute --watch --project <roots...>` enables
the bounded lanes for that process's initial reviewed inventory, not future
backlog. Enrollment gaps remain visible; idle lanes never imply an empty queue.

Queue Partner should act on already-authorized local repair work without repeated
operator confirmation. Technical failures and missing historical evidence go to
evidence recovery or a bounded Codex assistance handoff, not a generic approval
question. A handoff must identify the canonical family, original requirements,
current revision, precise error, receipt references, attempted fixes and permitted
scope. It must reuse the existing checkpoint and deduplicate unchanged requests.
Only a supported transport acknowledgement establishes that Codex was contacted;
the agent prompt alone does not implement that transport. If unavailable, retain
the technical hold explicitly. Ask the operator only for a specific missing
permission, never to resolve an implementation uncertainty or waive unavailable
proof. Existing policy and independent acceptance checks remain authoritative.

The coordinator now records deduplicated technical-help messages on the original
source run and uses the existing fenced Codex notification transport. Destinations
come only from the original run's trusted Codex binding. Missing bindings are
reported as unavailable, never replaced with a guessed thread. Each pass creates
at most three new requests; unchanged requests retain their original outbox row.
Transport acceptance is not arrival or completed help. Approval, evaluation,
active-family and external-proof waits do not become technical repair requests.
`--request-help` performs this bounded help pass without dispatching repairs;
ordinary previews remain read-only. Execution mode uses the same help path while
retaining three unrelated repair lanes and one independent verifier. Already
running processes do not acquire new source code until an authorized reload.

Legacy runs without an original typed enrollment require a separate explicit
human authorization for a `legacy-current-baseline` record. The record preserves
the full original task verbatim and all four acceptance gates, captures the real
current manifest under an exact live work intent, and binds the independently
approved offline provider/tier. It never backfills the original contract or
claims the current baseline was a historical preimage. A chained authorization
receipt must bind the exact original project, family, task hash, paths and route.
`--enroll-legacy <file>` consumes at most three such authorized plans and cannot
dispatch, watch or request help. Original metadata, overrides, approvals and
statuses remain unchanged. Evaluation work and incomplete original receipt chains
remain excluded. A no-change candidate is permitted only for this explicit legacy
mode so already-correct source can receive independent verification without a
manufactured diff; it still requires the full original gates and current-source
proof. Durable family/lane claims and no-loop suppression continue to apply.

Enrollment requires an original runtime-owned acceptance contract, a canonical
execution scope, exact source paths, matching source evidence, current policy
and a live fenced work intent. Display-only grouping is not execution authority.
Pending approvals, active families, overlapping files, unchanged failures,
recursive repairs and unavailable external proof stay held. Uncertain execution
retains its reservation for reconciliation, rather than becoming an automatic
retry. Evaluation/training work is excluded from these general repair lanes.

Every assignment adds receipts without rewriting original failures. The verifier
checks original requirements, current source and governed receipt chains;
neither an agent report nor a completed repair child closes the original run.
This initial coordinator does not automatically dismiss runs.

The dashboard home includes a Queue Partner conversation using the registered
agent and the existing provider connection. Each answer receives a fresh bounded
snapshot filtered to the selected execution project; logical aliases do not
transfer evidence access. Source counts, omissions, capture time, blockers,
approval status and history links are included as untrusted evidence. Switching
projects clears the conversation. Questions remain read-only; action requests
hand back to governed review, while already-authorized autonomous repairs run
through the coordinator. The conversation itself never approves, deploys or
changes run state. The separate native Studio conversation surface is unchanged.

A repair captures an immutable actual preimage before writing. A candidate is
recorded only after the completed repair's governed write transitions account
for the entire enrolled source manifest. A separate read-only verifier receives
a new contract on that candidate's source hash, with exactly the original
deliverable descriptions, required gates and advisory/severity settings. Four
gates, current source, all receipt chains, original provider/tier, and family
approval/activity holds are checked before appending an immutable attestation.
The original contract and approvals are never replaced or inherited as authority.
Later changes or new approvals invalidate current attestation checks; historical
attestations remain intact. Missing historical preimages cannot be invented.

Self-repair learning means proposing scrubbed lessons and regression cases from
independently verified outcomes through the existing learning review process.
It does not mean silent model training, policy changes, promotion or new paid
evaluations. Those remain separately governed decisions.

Runs launched from Codex retain the originating Codex task identifier in local
run metadata. When a new approval remains pending or a new failure cannot be
self-healed, the daemon resumes that exact Codex task with a bounded callback.
Approval callbacks instruct Codex to ask the user for approve-and-execute,
approve-only, reject, or dismiss the approval request; they never grant approval
themselves. Failure callbacks may continue only separately authorized work,
otherwise they ask for direction. Successful callback delivery is recorded as an idempotent
`codex_attention_delivered` receipt, so daemon polling cannot repeatedly message
the same task. Callback identifiers are removed from scrubbed run exports.

An operator may also record a durable `workflow_supervisor_repair_suppressed`
receipt on the original source run after reviewing a stale or externally
superseded lineage. The supervisor treats that original receipt as a permanent
stop condition and cancels any still-active automatic repair linked to it.

Before dismissal, the supervisor requires exact project/task and requirement
equivalence with an independently accepted completed replacement. Narrative
delivery files, fuzzy task terms, plans, inspection-only receipts and a queued
replacement cannot establish that proof. Recovery preserves its unfinished
source and immutable lineage until independent acceptance. Already dismissed
history is never eligible for another repair.

## Autonomous Queue Partner recovery

Partner owns technical recovery across registered queued projects using the
configured model/provider and governed worker, not a technical-help callback to
a separate coding chat. Enable `--autonomous-recovery` on the existing
`queue-coordinator --execute --manage-self-repair` owner, using explicit
`--project` roots or `--all-queued-projects`. Add `--watch` for rolling refill;
keep only one watch. Read-only previews never execute actors. The legacy
`--request-help` option sends no chat handoff from this coordinator.

The target is 3-5 genuinely working items, aiming for five. Ordinary repairs,
autonomous recovery and the single independent verifier share the same total
capacity, durable family/lane indexes, source overlap checks and uncertain-claim
fences. A held card is not active work, and a recovery lifecycle completion is
not acceptance of the original product.

Missing old acceptance enrollment does not prevent model-backed investigation.
Without a safe exact scope, the first turn is read-only and returns
`artifact.proposedSourcePaths`: at most 40 exact existing project-relative
source/test paths. A subsequent turn revalidates canonical ownership, current
disk policy and source hashes and acquires the exact source intent before
repair. A suggestion selects work inside current permissions; it cannot create
a grant, transfer approval, invent a historical preimage or rewrite a contract.
Scoped actors can execute allowed commands/writes and inspect actual results.
Command recipes are narrowed to focused, scope-bound checks. An existing broad
Python grant can produce an exact in-scope unittest recipe; an exact or blocked
grant is never widened. Inspect tests for live effects before execution: write
containment does not establish offline behavior or network/secret isolation. The actor
snapshot sets `actions.isolate_command_writes: true`: on supported macOS hosts,
the existing system sandbox denies project/host file writes by commands and
their subprocesses, permitting only per-command scratch output. Source edits
still use governed file tools. Other hosts fail closed for these commands until
a supported containment backend exists; there is no unsandboxed fallback.
Omitting this optional field preserves ordinary project command behavior.
Suggested scopes require both an exact current reservation receipt segment and
a completed child's output bound to its verified receipt chain. This does not
repair or certify missing historical provenance.

Every turn retains a semantic fingerprint and a durable five-turn lifetime budget;
earlier reservations remain counted, including reservations made under an older
limit. Protocol, command-contract and actual source/effect changes are relevant;
clocks, generated ids and changing model prose do not rearm unchanged failures. Refused or
already-investigated rows do not starve later eligible items. Shutdown prevents
new reservations and drains owned work without cancellation or lease reset.
Uncertain effects remain fenced for supported reconciliation.

Fresh actors receive bounded authenticated prior owned command/write facts,
including failed checks, so missing handoff context does not erase actual
results. Historical passes are not acceptance of changed source. A queued
checkpoint can wait briefly on the same child and exact live intent/assignment
fences; foreign leases, lost ownership and exhausted continuation bounds remain
uncertain rather than triggering another run.

A terminal read-only discovery that lost its outcome observation can be closed
through `reconcileReadOnlyPartnerChild` without replay. This requires an audited
prospective operator authorization, a new exact live scope intent after the old
owner expires, canonical/current-policy checks, an authentic protocol reservation,
a verified child receipt chain, bound terminal task outputs, explicitly empty
frozen approval rules, and no pending, approved or executing actions on child
or original. Approval absence is rechecked at the final state effect. Writers
and queued/checkpointed children are refused.
Only the reservation becomes held: original results, acceptance, budgets and prior
uncertainty receipts remain unchanged.

An interrupted strictly read-only child can instead use
`handoffReadOnlyPartnerChild` under a fresh, receipt-bound operator authorization.
The exact old task/run leases and intent must be expired, and the operator must
independently verify prior-worker quiescence. Current canonical project/policy,
the exact new intent, task generation, bounded checkpoint/effect observations,
the original reservation and preceding handoff proofs, a complete child receipt
chain, and a strict read-only receipt allowlist are required. Frozen command,
write-path and approval-rule arrays must all be empty; pending, approved or
executing child/original actions prevent delegation. Two handoffs per assignment
is a durable ceiling, not a budget reset.

The handoff preserves the reservation ID, fence and lane, immutable run/task/policy
snapshots and consumed recovery budget. Only its owner/intent changes. Installed
SQL claim fences reject the old worker; ordinary claim APIs give the new exact
worker a fresh task/run lease generation. A new observation of an older checkpoint
does not invent historical payload provenance. Write-capable interruptions need a
separately supported effect-reconciliation path, never a read-only API or generic
cancellation/replay workaround.

Model discovery responses carry `proposedSourcePaths` as a top-level JSON array
of at most 40 exact project-relative source/test paths. The portable normalizer
stores this in artifact metadata; Codex CLI's strict schema supports the field.
References to `artifact.proposedSourcePaths` mean its stored location, not a
free-form JSON envelope. A JSON proposal embedded only in findings remains
narrative and is never promoted into structured scope. Malformed proposals are
omitted as a whole. Current project/path/policy checks still govern any later
action; a proposal is not permission, an executable request or acceptance.

The nullable `memoryInfluence` field similarly carries at most 12 bounded
comparison IDs, known influence classifications and reasons. Attribution must
still refer to comparisons actually supplied to the task. Neither field can copy
grants between projects or waive an existing owner, source or acceptance guard.

Initialize the normal CLI runtime before any live worker invocation. A
database-only test bootstrap does not configure the model. Record the actual
executed route: a mock completion is synthetic lifecycle evidence, not genuine
autonomous reasoning or product acceptance. Preserve and disclose a misrouted
result rather than relabeling it or refunding its consumed recovery budget.

Partner requests a human decision only for genuinely missing permission/access,
a material choice, unavailable physical proof or an exact exhausted recovery
boundary. Technical uncertainty, missing evidence and routine failed tests are
work for its own configured model, not instructions for another chat to solve.
Source, installed/deployed, native and human acceptance remain distinct.
Explicit current operator authorization can cover high-risk actions; the risk
label alone is not another approval requirement. This does not create grants
from model output, transfer project permissions, remove audit or independent
verification, or bypass another owner's claims.
