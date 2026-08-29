# Model Improvement Walkthrough

This walkthrough shows the full local developer loop for improving agent
quality while controlling model cost. It uses scrubbed examples and placeholder
project paths so the same process can be shared publicly without exposing
customer data, private prompts, scoring formulas, or production routing policy.

Use this when a workflow is getting useful results, but the output is too slow,
too expensive, inconsistent, or needs repeated manual correction.

## Goal

Move from local evidence to a reviewed improvement proposal:

1. Run a workflow and inspect quality/cost evidence.
2. Record feedback.
3. Generate tuning proposals.
4. Approve only the proposals you trust.
5. Create scrubbed model-improvement plan files.
6. Create baseline-versus-candidate comparison suites.
7. Inspect comparison readiness and recommendations in the dashboard.
8. Generate a review-only promotion note plan.

Nothing in this flow automatically uploads datasets, starts provider fine-tune
jobs, or changes live routing.

## 1. Start Local Services

From the Agent Workflow repo:

```bash
cd /path/to/agent-workflow
npm install
docker compose -f infra/docker-compose.yml up -d
npm run doctor
npm run bootstrap-storage
```

Expected output:

```text
OK: Postgres + pgvector
OK: Redis
OK: MinIO object storage
Seeded agents and workflows into enterprise storage.
```

## 2. Initialize A Target Project

Use enterprise mode for the normal local developer workflow:

```bash
npm run onboard-project -- --project /path/to/project --profile enterprise --write
```

Expected result:

```text
Wrote .agent-workflow/project.yaml
Wrote AGENTS.md
```

Keep project-specific context inside that target project. Reusable agents and
workflows stay in the Agent Workflow package.

## 3. Run A Workflow

Run the workflow you want to improve. This example uses `review-pr`, but the
same loop works for `build-feature`, `debug-failure`, `production-readiness`,
or a direct agent task.

```bash
npm run agentflow -- run-and-watch review-pr \
  --project /path/to/project \
  --task "Review the current local changes for bugs, risks, and missing tests" \
  --index-max-files 100 \
  --worker-limit 6
```

Expected output includes a run id:

```text
Queued workflow run <run-id>
Completed workflow run <run-id>
```

## 4. Inspect Quality And Cost

```bash
npm run agentflow -- quality-report --run <run-id>
```

Look for:

- fallback use
- quality pass or fail counts
- average latency
- provider and model-tier mix
- stages that cost more than their value

The dashboard home also shows Usage & Performance across recent runs:

![Dashboard home](assets/screenshots/dashboard-home.png)

## 5. Record Feedback

Feedback is the personalization signal. Keep it short and outcome-focused.

```bash
npm run agentflow -- feedback \
  --run <run-id> \
  --rating revised \
  --note "Good risk coverage, but too much reasoning-tier use for docs-only findings"
```

Expected output:

```text
Recorded revised feedback.
```

Use `accepted` when the run was good, `revised` when it needed changes, and
`rejected` when the result should not influence future defaults.

## 6. Generate Tuning Proposals

```bash
npm run agentflow -- preference-scorecard --project /path/to/project
npm run agentflow -- tuning-proposals --project /path/to/project
```

The proposal output may recommend prompt notes, context-budget changes, routing
preferences, or more feedback. These are review hints, not automatic changes.

## 7. Queue And Approve Trusted Proposals

Dry-run first:

```bash
npm run agentflow -- queue-tuning-approvals --project /path/to/project --ids all
```

Write the approval queue only when the proposals look reasonable:

```bash
npm run agentflow -- queue-tuning-approvals --project /path/to/project --ids all --write
npm run agentflow -- tuning-approvals --project /path/to/project --approve tune-001 --reviewer "Your Name"
```

Expected files:

```text
.agent-workflow/tuning/approval-queue.json
.agent-workflow/tuning/approval-queue.md
.agent-workflow/tuning/approval-history.json
.agent-workflow/tuning/approval-history.md
```

