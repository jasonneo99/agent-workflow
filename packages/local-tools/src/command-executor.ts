import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";
import {prepareScopedCommandSandbox} from './scoped-command-sandbox.js';
import {verificationRecipeEvidence,type VerificationRecipeEvidence} from './verification-recipe-evidence.js';
import { runEnvironmentCommand, selectEnvironment, type EnvironmentContext, type EnvironmentEvidence, type EnvironmentResult } from '../../run-environments/src/index.js';

export interface CommandExecutionResult {
  commandLine: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  outputTruncated?:boolean;
  verificationRecipe?:VerificationRecipeEvidence;
  environment?: EnvironmentEvidence;
}

export interface ExecutionCapabilityProbe {
  id: string;
  status: "passed" | "failed";
  checkedAt: string;
  digest: string;
  reason: string | null;
}

/** Python redirects bytecode under an inherited cache prefix even for explicit
 * py_compile calls. Inspect that artifact without removing the caller's
 * write-isolation environment or permitting writes beside product source. */
export function pythonCompilationCacheDirectory(sourceFile:string,cwd:string,env:NodeJS.ProcessEnv=process.env):string {
  const directory=path.dirname(path.resolve(cwd,sourceFile));
  if(!env.PYTHONPYCACHEPREFIX)return path.join(directory,"__pycache__");
  return path.join(path.resolve(cwd,env.PYTHONPYCACHEPREFIX),directory.slice(path.parse(directory).root.length));
}

/** Exercise remediation-sensitive command behavior through the real executor.
 * Probes are isolated, bounded, body-free and grant no command authority. */
export async function probeCommandExecutionCapabilities():Promise<ExecutionCapabilityProbe[]> {
  const id="python-pycompile-glob-v1",checkedAt=new Date().toISOString();
  const cwd=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"agentflow-worker-capability-")));
  try {
    await fs.mkdir(path.join(cwd,"source"));
    await fs.writeFile(path.join(cwd,"source","probe.py"),"probe_value = 1\n","utf8");
    const project={actions:{allowed_commands:["python3 -m py_compile source/*.py"],blocked_commands:[],command_timeout_ms:5_000,max_output_chars:2_000,isolate_command_writes:false}} as unknown as ProjectConfig;
    const result=await executeAllowedCommand({commandLine:"python3 -m py_compile source/*.py",cwd,project});
    const compiled=(await fs.readdir(pythonCompilationCacheDirectory("source/probe.py",cwd))).some(name=>name.startsWith("probe.")&&name.endsWith(".pyc"));
    if(result.exitCode!==0||result.timedOut||!compiled)throw new Error(result.stderr.trim()||`probe exited ${result.exitCode}`);
    return [{id,status:"passed",checkedAt,digest:createHash("sha256").update(`${id}\0expanded\0shell-false\0compiled`).digest("hex"),reason:null}];
  } catch(error) {
    const reason=(error instanceof Error?error.message:String(error)).replace(/\s+/gu," ").slice(0,500);
    return [{id,status:"failed",checkedAt,digest:createHash("sha256").update(`${id}\0failed\0${reason}`).digest("hex"),reason}];
  } finally { await fs.rm(cwd,{recursive:true,force:true}); }
}

export function assertCommandAllowed(commandLine: string, project: ProjectConfig): void {
  const normalized = normalizeCommand(commandLine);

  if (containsShellMetacharacters(normalized)) {
    throw new Error("Command rejected: shell metacharacters are not allowed.");
  }

  if (isLikelyLongRunningServerCommand(normalized)) {
    throw new Error("Command rejected: long-running server commands must be started outside worker-requested blocking commands.");
  }

  for (const pattern of project.actions.blocked_commands) {
    if (matchesPattern(normalized, pattern)) {
      throw new Error(`Command rejected by blocked pattern: ${pattern}`);
    }
  }

  const allowed = project.actions.allowed_commands.some((pattern) => matchesPattern(normalized, pattern));
  if (!allowed) {
    throw new Error(`Command is not allowed by project policy: ${normalized}`);
  }
}

