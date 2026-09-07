# Executor Adapter Implementation Receipt

- Date: 2026-09-06
- Origin host: Loki
- Scope: first-class remote executor adapter contract and Hulk exact-revision adapter
- Fleet evidence: `fleet-config` commit `4197028a362268a654e2daf9ba9b6cbd168580e0`
- Activation: none; no remote binding, service restart, or deployment performed

## Changes

- Added opt-in project registrations and workflow-stage executor bindings.
- Added immutable run/task executor snapshots with hashes and exact revisions.
- Added fixed two-argument Heimdall invocation, bounded output/timeouts,
  fail-closed behavior, explicit local fallback, idempotent receipt reuse, and
  actual-host artifact reporting.
- Added additive storage migration, schemas, template guidance, tests, CLI and
  dashboard evidence, operator migration, canary, and rollback documentation.

## Verification

- `npm run check`: passed (90 tests).
- Agent Workflow `build-feature` run:
  `5764df7c-58f8-468a-91d3-adacbfa3b691`.
- Run result: 6/6 stages completed, 0 failed, 12 receipts.
- Durable exports remain under `.agent-workflow/exports/` and are intentionally
  excluded from version control.
