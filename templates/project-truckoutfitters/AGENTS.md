# AGENTS.md

This project uses the shared Portable Agent Workflows kit for Truck Outfitters Unlimited.

Project-specific context lives in `.agent-workflow/`. Reusable agents, workflows, policies, and automation live outside this repository.

## Agent Workflow Rules

- Treat the public site as production-facing.
- Read `.agent-workflow/project.yaml` before choosing a workflow.
- Use `.agent-workflow/context.md` for business, audience, and site architecture context.
- Use `.agent-workflow/commands.md` for safe local validation commands.
- Use `.agent-workflow/decisions.md` for durable project decisions.
- Keep generated reports in `.agent-workflow/exports/`.
- Do not write secrets, credentials, or external WordPress credentials into the repository.
- Automatic writes must stay inside paths allowed by `.agent-workflow/project.yaml`.

## Recommended Commands

```bash
npm run agentflow -- orchestrate --project . --task "<natural-language task>"
npm run agentflow -- run-and-watch review-pr --project . --task "<review task>"
npm run agentflow -- agent-task Mira --project . --task "<ux task>"
```
