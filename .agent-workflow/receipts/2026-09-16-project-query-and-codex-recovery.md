# Project-query routing and Codex CLI recovery

- Date: 2026-09-16
- Scope: shared Agent Workflow runtime used by Agent Workflow Studio
- Routing: read-only project questions, including roadmap and status questions,
  now use one `technical-architect` agent task instead of the `review-pr`
  workflow.
- Recovery: transient Codex CLI process failures are classified as provider
  outages and use the existing bounded policy to retry once.
- Diagnostics: Codex CLI exit codes and sanitized, bounded stderr details are
  retained in provider attempts and failed model-route receipts.
- Privacy: credential-shaped values are redacted before diagnostic text is
  recorded; arbitrary provider response bodies remain suppressed.
- Validation: focused routing/provider tests, TypeScript typecheck, dry-run and
  live execution against the Jarvis roadmap question, and all 257 package tests.
- Existing check issue: open-source boundary validation remains blocked by the
  unrelated pre-existing `/home/remote` fixture in
  `packages/daemon-control/src/index.test.ts`; this change did not edit it.
