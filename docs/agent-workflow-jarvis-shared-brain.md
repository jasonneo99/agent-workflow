# Agent Workflow + Jarvis Shared Brain

This guide describes how Jarvis and Agent Workflow can operate as one governed
assistant without collapsing conversation, planning, execution, and host control
into one privileged process.

## Mental Model

Jarvis is the conversational front door. Agent Workflow is the durable working
brain. Fleet Control is the separately signed execution boundary for machine and
fleet operations.

```text
User
  -> Jarvis Voice and UI: understand intent, clarify, explain, notify
  -> Jarvis Orchestrator: select a registered project and bounded goal
  -> Agent Workflow: plan, route, execute, verify, remember, and learn
  -> Fleet Control: perform separately authorized host actions
  -> Jarvis Voice and UI: summarize evidence and request decisions
```

The components share durable evidence, not unrestricted authority. Jarvis does
not translate speech directly into shell commands. Agent Workflow does not infer
approval from conversational tone. Fleet Control does not accept arbitrary
Agent Workflow output as an executable instruction.

## Open-Source And Personal Boundary

This repository contains only the reusable integration pattern:

- Versioned intent, status, approval, handoff, and receipt schemas.
- Registered-project routing and redaction rules.
- Provider-neutral orchestration, daemon optimization, and policy gates.
- Synthetic examples, generic dashboard surfaces, and portable client adapters.
- The abstract Jarvis/Fleet boundary, which another assistant or fleet system
  can implement without Jason's environment.

A separate private companion repository should contain personal add-ons:

- Jarvis persona, voice behavior, wake words, private skills, and preferences.
- Jason-specific memory, contacts, calendars, accounts, and conversation data.
- Real fleet inventory, hostnames, network addresses, signing configuration,
  deployment overlays, and operational secrets.
- Private project mappings, domain prompts, business rules, approval policy,
  and production automation.
- Unscrubbed logs, screenshots, evaluations, incidents, and generated learning
  artifacts.

The private repository should depend on a tagged Agent Workflow release and use
public extension contracts. Agent Workflow must not depend on the private
repository. Improvements should graduate back into open source only after they
are generalized, scrubbed, tested with synthetic fixtures, and useful without
the personal environment.

## Responsibilities

| Layer | Owns | Must not own |
| --- | --- | --- |
| Jarvis Voice and UI | Conversation, intent capture, clarification, presentation, notifications | Raw command execution, silent approval, unrestricted project discovery |
| Jarvis Orchestrator | Registered-project selection, goal routing, plan preview, bounded status composition | Policy overrides, credentials, direct database access |
| Agent Workflow | Workflow plans, agents, handoffs, policy checks, approvals, receipts, artifacts, evaluations, learning | Fleet signing keys, implicit user consent, public-network exposure by default |
| Learning daemon | Evidence collection and low-risk optimization within project policy | Permission expansion, high-risk approval, removal verification gates |
| Fleet Control | Signed and allowlisted host or fleet operations | Natural-language interpretation, workflow planning, durable product memory |

## Request Lifecycle

For a request such as “Create a local web app that tracks household projects”:

1. Jarvis captures the goal and asks only for missing choices that materially
   change the result.
2. The orchestrator resolves a registered project or proposes creating one. It
   chooses a reusable workflow or constructs a validated workflow from reusable
   stages.
3. Jarvis previews the plan: agents, handoffs, expected outputs, permissions,
   approval gates, cost posture, and completion criteria.
4. Agent Workflow queues the approved scope with an idempotency key and durable
   request receipt.
5. Agents exchange explicit artifacts and compact context through auditable
   handoffs. Verification failures trigger bounded retry, remediation, or user
   escalation rather than silent success.
6. Jarvis reports meaningful progress and presents approval cards for protected
   actions. It remains quiet when nothing actionable changed.
7. Agent Workflow stores final artifacts, verification evidence, decisions, and
   a concise reusable memory summary.
