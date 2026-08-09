# Tellara Integration

This repository can operate as the shared workflow runner for Tellara while keeping Tellara-specific context inside the Tellara repository.

See [Open Source Boundary](open-source-boundary.md) for the public/private line: Agent Workflow should share reusable orchestration, safety, routing, and observability patterns, while Tellara-specific agent engine logic stays project-local or private.

## Install The Profile

From this repository:

```bash
npm run init-project -- --project /Users/jasonmiller/Projects/media-ai-startup --profile tellara
```

The Tellara profile writes `.agent-workflow/` files and `README.agent-workflow.md`. It does not replace Tellara's existing `AGENTS.md` unless `--force` is explicitly passed.

## Index Tellara

```bash
npm run index-project -- --project /Users/jasonmiller/Projects/media-ai-startup --max-files 300
npm run project-files -- --project /Users/jasonmiller/Projects/media-ai-startup --limit 25
```

## Run A Safe Workflow

Use `mock` first to verify queueing, context compilation, receipts, and export behavior without model spend or file changes:

```bash
DEFAULT_MODEL_PROVIDER=mock \
npm run agentflow -- run review-pr \
  --project /Users/jasonmiller/Projects/media-ai-startup \
  --task "Review current Tellara project context and summarize readiness risks. Do not request commands or file writes." \
  --no-brief

DEFAULT_MODEL_PROVIDER=mock npm run worker -- --limit 6
npm run status
```

## Run A Live Provider

After the mock path is healthy:

```bash
DEFAULT_MODEL_PROVIDER=openai npm run provider-smoke
```

Then queue a real Tellara workflow:

```bash
npm run agentflow -- run build-feature \
  --project /Users/jasonmiller/Projects/media-ai-startup \
  --task "<Tellara task>" \
  --source-token-budget 5000 \
  --source-max-files 40 \
  --no-brief

npm run worker -- --limit 6
```

## Export The Result

```bash
npm run agentflow -- status --run <workflow-run-id> --artifacts
npm run export-run -- --run <workflow-run-id>
```

## Tellara Guardrails

- Tellara's root `AGENTS.md` remains authoritative.
- `pnpm verify` is allowed but heavy.
- Destructive local reset commands are blocked by project policy.
- Writes are blocked for `.env*`, `.git/**`, `node_modules/**`, `.next/**`, Terraform, Notion imports, generated AI Staff assets, and build outputs.
- Infrastructure and deployment work should still use Tellara's isolated-worktree practice when risk warrants it.
