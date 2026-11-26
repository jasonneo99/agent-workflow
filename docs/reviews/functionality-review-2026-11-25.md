# Functionality review — 2026-11-25

Read-only review of the CLI, MCP server, gateway, core packages, agents and
workflows, plus real runs of the main user paths. Nothing was changed. Not
committed: pick items first.

## How the paths were exercised

Fresh runs used a throwaway PostgreSQL database created and dropped for the
review (same method as `scripts/test-isolated.ts`), so the live supervised
worker could not claim them. Projects were throwaway copies under a scratch
directory. `DEFAULT_MODEL_PROVIDER=mock` was set for every run.

| Path | Result | Wall time |
|---|---|---|
| `npm run doctor` | OK, 4 lines (definitions + 3 TCP checks) | 3.5 s |
| `npm run list` | OK, 28 agents, 24 workflows | 2.1 s |
| `agentflow --help` via tsx / via `dist/` | 187 top-level commands | 3 s / 0.9 s |
| migrate fresh DB | OK | 2.3 s |
| `dynamic-plan` (template project) | OK, `api-service` archetype, backend → verify | 2.4 s |
| `compile build-feature` | OK, prints brief only (does not queue) | 2.5 s |
| `init-project --profile enterprise` (new git repo) | OK | 3.9 s |
| `run-and-watch build-feature` before `bootstrap-storage` | **exit 1**, raw FK error | 4.1 s |
| `bootstrap-storage` | OK | 5.7–6.2 s |
| `run-and-watch build-feature` | **blocked** in stage 1 (no environment profiles) | ~4 s |
| `run-and-watch review-pr` | **blocked** in stage 1; ran on **codex-cli gpt-6-astra**, not mock | 107 s |
| `run-and-watch answer-question` | completed; ran on **codex-cli gpt-6-luna**, not mock | 12 s |

Agents: all 28 agents are referenced by at least one workflow or by runtime
code. Workflows: all 24 load; `code-review` and `review-pr` are distinct
(single-file deep review vs. change review).

## Ranked improvements

### 1. `DEFAULT_MODEL_PROVIDER=mock` is not honored — validation runs spend live provider usage
- **Evidence:** both mock-mode runs above executed on `codex-cli` (exports record `gpt-6-astra`, est. $0.139, and `gpt-6-luna`). `apps/cli/src/lib/context.ts:62` loads `.agent-workflow/runtime.env` with `override: true`, and that file sets `AGENTFLOW_PROVIDER_FAST/STANDARD/REASONING`, which route by tier ahead of the default provider. AGENTS.md promises mock for deterministic local validation.
- **Impact:** tests, demos and CI-style checks silently consume subscription or paid credits and are non-deterministic; reviewers may trust "mock" results that came from a live model.
- **Fix:** treat `DEFAULT_MODEL_PROVIDER=mock` as a hard switch that disables tier and auto routing; let explicit shell env win over `runtime.env` (drop `override: true`, or exempt provider keys); print the resolved provider per stage at run start.
- **Effort:** S–M

### 2. A freshly initialized project cannot run `build-feature`
- **Evidence:** `run-and-watch build-feature` blocks in `implement` with "Prepared source execution needs declared environment profiles; no host fallback is permitted" (`packages/run-environments/src/workspace.ts:18`). `init-project --profile enterprise` creates no environment profile, and the message does not name the command that fixes it.
- **Impact:** the flagship workflow fails on first use for every new project.
- **Fix:** have `init-project` write a default prepared environment profile (or offer `--environment host-node`), and make the blocker message include the exact command to declare one. Add a fresh-project end-to-end test.
- **Effort:** M

