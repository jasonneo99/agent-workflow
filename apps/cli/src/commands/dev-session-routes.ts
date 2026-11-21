import type http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import type { ProjectConfig } from "../../../../packages/agent-registry/src/schemas.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import {
  createDevSession,
  listDevSessionDiffs,
  listDevSessionTurns,
  listDevSessions,
  type DevSession
} from "../../../../packages/storage/src/dev-sessions.js";
import { getDevSessionOrThrow, runDirectTurn, type DevTurnEvent } from "../../../../packages/workflow-engine/src/direct-turn.js";

/**
 * HTTP-facing Dev session handlers, called from the dashboard daemon
 * (`apps/cli/src/commands/daemon.ts`). Body parsing and the trusted-local
 * guard live in the daemon; this module validates payloads, resolves the
 * project, and drives the direct turn loop.
 */

export function parseDevSessionPath(pathname: string): { id: string; action: string } | null {
  const prefix = "/api/dev-session/";
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length).split("/").filter(Boolean);
  if (rest.length === 0 || rest.length > 2) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(rest[0])) return null;
  return { id: rest[0], action: rest[1] ?? "" };
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
}> {
  const session = await getDevSessionOrThrow(sessionId);
  const [turns, diffs] = await Promise.all([listDevSessionTurns(session.id), listDevSessionDiffs(session.id)]);
  return { session, turns, diffs };
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
 * half-open stream. Phase 1 runs the turn with tools disabled: the provider
 * answers, and any requested actions are recorded as deferred.
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
      maxIterations: 1,
      toolsEnabled: false,
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
