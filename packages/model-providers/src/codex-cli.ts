import { spawn } from "node:child_process";
import { createHash , randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileSummaryInput, FileSummaryOutput, ModelProvider, ModelTier, StageExecutionInput, StageExecutionOutput } from "./types.js";
import { logEgress } from "./egress-log.js";
import { codexCliChildEnvironment } from "./codex-cli-environment.js";
import { assertCodexCliVersion, codexCliPermissionArgs } from "./codex-cli-permissions.js";
import { acceptanceContractSchema, acceptanceContractShapeError } from "./acceptance-schema.js";
import {
  buildFileSummaryPrompt,
  buildStageExecutionOutput,
  buildStagePrompt,
  extractJsonObject,
  normalizeFileSummaryArtifact,
  normalizeStageArtifact,
  type FileSummaryJsonArtifact,
  type StageJsonArtifact
} from "./prompts.js";

type CodexCliRunInput = { prompt: string; schema: Record<string, unknown>; model?: string; reasoningEffort?: "low" | "medium"; workingDirectory?: string; sessionKey?: string;abortSignal?:AbortSignal };
type CodexCliRunResult = { output: string; model: string; usage?: StageExecutionOutput["usage"] };
export type CodexCliDiagnosticCategory = "spawn_unavailable" | "timeout" | "output_limit" | "authentication" | "account_quota" | "rate_limited" | "model_unavailable" | "configuration" | "transport" | "service_unavailable" | "schema_or_usage" | "process_exit";
export interface CodexCliDiagnostic {
  source: "codex-cli";
  category: CodexCliDiagnosticCategory;
  digest: string;
  retryable: boolean;
  exitCode?: number;
  errorCode?: string;
  signal?: NodeJS.Signals;
  /** truncated, secret-redacted subprocess stderr — surfaced, never hashed away */
  stderrExcerpt?: string;
}
type CodexCliProcessError = Error & { code?: string; retryable?: boolean; diagnostic?: CodexCliDiagnostic };
export type CodexCliRunner = {
  authStatus(): Promise<string>;
  execute(input: CodexCliRunInput): Promise<CodexCliRunResult>;
};

const stageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    outcome: { type: "string", enum: ["completed", "blocked"] },
    blockedReason: { type: "string" },
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    nextAction: { type: "string" },
    proposedSourcePaths: { type: "array", maxItems: 40, items: { type: "string", maxLength: 500 } },
    memoryInfluence: {
      type: ["object", "null"], additionalProperties: false,
      properties: {
        used: { type: "array", maxItems: 12, items: {
          type: "object", additionalProperties: false,
          properties: { childRunId: { type: "string", maxLength: 128 }, effect: { type: "string", enum: ["changed-plan", "confirmed-plan", "rejected"] }, reason: { type: "string", maxLength: 1500 } },
          required: ["childRunId", "effect", "reason"]
        } },
        noInfluenceReason: { type: "string", maxLength: 2000 }
      },
      required: ["used", "noInfluenceReason"]
    },
    requestedCommands: { type: "array", items: { type: "string" } },
    requestedFileReads: { type: "array", items: { type: "string" } },
    requestedFileSearches: { type: "array", maxItems: 4, items: { type: "string" } },
    requestedFileWrites: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, content: { type: ["string", "null"] }, patch: { type: ["string", "null"] }, expectedHash: { type: ["string", "null"] } },
        required: ["path", "content", "patch", "expectedHash"]
      }
    }
  },
  required: ["outcome", "blockedReason", "summary", "findings", "nextAction", "proposedSourcePaths", "memoryInfluence", "requestedCommands", "requestedFileReads", "requestedFileSearches", "requestedFileWrites"]
};

const fileSummarySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    keyFacts: { type: "array", items: { type: "string" } },
    likelyUseWhen: { type: "array", items: { type: "string" } }
  },
  required: ["summary", "keyFacts", "likelyUseWhen"]
};

export class CodexCliProvider implements ModelProvider {
  id = "codex-cli";

  constructor(private readonly runner: CodexCliRunner = createCodexCliRunner()) {}

