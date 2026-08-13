# Agent Workflow Commands

Recommended safe commands for local self-dogfooding:

- `npm run typecheck`
- `npm run validate`
- `npm run validate-examples`
- `npm run provider-check`
- `npm run list`
- `npm run status`
- `npm run agentflow -- list`
- `npm run agentflow -- status`
- `npm run index-project -- --project . --max-files 100`

Project onboarding commands:

- `npm run onboard-project -- --project . --profile enterprise --write`
- `npm run init-project -- --project . --profile enterprise`

Use `onboard-project --write` for the recommended first setup because it writes project config, durable context, command notes, decisions, and schedules. Use `init-project` when only the base `.agent-workflow/project.yaml` is needed.
