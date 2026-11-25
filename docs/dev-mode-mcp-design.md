# Dev mode over MCP — design

Status: approved direction (Jason, 2026-11-25). The plumbing for Studio Dev mode
should be Agent Workflow, not the dashboard HTTP server. This note fixes the
MCP tool contract and the transport decision before implementation.

## Context

- Studio Dev mode today talks to the dashboard HTTP API (`/api/dev-session*`,
  SSE stream) on 127.0.0.1:17888, via `src-tauri/src/dev_sessions.rs`.
- The dev-session logic already exists as importable TypeScript:
  `apps/cli/src/commands/dev-session-routes.ts` (thin HTTP adapter) over
  `packages/storage/src/dev-sessions.ts`,
  `packages/workflow-engine/src/direct-turn.ts` (`runDirectTurn`),
  `packages/workflow-engine/src/dev-diff-decisions.ts` (`decideDevSessionDiff`).
- The MCP server (`apps/mcp`, name `portable-agent-workflows`, stdio transport)
  has NO dev-session tools today. Its tools wrap the `agentflow` CLI via
  `runAgentflow` (orchestrate, approvals, doctor, validate, context, reporting).
- There is NO CLI command for dev sessions. The dev-session API is only
  reachable via the dashboard HTTP routes today.
- The web-dashboard Dev panel STAYS as-is. The MCP path is for the Studio Mac
  app only. The dashboard HTTP Dev mode is not removed or broken by this work.

## Decision 1 — the MCP tools (mirror the dev-session API)

Six tools, all prefixed `agentflow_dev_*`, following the server's existing
`server.registerTool(name, { title, description, inputSchema (zod) }, handler)`
pattern. Inputs and outputs mirror `dev-session-routes.ts` so the Studio
transport is a mechanical swap.

| Tool | Inputs | Returns |
|---|---|---|
| `agentflow_dev_session_create` | `project` (dir), `provider?`, `model?`, `title?` | `{ session }` — same shape as `createDevSessionFromBody` |
| `agentflow_dev_sessions_list` | `project?` | `{ sessions: DevSession[] }` — same as `listDevSessionsForBody` |
| `agentflow_dev_session_get` | `sessionId` | `{ session, turns, diffs, approvals, hunks }` — same as `getDevSessionDetail` |
| `agentflow_dev_turn` | `sessionId`, `message`, `openFiles?`, `provider?`, `model?` | `{ turnId, stoppedReason, summary, usage, iterations, diffIds, events: DevTurnEvent[] }` (see Decision 2) |
| `agentflow_dev_diff_decide` | `sessionId`, `diffId`, `decision` (`accept`\|`reject`), `hunkIndex?`, `actor?` | result of `decideDevSessionDiff` |
| `agentflow_dev_approval_decide` | `sessionId`, `approvalId`, `decision` (`approved`\|`rejected`), `actor?` | `{ approval, resumeHint }` — same as `decideDevSessionApprovalFromBody` |

Validation mirrors the routes module (missing project/message, bad decision
strings, unknown session/diff/approval ids, diff/approval not belonging to the
session). Errors are returned as MCP tool errors with the same messages the
HTTP routes throw, so Studio's existing error handling still applies.

## Decision 2 — streaming: run the turn to completion, return the full event list

MCP tools are request/response; there is no server-push stream. The turn tool
calls `runDirectTurn` directly, collects every event through its `onEvent`
callback, and returns the complete ordered `events[]` plus the turn result.

Why this preserves Dev mode:

- `runDirectTurn` RETURNS on approval pause; it never blocks waiting for a
  user decision. When a turn hits an inline gate it emits
  `turn_awaiting_approval`, persists the pending approval row, and returns
  with `stoppedReason: "awaiting_approval"`. There is therefore no deadlock:
  the turn tool returns, Studio shows the approval card, the user decides via
  `agentflow_dev_approval_decide`, and the resume hint is sent as a new
  `agentflow_dev_turn` — exactly the flow the dashboard HTTP path uses today.