  async check(): Promise<{ ready: boolean; details: string[] }> {
    try {
      const status = await this.runner.authStatus();
      const authMode = configuredAuthMode();
      const ready = authMode === "any"
        ? /logged in using|access token/iu.test(status)
        : authMode === "access-token"
          ? /access token/iu.test(status)
          : /logged in using chatgpt/iu.test(status);
      return {
        ready,
        details: ready
          ? [`Codex CLI is authenticated with ${authMode === "any" ? "an allowed method" : authMode}.`]
          : [`Codex CLI authentication does not satisfy CODEX_CLI_AUTH_MODE=${authMode}.`]
      };
    } catch (error) {
      if ((error as { code?: string }).code === "CODEX_CLI_UNQUALIFIED_VERSION") {
        return { ready: false, details: [(error as Error).message] };
      }
      return { ready: false, details: ["Codex CLI is unavailable or not authenticated."] };
    }
  }

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    await this.requireReady();
    const model = configuredModelForTier(input.modelTier, input.modelOverride);
    const reasoningEffort = input.modelTier === "reasoning" ? "medium" : "low";
    const call: CodexCliRunInput = {
      prompt: [
        "Execute one durable workflow stage. Return only the JSON object required by the supplied schema.",
        "Direct repository inspection is disabled. Use the compiled evidence first. When the exact path is unknown, request a bounded filename/path lookup through requestedFileSearches, then request exact additional files through requestedFileReads. Request policy-governed commands and file writes in the structured output. Do not use native tools or claim side effects.",
        buildStagePrompt(input)
      ].join("\n\n"),
      schema: input.acceptanceContract ? {
        ...stageSchema,
        properties: { ...stageSchema.properties, acceptanceContract: acceptanceContractSchema(input.acceptanceContract) },
        required: [...stageSchema.required, "acceptanceContract"]
      } : stageSchema,
      model,
      reasoningEffort,
      abortSignal: input.abortSignal
    };
    let result = await this.runner.execute(call);
    let decoded = extractJsonObject(result.output) as StageJsonArtifact;
    if (input.acceptanceContract) {
      const shapeError = (value: unknown): string | null => acceptanceContractShapeError(
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).acceptanceContract : undefined,
        input.acceptanceContract!
      );
      const error = shapeError(decoded);
      if (error) {
        result = await this.runner.execute({
          ...call,
          prompt: `${call.prompt}\n\nAcceptance schema correction (one attempt): ${error}. Return a complete response matching the same schema. Receipt gates must contain arrays of typed references. Preserve the supplied authoritative contract and references exactly; never fabricate evidence, weaken gates, or downgrade to legacy. If evidence is unavailable, report the gap.`
        });
        decoded = extractJsonObject(result.output) as StageJsonArtifact;
        const correctionError = shapeError(decoded);
        if (correctionError) throw new Error(`Codex CLI acceptance schema rejected correction: ${correctionError}`);
      }
    }
    const parsed = normalizeStageArtifact(decoded);
    return {
      ...buildStageExecutionOutput(input, parsed, {
      provider: this.id,
      model: result.model,
      modelTier: input.modelTier ?? "standard",
      authMode: configuredAuthMode()
      }),
      ...(result.usage ? { usage: result.usage } : {})
    };
  }

  async summarizeFile(input: FileSummaryInput): Promise<FileSummaryOutput> {
    await this.requireReady();
    const result = await this.runner.execute({
      prompt: [
        "Summarize the supplied file content. Return only the JSON object required by the supplied schema.",
        "Do not inspect the filesystem or execute commands.",
        buildFileSummaryPrompt(input)
      ].join("\n\n"),
      schema: fileSummarySchema,
      model: configuredModelForTier("fast")
    });
    const parsed = normalizeFileSummaryArtifact(extractJsonObject(result.output) as FileSummaryJsonArtifact);
    return {
      summary: [
        parsed.summary,
        parsed.keyFacts.length ? `Key facts: ${parsed.keyFacts.join(" | ")}` : "",
        parsed.likelyUseWhen.length ? `Use when: ${parsed.likelyUseWhen.join(" | ")}` : ""
      ].filter(Boolean).join("\n"),
      artifact: { provider: this.id, model: result.model, sourceUri: input.sourceUri, refined: true, keyFacts: parsed.keyFacts, likelyUseWhen: parsed.likelyUseWhen }
    };
  }

  private async requireReady(): Promise<void> {
    const readiness = await this.check();
    if (!readiness.ready) throw new Error(readiness.details[0]);
  }
}

