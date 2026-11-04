# V1 stabilization

The objective is verified completion of bounded coding tasks through the existing
pipeline without a separate chat repairing its machinery. Codex CLI is the
preferred executor for this qualification; provider-neutral contracts remain.
V2 is retired from active development and retained as a learning experiment.
The [v1 improvement plan](v1-improvement-plan.md) records the current direction.
This work preserves Studio, existing services,
operational data, unrelated source work and immutable run history.

## Starting evidence

The clean local source baseline preserves reviewed pending changes and branch
history. Its full test suite passed 1,975 tests with five explicit skips. The
aggregate repository check remained failed on four pre-existing file-size
regressions. Their ceilings remain 2,120 lines for the MCP entry point, 3,836 for
storage, 2,522 for reporting and 1,802 for the workflow executor.

The verifier-context fix carries the exact candidate revision, source and recipe
hashes, selected environment and required checks separately from truncated prior
artifacts. The packaged engine was refreshed to include that behavior while
preserving dependency bytes. Neither source validation nor archive refresh proves
that a running worker has loaded the change. Live provider, optional PostgreSQL
controls and original-task acceptance remain separate evidence requirements.

Raw runtime identities, private paths, database fixture names and operational
receipts stay in ignored local notes. The portable historical failure mechanisms
are unsupported completion, pre-edit verification, unconsumed tool results,
acceptance scope drift, interrupted execution and conflicting ownership.
Their present frequency and live causality require current reproduction.

## Qualified source repairs

Mutation-batch recovery now retains unvisited writes and dependent commands
after a successful local patch correction. Verification requires the current
batch's successful mutations, including repeated paths; earlier observations
cannot satisfy a new failed write. Explicit replanning and blocked output keep
their existing meaning. Actual-worker regressions exercise the failed-patch
sequence and require all source writes before the behavioral check.

Prepared Git inspection recognizes a narrow read-only `diff-tree` form with
external helpers disabled. Prepared source recovery also distinguishes fresh
full-graph retry from checkpoint preservation: unsupported source checkpoint
reuse is held before recovery writes, and replacement acceptance needs fresh
run-owned evidence. Structured and physical recovery gates remain independent.
These source controls require runtime adoption and a new project-task trial;
unit checks alone do not establish unattended operation.

Explicit historical-run withdrawal remains view-only. A rejected pre-write
reservation settles the visibility hold only when its exact no-effect
disposition has a durable matching receipt; unresolved effects remain visible.

The four inherited size failures are cleared through module extraction without
raising ceilings. The aggregate check after extraction passed 1,986 tests with
five unchanged skips. Subsequent behavior changes require a new combined check.

Reproduced ownership defects now have regression controls: an old worker cannot
release a newer claim, reclaiming with the same worker advances the task's own
generation independently of the run epoch, and expiry recovery preserves a live
sibling's lease. Completion and approval waits use the locked run epoch while
task receipts retain the task generation. All claiming workers must adopt the
new source together; mixed old and new claim writers remain unsupported.

Codex children receive a minimal environment. Restricted executions use fresh
sessions, a neutral directory, a qualified CLI version and controller-owned
actions. Native command execution and delegation are disabled. Cancellation
escalates an unresponsive owned child after a bounded grace period and cannot
turn a forced stop into success. This establishes neither general descendant
cleanup nor qualification on every operating system. Runtime adoption and live
workflow delivery remain separate milestones.

Timed-out environment builds request removal of intermediate containers.
Preparation failures retain the underlying timeout, signal and bounded output
from both process streams, so a warning cannot conceal the failure. Regression
controls cover failed preparation without task execution; an owned real build
timeout separately verifies automatic intermediate-container removal.

Reused command results retain the original declared collection, environment
binding and truncation facts. Duplicate suppression must not discard passing
verification evidence or convert failed, missing or truncated evidence into a
pass. The original command receipt and source-sensitive identity stay authoritative.
Fresh command results also identify their action type explicitly, so unchanged-
revision validation can recognize executed checks and validate their receipts.

Saved command output alone does not authorize recovery. Reuse requires a completed
durable side-effect receipt matching the exact command, artifact and outcome,
with the original run, task and stage ownership intact. Pending, uncertain,
missing or mismatched receipts hold the task without repeating the command.
Crash-window controls distinguish output saved before finalization from a
finalized observation recovered before its stage checkpoint.

Each successful governed write refreshes its cached source observation before
another command, mutation retry or provider turn can bypass that refresh.
Combined write-and-check requests must expose the applied postimage and executed
check together. Completion still requires consuming new results, current-source
checks, the candidate checkpoint and fresh independent verification.

## Repair order

1. Extract cohesive modules to clear the inherited source-size failures. Preserve
   public entry points, policy checks, SQL, budgets, idempotency, receipt content
   and effect ordering. Verify extraction separately from behavior changes.
2. Reproduce stale worker release against a newer task owner. Replace the
   worker's run-wide release with exact task, run, worker and fence validation.
   Preserve the separately governed operator recovery API and sibling tasks.
3. Qualify durable result observation, interrupted-executor recovery and repair
   deduplication. Completed effects must retain their receipts; unavailable
   evidence inhibits further effects rather than authorizing a duplicate.
4. Demonstrate the existing implementation, candidate checkpoint, fresh verifier
   and governed integration path using an explicitly pinned Codex route.
   Preserve required checks and expose missing authority through existing gates.
5. Reconcile obsolete active views only after equivalent accepted replacement
   work and the exact human-authorized scope are established. Archival changes
   visibility, never historical execution or acceptance.

## Qualification contract

Use separately owned fixture projects, finite task budgets and disposable test
storage. Pin the reviewed source/build, provider/model, workflow, environment
recipe, checks and task set before a cohort. Disable fallback and unrelated
claims for the explicitly selected qualification worker. Existing credentials
remain outside task content and untrusted tool environments.

First complete one bounded coding task with executed candidate-bound checks and
fresh independent verification. Then run the fixed five-case suite covering a
bug fix, library plus CLI change, refactor, legitimate no-change result and an
intentional failing check. The negative check must remain failed. Finally run
ten additional bounded coding tasks against their frozen expected outcomes.

Every case records the actual source and candidate identity, provider/model,
commands and complete check results, attempts, duration, measured usage, cleanup
and interventions. Cost remains unknown when the provider does not report it.
Approval waits, model errors, incorrect solutions and machinery failures remain
separate classifications. A passing cohort requires its expected outcomes,
zero outside machinery repairs and zero false completions. Investigations and
changes end the current cohort; preserve it before starting a newly identified
cohort. Never reset consumed attempts or quietly replace a failed run.

Retain positive and negative controls for stale ownership, sibling isolation,
final-write verification freshness, receipt reuse, bounded continuation,
interruption/cancellation and duplicate repair admission. Component coverage,
source checks, live provider qualification, installed runtime adoption and
original product acceptance are reported separately.

See the [repair commit process](repair-commit-process.md),
[reliability control plane](reliability-control-plane.md) and
[root-repair playbook](workflow-root-repair-playbook.md).
