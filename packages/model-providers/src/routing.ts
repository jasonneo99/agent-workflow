import type { ModelTier, StageExecutionInput } from "./types.js";
import { providerFromEnv } from "./index.js";

export interface ModelRouteDecision {
  providerId: string;
  modelTier: ModelTier;
  requestedModelTier: ModelTier;
  mode: "fixed" | "adaptive" | "auto";
  reason: string;
  estimatedCostTier: "none" | "low" | "medium" | "high";
}

type ProviderReadiness = {
  ready: boolean;
  details: string[];
};

const readinessCache = new Map<string, Promise<ProviderReadiness>>();

export async function selectModelRoute(input: Pick<StageExecutionInput, "modelTier" | "agentId" | "stageId" | "workflowId" | "compiledBrief">): Promise<ModelRouteDecision> {
  const requestedModelTier = input.modelTier ?? "standard";
  const preference = inferPreferenceTuning(input.compiledBrief);
  const defaultProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
  const mode = defaultProvider === "auto" ? "auto" : process.env.AGENTFLOW_ROUTING_MODE === "fixed" ? "fixed" : "adaptive";
  const modelTier = mode === "adaptive" && preference.promoteFastStages && requestedModelTier === "fast" ? "standard" : requestedModelTier;
  const explicitTierProvider = process.env[`AGENTFLOW_PROVIDER_${modelTier.toUpperCase()}`];
  const autoRoute = mode === "auto" ? await selectAutoProvider(modelTier, explicitTierProvider) : undefined;
  const providerId = mode === "fixed"
    ? defaultProvider
    : autoRoute?.providerId ?? explicitTierProvider ?? defaultProvider;

  return {
    providerId,
    modelTier,
    requestedModelTier,
    mode,
    estimatedCostTier: estimateCostTier(providerId, modelTier),
    reason: mode === "fixed"
      ? `Fixed routing uses DEFAULT_MODEL_PROVIDER=${defaultProvider}.`
      : mode === "auto"
        ? [
          `Auto routing selected ${providerId} for ${modelTier} stage ${input.workflowId}/${input.stageId} (${input.agentId}).`,
          autoRoute?.reason ?? "",
          modelTier !== requestedModelTier ? `Promoted from ${requestedModelTier} because prior project feedback includes revision or rejection signal.` : "",
          preference.feedbackSignals.length ? `Feedback signals: ${preference.feedbackSignals.join("; ")}` : ""
        ].filter(Boolean).join(" ")
      : [
        `Adaptive routing selected ${providerId} for ${modelTier} stage ${input.workflowId}/${input.stageId} (${input.agentId}).`,
        modelTier !== requestedModelTier ? `Promoted from ${requestedModelTier} because prior project feedback includes revision or rejection signal.` : "",
        preference.feedbackSignals.length ? `Feedback signals: ${preference.feedbackSignals.join("; ")}` : ""
      ].filter(Boolean).join(" ")
  };
}

async function selectAutoProvider(modelTier: ModelTier, explicitTierProvider?: string): Promise<{ providerId: string; reason: string }> {
  if (explicitTierProvider && explicitTierProvider !== "auto") {
    return {
      providerId: explicitTierProvider,
      reason: `Tier override AGENTFLOW_PROVIDER_${modelTier.toUpperCase()}=${explicitTierProvider} was set.`
    };
  }

  const candidates = autoProviderCandidates(modelTier);
  const checked: string[] = [];
  for (const providerId of candidates) {
    const readiness = await getProviderReadiness(providerId);
    checked.push(`${providerId}:${readiness.ready ? "ready" : "missing"}`);
    if (readiness.ready) {
      return {
        providerId,
        reason: `Checked ${checked.join(", ")}.`
      };
    }
  }

  return {
    providerId: "mock",
    reason: `No live provider was ready after checking ${checked.join(", ")}; using mock.`
  };
}

function autoProviderCandidates(modelTier: ModelTier): string[] {
  const configured = splitProviderList(process.env.AGENTFLOW_AUTO_PROVIDERS);
  if (configured.length) {
    return unique([...configured, "mock"]);
  }

  if (modelTier === "fast") {
    return ["byo", "bedrock", "openai-compatible", "openai", "kiro", "mock"];
  }
  if (modelTier === "reasoning") {
    return ["openai", "bedrock", "byo", "openai-compatible", "kiro", "mock"];
  }
  return ["byo", "bedrock", "openai", "openai-compatible", "kiro", "mock"];
}

function splitProviderList(value?: string): string[] {
  return value
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function getProviderReadiness(providerId: string): Promise<ProviderReadiness> {
  if (providerId === "auto") {
    return { ready: false, details: ["auto is a router, not an execution provider"] };
  }
  if (providerId === "mock") {
    return { ready: true, details: ["mock is always available"] };
  }

  let cached = readinessCache.get(providerId);
  if (!cached) {
    cached = checkProviderReadiness(providerId);
    readinessCache.set(providerId, cached);
  }
  return cached;
}

async function checkProviderReadiness(providerId: string): Promise<ProviderReadiness> {
  try {
    const provider = providerFromEnv(providerId);
    if (!provider.check) {
      return { ready: true, details: [`${providerId} configured`] };
    }
    return await provider.check();
  } catch (error) {
    return {
      ready: false,
      details: [error instanceof Error ? error.message : String(error)]
    };
  }
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
