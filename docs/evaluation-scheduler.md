# Evaluation scheduler contract

The scheduler discovers valid evaluation YAML files in the project's
`.agent-workflow/evaluations/` directory, filtered by `suite_glob`. A suite is due
when it has no matching report or its newest report is older than
`interval_hours`. Its declared `id`, not the filename, identifies reports and
the evaluation metadata written by the existing `evaluate` command.

## Dashboard readiness reconciliation

The `/evaluations` route in `apps/cli/src/commands/daemon.ts` loads two distinct
inputs: `loadDashboardEvaluations()` and provider statuses. Its renderer labels
**provider** availability as `ready` in the Provider coverage table. It does not
expose a separate suite-ready queue. The suite list contains historical runs,
not pending YAML definitions.

`loadDashboardEvaluations` in `apps/cli/src/lib/builders-learning.ts` groups stored
workflow runs by `evaluationMetadata.suiteId`. The `evaluate` command in
`apps/cli/src/commands/runs.ts` supplies that same declared suite ID for every
case/variant. Therefore the scheduler feeds the existing dashboard through the
existing evaluator; it does not consume provider readiness as a queue state.
Provider availability is checked by the evaluator before execution. No new
`status: ready` field or separate queue policy is introduced.

## Verification and activation boundaries

`npm test` creates a uniquely named disposable database using
`scripts/test-isolated.ts`, initializes and migrates only that database, and
supplies its URL to all test children. It verifies the database identity before
initialization and drops only that invocation's exact generated database in
cleanup. Creation requires CREATEDB on the existing PostgreSQL server; failure
stops the suite without falling back to the runtime database. No service is
started or restarted. Abrupt SIGKILL may leave a clearly named test database for
operator cleanup; normal completion, test failure, SIGINT and SIGTERM use cleanup.

The harness loads only the repository's database configuration through
`scripts/test-environment.mjs`. Explicit `TEST_DATABASE_URL` takes precedence,
then an existing `DATABASE_URL`; otherwise the local project environment and
runtime override are consulted. The worker still strips its own database URL
from arbitrary project commands. This bootstrap does not start services,
migrate databases, or import other runtime credentials. The isolated harness
performs initialization only in its newly created disposable database. Database integration
tests must maintain their own isolated fixtures.

Run scheduler tests explicitly as well: they live outside the normal packages
and apps test globs. Passing source tests and packaging checks does not install
or activate the scheduler. Live activation remains a separate operator action.