- Studio's frontend already renders from an event list. The Rust transport
  feeds the returned `events[]` through the same `dev-session-event` Tauri
  event pipeline the SSE thread feeds today, so diff proposals, approval
  cards, and the Proposed changes view behave identically.
- The only behavior change is arrival timing: events arrive as one batch at
  turn end instead of trickling live. For the mock provider and typical short
  turns this is imperceptible; for long real turns the panel shows a working
  state until the turn completes, then the events land at once.

Rejected alternative — MCP progress notifications (`notifications/progress`):
the SDK supports them, but the Rust client would have to correlate in-flight
notifications with the pending tool call, and a dropped or mis-ordered
notification would silently lose events. The batch return is simpler, lossless
(because the event list is the tool result itself), and keeps the approval
pause/resume flow identical. If live trickling is ever wanted, it can be added
later without changing the tool contract (the event list is already ordered).

## Decision 3 — direct function calls, NOT via the CLI (`runAgentflow`)

The dev-session MCP tools call the underlying functions directly (imported
from `packages/storage` and `packages/workflow-engine`, the same imports
`dev-session-routes.ts` already uses). They do NOT go through `runAgentflow`
/ a new CLI command. Reasons:

1. No CLI command exists for dev sessions. Adding one only to wrap it for MCP
   is indirection with no benefit.
2. The turn's `onEvent` callback must be in-process to collect events. Via a
   CLI subprocess the events would need JSON-lines over stdout and re-parsing,
   and the CLI does not emit them today.
3. `toolResult` truncates output to `AGENTFLOW_MCP_MAX_OUTPUT_CHARS` (12,000
   by default, head + tail). A turn's event list routinely exceeds that, and
   truncation would corrupt the event JSON. The dev tools therefore build
   their result JSON directly and do NOT pass through `toolResult`. (The MCP
   SDK itself imposes no such limit; the 12k cap is this codebase's helper.)
4. Direct imports are already established in this server: it imports
   `buildClientCapabilityContract` from `packages/client-capabilities` and
   `findAgentWorkflowRoot` from `packages/runtime-root` today.

The one cost is consistency: most MCP tools wrap the CLI. That pattern fits
tools that are naturally CLI-shaped (doctor, validate, orchestrate). Dev
sessions are not CLI-shaped — they are an in-process, event-driven API — so
the direct-call form is the right one here, and this note records why.

## Decision 4 — Studio transport (Rust MCP client over stdio)

- Studio adds an MCP client using `rmcp` (the Rust MCP SDK), speaking
  JSON-RPC over stdio to the MCP server process.
- Studio spawns the MCP server from the AW checkout/sidecar (the compiled
  `apps/mcp` entrypoint) as a child process, loopback-only, same as the
  dashboard is today. No network port is involved.
- `dev_sessions.rs` swaps its HTTP calls for MCP tool calls, keeping the same
  Tauri event emission (`dev-session-event`) so the frontend (`dev-mode.ts`,
  approval cards, Proposed changes view) is unchanged.
- The dashboard HTTP path in Studio is left in place as a fallback; it is
  not removed. The build must not break either way.
- For local testing Studio points at a locally-built MCP server from the AW
  checkout. The published-release repin comes later (see Release note).

## Release note

These tools are NEW AW code for the NEXT release after 0.4.12 (already
published). Do NOT bump the version, regenerate the bundle, or sign anything
in this work. A future release + Studio repin will be needed before Studio
can use the published MCP tools. Local testing uses the checkout build.

## Open risks

- Long real-provider turns block the MCP tool call until the turn completes
  (or pauses for approval). No timeout is imposed by the dev tools themselves;
  Studio should surface a working state and allow cancel via the existing
  abort path. If turns routinely exceed a few minutes, revisit with a
  start-turn / poll-events split — but that changes the tool contract, so it
  is a separate decision, not part of this work.
- The MCP server process lifecycle in Studio (spawn, stdio, restart on crash)
  needs the same care as the dashboard lifecycle (`standalone.rs`): never
  start a second server, never leave a stale one running, log redacted output.
