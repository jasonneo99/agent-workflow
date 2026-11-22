# Queue delivery improvement program

This program strengthens the maintained v1 runtime. Completion requires live
delivery evidence in addition to source tests. Failed attempts remain in history;
archival does not establish acceptance.

## Required outcomes

1. **Stable discovery.** One discovery reservation per unchanged task, policy,
   and relevant source snapshot. Failure prose must not reset the budget.
   Relevant manual changes may trigger a fresh plan; unrelated dirty files must
   coexist without blocking the queue.
2. **Executable admission.** Check declared write capabilities, exact source
   scope, execution provider, test recipes, environment and ownership before
   reserving work or calling a model. Missing prerequisites must be actionable.
3. **Provider recovery.** Preserve the selected model; classify failures and
   bound retries. Exhausted accounts enter cooldown immediately. Recovery must
   respect approved providers and data policy across processes and restarts.
4. **One delivery card.** Preserve original deliverables as card titles and
   expose attempts within explicit families. Repeated scheduled requests must
   not create competing unresolved deliveries. Similar wording alone is not
   evidence that two requirements are equivalent.
5. **Finish ready candidates.** Reserve verification capacity and prioritize
   sealed candidates and effect reconciliation over new discovery. Verify actual
   outcomes before promoting an adaptive strategy.
6. **Bounded retries and wake conditions.** Preserve lifetime budgets,
   deduplication, current ownership and uncertain-effect holds. Retry an unchanged
   prerequisite only after its recorded wake condition changes.
7. **Measure accepted delivery.** Show verified family and attempt yield
   separately from queue load. Include first-attempt acceptance, unresolved age,
   and measured time/cost coverage. Unknown values remain unknown.
8. **Shared boundaries.** Separate admission, execution, scheduling, acceptance
   and presentation into maintained modules. CLI, MCP, dashboard and workers
   must consume the same decisions and evidence contracts.
9. **Autonomous qualified model switching.** Select among authorized models
   using fresh task-quality, success, latency, cost and account-headroom evidence.
   Fresh insufficient credit excludes a candidate; stale or absent balances do
   not imply funds. Quota responses update availability. Credit does not bypass
   quality gates or authorize another provider's data access.

## Acceptance evidence

- Run positive and negative database tests for stable discovery, changed source,
  ownership, approvals, duplicate admission and finite recovery budgets.
- Exercise prepared workspaces with manual edits and unrelated staged files;
  preserve those bytes and the canonical index during integration.
- Verify provider model preservation, quota cooldown, policy-restricted fallback
  and recovery after availability changes, including separate worker processes.
- Check queue API and rendered cards after archival and explicit refresh.
- Execute real bounded deliveries through preparation, model execution, governed
  effects, fresh independent verification and integration. Inspect the actual
  files, command receipts, source identities and acceptance gaps.
- Record source completion, installed-runtime adoption, interface verification
  and original-deliverable acceptance separately. A review-only completion or a
  simulated provider run cannot establish write-capable delivery acceptance.

## Follow-up findings from the architecture review

Review invocation-wide model-call budgets, lease-renewal loss, collision-resistant
lease keys, interrupted Git checkpoint reconciliation, and migration lock scope.
Each finding needs a reproduced case and a bounded patch; it must not generate a
generic recovery wrapper or silently broaden the original deliverable.

## Current implementation and remaining proof

Source changes cover relevant-source discovery deduplication, provider admission,
fresh explicit queue refreshes, original-outcome titles, selected-model retention,
quota cooldown and qualified credit evidence. Shared provider availability uses
PostgreSQL generations and one expiring recovery probe across workers. A lost or
expired probe cannot reopen an account. Cooldown retains its failure category
across restart, including quota fallback's explicit provider/data-policy checks.
The default availability scope is per adapter; installations with separate
accounts should configure `AGENTFLOW_PROVIDER_ACCOUNT_SCOPE` consistently for
each account. It contains an opaque scope identifier, never a secret.

`AGENTFLOW_STAGE_MODEL_CALL_LIMIT` bounds primary, guide, reread and fallback
calls within a stage invocation (default 64, range 1–256). This does not yet
replace durable family retry budgets or persist an invocation counter across
worker restarts. Fresh optional credit observations inform qualified ranking;
providers without measured balances remain unknown. No universal balance
collector or new paid account is implied.

Recovery metrics distinguish verified families and attempts, first-attempt
acceptance with lifetime ordinals and window coverage, and measured time-to-
verification coverage. These observations describe recovery outcomes, not
universal product acceptance or complete cost accounting. The dashboard reloads
yield with its history refresh. Independent live delivery and installed runtime
verification remain required before marking the program complete.

Live validation exposed two further delivery blockers: a verifier selected the
profile catalog instead of the source-scoped recipe, and frequent activity
refreshes read every historical Partner decision. Maintained fixes give both
prepared stages the same literal checks and restrict queue activity reads to
the canonical queue's exact family members. Historical views retain their
separate scope. Database regressions retain exact receipt equality and reject
unreceipted or foreign observations. Graph refreshes coalesce in-flight reads,
and the queue read restores its checked-out connection's planning settings.

## Verified bounded delivery

A real documentation delivery passed prepared authoring, a separate independent
verifier and governed canonical integration. Both stages executed the selected
46-test behavioral collection with zero skips. Its 98-record receipt chain
verified, the integration contained only the requested document, and every
pre-existing index entry and the manually edited instruction bytes were
preserved. This establishes that bounded source-delivery case, not universal
product or fleet acceptance.

The final full regression run reported 2,193 passes, five skips and no failures.
Those skips remain disclosed and do not count as strict verification evidence.
Installed local worker/dashboard checks are separate from a published package
release. Continue the remaining account-headroom integration and broader live
delivery cases under the same evidence and policy boundaries.
