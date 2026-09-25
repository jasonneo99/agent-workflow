import type { StageExecutionOutput } from "../../model-providers/src/types.js";
import type { ProviderFallbackAttempt } from "../../model-providers/src/fallback.js";
import { estimateModelCost, MODEL_PRICING_VERSION, modelPricingFromEnv } from "../../fleet-model-gateway/src/index.js";

export function buildModelRouteReceiptContent(input: {
  workflowId: string; stageId: string; agentId: string; route: unknown; fallbackProviderId?: string;
  fallbackUsed: boolean; latencyMs: number; stagePattern: unknown; quality: unknown; output: StageExecutionOutput;
  actualProviderId?: string; actualModel?: string; attempts?: ProviderFallbackAttempt[];
}): Record<string, unknown> {
  const route = objectValue(input.route);
  const actualProviderId = input.actualProviderId ?? input.fallbackProviderId ?? stringValue(route.providerId);
  const usage = enrichUsage(input.output.usage, input.actualModel);
  return {
    target: `${input.workflowId}/${input.stageId}`,
    workflowId: input.workflowId,
    stageId: input.stageId,
    agentId: input.agentId,
    route: input.route,
    fallbackProviderId: input.fallbackProviderId,
    fallbackUsed: input.fallbackUsed,
    actualProviderId,
    actualModel: input.actualModel,
    attempts: input.attempts ?? [],
    usage,
    latencyMs: input.latencyMs,
    stagePattern: input.stagePattern,
    quality: input.quality
  };
}

export function enrichUsage(usage: StageExecutionOutput["usage"], model: string | undefined): StageExecutionOutput["usage"] {
  if (!usage) return undefined;
  const inputTokens = finiteToken(usage.inputTokens);
  const cachedInputTokens = finiteToken(usage.cachedInputTokens);
  const reasoningTokens = finiteToken(usage.reasoningTokens);
  const outputTokens = finiteToken(usage.outputTokens);
  const totalTokens = finiteToken(usage.totalTokens) ?? ((inputTokens ?? 0) + (outputTokens ?? 0));
  const normalized = { inputTokens, cachedInputTokens, reasoningTokens, outputTokens, totalTokens };
  const providerCost = finiteCost(usage.costUsd);
  const estimatedCost = providerCost ?? estimateModelCost({
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
    reasoningTokens: reasoningTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens
  }, model, modelPricingFromEnv());
  return {
    ...usage,
    ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined)),
    ...(estimatedCost === undefined ? {} : { costUsd: estimatedCost }),
    costSource: providerCost !== undefined ? "provider-reported" : estimatedCost !== undefined ? "catalog-estimate" : "unavailable",
    pricingVersion: MODEL_PRICING_VERSION
  };
}

function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.length ? value : undefined; }
function finiteToken(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined; }
function finiteCost(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined; }
