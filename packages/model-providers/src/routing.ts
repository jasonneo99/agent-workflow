import type { ModelTier, StageExecutionInput } from "./types.js";

export interface ModelRouteDecision {
  providerId: string;
  modelTier: ModelTier;
  mode: "fixed" | "adaptive";
  reason: string;
  estimatedCostTier: "none" | "low" | "medium" | "high";
}

export function selectModelRoute(input: Pick<StageExecutionInput, "modelTier" | "agentId" | "stageId" | "workflowId">): ModelRouteDecision {
  const modelTier = input.modelTier ?? "standard";
  const defaultProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
  const mode = process.env.AGENTFLOW_ROUTING_MODE === "fixed" ? "fixed" : "adaptive";
  const providerId = mode === "fixed"
    ? defaultProvider
    : process.env[`AGENTFLOW_PROVIDER_${modelTier.toUpperCase()}`] || defaultProvider;

  return {
    providerId,
    modelTier,
    mode,
    estimatedCostTier: estimateCostTier(providerId, modelTier),
    reason: mode === "fixed"
      ? `Fixed routing uses DEFAULT_MODEL_PROVIDER=${defaultProvider}.`
      : `Adaptive routing selected ${providerId} for ${modelTier} stage ${input.workflowId}/${input.stageId} (${input.agentId}).`
  };
}

function estimateCostTier(providerId: string, modelTier: ModelTier): ModelRouteDecision["estimatedCostTier"] {
  if (providerId === "mock") {
    return "none";
  }
  if (modelTier === "fast") {
    return "low";
  }
  if (modelTier === "reasoning") {
    return "high";
  }
  return "medium";
}
