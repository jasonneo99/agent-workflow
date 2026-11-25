# Queue delivery

Queue history, delivery reliability, and delivery improvements. Combined on 2026-11-25 from three earlier notes, which are kept in [archive/](archive/).

## Withdrawing unsuccessful runs

An explicit human request can remove an unsuccessful run from active queue
views without accepting it or changing its terminal status. Its tasks,
contracts, approvals, artifacts and receipts remain available in history.

The withdrawal API requires the exact project, run, task digest, confirmation,
and a fresh intent scoped to `runtime/withdrawals/<run-id>`. It rejects active
tasks, approvals, reservations and unresolved effects.

Chat-created runs remain bound to their original chat. CLI and scheduled runs
may instead use an operator session and the digest of their actual requester,
requester channel and evaluation metadata. The source origin stays unchanged;
an operator session is not recorded as the run's originating chat. Queue
membership checks the retained origin snapshot before honoring the receipt.

The dashboard's **Archive from active views** action fetches this binding from
the canonical run before invoking the same fenced API. A callback or copied
session identifier is not a human instruction and cannot authorize withdrawal,
execution, replay or acceptance.

## Queue delivery reliability

This document describes implemented source behavior. Admission, recovery activity, and successful model execution do not by themselves prove original acceptance or live product acceptance.

### Discovery and manual changes

[Partner reasoning reservations](../packages/storage/src/queue-partner-reasoning.ts) suppress another read-only discovery reservation for the same source run, task hash, policy hash, and discovery hash. Changed attempt fingerprints or provider failures alone do not bypass this check. Reservations also have a durable lifetime limit of five recovery turns per source run; restarting a watcher does not reset it.

When discovery paths are supplied, reservation checks their read permissions and recomputes their source hash. Write reservations similarly recheck current write permissions and the hash of their exact write paths. Current policy, canonical project location, exact work intent, family activity, overlapping scopes, and capacity are checked before reservation.

A manual change to a file included in the discovery hash changes that binding and can make discovery eligible again, subject to the remaining gates and lifetime budget. An unrelated dirty file outside those paths does not change that hash. For example, editing a scoped `src/worker.ts` can change the discovery input; editing an unrelated `notes.md` does not. A stale caller must refresh its binding before reservation can succeed. These checks cover the supplied paths; they do not prove that every relevant file was discovered or that the whole working tree is clean.

### Live provider admission

[Queue provider readiness](../apps/cli/src/lib/queue-provider-readiness.ts) selects a route for the recovery agent using the standard tier and current project configuration. A mock route is rejected for dispatch. A live route must pass `getProviderReadiness`; an unavailable provider produces a configuration/authentication repair message.

Readiness is admission evidence. The executor still validates its own route, and readiness does not guarantee a later invocation will succeed or establish that the product works live.

### Snapshot freshness

[Queue card snapshots](../apps/cli/src/lib/queue-card-snapshot.ts) coalesce concurrent loads per cache key and return `capturedAt`, `ageMs`, and `refreshing` with each value. Defaults are a 750 ms refresh threshold and a 30 second maximum stale interval.

Within the stale interval, an older snapshot may be returned while a replacement loads, with its age and refresh status exposed. An explicit refresh, missing snapshot, or snapshot older than the stale limit waits for the shared load and returns its result with age zero and `refreshing: false`. Capture time is assigned when loading completes; it is not a guarantee that underlying observations were simultaneous.

Background load failures are observed and later requests can retry. A caller requiring a fresh load receives its failure rather than a successful fresh response containing the old value. Consumers must use the returned freshness metadata when presenting queue state.

### Selected models, cooldown, and fallback

[Provider fallback execution](../packages/model-providers/src/fallback.ts) places the requested provider and `stageInput.modelOverride` first in its candidate list. Each invocation receives that candidate's model override. Fallback candidates can specify their own model; a candidate without one uses the adapter's default selection. Results record the requested and actual providers, actual model when available, whether fallback was used, and attempt outcomes.

Circuits are keyed by provider and model, including a distinct tier-default key. Account-quota failures open the circuit immediately and are not retried on that candidate. Outages and rate limits receive bounded retries and open a circuit at the configured failure threshold. The default cooldown is 60 seconds. Circuit state is persisted by default, so cooldown evidence can survive process restarts. During cooldown the candidate is skipped with its recorded failure kind. After cooldown, an adapter with a health check must pass that probe before execution resumes; successful execution clears the circuit.

