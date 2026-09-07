# AGENTS.md

This project uses Agent Workflow for reusable agent workflows, project-specific context, and safe automation.

## Project Rules

- Read `.agent-workflow/project.yaml` before choosing a workflow.
- Use `.agent-workflow/context.md` for product, user, team, and personalization context.
- Use `.agent-workflow/commands.md` for setup, test, build, and release commands.
- Use `.agent-workflow/decisions.md` for durable project decisions.
- Keep reusable agents and workflows outside this project in the shared Agent Workflow repo.
- Keep project-specific preferences and constraints inside this project.
- Write receipts for automatic actions.
