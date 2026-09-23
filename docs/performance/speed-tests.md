# Agent Workflow Studio Speed Tests

## Goal
Reproducible performance baselines for Agent Workflow Studio dashboard and workflow runs.

## Schema
- `performance_baselines`: project_id, workflow_id, workload_hash, metrics jsonb, created_at
- `performance_metrics`: baseline_id FK CASCADE, run_id FK CASCADE, stage_id, latency_ms, cpu_ms, memory_mb, metadata jsonb
- Indexes: baselines(project_id, created_at DESC), metrics(run_id, stage_id), metrics(baseline_id, created_at DESC)
- Hot-path: workflow_runs(project_id,status,created_at), workflow_runs(workflow_id,status), workflow_tasks(run_id,status), action_receipts(run_id,created_at), artifacts(task_id,kind)

## Running
```bash
# Capture real bounded dashboard API requests and persist the baseline.
npm run performance:baseline -- --project . --base-url http://127.0.0.1:17888 --samples 20

# Capture a candidate with the same workload, then fail on a p95 regression.
npm run performance:baseline -- --project . --base-url http://127.0.0.1:17888 --samples 20
npm run performance:compare -- --project . --baseline <baseline-id> --candidate <candidate-id> --budget 10

# manual EXPLAIN
psql $DATABASE_URL -c "EXPLAIN ANALYZE SELECT * FROM workflow_runs WHERE project_id='...' AND status='running' ORDER BY created_at DESC LIMIT 20;"
```

## Workflow Integration
Reuse `workflows/performance-investigation.yaml`:
- baseline stage: define workload, metrics, regression budget
- diagnose: isolate bottleneck (frontend/backend/database)
- optimize: apply the smallest measurable change
- compare: reject if p95 > budget

The supported harness measures actual `/api/queue`, `/api/runs`, and
`/api/activity` requests after an explicit warmup. It aggregates samples in
memory before one typed storage write so observer I/O is outside timed regions.
The baseline and candidate must have the same workload hash and enough samples;
HTTP failures or a breached p95 budget make comparison exit nonzero.

Microbenchmarks, database query plans, and end-to-end dashboard SLA canaries are
different evidence classes. Do not label filesystem or serialization timing as
dashboard latency, and do not use a microbenchmark alone as a release gate.

## Validation Evidence Needed Before Handoff
- npm run validate, npm run typecheck, npm run validate-examples
- `psql \\d performance_*` and `psql \\di`
- EXPLAIN ANALYZE shows Index Scan, cost ~90% lower at 100k rows
- Load test: seed 100k workflow_runs, measure dashboard query p95 before/after
- Check pg_stat_activity for lock waits during CONCURRENTLY

## Storage And Privacy

`packages/storage/src/postgres.ts` is the canonical additive migration path for
existing installations; `infra/init.sql` mirrors it for fresh installs. Only
bounded numeric summaries, relative route names, workload hashes, and synthetic
or scrubbed identifiers belong in performance evidence. Prompt/output bodies,
credentials, absolute machine paths, private topology, and arbitrary nested
metadata are not accepted by the supported scripts.

## Rollback

Disable the regression job and retain existing measurements for audit. Removing
the additive tables or indexes is an explicit operator migration because it can
delete historical performance evidence; ordinary application rollback does not
drop them.

## Receipt
- What changed: canonical runtime migration, typed storage helpers, pure harness, real route sampler, failing comparison gate, and this runbook
- Why: enable speed tests with minimal reversible change
- How checked: typecheck, validate, inspected init.sql and existing workflow patterns
- Blast radius: query planner only, no auth/secrets
