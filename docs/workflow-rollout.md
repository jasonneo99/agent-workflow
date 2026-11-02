# Prepared execution and queue reprocessing

New source runs use a run-owned checkout, declared test environment, tested
candidate checkpoint, separate verifier execution, and trusted source
integration. A required installation policy applies at the common storage
intake, including specialist tasks, dynamic workflows, CLI runs and Partner
children. Older clients cannot insert unprepared runs, and older workers cannot
claim required runs. Historical workflow snapshots and action authorities are
never rewritten.

Read-only workflows retain their stage contracts and cannot write source.
Context and roadmap maintenance retain their own stages and use exact declared
Markdown artifact paths. Both the frozen and current action policies must allow
each path. These tasks use a fenced project intent and ordinary mutation
receipts; they cannot run commands or create source checkpoints. Roadmap
curation still requires its existing explicit approval.
Source workflows retain their original goals; the runtime inserts checkpoint
boundaries, a final verifier and source integration. Partner selects the same
repair/verify/integrate definition. These controls require execution evidence:
model prose, empty collections, skipped tests and truncated output cannot satisfy
the verification gate.

Stored command diagnostics bind to their actual run, task, stage, timestamp and
receipt path. Reading those diagnostics does not require a legacy acceptance
contract. Prepared source receipts may therefore expose their owned output
without an acceptance reference. Acceptance references still require their
original subject binding, and complete stored output does not attest complete
process-stream capture.

## Project configuration

Enable `execution.pipeline.required`, declare `execution.environments`, enable
`execution.repair_commits`, and grant the exact environment and checkpoint
capabilities in action policy. Environment profiles bind source files, language
versions, digest-pinned images or native hosts, dependency setup, readiness
checks, collection contracts and resource limits. Commands still pass action
policy independently. Missing tools or a mismatched target platform block before
model work or host fallback.
Task-scoped tests take precedence. An unscoped source run uses literal tests
from its default profile, or its sole profile when no default is configured;
it never inherits unrelated specialized test commands from other profiles.

Private local installations may add `.agent-workflow/project.local.yaml` with
only `execution` and `actions` configuration. Keep that file ignored. Objects
merge and arrays retain existing entries; the combined configuration must pass
the project schema. Store host-specific profiles and credentials outside the
portable repository. Source snapshots exclude private/generated inputs;
`source_extensions` filters directory traversal, while `source_exclude_paths`
can omit exact files or subtrees such as vendored symlink consumers. Neither
exclusions nor contract patterns grant action authority.

Directory snapshots respect Git ignore rules. Exact `fixture_paths` can include
reviewed nested example project context needed by tests, while root runtime
context, credentials, generated data and symlinks remain excluded. Preparation
never force-adds ignored files to its candidate baseline.

Workspaces snapshot the current declared source without consuming the canonical
index. They retain immutable baseline and source hashes. Project context is
copied only into ignored runtime storage. Governed writes acquire exact source
intents and stop on another owner or changed canonical bytes. Successful
integration publishes only the independently verified delta with a local Git
compare-and-swap commit; unrelated staging is preserved. An already-correct
revision receives a tested checkpoint without an artificial source edit.
The canonical commit records the candidate digest without merging the
preparation snapshot's history.

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
### Approval waits and explicit withdrawal

An executable approval request parks the unfinished stage in a durable
continuation checkpoint. It yields the worker lease, keeps later stages queued,
and appears as **Awaiting approval** with the exact payload and **Approve and
continue**, **Approve only**, and **Reject** controls. Waiting does not count as a
failed or completed stage. Approve-only does not execute or release the stage.
The same stage becomes eligible only after all its exact required approvals have
successful execution receipts. Workers still recheck project policy, source,
intent, and coordinator fences. Executed policy additions supplement the frozen
policy only when their exact audited rules remain in current project policy;
the original snapshot and completed effects are retained. Rejection, expiry, or
failed execution remains an explicit blocker, never success.

Scheduling eligibility timestamps are not activity. Queue ordering uses durable
run, action, approval, and actual stage activity, so prepared or approval-held
work cannot jump above fresh work through a future or infinite schedule.

An explicit originating-chat withdrawal can remove one stopped, unsuccessful
run from active views without accepting it or erasing its history. The exact
project, task digest, origin, direct human instruction, and fresh scoped intent
must match; active work, unresolved approvals, or uncertain effects prevent
withdrawal. This disposition grants no replay or replacement authority and
cannot conceal later active work. Verified historical archival remains separate.

Test authoring is an executor stage under the existing project write scope.
It cannot replace the implementation executor; review-only workflows instead
use a read-only coverage review stage. Authoring precedes the independent
read-only verifier. Prepared workflows create the candidate at the declared
end of each source phase, after its test authoring;
legacy stage-name checkpoint settings cannot commit an unfinished prepared phase.
Changing this template affects new runs only; historical snapshots remain intact.

Prepared source verifiers run the candidate's declared checks in its selected
environment before additional suites. An explicitly required full source suite
remains required. Source verification precedes integration; deployment, launch,
and visible runtime acceptance stay pending until separately executed evidence
proves them. Completing source stages never establishes overall product acceptance.
