# Local-Only Learning and Guarded Autonomy

## Program statement

Agent Workflow is a reliability and learning layer for agentic systems. It is
not an AGI system and does not treat model capability, confidence, or persuasive
output as authority. The program makes capable models safer, more dependable,
more cost-efficient, and more useful for long-running work by measuring outcomes,
issuing bounded authority, retaining accountable local evidence, and stopping
safely when the system cannot prove that continuing is allowed.

Local-only is the default. Private source, prompts, feedback, receipts,
artifacts, memories, eval cases, and scoring remain in the configured local
project/state plane. Any network export requires a separate explicit approval,
scope-limited payload, redaction proof, destination, purpose, and receipt.

## Non-goals

- Claiming Agent Workflow is AGI or measuring general intelligence.
- Training foundation models or exporting private data for training.
- Silent self-modification of shared agents, workflows, providers, policies,
  source code, release state, or production systems.
- Letting a model's self-reported confidence grant action authority.
- Replacing project policy, human approvals, deterministic enforcement, or
  independent verification with model judgment.
- Making server mode, network access, live provider calls, or production action
  a prerequisite for the local learning loop.

## Existing foundations and gaps

Reuse rather than replace these current foundations:

- `packages/evaluation`: suites, variants, comparison rows, frozen-baseline
  regression gates, quality, latency, fallback, and cost evidence;
- `packages/learning-evidence`, `learning-proposals`, and
  `learning-governance`: local reports, proposals, approval queues, application
  plans, risk levels, and owned-state boundaries;
- `packages/policy-engine`: command/write allowlists, approval rules, autonomy
  levels, immutable execution-policy snapshots, and fail-closed decisions;
- workflow-engine/storage: durable runs and tasks, idempotency keys, renewable
  leases, checkpoint resume/replay, action approvals, receipts, artifacts, and
  handoff evidence;
- run reporting and export redaction: measured usage coverage, local feedback,
  receipt reporting, and scrubbed outputs;
- Context Intelligence Gateway: source hashes, bounded cited claims, project
  isolation, cache invalidation, and holdout-backed conservative routing.

The program fills four gaps: a representative end-to-end reliability baseline;
one authority contract shared by every stage; provenance and permitted-use rules
for retained memory; and independently enforced hierarchical breakers.

## Ownership boundaries

| Owner | May contain | May change automatically | Must not contain or control |
| --- | --- | --- | --- |
| Project-local learning state | private evidence, reports, proposals, eval cases, overlays, baseline and rollback references | Agent Workflow-owned reports and explicitly policy-eligible low-risk local overlays | another project or tenant's data; shared definitions; provider or production policy |
| Reusable shared assets | generic schemas, synthetic/public fixtures, workflow/agent templates, redaction and gate logic | nothing through learning alone | private prompts, source, customer scoring, host topology, personal memory |
| Human-controlled policy | authority ceilings, approvals, breakers, budgets, provider/network/export permissions, production gates | deterministic expiry or restriction only | model-authored authority escalation or silent re-enable |

A private companion repository may consume tagged shared assets. The shared
Agent Workflow repository never imports private companion state.

## Required contracts

### Reliability observation

Each observation binds:

- suite, case, fixture, hidden-check, evaluator, workflow, agent, provider/model,
  prompt/context, policy, authority, and code/bundle versions by stable ID/hash;
- correctness, verification coverage, reviewer effort, recovery/rollback,
  interventions, unsafe attempts, measured usage coverage, cost, latency,
  context, fallback, confidence, issued authority, and actual outcome;
- data classification and whether aggregate export is allowed;
- `measured`, `partial`, or `unavailable` coverage for every metric.

### Stage authority grant

The grant is an immutable, expiring policy result, not model text. It includes:

- project/tenant/run/task/stage/agent and action target scope;
- requested, policy ceiling, and issued ladder level;
- evidence and baseline hashes, issuer, issue/expiry time, and idempotency key;
- command/write/tool/provider/network classes and quantitative budgets;
- reversibility class, dry-run result, required approval and verifier;
- applicable breaker generations and human override state.

Execution must revalidate the grant and breaker generations immediately before
every side effect. A stale worker, changed target, changed policy, expired grant,
or tripped breaker denies the action.

### Provenance-first memory claim

Every claim or decision includes a source URI/kind and hash, project and tenant,
creator, created time, expiry/revalidation rule, evidence strength, dependencies,
conflicts, derivation/version, and permitted use: `planning` or `action`.
Summaries are indexes over claims, not replacement evidence. Action use requires
fresh in-scope sources, resolved conflicts, sufficient strength, and explicit
action permission.

### Transaction and terminal receipt

Every action-capable transaction declares preconditions, authority grant,
simulation result, idempotency key, lease/fencing generation, checkpoints,
intended effects, observed effects, verifier, rollback/compensation plan,
terminal outcome, unresolved risks, and retained evidence. Terminal states are
validated transitions; neither model prose nor an absent worker may mark work
complete.

### Breaker state

Breaker records are independently enforced and hierarchical: global, project,
workflow, agent, provider, and tool class. A record binds state, generation,
reason, evidence, trigger, actor, created/expiry time, affected leases/grants,
resume requirements, and receipt. The most restrictive applicable breaker wins.
Only a human-controlled flow may re-enable a tripped scope.

## Initial architecture decisions

These are the recommended initial defaults. They remain versioned decisions and
may be revised through evidence and human review; they do not imply the runtime
capabilities already exist.

1. Baselines and authority/provenance state use append-only versioned records
   with derived current views. Large artifacts are content-addressed. Rollback
   selects an earlier accepted version instead of rewriting history.
