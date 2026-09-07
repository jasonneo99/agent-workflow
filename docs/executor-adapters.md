# Executor adapters

Executor adapters route selected workflow stages through fixed, registered
execution contracts. They are not model tools: agents cannot supply commands,
paths, environment variables, or arguments.

## Hulk exact-revision adapter

`hulk-exact-revision` invokes Heimdall's existing
`~/.local/bin/fleet-hulk-agent-workflow-job` with exactly two arguments: one
registered operation and one full Git commit ID. The adapter supports only the
registered `agent-workflow` project and `typecheck`, `validate`, or `test`.

Remote execution is disabled unless both a project registration and a workflow
stage binding exist. A queue transaction records executor ID, adapter type,
project, operation, exact revision, run ID, task ID, timeout, output limit,
requested host, and fallback policy in hashed run/task snapshots. Retries reuse
a successful artifact by snapshot hash. Receipts and stage artifacts include the
host that actually ran the operation.

Example Heimdall project registration:

```yaml
execution:
  policy_profile: local
  policy_profiles: {}
  executor_adapters:
    hulk-exact-revision:
      type: hulk-exact-revision
      projects: [agent-workflow]
      operations: [typecheck, validate, test]
      host: hulk
      timeout_ms: 1800000
      max_output_chars: 20000
      local_fallback: off
```

Bind only the intended verification stage:

```yaml
stages:
  - id: verify-typecheck
    agent: auto-test-runner
    goal: Run the registered typecheck operation.
    executor:
      id: hulk-exact-revision
      operation: typecheck
```

The mapped local command must also remain allowed by project action policy.
Unknown adapter IDs, projects, operations, malformed revisions, or modified
snapshot evidence fail closed.

## Migration and canary

On Heimdall after the reviewed build is installed:

1. Run `agentflow migrate-storage` to add the additive JSONB snapshot columns.
2. Add the project registration above to the registered Agent Workflow checkout.
3. Add one `typecheck` stage binding and canary an exact committed revision.
4. Inspect `agentflow status --run <id> --artifacts`; confirm the executor,
   revision, `requestedHost: hulk`, and `executionHost: hulk` evidence.
5. Canary `validate`, then `test` separately.

Do not restart services or enable bindings as part of a source-only rollout.
The fleet-config role already owns installation of the fixed executor.

Local fallback is deliberately separate configuration. Set `local_fallback:
explicit` only after an unreachable/timeout exercise has been reviewed. The
fallback maps the operation to the existing policy-controlled local command and
records `fallbackUsed: true` plus the actual local hostname.

## Rollback

Remove the stage `executor` bindings, then remove the project
`executor_adapters` registration and restart the Heimdall worker during an
approved deployment window. Existing workers return to local model stages.
Keep the additive snapshot columns so historical evidence remains readable; no
database downgrade is required. The standalone fixed executor is unaffected.
