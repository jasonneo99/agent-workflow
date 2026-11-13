# Repair commit checkpoints

Required source pipelines perform these phases automatically and finish with
trusted canonical source integration. An unchanged revision still requires
executed tests and a fresh independent verifier, but needs no artificial edit.
See [prepared execution](workflow-rollout.md) for installation enforcement and
existing-family preparation.

A repair phase produces a source candidate with a durable revision. Independent
verification checks that exact revision in a fresh environment. Failed attempts
remain history; a candidate commit is never product acceptance.

## Mutation batches and recovery

When a rejected patch is corrected locally, the worker retains the ordered
mutations that have not run and the commands waiting on that batch. Every
mutation still passes its own authority, policy and preimage checks. Explicit
blocked responses and replacement plans do not revive abandoned mutations.
Verification waits for successful observations of every requested mutation in
the current action round; an earlier write to the same path is not a substitute.

Prepared source checkpoint receipts belong to their original workspace. A
replacement run cannot preserve a completed source stage by copying its output
JSON. Explicit checkpoint-preserving recovery is held before recovery writes
when those workspace bindings cannot be restored. Attested read-only planning
prefixes can still be preserved when they contain no source or command effects.

Ordinary source-only retries use a fresh full graph and record the requested
and effective recovery modes. Original checkpoints remain diagnostic history;
the replacement needs its own source, tests and independent verification.
Structured product requirements and physical or delivery recovery are not
silently converted into fresh source-only retries. The notification identifies
fresh replay separately from checkpoint preservation.

Prepared source inspection supports the exact read-only form
`git diff-tree --no-commit-id --name-status -r <commit>`, where the commit is
`HEAD` or a full object ID. The executor disables external diff and text
conversion helpers. Additional options, output files, configuration overrides
and mutations remain outside that inspection capability; project command
permission is still required.

## Phase sequence

1. Start from a clean isolated worktree and record its parent commit. Acquire the
   owning project's scoped work intent before implementation.
2. Repair only the run-owned source and tests. Prepare the declared per-run
   environment and run the actual tests with complete collection and zero skips.
3. Check the original parent, current source hashes, exact changed-file list,
   project write policy and passing environment receipt. Create a candidate
   commit that records the run, environment recipe and validation receipt hash.
4. Release implementation ownership. An independent verifier uses a clean
   checkout at that exact commit and a new instance of the frozen environment.
5. Record source verification only when the fresh test receipt matches the
   candidate source, environment and image. Continue the original installed,
   deployment, hardware and human acceptance gates separately.
6. If verification finds a defect, append a new repair commit and verification
   receipt. Preserve the rejected candidate and failed evidence. Never amend,
   reset, squash, rewrite a terminal attempt, or silently change its baseline.

Documentation or packaging changes after verification create another candidate
revision and require the relevant checks again. A later failing check supersedes
an earlier pass. Commit subjects should name the concrete repair; trailers retain
machine-readable evidence without embedding private runtime details in source.

## Enable automatic candidate commits

Merge this opt-in fragment into the owning project's existing configuration:

```yaml
execution:
  repair_commits:
    enabled: true
    stages: [implement, repair]
actions:
  allowed_commands:
    - npm run agentflow -- repair-checkpoint *
```

The worker pins a clean parent before a selected stage invokes its agent. At
completion it uses only the run's durable write footprint and a current passing
environment test receipt. Dirty unrelated files, an already staged index,
changed parents, missing evidence or changed source hold the stage. Existing
projects do not gain commit authority by installing the feature.

Partner uses `repair-blocked-item` for projects that enable this capability. Its
`repair` stage creates the candidate automatically and its read-only `verify`
stage tests that exact commit in a fresh instance of the declared environment.
The worker schedules missing declared candidate test commands through ordinary
action policy even when the verifier returns only a review. An observed test is
never scheduled again automatically, including a failed test.
The selected implementation specialist replaces only the repair-stage agent.
Partner checks both stages' environment selectors, the behavioral recipe and
the clean checkout before reserving an attempt. Missing profiles or a dirty
shared checkout produce a preparation hold rather than consuming another turn.
The pipeline occupies one item inside the shared capacity limit and reserves
the single verifier slot until the assignment finishes or is reconciled.
Use a scoped isolated checkout for accumulated work; this policy never cleans,
adopts, or commits another owner's changes automatically.

Projects without this explicit capability retain their existing workflow.
Native, device, deployment and human acceptance still require their own matching
environment and authority; a container source pass does not satisfy those gates.

Independent verifier stages consume the candidate in the preceding stage's
artifact and require their own fresh test receipt before reporting source
verification. The commit and verifier records become normal run action artifacts.

## Manual preview and execution

```bash
npm run agentflow -- repair-checkpoint --project templates/project --run example-repair --parent <exact-parent> --files src/example.ts,tests/example.test.ts --evidence .agent-workflow/runtime/run-environments/example-repair/tests/receipts/<attempt>.json
npm run agentflow -- repair-checkpoint --project templates/project --run example-repair --parent <exact-parent> --files src/example.ts,tests/example.test.ts --evidence .agent-workflow/runtime/run-environments/example-repair/tests/receipts/<attempt>.json --execute
npm run agentflow -- repair-checkpoint --project templates/project --verify .agent-workflow/runtime/repair-checkpoints/<candidate>.json --evidence .agent-workflow/runtime/run-environments/example-verifier/tests/receipts/<attempt>.json
```

The candidate command uses a private Git index, checks the resulting tree's exact
file list, and advances HEAD with an expected-parent compare-and-swap. It never
pushes, merges, checks out files or resets the working tree. It honors configured
commit signing. Candidate commits use Git plumbing rather than interactive Git
hooks, so the workflow must execute required repository checks explicitly before
the checkpoint. A human release/merge remains governed independently.

The ordinary shared index must be clean. The command changes its staged state
only for the exact committed paths after a successful branch update. A concurrent
branch advance rejects the candidate update and preserves the other owner's
history. Local checkpoint evidence is appended under
`.agent-workflow/runtime/repair-checkpoints/` and stays outside the public package.

## Shared-checkout cleanup

Reconcile accumulated work explicitly before enabling this policy. Inventory
tracked, staged and untracked changes; preserve private evidence at its existing
location; validate the portable source; and commit the reviewed source checkpoint.
Do not use a repair run to sweep someone else's unfinished work into its commit.
Use exact local ignore entries for private runtime material that must retain its
historical path. Do not ignore pending portable source to make status look clean.
