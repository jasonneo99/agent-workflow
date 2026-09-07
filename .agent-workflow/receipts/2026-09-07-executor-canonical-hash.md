# Executor snapshot canonical-hash fix

Date: 2026-09-07 UTC

## Live failure reproduced

Fleet canary run `67322999-9e80-40c0-b57b-ca48dcda9cdc` created the expected
fallback-off `hulk-exact-revision/typecheck` approval. Approval execution failed
closed before contacting Hulk with `Executor snapshot evidence hash mismatch`.

PostgreSQL stored the executor snapshot as `jsonb`, which preserves semantic
content but may reorder object keys. Snapshot creation hashed ordinary
`JSON.stringify` insertion order, so the persisted object produced a different
digest when approval execution revalidated it.

## Change

- Hash executor evidence through recursive canonical JSON key ordering.
- Preserve array order and primitive values.
- Continue hashing every immutable executor evidence field.
- Add a regression for top-level PostgreSQL-style key reordering.
- Add a regression proving nested object keys are canonicalized recursively.
- Preserve fail-closed behavior when evidence values actually change.

## Verification

- Focused executor-adapter tests: 8 passed.
- `npm run check`: 97 tests passed with no failures.
- `npm run build`: passed.
- `npm run pack:check`: passed.

## Deployment boundary

This source fix was validated in an isolated worktree based on reviewed revision
`b2dc89df16cdd9e8f6f070033f61b0fd44da1851`. It was not deployed by this change.
The failed approval remains historical evidence and should not be retried; a new
canary run must generate a snapshot with the corrected canonical hash.
