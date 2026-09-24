import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { StageExecutionInput, StageExecutionOutput } from "../../model-providers/src/types.js";

type StagePattern = NonNullable<StageExecutionInput["stagePattern"]>;

export const COMMAND_FAILURE_ERROR_OUTPUT_MAX_LINES = 20;
export const COMMAND_FAILURE_ERROR_OUTPUT_MAX_CHARS = 4000;
export const VERIFY_COMMAND_RETRY_BUDGET_DEFAULT = 2;
export const VERIFY_COMMAND_RETRY_BUDGET_MAX = 5;

export function truncateCommandOutputForError(
  output: string,
  maxLines: number = COMMAND_FAILURE_ERROR_OUTPUT_MAX_LINES,
  maxChars: number = COMMAND_FAILURE_ERROR_OUTPUT_MAX_CHARS
): string {
  const lines = output.split("\n");
  const head = lines.slice(0, Math.max(1, maxLines)).join("\n");
  const text = lines.length > maxLines
    ? `${head}\n… [truncated: showing first ${maxLines} of ${lines.length} lines]`
    : head;
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars))}\n… [truncated: showing first ${maxChars} chars]`
    : text;
}

export function formatCommandFailureEvidence(input: {
  commandLine: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}): string {
  const combined = [input.stdout?.trim(), input.stderr?.trim()]
    .filter((part): part is string => Boolean(part))
    .join("\n");
  const outcome = input.timedOut ? "timed out" : `exited with code ${input.exitCode}`;
  if (!combined) return `Command \`${input.commandLine}\` ${outcome}; it produced no output.`;
  return `Command \`${input.commandLine}\` ${outcome}.\nCommand output (truncated):\n${truncateCommandOutputForError(combined)}`;
}

export function commandFailureEligibleForVerifyRetry(stagePattern: Pick<StagePattern, "type">): boolean {
  const type = stagePattern.type.trim().toLowerCase();
  return type === "test" || type === "verify" || type === "verifier";
}

export function verifyRetryBudgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AGENTFLOW_VERIFY_RETRY_BUDGET?.trim();
  if (!raw) return VERIFY_COMMAND_RETRY_BUDGET_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return VERIFY_COMMAND_RETRY_BUDGET_DEFAULT;
  return Math.min(VERIFY_COMMAND_RETRY_BUDGET_MAX, Math.max(0, parsed));
}

export function npmPreflightDiagnostic(commandLine: string, cwd: string): string | null {
  const tokens = commandLine.trim().split(/\s+/);
  if (tokens[0] !== "npm") return null;
  const runIndex = tokens[1] === "run" ? 1 : tokens[1] === "--prefix" && tokens[3] === "run" ? 3 : -1;
  if (runIndex < 0) return null;
  let targetDir = cwd;
  const prefixIndex = tokens.findIndex((token) => token === "--prefix");
  if (prefixIndex >= 0 && prefixIndex < runIndex && tokens[prefixIndex + 1]) {
    targetDir = path.resolve(cwd, tokens[prefixIndex + 1]);
  }
  if (existsSync(path.join(targetDir, "package.json"))) return null;
  return `Cannot run \`${commandLine.trim()}\`: no package.json found in ${targetDir} (resolved from cwd ${cwd}). npm run requires a package.json in the working directory; without it npm fails with ENOENT. Run the command from the directory containing package.json, or create one there.`;
}

export function parseGitStatusPorcelain(porcelain: string): Set<string> {
  const paths = new Set<string>();
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrowIndex = rest.indexOf(" -> ");
    const rawPath = arrowIndex >= 0 ? rest.slice(arrowIndex + 4) : rest;
    const unquoted = rawPath.length >= 2 && rawPath.startsWith('"') && rawPath.endsWith('"') ? rawPath.slice(1, -1) : rawPath;
    if (unquoted) paths.add(unquoted);
  }
  return paths;
}

export function diffGitFootprint(before: Set<string>, after: Set<string>): Set<string> {
  return new Set([...after].filter((entry) => !before.has(entry)));
}

const VERIFY_FAILURE_FILE_PATTERNS = [
  /^\s*([^\s(]+\.[A-Za-z0-9]+)\(\d+,\d+\)/,
  /^\s*((?:[A-Za-z]:)?[^\s]+\.[A-Za-z0-9]+):\d+:\d+/
];

export function extractVerifyFailureFiles(output: string, cwd: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const cwdPosix = cwd.replace(/\\/g, "/");
  for (const line of output.split("\n")) {
    for (const pattern of VERIFY_FAILURE_FILE_PATTERNS) {
      const match = pattern.exec(line);
      if (!match) continue;
      let rel = match[1].replace(/\\/g, "/");
      if (path.posix.isAbsolute(rel)) {
        if (!rel.startsWith(`${cwdPosix}/`)) break;
        rel = rel.slice(cwdPosix.length + 1);
      }
      rel = path.posix.normalize(rel);
      if (rel === ".." || rel.startsWith("../")) break;
      if (!seen.has(rel)) {
        seen.add(rel);
        files.push(rel);
      }
      break;
    }
  }
  return files;
}

export type VerifyFailureAttribution = { kind: "agent" | "environmental"; files: string[] };

function verifyFileInFootprint(file: string, footprint: Set<string>): boolean {
  return [...footprint].some((entry) => entry === file || (entry.endsWith("/") && file.startsWith(entry)));
}

export function attributeVerifyFailure(input: {
  outputLines: string[];
  footprintBefore: Set<string> | null;
  footprintAfter: Set<string> | null;
  cwd: string;
}): VerifyFailureAttribution {
  const files = extractVerifyFailureFiles(input.outputLines.join("\n"), input.cwd);
  if (input.footprintBefore === null || input.footprintAfter === null || files.length === 0) return { kind: "agent", files };
  const footprint = diffGitFootprint(input.footprintBefore, input.footprintAfter);
  return { kind: files.every((file) => !verifyFileInFootprint(file, footprint)) ? "environmental" : "agent", files };
}

const execFileAsync = promisify(execFile);

export async function snapshotGitStatus(cwd: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], { cwd, timeout: 15000 });
    return parseGitStatusPorcelain(stdout);
  } catch {
    return null;
  }
}

export async function attributeVerifyCommandFailure(input: {
  outputLines: string[];
  cwd: string;
  footprintBefore: Set<string> | null;
}): Promise<VerifyFailureAttribution> {
  const footprintAfter = input.footprintBefore === null ? null : await snapshotGitStatus(input.cwd);
  return attributeVerifyFailure({ ...input, footprintAfter });
}

export function commandFailureIsDiagnosticEvidence(stagePattern: Pick<StagePattern, "type">): boolean {
  return stagePattern.type === "planner" || stagePattern.type === "react";
}

export function commandFailurePrecedesGovernedWrites(
  stagePattern: Pick<StagePattern, "type">,
  output: Pick<StageExecutionOutput, "requestedFileWrites">
): boolean {
  return stagePattern.type === "executor" && (output.requestedFileWrites?.length ?? 0) > 0;
}
