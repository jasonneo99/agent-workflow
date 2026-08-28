# Contributing

Thanks for helping improve Agent Workflow. This project is a portable, model-agnostic developer workflow kit, so contributions should stay reusable across projects, model providers, and MCP-capable tools.

## Local Setup

```bash
git clone https://github.com/jasonneo99/agent-workflow.git
cd agent-workflow
npm install
cp .env.example .env
npm run setup
```

For deterministic local checks, use the mock provider:

```env
DEFAULT_MODEL_PROVIDER=mock
```

Run the contributor check before opening a PR:

```bash
npm run check
```

## Project Boundaries

Keep this repository focused on reusable developer workflows. Before adding domain-specific behavior, read [Open Source Boundary](docs/open-source-boundary.md).

Good contributions usually improve:

- reusable agent definitions
- composable workflow definitions
- provider-neutral model routing
- local developer ergonomics
- dashboard visibility
- docs, examples, and tests
- project template safety

Avoid committing:

- secrets, API keys, tokens, or private signing keys
- `.env` files
- local runtime state under `.agent-workflow/runtime/`
- private project context or customer data
- absolute machine-specific paths
- generated artifacts that are not scrubbed examples

## Agents

Reusable agent cards live in `agents/**/*.yaml`.

When adding or changing an agent:

- keep the prompt compact and role-specific
- avoid project-specific names, customers, schemas, or business rules
- define clear responsibilities and outputs
- prefer model-neutral instructions
- run `npm run validate`

Project-specific agents belong in a consuming project's `.agent-workflow/agents/`, not in this shared repository.

## Workflows

Reusable workflows live in `workflows/**/*.yaml`.

When adding or changing a workflow:

- keep stages narrow and auditable
- use existing agents when possible
- require receipts for meaningful actions
- avoid hidden provider assumptions
- document expected use in the user guide when user-facing behavior changes

Run:

```bash
npm run validate
npm run check
```

## Docs And Examples

Update docs when behavior changes. Start with:

- [User Guide](docs/user-guide.md)
- [Provider Matrix](docs/providers.md)
- [MCP Client Setup](docs/mcp-clients.md)
- [Release Guide](docs/release.md)

Use scrubbed examples for public docs or issue reports:

```bash
npm run export-run -- --run <run-id> --scrub
npm run validate-examples
```

Scrubbed examples must not contain local paths, emails, secrets, compiled briefs, raw command output, private prompts, tenant details, customer details, or product-specific task text.

## Release Work

Most contributors do not need release credentials. Use:

```bash
npm run release:check -- --allow-current-version
```

Maintainer-only release steps are documented in [Release Guide](docs/release.md). Do not commit maintainer-local signing paths, private keys, or npm credentials.

## Pull Requests

Before opening a PR:

```bash
npm run check
```

Include a short description of:

- what changed
- why it belongs in the shared open-source workflow kit
- what checks you ran
- any docs or examples updated