2. Hidden checks live in a separately packaged, content-addressed evaluator
   bundle and run after candidate execution in an isolated process. Candidates
   see fixtures and public scoring categories, but not hidden assertions,
   expected outputs, or private holdout identities. Receipts bind evaluator
   bundle and runtime hashes.
3. Fewer than 10 representative cases are insufficient. From 10 through 29,
   evidence may support only a human-approved recommendation. Project-local
   canaries require at least 30 cases and five cases per affected workflow
   class, a five-percent relative or three-point absolute quality gain, paired
   comparisons where possible, and a 95-percent confidence bound excluding
   meaningful degradation. Promotion also requires zero new severe safety
   violations, no material verification/recovery/policy regression, and no
   more than a 10-percent unapproved cost or latency regression.
4. Reviewer burden stores structured metrics only: decision time, total review
   time, pass count, revisions, disposition, manual correction count/category,
   and an optional local score. Shared aggregates require cohorts of at least
   10 and exclude review text, prompts, source excerpts, identities, and project
   names.
5. Effects are classified `R0` read-only, `R1` reversible local, `R2`
   consequential but compensable, and `R3` irreversible or external. `R0` may
   be automatic within budgets; `R1` requires evaluation and policy approval;
   `R2` always requires explicit human approval; and `R3` is never autonomous
   initially. Production deletion, credential/security-boundary changes,
   destructive migrations, and critical releases are candidates for later
   two-person approval, not current autonomous authority.
6. Breakers use one authoritative durable generation and the most restrictive
   applicable scope wins. Execution revalidates breaker generations, grants,
   and leases immediately before each side effect. An unreadable current state
   denies mutation; cached state may only restrict. Trips increment generation
   and invalidate stale grants and leases. Offline workers may only observe or
   propose. Re-enable is a new human-authored event.
7. Memory preserves conflicting claims rather than silently selecting a winner.
   Source mutation or revocation marks dependent action claims stale through
   the dependency graph. Stale or disputed claims may support labeled planning
   but cannot support action until revalidated or resolved. Precedence is human
   policy/correction, fresh authoritative source, fresh direct observation,
   verified derived evidence, then summaries/model inference. Resolution
   creates a new record.
8. Canary rollout proceeds through shadow, 10 percent after at least 10 runs,
   25 percent after 20 additional runs, 50 percent after 30 additional runs,
   and 100 percent only after human approval. Each stage lasts at least 24 hours
   or its run minimum; low-volume projects may use seven days. New severe
   safety violations, authority anomalies, repeated verification failure,
   material correctness/recovery/cost/latency regression, corrupted evidence,
   or statistically credible quality decline triggers rollback and quarantine.

## Promotion and rollback rules

No candidate advances because it is newer or because a model recommends it.
Promotion requires a frozen baseline, representative holdouts, hidden checks,
complete-enough measured coverage, policy approval, no safety regression, source
hashes, a canary window, and a rollback reference. Shared assets always require
human review. A regression, compromised evaluator, stale evidence, unexpected
authority request, or unresolved side effect trips the narrowest breaker and
returns that scope to observe-only.

Rollback preserves evidence. It restores pinned definitions or local overlays,
revokes outstanding authority, stops new claims, quarantines the candidate and
derived action-use memory, records compensation, and requires human re-enable.
It never deletes queues, receipts, memory, artifacts, or user work.

## Implemented foundation

The first six prioritized slices are implemented on the shared local state
plane:

- the seven synthetic workflows execute through a separate evaluator process
  and produce a frozen measured baseline with explicit provider/model, latency,
  cost, fallback, verification, recovery, and calibration evidence;
- workers issue immutable stage grants and revalidate current breaker
  generations before provider execution, retries, bound executors, commands,
  and file writes;
- global, project, workflow, agent, provider, and tool-class breaker events are
  durable, generation-fenced, fail closed, invalidate affected active leases,
  and require a human-authored re-enable event;
- provenance claims are append-only, scoped to project and tenant, retain
  dependencies/conflicts/permitted use, and recursively become stale or revoked
  when source evidence is revoked;
- guarded transaction receipts and the deterministic fault matrix cover
  interruption, duplicates, stale workers/approvals, retries, partial effects,
  verification failure, and compensation failure;
- promotion candidates bind a frozen baseline, move through receipted approval
  and canary states, use staged rollout thresholds, roll back and quarantine on
  regression, and are protected by the adversarial release gate.

Authority expansion is still forbidden until real-run evidence satisfies the
documented promotion thresholds. The implementation establishes enforcement
and evidence collection; it does not pre-approve greater autonomy.

## Operational calibration evidence

The first live calibration completed a bounded provider-smoke run through
immutable grant issuance and provider-breaker revalidation. A separate scoped
breaker drill proved that changing the breaker generation denies a stale grant,
invalidates affected active leases, and requires a new human-authored enable
generation before work can resume. These results validate the enforcement path;
they are not sufficient by themselves to expand authority. Sustained passing
samples and a human-reviewed promotion canary are still required.

## First implementation slice

Build the Reliability Suite baseline without live model calls:

1. add a versioned schema and synthetic manifest with one case for each of the
   seven representative workflows;
2. extend evaluation result contracts with measured coverage, reviewer burden,
   verification, recovery, intervention, unsafe-attempt, and calibration fields;
3. add a frozen-baseline identity and scrubbed aggregate export contract;
4. create deterministic fixture adapters and hidden acceptance checks;
5. add preview-only authority and breaker receipts so baseline runs can measure
   calibration without granting new authority;
6. require redaction, project isolation, reproducibility, and incomplete-metric
   tests before accepting the baseline.

This slice produces local evidence and contracts only. It does not change
providers, execute live model comparisons, edit shared agents/workflows, enable
automatic promotion, access a network, or expand production authority.
