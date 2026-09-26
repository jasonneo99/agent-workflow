import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileSummaryInput, FileSummaryOutput, ModelProvider, ModelTier, StageExecutionInput, StageExecutionOutput } from "./types.js";
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

type CodexCliRunInput = { prompt: string; schema: Record<string, unknown>; model?: string; workingDirectory?: string; sessionKey?: string };
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
}
type CodexCliProcessError = Error & { code?: string; retryable?: boolean; diagnostic?: CodexCliDiagnostic };
const codexCliSessions = new Map<string, string>();
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
    requestedCommands: { type: "array", items: { type: "string" } },
    requestedFileReads: { type: "array", items: { type: "string" } },
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
  required: ["outcome", "blockedReason", "summary", "findings", "nextAction", "requestedCommands", "requestedFileReads", "requestedFileWrites"]
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
    } catch {
      return { ready: false, details: ["Codex CLI is unavailable or not authenticated."] };
    }
  }

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    await this.requireReady();
    const model = configuredModelForTier(input.modelTier, input.modelOverride);
    const result = await this.runner.execute({
      prompt: [
        "Execute one durable workflow stage. Return only the JSON object required by the supplied schema.",
        input.projectRootUri
          ? "Treat the supplied stage context and prior artifacts as primary. Avoid broad repository scans and repeated orientation. Inspect only a small, task-relevant path when the supplied evidence is insufficient; otherwise request exact additional files through requestedFileReads. Resolve named commits with bounded git show/diff when required. The sandbox prevents writes. Do not claim mutations or validation that you did not perform; request policy-governed commands and file writes in the structured output."
          : "No project checkout is available. Do not inspect unrelated filesystem locations, execute commands, or claim side effects.",
        buildStagePrompt(input)
      ].join("\n\n"),
      schema: stageSchema,
      model,
      workingDirectory: input.projectRootUri,
      sessionKey: input.runId
    });
    const parsed = normalizeStageArtifact(extractJsonObject(result.output) as StageJsonArtifact);
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
  return {
    authStatus: async () => {
      const result = await runProcess(binary, ["login", "status"], undefined, process.cwd());
      return `${result.stdout}\n${result.stderr}`.trim();
    },
    execute: async ({ prompt, schema, model, workingDirectory, sessionKey }) => {
      return withCodexCliProcessLock(async () => {
        const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-codex-cli-"));
        const schemaPath = path.join(temporaryDir, "output-schema.json");
        const outputPath = path.join(temporaryDir, "last-message.json");
        try {
          await fs.writeFile(schemaPath, `${JSON.stringify(schema)}\n`, { encoding: "utf8", mode: 0o600 });
          const executionDirectory = workingDirectory?.trim() ? path.resolve(workingDirectory) : temporaryDir;
          const reusableSession = configuredCodexCliSessionReuse() && sessionKey ? await loadCodexCliSession(sessionKey) : undefined;
          const args = reusableSession
            ? [
              "exec", "resume", "--ignore-user-config", "--ignore-rules", "--json", "--skip-git-repo-check",
              "--output-schema", schemaPath, "--output-last-message", outputPath,
              ...(model ? ["--model", model] : []), reusableSession, "-"
            ]
            : [
              "exec", ...(configuredCodexCliSessionReuse() && sessionKey ? [] : ["--ephemeral"]),
              "--ignore-user-config", "--ignore-rules", "--json", "--skip-git-repo-check",
              "--sandbox", "read-only", "--cd", executionDirectory,
              "--output-schema", schemaPath, "--output-last-message", outputPath,
              "--color", "never", ...(model ? ["--model", model] : []), "-"
            ];
          const processResult = await runProcess(binary, args, prompt, executionDirectory);
          if (!reusableSession && sessionKey) {
            const threadId = parseCodexCliThreadId(processResult.stdout);
            if (threadId) {
              codexCliSessions.set(sessionKey, threadId);
              await rememberCodexCliSession(sessionKey, threadId);
              while (codexCliSessions.size > 128) codexCliSessions.delete(codexCliSessions.keys().next().value!);
            }
          }
          return { output: await fs.readFile(outputPath, "utf8"), model: model ?? "codex-default", usage: parseCodexCliUsage(processResult.stdout) };
        } finally {
          await fs.rm(temporaryDir, { recursive: true, force: true });
        }
      });
    }
  };
}

