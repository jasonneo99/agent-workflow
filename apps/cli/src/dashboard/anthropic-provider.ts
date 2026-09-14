import { configuredAnthropicModelForTier, loadAnthropicModelCatalog } from "../../../../packages/model-providers/src/anthropic.js";
import { selectModelFromCatalog, type CatalogProviderKind } from "../../../../packages/model-providers/src/catalog.js";
import type { ModelTier } from "../../../../packages/model-providers/src/types.js";

export type ProviderTierModel = { tier: ModelTier; model: string; source: "env" | "catalog" | "unavailable" };
type RoutingConfig = { provider: string; autoProviders: string; fastProvider: string; standardProvider: string; reasoningProvider: string; fallbackProvider: string; qualityThreshold: string; modelPolicy: string };

export async function describeAnthropicProvider(adapter: string, routingConfig: RoutingConfig) {
  const currentModel = process.env.ANTHROPIC_MODEL || "auto";
  const discovered = await discoverModels();
  return {
    selected: "anthropic",
    adapter,
    model: currentModel,
    modelEnv: "ANTHROPIC_MODEL",
    baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1",
    apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
    canSelectModel: Boolean(process.env.ANTHROPIC_API_KEY),
    availableModels: unique(["auto", currentModel, ...discovered.models]),
    availableModelsError: discovered.error,
    tierModels: loadGenericTierModelPreview({ catalog: discovered.models, provider: "anthropic", baseModel: currentModel, tierEnvPrefix: "ANTHROPIC_MODEL" }),
    catalogHint: discovered.models.length
      ? "Claude model choices are refreshed from Anthropic's live model catalog. Use auto to adopt available Claude releases by tier."
      : "Claude model choices will refresh after ANTHROPIC_API_KEY can list models.",
    routingConfig
  };
}

export function describeAnthropicProviderFast(adapter: string, routingConfig: RoutingConfig) {
  const model = process.env.ANTHROPIC_MODEL || "auto";
  return { selected: "anthropic", adapter, model, modelEnv: "ANTHROPIC_MODEL", baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1", apiKeyConfigured: Boolean(process.env.ANTHROPIC_API_KEY), canSelectModel: Boolean(process.env.ANTHROPIC_API_KEY), availableModels: unique(["auto", model]), availableModelsError: "Live model listing was skipped for fast page load.", catalogHint: "Use the Providers page or provider-check to refresh Claude tier choices from Anthropic's live model catalog.", routingConfig };
}

export function anthropicCatalogConfig() {
  return {
    providerId: "anthropic" as const,
    label: "Anthropic Claude",
    configured: Boolean(process.env.ANTHROPIC_API_KEY),
    catalogProvider: "anthropic" as const,
    catalogSource: "Anthropic /v1/models",
    modelEnv: "ANTHROPIC_MODEL",
    configuredModel: process.env.ANTHROPIC_MODEL || "auto",
    baseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1",
    apiKeyStatus: process.env.ANTHROPIC_API_KEY ? "configured" : "missing",
    loadModels: () => loadAnthropicModelCatalog(),
    configuredForTier: (tier: ModelTier) => configuredAnthropicModelForTier(tier)
  };
}

export async function inspectAnthropicStatus() {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { providerId: "anthropic", label: "Anthropic Claude", configured: false, status: "not configured" as const, model: process.env.ANTHROPIC_MODEL || "auto", apiKeyStatus: "missing", details: ["ANTHROPIC_API_KEY is not configured."] };
  }
  const discovered = await discoverModels();
  const tierModels = loadGenericTierModelPreview({ catalog: discovered.models, provider: "anthropic", baseModel: process.env.ANTHROPIC_MODEL || "auto", tierEnvPrefix: "ANTHROPIC_MODEL" });
  return {
    providerId: "anthropic",
    label: "Anthropic Claude",
    configured: true,
    status: discovered.error ? "missing" as const : "ready" as const,
    model: process.env.ANTHROPIC_MODEL || "auto",
    apiKeyStatus: "configured",
    tierModels,
    details: discovered.error ? [`Anthropic model list check failed: ${discovered.error}`] : [`API key configured. ${discovered.models.length} Claude models listed. ${formatTierModelPreview(tierModels)}`]
  };
}

export function loadGenericTierModelPreview(input: { catalog: string[]; provider: CatalogProviderKind; baseModel: string; tierEnvPrefix: string }): ProviderTierModel[] {
  return (["fast", "standard", "reasoning"] as const).map((tier) => {
    const configured = process.env[`${input.tierEnvPrefix}_${tier.toUpperCase()}`] || input.baseModel;
    if (configured !== "auto") return { tier, model: configured, source: "env" as const };
    const model = selectModelFromCatalog(input.catalog, tier, { provider: input.provider });
    return model ? { tier, model, source: "catalog" as const } : { tier, model: "unavailable", source: "unavailable" as const };
  });
}

export function formatTierModelPreview(tierModels: Array<{ tier: string; model: string; source: "env" | "catalog" | "unavailable" }>): string {
  return `Tier models: ${tierModels.map((item) => `${item.tier}=${item.model}${item.source === "catalog" ? " auto" : ""}`).join(", ")}.`;
}

async function discoverModels(): Promise<{ models: string[]; error?: string }> {
  try { return { models: await loadAnthropicModelCatalog() }; }
  catch (error) { return { models: [], error: error instanceof Error ? error.message : String(error) }; }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
