import { spawn } from "node:child_process";
import type { ProjectConfig } from "../../agent-registry/src/schemas.js";

export interface CommandExecutionResult {
  commandLine: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export function assertCommandAllowed(commandLine: string, project: ProjectConfig): void {
  const normalized = normalizeCommand(commandLine);

  if (containsShellMetacharacters(normalized)) {
    throw new Error("Command rejected: shell metacharacters are not allowed.");
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
}): Promise<CommandExecutionResult> {
  const commandLine = normalizeCommand(input.commandLine);
  assertCommandAllowed(commandLine, input.project);
  const argv = splitCommand(commandLine);
  if (!argv.length) {
    throw new Error("Command is empty.");
  }

  const started = Date.now();
  const timeoutMs = input.project.actions.command_timeout_ms;
  const maxOutputChars = input.project.actions.max_output_chars;

  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: input.cwd,
      shell: false,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = truncateOutput(stdout + chunk.toString("utf8"), maxOutputChars);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = truncateOutput(stderr + chunk.toString("utf8"), maxOutputChars);
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({
        commandLine,
        cwd: input.cwd,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut
      });
    });
  });
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
  return /[;&|<>`$(){}[\]\n\r]/.test(commandLine);
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

function truncateOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