### 3. The project template defaults to wide-open autonomy
- **Evidence:** `templates/project/.agent-workflow/project.yaml:10` `autonomy: wide-open` and `:77` `allow_wide_open: true`; the compiled brief for a new project shows "Project autonomy: wide-open" with `npm *` and `git *` allowed (`git push` is not in the block list). AGENTS.md says wide-open is only for projects that explicitly opt in.
- **Impact:** every new project starts at maximum autonomy without the user choosing it.
- **Fix:** template defaults to a guarded level (3) with `allow_wide_open: false`; offer `init-project --autonomy wide-open` as an explicit opt-in; block `git push *` by default.
- **Effort:** S

### 4. First run on a new database fails with a raw SQL error
- **Evidence:** before `bootstrap-storage`, `run-and-watch` exits 1 with `insert or update on table "workflow_runs" violates foreign key constraint "workflow_runs_workflow_id_fkey"`. `doctor` reports all OK in that state.
- **Impact:** setup looks broken; the error gives no hint that definitions must be bootstrapped.
- **Fix:** sync workflow/agent definitions automatically on `run`/`run-and-watch` (idempotent), or catch the FK error and print "run `npm run bootstrap-storage`". Have `doctor` check it (see 6).
- **Effort:** S

### 5. The project template carries dogfooding residue into new projects
- **Evidence:** `templates/project/.agent-workflow/decisions.md:8-9` lists `src/leaseRecovery.js` and `test/leaseRecovery.test.js`; the template also ships a dated `evaluations/daemon-model-comparison-standard-2026-09-15T20-08-52Z.*` artifact; new projects are named "Example Project". In the review-pr run the model tried to read the leaseRecovery files ("File read failed: no such file") and the run blocked.
- **Impact:** new projects start with misleading context that wastes tokens and derails stages.
- **Fix:** scrub the template, set the project name from the folder in `init-project`, and add a test asserting the template matches a pristine manifest (smoke tests must write to a copy, not the template).
- **Effort:** S

### 6. `doctor` only checks TCP reachability
- **Evidence:** `apps/cli/src/commands/system.ts:95-123` checks Postgres/Redis/S3 ports and counts definitions. It does not check migrations, bootstrapped definitions, environment profiles, which provider will actually run, the Codex binary, or env-file overrides.
- **Impact:** items 1, 2 and 4 all pass `doctor`.
- **Fix:** add schema version, definition sync, resolved provider routing (with a warning when mock is requested but overridden), environment-profile presence for the target project, and a runtime.env secrets check. Add `--project` to scope it.
- **Effort:** M

### 7. Flaky test: existing-assignment-reconciliation (mixed clocks)
- **Evidence:** failed once in a full run with "Fresh successful governed test evidence required" instead of the expected one-time-phase error; passes alone. Receipts take `created_at` from the client clock with a +1 ms monotonic bump (`packages/storage/src/receipt-writer.ts:30`), while artifacts use the database host's `clock_timestamp()`; the guard compares them (`packages/storage/src/existing-assignment-reconciliation.ts:389`, `a.created_at > $3`). The database is on a different host, so skew or the bump can order an artifact before the receipt.
- **Impact:** intermittent red suites; the same ordering assumption can wrongly reject real operator repairs.
- **Fix:** take receipt timestamps from the database (`clock_timestamp()` with a SQL-side monotonic guard), or order evidence by receipt sequence/hash chain instead of wall-clock comparison.
- **Effort:** M

### 8. Flaky test: Codex CLI cancellation (absolute timing under load)
- **Evidence:** `packages/model-providers/src/codex-cli-cancellation.test.ts:127` races completion against a fixed 3,000 ms window and `:135` asserts natural completion under 2,000 ms, while spawning real processes. It failed once during a full parallel run and passed 3/3 alone.
- **Impact:** intermittent red suites unrelated to the change under test.
- **Fix:** measure from the fixture's recorded exit time rather than test start, widen the bounds, or run real-process tests in a serial test group.
- **Effort:** S

