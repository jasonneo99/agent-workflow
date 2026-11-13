# Evaluation Harness

## Accepted Workflow Outcomes

`quality-report` now reports provider-measured input-token coverage, measured
frontier input tokens, and provider-reported cost for the run. A workflow counts
as accepted only when it completed and its latest recorded feedback is
`accepted`. Missing usage is shown as unavailable or partial and is never
replaced by a projection.

Aggregate the primary outcomes across recent project runs with:

```bash
npm run accepted-outcomes -- -p /path/to/project --limit 100 --json
```

The report separates the number of accepted workflows from the subset with
measured usage, preventing uninstrumented historical runs from appearing as
zero-token or zero-cost successes. OpenAI Responses and OpenAI-compatible
adapters record provider-returned token counts for new workflow stages. Dollar
cost remains unavailable unless an adapter supplies provider-reported cost.

Agent Workflow evaluation suites compare the same workflow cases across model
providers, model tiers, and prompt variants. Suites may be committed synthetic
benchmarks or private project-local YAML files.

## Suite format

```yaml
version: 1
id: review-comparison
name: Review comparison
workflow: review-pr
cases:
  - id: security-review
    task: Review the authentication boundary for security risks.
    expectations:
      status: completed
      minimum_average_quality: 0.7
      maximum_fallbacks: 0
variants:
  - id: local-fast
    provider: byo
    model_tier: fast
    prompt_suffix: Return concise findings ordered by severity.
  - id: openai-reasoning
    provider: openai
    model_tier: reasoning
    prompt_suffix: Separate confirmed findings from uncertainties.
```

Each case is executed once for every variant. Provider and tier overrides are
stored on the workflow run, so queued work remains reproducible if another
worker claims it. Prompt suffixes are recorded in evaluation metadata.

## Running a suite

Validate and preview the matrix without calling a model:

```bash
npm run agentflow -- evaluate \
  --suite evaluations/synthetic-provider-comparison.yaml \
  --project . \
  --dry-run
```

Run the matrix:

```bash
npm run agentflow -- evaluate \
  --suite evaluations/synthetic-provider-comparison.yaml \
  --project .
```

Evaluation runs use the built-in read-only `evaluation` execution policy:
models can analyze the project, but requested commands and file writes are
rejected. Results are written as Markdown and JSON under
`.agent-workflow/evaluations/` unless `--out` is supplied.

## Automatic evaluation runner

The launchd-compatible runner discovers valid suite YAML files in `.agent-workflow/evaluations/` and invokes the existing built `evaluate` CLI for suites with no JSON result or whose newest result is at least `interval_hours` old. Report identity uses the YAML suite `id`; duplicate or invalid IDs are rejected.

Configuration lives in `.agent-workflow/evaluation-daemon.yaml`. Defaults are `interval_hours: 24`, `suite_glob: "*.yaml"`, `max_concurrent: 1`, `project: "."`, `hour: 2`, `minute: 0`, `timeout_minutes: 180`, and `skip_index: true`. The suite filter supports `*` wildcards. Missing configuration is created with defaults; invalid configuration is rejected.

With a 24-hour interval, launchd uses a daily calendar schedule at the configured local hour and minute. Other positive intervals use `StartInterval` in seconds. Re-run `start` after changing the schedule to refresh the plist.

```bash
npm run build
npm run agentflow -- evaluation-daemon status --json
npm run agentflow -- evaluation-daemon start
npm run agentflow -- evaluation-daemon stop
```

These are operator commands for a built checkout on macOS: `start` installs and loads the per-user LaunchAgent; `stop` unloads and removes it. Starting scheduling can execute configured provider evaluations. Successful tests do not install or activate the daemon.

A live daemon lock skips overlapping ticks, stale process locks are reaped, and `max_concurrent` bounds in-flight suites. An `evaluate` exit code of 75 is treated as a skipped evaluation rather than a failure notification.

