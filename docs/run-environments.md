# Per-run execution environments

An owning project can select a reproducible environment for each run, workflow,
stage or command. Required installations enforce the prepared execution path
for every new run; projects must declare profiles and the exact environment
capability before source execution. A profile
prepares the toolchain and dependencies; it does not authorize an otherwise
blocked command, replay an older run, or accept a product requirement.

See [prepared execution and queue reprocessing](workflow-rollout.md) for rollout,
isolated workspaces and paused preparation entries.

## Configure a profile

Merge an `execution.environments` section into the project's existing
`.agent-workflow/project.yaml`. Use a real immutable base-image digest resolved
from the trusted registry. The digest below is an illustrative placeholder.

```yaml
execution:
  environments:
    docker_context: default
    default_profile: node-tests
    profiles:
      node-tests:
        kind: container
        platform: linux/amd64
        image: node:22-bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        source_paths: [src, tests]
        dependency_paths: [package.json, package-lock.json]
        setup:
          - [npm, ci, --ignore-scripts]
        build_network: default
        readiness:
          - argv: [node, --version]
            expect_output: v22.
          - argv: [npm, ls, --omit=optional]
        verification:
          - commands: [node --test tests/example.test.js]
            format: node-test
            minimum_tests: 1
        limits:
          cpus: 2
          memory_mb: 2048
          pids: 256
          timeout_ms: 120000
          preparation_timeout_ms: 600000
    selectors:
      - profile: node-tests
        workflow: build-feature
        stage: verify
        command: node --test *
actions:
  allowed_commands:
    - npm run agentflow -- environments *
    - node --test tests/example.test.js
```

These are merge fragments, not instructions to replace an existing policy.
Preparation and execution share a frozen total deadline capped by the owning
project's `actions.command_timeout_ms`. Every individual operation is also
bounded by the profile timeout. Increase the project budget explicitly when a
dependency build legitimately needs longer; readiness never creates an extra
unbounded execution window.

Profiles can contain Python, Node, browsers, compilers and other tools supported
by their pinned base image and locked setup inputs. For example, a numerical
profile can copy a hash-locked requirements file, run
`[python3, -m, pip, install, --require-hashes, -r, requirements-test.txt]` during
image preparation, and require `[python3, -c, "import numpy; import cv2"]` before
the actual test command. No package is installed on the host.

## Preview and execute

```bash
npm run agentflow -- environments --project templates/project --run example-repair --profile node-tests --command 'node --test tests/example.test.js'
npm run agentflow -- environments --project templates/project --run example-repair --profile node-tests --command 'node --test tests/example.test.js' --execute --json
npm run agentflow -- environments --project templates/project --run example-verifier --reuse-run example-repair --profile node-tests --command 'node --test tests/example.test.js' --verify --execute --json
```

Preview reads only explicitly declared, policy-readable files. It does not
contact Docker, install packages or create runtime files. `--execute` uses the
existing project command allowlist in addition to the environment capability.
The MCP equivalent is `agentflow_environments` with the same fields.

The governed worker supplies the real run, task, workflow and stage identities
when executing requested commands. The first matching selector wins; an explicit
CLI profile overrides selectors, then the default applies. A project can define
an exact `run` selector for an individual task. Undeclared profiles are rejected.
Profiles and selectors are trusted project policy, not free-form model arguments.

`baseline_profile` optionally names the source baseline used during prepared
source planning and verification-command selection, including before a task has
identified individual files. It must name a declared profile. It grants no
command fallback: each baseline check still needs a matching command selector
or the existing `default_profile`. A project may set a baseline and exact check
selectors while omitting the default, so unrelated native commands remain
unmatched. When no baseline is declared, existing default behavior is preserved.
Only profiles selected for the required checks receive readiness probes;
declaring another platform profile does not make its toolchain required.

An owner-declared literal verification recipe applies when the task's source
scope intersects its declared source or test paths. Its complete source and test inputs
must be bound to the selected environment, and its commands must remain allowed
and declared behavioral checks there. Unchanged test inputs need no write grant;
the recipe never expands the task's authorized writes. Covered paths use that
runner, while uncovered paths retain focused command inference.

## Reproducibility and isolation

- The recipe includes the normalized profile, Docker context, pinned base image,
  setup arguments, dependency bytes and executable modes. The first use freezes
  that recipe for its run/profile. A changed dependency or recipe requires a new
  authorized run; an existing recipe is never overwritten.
- Source bytes, paths, sizes and executable modes identify a separate immutable
  candidate snapshot. Source edits generate another candidate image while the
  declared dependency recipe stays fixed. Dependency layers are built before
  source layers so Docker can reuse unchanged installation work.
