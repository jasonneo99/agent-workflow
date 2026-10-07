# Contract Tests

Contract tests help extension authors verify reusable definition packs,
project-local agents, and provider adapters before sharing or adopting them.

## Durable Action-Result Continuation

```bash
npm exec -- node --import tsx --test packages/workflow-engine/src/action-result-continuation.test.ts
npm exec -- node --import tsx scripts/test-continuation-postgres.ts
```

The first command exercises real workers with mocked storage. The opt-in second
command uses live PostgreSQL and requires CREATEDB and the extensions in
`infra/init.sql`. It creates a uniquely named synthetic database, runs harmless
`node --version` commands, and drops that exact database in its `finally` block.
Acceptance requires successful assertions and the printed cleanup result.
Separate worker processes prove retained results and state are consumed before
completion, repeated commands reuse receipts, and stale workers are fenced.

Unchanged evidence checkpoints at 5, 10, and 20 seconds before terminal blocking. Validation also requires `npm run typecheck`, `npm run build`, `npm test`, and `npm run validate-boundary`; supervisor terminal receipt checks remain separate.

## Default Safe Check

Run against the built-in bundle and mock provider:

```bash
agentflow contract-test
```

Run against a custom definition bundle:

```bash
agentflow contract-test --definitions /path/to/agent-workflow-pack
```

Include project-local agents from `.agent-workflow/agents`:

```bash
agentflow contract-test --project /path/to/project
```

The check validates:

- agent schema compatibility
- workflow schema compatibility
- unique agent and workflow ids
- unique stage ids
- workflow lead, stage agent, and subagent references
- provider output shape

## Provider Adapters

By default, provider execution uses `mock` so checks are deterministic and
cost-free:

```bash
agentflow contract-test --provider mock
```

Non-mock providers are loaded but not executed unless explicitly allowed:

```bash
agentflow contract-test --provider byo --live-provider
```

Live provider contract tests send a small synthetic prompt and expect a
non-empty summary plus an artifact object. They do not grant command or file
write permissions.

## MCP

MCP clients can call `agentflow_contract_test`.

Example prompt:

```text
Use Agent Workflow to contract-test this project with the mock provider.
```
