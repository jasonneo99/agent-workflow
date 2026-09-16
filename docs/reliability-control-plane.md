# Reliability Control Plane

Agent Workflow uses one reliability contract across interactive clients, workers,
the learning daemon, and releases.

## Work ownership

Acquire a project-scoped intent before Codex, a daemon lane, or an external
client begins write-capable work. Empty file scope means the whole project.

```bash
npm run reliability -- intent acquire --project project-id --owner codex:task-id \
  --objective "Implement bounded change" --files packages/storage,packages/workflow-engine
```

Renew long work with `intent renew --token ...` and release it with
`intent release --token ...`. A conflicting owner, identical objective, or
overlapping file scope fails closed. Fencing tokens prevent an expired owner
from renewing or releasing a newer lease.

## Execution state

Every stage follows `queued -> leased -> running -> completed | blocked | failed
| cancelled`. The run status is derived from stage state. A claim increments
the durable stage fencing token; completion, block, and failure writes require
the current worker identity, unexpired lease, and exact token.

## Exactly-once effects

Commands, writes, executors, approvals, and model routes retain their existing
receipts. `side_effect_receipts` supplies a shared idempotency ledger for commits,
deployments, and future external actions. The first result wins; retries replay
the recorded result.

## Atomic releases

`npm run release:atomic -- ...` prepares a release before switching the `current`
symlink, restarts bounded services, performs an authenticated health check, and
rolls the symlink and services back if health does not pass. Metadata-only
receipts are stored under the operator's private local state directory.

## Failure injection and SLOs

`npm run reliability:chaos` lists the required deterministic failure matrix.
The command reports contract coverage separately from live execution; a scenario
is not considered proven until its recovery and rollback evidence is recorded.
`npm run reliability` reports duplicate effects, receipt coverage, expired
leases, invalid terminal runs, recovery time, fleet false criticals, and rollback
time. Expansion of autonomous authority requires a passing report and tested
recovery for every failure scenario.