- Every dependency probe and requested command gets a fresh container from the
  exact inspected image ID. Image labels, OS and CPU architecture must match the
  resolved snapshot. A cache tag alone is insufficient evidence.
- Containers run without host bind mounts, engine sockets, host credentials,
  privileged mode, added capabilities or inherited host variables. CPU, memory,
  PID, time, source size, file count and captured output are bounded. The
  supervisor retains authority and rechecks it before each Docker operation.
- Runtime execution has no network by default. Optional pinned test services
  share a new internal network with no published host ports. Profiles may supply
  literal test-only environment values. Host variables are never interpolated.
- Cleanup addresses only the container/network IDs created by this attempt.
  Cleanup failure blocks the result and leaves diagnostic evidence. Cached images
  remain available for exact reproduction; no global image or volume prune runs.

Sources cannot escape through symlinks. Private configuration, `.env` files,
credentials, Git metadata, workflow runtime records and installed dependency
directories are excluded. Project read restrictions still apply. Build inputs
are copied into a bounded temporary context and removed after execution.

## Supporting test services

Add a `services` map to a container profile. Each service needs a pinned image,
an unprivileged numeric `user`, literal test-only `env` values and a readiness
probe. An optional `argv` supplies image command arguments. The map key becomes
the service's DNS alias on the isolated internal network; task `env` values can
refer to that alias. No real production database or host service is attached.

Readiness probes support bounded `attempts` and `interval_ms` fields for startup
latency. The same frozen total deadline applies to every retry. A missing library,
failed version check or unavailable service stops the requested task command.

Required source pipelines run readiness before the first model call of each
stage, using the profiles selected by their literal verification commands.
The same environment lifecycle, scoped native execution, authority checks,
deadlines and owned-resource cleanup apply. A readiness-only receipt records
`operation: readiness`; it executes no candidate command and contains no
verification result. Candidate checks and independent verification still run
fresh. Declare baseline files, dependency manifests and neutral test fixtures
in the existing source, dependency and fixture paths. Readiness probes should
check every required runtime dependency; the framework does not infer imports
or install missing host tools. A new authorized file beneath an existing source
root does not have to exist before an author creates it.

`npm run agentflow` and direct `agentflow` invocations are controller operations,
not model-requestable commands. Exact environment and checkpoint capability
tokens remain required by the runtime but are omitted from worker command lists;
broad command wildcards do not override this boundary. Workers request the
underlying authorized behavioral check and consume supplied workflow evidence.

An optional stage pattern `requires_source_writes: true` declares an authoring
prerequisite without granting writes. It requires a write-capable role and a
nonempty effective write grant before inference. Generated test-authoring stages
declare it; read-only test review and legitimate no-change tasks do not. Existing
snapshots without the optional field remain unchanged. Every actual write still
passes exact task scope, current policy, source binding and ownership checks.

## Matching native platforms

Use `kind: native` and an exact platform such as `darwin/arm64` for tools that
require a matching host. Native profiles require an already installed toolchain;
automatic installation, task environment overrides and container services are
not supported on that backend. Every native readiness command must itself be
project-allowlisted and uses the existing command-write sandbox. A platform
mismatch is a hold, never an unsandboxed fallback from a failed container.

## Evidence and verification

Immutable recipe bindings and per-attempt JSON receipts live under
`.agent-workflow/runtime/run-environments/<run>/<profile>/`. Receipts contain the
source manifest, recipe/dependency hashes, inspected image ID, readiness results,
command output, timing, cleanup status and actual test counts.

Verification contracts support Node test summaries, Python unittest and pytest.
A process exit of zero does not pass a required test contract. Empty, skipped,
failed, cancelled, deselected, todo, ambiguous or truncated collection remains
unverified. An exact `expected_tests` count can additionally pin the collection.
Owner-declared wrapper and absolute-interpreter commands use the selected
profile's declared parser. Stored acceptance recomputes the raw result under the
frozen profile rather than trusting reported passing counts. Pytest warnings
and successful subtests do not increase the primary test count; nonpassing
subtests and unknown or ambiguous summaries remain unverified.
Independent verification uses a fresh attempt/run/task and compares the source
and frozen recipe; a prior run's receipt never grants execution authority.

Container source tests establish source behavior on the declared platform.
Installed, deployed, hardware, native GUI and human acceptance remain separate
requirements. See [repair commit checkpoints](repair-commit-process.md) for
committing candidates before independent verification.

The source preparation artifact describes its source-phase scope and separately
lists delivery capabilities it has not qualified. Its pending deliverables are
copied only from the enrolled acceptance contract; a source-only task acquires
no deployment requirement. Readiness or source success never promotes an
installation, launch or visible-UI requirement to accepted, grants delivery
authority, or replaces the original task's completion gates.
