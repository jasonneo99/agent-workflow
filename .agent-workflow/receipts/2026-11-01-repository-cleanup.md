# Repository cleanup receipt — 2026-11-01

- Added bounded copy-truncate rotation for supervisor stdout and stderr. Defaults retain five 10 MiB segments and preserve launchd's active file descriptor.
- Verified focused rotation and supervisor tests, TypeScript compilation, and diff hygiene.
- Reinstalled the local LaunchAgent and observed a fresh running supervisor heartbeat on port 17888.
- Reduced live supervisor logs from approximately 1.4 GiB to 20 MiB without deleting current evidence.
- Moved thirteen inactive October 22 context/E2E build directories to the user's Trash for recoverable cleanup; no running process referenced them.
- Pruned five stale Git worktree metadata entries whose gitdir targets no longer existed.
- Reconciled three inaccessible registrations into stable historical project identities through reviewed, append-only identity plans: the legacy Agent Workflow Linux release, the Jarvis bootstrap canary, and the obsolete deck demo fixture.

This cleanup did not delete workflow records, artifacts, receipts, approvals, or run history. It did not archive or reinterpret failed runs.
