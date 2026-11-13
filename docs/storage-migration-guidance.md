# Storage Migration Guidance

## Overview
This document outlines the steps and considerations for migrating local agent workflow storage to a shared shared host storage target.

## Key Considerations
- **Open-source/Local-first**: Ensure all tools and scripts remain open-source and prioritizes local infrastructure.
- **Dry-run First**: Implement mechanisms to simulate the migration process to identify potential issues beforehand.
- **Non-empty Target Detection**: Integrate checks to confirm the target storage is empty before allowing migration to proceed.
- **Preflight/Readiness Check**: Introduce checks to preemptively highlight collision risks and ensure readiness.
- **Preserve Target Data**: Avoid any operations that may overwrite or delete existing data in the target storage.

## Implementation Steps
1. **Dry-run Implementation**
   - Develop a simulation mode using the CLI to preview the migration.

2. **Pre-flight Collision Detection**
   - Create scripts or functions to detect potential collisions or issues before actual data transfer.

3. **Safety Checks**
   - Ensure the target directory is verified for non-emptiness and appropriate warnings are given.

4. **Documentation and Testing**
   - Update documentation and create relevant tests to verify the migration process integrity.

## Stable projects and permission-scoped locations

A project has one stable logical UUID. Checkouts, clones, worktrees, pinned
dependency mirrors and historical locations attach beneath it. Repairs remain
workflow runs, never new project identities. Existing `projects.id` values are
retained as execution scopes with their original roots, policies, approvals,
grants, intents and run ownership. Identity membership never unions permissions.
Historical receipts, artifacts and lifecycle state are not rewritten.

`project-identities` lists identities and their locations. Initialization is an
explicit additive metadata operation: `--initialize --write --actor ... --reason
...`. Preview attachments with `--target <canonical-uuid> --attach <json>`;
the JSON is an array of `{projectId,kind}` records. Kinds are `checkout`,
`worktree`, `vendor` and `historical`; pinned dependencies remain `vendor`.
Inspect and privately save the preview, then apply with `--plan <file> --write
--actor ... --reason ...`. Registration/config digests must still match.
Rollback uses `--revert <event-id> --write --actor ... --reason ...`, records a
new chained audit event and refuses changed links. No registration is deleted.
`--runs <identity-uuid>` projects run/repair history beneath the logical project
while retaining every original execution scope and run ID.

A local Git common directory can prove that a new worktree belongs to a
registered project, but does not transfer any permission. Subdirectory
registration is refused: register the repository root and use file scopes.
Independent nested repositories remain independent. Names, remote URLs and
home-prefix heuristics are not identity or authorization evidence. Other clones
require explicit operator-reviewed attachment; unavailable remote roots are
never guessed from basenames.

Do not use the older destructive alias consolidation for identity reconciliation:
it reparents history and deletes source registrations. This additive model does
not establish workflow acceptance or dismiss unfinished work. Updating registry
metadata is separate from deploying the new source or reloading a daemon.
