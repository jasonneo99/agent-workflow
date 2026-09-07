import OpenAI from "openai";
import type { FileSummaryInput, FileSummaryOutput, ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";
import {
  buildFileSummaryPrompt,
  buildStagePrompt,
  normalizeFileSummaryArtifact,
  normalizeStageArtifact,
  type FileSummaryJsonArtifact,
  type StageJsonArtifact
} from "./prompts.js";
import type { ModelTier } from "./types.js";
import { selectModelFromCatalog } from "./catalog.js";

const OPENAI_AUTO_MODEL = "auto";

const modelCatalogCache = new Map<string, Promise<string[]>>();

export function configuredOpenAIModelForTier(tier: ModelTier | undefined): string {
  if (tier) {
    const tierModel = process.env[`OPENAI_MODEL_${tier.toUpperCase()}`]?.trim();
    if (tierModel) {
      return tierModel;
    }
  }
  return process.env.OPENAI_MODEL?.trim() || OPENAI_AUTO_MODEL;
}

export async function resolveOpenAIModelForTier(tier: ModelTier | undefined): Promise<{ model: string; source: "env" | "catalog" }> {
  const configured = configuredOpenAIModelForTier(tier);
  if (configured !== OPENAI_AUTO_MODEL) {
    return { model: configured, source: "env" };
  }

  const catalog = await loadOpenAIModelCatalog();
  const selected = selectOpenAIModelFromCatalog(catalog, tier ?? "standard");
  if (!selected) {
    throw new Error("OPENAI_MODEL=auto could not select a model because the OpenAI model catalog was empty or unavailable.");
  }
  return { model: selected, source: "catalog" };
}

export function selectOpenAIModelFromCatalog(modelIds: string[], tier: ModelTier): string | undefined {
  return selectModelFromCatalog(modelIds, tier, { provider: "openai" });
}

export async function loadOpenAIModelCatalog(): Promise<string[]> {
  if (!process.env.OPENAI_API_KEY) {
    return [];
  }

  const cacheKey = process.env.OPENAI_API_KEY.slice(-8);
  let cached = modelCatalogCache.get(cacheKey);
  if (!cached) {
    cached = fetchOpenAIModelCatalog();
    modelCatalogCache.set(cacheKey, cached);
  }
  return cached;
}

async function fetchOpenAIModelCatalog(): Promise<string[]> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const models = await client.models.list();
  return [...new Set(models.data.map((model) => model.id).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export class OpenAIProvider implements ModelProvider {
  id = "openai";
  private readonly client: OpenAI;

  constructor() {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when DEFAULT_MODEL_PROVIDER=openai");
    }

    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  async check(): Promise<{ ready: boolean; details: string[] }> {
    try {
      const modelIds = await loadOpenAIModelCatalog();
      const tierModels = await Promise.all((["fast", "standard", "reasoning"] as const).map(async (tier) => {
        const resolved = await resolveOpenAIModelForTier(tier);
        return `${tier}: ${resolved.model}${resolved.source === "catalog" ? " (auto)" : ""}`;
      }));
      const configuredModels = (["fast", "standard", "reasoning"] as const)
        .map((tier) => configuredOpenAIModelForTier(tier))
        .filter((model) => model !== OPENAI_AUTO_MODEL);
      const available = configuredModels.every((model) => modelIds.includes(model));
      return {
        ready: available,
        details: available
          ? [`OpenAI API reachable`, `Tier models: ${tierModels.join(", ")}`]
          : [`OpenAI API reachable`, `A configured model was not listed: ${configuredModels.join(", ")}`]
      };
    } catch (error) {
      return { ready: false, details: [`OpenAI provider check failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    const { model } = await resolveOpenAIModelForTier(input.modelTier);
    const response = await this.client.responses.create({
      model,
      input: [
        {
          role: "system",
          content: [
            "You are executing one stage in a durable agent workflow.",
            "Return concise JSON only.",
            "Do not claim that files, commands, or external systems changed unless the stage input explicitly includes that evidence."
          ].join(" ")
        },
        {
          role: "user",
          content: buildStagePrompt(input)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "stage_execution_result",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              findings: {
                type: "array",
                items: { type: "string" }
              },
              nextAction: { type: "string" }
              ,
              requestedCommands: {
                type: "array",
                items: { type: "string" }
              },
              requestedFileWrites: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" }
                  },
                  required: ["path", "content"]
                }
              }
            },
            required: ["summary", "findings", "nextAction", "requestedCommands", "requestedFileWrites"]
          },
          strict: true
        }
      }
    });

    const parsed = normalizeStageArtifact(JSON.parse(response.output_text) as StageJsonArtifact);

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
    const { model } = await resolveOpenAIModelForTier("fast");
    const response = await this.client.responses.create({
      model,
      input: [
        {
          role: "system",
          content: [
            "Summarize one project file for future coding-agent context retrieval.",
            "Return concise JSON only.",
            "Emphasize purpose, public interfaces, commands, constraints, and when an agent should read this file."
          ].join(" ")
        },
        {
          role: "user",
          content: buildFileSummaryPrompt(input)
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "file_summary_result",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              keyFacts: {
                type: "array",
                items: { type: "string" }
              },
              likelyUseWhen: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["summary", "keyFacts", "likelyUseWhen"]
          },
          strict: true
        }
      }
    });

    const parsed = normalizeFileSummaryArtifact(JSON.parse(response.output_text) as FileSummaryJsonArtifact);
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

}
