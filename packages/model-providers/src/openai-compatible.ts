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
import { selectModelFromCatalog } from "./catalog.js";
import type { ModelTier } from "./types.js";

const AUTO_MODEL = "auto";
const compatibleCatalogCache = new Map<string, Promise<string[]>>();

export class OpenAICompatibleProvider implements ModelProvider {
  id = "openai-compatible";
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly baseURL: string;
  private readonly modelEnv: string;

  constructor(input: { id?: string; baseUrlEnv?: string; modelEnv?: string; apiKeyEnv?: string; defaultBaseURL?: string } = {}) {
    this.id = input.id ?? this.id;
    const baseUrlEnv = input.baseUrlEnv ?? "OPENAI_COMPATIBLE_BASE_URL";
    const legacyBaseURL = input.baseUrlEnv ? undefined : process.env.OPENAI_COMPATIBLE_BASE_URL;
    const baseURL = process.env[baseUrlEnv] ?? legacyBaseURL ?? input.defaultBaseURL;
    if (!baseURL) {
      throw new Error(`${baseUrlEnv} is required when DEFAULT_MODEL_PROVIDER=${this.id}`);
    }

    this.baseURL = baseURL;
    this.modelEnv = input.modelEnv ?? "OPENAI_COMPATIBLE_MODEL";
    this.model = process.env[this.modelEnv] ?? process.env.OPENAI_COMPATIBLE_MODEL ?? process.env.OPENAI_MODEL ?? AUTO_MODEL;

    this.client = new OpenAI({
      apiKey: process.env[input.apiKeyEnv ?? "OPENAI_COMPATIBLE_API_KEY"] || process.env.OPENAI_COMPATIBLE_API_KEY || "not-required",
      baseURL
    });
  }

  async check(): Promise<{ ready: boolean; details: string[] }> {
    try {
      const modelIds = await this.loadModelCatalog();
      const tierModels = await Promise.all((["fast", "standard", "reasoning"] as const).map(async (tier) => {
        const resolved = await this.resolveModelForTier(tier);
        return `${tier}: ${resolved.model}${resolved.source === "catalog" ? " (auto)" : ""}`;
      }));
      const configuredModels = (["fast", "standard", "reasoning"] as const)
        .map((tier) => this.configuredModelForTier(tier))
        .filter((model) => model !== AUTO_MODEL);
      const hasConfiguredModel = configuredModels.every((model) => modelIds.includes(model));
      return {
        ready: hasConfiguredModel,
        details: hasConfiguredModel
          ? [`Endpoint reachable: ${this.baseURL}`, `Tier models: ${tierModels.join(", ")}`]
          : [
            `Endpoint reachable: ${this.baseURL}`,
            `Configured model was not listed: ${configuredModels.join(", ")}`,
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
    const { model } = await this.resolveModelForTier(input.modelTier);
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
    const { model } = await this.resolveModelForTier("fast");
    const response = await this.client.chat.completions.create({
      model,
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
        model,
        responseId: response.id,
        sourceUri: input.sourceUri,
        refined: true,
        keyFacts: parsed.keyFacts,
        likelyUseWhen: parsed.likelyUseWhen
      }
    };
  }

  private configuredModelForTier(tier: ModelTier | undefined): string {
    if (!tier) {
      return this.model;
    }
    const tierEnv = this.modelEnv.replace(/(?:MODEL|MODEL_NAME)$/u, `MODEL_${tier.toUpperCase()}`);
    return process.env[tierEnv] || this.model;
  }

  private async resolveModelForTier(tier: ModelTier | undefined): Promise<{ model: string; source: "env" | "catalog" }> {
    const configured = this.configuredModelForTier(tier);
    if (configured !== AUTO_MODEL) {
      return { model: configured, source: "env" };
    }
    const catalog = await this.loadModelCatalog();
    const selected = selectModelFromCatalog(catalog, tier ?? "standard", { provider: "compatible" });
    if (!selected) {
      throw new Error(`${this.modelEnv}=auto could not select a model because the endpoint model catalog was empty or unavailable.`);
    }
    return { model: selected, source: "catalog" };
  }

  private async loadModelCatalog(): Promise<string[]> {
    const cacheKey = `${this.id}:${this.baseURL}:${this.modelEnv}`;
    let cached = compatibleCatalogCache.get(cacheKey);
    if (!cached) {
      cached = this.client.models.list().then((models) =>
        [...new Set(models.data.map((model) => model.id).filter(Boolean))].sort((a, b) => a.localeCompare(b))
      );
      compatibleCatalogCache.set(cacheKey, cached);
    }
    return cached;
  }
}

export function openAICompatibleConfigStatus(): { ready: boolean; details: string[] } {
  const details: string[] = [];
  if (!process.env.OPENAI_COMPATIBLE_BASE_URL) {
    details.push("OPENAI_COMPATIBLE_BASE_URL is missing");
  }
  return {
    ready: details.length === 0,
    details
  };
}
