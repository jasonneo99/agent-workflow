# Prepared execution and queue reprocessing

New source runs use a run-owned checkout, declared test environment, tested
candidate checkpoint, separate verifier execution, and trusted source
integration. A required installation policy applies at the common storage
intake, including specialist tasks, dynamic workflows, CLI runs and Partner
children. Older clients cannot insert unprepared runs, and older workers cannot
claim required runs. Historical workflow snapshots and action authorities are
never rewritten.

Read-only workflows retain their stage contracts and cannot write source.
Source workflows retain their original goals; the runtime inserts checkpoint
boundaries, a final verifier and source integration. Partner selects the same
repair/verify/integrate definition. These controls require execution evidence:
model prose, empty collections, skipped tests and truncated output cannot satisfy
the verification gate.

## Project configuration

Enable `execution.pipeline.required`, declare `execution.environments`, enable
`execution.repair_commits`, and grant the exact environment and checkpoint
capabilities in action policy. Environment profiles bind source files, language
versions, digest-pinned images or native hosts, dependency setup, readiness
checks, collection contracts and resource limits. Commands still pass action
policy independently. Missing tools or a mismatched target platform block before
model work or host fallback.

Private local installations may add `.agent-workflow/project.local.yaml` with
only `execution` and `actions` configuration. Keep that file ignored. Objects
merge and arrays retain existing entries; the combined configuration must pass
the project schema. Store host-specific profiles and credentials outside the
portable repository. Source snapshots exclude private/generated inputs;
`source_extensions` filters directory traversal, while `source_exclude_paths`
can omit exact files or subtrees such as vendored symlink consumers. Neither
exclusions nor contract patterns grant action authority.

Workspaces snapshot the current declared source without consuming the canonical
index. They retain immutable baseline and source hashes. Project context is
copied only into ignored runtime storage. Governed writes acquire exact source
intents and stop on another owner or changed canonical bytes. Successful
integration publishes only the independently verified delta with a local Git
compare-and-swap commit; unrelated staging is preserved. An already-correct
revision receives a tested checkpoint without an artificial source edit.

## Preparing existing families

Prepare one fresh entry per original owning family under a new explicit source
grant. Retain its full original task, original run and family identifiers,
canonical project binding, current source manifest, current policy digest and
exact plan hash. Never transfer consumed historical approvals or claim original
installed, native or product acceptance from source verification.

`createWorkflowRun({ prepareOnly: true, ... })` keeps every task unavailable and
stamps `executionPipeline.preparedOnly`. Prepared entries do not occupy working
or verifier capacity. Ordinary resume cannot activate them. Activation requires
a current owning intent and the exact source and policy bindings:

```sh
npm run agentflow -- activate-prepared-run --run RUN_ID \
  --plan-hash PLAN_HASH --owner INTENT_OWNER --fence CURRENT_FENCE
```

Changed source or policy requires a fresh preparation. Activation releases only
that entry to the normal worker; it does not replay an old run, decide an
approval, restart a product service or complete an original acceptance gate.
Installation-wide enforcement is enabled through
`requirePreparedRunPipeline` with a current scoped rollout intent and direct
human authority. Deploy the compatible runtime before enabling that fence.
