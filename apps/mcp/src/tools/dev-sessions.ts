import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v3";
import {
  createDevSessionFromBody,
  decideDevSessionApprovalFromBody,
  decideDevSessionDiffFromBody,
  getDevSessionDetail,
  listDevSessionsForBody,
  resolveDevProject
} from "../../../../apps/cli/src/commands/dev-session-routes.js";
import {
  DEV_MODE_MAX_ITERATIONS,
  getDevSessionOrThrow,
  runDirectTurn,
  type DevTurnEvent,
  type DevTurnResult
} from "../../../../packages/workflow-engine/src/direct-turn.js";

/**
 * Dev mode (interactive editor sessions) over MCP.
 *
 * These tools mirror the dashboard HTTP dev-session API
 * (`apps/cli/src/commands/dev-session-routes.ts`) so the Studio transport is
 * a mechanical swap. They call the underlying functions directly — NOT via
 * `runAgentflow` / a CLI command, which does not exist for dev sessions and
 * could not carry the turn's `onEvent` callback in-process — and they build
 * their result JSON directly instead of passing through `toolResult`, whose
 * 12,000-character truncation would corrupt a turn's event list.
 * See `docs/dev-mode-mcp-design.md` (Decisions 1–3).
 *
 * Validation mirrors the routes module: the `decision` fields are plain
 * strings (not zod enums) and `hunkIndex` is a plain number on purpose, so
 * a bad value reaches the routes functions and surfaces their exact error
 * messages ("Decision must be accept or reject.", "hunkIndex must be a
 * non-negative integer.", ...) instead of a zod schema message.
 */

type DevToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function devToolResult(value: unknown): DevToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function registerDevSessionTools(server: McpServer): void {
  server.registerTool(
    "agentflow_dev_session_create",
    {
      title: "AgentFlow Dev session create",
      description:
        "Create a Dev mode session for interactive editor work in a project directory. Returns the session; send turns with agentflow_dev_turn.",
      inputSchema: {
        project: z.string().describe("Project directory."),
        provider: z.string().optional().describe("Model provider id; defaults to the configured provider, then mock."),
        model: z.string().optional().describe("Model override."),
        title: z.string().optional().describe("Session title.")
      }
    },
    async ({ project, provider, model, title }) => {
      const { session } = await createDevSessionFromBody({ project, provider, model, title });
      return devToolResult({ session });
    }
  );

  server.registerTool(
    "agentflow_dev_sessions_list",
    {
      title: "AgentFlow Dev sessions list",
      description: "List Dev mode sessions, optionally filtered to one project directory.",
      inputSchema: {
        project: z.string().optional().describe("Project directory; omit to list sessions across projects.")
      }
    },
    async ({ project }) => devToolResult({ sessions: await listDevSessionsForBody({ project }) })
  );

  server.registerTool(
    "agentflow_dev_session_get",
    {
      title: "AgentFlow Dev session detail",
      description: "Read one Dev mode session with its turns, proposed diffs, approvals, and diff hunks.",
      inputSchema: {
        sessionId: z.string().describe("Dev session id.")
      }
    },
    async ({ sessionId }) => devToolResult(await getDevSessionDetail(sessionId))
  );

  server.registerTool(
    "agentflow_dev_turn",
    {
      title: "AgentFlow Dev turn",
      description:
        "Send one message to a Dev mode session and run the turn to completion. Returns the turn result plus the full ordered event list (turn_started, token, tool_call, diff_proposed, turn_awaiting_approval, turn_completed). File writes become proposed diffs, never direct edits. A turn that hits an inline gate returns with stoppedReason awaiting_approval instead of blocking: decide the approval with agentflow_dev_approval_decide and send its resume hint as a new turn.",
      inputSchema: {
        sessionId: z.string().describe("Dev session id."),
        message: z.string().describe("Owner message for this turn."),
        openFiles: z.array(z.string()).optional().describe("Project-relative open files to include as context."),
        provider: z.string().optional().describe("Model provider id override."),
        model: z.string().optional().describe("Model override.")
      }
    },
    async ({ sessionId, message, openFiles, provider, model }) => {
      const trimmed = message.trim();
      if (!trimmed) throw new Error("Missing message.");
      const session = await getDevSessionOrThrow(sessionId);
      const { projectDir, project } = await resolveDevProject(session.projectRootUri);
      const events: DevTurnEvent[] = [];
      let result: DevTurnResult;
      try {
        result = await runDirectTurn({
          session,
          projectDir,
          project,
          message: trimmed,
          openFiles: openFiles ?? [],
          providerId: provider || undefined,
          modelOverride: model || undefined,
          maxIterations: DEV_MODE_MAX_ITERATIONS,
          toolsEnabled: true,
          onEvent: (event) => {
            events.push(event);
          }
        });
      } catch (error) {
        // runDirectTurn already emitted turn_failed and persisted the
        // failure, mirroring the dashboard SSE path. Return the collected
        // events (including turn_failed) as an error result instead of
        // dropping them behind a bare thrown message.
        const started = events.find((event) => event.type === "turn_started");
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  turnId: started?.turnId ?? "",
                  stoppedReason: "failed",
                  summary: "",
                  iterations: 0,
                  diffIds: [],
                  error: error instanceof Error ? error.message : String(error),
                  events
                },
                null,
                2
              )
            }
          ],
          isError: true
        };
      }
      return devToolResult({ ...result, events });
    }
  );

  server.registerTool(
    "agentflow_dev_diff_decide",
    {
      title: "AgentFlow Dev diff decision",
      description:
        "Accept or reject a proposed Dev mode diff, per file or per hunk. Accepting verifies the preimage and applies the exact proposed content; rejecting leaves the file untouched.",
      inputSchema: {
        sessionId: z.string().describe("Dev session id."),
        diffId: z.string().describe("Proposed diff id."),
        decision: z.string().describe("accept or reject."),
        hunkIndex: z.number().optional().describe("Hunk index for a per-hunk decision; omit to decide the whole diff."),
        actor: z.string().optional().describe("Deciding actor recorded in receipts.")
      }
    },
    async ({ sessionId, diffId, decision, hunkIndex, actor }) =>
      devToolResult(
        await decideDevSessionDiffFromBody({ sessionId, diffId, body: { decision, hunkIndex, actor } })
      )
  );

  server.registerTool(
    "agentflow_dev_approval_decide",
    {
      title: "AgentFlow Dev approval decision",
      description:
        "Answer a paused turn's inline approval. Approving authorizes the exact action once; the returned resume hint is the follow-up message to send as a new turn so the agent re-requests the approved action. Rejecting returns a null resume hint.",
      inputSchema: {
        sessionId: z.string().describe("Dev session id."),
        approvalId: z.string().describe("Pending approval id."),
        decision: z.string().describe("approved or rejected."),
        actor: z.string().optional().describe("Deciding actor recorded in receipts.")
      }
    },
    async ({ sessionId, approvalId, decision, actor }) =>
      devToolResult(
        await decideDevSessionApprovalFromBody({ sessionId, body: { approvalId, decision, actor } })
      )
  );
}
