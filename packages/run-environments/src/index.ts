import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import { assertFileReadAllowed } from "../../local-tools/src/file-reader.js";
import { ENVIRONMENT_COMMAND, runEnvironmentsSchema, type EnvironmentContext, type EnvironmentProfile } from "./schema.js";
import { testEvidence, verificationCommandMatches, type TestEvidence } from "./evidence.js";

export { environmentProfileSchema, runEnvironmentsSchema, ENVIRONMENT_COMMAND } from "./schema.js";
export type { EnvironmentContext, EnvironmentProfile, RunEnvironments } from "./schema.js";

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated?: boolean;
  durationMs: number;
}
export type ProcessRunner = (argv: string[], options: { cwd: string; timeoutMs: number; maxOutputChars: number; env?: Record<string, string> }) => Promise<ProcessResult>;
export interface EnvironmentPlan {
  schemaVersion: 1;
  profile: string;
  kind: "container" | "native";
  platform: string;
  recipeHash: string;
  dependencyHash: string;
  sourceHash: string;
  sourceFiles: Array<{ path: string; sha256: string; bytes: number; mode: number }>;
  imageTag: string | null;
  spec: EnvironmentProfile;
}
export interface EnvironmentEvidence {
  schemaVersion: 1;
  authority: "execution-evidence-only";
  runId: string;
  taskId: string | null;
  attemptId: string;
  profile: string;
  status: "ready" | "blocked";
  phase: string;
  reason: string | null;
  platform: string;
  recipeHash: string;
  dependencyHash: string;
  sourceHash: string;
  imageId: string | null;
  runtimeHash: string | null;
  readiness: Array<{ argv: string[]; result: ProcessResult }>;
  receiptPath: string | null;
  cleanup: "not-needed" | "complete" | "failed";
  resources: { containers: string[]; network: string | null };
}
export interface EnvironmentResult extends ProcessResult {
  environment: EnvironmentEvidence;
  verificationRecipe?: TestEvidence;
}
type Snapshot = Array<{ path: string; body: Buffer; sha256: string; bytes: number; mode: number }>;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) =>
  entry && typeof entry === "object" && !Array.isArray(entry) && !Buffer.isBuffer(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
export const environmentDataHash = (value: unknown): string => hash(stable(value));
const identifier = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value) || value.includes("..")) throw Error("Invalid run environment identity.");
  return value;
};
const matches = (value: string | undefined, pattern: string | undefined) => pattern === undefined || (value !== undefined &&
  new RegExp(`^${pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*")}$`, "u").test(value));

export function selectEnvironment(project: ProjectConfig, context: EnvironmentContext, commandLine?: string): string | null {
  const raw = project.execution.environments;
  if (!raw) {
    if (context.profile) throw Error("This project has no execution environment profiles.");
    return null;
  }
  const config = runEnvironmentsSchema.parse(raw);
  const selector = config.selectors.find(entry => matches(context.runId, entry.run) && matches(context.workflowId, entry.workflow) &&
    matches(context.stageId, entry.stage) && matches(commandLine, entry.command));
  const selected = context.profile ?? selector?.profile ?? config.default_profile;
  if (selected && !config.profiles[selected]) throw Error(`Unknown environment profile: ${selected}`);
  return selected ?? null;
}

function assertEnabled(project: ProjectConfig): void {
  if (!project.actions.allowed_commands.includes(ENVIRONMENT_COMMAND) || project.actions.blocked_commands.some(pattern => matches(ENVIRONMENT_COMMAND, pattern))) {
    throw Error(`Run environments require the exact project capability: ${ENVIRONMENT_COMMAND}`);
  }
}