## 8. Create The Model-Improvement Plan

Dry-run:

```bash
npm run agentflow -- model-improvement-plan --project /path/to/project
```

Write local scrubbed plan files:

```bash
npm run agentflow -- model-improvement-plan --project /path/to/project --write
```

Expected files:

```text
.agent-workflow/model-improvement/eval-case-proposals.md
.agent-workflow/model-improvement/provider-dataset-plan.md
.agent-workflow/model-improvement/model-improvement-plan.json
```

These files describe eval cases and provider dataset shapes. They do not export
raw prompts or upload training data.

## 9. Create Candidate Comparison Suites

Compare the current baseline against a proposed candidate route:

```bash
npm run agentflow -- candidate-comparison-plan \
  --project /path/to/project \
  --baseline-provider auto \
  --baseline-tier standard \
  --candidate-provider auto \
  --candidate-tier reasoning \
  --write
```

Expected files:

```text
.agent-workflow/model-improvement/candidate-comparison-plan.md
.agent-workflow/model-improvement/candidate-comparison-plan.json
.agent-workflow/evaluations/model-improvement-<workflow>-01.yaml
```

## 10. Run Evaluations And Gate Promotion

Run the generated suite. Start with dry-run if you only want to inspect the
matrix.

```bash
npm run agentflow -- evaluate \
  --suite .agent-workflow/evaluations/model-improvement-<workflow>-01.yaml \
  --project /path/to/project
```

After you have baseline and candidate run ids:

```bash
npm run agentflow -- gate \
  --run <candidate-run-id> \
  --baseline-run <baseline-run-id> \
  --project /path/to/project
```

Only promote changes after the gate passes.

## 11. Inspect The Dashboard

Start the dashboard:

```bash
npm run agentflow -- dashboard
```

Open:

```text
http://127.0.0.1:17888/model-improvement?project=/path/to/project
http://127.0.0.1:17888/candidate-comparisons?project=/path/to/project
```

The Candidate Comparisons page shows:

- comparison plan status
- generated suite file status
- baseline/candidate quality and latency deltas
- promotion recommendation
- promotion gate command
- promotion note plan files after they are written

The Queue and Run Detail pages are useful when a comparison run needs attention:

![Queue control panel](assets/screenshots/dashboard-queue.png)

![Run detail page](assets/screenshots/dashboard-run-detail.png)

## 12. Generate A Review-Only Promotion Note

When the dashboard recommendation says `propose_routing_note`, preview the note
plan:

```bash
npm run agentflow -- promotion-note-plan --project /path/to/project
```

Write review files:

```bash
npm run agentflow -- promotion-note-plan --project /path/to/project --write
```

Expected files:

```text
.agent-workflow/tuning/promotion-routing-note-plan.md
.agent-workflow/tuning/promotion-routing-note-plan.json
```

Refresh Candidate Comparisons to review the file status and markdown preview.
These files are advisory. They do not update active routing preferences.

## Safe Sharing Checklist

Before sharing a report, issue, screenshot, or doc publicly:

- Use `npm run export-run -- --run <run-id> --scrub`.
- Keep `.agent-workflow/evaluations/` private unless examples are synthetic.
- Do not include raw customer prompts, private test fixtures, secrets, or
  proprietary ranking formulas.
- Prefer screenshots of dashboard structure over project-specific output.
- Replace absolute project paths with `/path/to/project`.

## Troubleshooting

If recommendations say `run_more_evals`, run both baseline and candidate
evaluations before trying to promote anything.

If the dashboard shows stale queued work, open `/queue`, use **Requeue Running**
for interrupted stages, then process a worker batch or restart:

```bash
npm run worker:daemon
```

If provider checks fail, confirm the selected provider in `.env` and run:

```bash
npm run provider-check
```

Do not paste API keys into issues, screenshots, or shared docs.
