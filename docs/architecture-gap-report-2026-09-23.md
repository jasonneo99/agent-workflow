# Architecture Gap Report — 2026-09-23

## Scope

This pass reviewed the current `master` delta, the uncommitted performance-testing work produced during the Muse session, and the learning-daemon architecture requested for recurring public training discovery. It did not delete, rewrite, or commit the existing Muse work.

## Aligned architecture

- The learning daemon remains the owner of recurring learning work. Training discovery is now a named, read-only `training-scout` lane rather than a separate Codex automation.
- Training discovery inventories the registered agent roster and daemon lanes, rotates bounded coverage, reads only a curated set of public official sources, hashes evidence for deterministic deduplication, emits source-health failures, and writes proposal reports without modifying prompts, policies, tools, provider routes, or code.
- The default cadence is daily (`86,400,000` ms), configurable through `AGENTFLOW_TRAINING_DISCOVERY_INTERVAL_MS`; `agentflow training-discovery --project <dir> --force` provides the manual path.
- In all-project mode, the control project owns the fleet-wide scout pass so the same official sources are not fetched once per registered project.
- The daemon heartbeat now reports discovery status, last run, next due time, proposal count, and errors.
- The current tracked code passes type checking, the open-source-boundary check, and the full test suite after the training-scout integration.

## Gap closure status

All eleven gaps identified by this pass are closed in the current working tree.
The sections below retain the original finding and record the implemented root
fix so future reviews can verify the architecture rather than rediscover it.

### G1 — Performance work has two incompatible persistence models (high)

The Muse work defines both `performance_baselines` / `performance_metrics` and `performance_test_runs` / `performance_test_metrics`. It also supplies two migration families and two storage adapters. They describe different identities, units, and lifecycle semantics, so adopting both would create ambiguous sources of truth.

Resolution: the typed `packages/storage/src/performance.ts` baseline/metric model is canonical; the parallel adapter, tables, and migrations were removed.

### G2 — The claimed speed tests do not measure the named production paths (high)

The Studio harness currently times filesystem reads, directory listings, object serialization, and synchronous JSONL appends. Labels such as `agentflow_status_list_latency_ms`, `workflow_transition_observer_ms`, and `index_project_probe_ms` overstate what is actually measured. The generated report therefore cannot support claims about dashboard, queue, transition, or indexing performance.

Resolution: `scripts/performance-baseline.ts` now measures bounded real dashboard API requests after explicit warmup and persists sample count, route, failures, and workload identity.

### G3 — The regression comparison command always passes (high)

`scripts/perf-compare.mjs` is a placeholder that does not load a baseline, calculate a percentile delta, or return failure when the configured budget is exceeded. It cannot serve as a CI or release gate.

Resolution: `scripts/performance-compare.ts` loads immutable baseline/candidate sets, checks workload identity and sample sufficiency, rejects failures, compares p95, and exits nonzero when evidence or budget fails.

### G4 — Migration ownership and packaging are unresolved (high)

The repository's runtime migration path is not shown consuming `infra/migrations/`, while the npm package includes `migrations/` rather than `infra/migrations/`. Fresh-install SQL was edited, but existing installations may never receive these migrations. The dated and numbered migrations also overlap in purpose.

Resolution: the additive schema and indexes live in canonical `migrateStorage()` and are mirrored by `infra/init.sql`; the unused migration family was removed and storage tests cover both paths.

### G5 — Performance evidence scrubbing is shallow and inconsistent (medium)

`infra/perf-store.ts` filters selected top-level metadata keys and strings containing `@`, but metric labels are written without scrubbing and nested values are not inspected. The adapter also derives storage from `process.cwd()`, which weakens project isolation.

Resolution: the supported scripts accept only fixed relative route labels and bounded numeric summaries; the arbitrary metadata adapter was removed, eliminating the shallow scrub path and implicit working-directory storage.

### G6 — The observer changes the measurement substantially (medium)

Every metric is synchronously appended to disk. The throughput loop writes 1,000 records while timing itself, so the observer cost dominates the measured result and `recordMetric_throughput_ops` is stored in a field presented as milliseconds.

Resolution: the pure harness buffers samples in memory, keeps latency units explicit, summarizes after measurement, and performs one injected sink write outside the timed request loop.

### G7 — Package layering and adoption are incomplete (medium)

`packages/perf-harness` imports an adapter from top-level `infra/`, has its own package manifest but is not integrated as a workspace or root script, and is not used by the Studio script. The typed storage helper is likewise not exported through an established package boundary.

Resolution: `packages/perf-harness` is pure with an injected sink, durable persistence remains in `packages/storage`, and root `performance:baseline` / `performance:compare` commands are the supported interface.

### G8 — Performance documentation conflicts (medium)

Three documents describe different schemas, commands, and meanings for “speed tests.” One calls directory reads and JSON serialization Studio latency, while another requires PostgreSQL `EXPLAIN ANALYZE` and large fixtures.

Resolution: duplicate performance documents and placeholder scripts were removed; `docs/performance/speed-tests.md` is the canonical runbook and separates microbenchmarks, query plans, and route/SLA evidence.

### G9 — Training discovery is a curated official-source watcher, not open-ended web search (medium)

The implemented scout safely monitors a bounded official catalog. It does not yet query a general search index, discover previously unknown domains, validate robots metadata, or automatically determine publication dates and license changes. This is an intentional fail-closed first slice, not completion of the entire roadmap contract.

Resolution: discovery now supports a versioned project-local official-source registry with an explicit domain allowlist, HTTPS enforcement, robots handling, rate limiting, fetch-size/time budgets, source hashes, and prompt-injection quarantine tests. Unknown-domain open crawling remains intentionally out of scope because it would weaken the declared trust boundary.

### G10 — Training proposals are not yet integrated into a dedicated dashboard inbox (medium)

The daemon writes JSON and Markdown reports and exposes heartbeat counts, but there is no first-class proposal lifecycle for approve, reject, stale, unsafe, evaluated, and promoted states. Training proposals must not be mixed directly into executable learning actions until that governance surface exists.

Resolution: a versioned proposal inbox now exposes pending/approved/rejected/stale/unsafe/evaluated/promoted lifecycle states through CLI, JSON API, and `/training-proposals`; approvals authorize evaluation only and never mutate prompts directly.

### G11 — Generated training report history needs a formal retention contract (low)

The scout maintains content hashes and a current report, but it does not yet publish an immutable bounded history or expiry policy. A current report alone is insufficient to audit why a changed source reappeared months later.

Resolution: source revisions are archived as compact reports, proposal and decision receipts are keyed by source/content hash, raw downloads are not retained, and the local receipt log is bounded to 500 entries.

## Suggested implementation order

1. Resolve the single canonical performance schema and migration path (G1, G4).
2. Replace proxy/placeholder measurements with real workload execution and a failing regression gate (G2, G3, G6).
3. Consolidate adapters, package boundaries, privacy controls, and documentation (G5, G7, G8).
4. Add the governed training-proposal schema and dashboard inbox (G10, G11).
5. Add a bounded provider-neutral search adapter only after injection, robots, license, and citation holdouts pass (G9).

## Verification performed

- `npm run validate`
- `npm run validate-boundary`
- `npm run typecheck`
- `npm test` — 523 passed, 0 failed, 1 skipped
- `npm run training-discovery -- --project . --force --json` — completed, 34 roster entries inventoried, 4 relevant official sources scanned, 0 source errors
