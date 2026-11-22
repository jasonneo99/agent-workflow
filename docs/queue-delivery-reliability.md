# Queue delivery reliability

This document describes implemented source behavior. Admission, recovery activity, and successful model execution do not by themselves prove original acceptance or live product acceptance.

## Discovery and manual changes

[Partner reasoning reservations](../packages/storage/src/queue-partner-reasoning.ts) suppress another read-only discovery reservation for the same source run, task hash, policy hash, and discovery hash. Changed attempt fingerprints or provider failures alone do not bypass this check. Reservations also have a durable lifetime limit of five recovery turns per source run; restarting a watcher does not reset it.

When discovery paths are supplied, reservation checks their read permissions and recomputes their source hash. Write reservations similarly recheck current write permissions and the hash of their exact write paths. Current policy, canonical project location, exact work intent, family activity, overlapping scopes, and capacity are checked before reservation.

A manual change to a file included in the discovery hash changes that binding and can make discovery eligible again, subject to the remaining gates and lifetime budget. An unrelated dirty file outside those paths does not change that hash. For example, editing a scoped `src/worker.ts` can change the discovery input; editing an unrelated `notes.md` does not. A stale caller must refresh its binding before reservation can succeed. These checks cover the supplied paths; they do not prove that every relevant file was discovered or that the whole working tree is clean.

## Live provider admission

[Queue provider readiness](../apps/cli/src/lib/queue-provider-readiness.ts) selects a route for the recovery agent using the standard tier and current project configuration. A mock route is rejected for dispatch. A live route must pass `getProviderReadiness`; an unavailable provider produces a configuration/authentication repair message.

Readiness is admission evidence. The executor still validates its own route, and readiness does not guarantee a later invocation will succeed or establish that the product works live.

## Snapshot freshness

[Queue card snapshots](../apps/cli/src/lib/queue-card-snapshot.ts) coalesce concurrent loads per cache key and return `capturedAt`, `ageMs`, and `refreshing` with each value. Defaults are a 750 ms refresh threshold and a 30 second maximum stale interval.

Within the stale interval, an older snapshot may be returned while a replacement loads, with its age and refresh status exposed. An explicit refresh, missing snapshot, or snapshot older than the stale limit waits for the shared load and returns its result with age zero and `refreshing: false`. Capture time is assigned when loading completes; it is not a guarantee that underlying observations were simultaneous.

Background load failures are observed and later requests can retry. A caller requiring a fresh load receives its failure rather than a successful fresh response containing the old value. Consumers must use the returned freshness metadata when presenting queue state.

## Selected models, cooldown, and fallback

[Provider fallback execution](../packages/model-providers/src/fallback.ts) places the requested provider and `stageInput.modelOverride` first in its candidate list. Each invocation receives that candidate's model override. Fallback candidates can specify their own model; a candidate without one uses the adapter's default selection. Results record the requested and actual providers, actual model when available, whether fallback was used, and attempt outcomes.

Circuits are keyed by provider and model, including a distinct tier-default key. Account-quota failures open the circuit immediately and are not retried on that candidate. Outages and rate limits receive bounded retries and open a circuit at the configured failure threshold. The default cooldown is 60 seconds. Circuit state is persisted by default, so cooldown evidence can survive process restarts. During cooldown the candidate is skipped with its recorded failure kind. After cooldown, an adapter with a health check must pass that probe before execution resumes; successful execution clears the circuit.

After an account-quota failure, fallback requires `allowQuotaFallback`, a candidate marked `fleetApproved`, and a nonempty `dataPolicy`. Merely configuring another provider is insufficient for quota fallback. Authentication and configuration failures stop execution immediately. These gates do not replenish quota, guarantee fallback success, or constitute live product acceptance.

## Optional credit evidence

[Adaptive route evidence](../packages/model-providers/src/adaptive-evidence.ts) requires matching agent/task-class observations no older than 30 days and at least three samples. Candidates must meet quality ≥ 0.7, task success ≥ 0.8, and fallback rate ≤ 0.1 before ranking.

Credit evidence is optional and has a separate five-minute freshness limit. A finite, fresh balance excludes a candidate when it is nonpositive or below its finite recorded `costUsd`. Missing, invalid, future-dated, or stale credit evidence leaves account headroom unknown; it does not establish a positive balance and does not alone exclude a candidate.

For example, a fresh balance of $0.20 with recorded cost of $0.30 excludes the candidate. An old $0.20 observation does not establish current funding. This interface does not imply that all providers expose balances, that balances are collected automatically, or that recorded cost predicts the next invocation exactly.

## Verified recovery yield and queue load

[Resolution metrics](../packages/storage/src/queue-partner-resolution-metrics.ts) summarize up to the latest 500 outcome-journal entries. Only `verified` outcomes count as acceptance gaps closed; `held`, `failed`, and `uncertain` outcomes count as nonresolving turns. The implementation relies on coordinator finalization independently enforcing original acceptance before a verified journal row is valid.

Reports distinguish attempts from observed families and include verified attempt and family rates, first-attempt acceptance with family coverage, and time to verification with duration coverage. Missing denominators or usable durations produce null metrics. Strategy closure counts count verified outcomes, not distinct families; distinct-family measures are reported separately. An absent journal produces an empty summary.

Queue occupancy and recovery dispatch measure load and activity, not verified recovery yield. More attempts, a completed discovery child, or a newly available slot cannot substitute for verified closure. Read-only terminal reconciliation explicitly leaves original acceptance and the consumed recovery budget unchanged.

Adaptive strategy ranking is shadow-only (`applied: false`). Known strategies need at least 20 attempts to enter ranking; promotion eligibility additionally requires two eligible strategies and a Wilson lower-bound lead of at least 0.1. Eligibility does not apply a routing change. This bounded historical window does not prove system-wide success or live product acceptance.

## Validation boundary

The documentation delivery requires the target file to exist, source-supported claims, preservation of unrelated work, and a successful `git diff --check`. The focused queue inventory test supplies additional source-level regression evidence. Neither check establishes installation, deployment, native interaction, or live UI/product acceptance; those remain downstream obligations wherever separately required and authorized.