export async function executeAllowedCommand(input: {
  commandLine: string;
  cwd: string;
  project: ProjectConfig;
  environmentContext?: EnvironmentContext;
  assertEnvironmentAuthority?: () => Promise<void>;
}): Promise<CommandExecutionResult> {
  const commandLine = normalizeCommand(input.commandLine);
  assertCommandAllowed(commandLine, input.project);
  const argv = await expandCompileArguments(commandLine, input.cwd);
  if (argv.join("\0") !== splitCommand(commandLine).join("\0")) {
    const moduleIndex = argv[1] === "-B" ? 2 : 1;
    const prefix = argv.slice(0, moduleIndex + 2);
    const files = argv.slice(moduleIndex + 2);
    const root = await fs.realpath(input.cwd);
    const relative = files.map(file => path.isAbsolute(file) ? path.relative(root,file).split(path.sep).join("/") : file);
    const candidates = [[...prefix,...files],[...prefix,...relative],
      ...files.map(file=>[...prefix,file]),...relative.map(file=>[...prefix,file])];
    for (const pattern of input.project.actions.blocked_commands) {
      if (candidates.some(args=>matchesPattern(args.join(" "),pattern))) {
        throw new Error(`Expanded compilation rejected by blocked pattern: ${pattern}`);
      }
    }
  }
  if (!argv.length) {
    throw new Error("Command is empty.");
  }
  if (input.environmentContext && argv.slice(0, 5).join(" ") === "npm run agentflow -- environments") {
    throw new Error("The environment capability cannot be requested as a nested agent command; request the underlying authorized test command.");
  }

  const started = Date.now();
  const timeoutMs = input.project.actions.command_timeout_ms;
  const maxOutputChars = input.project.actions.max_output_chars;

  const selectedEnvironment = input.environmentContext ? selectEnvironment(input.project, input.environmentContext, commandLine) : null;
  if (input.environmentContext && selectedEnvironment) {
    let observed: EnvironmentResult;
    try { observed = await runEnvironmentCommand({ cwd: input.cwd, project: input.project,
      context: input.environmentContext, commandLine, argv,
      assertAuthority: input.assertEnvironmentAuthority,
      nativeRunner: async (nativeArgv, limits) => {
        const nativeCommand = nativeArgv === argv ? commandLine : nativeArgv.map(argument => {
          if (/["'\\\r\n]/u.test(argument)) throw Error('Native readiness requires a simple allowlisted command; use a project script for complex probes.');
          return /\s/u.test(argument) ? `"${argument}"` : argument;
        }).join(' ');
        return executeAllowedCommand({ cwd: input.cwd, project: { ...input.project, actions: { ...input.project.actions,
          command_timeout_ms: limits.timeoutMs, max_output_chars: limits.maxOutputChars } }, commandLine: nativeCommand });
      }
    }); } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      observed = { exitCode: 126, signal: null, stdout: '', stderr: reason, durationMs: Date.now() - started, timedOut: false,
        environment: { schemaVersion: 1, authority: 'execution-evidence-only', runId: input.environmentContext.runId,
          taskId: input.environmentContext.taskId ?? null, attemptId: randomUUID(), profile: selectedEnvironment,
          status: 'blocked', phase: 'resolution', reason, platform: input.project.execution.environments!.profiles[selectedEnvironment]!.platform,
          recipeHash: '', dependencyHash: '', sourceHash: '', imageId: null, runtimeHash: null, readiness: [], receiptPath: null, cleanup: 'not-needed', resources: { containers: [], network: null } } };
    }
    const retained = verificationRecipeEvidence({ ...observed, commandLine }, input.project.actions.verification_recipes);
    const verificationRecipe = retained?.status === 'failed' ? retained : observed.verificationRecipe ?? retained;
    return { ...observed, commandLine, cwd: input.cwd, ...(verificationRecipe ? { verificationRecipe } : {}) };
  }

  const sandbox=await prepareScopedCommandSandbox({enabled:input.project.actions.isolate_command_writes===true,nativePty:input.project.actions.isolate_command_writes===true && (input.project.actions.scoped_native_pty_commands??[]).includes(commandLine),argv,env:createProjectCommandEnv()});
  try{return await new Promise<CommandExecutionResult>((resolve, reject) => {
    const child = spawn(sandbox.argv[0], sandbox.argv.slice(1), {
      cwd: input.cwd,
      shell: false,
      env: sandbox.env
    });
    const stdout = createBoundedOutputCapture(maxOutputChars);
    const stderr = createBoundedOutputCapture(maxOutputChars);
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk.toString("utf8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      const result:CommandExecutionResult={
        commandLine,
        cwd: input.cwd,
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        durationMs: Date.now() - started,
        timedOut,
        ...(stdout.truncated()||stderr.truncated()?{outputTruncated:true}:{})
      };
      const verificationRecipe=verificationRecipeEvidence(result,input.project.actions.verification_recipes);
      resolve({...result,...(verificationRecipe?{verificationRecipe}:{})});
    });
  });}finally{await sandbox.cleanup();}
}

