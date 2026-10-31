# Per-run execution environments

An owning project can select a reproducible environment for each run, workflow,
stage or command. Existing projects keep their command execution behavior until
they declare profiles and enable the exact environment capability. A profile
prepares the toolchain and dependencies; it does not authorize an otherwise
blocked command, replay an older run, or accept a product requirement.

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
Independent verification uses a fresh attempt/run/task and compares the source
and frozen recipe; a prior run's receipt never grants execution authority.

Container source tests establish source behavior on the declared platform.
Installed, deployed, hardware, native GUI and human acceptance remain separate
requirements. See [repair commit checkpoints](repair-commit-process.md) for
committing candidates before independent verification.