Results use the existing evaluation JSON/Markdown output directory. Per-evaluation records are appended to `.agent-workflow/evaluation-daemon-tokens.jsonl`; token usage is currently `status: "unknown"` with `totalTokens: null` because evaluation reports do not expose measured token totals. Estimated cost mix is separate from measured usage. Failures invoke `scripts/notify-requester.py` on a best-effort basis. Tick state and process output are available in `.agent-workflow/evaluation-daemon-state.json` and `.agent-workflow/evaluation-daemon.log`.

Scheduler and CLI tests use temporary fixtures and synthetic process/launchctl adapters. Run `npm exec -- node --import tsx --test scripts/evaluation-daemon.test.ts apps/cli/src/commands/evaluation-daemon.test.ts` for focused verification, including overlap, concurrency, configuration and lifecycle controls. Release review also requires fresh full-suite, typecheck, build and OSS boundary evidence; live activation is a separate operator action.


## Ranking

A run passes when status, minimum average quality, and maximum fallback
expectations all pass. Variants are ranked by:

1. pass rate
2. average quality
3. lower fallback rate
4. lower latency

The JSON report preserves per-run provider, tier, estimated cost mix, quality,
latency, fallbacks, expectation failures, and run IDs. This is the durable data
contract used by the dashboard run-comparison view.

Open `/evaluations` in the local dashboard to select a suite and compare its
variants. The view ranks variants by completion, quality, fallback use, and
latency, then exposes the full case/variant run matrix with links to individual
run details. `/api/evaluations` returns the same comparison data as JSON; pass
`?suite=<suite-id>` to select one suite.

Do not commit private evaluation cases, customer prompts, or product-specific
scoring. Keep those suites inside the target project's ignored local context.

### Workflow outcome contract holdout

The repository-local `.agent-workflow/evaluations/workflow-outcome-contracts.yaml`
suite exercises inspection-only work, implementation delivery, failed
verification repair, supersession, reversible migrations, final review
packaging, and provider fallback. It is intentionally ignored because generated
reports and provider observations are local runtime evidence. Preview or run it
with:

```bash
npm run agentflow -- evaluate \
  --suite .agent-workflow/evaluations/workflow-outcome-contracts.yaml \
  --project . \
  --dry-run

npm run agentflow -- evaluate \
  --suite .agent-workflow/evaluations/workflow-outcome-contracts.yaml \
  --project . \
  --skip-index
```

Lifecycle completion and expected-result acceptance are separate signals. The
Outcome Accuracy scorecard therefore combines explicit accepted, revised, and
rejected feedback with completion, fallback, latency-budget, and evidence-gap
counts instead of treating a completed run or a heuristic quality score as
proof that the result was useful.

## Private product scoring

Shared evaluation code supports a declarative weighting profile, but the actual product weights and heuristics stay under the target project's ignored `.agent-workflow/evaluations/` directory. For example:

```yaml
version: 1
id: private-product-fit-v1
weights:
  pass_rate: 3
  quality: 2
  latency: 0.25
  fallback_rate: -1
  accepted_feedback_rate: 2
  revised_feedback_rate: -0.5
  rejected_feedback_rate: -3
case_weights:
  checkout-critical-path: 4
  backoffice-edge-case: 0.5
latency_budget_ms: 30000
```

Run it with:

```bash
npm run agentflow -- evaluate \
  --suite .agent-workflow/evaluations/private-suite.yaml \
  --project . \
  --scoring-profile .agent-workflow/evaluations/private-scoring.yaml
```

The shared engine combines normalized pass rate, quality, latency, fallback rate, and feedback rates. Positive weights reward a signal and negative weights penalize it. Optional `case_weights` keep product-critical scenario priorities private while using the same public scoring mechanics. The generated report contains the profile ID and checksum for reproducibility, but does not copy the private weights, case priorities, or heuristics into shared output. Without a private profile, the original public ranking remains pass rate, quality, fallback use, then latency.
