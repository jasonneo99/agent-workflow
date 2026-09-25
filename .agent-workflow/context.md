# agent-workflow Context

Portable Agent Workflows is a local-first developer workflow kit for reusable agents, automatic agents, multi-stage workflows, MCP tools, dashboard controls, and enterprise local storage. The goal is to keep reusable workflow logic outside target projects while each project contributes compact local context through `AGENTS.md` and `.agent-workflow/`.

Local release operations use the ignored `.agent-workflow/runtime.env`. The release operator should verify `AGENTFLOW_RELEASE_SIGNING_KEY` points to the protected local Ed25519 key and run `npm run release:check` before any version bump or publish. Never print, copy, commit, or export the private key.

## Detected Stack

- Package manager: npm
- Runtime: Node.js and TypeScript
- Services: Postgres with pgvector, Redis, and MinIO through Docker Compose
- Interfaces: CLI, MCP server, local dashboard, and project templates
- Languages: javascript, typescript

## Personalization Notes

- Prefer model-portable provider adapters and BYO model configuration over environment-specific assumptions.
- Optimize for developer cost savings, compact context, durable receipts, and useful artifacts.
- Dashboard and MCP features should make workflows easy to run from Codex, Cursor, VS Code, or a terminal.
- Keep durable preferences here instead of repeating them in every prompt.

## Repository Map

- `agents/`: reusable and automatic agent definitions.
- `workflows/`: reusable workflow definitions.
- `apps/cli/`: CLI, dashboard server, provider adapters, worker, storage, and orchestration logic.
- `apps/mcp/`: MCP integration surface.
- `packages/`: shared runtime packages.
- `templates/project/`: installable project template and smoke target.
- `docs/`: user guides, roadmap, integration notes, and example exports.
- `infra/`: local enterprise storage services.

## Roadmap evidence handoff

- Evidence anchor: commit `ab07a40666d216aca37a3f96c3be44d17c2d3716`; authoritative priorities remain in `docs/roadmap.md`. This context update records inspection, not completion of the overall roadmap task.
- Guarded autonomy: completed-mutation accounting reports a verified 896/896 sample. Row-level inspection identified the excluded record as an expired pending reservation, not a completed mutation without a receipt. Duplicate-effect, timed recovery, fleet-false-critical, timed rollback, sustained samples, and reviewed canary evidence remain necessary. See `apps/cli/src/reliability-command.ts` and `packages/reliability-suite/src/index.test.ts`.
- Recovery: `docs/recovery.md` documents independent standby replay and read-only state; promotion, fencing, endpoint switching, and rollback completion are not established. Continue non-destructive proof with one writer.
- Extraction: retain `repository-maintenance-baseline.json` targets for CLI index (43,437), storage postgres (2,816), and workflow executor (957). The roadmap records 4,808 lines remaining, not a fresh measurement here. `stage-outcome.ts` retains compatibility exports through `executor.ts`, with cases in `executor.test.ts`.
- Worktrees: governed isolation, overlap prediction, conflict-aware merge ordering, branch verification receipts, and cleanup remain next work in the roadmap; implementation proof was not established by this inspection.
- Latency: `packages/observability/src/index.ts` and `index.test.ts` contain queue/model, approval-wait, retry, overhead, and task-overlap metrics. Direct-baseline comparison and evidence-led tuning remain open. Aggregate model-time subtraction and task overlap are not verified critical-path overhead or productive speedup.
- MCP: reuse the recovery guidance in `docs/roadmap.md`; collect fresh metadata-only client/launcher evidence on recurrence before changing repository code.
- Validation handoff: acquire an exact-file reliability intent before writes; stop on conflict, renew while active, and release with the returned fencing token. Record pre/post hashes, action receipts, and verifier results. `npm run check` includes boundary validation, examples, maintenance ratchet, typecheck, and tests; no test execution is claimed here. Subsequent source changes also require focused affected tests under applicable command policy.
