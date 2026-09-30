# Agent Workflow Codex plugin

This local plugin makes the Agent Workflow MCP server and operating skill
available from any trusted Codex project on the same machine. Distribution
packages include a pinned compiled Agent Workflow runtime and its production
dependencies, so users do not need a repository clone, global npm install, or
first-run network download. Node.js 24 or newer is still required to execute the
local MCP process.

The plugin resolves the runtime in this order:

1. bundled runtime under `runtime/`
2. `AGENT_WORKFLOW_HOME` for development overrides
3. the enclosing Agent Workflow repository when running from source
4. a globally installed `agentflow-mcp` executable as a legacy fallback

Agent Workflow Studio is an optional companion UI over the same engine. The
plugin does not bundle or launch a second Studio runtime.

## Build the self-contained runtime

From the Agent Workflow repository:

```bash
node plugins/agent-workflow/scripts/bundle-runtime.mjs
```

The script downloads the exact published npm version pinned in
`runtime-version.json`, installs its production dependencies beneath `runtime/`,
removes npm bin symlinks, and records package integrity in
`runtime/runtime-manifest.json`.
The generated runtime is ignored by Git but must be included in the
distributable plugin ZIP and local marketplace source. The build also creates
`runtime-bundle.tgz` plus a SHA-256 file. Those two regular files are committed
for public Git marketplace installs; the launcher verifies and extracts the
archive into the user's cache without a network request.

## Brand assets

- `assets/agent-workflow-logo.png` is the square mark for plugin listings,
  composer icons, avatars, and other constrained icon surfaces.
- `assets/agent-workflow-wordmark.png` is the horizontal lockup for wide
  onboarding, documentation, headers, and Studio or plugin views with enough
  horizontal space. Do not squeeze the wordmark into square icon slots.

For source-marketplace installation, point the marketplace entry at this
directory, then install `agent-workflow@<marketplace-name>` and restart Codex.
