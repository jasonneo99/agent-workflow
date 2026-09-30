# Public distribution and submission status

## Distribution

The plugin is distributed through the public Agent Workflow Git marketplace.
It contains a checksum-verified archive of the published Agent Workflow npm
runtime pinned in `runtime-version.json`. Installation does not require an Agent
Workflow clone, global npm package, or first-run network download. Node.js 24 or
newer is required.

## Review cases

Five positive and three negative cases are declared in `plugin.json`. They cover
runtime readiness, definition discovery, project indexing, a named specialist,
run-status reporting, unrelated questions, unsupported purchases, and
unavailable private repositories.

## Public directory blockers

The current plugin exposes a local stdio MCP server because its core purpose is
to operate on local projects, files, processes, and user-configured services.
OpenAI's public submission flow requires a verified remote HTTPS MCP endpoint;
repackaging this stdio process does not host it.

The pinned `0.4.6` MCP runtime also omits required boolean `readOnlyHint`,
`openWorldHint`, and `destructiveHint` annotations on its 72 tools. A future
submission needs a published runtime with reviewed annotations for every tool.

A public-directory submission additionally needs confirmed publisher identity,
country targeting, commerce declaration, a reviewer-accessible demo recording,
portal connection testing, and developer-completed legal attestations. These
items must not be marked complete from package preparation alone.
