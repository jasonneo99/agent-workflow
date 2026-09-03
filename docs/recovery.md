# Backup And Recovery

Agent Workflow is local-first. Backup and recovery should protect the local
enterprise services and project-local `.agent-workflow/` files without moving
private project data into the open source package.

## What To Back Up

- Postgres data, including workflow runs, tasks, receipts, artifacts, project
  registrations, indexed file summaries, memory, approvals, and provider
  evidence.
- Redis only when you need transient queue state during a live incident. Durable
  workflow evidence is in Postgres.
- Object storage buckets used for large artifacts.
- Project-local `.agent-workflow/` directories, especially project policy,
  schedules, tuning approvals, exports, and reports.
- The exact Agent Workflow package or git revision used for the run evidence.

Do not back up `.env` into shared archives. Store provider keys and service
credentials in your normal secret manager.

## Readiness Check

Run a read-only backup inventory:

```bash
agentflow backup-report --project /path/to/project
agentflow backup-report --project /path/to/project --json
npm run backup-report -- --project templates/project
```

The report checks enterprise service reachability, registered projects, runs,
indexed context, memory items, artifact counts and bytes, archive snapshots,
restore snapshots, lifecycle approvals, and active queue blockers.

## Restore Drill

Run a read-only restore drill after at least one approved archive and restore
snapshot exists:

```bash
agentflow restore-drill --project /path/to/project
agentflow restore-drill --project /path/to/project --json
npm run restore-drill -- --project templates/project
```

The drill verifies `restored_artifact -> archived_artifact -> original URI`
lineage and confirms that the copied restored content hash matches the archived
content hash. It does not create backups, restore files, overwrite rows, delete
artifacts, or mutate storage.

## Recovery Procedure

1. Restore Postgres from your normal database backup.
2. Restore object storage buckets if your deployment stores large artifacts
   outside Postgres.
3. Start local enterprise services.
4. Run `agentflow doctor`.
5. Run `agentflow backup-report --project /path/to/project`.
6. Run `agentflow restore-drill --project /path/to/project`.
7. Inspect `/backup-report`, `/artifact-lifecycle`, `/approvals`, and `/queue`
   in the dashboard.
8. Requeue interrupted tasks only after checking queue and approval state.

Keep destructive prune/delete operations outside recovery until a future release
adds an audited implementation. Current prune/delete gates record approval and
policy evidence but do not delete data.