/** Only the explicitly requested Python compilation recipe expands wildcards.
 * Never enable a shell or apply expansion to scripts, flags or quoted literals.
 */
export async function expandCompileArguments(commandLine: string, cwd: string): Promise<string[]> {
  const argv = splitCommand(commandLine);
  const moduleIndex = argv[1] === "-B" ? 2 : 1;
  if (!/^python(?:3(?:\.\d+)?)?$/u.test(argv[0] ?? "") ||
      argv[moduleIndex] !== "-m" || argv[moduleIndex + 1] !== "py_compile") return argv;
  const raw = commandLine.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? [];
  const root = await fs.realpath(cwd);
  const expanded = argv.slice(0, moduleIndex + 2);
  for (let index = moduleIndex + 2; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.includes("*") || /^["']/u.test(raw[index] ?? "")) {
      expanded.push(argument);
      continue;
    }
    if (!/^(?:[A-Za-z0-9_.-]+\/)*\*\.py$/u.test(argument) ||
        argument.split("/").some(part => part === "." || part === "..")) {
      throw new Error("Unsupported compilation wildcard; use a bounded project-relative *.py pattern.");
    }
    const directory = path.resolve(root, path.dirname(argument));
    if (await fs.realpath(directory) !== directory) throw new Error("Compilation wildcard directory contains a symlink.");
    const relative = path.relative(root, directory);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Compilation wildcard escapes the project.");
    }
    const matches: string[] = [];
    const entries = await fs.opendir(directory);
    let inspected = 0;
    for await (const entry of entries) {
      if (++inspected > 4096) throw new Error("Compilation wildcard directory exceeds inspection bound.");
      if (!entry.name.endsWith(".py") || entry.name.startsWith(".")) continue;
      const file = path.join(directory, entry.name);
      if (!(await fs.lstat(file)).isFile() || entry.isSymbolicLink()) {
        throw new Error("Compilation wildcard requires regular non-symlink files.");
      }
      matches.push(file);
      if (matches.length > 256) throw new Error("Compilation wildcard exceeds file bound.");
    }
    if (!matches.length) throw new Error("Compilation wildcard matched no files.");
    expanded.push(...matches.sort());
    if (expanded.length > 512) throw new Error("Compilation arguments exceed bound.");
  }
  if (expanded.length > 512) throw new Error("Compilation arguments exceed bound.");
  return expanded;
}

