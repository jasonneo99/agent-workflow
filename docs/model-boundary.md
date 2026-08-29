# Model Boundary

Agent Workflow can help local developers decide how to improve model-backed
workflows without turning the open source package into a model-training
platform.

The project should stay local-first, provider-neutral, and inexpensive to run.
It may create plans, evidence, comparison reports, and project-local notes. It
should not host private datasets, large model artifacts, model registries, or
GPU training infrastructure.

## Belongs In Agent Workflow

- Provider-neutral model routing and fallback rules.
- Prompt, context, retrieval, and routing tuning proposals.
- Evaluation suites, evaluation gates, and regression budgets.
- Candidate comparison plans and reports.
- Cost, latency, fallback, quality, and feedback summaries.
- Reviewable fine-tune or model-improvement plans.
- Project-local approval queues, pins, receipts, and tuning notes.
- Scrubbed public examples that preserve workflow shape without private data.

These artifacts are small, auditable, and useful across Codex, Cursor, VS Code,
Claude Code, Aider, and other MCP-capable or CLI-based developer workflows.

## Stays Outside The Core Package

- GPU training jobs and training schedulers.
- Hosted model registry infrastructure.
- Fine-tune dataset storage and dataset upload automation.
- Private customer datasets or production transcripts.
- Large model weights, adapters, checkpoints, embeddings dumps, and artifacts.
- Product-specific scoring formulas, ranking models, or proprietary eval cases.
- Production inference fleet management.

Those systems can consume Agent Workflow outputs, but they should live in a
private project, provider platform, or enterprise ML system.

## Practical Rule

Agent Workflow may say:

```text
The evidence supports testing a cheaper standard-tier model for docs stages,
and a reasoning-tier fallback for security review stages.
```

Agent Workflow may write:

```text
.agent-workflow/model-improvement/model-improvement-plan.json
.agent-workflow/evaluations/provider-comparison.yaml
.agent-workflow/tuning/routing-preferences.md
```

Agent Workflow should not write:

```text
training-data/customer-transcripts.jsonl
models/fine-tuned-reviewer.gguf
registry/production-model-catalog.db
```

## Safe Integration Pattern

Use Agent Workflow as the evidence and governance layer:

1. Capture feedback on local workflow runs.
2. Generate tuning proposals or a model-improvement plan.
3. Create private project-local eval cases only from approved feedback.
4. Compare baseline and candidate routing choices.
5. Record promotion recommendations as reviewable project-local notes.
6. Hand off any training, hosted registry, or production model deployment to an
   external system.

The handoff can be a file, ticket, command plan, or provider job plan, but the
open source package should not perform the heavyweight or private operation by
default.

## Open Source Review Checklist

Before adding model-improvement functionality, ask:

- Does this work without a specific provider account?
- Does it avoid storing private data in the shared repository?
- Does it produce a reviewable plan instead of performing irreversible actions?
- Does it keep large artifacts outside npm package contents?
- Does it preserve project-local ownership of context, evals, and tuning notes?
- Can a developer understand the cost, quality, and safety tradeoff from the
  generated evidence?

If the answer is no, keep the feature as private project code or make the open
source version a plan-only integration point.
