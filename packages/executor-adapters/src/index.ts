import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir, hostname } from "node:os";
import path from "node:path";
import type { ProjectConfig, WorkflowDefinition } from "../../agent-registry/src/schemas.js";

export const EXECUTOR_OPERATIONS = ["typecheck", "validate", "test"] as const;
export type ExecutorOperation = typeof EXECUTOR_OPERATIONS[number];

export interface ExecutorEnvelope {
  executorId: string;
  registeredProject: string;
  registeredProjectRoot: string;
  operation: ExecutorOperation;
  revision: string;
  runId: string;
  taskId: string;
  timeoutMs: number;
  maxOutputChars: number;
}

export interface ExecutorSnapshot extends ExecutorEnvelope {
  adapterType: "ssh-exact-revision";
  requestedHost: string;
  localFallback: "off" | "explicit";
  snapshotHash: string;
}

export interface ExecutorResult {
  status: "passed" | "failed";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  requestedHost: string;
  executionHost: string;
  fallbackUsed: boolean;
  artifactReference: string | null;
}

export function createExecutorSnapshots(input: {
  project: ProjectConfig;
  workflow: WorkflowDefinition;
  revision: string;
  runId: string;
  taskIds: Record<string, string>;
  projectRootUri: string;
}): Record<string, ExecutorSnapshot> {
  if (!/^[0-9a-f]{40}$/.test(input.revision)) throw new Error("Executor revision must be a full lowercase Git commit ID.");
  const snapshots: Record<string, ExecutorSnapshot> = {};
  for (const stage of input.workflow.stages) {
    if (!stage.executor) continue;
    const registration = input.project.execution.executor_adapters?.[stage.executor.id];
    if (!registration) throw new Error(`Unknown executor adapter: ${stage.executor.id}`);
    if (stage.executor.id !== "ssh-exact-revision") throw new Error(`Unknown executor adapter: ${stage.executor.id}`);
    if (!registration.projects.includes(input.project.project.name)) {
      throw new Error(`Executor ${stage.executor.id} is not registered for project ${input.project.project.name}.`);
    }
    if (!path.isAbsolute(registration.project_root)) throw new Error(`Executor ${stage.executor.id} project_root must be absolute.`);
    const registeredProjectRoot = path.resolve(registration.project_root);
    const requestedProjectRoot = path.resolve(input.projectRootUri);
    if (registeredProjectRoot !== requestedProjectRoot) {
      throw new Error(`Executor ${stage.executor.id} is not registered for project root ${requestedProjectRoot}.`);
    }
    if (!registration.operations.includes(stage.executor.operation)) {
      throw new Error(`Executor ${stage.executor.id} does not permit operation ${stage.executor.operation}.`);
    }
    const taskId = input.taskIds[stage.id];
    if (!taskId) throw new Error(`Missing task ID for executor stage ${stage.id}.`);
    const evidence = {
      executorId: stage.executor.id,
      adapterType: registration.type,
      registeredProject: input.project.project.name,
      registeredProjectRoot,
      operation: stage.executor.operation,
      revision: input.revision,
      runId: input.runId,
      taskId,
      timeoutMs: registration.timeout_ms,
      maxOutputChars: registration.max_output_chars,
      requestedHost: registration.host,
      localFallback: registration.local_fallback
    } satisfies Omit<ExecutorSnapshot, "snapshotHash">;
    snapshots[stage.id] = {
      ...evidence,
      snapshotHash: executorEvidenceHash(evidence)
    };
  }
  return snapshots;
}

export async function executeExecutorSnapshot(
  snapshot: ExecutorSnapshot,
  options: {
    executable?: string;
    localFallback?: (operation: ExecutorOperation, timeoutMs: number, maxOutputChars: number) => Promise<ExecutorResult>;
  } = {}
): Promise<ExecutorResult> {
  assertSnapshot(snapshot);
  const executable = options.executable ?? path.join(homedir(), ".local", "bin", "fleet-sharedHost-agent-workflow-job");
  try {
    const result = await spawnBounded(executable, [snapshot.operation, snapshot.revision], snapshot.timeoutMs, snapshot.maxOutputChars);
    const { stdoutTail, ...bounded } = result;
    return {
      ...bounded,
      status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
      requestedHost: snapshot.requestedHost,
      executionHost: snapshot.requestedHost,
      fallbackUsed: false,
      artifactReference: extractArtifactReference(stdoutTail)
    };
  } catch (error) {
    if (snapshot.localFallback !== "explicit" || !options.localFallback) throw error;
    const fallback = await options.localFallback(snapshot.operation, snapshot.timeoutMs, snapshot.maxOutputChars);
    return { ...fallback, requestedHost: snapshot.requestedHost, executionHost: hostname(), fallbackUsed: true };
  }
}

