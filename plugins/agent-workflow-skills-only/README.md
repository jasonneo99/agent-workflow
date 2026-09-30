# Agent Workflow directory edition

This is the skills-only public-directory package for Agent Workflow. It helps
people understand and install the full local-first Codex plugin without routing
their projects through a hosted Agent Workflow service.

The full plugin is distributed from the public Agent Workflow Git marketplace:

```bash
codex plugin marketplace add jasonneo99/agent-workflow --ref master
codex plugin add agent-workflow@agent-workflow
```

That package includes a pinned compiled Agent Workflow runtime and runs its MCP
server locally. This directory edition contains no `mcp.json`, executable
runtime, remote service binding, credentials, or user data.

See the [full plugin README](https://github.com/jasonneo99/agent-workflow/blob/master/plugins/agent-workflow/README.md)
for runtime details.