export function configuredCodexCliModelForTier(tier?: ModelTier, override?: string): string | undefined {
  if (override?.trim()) return override.trim();
  if (tier) {
    const tierModel = process.env[`CODEX_CLI_MODEL_${tier.toUpperCase()}`]?.trim();
    if (tierModel) return tierModel;
  }
  return process.env.CODEX_CLI_MODEL?.trim() || undefined;
}

function configuredModelForTier(tier?: ModelTier, override?: string): string | undefined {
  return configuredCodexCliModelForTier(tier, override);
}

function configuredAuthMode(): "chatgpt" | "access-token" | "any" {
  const value = process.env.CODEX_CLI_AUTH_MODE?.trim().toLowerCase();
  return value === "access-token" || value === "any" ? value : "chatgpt";
}

export function createCodexCliRunner(): CodexCliRunner {
  const binary = resolveCodexCliBinary();
  const requireCompatible = async (cwd: string, abortSignal?: AbortSignal): Promise<void> => {
    const version = await runProcess(binary, ["--version"], undefined, cwd, abortSignal);
    assertCodexCliVersion(version.stdout);
  };
  return {
    authStatus: async () => {
      const temporaryDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-codex-status-")));
      try {
        await requireCompatible(temporaryDir);
        const result = await runProcess(binary, ["login", "status"], undefined, temporaryDir);
        return `${result.stdout}\n${result.stderr}`.trim();
      } finally {
        await fs.rm(temporaryDir, { recursive: true, force: true });
      }
    },
    execute: async ({ prompt, schema, model, reasoningEffort, abortSignal }) => {
      return withCodexCliProcessLock(async () => {
        if (abortSignal?.aborted) throw new Error("Codex CLI execution aborted before process start.");
        const temporaryDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-codex-cli-")));
        const schemaPath = path.join(temporaryDir, "output-schema.json");
        const outputPath = path.join(temporaryDir, "last-message.json");
        try {
          await requireCompatible(temporaryDir, abortSignal);
          const resolvedBinary = await fs.realpath(binary);
          await fs.writeFile(schemaPath, `${JSON.stringify(schema)}\n`, { encoding: "utf8", mode: 0o600 });
          // Always fresh: legacy session pointers and repository cwd inputs are
          // ignored. Every structured action remains subject to controller policy.
          const args = [
            "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--json", "--skip-git-repo-check",
            "--cd", temporaryDir, ...codexCliPermissionArgs(temporaryDir, resolvedBinary),
            "--output-schema", schemaPath, "--output-last-message", outputPath, "--color", "never",
            ...(reasoningEffort ? ["--config", `model_reasoning_effort="${reasoningEffort}"`] : []),
            ...(model ? ["--model", model] : []), "-"
          ];
          const processResult = await runProcess(resolvedBinary, args, prompt, temporaryDir, abortSignal);
          assertCodexCliTurnSucceeded(processResult.stdout);
          const output = await readCodexCliOutputFile(outputPath);
          return { output, model: model ?? "codex-default", usage: parseCodexCliUsage(processResult.stdout) };
        } finally {
          await fs.rm(temporaryDir, { recursive: true, force: true });
        }
      });
    }
  };
}

/** @deprecated Restricted executions are always fresh; legacy environment settings are ignored. */
export function configuredCodexCliSessionReuse(): boolean { return false; }

/** @deprecated Files enter the model context only through controller-owned reads. */
export function configuredCodexCliDirectRepoInspection(): boolean { return false; }

export function parseCodexCliThreadId(jsonl: string): string | undefined {
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const candidate = event.thread_id ?? event.threadId ?? (event.thread && typeof event.thread === "object" ? (event.thread as Record<string, unknown>).id : undefined);
      if (typeof candidate === "string" && /^[0-9a-f-]{36}$/iu.test(candidate)) return candidate;
    } catch { /* Ignore non-event output. */ }
  }
  return undefined;
}

