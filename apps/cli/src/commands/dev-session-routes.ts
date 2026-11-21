import type http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import type { ProjectConfig } from "../../../../packages/agent-registry/src/schemas.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { resolveExecutionPolicy } from "../../../../packages/policy-engine/src/index.js";
import {
  appendDevSessionReceipt,
  createDevSession,
  decideDevSessionApproval,
  getDevSessionApproval,
  getDevSessionDiff,
  listDevSessionApprovals,
  listDevSessionDiffHunks,
  listDevSessionDiffs,
  listDevSessionTurns,
  listDevSessions,
  type DevSession
} from "../../../../packages/storage/src/dev-sessions.js";
import {
  DEV_MODE_AGENT_ID,
  DEV_MODE_MAX_ITERATIONS,
  getDevSessionOrThrow,
  runDirectTurn,
  type DevTurnEvent
} from "../../../../packages/workflow-engine/src/direct-turn.js";
import { decideDevSessionDiff } from "../../../../packages/workflow-engine/src/dev-diff-decisions.js";

/**
 * HTTP-facing Dev session handlers, called from the dashboard daemon
 * (`apps/cli/src/commands/daemon.ts`). Body parsing and the trusted-local
 * guard live in the daemon; this module validates payloads, resolves the
 * project, and drives the direct turn loop.
 */

export function parseDevSessionPath(pathname: string): { id: string; action: string; target: string } | null {
  const prefix = "/api/dev-session/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (rest.length === 0 || rest.length > 3) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(rest[0])) return null;
  return { id: rest[0], action: rest[1] ?? "", target: rest[2] ?? "" };
}