After an account-quota failure, fallback requires `allowQuotaFallback`, a candidate marked `fleetApproved`, and a nonempty `dataPolicy`. Merely configuring another provider is insufficient for quota fallback. Authentication and configuration failures stop execution immediately. These gates do not replenish quota, guarantee fallback success, or constitute live product acceptance.

### Optional credit evidence

[Adaptive route evidence](../packages/model-providers/src/adaptive-evidence.ts) requires matching agent/task-class observations no older than 30 days and at least three samples. Candidates must meet quality ≥ 0.7, task success ≥ 0.8, and fallback rate ≤ 0.1 before ranking.

Credit evidence is optional and has a separate five-minute freshness limit. A finite, fresh balance excludes a candidate when it is nonpositive or below its finite recorded `costUsd`. Missing, invalid, future-dated, or stale credit evidence leaves account headroom unknown; it does not establish a positive balance and does not alone exclude a candidate.

For example, a fresh balance of $0.20 with recorded cost of $0.30 excludes the candidate. An old $0.20 observation does not establish current funding. This interface does not imply that all providers expose balances, that balances are collected automatically, or that recorded cost predicts the next invocation exactly.

### Verified recovery yield and queue load

[Resolution metrics](../packages/storage/src/queue-partner-resolution-metrics.ts) summarize up to the latest 500 outcome-journal entries. Only `verified` outcomes count as acceptance gaps closed; `held`, `failed`, and `uncertain` outcomes count as nonresolving turns. The implementation relies on coordinator finalization independently enforcing original acceptance before a verified journal row is valid.

Reports distinguish attempts from observed families and include verified attempt and family rates, first-attempt acceptance with family coverage, and time to verification with duration coverage. Missing denominators or usable durations produce null metrics. Strategy closure counts count verified outcomes, not distinct families; distinct-family measures are reported separately. An absent journal produces an empty summary.

Queue occupancy and recovery dispatch measure load and activity, not verified recovery yield. More attempts, a completed discovery child, or a newly available slot cannot substitute for verified closure. Read-only terminal reconciliation explicitly leaves original acceptance and the consumed recovery budget unchanged.

Adaptive strategy ranking is shadow-only (`applied: false`). Known strategies need at least 20 attempts to enter ranking; promotion eligibility additionally requires two eligible strategies and a Wilson lower-bound lead of at least 0.1. Eligibility does not apply a routing change. This bounded historical window does not prove system-wide success or live product acceptance.

### Validation boundary

The documentation delivery requires the target file to exist, source-supported claims, preservation of unrelated work, and a successful `git diff --check`. The focused queue inventory test supplies additional source-level regression evidence. Neither check establishes installation, deployment, native interaction, or live UI/product acceptance; those remain downstream obligations wherever separately required and authorized.

## Queue delivery improvement program

This program strengthens the maintained v1 runtime. Completion requires live
delivery evidence in addition to source tests. Failed attempts remain in history;
archival does not establish acceptance.

### Required outcomes

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

### Acceptance evidence

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

### Follow-up findings from the architecture review

Review invocation-wide model-call budgets, lease-renewal loss, collision-resistant
lease keys, interrupted Git checkpoint reconciliation, and migration lock scope.
Each finding needs a reproduced case and a bounded patch; it must not generate a
generic recovery wrapper or silently broaden the original deliverable.

### Current implementation and remaining proof

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

### Verified bounded delivery

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
release. Continue provider-specific account-headroom measurement and broader live
delivery cases under the same evidence and policy boundaries.

### Human removal of failed cards

Manual removal uses direct-human withdrawal, separately from generic Partner
dismissal or accepted-replacement archival. The review freezes every currently
visible failed attempt represented by the selected family cards, including task
digests. New arrivals are not swept in; changed tasks or terminal states are
refused. Each attempt requires a fresh exact intent and retains the ordinary
active-work, approval and unresolved-effect checks. Partial success is reported
explicitly. Failed statuses, original contracts, tasks, approvals and evidence
remain unchanged; withdrawal grants no execution or acceptance authority.

