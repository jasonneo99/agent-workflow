# MCP Client Setup

Agent Workflow can be used from any MCP-capable client. The MCP server is local stdio and reuses this repo's CLI, `.env`, provider config, storage config, project policies, and workflow definitions.

For model-provider pairings and copyable end-to-end examples, see [Integration Examples](integration-examples.md).

## Install Once

Install the compiled package without cloning:

```bash
npm install --global @jasonneo99/agent-workflow
agentflow-setup
agentflow ide-onboard --project /path/to/project --write --check
```

The standalone MCP executable is `agentflow-mcp`. IDE onboarding resolves its installed compiled entrypoint to an absolute Node command, avoiding IDE shell `PATH` differences.

For repository development:

```bash
git clone https://github.com/jasonneo99/agent-workflow.git
cd agent-workflow
npm install
cp .env.example .env
npm run setup
npm run provider-check
```

## Generate And Validate Workspace Setup

Preview ready-to-use snippets for all supported IDEs:

```bash
npm run ide-onboard -- --project /path/to/project
```

Safely merge them into `.vscode/mcp.json`, `.cursor/mcp.json`, and the trusted project's `.codex/config.toml`:

```bash
npm run ide-onboard -- --project /path/to/project --write
```

Existing unrelated JSON servers and settings are preserved. An existing Codex `agent-workflow` table is left unchanged. Add `--client vscode`, `--client cursor`, or `--client codex` to configure one surface. Add `--check` to probe enterprise storage and the configured provider in addition to checking project context and reusable definitions.

```bash
npm run ide-onboard -- --project /path/to/project --client codex --check
```

Add YAML schema validation for Agent Workflow files in VS Code or Cursor:

```bash
npm run agentflow -- schemas --project /path/to/project --write-vscode
```

Codex CLI, its IDE extension, and the desktop app share MCP configuration on the same host. Project-scoped `.codex/config.toml` is loaded only for trusted projects, so reload the IDE and trust the workspace after installation.

If a client reports `Transport closed`, restart that IDE/client to create a
fresh stdio subprocess. Agent Workflow also writes MCP lifecycle breadcrumbs to
`.agent-workflow/runtime/mcp/stdio.log` and launcher breadcrumbs to
`.agent-workflow/runtime/mcp/launcher.log` so you can distinguish a closed
client pipe from a dashboard, worker, provider, or storage outage. Run
`npm run runtime-monitor -- --check-mcp` from the Agent Workflow repo to verify
the launcher and tool list independently of the IDE/client's private stdio
transport. The logs intentionally exclude `.env` values, provider keys,
database URLs, storage secrets, prompt bodies, and artifacts.
The `/server-readiness` Runtime Monitor panel shows the same check plus a
Codex / IDE Reload Guidance callout for the common case where the launcher
smoke passes but the client still has a stale private pipe.
It also shows metadata-only approval-call diagnostics for `agentflow_approvals`
and command spans for every MCP-launched CLI operation, so approval failures or
long-running tool calls can be correlated with launcher lifecycle events and
CLI fallback receipts without exposing command text, approval notes, prompts,
artifacts, or secrets.
MCP responses are compacted by default for stdio stability. Increase
`AGENTFLOW_MCP_MAX_OUTPUT_CHARS` only for clients that tolerate larger payloads;
for complete output, run the CLI command printed in the MCP response.

For BYO model usage, `.env` only needs a reachable OpenAI-compatible endpoint:

```env
DEFAULT_MODEL_PROVIDER=byo
BYO_MODEL_BASE_URL=http://localhost:11434/v1
BYO_MODEL_NAME=auto
BYO_MODEL_API_KEY=not-required
```

## VS Code

Add a workspace config at `.vscode/mcp.json` in the project where you want to use Agent Workflow, or add it to your VS Code user MCP config.

```json
{
  "servers": {
    "agentWorkflow": {
      "type": "stdio",
      "command": "npm",
      "args": ["run", "-s", "mcp"],
      "cwd": "/absolute/path/to/agent-workflow"
    }
  }
}
```

Then run `MCP: List Servers` from the Command Palette and start `agentWorkflow`.

## Cursor

Add this through Cursor Settings > Tools & Integrations > MCP Tools, or place it in `.cursor/mcp.json` for a workspace-level setup.

```json
{
  "mcpServers": {
    "agentWorkflow": {
      "command": "npm",
      "args": ["run", "-s", "mcp"],
      "cwd": "/absolute/path/to/agent-workflow"
    }
  }
}
```

