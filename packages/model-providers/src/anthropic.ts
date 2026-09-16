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
import { selectModelFromCatalog } from "./catalog.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const AUTO_MODEL = "auto";
const catalogCache = new Map<string, Promise<string[]>>();

type AnthropicMessageResponse = {
  id?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

class AnthropicApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    requestId: string | null
  ) {
    super(`Anthropic API returned HTTP ${status}${requestId ? ` (request ${requestId})` : ""}`);
    this.name = "AnthropicApiError";
  }
}

export function configuredAnthropicModelForTier(tier: ModelTier | undefined): string {
  if (tier) {
    const tierModel = process.env[`ANTHROPIC_MODEL_${tier.toUpperCase()}`]?.trim();
    if (tierModel) return tierModel;
  }
  return process.env.ANTHROPIC_MODEL?.trim() || AUTO_MODEL;
}

export async function loadAnthropicModelCatalog(): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  const cacheKey = apiKey.slice(-8);
  let cached = catalogCache.get(cacheKey);
  if (!cached) {
    cached = anthropicRequest<{ data?: Array<{ id?: string }> }>("/models").then((result) =>
      [...new Set((result.data ?? []).map((model) => model.id).filter((id): id is string => Boolean(id)))].sort((a, b) => a.localeCompare(b))
    );
    catalogCache.set(cacheKey, cached);
  }
  return cached;
}

export async function resolveAnthropicModelForTier(tier: ModelTier | undefined): Promise<{ model: string; source: "env" | "catalog" }> {
  const configured = configuredAnthropicModelForTier(tier);
  if (configured !== AUTO_MODEL) return { model: configured, source: "env" };
  const selected = selectModelFromCatalog(await loadAnthropicModelCatalog(), tier ?? "standard", { provider: "anthropic" });
  if (!selected) throw new Error("ANTHROPIC_MODEL=auto could not select a Claude model because the Anthropic model catalog was empty or unavailable.");
  return { model: selected, source: "catalog" };
}

export class AnthropicProvider implements ModelProvider {
  id = "anthropic";

  constructor() {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is required when DEFAULT_MODEL_PROVIDER=anthropic");
    }
  }

  async check(): Promise<{ ready: boolean; details: string[] }> {
    try {
      const modelIds = await loadAnthropicModelCatalog();
      const tierModels = await Promise.all(((["fast", "standard", "reasoning"] as const)).map(async (tier) => {
        const resolved = await resolveAnthropicModelForTier(tier);
        return `${tier}: ${resolved.model}${resolved.source === "catalog" ? " (auto)" : ""}`;
      }));
      const configured = (["fast", "standard", "reasoning"] as const)
        .map((tier) => configuredAnthropicModelForTier(tier))
        .filter((model) => model !== AUTO_MODEL);
      const available = configured.every((model) => modelIds.includes(model));
      return {
        ready: available,
        details: available
          ? ["Anthropic API reachable", `Tier models: ${tierModels.join(", ")}`]
          : ["Anthropic API reachable", `A configured Claude model was not listed: ${configured.filter((model) => !modelIds.includes(model)).join(", ")}`]
      };
    } catch (error) {
      return { ready: false, details: [`Anthropic provider check failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    const model = input.modelOverride ?? (await resolveAnthropicModelForTier(input.modelTier)).model;
    const response = await createMessage(model, [
      "You are executing one stage in a durable agent workflow.",
      "Return one valid JSON object only.",
      "Do not claim that files, commands, or external systems changed unless the stage input explicitly includes that evidence."
    ].join(" "), buildStagePrompt(input));
    const parsed = normalizeStageArtifact(extractJsonObject(messageText(response)) as StageJsonArtifact);
    return {
      ...buildStageExecutionOutput(input, parsed, {
        provider: this.id,
        model,
        modelTier: input.modelTier ?? "standard",
        responseId: response.id
      }),
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
        totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)
      }
    };
  }

  async summarizeFile(input: FileSummaryInput): Promise<FileSummaryOutput> {
    const { model } = await resolveAnthropicModelForTier("fast");
    const response = await createMessage(model, [
      "Summarize one project file for future coding-agent context retrieval.",
      "Return one valid JSON object only.",
      "Emphasize purpose, public interfaces, commands, constraints, and when an agent should read this file."
    ].join(" "), buildFileSummaryPrompt(input));
    const parsed = normalizeFileSummaryArtifact(extractJsonObject(messageText(response)) as FileSummaryJsonArtifact);
    return {
      summary: [
        parsed.summary,
        parsed.keyFacts.length ? `Key facts: ${parsed.keyFacts.join(" | ")}` : "",
        parsed.likelyUseWhen.length ? `Use when: ${parsed.likelyUseWhen.join(" | ")}` : ""
      ].filter(Boolean).join("\n"),
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

async function createMessage(model: string, system: string, prompt: string): Promise<AnthropicMessageResponse> {
  return anthropicRequest<AnthropicMessageResponse>("/messages", buildAnthropicMessageRequest(model, system, prompt));
}

export function buildAnthropicMessageRequest(model: string, system: string, prompt: string): Record<string, unknown> {
  return {
    model,
    max_tokens: 4096,
    system,
    messages: [{ role: "user", content: prompt }]
  };
}

async function anthropicRequest<T>(path: string, body?: unknown): Promise<T> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");
  const response = await fetch(`${process.env.ANTHROPIC_BASE_URL?.replace(/\/$/u, "") || ANTHROPIC_API_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    const requestId = response.headers.get("request-id");
    const payload = await response.json().catch(() => undefined) as { error?: { type?: unknown } } | undefined;
    const code = typeof payload?.error?.type === "string" ? payload.error.type : undefined;
    throw new AnthropicApiError(response.status, code, requestId);
  }
  return await response.json() as T;
}

function messageText(response: AnthropicMessageResponse): string {
  const text = (response.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
  if (!text) throw new Error("Anthropic response did not contain a text block.");
  return text;
}
