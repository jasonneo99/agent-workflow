# Evaluation Harness

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