### 9. runtime.env credential entries (corrected on follow-up)
- **Evidence:** `.agent-workflow/runtime.env:1` says "Non-secret durable runtime settings. Do not place credentials in this file" and contains two API-key entries. On follow-up both entries are **blank**: they deliberately switch the direct OpenAI and Muse APIs off by overriding `.env`. No credential is stored there.
- **Impact:** none today; the risk is a future non-empty credential landing in a file meant for non-secret settings.
- **Fix (applied):** keep the loading order (the blank override is intentional) and warn on stderr, naming only the key, when runtime.env sets a non-empty credential.
- **Effort:** S

### 10. Run report says "Failures: None" when a stage failed or blocked
- **Evidence:** the build-feature report printed "Tasks: 0/3 completed, 1 failed" and "Failures: - None" in the same summary.
- **Impact:** users skim the wrong conclusion.
- **Fix:** list blocked and failed stages with their blocker reason under Failures/Blockers in `run-reporter`.
- **Effort:** S

### 11. Docs and template commands drift from the definitions
- **Evidence:** AGENTS.md lists 17 workflows; 7 exist but are missing (`answer-question`, `code-review`, `investigate-issue`, `production-readiness`, `provider-smoke`, `repair-blocked-item`, `training-evaluation`), as are agents `project-answerer`, `workflow-guide`, `queue-partner`. `.agent-workflow/project.yaml` lists `investigate-issue` as a default workflow. The new-project AGENTS.md (`templates/project/AGENTS.md:22`) recommends `agentflow run`, which only queues and needs a worker; `run-and-watch` is the one-shot path.
- **Impact:** users and agents choose from an incomplete menu and use the command that appears to do nothing.
- **Fix:** generate the roster sections from YAML and validate them in `npm run validate`; recommend `run-and-watch` in the template.
- **Effort:** S

### 12. CLI startup cost on every command
- **Evidence:** all npm scripts use `tsx` (`--help` 3 s), while the built `dist/` CLI answers in 0.9 s. A typical session runs dozens of commands; the dashboard and daemon also shell out.
- **Impact:** about 2 s of overhead per invocation.
- **Fix:** have `npm run agentflow` and the common scripts use `dist/` when it is newer than the sources (fallback to tsx), or ship a small launcher that checks build freshness.
- **Effort:** S–M

### 13. Command surface is too large to discover
- **Evidence:** 187 top-level CLI commands and 153 npm scripts. Ten commands have no reference in docs, README, package.json, MCP or scripts: `context-correction-review`, `provider-use|model-use` (documented only by name in providers.md), `egress-log`, `verify-receipts`, `workflow-graph|graph`, `guide-evidence-diagnostics`, `guide-adoption-hold-metrics`, `context-hook`, `context-session-hook`, `worker-host-trust` (most are referenced only by a test).
- **Impact:** `--help` is a wall of text; operator-only commands sit next to everyday ones.
- **Fix:** group into subcommands (`run`, `queue`, `learning`, `context`, `provider`, `runtime`, `ops`), hide operator and hook commands from default help, document or deprecate the ten unreferenced ones, and prune npm script aliases to the documented core.
- **Effort:** L

### 14. MCP server exposes about 67 tools
- **Evidence:** `apps/mcp/src/index.ts` (2,089 lines) registers about 67 tools.
- **Impact:** every MCP client pays the tool-schema context cost on each turn, and models pick from a crowded list.
- **Fix:** expose a core set by default (run, status, artifacts, approvals, context) and gate the rest behind opt-in tool groups advertised through client capabilities.
- **Effort:** M

### 15. `daemon.ts` is a 21,491-line hotspot
- **Evidence:** `apps/cli/src/commands/daemon.ts` holds dashboard HTML, API routes, roadmap parsing and supervisor logic; next largest files are `builders-learning.ts` (5,517) and `learning.ts` (3,980). This is already roadmap priority 4.
- **Impact:** slow reviews, frequent merge conflicts (two sessions edited it today), and slow type-checking of a single module.
- **Fix:** continue extraction: dashboard pages and API routes into their own modules first, then roadmap parsing into `packages/roadmap`.
- **Effort:** L