export function assertSnapshot(snapshot: ExecutorSnapshot): void {
  if (snapshot.adapterType !== "ssh-exact-revision" || snapshot.executorId !== "ssh-exact-revision") {
    throw new Error(`Unknown executor adapter: ${snapshot.executorId}`);
  }
  if (snapshot.registeredProject !== "agent-workflow") throw new Error(`Unregistered executor project: ${snapshot.registeredProject}`);
  if (!path.isAbsolute(snapshot.registeredProjectRoot)) throw new Error("Executor project root must be absolute.");
  if (snapshot.requestedHost !== "sharedHost") throw new Error(`Unregistered executor host: ${snapshot.requestedHost}`);
  if (!EXECUTOR_OPERATIONS.includes(snapshot.operation)) throw new Error(`Unregistered executor operation: ${snapshot.operation}`);
  if (!/^[0-9a-f]{40}$/.test(snapshot.revision)) throw new Error("Executor revision must be a full lowercase Git commit ID.");
  if (!Number.isInteger(snapshot.timeoutMs) || snapshot.timeoutMs < 1 || snapshot.timeoutMs > 3_600_000) throw new Error("Executor timeout is outside the registered bounds.");
  if (!Number.isInteger(snapshot.maxOutputChars) || snapshot.maxOutputChars < 1 || snapshot.maxOutputChars > 1_000_000) throw new Error("Executor output limit is outside the registered bounds.");
  const { snapshotHash, ...evidence } = snapshot;
  if (executorEvidenceHash(evidence) !== snapshotHash) {
    throw new Error("Executor snapshot evidence hash mismatch.");
  }
}

export function assertExecutorRegistration(snapshot: ExecutorSnapshot, project: ProjectConfig, projectRootUri: string): void {
  const registration = project.execution.executor_adapters?.[snapshot.executorId];
  if (!registration || registration.type !== snapshot.adapterType) throw new Error(`Unknown executor adapter: ${snapshot.executorId}`);
  if (registration.host !== "sharedHost" || snapshot.requestedHost !== registration.host) throw new Error(`Unregistered executor host: ${snapshot.requestedHost}`);
  if (!registration.projects.includes(snapshot.registeredProject) || snapshot.registeredProject !== project.project.name) throw new Error(`Unregistered executor project: ${snapshot.registeredProject}`);
  if (!registration.operations.includes(snapshot.operation)) throw new Error(`Unregistered executor operation: ${snapshot.operation}`);
  if (!path.isAbsolute(registration.project_root) || path.resolve(registration.project_root) !== path.resolve(projectRootUri) || snapshot.registeredProjectRoot !== path.resolve(projectRootUri)) {
    throw new Error(`Unregistered executor project root: ${snapshot.registeredProjectRoot}`);
  }
}

async function spawnBounded(executable: string, argv: string[], timeoutMs: number, maxOutputChars: number) {
  const started = Date.now();
  return new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; stdoutTail: string; durationMs: number; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(executable, argv, { shell: false, env: process.env, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let stdoutTail = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform !== "win32" && child.pid) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      } else {
        child.kill("SIGTERM");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = truncate(stdout + text, maxOutputChars);
      stdoutTail = (stdoutTail + text).slice(-4096);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = truncate(stderr + chunk.toString("utf8"), maxOutputChars); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, stdoutTail, durationMs: Date.now() - started, timedOut });
    });
  });
}

function extractArtifactReference(stdout: string): string | null {
  const job = stdout.match(/^job=([^\r\n]+)$/m)?.[1];
  return job ? `sharedHost-job://${job}` : null;
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = "\n...[truncated]";
  return limit <= marker.length ? value.slice(0, limit) : `${value.slice(0, limit - marker.length)}${marker}`;
}

export function executorEvidenceHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(value)))
    .digest("hex");
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalizeJson(entry)])
  );
}
