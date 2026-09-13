# Source Module Boundaries

The daemon control-plane extraction keeps lane definitions, trust normalization,
effective risk ceilings, and status contracts in `packages/daemon-control/`;
dashboard rendering and request parsing in `apps/cli/src/dashboard/`; and
supervisor process-to-lane reporting in `scripts/supervisor-daemon-lanes.mjs`.
The CLI entry point now composes these contracts instead of owning their logic.

Learning approval queue construction, explicit approval decisions, risk-aware
auto-approval, and application-plan construction live in
`packages/learning-governance/`. CLI and dashboard entry points consume that
shared policy contract so they cannot silently diverge.

Learning report evidence aggregation now lives in `packages/learning-evidence/`:
failed-run selection, repeated-stage failure patterns, routing/cost opportunity
selection, route-feedback grouping, evaluation-gap analysis, and proposal-preview
counts. The CLI remains responsible only for loading storage-backed inputs and
assembling the stable report envelope.

Repository maintenance reports every production source file over 1,000 lines.
Files over 2,000 lines are warnings; files between 1,001 and 2,000 lines are
informational. Size is a review trigger, not an automatic failure: a split must
improve ownership, testing, or reuse instead of distributing one monolith across
arbitrary files.

Run the inventory with:

```bash
npm run repository-maintenance -- -p . --json
```

The command writes the complete result to
`.agent-workflow/learning/repository-maintenance-receipt.json` so daemon and
human maintenance decisions remain visible.

## CLI Boundaries

`apps/cli/src/index.ts` remains the compatibility entrypoint. New work should
put command registration in `apps/cli/src/commands/<domain>.ts`, dashboard-only
presentation in `apps/cli/src/dashboard/`, and reusable behavior in the owning
package under `packages/`. Command modules should depend on package APIs rather
than importing other command modules.

The first extractions moved dashboard styles and icons into the dashboard
module, repository-maintenance and accepted-outcome/threshold-review commands
into command modules, MCP diagnostic redaction into a diagnostic module,
database connection ownership into a storage client module, model-route receipt
construction into a workflow-engine module, and accepted-workflow accounting
into a run-reporter module. Continue by extracting cohesive command and storage
families; avoid a mechanical file-per-function split.

## Current Large-File Inventory

- `apps/cli/src/index.ts`: split command registration by domain, then move
  reusable report and service logic into packages.
- `packages/storage/src/postgres.ts`: split storage implementations by durable
  resource while keeping the public storage contract stable.
- `packages/run-reporter/src/index.ts`: split report builders and formatters by
  report family.
- `apps/mcp/src/index.ts`: split tool definitions and handlers by domain while
  preserving the MCP tool contract.
- `packages/workflow-engine/src/executor.ts`: review stage execution, approval,
  and recovery seams before extracting them.

The generated receipt is the source of truth for line counts because this list
is intentionally descriptive and may become stale as modules move.