export function formatDevSseEvent(event: DevTurnEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

function stringArrayField(body: Record<string, unknown>, key: string): string[] {
  const value = body[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export async function resolveDevProject(projectInput: string): Promise<{ projectDir: string; project: ProjectConfig }> {
  const projectDir = path.resolve(process.cwd(), projectInput.trim());
  const stat = await fs.stat(projectDir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Unknown project directory: ${projectInput}`);
  const project = await loadProjectConfig(projectDir);
  return { projectDir, project };
}

export async function createDevSessionFromBody(body: Record<string, unknown>): Promise<{
  session: DevSession;
  projectDir: string;
  project: ProjectConfig;
}> {
  const projectInput = stringField(body, "project");
  if (!projectInput) throw new Error("Missing project.");
  const provider = stringField(body, "provider") || process.env.DEFAULT_MODEL_PROVIDER || "mock";
  // Throws on an unsupported provider id, before anything is persisted.
  providerFromEnv(provider);
  const { projectDir, project } = await resolveDevProject(projectInput);
  const session = await createDevSession({
    projectRootUri: projectDir,
    projectId: "",
    provider,
    model: stringField(body, "model") || null,
    title: stringField(body, "title") || ""
  });
  return { session, projectDir, project };
}

export async function getDevSessionDetail(sessionId: string): Promise<{
  session: DevSession;
  turns: Awaited<ReturnType<typeof listDevSessionTurns>>;
  diffs: Awaited<ReturnType<typeof listDevSessionDiffs>>;
  approvals: Awaited<ReturnType<typeof listDevSessionApprovals>>;
  hunks: Array<{ diffId: string; hunks: Awaited<ReturnType<typeof listDevSessionDiffHunks>> }>;
}> {
  const session = await getDevSessionOrThrow(sessionId);
  const [turns, diffs, approvals] = await Promise.all([
    listDevSessionTurns(session.id),
    listDevSessionDiffs(session.id),
    listDevSessionApprovals(session.id)
  ]);
  const hunks = await Promise.all(
    diffs.map(async (diff) => ({ diffId: diff.id, hunks: await listDevSessionDiffHunks(diff.id) }))
  );
  return { session, turns, diffs, approvals, hunks };
}

/**
 * Accept or reject a proposed diff, per file or per hunk. The Accept click
 * is the durable approval: the exact new content is bound through
 * approved-file-mutation before anything is written.
 */
export async function decideDevSessionDiffFromBody(input: {
  sessionId: string;
  diffId: string;
  body: Record<string, unknown>;
}): Promise<Awaited<ReturnType<typeof decideDevSessionDiff>>> {
  const decision = stringField(input.body, "decision");
  if (decision !== "accept" && decision !== "reject") throw new Error("Decision must be accept or reject.");
  const hunkIndexRaw = input.body.hunkIndex;
  const hunkIndex =
    typeof hunkIndexRaw === "number" && Number.isInteger(hunkIndexRaw) && hunkIndexRaw >= 0 ? hunkIndexRaw : undefined;
  if (hunkIndexRaw !== undefined && hunkIndex === undefined) throw new Error("hunkIndex must be a non-negative integer.");
  const session = await getDevSessionOrThrow(input.sessionId);
  const diff = await getDevSessionDiff(input.diffId);
  if (!diff) throw new Error(`Unknown dev diff: ${input.diffId}`);
  if (diff.sessionId !== input.sessionId) throw new Error("Diff does not belong to this session.");
  const { projectDir, project } = await resolveDevProject(session.projectRootUri);
  const resolved = resolveExecutionPolicy(project, "trusted-personal");
  return decideDevSessionDiff({
    diffId: diff.id,
    decision,
    hunkIndex,
    decidedBy: stringField(input.body, "actor") || "dashboard-user",
    projectDir,
    project: resolved.project
  });
}

/**
 * Answer a paused turn's inline approval. Approving authorizes the exact
 * action once: the next turn in this session consumes it. The returned
 * resume hint is the follow-up message the Studio panel sends so the agent
 * re-requests the approved action with the approval in force.
 */
export async function decideDevSessionApprovalFromBody(input: {
  sessionId: string;
  body: Record<string, unknown>;
}): Promise<{
  approval: Awaited<ReturnType<typeof decideDevSessionApproval>>;
  resumeHint: string | null;
}> {
  const approvalId = stringField(input.body, "approvalId");
  const decision = stringField(input.body, "decision");
  const actor = stringField(input.body, "actor") || "dashboard-user";
  if (!approvalId) throw new Error("Missing approvalId.");
  if (decision !== "approved" && decision !== "rejected") throw new Error("Decision must be approved or rejected.");
  const existing = await getDevSessionApproval(approvalId);
  if (!existing) throw new Error(`Unknown dev approval: ${approvalId}`);
  if (existing.sessionId !== input.sessionId) throw new Error("Approval does not belong to this session.");
  const approval = await decideDevSessionApproval({ approvalId, decision, decidedBy: actor });
  if (!approval) throw new Error("Approval was already decided.");
  await appendDevSessionReceipt({
    sessionId: input.sessionId,
    turnId: approval.turnId,
    agentId: DEV_MODE_AGENT_ID,
    actionType: "dev_approval_decided",
    target: approval.target,
    summary: `${approval.actionType} ${approval.target} was ${decision} by ${actor}.`,
    metadata: { approvalId: approval.id, decision, actor }
  });
  const resumeHint =
    decision === "approved"
      ? approval.actionType === "local_command"
        ? `Continue with the approved local_command: ${approval.target}`
        : `Continue with the approved file write: ${approval.target}`
      : null;
  return { approval, resumeHint };
}

export async function listDevSessionsForBody(body: Record<string, unknown>): Promise<DevSession[]> {
  const projectInput = stringField(body, "project");
  if (!projectInput) return listDevSessions({});
  const { projectDir } = await resolveDevProject(projectInput);
  return listDevSessions({ projectRootUri: projectDir });
}

/**
 * Stream one direct turn over SSE. All validation happens before the SSE
 * headers are written, so failures surface as JSON errors instead of a
 * half-open stream. The turn runs with tools enabled: reads and
 * policy-checked commands execute, file writes become proposed diffs, and
 * hard gates pause the turn with an inline approval.
 */
export async function streamDevSessionMessage(input: {
  sessionId: string;
  body: Record<string, unknown>;
  request: http.IncomingMessage;
  response: http.ServerResponse;
}): Promise<void> {
  const message = stringField(input.body, "message").trim();
  if (!message) throw new Error("Missing message.");
  const session = await getDevSessionOrThrow(input.sessionId);
  const { projectDir, project } = await resolveDevProject(session.projectRootUri);
  const openFiles = stringArrayField(input.body, "openFiles");

  const response = input.response;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive"
  });
  const abortController = new AbortController();
  const onClose = (): void => abortController.abort();
  input.request.on("close", onClose);
  let sawEvent = false;
  try {
    await runDirectTurn({
      session,
      projectDir,
      project,
      message,
      openFiles,
      providerId: stringField(input.body, "provider") || undefined,
      modelOverride: stringField(input.body, "model") || undefined,
      maxIterations: DEV_MODE_MAX_ITERATIONS,
      toolsEnabled: true,
      onEvent: (event) => {
        sawEvent = true;
        if (!response.writableEnded) response.write(formatDevSseEvent(event));
      },
      abortSignal: abortController.signal
    });
  } catch (error) {
    // runDirectTurn already emitted turn_failed and persisted the failure
    // for provider errors. Only emit one here if the turn never started
    // (e.g. the session/turn rows could not be written).
    if (!sawEvent && !response.writableEnded) {
      response.write(
        formatDevSseEvent({
          type: "turn_failed",
          turnId: "",
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  } finally {
    input.request.off("close", onClose);
    if (!response.writableEnded) response.end();
  }
}
