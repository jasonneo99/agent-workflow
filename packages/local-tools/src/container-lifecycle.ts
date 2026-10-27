import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export type ContainerLifecycleAction = "start" | "stop" | "restart" | "status";

export interface ContainerLifecycleReceipt {
  schemaVersion: 1;
  receiptId: string;
  recordedAt: string;
  projectRoot: string;
  composeFile: string;
  composeProject: string;
  action: ContainerLifecycleAction;
  services: string[];
  phase: "intent" | "result";
  command: string[];
  exitCode: number | null;
  durationMs: number | null;
  success: boolean | null;
  diagnostic: string | null;
}

export interface ContainerLifecycleResult {
  preview: boolean;
  projectRoot: string;
  composeFile: string;
  composeProject: string;
  action: ContainerLifecycleAction;
  services: string[];
  command: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  receiptPath: string | null;
}

type SpawnCommand = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}>;

const RECEIPT_RELATIVE_PATH = path.join(".agent-workflow", "receipts", "container-lifecycle.jsonl");

export async function runContainerLifecycle(input: {
  projectRoot: string;
  composeFile?: string;
  action: ContainerLifecycleAction;
  services?: string[];
  execute?: boolean;
  actor?: string;
  spawnCommand?: SpawnCommand;
  now?: () => Date;
}): Promise<ContainerLifecycleResult> {
  const projectRoot = await fs.realpath(path.resolve(input.projectRoot));
  const composeFile = await resolveComposeFile(projectRoot, input.composeFile ?? "compose.yaml");
  const document = await loadAndValidateCompose(composeFile, projectRoot);
  const services = validateServices(input.services ?? [], document);
  const composeProject = `agentflow-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 12)}`;
  const args = buildComposeArgs({ composeFile, composeProject, action: input.action, services });
  const command = ["docker", ...args];

  if (!input.execute) {
    return {
      preview: true,
      projectRoot,
      composeFile,
      composeProject,
      action: input.action,
      services,
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      receiptPath: null
    };
  }

  const now = input.now ?? (() => new Date());
  const receiptPath = path.join(projectRoot, RECEIPT_RELATIVE_PATH);
  const started = Date.now();
  await appendReceipt(receiptPath, makeReceipt({
    now: now(), projectRoot, composeFile, composeProject, action: input.action, services,
    phase: "intent", command, exitCode: null, durationMs: null, success: null,
    diagnostic: input.actor?.trim() ? `requested by ${input.actor.trim().slice(0, 120)}` : null
  }));
  const runner = input.spawnCommand ?? spawnCommand;
  let result: Awaited<ReturnType<SpawnCommand>>;
  try {
    result = await runner("docker", args, { cwd: projectRoot, env: process.env });
  } catch (error) {
    const durationMs = Date.now() - started;
    const diagnostic = boundedDiagnostic(error instanceof Error ? error.message : String(error));
    await appendReceipt(receiptPath, makeReceipt({
      now: now(), projectRoot, composeFile, composeProject, action: input.action, services,
      phase: "result", command, exitCode: null, durationMs, success: false, diagnostic
    }));
    throw error;
  }
  const durationMs = Date.now() - started;
  const success = result.exitCode === 0;
  await appendReceipt(receiptPath, makeReceipt({
    now: now(), projectRoot, composeFile, composeProject, action: input.action, services,
    phase: "result", command, exitCode: result.exitCode, durationMs, success,
    diagnostic: success ? null : boundedDiagnostic(result.stderr || result.stdout)
  }));
  return { preview: false, projectRoot, composeFile, composeProject, action: input.action, services, command,
    exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs, receiptPath };
}

export function buildComposeArgs(input: {
  composeFile: string;
  composeProject: string;
  action: ContainerLifecycleAction;
  services: string[];
}): string[] {
  const prefix = ["compose", "--project-name", input.composeProject, "--file", input.composeFile];
  const actionArgs: Record<ContainerLifecycleAction, string[]> = {
    start: ["up", "--detach", "--remove-orphans", ...input.services],
    stop: ["stop", ...input.services],
    restart: ["restart", ...input.services],
    status: ["ps", "--format", "json", ...input.services]
  };
  return [...prefix, ...actionArgs[input.action]];
}

async function resolveComposeFile(projectRoot: string, requested: string): Promise<string> {
  if (path.isAbsolute(requested)) throw new Error("Container lifecycle rejected: compose file must be project-relative.");
  const candidate = path.resolve(projectRoot, requested);
  const relative = path.relative(projectRoot, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Container lifecycle rejected: compose file escapes the project.");
  }
  const real = await fs.realpath(candidate).catch(() => { throw new Error(`Container lifecycle rejected: compose file not found: ${requested}`); });
  if (real !== candidate) throw new Error("Container lifecycle rejected: compose file or parent contains a symlink.");
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error("Container lifecycle rejected: compose path is not a regular file.");
  return real;
}