function privatePath(relative: string): boolean {
  return relative.split("/").some(part => [".git", ".agent-workflow", "node_modules", ".npmrc", ".pypirc", ".netrc", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache", "DerivedData"].includes(part) ||
    /^\.env(?:\.|$)/u.test(part) || /\.(?:pem|key)$/iu.test(part) || /^id_(?:rsa|ed25519)(?:\.|$)/u.test(part));
}

async function snapshot(root: string, profile: EnvironmentProfile, project: ProjectConfig): Promise<Snapshot> {
  const files = new Map<string, Snapshot[number]>();
  let bytes = 0, inspected = 0;
  const walk = async (relative: string, explicit: boolean): Promise<void> => {
    if (++inspected > profile.limits.max_files * 4) throw Error("Environment source inspection exceeds its bound.");
    if(profile.source_exclude_paths?.some(excluded=>relative===excluded||relative.startsWith(excluded+'/'))){if(explicit)throw Error('An explicit environment input is excluded: '+relative);return;}
    if (privatePath(relative)) {
      if (explicit) throw Error(`Private or generated source cannot enter an environment: ${relative}`);
      return;
    }
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if(!explicit&&!stat.isDirectory()&&profile.source_extensions?.length&&!profile.source_extensions.includes(path.extname(relative)))return;
    if (stat.isSymbolicLink() || await fs.realpath(absolute) !== absolute) throw Error(`Environment source contains a symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(absolute)).sort()) await walk(`${relative}/${entry}`, false);
      return;
    }
    if (!stat.isFile()) throw Error(`Environment source is not a regular file: ${relative}`);
    if (files.has(relative)) return;
    try { assertFileReadAllowed(relative, project); } catch (error) { if (explicit) throw error; return; }
    if (stat.size > profile.limits.max_source_bytes - bytes || files.size >= profile.limits.max_files) throw Error("Environment source exceeds its size or file limit.");
    // The opened descriptor is checked again: a replaced symlink cannot leak host files.
    const handle = await fs.open(absolute, (await import("node:fs")).constants.O_RDONLY | (await import("node:fs")).constants.O_NOFOLLOW);
    let body: Buffer;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > profile.limits.max_source_bytes - bytes) throw Error("Environment source changed while opening.");
      body = Buffer.alloc(opened.size + 1);
      const read = await handle.read(body, 0, body.length, 0);
      if (read.bytesRead !== opened.size) throw Error("Environment source changed while reading.");
      body = body.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
    bytes += body.length;
    files.set(relative, { path: relative, body, sha256: hash(body), bytes: body.length, mode: stat.mode & 0o111 ? 0o755 : 0o644 });
  };
  for (const relative of [...new Set([...profile.source_paths, ...profile.dependency_paths])]) await walk(relative, true);
  if (!files.size) throw Error("Environment source snapshot is empty.");
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function resolvePlan(input: { cwd: string; project: ProjectConfig; context: EnvironmentContext; commandLine?: string }) {
  assertEnabled(input.project);
  identifier(input.context.runId);
  if (input.context.reuseRunId) identifier(input.context.reuseRunId);
  const selected = selectEnvironment(input.project, input.context, input.commandLine);
  if (!selected) throw Error("No environment profile matches this run and command.");
  const root = await fs.realpath(input.cwd);
  const config = runEnvironmentsSchema.parse(input.project.execution.environments);
  const spec = config.profiles[selected]!;
  const files = await snapshot(root, spec, input.project);
  const dependencyFiles = files.filter(file => spec.dependency_paths.some(item => file.path === item || file.path.startsWith(`${item}/`)));
  const dependencyHash = hash(stable(dependencyFiles.map(file => ({ path: file.path, sha256: file.sha256, mode: file.mode }))));
  const recipeHash = hash(stable({ schemaVersion: 1, profile: selected, dockerContext: config.docker_context, spec, dependencyHash }));
  const sourceFiles = files.map(({ path: filePath, sha256, bytes, mode }) => ({ path: filePath, sha256, bytes, mode }));
  const sourceHash = hash(stable(sourceFiles));
  const plan: EnvironmentPlan = { schemaVersion: 1, profile: selected, kind: spec.kind, platform: spec.platform, spec,
    recipeHash, dependencyHash, sourceHash, sourceFiles,
    imageTag: spec.kind === "container" ? `agentflow-env:${hash(root).slice(0, 12)}-${hash(recipeHash + sourceHash).slice(0, 40)}` : null };
  return { plan, files, root, config };
}

/** Preview reads only declared, policy-readable sources; it does not contact Docker or create files. */
export async function planRunEnvironment(input: { cwd: string; project: ProjectConfig; context: EnvironmentContext; commandLine?: string }): Promise<EnvironmentPlan> {
  return (await resolvePlan(input)).plan;
}

async function ownedDirectory(root: string, segments: string[]): Promise<string> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    if (!(await fs.lstat(current)).isDirectory() || await fs.realpath(current) !== current) throw Error("Environment evidence directory is not a physical project-owned directory.");
  }
  return current;
}

async function freezeRecipe(root: string, plan: EnvironmentPlan, context: EnvironmentContext): Promise<string> {
  const directory = await ownedDirectory(root, [".agent-workflow", "runtime", "run-environments", identifier(context.runId), identifier(plan.profile)]);
  const binding = { schemaVersion: 1, runId: context.runId, profile: plan.profile, recipeHash: plan.recipeHash, dependencyHash: plan.dependencyHash };
  const check = async (file: string) => {
    if (!(await fs.lstat(file)).isFile() || await fs.realpath(file) !== file) throw Error("Frozen environment binding is not a regular owned file.");
    const existing = JSON.parse(await fs.readFile(file, "utf8")) as typeof binding;
    if (existing.schemaVersion !== 1 || existing.recipeHash !== plan.recipeHash || existing.dependencyHash !== plan.dependencyHash || existing.profile !== plan.profile) {
      throw Error("Frozen run environment drifted; prepare a new authorized run instead of replacing its recipe.");
    }
  };
  if (context.reuseRunId) {
    const original = path.join(root, ".agent-workflow", "runtime", "run-environments", identifier(context.reuseRunId), identifier(plan.profile), "recipe.json");
    await check(original);
  }
  const target = path.join(directory, "recipe.json");
  // Link a complete file atomically: concurrent repair/verifier instances never see a partial binding.
  const temporary = path.join(directory, `recipe-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(binding, null, 2)}\n`, { flag: "wx", mode: 0o400 });
  try { await fs.link(temporary, target).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; await check(target); }); }
  finally { await fs.unlink(temporary); }
  return directory;
}

async function freezeRuntime(directory: string, root: string, plan: EnvironmentPlan, context: EnvironmentContext, runtimeHash: string): Promise<void> {
  const name = plan.kind === "container" ? `runtime-${plan.sourceHash}.json` : "runtime-native.json";
  const body = { schemaVersion: 1, recipeHash: plan.recipeHash, runtimeHash, platform: plan.platform,
    ...(plan.kind === "container" ? { sourceHash: plan.sourceHash } : {}) };
  const check = async (file: string) => {
    if (!(await fs.lstat(file)).isFile() || await fs.realpath(file) !== file || stable(JSON.parse(await fs.readFile(file, "utf8"))) !== stable(body)) {
      throw Error("The frozen runtime/image changed; its previous execution cannot be adopted as equivalent.");
    }
  };
  if (context.reuseRunId) await check(path.join(root, ".agent-workflow/runtime/run-environments", identifier(context.reuseRunId), plan.profile, name));
  const temporary = path.join(directory, `${randomUUID()}.tmp`), target = path.join(directory, name);
  await fs.writeFile(temporary, `${JSON.stringify(body)}\n`, { flag: "wx", mode: 0o400 });
  try { await fs.link(temporary, target).catch(async (error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; await check(target); }); }
  finally { await fs.unlink(temporary); }
}

export function dockerfileFor(plan: EnvironmentPlan): string {
  const lines = [`FROM ${plan.spec.image}`, "WORKDIR /workspace", "ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1"];
  if (plan.spec.dependency_paths.length) lines.push("COPY dependencies/ /workspace/");
  for (const args of plan.spec.setup) lines.push(`RUN ${JSON.stringify(args)}`);
  lines.push("COPY source/ /workspace/", 'RUN ["chown", "-R", "10001:10001", "/workspace"]', "USER 10001:10001", "ENTRYPOINT []");
  return `${lines.join("\n")}\n`;
}

function emptyResult(reason: string): ProcessResult {
  return { exitCode: 126, signal: null, stdout: "", stderr: reason, timedOut: false, durationMs: 0 };
}

/** The supervisor owns Docker; containers receive no host bind mounts, socket, credentials or inherited host environment. */
export async function runEnvironmentCommand(input: {
  cwd: string; project: ProjectConfig; context: EnvironmentContext; commandLine: string; argv: string[];
  runner?: ProcessRunner; nativeRunner?: (argv: string[], limits: { timeoutMs: number; maxOutputChars: number }) => Promise<ProcessResult>;
  assertAuthority?: () => Promise<void>;
}): Promise<EnvironmentResult> {
  // Check the real argv again at the public API boundary, including expanded compilation paths.
  const { assertCommandAllowed, expandCompileArguments } = await import("../../local-tools/src/command-executor.js");
  assertCommandAllowed(input.commandLine, input.project);
  if (stable(await expandCompileArguments(input.commandLine, input.cwd)) !== stable(input.argv)) throw Error("Environment argv does not match the exact authorized command.");
  await input.assertAuthority?.();
  const { plan, files, root, config } = await resolvePlan(input);
  const declarations = plan.spec.verification.filter(item => item.commands.some(pattern=>verificationCommandMatches(input.commandLine,pattern)));
  if(declarations.length>1)throw Error('Ambiguous verification contract for this literal command.');
  const declaration = declarations[0];
  if (input.context.requireVerification && !declaration) throw Error("Independent verification requires a declared test collection contract for this exact command.");
  const attemptId = randomUUID(), started = Date.now();
  const evidence: EnvironmentEvidence = { schemaVersion: 1, authority: "execution-evidence-only", runId: input.context.runId,
    taskId: input.context.taskId ?? null, attemptId, profile: plan.profile, status: "blocked", phase: "preparation", reason: null,
    platform: plan.platform, recipeHash: plan.recipeHash, dependencyHash: plan.dependencyHash, sourceHash: plan.sourceHash,
    imageId: null, runtimeHash: null, readiness: [], receiptPath: null, cleanup: "not-needed", resources: { containers: [], network: null } };
  const directory = await freezeRecipe(root, plan, input.context);
  const runner = input.runner ?? runProcess;
  const containers: string[] = [];
  let network: string | null = null, scratch: string | null = null, result = emptyResult("Environment preparation did not finish.");
  const deadline = Date.now() + Math.min(plan.spec.limits.preparation_timeout_ms, input.project.actions.command_timeout_ms);
  const invoke = async (args: string[], phase = "preparation", cleanup = false) => {
    if (!cleanup) await input.assertAuthority?.();
    if (!cleanup) evidence.phase = phase;
    const remaining = deadline - Date.now();
    if (!cleanup && remaining <= 0) throw Error("Environment preparation/execution exceeded its frozen total time limit.");
    return runner(["docker", "--context", config.docker_context, ...args], { cwd: root,
      timeoutMs: cleanup ? 10_000 : Math.min(remaining, plan.spec.limits.timeout_ms),
      maxOutputChars: Math.min(plan.spec.limits.max_output_chars, input.project.actions.max_output_chars) });
  };
  const successful = (value: ProcessResult, message: string) => {
    if (value.exitCode !== 0 || value.timedOut || value.outputTruncated) throw Error(`${message}: ${value.stderr || value.stdout || `exit ${value.exitCode}`}`);
  };
  const probeUntilReady = async (probe: EnvironmentProfile["readiness"][number], observe: () => Promise<ProcessResult>, message: string) => {
    for (let attempt = 0; attempt < probe.attempts; attempt++) {
      const observation = await observe();
      evidence.readiness.push({ argv: probe.argv, result: observation });
      const matchesExpectation = !probe.expect_output || (observation.stdout + observation.stderr).includes(probe.expect_output);
      if (observation.exitCode === 0 && !observation.timedOut && !observation.outputTruncated && matchesExpectation) return;
      if (attempt + 1 === probe.attempts) {
        successful(observation, message);
        throw Error(`${message}: runtime version/readiness expectation did not match.`);
      }
      if (Date.now() + probe.interval_ms >= deadline) throw Error(`${message}: readiness exhausted the frozen time limit.`);
      await new Promise(resolve => setTimeout(resolve, probe.interval_ms));
    }
  };
  const inNative = async (args: string[]) => {
    await input.assertAuthority?.();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Error("Native environment exceeded its frozen total time limit.");
    return input.nativeRunner!(args, { timeoutMs: Math.min(remaining, plan.spec.limits.timeout_ms),
      maxOutputChars: Math.min(plan.spec.limits.max_output_chars, input.project.actions.max_output_chars) });
  };
  const limits = ["--cpus", String(plan.spec.limits.cpus), "--memory", `${plan.spec.limits.memory_mb}m`, "--pids-limit", String(plan.spec.limits.pids),
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--init", "--label", `io.agentflow.attempt=${attemptId}`];
  const create = async (imageId: string, args: string[], service = false, user = "10001:10001", env: Record<string, string> = {}, alias?: string) => {
    const created = await invoke(["create", ...limits, "--network", network ?? "none", "--user", user,
      ...(alias ? ["--network-alias", alias] : []), ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      "--workdir", service ? "/" : "/workspace", ...(!service && args.length ? ["--entrypoint", args[0]!] : []),
      imageId, ...(service ? args : args.slice(1))]);
    successful(created, "Container creation failed");
    const id = created.stdout.trim();
    if (!/^[a-f0-9]{12,64}$/u.test(id)) throw Error("Docker returned an invalid owned container identity.");
    containers.push(id);
    evidence.resources.containers.push(id);
    evidence.cleanup = "complete";
    return id;
  };
  const inContainer = async (args: string[], phase: string) => {
    const containerArgs = args.map(argument => argument === root ? "/workspace" : argument.startsWith(`${root}${path.sep}`) ? `/workspace/${path.relative(root, argument).split(path.sep).join("/")}` : argument);
    const id = await create(evidence.imageId!, containerArgs, false, "10001:10001", plan.spec.env);
    const attached = await invoke(["start", "--attach", id], phase);
    if (attached.timedOut) return attached;
    const inspected = await invoke(["inspect", "--format", "{{json .State}}", id], phase);
    successful(inspected, "Container result inspection failed");
    const state = JSON.parse(inspected.stdout) as { Running?: boolean; ExitCode?: number; OOMKilled?: boolean; Error?: string };
    if (state.Running || !Number.isInteger(state.ExitCode) || state.OOMKilled || state.Error) throw Error("Container did not finish with a trustworthy exit state.");
    return { ...attached, exitCode: attached.exitCode === 0 ? state.ExitCode! : attached.exitCode };
  };
  try {
    if (plan.kind === "native") {
      const hostPlatform = `${process.platform}/${process.arch === "x64" ? "amd64" : process.arch}`;
      if (hostPlatform !== plan.platform || !input.nativeRunner) throw Error(`A matching native runner is required: ${plan.platform}; available host is ${hostPlatform}.`);
      for (const probe of plan.spec.readiness) {
        await probeUntilReady(probe, () => inNative(probe.argv), "Native environment readiness failed");
      }
      evidence.runtimeHash = environmentDataHash([...new Map(evidence.readiness.filter(item => item.result.exitCode === 0 && !item.result.timedOut && !item.result.outputTruncated)
        .map(item => [stable(item.argv), { argv: item.argv, stdout: item.result.stdout, stderr: item.result.stderr }])).values()]);
      await freezeRuntime(directory, root, plan, input.context, evidence.runtimeHash);
      evidence.status = "ready"; evidence.phase = "command";
      result = await inNative(input.argv);
    } else {
      const cached = await invoke(["image", "inspect", "--format", "{{json .}}", plan.imageTag!]);
      let imageInfo: { Id?: string; Os?: string; Architecture?: string; Config?: { Labels?: Record<string, string> } };
      if (cached.exitCode === 0 && !cached.timedOut && !cached.outputTruncated) imageInfo = JSON.parse(cached.stdout) as typeof imageInfo;
      else {
        scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-environment-")));
        await fs.mkdir(path.join(scratch, "source")); await fs.mkdir(path.join(scratch, "dependencies"));
        for (const file of files) {
          for (const section of ["source", ...(plan.spec.dependency_paths.some(item => file.path === item || file.path.startsWith(`${item}/`)) ? ["dependencies"] : [])]) {
            const target = path.join(scratch, section, file.path);
            await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.body, { mode: file.mode, flag: "wx" });
          }
        }
        await fs.writeFile(path.join(scratch, "Dockerfile"), dockerfileFor(plan), { flag: "wx" });
        const built = await invoke(["build", "--platform", plan.platform, "--network", plan.spec.build_network, "--pull=false",
          "--label", `io.agentflow.recipe=${plan.recipeHash}`, "--label", `io.agentflow.source=${plan.sourceHash}`, "--tag", plan.imageTag!, scratch], "build");
        successful(built, "Environment image build failed");
        const inspected = await invoke(["image", "inspect", "--format", "{{json .}}", plan.imageTag!], "build");
        successful(inspected, "Built image identity unavailable"); imageInfo = JSON.parse(inspected.stdout) as typeof imageInfo;
      }
      if (!/^sha256:[a-f0-9]{64}$/u.test(imageInfo.Id ?? "") || `${imageInfo.Os}/${imageInfo.Architecture}` !== plan.platform ||
          imageInfo.Config?.Labels?.["io.agentflow.recipe"] !== plan.recipeHash || imageInfo.Config?.Labels?.["io.agentflow.source"] !== plan.sourceHash) {
        throw Error("Image identity, platform or source binding did not match the resolved environment.");
      }
      evidence.imageId = imageInfo.Id!;
      evidence.runtimeHash = hash(evidence.imageId);
      await freezeRuntime(directory, root, plan, input.context, evidence.runtimeHash);
      if (Object.keys(plan.spec.services).length) {
        const created = await invoke(["network", "create", "--internal", "--label", `io.agentflow.attempt=${attemptId}`, `agentflow-${attemptId}`]);
        successful(created, "Isolated service network creation failed");
        if (!/^[a-f0-9]{12,64}$/u.test(created.stdout.trim())) throw Error("Docker returned an invalid owned network identity.");
        network = created.stdout.trim(); evidence.resources.network = network; evidence.cleanup = "complete";
        for (const [name, service] of Object.entries(plan.spec.services)) {
          successful(await invoke(["pull", "--platform", plan.platform, service.image]), "Pinned service image unavailable");
          const id = await create(service.image, service.argv ?? [], true, service.user, service.env, name);
          successful(await invoke(["start", id]), "Test service failed to start");
          try{await probeUntilReady(service.readiness, () => invoke(["exec", id, ...service.readiness.argv], "service-readiness"), `Service ${name} is not ready`);}
          catch(error){const logs=await invoke(['logs','--tail','60',id],'service-diagnostics');throw Error(`${String(error)}\n${logs.stdout.slice(-3000)}${logs.stderr.slice(-3000)}`);}
        }
      }
      for (const probe of plan.spec.readiness) {
        await probeUntilReady(probe, () => inContainer(probe.argv, "readiness"), "Environment dependency/readiness check failed");
      }
      evidence.status = "ready";
      result = await inContainer(input.argv, "command");
    }
  } catch (error) {
    evidence.status = "blocked";
    evidence.reason = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
    result = emptyResult(evidence.reason);
  } finally {
    const cleanupErrors: string[] = [];
    for (const id of [...containers].reverse()) {
      try { successful(await invoke(["rm", "--force", "--volumes", id], "cleanup", true), "Owned container cleanup failed"); }
      catch (error) { cleanupErrors.push(String(error)); }
    }
    if (network) {
      try { successful(await invoke(["network", "rm", network], "cleanup", true), "Owned network cleanup failed"); }
      catch (error) { cleanupErrors.push(String(error)); }
    }
    if (scratch) await fs.rm(scratch, { recursive: true, force: true }).catch(error => cleanupErrors.push(String(error)));
    if (cleanupErrors.length) {
      evidence.cleanup = "failed"; evidence.status = "blocked"; evidence.reason = cleanupErrors.join("\n").slice(0, 4000);
      result = emptyResult(evidence.reason);
    }
  }
  const verificationRecipe = declaration ? testEvidence(result, declaration) : undefined;
  const receiptDirectory = await ownedDirectory(directory, ["receipts"]);
  evidence.receiptPath = path.join(receiptDirectory, `${attemptId}.json`);
  const outcome: EnvironmentResult = { ...result, durationMs: Date.now() - started, environment: evidence,
    ...(verificationRecipe ? { verificationRecipe } : {}) };
  await fs.writeFile(evidence.receiptPath, `${JSON.stringify({ recordedAt: new Date().toISOString(), commandLine: input.commandLine, plan, result: outcome }, null, 2)}\n`, { flag: "wx", mode: 0o400 });
  return outcome;
}

/** Bound both pipes, terminate the CLI process group, and still clean owned Docker resources above. */
export const runProcess: ProcessRunner = async (argv, options) => new Promise((resolve, reject) => {
  const started = Date.now();
  const child = spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, shell: false, detached: process.platform !== "win32",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG ?? "C.UTF-8", ...options.env } });
  let stdout = "", stderr = "", timedOut = false, truncated = false;
  const append = (value: string, chunk: Buffer) => {
    const next = value + chunk.toString("utf8");
    if (next.length > options.maxOutputChars) truncated = true;
    return next.slice(0, options.maxOutputChars);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const kill = (signal: NodeJS.Signals) => { try { if (process.platform === "win32") child.kill(signal); else if (child.pid) process.kill(-child.pid, signal); } catch { /* already exited */ } };
  let force: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), 2000); }, options.timeoutMs);
  child.on("error", error => { clearTimeout(timer); if (force) clearTimeout(force); reject(error); });
  child.on("close", (exitCode, signal) => { clearTimeout(timer); if (force) clearTimeout(force);
    resolve({ exitCode, signal, stdout, stderr, timedOut, durationMs: Date.now() - started, ...(truncated ? { outputTruncated: true } : {}) }); });
});
