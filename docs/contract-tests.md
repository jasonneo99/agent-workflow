# Contract Tests

Contract tests help extension authors verify reusable definition packs,
project-local agents, and provider adapters before sharing or adopting them.

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