async function loadAndValidateCompose(composeFile: string, projectRoot: string): Promise<Record<string, unknown>> {
  const parsed = YAML.parse(await fs.readFile(composeFile, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Container lifecycle rejected: compose document must be an object.");
  if ("include" in parsed) throw new Error("Container lifecycle rejected: compose include is not supported by governed execution.");
  const services = parsed.services;
  if (!isRecord(services) || !Object.keys(services).length) throw new Error("Container lifecycle rejected: compose services are missing.");
  for (const sectionName of ["configs", "secrets"] as const) {
    const section = parsed[sectionName];
    if (!isRecord(section)) continue;
    for (const [name, definition] of Object.entries(section)) {
      if (isRecord(definition) && typeof definition.file === "string") {
        assertContainedReference(definition.file, `${sectionName}.${name}.file`, path.dirname(composeFile), projectRoot);
      }
    }
  }
  for (const [name, raw] of Object.entries(services)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(name) || !isRecord(raw)) throw new Error(`Container lifecycle rejected: invalid service ${name}.`);
    if (raw.privileged === true) throw new Error(`Container lifecycle rejected: ${name} requests privileged mode.`);
    for (const key of ["pid", "ipc", "network_mode"] as const) {
      if (String(raw[key] ?? "").toLowerCase() === "host") throw new Error(`Container lifecycle rejected: ${name} requests host ${key}.`);
    }
    if (Array.isArray(raw.devices) && raw.devices.length) throw new Error(`Container lifecycle rejected: ${name} requests host devices.`);
    if (Array.isArray(raw.cap_add) && raw.cap_add.length) throw new Error(`Container lifecycle rejected: ${name} adds Linux capabilities.`);
    if (raw.extends !== undefined) throw new Error(`Container lifecycle rejected: ${name} uses an external extends definition.`);
    if (raw.container_name !== undefined) throw new Error(`Container lifecycle rejected: ${name} overrides the project-scoped container name.`);
    if (raw.volumes_from !== undefined) throw new Error(`Container lifecycle rejected: ${name} imports volumes from another container.`);
    validateBuild(raw.build, name, path.dirname(composeFile), projectRoot);
    const envFiles = Array.isArray(raw.env_file) ? raw.env_file : raw.env_file === undefined ? [] : [raw.env_file];
    for (const envFile of envFiles) {
      const candidate = typeof envFile === "string" ? envFile : isRecord(envFile) && typeof envFile.path === "string" ? envFile.path : "";
      if (candidate) assertContainedReference(candidate, `${name}.env_file`, path.dirname(composeFile), projectRoot);
    }
    for (const volume of Array.isArray(raw.volumes) ? raw.volumes : []) validateVolume(volume, name, path.dirname(composeFile), projectRoot);
  }
  return parsed;
}

function validateVolume(volume: unknown, service: string, composeDir: string, projectRoot: string): void {
  let source = "";
  let target = "";
  if (typeof volume === "string") {
    const parts = volume.split(":");
    if (parts.length > 1) [source, target] = parts;
  } else if (isRecord(volume)) {
    source = typeof volume.source === "string" ? volume.source : "";
    target = typeof volume.target === "string" ? volume.target : "";
  } else return;
  if (/docker\.sock$/iu.test(source) || /docker\.sock$/iu.test(target)) {
    throw new Error(`Container lifecycle rejected: ${service} mounts the container-engine socket.`);
  }
  if (source.includes("${") || target.includes("${")) throw new Error(`Container lifecycle rejected: ${service} has an interpolated mount.`);
  const isHostPath = path.isAbsolute(source) || source.startsWith(".") || source.includes("/") || source.includes("\\");
  if (isHostPath) assertContainedReference(source, `${service} mount`, composeDir, projectRoot);
}

function validateBuild(build: unknown, service: string, composeDir: string, projectRoot: string): void {
  if (build === undefined) return;
  const context = typeof build === "string" ? build : isRecord(build) && typeof build.context === "string" ? build.context : ".";
  assertContainedReference(context, `${service}.build.context`, composeDir, projectRoot);
  if (isRecord(build) && typeof build.dockerfile === "string") {
    if (path.isAbsolute(build.dockerfile) || build.dockerfile.includes("${")) {
      throw new Error(`Container lifecycle rejected: ${service}.build.dockerfile is not a fixed relative path.`);
    }
    const buildRoot = path.resolve(composeDir, context);
    assertContainedReference(build.dockerfile, `${service}.build.dockerfile`, buildRoot, projectRoot);
  }
}

function assertContainedReference(value: string, label: string, baseDir: string, projectRoot: string): void {
  if (!value || value.includes("${")) throw new Error(`Container lifecycle rejected: ${label} is empty or interpolated.`);
  const resolved = path.resolve(baseDir, value);
  const relative = path.relative(projectRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Container lifecycle rejected: ${label} references a host path outside the project.`);
  }
  let existing = resolved;
  const remainder: string[] = [];
  while (!fsSync.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    remainder.unshift(path.basename(existing));
    existing = parent;
  }
  const physical = path.resolve(fsSync.realpathSync(existing), ...remainder);
  const physicalRelative = path.relative(projectRoot, physical);
  if (physicalRelative === ".." || physicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(physicalRelative)) {
    throw new Error(`Container lifecycle rejected: ${label} follows a symlink outside the project.`);
  }
}

function validateServices(requested: string[], document: Record<string, unknown>): string[] {
  const available = new Set(Object.keys(document.services as Record<string, unknown>));
  const services = [...new Set(requested.map((item) => item.trim()).filter(Boolean))];
  for (const service of services) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(service) || !available.has(service)) {
      throw new Error(`Container lifecycle rejected: unknown service ${service}.`);
    }
  }
  return services;
}

async function spawnCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout = boundedOutput(stdout + chunk.toString("utf8")); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = boundedOutput(stderr + chunk.toString("utf8")); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

function makeReceipt(input: Omit<ContainerLifecycleReceipt, "schemaVersion" | "receiptId" | "recordedAt"> & { now: Date }): ContainerLifecycleReceipt {
  const recordedAt = input.now.toISOString();
  const body = { ...input, now: undefined, recordedAt };
  return { schemaVersion: 1, receiptId: createHash("sha256").update(JSON.stringify(body)).digest("hex"), ...body };
}

async function appendReceipt(filePath: string, receipt: ContainerLifecycleReceipt): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600 });
}

function boundedOutput(value: string): string { return value.length <= 20_000 ? value : value.slice(-20_000); }
function boundedDiagnostic(value: string): string { return value.replace(/\s+/gu, " ").trim().slice(0, 1_000); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
