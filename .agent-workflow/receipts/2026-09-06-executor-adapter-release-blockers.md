# Executor Adapter Release Blocker Receipt

- Date: 2026-09-06
- Base revision: `bce1616bb814fd982c6eafe7f12efd141b49274a`
- Scope: external-action approvals, exact Hulk host validation, and registered project-root identity
- Infrastructure changes: none; storage was not migrated and services were not restarted

## Evidence

- Agent Workflow `build-feature` brief compiled locally with the deterministic mock provider.
- Enterprise indexing was attempted and failed closed because Postgres, Redis, and MinIO were offline.
- Focused executor, policy, and worker tests passed.
- `npm run check` passed with 95 tests.
- Final build and package verification are recorded in the task handoff.

## Safety properties

- A pending executor approval returns without calling the executor.
- Approved execution and exact recurring rules pass through the same approval gate.
- The approval target binds adapter, operation, host, exact revision, and registered root.
- Host registration accepts only `hulk`; root registration must be absolute and match stored project identity.
- Existing timeout, output bounds, explicit fallback, snapshot hashing, receipt reuse, storage export, and dashboard surfaces remain intact.