The interface shows the number of failed attempts as well as cards. Removing
only the newest attempt must not silently reveal an older failed attempt from
the same reviewed family. Confirmed removal invalidates queue snapshots, and
pre-mutation in-flight loads cannot restore withdrawn cards into the cache.
Database guards, malformed/stale review tests, partial-result tests, and the
actual browser control were exercised. The live removal preserved all sampled
original run, task and approval snapshots, with zero failed cards left visible.

### Prepared authoring and account isolation proof

A second live bounded delivery created the credential-aware availability scope
module, its behavioral tests, and its call-guard integration. Prepared authoring
and the separate independent verifier each ran the exact 24-test collection
with zero skips. Governed integration admitted only the three authorized files.
The 136-record receipt chain verified, all unrelated index entries remained
identical, and manually edited instruction bytes were preserved. This is source
delivery evidence, separately from published-package or fleet adoption.

That delivery exposed an automatic-check ordering defect. An author may declare
a test before creating its file; automatic scheduling now waits for the missing
test input. Explicit baseline requests still run, and independent verifiers do
not defer missing tests. Worker regressions create and execute a real new test,
reject completion without creating it, and retain stale-evidence rejection.
Prepared workers consume runtime-owned work intents instead of invoking nested
host ownership mutations inside their isolated environment.

Account availability keys preserve explicit scope bindings, otherwise fingerprint
applicable configured credentials, and use opaque host/principal isolation when
account identity cannot be determined. Raw credentials and identities are never
stored in these keys; credential files and billing services are not queried.
Unknown account balances remain unknown. Existing provider authorization, model
selection, finite call budgets, probe ownership and independent acceptance gates
remain in force.

Prepared source pipelines also suppress fallback scope-discovery dispatch: an
already compiled source contract with a missing test, environment or enrollment
needs its named readiness prerequisite repaired, not another inferred contract.
Legacy unscoped investigation retains its existing governed path. Manual
withdrawal explains protected active work and unresolved effects with a fixed
public refusal instead of a generic server error; unexpected diagnostics remain
private.

### Next qualification program

The packaged-runtime live cohort now has a passing bounded baseline followed by
bug-fix, library/CLI, refactor, legitimate no-change, and intentional-failure
controls. All five positive deliveries completed with fresh independent source
verification and integration. Forty positive behavioral assertions executed
without skips; the negative control remained blocked after its real check failed.
Candidate/source identities and receipt chains matched, and unrelated staged
manual changes, immutable tests, and policy were preserved in every fixture.
Positive end-to-end durations ranged from 71 to 102 seconds. This establishes
bounded source delivery, not installed/native/product acceptance or fleet rollout.
An earlier fixture-path failure remains separately recorded; its attempts were
not reset or counted as success. The passing cohort needed no outside repairs.

The maintained `scripts/live-development-qualification.mjs` runner requires
explicit execution, a selected built runtime, reviewed schema, an owned output
directory, disposable storage, and frozen per-case requirements. It preserves
full evidence before removing its database and stops the cohort on a mismatch.
Provider-reported cost and catalog estimates remain distinct.

The next five deliverables are packaged release qualification, MCP adoption,
native Studio/fleet verification, the frozen five-case live development
benchmark, and provider-specific credit measurement. Keep their evidence
separate; source version equality alone cannot prove loaded-runtime adoption.

Initial release inspection passed definitions, signature/checksum metadata,
typecheck and package verification. Strict release readiness remains held while
the source branch is ahead of its upstream and the evaluation gate has not run.
The benchmark must preserve the stabilization contract's bug fix, library/CLI,
refactor, legitimate no-change and intentional-negative cases. A machinery fix
ends that cohort instead of silently converting it into a passing one.

The maintained credit collector and account-scoped storage now expose provider
measurements and explicit unknown reasons through `provider-credits`. Collector
and database regressions cover credential scrubbing, endpoint qualification,
response limits, stale overwrite, currency separation and key-cap versus funds.
See [provider credit measurement](provider-credit-measurement.md). Recurring
collection, packaged adoption and the five-case cohort
remain separate qualification work.

Native credit collection now includes the read-only Codex quota meter. Its
subscription usage windows and optional native credit amount are kept distinct
from currency balances. The existing learning daemon has an opt-in bounded
measurement pass with visible heartbeat counts, isolated provider failures and
no additional queue entries. Candidate tests establish these contracts; installed
daemon, MCP, Studio and fleet adoption still require explicit runtime evidence.
