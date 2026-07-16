# Tellara Portable Agent Workflow Profile

This profile is installed from the shared Portable Agent Workflows repository.

It intentionally does not replace Tellara's existing `AGENTS.md`. Tellara's root `AGENTS.md` remains the primary project-level instruction file.

Use from the workflow repo:

```bash
npm run index-project -- --project /Users/jasonmiller/Projects/media-ai-startup --max-files 300
npm run agentflow -- run review-pr --project /Users/jasonmiller/Projects/media-ai-startup --task "<task>" --no-brief
npm run worker -- --limit 6
npm run agentflow -- status --run <workflow-run-id> --artifacts
npm run export-run -- --run <workflow-run-id>
```
