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

export async function selectModelRoute(input: Pick<StageExecutionInput, "modelTier" | "providerOverride" | "agentId" | "stageId" | "workflowId" | "compiledBrief">): Promise<ModelRouteDecision> {
  const requestedModelTier = input.modelTier ?? "standard";
  const preference = inferPreferenceTuning(input.compiledBrief);
  const defaultProvider = input.providerOverride ?? process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
  const mode = defaultProvider === "auto" ? "auto" : process.env.AGENTFLOW_ROUTING_MODE === "fixed" ? "fixed" : "adaptive";
  const allowAdaptiveTierPromotion = input.workflowId !== "provider-smoke";
  const modelTier = mode === "adaptive" && allowAdaptiveTierPromotion && preference.promoteFastStages && requestedModelTier === "fast" ? "standard" : requestedModelTier;
  const explicitTierProvider = process.env[`AGENTFLOW_PROVIDER_${modelTier.toUpperCase()}`];
  const tierProvider = explicitTierProvider === "auto" ? undefined : explicitTierProvider;
  const approvedLocalRoute = mode !== "fixed" && modelTier === "fast" && preference.localHoldoutPromotion.approved
    ? await selectApprovedLocalRoute(preference.localHoldoutPromotion)
    : undefined;
  const autoRoute = mode === "auto" ? await selectAutoProvider(modelTier, explicitTierProvider) : undefined;
  const providerId = mode === "fixed"
    ? defaultProvider
    : approvedLocalRoute?.providerId ?? autoRoute?.providerId ?? tierProvider ?? defaultProvider;

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
          approvedLocalRoute?.reason ?? "",
          autoRoute?.reason ?? "",
          modelTier !== requestedModelTier ? `Promoted from ${requestedModelTier} because prior project feedback includes revision or rejection signal.` : "",
          preference.feedbackSignals.length ? `Feedback signals: ${preference.feedbackSignals.join("; ")}` : ""
        ].filter(Boolean).join(" ")
      : [
        `Adaptive routing selected ${providerId} for ${modelTier} stage ${input.workflowId}/${input.stageId} (${input.agentId}).`,
        approvedLocalRoute?.reason ?? "",
        modelTier !== requestedModelTier ? `Promoted from ${requestedModelTier} because prior project feedback includes revision or rejection signal.` : "",
        preference.feedbackSignals.length ? `Feedback signals: ${preference.feedbackSignals.join("; ")}` : ""
      ].filter(Boolean).join(" ")
  };
}

