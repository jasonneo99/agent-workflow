# Daemon fleet health contract

- Date: 2026-09-13
- Added: authenticated `/api/server-daemon-fleet-health`
- Includes: supervisor freshness, worker lanes, eight governed daemon lanes,
  per-project scheduling and learning heartbeat status
- Boundary: project ids and names only; no client-facing roots or secrets
- All-projects behavior: resolves registered roots to local mapped checkouts and
  honors project daemon enable, pause, mode, and run-limit settings
- Validation: typecheck, open-source boundary validation, and package tests