export function commandSerializationResource(commandLine: string, cwd: string): string | null {
  const tokens = splitCommand(normalizeCommand(commandLine));
  const runner = tokens[0];
  if (!runner || !["npm", "pnpm", "yarn", "bun", "next"].includes(runner)) return null;
  let targetDir = path.resolve(cwd);
  const prefixIndex = tokens.findIndex((token) => token === "--prefix" || token === "--dir" || token === "-C");
  if (prefixIndex >= 0 && tokens[prefixIndex + 1]) targetDir = path.resolve(cwd, tokens[prefixIndex + 1]);
  const isBuild = runner === "next"
    ? tokens[1] === "build"
    : tokens.some((token, index) => token === "build" && (tokens[index - 1] === "run" || index === 1));
  return isBuild ? `build:${targetDir}` : null;
}

function createProjectCommandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.PATH = withDeveloperToolPath(env.PATH);

  // Agent Workflow uses DATABASE_URL for its own storage database. Project
  // commands should resolve their database config from the project cwd instead
  // of inheriting the workflow runtime connection string.
  delete env.DATABASE_URL;
  // A workflow test command is a new collection, not a child of the runner's
  // own Node test harness. Inheriting this silently skips nested collections.
  delete env.NODE_TEST_CONTEXT;

  return env;
}

export function withDeveloperToolPath(currentPath: string | undefined): string {
  const prefixes = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const existing = (currentPath ?? "").split(":").filter(Boolean);
  return [...prefixes, ...existing.filter((entry) => !prefixes.includes(entry))].join(":");
}

function matchesPattern(commandLine: string, pattern: string): boolean {
  const normalizedPattern = normalizeCommand(pattern);
  if (normalizedPattern.endsWith(" *")) {
    const prefix = normalizedPattern.slice(0, -2);
    return commandLine === prefix || commandLine.startsWith(`${prefix} `);
  }
  return commandLine === normalizedPattern;
}

function containsShellMetacharacters(commandLine: string): boolean {
  let quote: string | null = null;
  for (const character of commandLine) {
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
    } else if (/[;&|<>`$(){}[\]\n\r]/.test(character)) {
      return true;
    }
  }
  // Quoted arguments are passed literally to spawn with shell:false.
  // Reject incomplete quoting rather than silently changing argument boundaries.
  return quote !== null;
}

function isLikelyLongRunningServerCommand(commandLine: string): boolean {
  const tokens = splitCommand(commandLine);
  const normalized = tokens.join(" ");
  if (/^python3? -m http\.server(?:\s|$)/.test(normalized)) {
    return true;
  }
  if (/^(npm|pnpm|yarn|bun) (run )?(dev|start|serve|preview)(?:\s|$)/.test(normalized)) {
    return true;
  }
  if (/^(vite|next|astro|remix|nuxt|wrangler) (dev|preview)?(?:\s|$)/.test(normalized)) {
    return true;
  }
  return false;
}

function normalizeCommand(commandLine: string): string {
  return commandLine.trim().replace(/\s+/g, " ");
}

function splitCommand(commandLine: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|[^\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }
  return tokens;
}

/** Retain the invocation preamble and latest diagnostics, never the whole log. */
export function createBoundedOutputCapture(maxChars: number): { append(chunk: string): void; text(): string;truncated():boolean } {
  const limit = Math.max(0, Math.floor(maxChars));
  const marker = "\n...[middle truncated]...\n".slice(0, limit);
  const headLimit = Math.floor((limit - marker.length) / 2);
  const tailLimit = limit - marker.length - headLimit;
  let head = "";
  let tail = "";
  let truncated = false;
  return {
    append(chunk) {
      if (!truncated) {
        if (head.length + chunk.length <= limit) {
          head += chunk;
          return;
        }
        // Only this event's input is transiently combined, never past output.
        tail = tailLimit ? (head + chunk).slice(-tailLimit) : "";
        head = (head + chunk).slice(0, headLimit);
        truncated = true;
      } else {
        tail = tailLimit ? (tail + chunk).slice(-tailLimit) : "";
      }
    },
    text: () => truncated ? head + marker + tail : head,
    truncated:()=>truncated
  };
}
