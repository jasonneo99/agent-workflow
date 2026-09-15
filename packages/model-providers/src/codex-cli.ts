import { spawn } from "node:child_process";
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

type CodexCliRunInput = { prompt: string; schema: Record<string, unknown>; model?: string };
type CodexCliRunResult = { output: string; model: string };
export type CodexCliRunner = {
  authStatus(): Promise<string>;
  execute(input: CodexCliRunInput): Promise<CodexCliRunResult>;
};

const stageSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    nextAction: { type: "string" },
    requestedCommands: { type: "array", items: { type: "string" } },
    requestedFileWrites: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"]
      }
    }
  },
  required: ["summary", "findings", "nextAction", "requestedCommands", "requestedFileWrites"]
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
        "Do not inspect the filesystem, execute commands, or claim side effects.",
        buildStagePrompt(input)
      ].join("\n\n"),
      schema: stageSchema,
      model
    });
    const parsed = normalizeStageArtifact(extractJsonObject(result.output) as StageJsonArtifact);
    return buildStageExecutionOutput(input, parsed, {
      provider: this.id,
      model: result.model,
      modelTier: input.modelTier ?? "standard",
      authMode: configuredAuthMode()
    });
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
  const binary = process.env.CODEX_CLI_BIN?.trim() || "codex";
  return {
    authStatus: async () => {
      const result = await runProcess(binary, ["login", "status"], undefined, process.cwd());
      return `${result.stdout}\n${result.stderr}`.trim();
    },
    execute: async ({ prompt, schema, model }) => {
      const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentflow-codex-cli-"));
      const schemaPath = path.join(temporaryDir, "output-schema.json");
      const outputPath = path.join(temporaryDir, "last-message.json");
      try {
        await fs.writeFile(schemaPath, `${JSON.stringify(schema)}\n`, { encoding: "utf8", mode: 0o600 });
        const args = [
          "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
          "--skip-git-repo-check", "--sandbox", "read-only", "--cd", temporaryDir,
          "--output-schema", schemaPath, "--output-last-message", outputPath,
          "--color", "never", ...(model ? ["--model", model] : []), "-"
        ];
        await runProcess(binary, args, prompt, temporaryDir);
        return { output: await fs.readFile(outputPath, "utf8"), model: model ?? "codex-default" };
      } finally {
        await fs.rm(temporaryDir, { recursive: true, force: true });
      }
    }
  };
}

async function runProcess(binary: string, args: string[], input: string | undefined, cwd: string): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = Math.max(5_000, Math.min(900_000, Number(process.env.CODEX_CLI_TIMEOUT_MS) || 300_000));
  const maxBytes = 1_000_000;
  const environment: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_ADMIN_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) child.kill("SIGTERM");
      else target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.on("error", () => { clearTimeout(timer); reject(new Error("Codex CLI could not be started.")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && bytes <= maxBytes) resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
      else reject(new Error(code === null ? "Codex CLI execution timed out or exceeded its output limit." : `Codex CLI execution failed with exit code ${code}.`));
    });
    child.stdin.end(input);
  });
}