/** @deprecated No native session resumes are permitted. */
export function configuredCodexCliMaxResumes(): number { return 0; }

export function parseCodexCliUsage(jsonl: string): StageExecutionOutput["usage"] {
  let measured: StageExecutionOutput["usage"];
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const usage = findUsageRecord(event);
      if (!usage) continue;
      const inputTokens = finiteUsageNumber(usage.input_tokens ?? usage.inputTokens);
      const cachedInputTokens = finiteUsageNumber(usage.cached_input_tokens ?? usage.cachedInputTokens);
      const reasoningTokens = finiteUsageNumber(usage.reasoning_tokens ?? usage.reasoningTokens);
      const outputTokens = finiteUsageNumber(usage.output_tokens ?? usage.outputTokens);
      const totalTokens = finiteUsageNumber(usage.total_tokens ?? usage.totalTokens) ?? ((inputTokens ?? 0) + (outputTokens ?? 0));
      if (inputTokens !== undefined || outputTokens !== undefined) measured = { inputTokens, cachedInputTokens, reasoningTokens, outputTokens, totalTokens };
    } catch { /* Ignore non-event output while retaining the structured last-message file. */ }
  }
  return measured;
}

function findUsageRecord(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 4) return undefined;
  const record = value as Record<string, unknown>;
  const direct = record.usage;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  for (const nested of Object.values(record)) {
    const found = findUsageRecord(nested, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function finiteUsageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;
}

function resolveCodexCliBinary(): string {
  const command = process.env.CODEX_CLI_BIN?.trim() || "codex";
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? realpathSync(command) : command;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return command;
}

async function withCodexCliProcessLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockPrefix = `agentflow-codex-cli-${typeof process.getuid === "function" ? process.getuid() : "user"}`;
  const concurrency = configuredCodexCliConcurrency();
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const deadline = Date.now() + configuredCodexCliTimeoutMs();
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let lockPath: string | undefined;
  while (!handle) {
    for (let slot = 0; slot < concurrency && !handle; slot += 1) {
      const candidate = path.join(os.tmpdir(), `${lockPrefix}-${slot}.lock`);
      try {
        handle = await fs.open(candidate, "wx", 0o600);
        lockPath = candidate;
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, createdAt: Date.now(), slot })}\n`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const owner = JSON.parse(await fs.readFile(candidate, "utf8")) as { pid?: unknown; createdAt?: unknown };
          const pid = typeof owner.pid === "number" ? owner.pid : 0;
          const createdAt = typeof owner.createdAt === "number" ? owner.createdAt : 0;
          let alive = pid > 0;
          if (alive) {
            try { process.kill(pid, 0); } catch { alive = false; }
          }
          if (!alive || Date.now() - createdAt > configuredCodexCliTimeoutMs() + 60_000) {
            await fs.unlink(candidate).catch(() => undefined);
          }
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
        }
      }
    }
    if (handle) break;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for an Agent Workflow Codex CLI execution slot.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    if (lockPath) {
      try {
        const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token?: unknown };
        if (owner.token === token) await fs.unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

export function configuredCodexCliConcurrency(): number {
  return Math.max(1, Math.min(16, Number(process.env.AGENTFLOW_CODEX_CLI_CONCURRENCY) || 1));
}

export function configuredCodexCliTimeoutMs(): number {
  return Math.max(5_000, Math.min(3_600_000, Number(process.env.CODEX_CLI_TIMEOUT_MS) || 900_000));
}

export function configuredCodexCliOutputMaxBytes(): number {
  const parsed = Number.parseInt(process.env.CODEX_CLI_OUTPUT_MAX_BYTES ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(1_000_000, Math.min(parsed, 32_000_000)) : 8_000_000;
}

/**
 * Reproduced 2026-10-01: `codex exec` can exit 0 while its JSONL stream
 * contains {"type":"turn.failed"} and it never writes --output-last-message.
 * Without this check the failure surfaces as a bare ENOENT on readFile.
 */
function assertCodexCliTurnSucceeded(stdout: string): void {
  let sawTurnFailed = false;
  let sawTurnCompleted = false;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: unknown };
      if (event.type === "turn.failed") sawTurnFailed = true;
      else if (event.type === "turn.completed") sawTurnCompleted = true;
    } catch { /* non-JSON lines carry no turn signal */ }
  }
  if (sawTurnFailed && !sawTurnCompleted) {
    throw codexCliProcessError({
      rawDetail: "codex exec exited 0 but its event stream reported turn.failed and no turn.completed",
      errorCode: "CODEX_CLI_TURN_FAILED"
    });
  }
}

async function readCodexCliOutputFile(outputPath: string): Promise<string> {
  try {
    return await fs.readFile(outputPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw codexCliProcessError({
        rawDetail: "codex exec exited 0 but never wrote the --output-last-message file; the turn likely failed silently",
        errorCode: "CODEX_CLI_MISSING_OUTPUT"
      });
    }
    throw error;
  }
}

async function runProcess(binary: string, args: string[], input: string | undefined, cwd: string,abortSignal?:AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const startedAt = Date.now();
  const timeoutMs = configuredCodexCliTimeoutMs();
  const maxBytes = configuredCodexCliOutputMaxBytes();
  const environment = codexCliChildEnvironment();
  const logSpawn = (outcome: { statusCode?: number; error?: string }): void => {
    const subcommand = args[0] === "exec" && args[1] === "resume" ? "exec resume" : args[0] === "exec" ? "exec" : args.slice(0, 2).join(" ");
    logEgress({
      providerId: "codex-cli",
      host: "localhost",
      endpoint: `codex ${subcommand}`,
      method: "spawn",
      durationMs: Date.now() - startedAt,
      ...outcome
    });
  };
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let terminationReason: "timeout" | "output_limit" | undefined;
    const abort=()=>{terminationReason='timeout';child.kill('SIGTERM');};abortSignal?.addEventListener('abort',abort,{once:true});if(abortSignal?.aborted)abort();
    const timer = setTimeout(() => {
      terminationReason = "timeout";
      child.kill("SIGTERM");
    }, timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        terminationReason = "output_limit";
        child.kill("SIGTERM");
      }
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A short-lived CLI may exit before consuming the prompt. Its close event
      // carries the authoritative exit code and stderr; do not let the expected
      // broken-pipe race mask that diagnostic on Linux runners.
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
      clearTimeout(timer);
      logSpawn({ error: `stdin failed: ${error.code ?? "CODEX_CLI_STDIN_FAILED"}` });
      reject(codexCliProcessError({ rawDetail: error.message, errorCode: error.code ?? "CODEX_CLI_STDIN_FAILED", forcedCategory: "spawn_unavailable" }));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const errorCode = (error as NodeJS.ErrnoException).code ?? "CODEX_CLI_SPAWN_FAILED";
      logSpawn({ error: `spawn failed: ${errorCode}` });
      reject(codexCliProcessError({ rawDetail: error.message, errorCode, forcedCategory: "spawn_unavailable" }));
    });
    child.on("close", (code, signal) => {
      abortSignal?.removeEventListener('abort',abort);
      clearTimeout(timer);
      if (code === 0 && bytes <= maxBytes) {
        logSpawn({});
        resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      }
      else {
        const rawDetail = Buffer.concat(stderr).toString("utf8") || Buffer.concat(stdout).toString("utf8");
        const errorCode = terminationReason === "output_limit"
          ? "CODEX_CLI_OUTPUT_LIMIT"
          : terminationReason === "timeout"
            ? "CODEX_CLI_TIMEOUT"
            : code === null ? "CODEX_CLI_SIGNAL" : `CODEX_CLI_EXIT_${code}`;
        logSpawn({ statusCode: code ?? undefined, error: codexStderrExcerpt(rawDetail).slice(0, 500) });
        reject(codexCliProcessError({ rawDetail, errorCode, exitCode: code ?? undefined, signal: signal ?? undefined, forcedCategory: terminationReason }));
      }
    });
    child.stdin.end(input);
  });
}

const CODEX_STDERR_EXCERPT_MAX = 2000;

/**
 * Collapse, truncate, and redact secrets from subprocess stderr before it is
 * surfaced in error messages, receipts, or logs. Fixes the 2026-10-01 finding
 * that failure evidence was hashed into a digest and thrown away.
 */
export function codexStderrExcerpt(rawDetail: string): string {
  const collapsed = rawDetail.replace(/\s+/gu, " ").trim();
  const truncated = collapsed.length > CODEX_STDERR_EXCERPT_MAX
    ? `${collapsed.slice(0, CODEX_STDERR_EXCERPT_MAX)}\u2026[truncated]`
    : collapsed;
  return truncated
    // URL-embedded credentials: postgres://user:pass@host -> postgres://[redacted]@host
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, "://[redacted]@")
    // key=value secrets: token=, api_key=, *_secret=, password= (quoted or bare)
    .replace(/(\b[\w-]*?(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*)(["']?)[^\s"';,]{4,}\2/gi, "$1$2[redacted]$2")
    .replace(/(bearer\s+)[\w\-./+]{8,}/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9]{8,}[\w-]*/g, "[redacted]");
}

export function buildCodexCliDiagnostic(input: { rawDetail: string; errorCode?: string; exitCode?: number; signal?: NodeJS.Signals; forcedCategory?: "spawn_unavailable" | "timeout" | "output_limit" }): CodexCliDiagnostic {
  const normalized = input.rawDetail.replace(/\s+/gu, " ").trim();
  const label = `${input.errorCode ?? ""} ${normalized}`.toLowerCase();
  const category: CodexCliDiagnosticCategory = input.forcedCategory
    ?? (/invalid[_ -]?api[_ -]?key|unauthorized|authentication|credential/iu.test(label) ? "authentication"
      : /insufficient_quota|billing[_ -]?hard[_ -]?limit|credit balance|quota.*exhaust/iu.test(label) ? "account_quota"
        : /rate.?limit|too many requests|throttl/iu.test(label) ? "rate_limited"
          : /model.*(?:not found|unavailable|does not exist|unsupported)/iu.test(label) ? "model_unavailable"
            : /required environment|missing configuration|unsupported provider adapter/iu.test(label) ? "configuration"
              : /econn|enotfound|etimedout|connection|network|socket|stream.*(?:closed|disconnect)/iu.test(label) ? "transport"
                : /temporar|try again|overload|service unavailable|internal server/iu.test(label) ? "service_unavailable"
                  : /schema|usage|unknown (?:argument|option)|invalid (?:argument|option)/iu.test(label) ? "schema_or_usage"
                    : "process_exit");
  const retryable = category === "timeout" || category === "transport" || category === "service_unavailable"
    || (category === "spawn_unavailable" && /EAGAIN|EBUSY|ECONN|ETIMEDOUT/iu.test(input.errorCode ?? ""));
  const stderrExcerpt = normalized ? codexStderrExcerpt(input.rawDetail) : undefined;
  return {
    source: "codex-cli",
    category,
    digest: createHash("sha256").update([input.errorCode ?? "", String(input.exitCode ?? ""), input.signal ?? "", normalized].join("\u001f")).digest("hex"),
    retryable,
    ...(stderrExcerpt ? { stderrExcerpt } : {}),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  };
}

function codexCliProcessError(input: Parameters<typeof buildCodexCliDiagnostic>[0]): CodexCliProcessError {
  const diagnostic = buildCodexCliDiagnostic(input);
  const safeCode = diagnostic.errorCode ? ` [${diagnostic.errorCode}]` : "";
  const exitInfo = diagnostic.exitCode !== undefined
    ? ` [exit ${diagnostic.exitCode}]`
    : diagnostic.signal ? ` [${diagnostic.signal}]` : "";
  const detail = diagnostic.stderrExcerpt ? ` Detail: ${diagnostic.stderrExcerpt.slice(0, 500)}` : "";
  const failure = new Error(`Codex CLI ${diagnostic.category.replaceAll("_", " ")}${safeCode}${exitInfo} (diagnostic ${diagnostic.digest.slice(0, 12)}).${detail}`) as CodexCliProcessError;
  failure.code = diagnostic.errorCode ?? `CODEX_CLI_${diagnostic.category.toUpperCase()}`;
  failure.retryable = diagnostic.retryable;
  failure.diagnostic = diagnostic;
  return failure;
}
