# Outcome Accuracy And Provider Fallback Contracts

## Feature summary

Outcome Accuracy distinguishes a workflow that reached a terminal state from a
workflow that produced the result the operator actually expected. It combines
reviewed feedback, first-pass success, fallback use, heuristic quality, and
stage-specific latency budgets into one evidence surface.

The accompanying provider fallback contract prevents two opposite errors:

- reporting an incomplete or unsafe result as successful merely because a
  provider returned valid JSON; and
- blocking a useful analytical answer merely because it contains policy
  judgment that a model describes as requiring approval.

The feature is local-first, provider-portable, and compatible with immutable
run history. It changes the interpretation and scoring of new outputs; it does
not rewrite earlier run records.

## Problem

Lifecycle state and result quality answer different questions:

- **Completion:** Did every required workflow stage reach a terminal completed
  state?
- **Expected result:** Did the completed work satisfy the operator's acceptance
  contract?
- **Quality:** Was the response concrete, evidence-backed, and actionable?

Previously, a structurally complete response could earn a high heuristic score
even when its lifecycle outcome was `blocked`. Conversely, a local model could
turn a read-only policy-analysis question into an unnecessary approval blocker.
Both behaviors distorted provider comparisons and could send routing
optimization in the wrong direction.

## User experience

The Model Improvements dashboard includes an **Outcome Accuracy** section with:

- lifecycle completion rate;
- accepted expected-result rate;
- feedback coverage;
- accepted first-pass rate;
- high-quality responses later marked revised or rejected;
- runs that required provider fallback; and
- per-route calibrated quality and latency-budget status.

Operators can therefore see when a workflow is technically healthy but still
producing results that need revision. Combinations without enough feedback are
explicitly marked as needing evidence rather than silently treated as good.

## Provider fallback decision contract

A fallback result may be accepted only when all of the following remain true:

1. The fallback preserves the original task and stage acceptance contract.
2. Required safety, authority, policy, and evidence boundaries are unchanged.
3. The response is structurally valid and passes the applicable quality gate.
4. Required actions, verification, and artifacts were actually completed or
   are represented as governed requested actions.
5. The run records the attempted and actual provider, fallback use, latency,
   usage, and quality evidence.

The run must remain failed or blocked when:

- the fallback lacks required context or capabilities;
- it would bypass approval, policy, trust, or provider restrictions;
- required external authority, credentials, dependencies, or protected
  resources remain unavailable;
- a delivery stage lacks required product-write or verification evidence; or
- the fallback response cannot meet the original acceptance contract.

## Analytical policy questions

Read-only requests to define, explain, compare, classify, or recommend policy
are analytical work. They complete when the requested decision and evidence
boundaries are returned. The presence of judgment is not itself an approval
boundary.

For `provider-smoke`, a model-generated blocker is reclassified as a finding
when it only says that policy criteria or decision-making cannot be automated.
Concrete production approvals, permissions, credentials, provider outages,
network failures, and external dependencies remain real blockers.

## Lifecycle-aware quality scoring

Heuristic response quality no longer overrides lifecycle truth:

- a `blocked` output cannot pass the quality gate;
- its heuristic score is capped below the normal passing threshold;
- the score records that the blocked lifecycle did not satisfy the expected
  result; and
- retry remains recommended where the provider or workflow can safely recover.

Reviewed feedback receives more weight than unreviewed heuristic quality when
the dashboard calculates calibrated quality. This prevents polished but wrong
answers from dominating routing recommendations.

## Routing and latency

Provider-smoke routing has an independent candidate order controlled by:

```env
AGENTFLOW_SMOKE_PROVIDERS=openai,anthropic,gemini,codex-cli,local
```

Every candidate still passes readiness checks. The default prioritizes the
historically reliable fast hosted routes, then Codex CLI and local execution,
without changing delivery-workflow routing.

Latency budgets are stage-specific. Provider smoke and triage use a tighter
budget than implementation, reasoning, or finalization stages. Breaches are
reported as evidence and do not silently change policy or provider settings.

## Evaluation

The local outcome-contract holdout covers:

1. inspection-only work;
2. implementation delivery;
3. failed-verification repair;
4. superseded-run handling;
5. reversible migration planning;
6. final review packaging; and
7. provider fallback boundaries.

The suite compares configured providers and model tiers on pass rate, quality,
latency, and fallback rate. Project-local prompts and generated reports remain
under ignored `.agent-workflow/evaluations/` storage.

## Acceptance criteria

The feature is accepted when:

- completion and expected-result accuracy are reported separately;
- accepted, revised, and rejected feedback affects calibrated quality;
- feedback coverage and missing outcome evidence are visible;
- a judgment-only provider-smoke response completes as an analytical finding;
- a concrete external approval or dependency still blocks;
- blocked lifecycle output cannot receive a passing quality score;
- provider attempts and fallback decisions remain receipted;
- local evaluation artifacts stay outside the open-source repository boundary;
  and
- focused tests, type checking, repository boundary validation, and the source
  size ratchet pass.

## Non-goals

- Automatically approving production or high-risk actions.
- Rewriting immutable historical runs after scoring logic changes.
- Treating heuristic quality as a replacement for human feedback.
- Promoting a provider from one successful sample.
- Exporting private prompts, project context, or evaluation evidence.

## Operational guidance

- Use the dashboard's Outcome Accuracy cards to locate high-completion,
  low-acceptance combinations.
- Collect feedback before changing routing for a thinly sampled combination.
- Re-run the applicable local holdout after prompt, policy, provider, or scoring
  changes.
- Preserve failed and blocked historical runs as evidence; create a replacement
  run when verifying a repair.
- Treat latency, fallback, and quality as separate signals instead of optimizing
  one at the expense of the acceptance contract.
