import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { FileSummaryInput, FileSummaryOutput, ModelProvider, ModelTier, StageExecutionInput, StageExecutionOutput } from "./types.js";
import {
  buildFileSummaryPrompt,
  buildStagePrompt,
  extractJsonObject,
  normalizeFileSummaryArtifact,
  normalizeStageArtifact,
  type FileSummaryJsonArtifact,
  type StageJsonArtifact
} from "./prompts.js";

const execFile = promisify(execFileCallback);

export class KiroProvider implements ModelProvider {
  id = "kiro";
  private readonly cliBin: string;
  private readonly agent?: string;
  private readonly modelLabel: string;
  private readonly timeoutMs: number;

  constructor() {
    this.cliBin = process.env.KIRO_CLI_BIN ?? "kiro-cli";
    this.agent = process.env.KIRO_AGENT || undefined;
    this.modelLabel = "auto";
    this.timeoutMs = Number(process.env.KIRO_TIMEOUT_MS ?? 10 * 60_000);
  }

  async check(): Promise<{ ready: boolean; details: string[] }> {
    try {
      const version = await this.runCli(["--version"], 30_000);
      const modelList = await this.runCli(["chat", "--list-models", "--format", "json"], 60_000);
      return {
        ready: true,
        details: [
          `Kiro CLI installed: ${version.trim()}`,
          `Kiro auth/model access ready.${this.agent ? ` Agent: ${this.agent}.` : ""}`,
          compactModelList(modelList)
        ].filter(Boolean)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ready: false,
        details: [
          `Kiro provider check failed: ${message}`,
          ...kiroRecoveryHints(message)
        ]
      };
    }
  }

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    const modelTier = input.modelTier ?? "standard";
    const text = await this.runKiroPrompt({
      prompt: [
        "You are executing one stage in a durable Agent Workflow run.",
        "Return one valid JSON object only.",
        "Do not wrap the JSON in markdown.",
        "Do not modify files or run commands.",
        "Do not claim that files, commands, or external systems changed unless the stage input explicitly includes that evidence.",
        buildStagePrompt(input)
      ].join("\n\n"),
      tier: modelTier
    });
    const parsed = normalizeStageArtifact(extractJsonObject(stripAnsi(text)) as StageJsonArtifact);

    return {
      summary: parsed.summary,
      requestedCommands: parsed.requestedCommands,
      requestedFileWrites: parsed.requestedFileWrites,
      artifact: {
        provider: this.id,
        model: this.modelLabel,
        modelTier,
        agent: this.agent,
        cli: this.cliBin,
        runId: input.runId,
        taskId: input.taskId,
        workflowId: input.workflowId,
        workflowTask: input.workflowTask,
        stageId: input.stageId,
        agentId: input.agentId,
        agentName: input.agentName,
        stageGoal: input.stageGoal,
        findings: parsed.findings,
        nextAction: parsed.nextAction,
        requestedCommands: parsed.requestedCommands,
        requestedFileWrites: parsed.requestedFileWrites,
        summary: parsed.summary
      }
    };
  }

  async summarizeFile(input: FileSummaryInput): Promise<FileSummaryOutput> {
    const text = await this.runKiroPrompt({
      prompt: [
        "Summarize one project file for future coding-agent context retrieval.",
        "Return one valid JSON object only.",
        "Do not wrap the JSON in markdown.",
        "Emphasize purpose, public interfaces, commands, constraints, and when an agent should read this file.",
        buildFileSummaryPrompt(input)
      ].join("\n\n"),
      tier: "fast"
    });
    const parsed = normalizeFileSummaryArtifact(extractJsonObject(stripAnsi(text)) as FileSummaryJsonArtifact);
    const summary = [
      parsed.summary,
      parsed.keyFacts.length ? `Key facts: ${parsed.keyFacts.join(" | ")}` : "",
      parsed.likelyUseWhen.length ? `Use when: ${parsed.likelyUseWhen.join(" | ")}` : ""
    ].filter(Boolean).join("\n");

    return {
      summary,
      artifact: {
        provider: this.id,
        model: this.modelLabel,
        agent: this.agent,
        cli: this.cliBin,
        sourceUri: input.sourceUri,
        refined: true,
        keyFacts: parsed.keyFacts,
        likelyUseWhen: parsed.likelyUseWhen
      }
    };
  }

  private async runKiroPrompt(input: { prompt: string; tier: ModelTier }): Promise<string> {
    const args = [
      "chat",
      "--no-interactive",
      "--effort",
      effortForTier(input.tier)
    ];
    if (this.agent) {
      args.push("--agent", this.agent);
    }
    args.push(input.prompt);
    return this.runCli(args, this.timeoutMs);
  }

  private async runCli(args: string[], timeoutMs: number): Promise<string> {
    try {
      const { stdout, stderr } = await execFile(this.cliBin, args, {
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        env: process.env
      });
      return [stdout, stderr].filter(Boolean).join("\n");
    } catch (error) {
      throw new Error(formatExecError(error));
    }
  }
}

function effortForTier(tier: ModelTier): string {
  if (tier === "fast") {
    return "low";
  }
  if (tier === "reasoning") {
    return "high";
  }
  return "medium";
}

function compactModelList(value: string): string {
  const text = stripAnsi(value).trim();
  if (!text) {
    return "";
  }
  return text.length > 240 ? `Kiro models: ${text.slice(0, 237)}...` : `Kiro models: ${text}`;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function formatExecError(error: unknown): string {
  if (error && typeof error === "object") {
    const maybe = error as { message?: string; stdout?: string; stderr?: string; code?: number | string; signal?: string };
    const parts = [
      maybe.message,
      maybe.stdout,
      maybe.stderr,
      maybe.code !== undefined ? `exit code: ${maybe.code}` : "",
      maybe.signal ? `signal: ${maybe.signal}` : ""
    ].filter(Boolean);
    return stripAnsi(parts.join("\n")).trim();
  }
  return String(error);
}

function kiroRecoveryHints(message: string): string[] {
  const normalized = message.toLowerCase();
  const hints = [
    "Install or update Kiro CLI with: curl -fsSL https://cli.kiro.dev/install | bash",
    "If your Kiro session expired, run: kiro-cli login",
    "For headless/CI usage, set KIRO_API_KEY from app.kiro.dev account settings.",
    "Or switch Agent Workflow back to OpenAI with: npm run agentflow -- provider-use openai --check"
  ];

  if (normalized.includes("enoent") || normalized.includes("not found")) {
    return [hints[0], hints[3]];
  }
  if (normalized.includes("auth") || normalized.includes("login") || normalized.includes("token") || normalized.includes("unauthorized")) {
    return [hints[1], hints[2], hints[3]];
  }
  return hints;
}
