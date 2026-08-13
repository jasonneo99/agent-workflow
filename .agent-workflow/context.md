# agent-workflow Context

Portable Agent Workflows is a local-first developer workflow kit for reusable agents, automatic agents, multi-stage workflows, MCP tools, dashboard controls, and enterprise local storage. The goal is to keep reusable workflow logic outside target projects while each project contributes compact local context through `AGENTS.md` and `.agent-workflow/`.

## Detected Stack

- Package manager: npm
- Runtime: Node.js and TypeScript
- Services: Postgres with pgvector, Redis, and MinIO through Docker Compose
- Interfaces: CLI, MCP server, local dashboard, and project templates
- Languages: javascript, typescript

## Personalization Notes

- Prefer model-portable provider adapters and BYO model configuration over environment-specific assumptions.
- Optimize for developer cost savings, compact context, durable receipts, and useful artifacts.
- Keep open-source Agent Workflow focused on local developer workflows; avoid adding Tellara proprietary product logic.
- Dashboard and MCP features should make workflows easy to run from Codex, Cursor, VS Code, or a terminal.
- Keep durable preferences here instead of repeating them in every prompt.

## Repository Map

- `agents/`: reusable and automatic agent definitions.
- `workflows/`: reusable workflow definitions.
- `apps/cli/`: CLI, dashboard server, provider adapters, worker, storage, and orchestration logic.
- `apps/mcp/`: MCP integration surface.
- `packages/`: shared runtime packages.
- `templates/project/`: installable project template and smoke target.
- `docs/`: user guides, roadmap, integration notes, and example exports.
- `infra/`: local enterprise storage services.
