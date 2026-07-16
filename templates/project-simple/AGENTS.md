# AGENTS.md

This project uses the shared Portable Agent Workflows kit in simple mode.

Project-specific context lives in `.agent-workflow/`. Reusable agents, workflows, policies, and automation live outside this repository. Simple mode does not require Postgres, Redis, or object storage.

## Agent Workflow Rules

- Read `.agent-workflow/project.yaml` before choosing a workflow.
- Use `.agent-workflow/context.md` for product and architecture context.
- Use `.agent-workflow/commands.md` for setup, test, build, and release commands.
- Use `.agent-workflow/decisions.md` for durable project decisions.
- Do not duplicate global agent prompts in this project.
- Keep subagent outputs compact and structured.
- Write receipts for automatic actions.
- Automatic file writes must stay inside paths allowed by `.agent-workflow/project.yaml`.

## Recommended Commands

```bash
npm run agentflow -- compile --workflow build-feature --project . --task "<task>"
npm run agentflow -- compile --workflow review-pr --project . --task "<review task>"
npm run agentflow -- compile --workflow debug-failure --project . --task "<failure>"
npm run agentflow -- compile --workflow maintain-context --project . --task "<context maintenance>"
```
