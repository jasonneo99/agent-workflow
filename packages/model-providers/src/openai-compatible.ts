import OpenAI from "openai";
import type { FileSummaryInput, FileSummaryOutput, ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";
import {
  buildFileSummaryPrompt,
  buildStagePrompt,
  extractJsonObject,
  normalizeFileSummaryArtifact,
  normalizeStageArtifact,
  type FileSummaryJsonArtifact,
  type StageJsonArtifact
} from "./prompts.js";

export class OpenAICompatibleProvider implements ModelProvider {
  id = "openai-compatible";
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly modelEnv: string;

  constructor(input: { id?: string; baseUrlEnv?: string; modelEnv?: string; apiKeyEnv?: string } = {}) {
    this.id = input.id ?? this.id;
    const baseURL = process.env[input.baseUrlEnv ?? "OPENAI_COMPATIBLE_BASE_URL"] ?? process.env.OPENAI_COMPATIBLE_BASE_URL;
    if (!baseURL) {
      throw new Error(`${input.baseUrlEnv ?? "OPENAI_COMPATIBLE_BASE_URL"} is required when DEFAULT_MODEL_PROVIDER=${this.id}`);
    }

    this.baseURL = baseURL;
    this.modelEnv = input.modelEnv ?? "OPENAI_COMPATIBLE_MODEL";
    this.model = process.env[this.modelEnv] ?? process.env.OPENAI_COMPATIBLE_MODEL ?? process.env.OPENAI_MODEL ?? "";
    if (!this.model) {
      throw new Error(`${input.modelEnv ?? "OPENAI_COMPATIBLE_MODEL"} is required when DEFAULT_MODEL_PROVIDER=${this.id}`);
    }

    this.client = new OpenAI({
      apiKey: process.env[input.apiKeyEnv ?? "OPENAI_COMPATIBLE_API_KEY"] || process.env.OPENAI_COMPATIBLE_API_KEY || "not-required",
      baseURL
    });
  }

  async check(): Promise<{ ready: boolean; details: string[] }> {
    try {
      const models = await this.client.models.list();
      const modelIds = models.data.map((model) => model.id);
      const hasConfiguredModel = modelIds.includes(this.model);
      return {
        ready: hasConfiguredModel,
        details: hasConfiguredModel
          ? [`Endpoint reachable: ${this.baseURL}`, `Model available: ${this.model}`]
          : [
            `Endpoint reachable: ${this.baseURL}`,
            `Configured model was not listed: ${this.model}`,
            modelIds.length ? `Available models: ${modelIds.join(", ")}` : "No models listed by endpoint."
          ]
      };
    } catch (error) {
      return {
        ready: false,
        details: [
          `Endpoint check failed: ${error instanceof Error ? error.message : String(error)}`
        ]
      };
    }
  }

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    const model = this.resolveModelForTier(input.modelTier);
    const response = await this.client.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: [
            "You are executing one stage in a durable agent workflow.",
            "Return one valid JSON object only.",
            "Do not claim that files, commands, or external systems changed unless the stage input explicitly includes that evidence."
          ].join(" ")
        },
        {
          role: "user",
          content: buildStagePrompt(input)
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    });

    const parsed = normalizeStageArtifact(extractJsonObject(response.choices[0]?.message.content ?? "") as StageJsonArtifact);

    return {
      summary: parsed.summary,
      requestedCommands: parsed.requestedCommands,
      requestedFileWrites: parsed.requestedFileWrites,
      artifact: {
        provider: this.id,
        model,
        modelTier: input.modelTier ?? "standard",
        responseId: response.id,
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
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: "system",
          content: [
            "Summarize one project file for future coding-agent context retrieval.",
            "Return one valid JSON object only.",
            "Emphasize purpose, public interfaces, commands, constraints, and when an agent should read this file."
          ].join(" ")
        },
        {
          role: "user",
          content: buildFileSummaryPrompt(input)
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    });

    const parsed = normalizeFileSummaryArtifact(extractJsonObject(response.choices[0]?.message.content ?? "") as FileSummaryJsonArtifact);
    const summary = [
      parsed.summary,
      parsed.keyFacts.length ? `Key facts: ${parsed.keyFacts.join(" | ")}` : "",
      parsed.likelyUseWhen.length ? `Use when: ${parsed.likelyUseWhen.join(" | ")}` : ""
    ].filter(Boolean).join("\n");

    return {
      summary,
      artifact: {
        provider: this.id,
        model: this.model,
        responseId: response.id,
        sourceUri: input.sourceUri,
        refined: true,
        keyFacts: parsed.keyFacts,
        likelyUseWhen: parsed.likelyUseWhen
      }
    };
  }

  private resolveModelForTier(tier: StageExecutionInput["modelTier"]): string {
    if (!tier) {
      return this.model;
    }
    const tierEnv = this.modelEnv.replace(/(?:MODEL|MODEL_NAME)$/u, `MODEL_${tier.toUpperCase()}`);
    return process.env[tierEnv] || this.model;
  }
}

export function openAICompatibleConfigStatus(): { ready: boolean; details: string[] } {
  const details: string[] = [];
  if (!process.env.OPENAI_COMPATIBLE_BASE_URL) {
    details.push("OPENAI_COMPATIBLE_BASE_URL is missing");
  }
  if (!process.env.OPENAI_COMPATIBLE_MODEL && !process.env.OPENAI_MODEL) {
    details.push("OPENAI_COMPATIBLE_MODEL is missing");
  }
  return {
    ready: details.length === 0,
    details
  };
}
