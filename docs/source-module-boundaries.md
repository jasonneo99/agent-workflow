# Source Module Boundaries

Repository maintenance reports every production source file over 1,000 lines.
Files over 2,000 lines are warnings; files between 1,001 and 2,000 lines are
informational. Size is a review trigger, not an automatic failure: a split must
improve ownership, testing, or reuse instead of distributing one monolith across
arbitrary files.

Run the inventory with:

```bash
npm run repository-maintenance -- -p . --json
npm run repository-maintenance -- -p . --check
```

The command writes the complete result to
`.agent-workflow/learning/repository-maintenance-receipt.json` so daemon and
human maintenance decisions remain visible.

`repository-maintenance-baseline.json` is a ratchet for the known large files.
The `--check` mode fails only when one grows beyond its committed baseline;
successful extractions lower the baseline. This prevents new concentration
without requiring an unsafe all-at-once rewrite.

## CLI Boundaries

`apps/cli/src/index.ts` remains the compatibility entrypoint. New work should
put command registration in `apps/cli/src/commands/<domain>.ts`, dashboard-only
presentation in `apps/cli/src/dashboard/`, and reusable behavior in the owning
package under `packages/`. Command modules should depend on package APIs rather
than importing other command modules.

The current extractions place Context Gateway reporting/calibration and
accepted-outcome/threshold-review registration in CLI command modules; MCP
threshold and accepted-outcome registration in domain tool modules; database
connection and project-index ownership in storage modules; tuning history and
accepted-workflow accounting in run-reporter modules; and model-route plus
action/ReAct receipt construction in workflow-engine modules. Continue by
extracting cohesive families; avoid a mechanical file-per-function split.

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