async function selectApprovedLocalRoute(promotion: LocalHoldoutPreference): Promise<{ providerId?: string; reason: string }> {
  const gate = evaluateLocalHoldoutPreference(promotion);
  if (!gate.passed) {
    return {
      reason: `Reviewed local-holdout routing preference was present, but holdout thresholds were not satisfied (${gate.reasons.join("; ")}); using the normal hosted/default route.`
    };
  }
  const readiness = await getProviderReadiness("local");
  if (readiness.ready) {
    return {
      providerId: "local",
      reason: `Reviewed local-holdout routing preference selected local for a fast low-risk stage after holdout thresholds passed (${gate.reasons.join("; ")}); hosted fallback remains required for high-risk, policy, secret, command, and production work.`
    };
  }
  return {
    reason: `Reviewed local-holdout routing preference was present, but local was not ready (${readiness.details.join("; ")}); using the normal hosted/default route.`
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
    return ["local", "byo", "bedrock", "openai-compatible", "openai", "kiro", "mock"];
  }
  if (modelTier === "reasoning") {
    return ["openai", "bedrock", "byo", "local", "openai-compatible", "kiro", "mock"];
  }
  return ["local", "byo", "bedrock", "openai", "openai-compatible", "kiro", "mock"];
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

type LocalHoldoutPreference = {
  approved: boolean;
  provider: "local" | null;
  maxRisk: "low" | null;
  evidenceSuites: number | null;
  minEvidenceSuites: number | null;
  minQualityDelta: number | null;
  maxLatencyRegressionMs: number | null;
  promotableSuites: number | null;
  worstQualityDelta: number | null;
  worstLatencyDeltaMs: number | null;
};

function inferPreferenceTuning(compiledBrief: string): { promoteFastStages: boolean; localHoldoutPromotion: LocalHoldoutPreference; feedbackSignals: string[] } {
  const section = compiledBrief.split("## Adaptive Preference Notes")[1]?.split("\n## ")[0] ?? "";
  const feedbackSignals = section
    .split("\n")
    .map((line) => line.replace(/^- /u, "").trim())
    .filter((line) => /revised|rejected/i.test(line))
    .slice(0, 3);
  const localHoldoutPromotion: LocalHoldoutPreference = {
    approved:
      /Local Holdout Promotion/i.test(section) &&
      /Status:\s*ready/i.test(section) &&
      /Approved:\s*yes/i.test(section),
    provider: /Provider:\s*local/i.test(section) ? "local" : null,
    maxRisk: /Max risk:\s*low/i.test(section) ? "low" : null,
    evidenceSuites: parseCsvCount(section, "Evidence suites"),
    minEvidenceSuites: parseNumberPreference(section, "Min evidence suites"),
    minQualityDelta: parseNumberPreference(section, "Min quality delta"),
    maxLatencyRegressionMs: parseNumberPreference(section, "Max latency regression ms"),
    promotableSuites: parseNumberPreference(section, "Promotable suites"),
    worstQualityDelta: parseNumberPreference(section, "Worst quality delta"),
    worstLatencyDeltaMs: parseNumberPreference(section, "Worst latency delta ms")
  };
  return {
    promoteFastStages: feedbackSignals.length > 0,
    localHoldoutPromotion,
    feedbackSignals
  };
}

function evaluateLocalHoldoutPreference(preference: LocalHoldoutPreference): { passed: boolean; reasons: string[] } {
  const blockers: string[] = [];
  const reasons: string[] = [];
  if (!preference.approved) blockers.push("promotion is not approved");
  if (preference.provider !== "local") blockers.push("provider is not local");
  if (preference.maxRisk !== "low") blockers.push("max risk is not low");
  if (preference.minEvidenceSuites !== null && (preference.promotableSuites ?? preference.evidenceSuites ?? 0) < preference.minEvidenceSuites) {
    blockers.push(`promotable suites ${(preference.promotableSuites ?? preference.evidenceSuites ?? 0)} < ${preference.minEvidenceSuites}`);
  }
  if (preference.minQualityDelta !== null && (preference.worstQualityDelta ?? -1) < preference.minQualityDelta) {
    blockers.push(`worst quality delta ${(preference.worstQualityDelta ?? "n/a")} < ${preference.minQualityDelta}`);
  }
  if (preference.maxLatencyRegressionMs !== null && (preference.worstLatencyDeltaMs ?? 0) > preference.maxLatencyRegressionMs) {
    blockers.push(`worst latency delta ${(preference.worstLatencyDeltaMs ?? "n/a")}ms > ${preference.maxLatencyRegressionMs}ms`);
  }
  if (blockers.length) return { passed: false, reasons: blockers };
  if (preference.minEvidenceSuites === null && preference.minQualityDelta === null && preference.maxLatencyRegressionMs === null) {
    reasons.push("legacy promotion note without explicit thresholds");
  } else if (!reasons.length) {
    reasons.push(`holdout suites ${(preference.promotableSuites ?? preference.evidenceSuites ?? 0)}, quality delta ${preference.worstQualityDelta ?? "n/a"}, latency delta ${preference.worstLatencyDeltaMs ?? "n/a"}ms`);
  }
  return { passed: true, reasons };
}

function parseNumberPreference(section: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*(-?\\d+(?:\\.\\d+)?)`, "iu").exec(section);
  return match ? Number(match[1]) : null;
}

function parseCsvCount(section: string, label: string): number | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}:\\s*([^\\n]+)`, "iu").exec(section);
  if (!match) return null;
  const value = match[1].trim();
  if (!value || value.toLowerCase() === "none") return 0;
  return value.split(",").map((item) => item.trim()).filter(Boolean).length;
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
