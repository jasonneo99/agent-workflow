import type { ModelTier, StageExecutionInput } from "./types.js";

export interface ModelRouteDecision {
  providerId: string;
  modelTier: ModelTier;
  requestedModelTier: ModelTier;
  mode: "fixed" | "adaptive";
  reason: string;
  estimatedCostTier: "none" | "low" | "medium" | "high";
}

export function selectModelRoute(input: Pick<StageExecutionInput, "modelTier" | "agentId" | "stageId" | "workflowId" | "compiledBrief">): ModelRouteDecision {
  const requestedModelTier = input.modelTier ?? "standard";
  const preference = inferPreferenceTuning(input.compiledBrief);
  const defaultProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
  const mode = process.env.AGENTFLOW_ROUTING_MODE === "fixed" ? "fixed" : "adaptive";
  const modelTier = mode === "adaptive" && preference.promoteFastStages && requestedModelTier === "fast" ? "standard" : requestedModelTier;
  const providerId = mode === "fixed"
    ? defaultProvider
    : process.env[`AGENTFLOW_PROVIDER_${modelTier.toUpperCase()}`] || defaultProvider;

  return {
    providerId,
    modelTier,
    requestedModelTier,
    mode,
    estimatedCostTier: estimateCostTier(providerId, modelTier),
    reason: mode === "fixed"
      ? `Fixed routing uses DEFAULT_MODEL_PROVIDER=${defaultProvider}.`
      : [
        `Adaptive routing selected ${providerId} for ${modelTier} stage ${input.workflowId}/${input.stageId} (${input.agentId}).`,
        modelTier !== requestedModelTier ? `Promoted from ${requestedModelTier} because prior project feedback includes revision or rejection signal.` : "",
        preference.feedbackSignals.length ? `Feedback signals: ${preference.feedbackSignals.join("; ")}` : ""
      ].filter(Boolean).join(" ")
  };
}

function inferPreferenceTuning(compiledBrief: string): { promoteFastStages: boolean; feedbackSignals: string[] } {
  const section = compiledBrief.split("## Adaptive Preference Notes")[1]?.split("\n## ")[0] ?? "";
  const feedbackSignals = section
    .split("\n")
    .map((line) => line.replace(/^- /u, "").trim())
    .filter((line) => /revised|rejected/i.test(line))
    .slice(0, 3);
  return {
    promoteFastStages: feedbackSignals.length > 0,
    feedbackSignals
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
