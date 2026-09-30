# Agent Workflow Plugin Privacy Notice

Effective: September 30, 2026

The Agent Workflow Codex plugin runs locally on the user's computer. The plugin
publisher does not operate a server that receives project files, prompts,
workflow outputs, credentials, or usage telemetry from the plugin.

The plugin can read local project files and run local processes when the user
asks Codex to use Agent Workflow. Agent Workflow stores project configuration,
receipts, run evidence, and artifacts locally or in storage endpoints configured
by the user. Users control those projects, endpoints, retention settings, and
deletion of that data.

Agent Workflow may send prompts or bounded project context to the model provider
selected by the user. Those transfers are governed by the user's provider
configuration and the provider's terms and privacy policy. The plugin does not
embed a publisher API key or silently select a hosted provider.

To remove the plugin, uninstall it from Codex. Users may separately delete the
plugin extraction cache and project-local `.agent-workflow/` data. Removing the
plugin does not delete information already sent to a user-selected provider or
stored in a user-configured external service.

Security or privacy questions may be reported through the repository's public
issue tracker. Do not include credentials, private source code, or sensitive
project data in a public issue.
