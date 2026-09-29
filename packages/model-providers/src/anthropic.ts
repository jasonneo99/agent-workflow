import { inferModelTaskClass, rankModelsFromCatalog } from "./catalog.js";
import { buildStageExecutionOutput, buildStagePrompt, extractJsonObject, normalizeStageArtifact, type StageJsonArtifact } from "./prompts.js";
import { classifyModelAttemptFailure, modelCandidatesExhaustedError, type ModelAttemptFailure } from "./fallback.js";
import type { ModelProvider, ModelTier, StageExecutionInput, StageExecutionOutput } from "./types.js";

const API_VERSION = "2023-06-01";
const AUTO_MODEL = "auto";

export class AnthropicProvider implements ModelProvider {
  id = "anthropic";
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY ?? "";
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY is required when DEFAULT_MODEL_PROVIDER=anthropic");
    this.baseUrl = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/u, "");
  }

  async check(): Promise<{ ready: boolean; details: string[] }> {
    try {
      const models = await this.loadModelCatalog();
      return { ready: models.length > 0, details: [`Anthropic API reachable`, `${models.length} Claude model(s) visible to this key.`] };
    } catch (error) {
      return { ready: false, details: [`Anthropic provider check failed: ${error instanceof Error ? error.message : String(error)}`] };
    }
  }

  async executeStage(input: StageExecutionInput): Promise<StageExecutionOutput> {
    const candidates = await this.modelCandidates(input);
    const attempts: ModelAttemptFailure[] = [];
    for (const [index, model] of candidates.entries()) {
      try {
        const response = await this.request("/v1/messages", {
          method: "POST",
          body: JSON.stringify({
            model,
            max_tokens: Number(process.env.ANTHROPIC_MAX_TOKENS ?? 4096),
            system: "You are executing one stage in a durable agent workflow. Return one valid JSON object only. Do not claim side effects without explicit evidence.",
            messages: [{ role: "user", content: buildStagePrompt(input) }]
          })
        }) as { id?: string; content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
        const text = response.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("") ?? "";
        const parsed = normalizeStageArtifact(extractJsonObject(text) as StageJsonArtifact);
        return {
          ...buildStageExecutionOutput(input, parsed, { provider: this.id, model, modelTier: input.modelTier ?? "standard", responseId: response.id }),
          usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens, totalTokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0) },
          modelAttempts: attempts.map(({ providerId, model: failedModel, status, category }) => ({ providerId, model: failedModel, status, category }))
        };
      } catch (error) {
        const failure = classifyModelAttemptFailure(error, this.id, model);
        attempts.push(failure);
        if (!failure.retryNextModel || index === candidates.length - 1) throw modelCandidatesExhaustedError(this.id, attempts, error);
      }
    }
    throw new Error("Anthropic model candidate list was unexpectedly empty.");
  }

  private async modelCandidates(input: StageExecutionInput): Promise<string[]> {
    const tier = input.modelTier ?? "standard";
    const configured = process.env[`ANTHROPIC_MODEL_${tier.toUpperCase()}`]?.trim() || process.env.ANTHROPIC_MODEL?.trim() || AUTO_MODEL;
    if (configured !== AUTO_MODEL) return [configured];
    const ranked = rankModelsFromCatalog(await this.loadModelCatalog(), tier, { provider: "anthropic", taskClass: inferModelTaskClass(input) });
    if (!ranked.length) throw new Error("ANTHROPIC_MODEL=auto could not select a Claude model from the live catalog.");
    return ranked;
  }

  private async loadModelCatalog(): Promise<string[]> {
    const response = await this.request("/v1/models?limit=1000", { method: "GET" }) as { data?: Array<{ id?: string }> };
    return [...new Set(response.data?.map((item) => item.id).filter((id): id is string => Boolean(id)) ?? [])].sort();
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-api-key": this.apiKey, "anthropic-version": API_VERSION, ...init.headers }
    });
    const body = await response.text();
    if (!response.ok) {
      const error = new Error(`Anthropic API ${response.status}: ${body.slice(0, 300)}`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    return body ? JSON.parse(body) : {};
  }
}