export function configuredCodexCliSessionReuse(): boolean {
  return !/^(?:0|false|off|no)$/iu.test(process.env.AGENTFLOW_CODEX_SESSION_REUSE?.trim() ?? "");
}

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

async function loadCodexCliSession(sessionKey: string): Promise<string | undefined> {
  const cached = codexCliSessions.get(sessionKey);
  if (cached) return cached;
  try {
    const record = JSON.parse(await fs.readFile(codexCliSessionPath(sessionKey), "utf8")) as { threadId?: unknown; createdAt?: unknown };
    if (typeof record.threadId !== "string" || !/^[0-9a-f-]{36}$/iu.test(record.threadId)) return undefined;
    if (typeof record.createdAt !== "number" || Date.now() - record.createdAt > 24 * 60 * 60 * 1000) return undefined;
    codexCliSessions.set(sessionKey, record.threadId);
    return record.threadId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    return undefined;
  }
}

async function rememberCodexCliSession(sessionKey: string, threadId: string): Promise<void> {
  const directory = codexCliSessionDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(codexCliSessionPath(sessionKey), `${JSON.stringify({ threadId, createdAt: Date.now() })}\n`, { mode: 0o600 });
}

function codexCliSessionDirectory(): string {
  return path.join(os.tmpdir(), `agentflow-codex-sessions-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

function codexCliSessionPath(sessionKey: string): string {
  return path.join(codexCliSessionDirectory(), `${createHash("sha256").update(sessionKey).digest("hex")}.json`);
}

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
  const configured = process.env.CODEX_CLI_BIN?.trim();
  if (configured) return configured;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, "codex");
    if (existsSync(candidate)) return candidate;
  }
  return "codex";
}

async function withCodexCliProcessLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockPrefix = `agentflow-codex-cli-${typeof process.getuid === "function" ? process.getuid() : "user"}`;
  const concurrency = configuredCodexCliConcurrency();
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
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

async function runProcess(binary: string, args: string[], input: string | undefined, cwd: string): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = configuredCodexCliTimeoutMs();
  const maxBytes = configuredCodexCliOutputMaxBytes();
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_ADMIN_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let terminationReason: "timeout" | "output_limit" | undefined;
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
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(codexCliProcessError({ rawDetail: error.message, errorCode: (error as NodeJS.ErrnoException).code ?? "CODEX_CLI_SPAWN_FAILED", forcedCategory: "spawn_unavailable" }));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && bytes <= maxBytes) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      else {
        const rawDetail = Buffer.concat(stderr).toString("utf8") || Buffer.concat(stdout).toString("utf8");
        const errorCode = terminationReason === "output_limit"
          ? "CODEX_CLI_OUTPUT_LIMIT"
          : terminationReason === "timeout"
            ? "CODEX_CLI_TIMEOUT"
            : code === null ? "CODEX_CLI_SIGNAL" : `CODEX_CLI_EXIT_${code}`;
        reject(codexCliProcessError({ rawDetail, errorCode, exitCode: code ?? undefined, signal: signal ?? undefined, forcedCategory: terminationReason }));
      }
    });
    child.stdin.end(input);
  });
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
  return {
    source: "codex-cli",
    category,
    digest: createHash("sha256").update([input.errorCode ?? "", String(input.exitCode ?? ""), input.signal ?? "", normalized].join("\u001f")).digest("hex"),
    retryable,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.signal ? { signal: input.signal } : {})
  };
}

function codexCliProcessError(input: Parameters<typeof buildCodexCliDiagnostic>[0]): CodexCliProcessError {
  const diagnostic = buildCodexCliDiagnostic(input);
  const safeCode = diagnostic.errorCode ? ` [${diagnostic.errorCode}]` : "";
  const failure = new Error(`Codex CLI ${diagnostic.category.replaceAll("_", " ")}${safeCode} (diagnostic ${diagnostic.digest.slice(0, 12)}).`) as CodexCliProcessError;
  failure.code = diagnostic.errorCode ?? `CODEX_CLI_${diagnostic.category.toUpperCase()}`;
  failure.retryable = diagnostic.retryable;
  failure.diagnostic = diagnostic;
  return failure;
}