Then enable the server in Cursor MCP settings.

## Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-workflow]
command = "npm"
args = ["run", "-s", "mcp"]
cwd = "/absolute/path/to/agent-workflow"
startup_timeout_sec = 120
```

Restart Codex after changing MCP configuration.

### Workflow callbacks

For local Codex plugin calls, Agent Workflow binds each CLI child to the host's
MCP request `_meta.threadId`. Tool arguments and project configuration cannot
choose this binding. Concurrent calls keep separate origins; calls without host
metadata do not inherit a chat ID from the shared MCP process. Invalid host IDs
fail before execution. This routing identity grants no approval authority.

After updating the plugin runtime, reload the client's MCP connections before
testing callbacks. A previously running server retains its loaded code. Verify
the run's recorded origin, callback arrival in that same chat, and durable
acknowledgment separately; a successful CLI-only test does not validate the
plugin path.

For an unpublished local runtime fix, build an isolated reviewed engine package
and pass its tarball with `AGENTFLOW_PLUGIN_RUNTIME_TARBALL` to the plugin's
`scripts/bundle-runtime.mjs`. The installed package must match the runtime pin
and contain the request-origin adapter. Keep build provenance in local receipts;
this does not publish a release or adopt unrelated checkout changes.

Codex callbacks preserve the requesting thread identity and use `codex queue`
to enqueue an evidence-inspection message into that session. The adapter
validates the returned message UUID and destination thread before recording
transport acceptance. It does not start a second CLI writer.

Queue acceptance, arrival in the originating task, and durable acknowledgment
are separate evidence. A successful process exit or `requester_notified`
receipt does not establish acknowledgment. Correlate the notification, run and
originating task when inspecting arrival and recording acknowledgment.

The installed Codex CLI must support `queue` and its correlated receipt format.
Missing capability, failed delivery or an invalid receipt leaves transport
unconfirmed for retry. Keep heartbeat fallback until live arrival is accepted
for the target environment; local desktop evidence does not establish support
on every operating system. Measure host-turn latency separately from durable
acknowledgment latency and record timestamp precision and restart overhead.

Callbacks grant no approval, repair, retry or execution authority. Automatic
repair requires its separate explicit activation; callback delivery cannot enable it.

## Example Prompts

```text
Use Agent Workflow to orchestrate this project for "Review production readiness, UX, SEO, and launch risks."
```

```text
Use Agent Workflow to have the UX reviewer do a pass on this app and export the report.
```

```text
Use Agent Workflow to update my model provider to BYO and run a provider check.
```

```text
Use Agent Workflow to onboard this project, write the recommended config, then tell me the next command to run.
```

```text
Use Agent Workflow to add editor schema validation to this workspace.
```

```text
Use Agent Workflow to run-and-watch the build-feature workflow for "Add audit logging."
```

For review requests from Codex, VS Code, or Cursor, prefer run-and-watch behavior. The MCP `agentflow_run_workflow` tool now processes worker stages by default; use `queueOnly=true` only when a separate worker is already running.

## Notes

- The MCP client is only the control surface. The model provider is configured in Agent Workflow's `.env`.
- BYO works the same from VS Code, Cursor, Codex, terminal, or automation.
- Keep reusable agents and workflows in Agent Workflow. Keep project-specific context in each target project's `AGENTS.md` and `.agent-workflow/`.
# Callback flood protection

Codex outbound delivery coalesces obsolete, unclaimed progress for the same run,
channel and originating task. Original rows, event identities and bodies remain
in storage with `coalesced_at`, `coalesced_into` and a reason. Blockers, failures,
approval/action-required notices and completion notifications are retained.
Active claims and other projects or destinations are not coalesced.

Before calling the non-idempotent queue transport, delivery is durably marked
`delivery_uncertain`. A valid queue receipt is persisted immediately with its
message identity and acceptance timestamp; dispatcher settlement is separate.
Known accepted deliveries are not sent again even if the dispatcher dies before
settlement. Queue acceptance never proves originating-task acknowledgment.

A definite transport rejection may retry with backoff. An ambiguous timeout,
malformed response or crash after transport begins requires reconciliation;
it is not automatically retried. Operators must independently establish arrival
or definite non-delivery before resolving that state. This favors avoiding
duplicate sends and does not claim exactly-once delivery from a queue transport
without an idempotency or lookup capability. These fields and states are added
by the normal storage bootstrap migration; no notification history is deleted.