8. The daemon evaluates quality, latency, cost, fallbacks, feedback, and workflow
   shape. Low-risk changes may be applied only when project policy already allows
   them; other recommendations return to the user through Jarvis.

## Shared Memory Without Shared Privilege

The shared brain should expose small, typed views instead of one unrestricted
memory pool:

- **Goal state:** requested outcome, registered project, current workflow, and
  completion criteria.
- **Working state:** active stage, accepted handoffs, blocked dependencies, and
  bounded progress.
- **Decision state:** approvals, rejections, revisions, policy decisions, and
  receipts.
- **Evidence state:** tests, evaluations, quality, latency, cost, fallback, and
  recovery proof.
- **Preference state:** explicitly accepted project-local preferences and
  reviewed tuning notes.
- **Operational state:** daemon health, provider health, queue depth, and
  registered project availability.

Raw prompts, credentials, arbitrary filesystem roots, private artifact bodies,
and secret-shaped values do not belong in Jarvis status responses. Project
identity crosses the bridge as a registered project ID, not an arbitrary path.

## Approval Rules

- Conversational phrases such as “looks good” are not approval unless Jarvis is
  handling a specific, visible approval card and confirms the exact action.
- Low-risk work may proceed automatically only when the project's existing
  policy, daemon mode, role rules, and server gates all allow it.
- High-risk actions require explicit approval and a fresh policy recheck.
- Approval and execution should be separated when project policy enables
  separation of duties.
- Duplicate requests reuse the original idempotency result and receipts.
- Fleet actions require the Fleet Control signature and allowlist in addition to
  Agent Workflow approval.

## Useful Interaction Patterns

### Ask and inspect

“Jarvis, what is Agent Workflow doing?” returns active goals, current stages,
recent outcomes, and open approvals. It does not start or modify work.

### Plan before execution

“Plan a local web app for household projects.” Jarvis asks the orchestrator for a
dry-run plan and presents its agents, handoffs, files, commands, and gates. The
user may revise the plan before anything is queued.

### Execute governed work

“Run that plan.” Jarvis submits the previously reviewed envelope with the same
project identity and an idempotency key. Agent Workflow performs policy checks,
records receipts, and reports progress through bounded status events.

### Review daemon improvements

“What has the daemon learned?” returns evidence-backed recommendations with impact,
confidence, risk, reversibility, and the reason each proposal is automatic,
reviewable, or deferred.

### Recover

“Why did the workflow stop?” returns the failed boundary, available evidence,
safe retry or rollback choices, and any decision required from the user.

## Operating Checklist

1. Keep Agent Workflow local-first or behind the authenticated trusted-network
   server mode.
2. Register projects and address them by canonical project ID.
3. Use role enforcement and separation of duties for shared or sensitive work.
4. Keep remote mutation and approval-action gates disabled until their exact
   canaries pass.
5. Route host actions through signed Fleet Control operations.
6. Surface high-risk approvals through Jarvis without deciding them.
7. Record every mutation, approval, execution, and rollback as a durable receipt.
8. Run daemon optimizations in observe or shadow mode before enabling bounded
   low-risk application.
9. Preserve a local dashboard and CLI recovery path when voice, bridge, or MCP
   transport is unavailable.

## Rollout Sequence

1. Read-only health, active goals, and approval inbox.
2. Dry-run workflow planning and explanation.
3. One low-risk idempotent workflow through the authenticated bridge.
4. Explicit high-risk approval presentation without remote decision mutation.
5. One bounded approval and separately signed Fleet action canary.
6. Daemon recommendation summaries in observe mode.
7. Policy-bounded automatic low-risk optimization with promotion and rollback
   evidence.
8. Install personal voice, memory, fleet, and deployment add-ons from the
   separately access-controlled private companion repository.

See [Jarvis ↔ Fleet Management Integration Contract](jarvis-fleet-integration-contract.md),
[Governed Server Mode](server-mode.md), [Local Learning Daemon](local-learning-daemon.md),
and [Autonomy Policy](autonomy.md) for the underlying contracts.
