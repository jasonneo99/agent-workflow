import { awsCredentialStatusLabel, hasAwsConfiguration, loadBedrockModelIds, loadOpenAIModelIds } from "../../data/provider-status.js";
import { formatNumber } from "../../ui/format.js";
import { escapeHtml, dashboardNav, renderDashboardFlash, renderDashboardActionHistory, renderDashboardDateTime, dashboardReturnInput } from "../../ui/layout.js";
import type { DashboardInfo } from "../../../lib/cli-types.js";
import { discoverModelIds, loadOpenAICompatibleModelIds } from "../../../lib/builders-learning.js";
import { safeDisplayUrl } from "../../../lib/builders-shared.js";
import { type CatalogProviderKind, explainModelCatalogSelection, normalizeModelSelectionPolicy } from "../../../../../../packages/model-providers/src/catalog.js";
import { configuredOpenAIModelForTier } from "../../../../../../packages/model-providers/src/openai.js";
import { type ModelTier } from "../../../../../../packages/model-providers/src/types.js";
import { anthropicCatalogConfig, formatTierModelPreview } from "../../anthropic-provider.js";
import { dashboardCss } from "../../styles.js";
import type { DashboardModelCatalogProvider, DashboardModelCatalogReport, DashboardModelTierExplanation } from "../../../commands/daemon-types.js";

export function estimateCatalogCostClass(model: string): "low" | "medium" | "high" | "unknown" {
  const normalized = model.toLowerCase();
  if (!model || model === "unavailable") return "unknown";
  if (/luna|mini|nano|lite|small|haiku|flash|speed|instant|8b|7b/u.test(normalized)) return "low";
  if (/astra|opus|reason|thinking|r1|o\d|405b|large|70b/u.test(normalized)) return "high";
  if (/terra|sonnet|pro|medium|coder|code|32b|14b/u.test(normalized)) return "medium";
  return "unknown";
}

export function explainDashboardTierSelection(input: {
  tier: ModelTier;
  status: DashboardModelCatalogProvider["status"];
  catalogProvider: CatalogProviderKind;
  catalog: string[];
  configuredModel: string;
  modelEnv: string;
}): DashboardModelTierExplanation {
  const policy = normalizeModelSelectionPolicy(process.env.AGENTFLOW_MODEL_POLICY);
  const explanation = explainModelCatalogSelection(input.catalog, input.tier, {
    provider: input.catalogProvider,
    policy
  });
  const envOverride = input.configuredModel !== "auto";
  const selectedModel = envOverride ? input.configuredModel : explanation.selectedModel ?? "unavailable";
  const selectedCandidate = explanation.candidates.find((candidate) => candidate.id === selectedModel);
  return {
    tier: input.tier,
    selectedModel,
    source: envOverride ? "env" : explanation.selectedModel ? "catalog" : "unavailable",
    configuredModel: input.configuredModel,
    estimatedCostClass: estimateCatalogCostClass(selectedModel),
    policyScore: selectedCandidate?.totalRank ?? null,
    tierFit: selectedCandidate?.tierRank ?? null,
    providerAvailability: input.status,
    overrideSource: envOverride ? `${input.modelEnv}_${input.tier.toUpperCase()} or ${input.modelEnv}` : "auto catalog selection",
    candidates: explanation.candidates.slice(0, 12).map((candidate) => ({
      ...candidate,
      selected: candidate.id === selectedModel
    })),
    excludedCount: explanation.candidates.filter((candidate) => !candidate.eligible).length
  };
}

export function fallbackDashboardModelCatalogReport(): DashboardModelCatalogReport {
  return {
    kind: "agentflow_model_catalog_report",
    generatedAt: new Date().toISOString(),
    selectedProvider: process.env.DEFAULT_MODEL_PROVIDER ?? "mock",
    modelPolicy: normalizeModelSelectionPolicy(process.env.AGENTFLOW_MODEL_POLICY),
    providers: []
  };
}

export async function loadDashboardModelCatalogReport(): Promise<DashboardModelCatalogReport> {
  const policy = normalizeModelSelectionPolicy(process.env.AGENTFLOW_MODEL_POLICY);
  const providers = await Promise.all([
    loadProviderCatalogExplanation({
      providerId: "openai",
      label: "OpenAI",
      configured: Boolean(process.env.OPENAI_API_KEY),
      catalogProvider: "openai",
      catalogSource: "OpenAI /v1/models",
      modelEnv: "OPENAI_MODEL",
      configuredModel: process.env.OPENAI_MODEL || "auto",
      apiKeyStatus: process.env.OPENAI_API_KEY ? "configured" : "missing",
      loadModels: () => loadOpenAIModelIds(),
      configuredForTier: (tier) => configuredOpenAIModelForTier(tier)
    }),
    loadProviderCatalogExplanation(anthropicCatalogConfig()),
    loadProviderCatalogExplanation({
      providerId: "deepseek",
      label: "DeepSeek",
      configured: Boolean(process.env.DEEPSEEK_API_KEY),
      catalogProvider: "compatible",
      catalogSource: "DeepSeek hosted /models",
      modelEnv: "DEEPSEEK_MODEL",
      configuredModel: process.env.DEEPSEEK_MODEL || "deepseek-flash",
      baseUrl: safeDisplayUrl(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1"),
      apiKeyStatus: process.env.DEEPSEEK_API_KEY ? "configured" : "missing",
      loadModels: () => loadOpenAICompatibleModelIds(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1", process.env.DEEPSEEK_API_KEY),
      configuredForTier: (tier) => process.env[`DEEPSEEK_MODEL_${tier.toUpperCase()}`] || process.env.DEEPSEEK_MODEL || "deepseek-flash"
    }),
    loadProviderCatalogExplanation({
      providerId: "gemini",
      label: "Google Gemini",
      configured: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      catalogProvider: "compatible",
      catalogSource: "Google Gemini OpenAI-compatible /models",
      modelEnv: "GEMINI_MODEL",
      configuredModel: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      baseUrl: safeDisplayUrl(process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/"),
      apiKeyStatus: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "configured" : "missing",
      loadModels: () => loadOpenAICompatibleModelIds(process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/", process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      configuredForTier: (tier) => process.env[`GEMINI_MODEL_${tier.toUpperCase()}`] || process.env.GEMINI_MODEL || "gemini-3.8-flash"
    }),
    loadProviderCatalogExplanation({
      providerId: "groq",
      label: "Groq",
      configured: Boolean(process.env.GROQ_API_KEY),
      catalogProvider: "compatible",
      catalogSource: "Groq OpenAI-compatible /models",
      modelEnv: "GROQ_MODEL",
      configuredModel: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      baseUrl: safeDisplayUrl(process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1"),
      apiKeyStatus: process.env.GROQ_API_KEY ? "configured" : "missing",
      loadModels: () => loadOpenAICompatibleModelIds(process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1", process.env.GROQ_API_KEY),
      configuredForTier: (tier) => process.env[`GROQ_MODEL_${tier.toUpperCase()}`] || process.env.GROQ_MODEL || "openai/gpt-oss-120b"
    }),
    loadProviderCatalogExplanation({
      providerId: "openrouter",
      label: "OpenRouter",
      configured: Boolean(process.env.OPENROUTER_API_KEY),
      catalogProvider: "compatible",
      catalogSource: "OpenRouter OpenAI-compatible /models",
      modelEnv: "OPENROUTER_MODEL",
      configuredModel: process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free",
      baseUrl: safeDisplayUrl(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1"),
      apiKeyStatus: process.env.OPENROUTER_API_KEY ? "configured" : "missing",
      loadModels: () => loadOpenAICompatibleModelIds(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1", process.env.OPENROUTER_API_KEY),
      configuredForTier: (tier) => process.env[`OPENROUTER_MODEL_${tier.toUpperCase()}`] || process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free"
    }),
    loadProviderCatalogExplanation({
      providerId: "nvidia",
      label: "NVIDIA NIM",
      configured: Boolean(process.env.NVIDIA_NIM_API_KEY),
      catalogProvider: "compatible",
      catalogSource: "NVIDIA NIM OpenAI-compatible /models",
      modelEnv: "NVIDIA_NIM_MODEL",
      configuredModel: process.env.NVIDIA_NIM_MODEL || "z-ai/glm-5.3-flash",
      baseUrl: safeDisplayUrl(process.env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com/v1"),
      apiKeyStatus: process.env.NVIDIA_NIM_API_KEY ? "configured" : "missing",
      loadModels: () => loadOpenAICompatibleModelIds(process.env.NVIDIA_NIM_BASE_URL || "https://integrate.api.nvidia.com/v1", process.env.NVIDIA_NIM_API_KEY),
      configuredForTier: (tier) => process.env[`NVIDIA_NIM_MODEL_${tier.toUpperCase()}`] || process.env.NVIDIA_NIM_MODEL || "z-ai/glm-5.3-flash"
    }),
    loadProviderCatalogExplanation({
      providerId: "byo",
      label: "BYO / OpenAI-compatible gateway",
      configured: Boolean(process.env.BYO_MODEL_BASE_URL),
      catalogProvider: "compatible",
      catalogSource: `${safeDisplayUrl(process.env.BYO_MODEL_BASE_URL) || "BYO endpoint"}/models`,
      modelEnv: "BYO_MODEL_NAME",
      configuredModel: process.env.BYO_MODEL_NAME || "auto",
      baseUrl: safeDisplayUrl(process.env.BYO_MODEL_BASE_URL),
      apiKeyStatus: process.env.BYO_MODEL_API_KEY ? "configured" : "not required or missing",
      loadModels: () => loadOpenAICompatibleModelIds(process.env.BYO_MODEL_BASE_URL, process.env.BYO_MODEL_API_KEY),
      configuredForTier: (tier) => process.env[`BYO_MODEL_${tier.toUpperCase()}`] || process.env.BYO_MODEL_NAME || "auto"
    }),
    loadProviderCatalogExplanation({
      providerId: "openai-compatible",
      label: "OpenAI-compatible legacy",
      configured: Boolean(process.env.OPENAI_COMPATIBLE_BASE_URL),
      catalogProvider: "compatible",
      catalogSource: `${safeDisplayUrl(process.env.OPENAI_COMPATIBLE_BASE_URL) || "OpenAI-compatible endpoint"}/models`,
      modelEnv: "OPENAI_COMPATIBLE_MODEL",
      configuredModel: process.env.OPENAI_COMPATIBLE_MODEL || "auto",
      baseUrl: safeDisplayUrl(process.env.OPENAI_COMPATIBLE_BASE_URL),
      apiKeyStatus: process.env.OPENAI_COMPATIBLE_API_KEY ? "configured" : "not required or missing",
      loadModels: () => loadOpenAICompatibleModelIds(process.env.OPENAI_COMPATIBLE_BASE_URL, process.env.OPENAI_COMPATIBLE_API_KEY),
      configuredForTier: (tier) => process.env[`OPENAI_COMPATIBLE_MODEL_${tier.toUpperCase()}`] || process.env.OPENAI_COMPATIBLE_MODEL || "auto"
    }),
    loadProviderCatalogExplanation({
      providerId: "bedrock",
      label: "AWS Bedrock",
      configured: hasAwsConfiguration(),
      catalogProvider: "bedrock",
      catalogSource: `AWS ListFoundationModels (${process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1"})`,
      modelEnv: "BEDROCK_MODEL",
      configuredModel: process.env.BEDROCK_MODEL ?? process.env.BEDROCK_MODEL_ID ?? "auto",
      apiKeyStatus: awsCredentialStatusLabel(),
      awsProfile: process.env.AWS_PROFILE || "default",
      awsRegion: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1",
      loadModels: () => loadBedrockModelIds(),
      configuredForTier: (tier) => process.env[`BEDROCK_MODEL_${tier.toUpperCase()}`] || process.env.BEDROCK_MODEL || process.env.BEDROCK_MODEL_ID || "auto"
    })
  ]);
  return {
    kind: "agentflow_model_catalog_report",
    generatedAt: new Date().toISOString(),
    selectedProvider: process.env.DEFAULT_MODEL_PROVIDER ?? "mock",
    modelPolicy: policy,
    providers
  };
}

export async function loadProviderCatalogExplanation(input: {
  providerId: DashboardModelCatalogProvider["providerId"];
  label: string;
  configured: boolean;
  catalogProvider: CatalogProviderKind;
  catalogSource: string;
  modelEnv: string;
  configuredModel: string;
  baseUrl?: string;
  apiKeyStatus?: string;
  awsProfile?: string;
  awsRegion?: string;
  loadModels: () => Promise<string[]>;
  configuredForTier: (tier: ModelTier) => string;
}): Promise<DashboardModelCatalogProvider> {
  const discovered = input.configured ? await discoverModelIds(input.loadModels) : { models: [] as string[] };
  const status = !input.configured ? "not configured" : discovered.error ? "missing" : "ready";
  return {
    providerId: input.providerId,
    label: input.label,
    configured: input.configured,
    status,
    catalogSource: input.catalogSource,
    modelsListed: discovered.models.length,
    configuredModel: input.configuredModel,
    modelEnv: input.modelEnv,
    baseUrl: input.baseUrl,
    apiKeyStatus: input.apiKeyStatus,
    awsProfile: input.awsProfile,
    awsRegion: input.awsRegion,
    error: discovered.error,
    tierSelections: (["fast", "standard", "reasoning"] as const).map((tier) =>
      explainDashboardTierSelection({
        tier,
        status,
        catalogProvider: input.catalogProvider,
        catalog: discovered.models,
        configuredModel: input.configuredForTier(tier),
        modelEnv: input.modelEnv
      })
    )
  };
}

export function renderModelCatalogHtml(report: DashboardModelCatalogReport): string {
  const providerCards = report.providers.map((provider) => {
    const tierRows = provider.tierSelections.map((tier) => `
      <tr>
        <td>${escapeHtml(tier.tier)}</td>
        <td>${escapeHtml(tier.selectedModel)}</td>
        <td>${escapeHtml(tier.source)}</td>
        <td>${escapeHtml(tier.estimatedCostClass)}</td>
        <td>${tier.policyScore ?? "n/a"}</td>
        <td>${tier.tierFit ?? "n/a"}</td>
        <td>${escapeHtml(tier.overrideSource)}</td>
      </tr>
    `).join("");
    const candidateRows = provider.tierSelections.flatMap((tier) =>
      tier.candidates.slice(0, 5).map((candidate) => `
        <tr>
          <td>${escapeHtml(tier.tier)}</td>
          <td>${candidate.selected ? "<strong>" : ""}${escapeHtml(candidate.id)}${candidate.selected ? "</strong>" : ""}${!candidate.eligible ? `<br><span class="muted">${escapeHtml(candidate.excludedReason ?? "excluded")}</span>` : ""}</td>
          <td>${candidate.eligible ? "yes" : "no"}</td>
          <td>${candidate.tierRank}</td>
          <td>${candidate.versionRank}</td>
          <td>${candidate.sizeRank}</td>
          <td>${candidate.familyRank}</td>
          <td>${candidate.totalRank}</td>
        </tr>
      `)
    ).join("");
    const excluded = provider.tierSelections.reduce((sum, tier) => sum + tier.excludedCount, 0);
    const statusClass = provider.status === "ready" ? "completed" : provider.status === "missing" ? "failed" : "queued";
    return `<section class="panel">
      <div class="section-heading">
        <div>
          <h2>${escapeHtml(provider.label)}</h2>
          <span class="muted">${escapeHtml(provider.providerId)} catalog source: ${escapeHtml(provider.catalogSource)}</span>
        </div>
        <span class="status ${statusClass}">${escapeHtml(provider.status)}</span>
      </div>
      <div class="meta-grid compact">
        <div><strong>Configured</strong>${provider.configured ? "yes" : "no"}</div>
        <div><strong>Models listed</strong>${formatNumber(provider.modelsListed)}</div>
        <div><strong>Configured model</strong>${escapeHtml(provider.configuredModel)}</div>
        <div><strong>Model env</strong>${escapeHtml(provider.modelEnv)}</div>
        <div><strong>API key / auth</strong>${escapeHtml(provider.apiKeyStatus ?? "not used")}</div>
        <div><strong>AWS</strong>${escapeHtml([provider.awsProfile ? `profile ${provider.awsProfile}` : "", provider.awsRegion ? `region ${provider.awsRegion}` : ""].filter(Boolean).join(", ") || "not used")}</div>
        <div><strong>Base URL</strong>${escapeHtml(provider.baseUrl ?? "not used")}</div>
        <div><strong>Excluded candidates</strong>${formatNumber(excluded)}</div>
      </div>
      ${provider.error ? `<p class="warn-box">${escapeHtml(provider.error)}</p>` : ""}
      <h3>Tier Selection</h3>
      <table><thead><tr><th>Tier</th><th>Selected model</th><th>Source</th><th>Cost class</th><th>Policy score</th><th>Tier fit</th><th>Override source</th></tr></thead><tbody>${tierRows}</tbody></table>
      <h3>Top Catalog Candidates</h3>
      <table><thead><tr><th>Tier</th><th>Model</th><th>Eligible</th><th>Tier</th><th>Version</th><th>Size</th><th>Family</th><th>Total</th></tr></thead><tbody>${candidateRows || "<tr><td colspan=\"8\">No catalog candidates listed.</td></tr>"}</tbody></table>
    </section>`;
  }).join("");
  const ready = report.providers.filter((provider) => provider.status === "ready").length;
  const totalListed = report.providers.reduce((sum, provider) => sum + provider.modelsListed, 0);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Model Catalog</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("model-catalog")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/providers">Providers</a>
        <h1>Model Catalog</h1>
        <p class="muted">Live explainability for auto model routing. Catalogs refresh from configured providers, then Agent Workflow scores tier fit, provider availability, policy, and override source.</p>
      </div>
      <div class="actions">
        <a class="button secondary" href="/api/model-catalog">JSON</a>
        <a class="button secondary" href="/model-catalog">Refresh</a>
      </div>
    </div>
    <section class="panel">
      <div class="meta-grid">
        <div><strong>Selected Provider</strong>${escapeHtml(report.selectedProvider)}</div>
        <div><strong>Model Policy</strong>${escapeHtml(report.modelPolicy)}</div>
        <div><strong>Ready Providers</strong>${formatNumber(ready)}</div>
        <div><strong>Models Listed</strong>${formatNumber(totalListed)}</div>
        <div><strong>Generated</strong>${renderDashboardDateTime(report.generatedAt)}</div>
      </div>
      <p class="muted">Use this page when auto routing surprises you. Env overrides win immediately; otherwise the catalog scorer chooses the best available model for fast, standard, and reasoning tiers.</p>
    </section>
    ${providerCards || "<section class=\"panel\"><p>No provider catalog data available. Refresh or open Providers for live readiness checks.</p></section>"}
  </main>
</body>
</html>`;
}

export function renderProvidersHtml(info: DashboardInfo, params: URLSearchParams = new URLSearchParams()): string {
  const providerRows = [
    ["Selected", info.provider.selected],
    ["Adapter", info.provider.adapter],
    ["Model", info.provider.model ?? "not set"],
    ["Model env", info.provider.modelEnv ?? "not used"],
    ["Base URL", info.provider.baseUrl ?? "not used"],
    ["API key", typeof info.provider.apiKeyConfigured === "boolean" ? info.provider.apiKeyConfigured ? "configured" : "not configured" : "not used"],
    ["Authentication", info.provider.authStatus ?? "provider-specific"],
    ["AWS profile", info.provider.awsProfile ?? "not used"]
  ].map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</div>`).join("");
  const modelOptions = info.provider.availableModels.map((model) => {
    const selected = model === info.provider.model ? " selected" : "";
    return `<option value="${escapeHtml(model)}"${selected}>${escapeHtml(model)}</option>`;
  }).join("");
  const modelControl = info.provider.availableModels.length
    ? `<select name="model">${modelOptions}</select>`
    : `<input name="model" value="${escapeHtml(info.provider.model ?? "")}" placeholder="Model name">`;
  const modelSelector = info.provider.canSelectModel ? `
      <form class="inline-form" method="post" action="/api/model">
        ${dashboardReturnInput("/providers", params)}
        <input type="hidden" name="provider" value="${escapeHtml(info.provider.selected)}">
        ${modelControl}
        <button type="submit">Use Model</button>
      </form>
      <p class="muted">${info.provider.availableModels.length ? `${info.provider.availableModels.length} models listed from the active provider.` : "No models were listed; enter a model name manually."} Secrets are never displayed.</p>
      ${info.provider.availableModelsError ? `<p class="warn-box">${escapeHtml(info.provider.availableModelsError)}</p>` : ""}`
    : info.provider.selected === "auto"
      ? `<p class="muted">Auto mode selects provider/model by stage tier. Use routing controls to tune it.</p>`
      : `<p class="muted">This provider has no selectable live model list.</p>`;
  const providerIds = ["auto", "local", "byo", "bedrock", "deepseek", "gemini", "groq", "openrouter", "nvidia", "codex-cli", "openai", "anthropic", "muse", "openai-compatible", "kiro", "mock"];
  const executionProviderIds = ["auto", "local", "byo", "bedrock", "deepseek", "gemini", "groq", "openrouter", "nvidia", "codex-cli", "openai", "anthropic", "muse", "openai-compatible", "kiro", "mock"];
  const fallbackProviderIds = ["", "codex-cli", "openai", "anthropic", "deepseek", "gemini", "groq", "openrouter", "nvidia", "muse", "bedrock", "local", "byo", "openai-compatible", "kiro", "mock"];
  const modelPolicyIds = ["best-coding", "balanced", "lowest-cost", "maximum-reasoning"];
  const optionList = (values: string[], selectedValue: string, blankLabel = "none") => values.map((value) => {
    const selected = value === selectedValue ? " selected" : "";
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value || blankLabel)}</option>`;
  }).join("");
  const autoRouteRows = info.provider.autoRoutes?.map((route) => `
    <tr><td>${escapeHtml(route.tier)}</td><td>${escapeHtml(route.providerId)}</td><td>${escapeHtml(route.estimatedCostTier)}</td><td>${escapeHtml(route.reason)}</td></tr>
  `).join("") ?? "";
  const providerStatusRows = info.provider.providerStatuses?.map((provider) => `
    <tr>
      <td>${escapeHtml(provider.label)}<br><span class="muted">${escapeHtml(provider.providerId)}</span></td>
      <td><span class="status ${provider.status === "ready" ? "completed" : provider.status === "missing" ? "failed" : "queued"}">${escapeHtml(provider.status)}</span></td>
      <td>${provider.configured ? "yes" : "no"}</td>
      <td>${escapeHtml(provider.model ?? "not set")}${provider.tierModels?.length ? `<br><span class="muted">${escapeHtml(formatTierModelPreview(provider.tierModels))}</span>` : ""}</td>
      <td>${escapeHtml(provider.baseUrl ?? "not used")}</td>
      <td>${escapeHtml(provider.apiKeyStatus ?? "not used")}</td>
      <td>${escapeHtml([provider.awsProfile ? `profile: ${provider.awsProfile}` : "", provider.awsRegion ? `region: ${provider.awsRegion}` : ""].filter(Boolean).join(", ") || "not used")}</td>
      <td>${escapeHtml(provider.details.join(" "))}</td>
    </tr>
  `).join("") ?? "";
  const providerStatuses = info.provider.providerStatuses ?? [];
  const providerStatusChecked = providerStatuses.length > 0;
  const readyProviders = providerStatuses.filter((provider) => provider.status === "ready");
  const configuredProviders = providerStatuses.filter((provider) => provider.configured);
  const missingProviders = providerStatuses.filter((provider) => provider.status === "missing");
  const awsStatus = providerStatuses.find((provider) => provider.providerId === "bedrock");
  const selectedStatus = providerStatuses.find((provider) => provider.providerId === info.provider.selected);
  const setupCards = [
    {
      title: "OpenAI",
      detail: "Best hosted path for high-quality development runs. Use OPENAI_MODEL=auto to refresh from the live catalog.",
      command: "OPENAI_API_KEY + OPENAI_MODEL=auto"
    },
    {
      title: "Muse",
      detail: "Meta's Muse Spark models through the Meta Model API. Create a key at dev.meta.ai.",
      command: "MUSE_API_KEY + MUSE_MODEL=auto"
    },
    {
      title: "Codex CLI / ChatGPT",
      detail: "Uses your authenticated Codex entitlement and becomes the primary path after the command succeeds.",
      command: "npm run agentflow -- provider-use codex-cli --login --check"
    },
    {
      title: "Local Runtime",
      detail: "Best opt-in path for Ollama, LM Studio, or llama.cpp-compatible localhost models.",
      command: "DEFAULT_MODEL_PROVIDER=local"
    },
    {
      title: "BYO Gateway",
      detail: "Best path for vLLM, LiteLLM, internal routers, or remote OpenAI-compatible gateways.",
      command: "BYO_MODEL_BASE_URL + BYO_MODEL_NAME"
    },
    {
      title: "AWS Bedrock",
      detail: "Best enterprise cloud option when AWS credentials are already available locally.",
      command: "AWS_PROFILE + AWS_REGION + BEDROCK_MODEL"
    },
    {
      title: "Auto",
      detail: "Routes by tier across ready providers, with fallback and quality threshold controls.",
      command: "DEFAULT_MODEL_PROVIDER=auto"
    }
  ].map((card) => `<div class="provider-setup-card"><strong>${escapeHtml(card.title)}</strong><span>${escapeHtml(card.detail)}</span><code>${escapeHtml(card.command)}</code></div>`).join("");
  const tierModelRows = info.provider.tierModels?.map((item) => `
    <tr><td>${escapeHtml(item.tier)}</td><td>${escapeHtml(item.model)}</td><td>${escapeHtml(item.source)}</td></tr>
  `).join("") ?? "";
  const codexSetup = info.provider.selected === "codex-cli" ? `
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Codex CLI Authentication</h2>
          <span class="muted">${escapeHtml(info.provider.authStatus ?? "Run the readiness check to verify authentication.")}</span>
        </div>
        <span class="status ${selectedStatus?.status === "ready" ? "completed" : "failed"}">${escapeHtml(selectedStatus?.status ?? "unchecked")}</span>
      </div>
      <p>Authenticate with ChatGPT, save <code>codex-cli</code> as the primary provider, and verify it with one command:</p>
      <pre><code>npm run agentflow -- provider-use codex-cli --login --check</code></pre>
      <p class="muted">Headless node: add <code>--device-auth</code>. New processes use the saved provider immediately; restart an already-running dashboard, worker, or learning daemon after changing providers.</p>
    </section>` : "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Providers</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("providers")}
  <main id="main-content">
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Providers & Models</h1>
        <p class="muted">Choose how Agent Workflow spends tokens: hosted models, local/BYO gateways, AWS Bedrock, or automatic routing by task tier.</p>
      </div>
      <a class="button secondary" href="/api/settings">Settings JSON</a>
    </div>
    ${renderDashboardFlash(params)}
    ${renderDashboardActionHistory()}
    <section class="panel provider-hero">
      <div class="provider-current">
        <strong>${escapeHtml(info.provider.selected)}</strong>
        <span>${escapeHtml(info.provider.adapter)}${info.provider.model ? ` / ${escapeHtml(info.provider.model)}` : ""}</span>
        <small>${selectedStatus ? escapeHtml(selectedStatus.details.join(" ")) : "Selected provider is routed dynamically or not listed in the status table."}</small>
      </div>
      <div class="provider-readiness">
        <div><strong>${providerStatusChecked ? formatNumber(readyProviders.length) : "unchecked"}</strong><span>ready providers</span></div>
        <div><strong>${providerStatusChecked ? formatNumber(configuredProviders.length) : "unchecked"}</strong><span>configured</span></div>
        <div><strong>${providerStatusChecked ? formatNumber(missingProviders.length) : "unchecked"}</strong><span>need attention</span></div>
        <div><strong>${escapeHtml(awsStatus?.status ?? "unknown")}</strong><span>AWS Bedrock</span></div>
      </div>
    </section>
    ${codexSetup}
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Selected Provider</h2>
          <span class="muted">Secrets are never displayed. New tasks use saved provider values; already-running workers may need a restart.</span>
        </div>
        <div class="actions">
          <a class="button secondary" href="/model-catalog">Explain Catalog</a>
          <a class="button secondary" href="/settings">Runtime Settings</a>
        </div>
      </div>
      <div class="meta-grid">${providerRows}</div>
      ${modelSelector}
      ${info.provider.catalogHint ? `<p class="muted">${escapeHtml(info.provider.catalogHint)}</p>` : ""}
      ${tierModelRows ? `<h3>Tier Model Preview</h3><table><thead><tr><th>Tier</th><th>Model</th><th>Source</th></tr></thead><tbody>${tierModelRows}</tbody></table>` : ""}
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Setup Paths</h2>
          <span class="muted">Pick one path, then use Routing Controls to make it active or include it in auto mode.</span>
        </div>
      </div>
      <div class="provider-setup-grid">${setupCards}</div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Routing Controls</h2>
          <span class="muted">Auto mode prioritizes the providers below, then uses tier-specific choices and fallback when quality drops.</span>
        </div>
      </div>
      <form class="routing-form" method="post" action="/api/routing">
        ${dashboardReturnInput("/providers", params)}
        <label>Provider mode
          <select name="provider">${optionList(providerIds, info.provider.routingConfig.provider)}</select>
        </label>
        <label>Auto priority
          <input name="autoProviders" value="${escapeHtml(info.provider.routingConfig.autoProviders)}" placeholder="byo,bedrock,deepseek,gemini,openai">
        </label>
        <label>Fast tier
          <select name="fastProvider">${optionList(executionProviderIds, info.provider.routingConfig.fastProvider)}</select>
        </label>
        <label>Standard tier
          <select name="standardProvider">${optionList(executionProviderIds, info.provider.routingConfig.standardProvider)}</select>
        </label>
        <label>Reasoning tier
          <select name="reasoningProvider">${optionList(executionProviderIds, info.provider.routingConfig.reasoningProvider)}</select>
        </label>
        <label>Fallback provider
          <select name="fallbackProvider">${optionList(fallbackProviderIds, info.provider.routingConfig.fallbackProvider)}</select>
        </label>
        <label>Quality threshold
          <input name="qualityThreshold" value="${escapeHtml(info.provider.routingConfig.qualityThreshold)}" inputmode="decimal">
        </label>
        <label>Model policy
          <select name="modelPolicy">${optionList(modelPolicyIds, info.provider.routingConfig.modelPolicy)}</select>
        </label>
        <div class="form-actions"><button type="submit">Save Routing</button></div>
      </form>
      <p class="muted">Model policy affects catalog-backed auto model selection: best-coding favors code-specialized models, balanced favors capable mid-cost models, lowest-cost favors efficient models, and maximum-reasoning favors the strongest available models.</p>
    </section>
    ${autoRouteRows ? `<section class="panel"><h2>Auto Routing Preview</h2><table><thead><tr><th>Tier</th><th>Provider</th><th>Cost</th><th>Reason</th></tr></thead><tbody>${autoRouteRows}</tbody></table></section>` : ""}
    ${providerStatusRows ? `<section class="panel"><div class="section-heading"><div><h2>Available Provider Status</h2><span class="muted">Use this table to see which model paths have keys, local endpoints, CLI login, or AWS credentials available.</span></div></div><table><thead><tr><th>Provider</th><th>Status</th><th>Configured</th><th>Model</th><th>Base URL</th><th>API Key / Auth</th><th>AWS</th><th>Details</th></tr></thead><tbody>${providerStatusRows}</tbody></table><p class="muted">Secrets are never displayed.</p></section>` : ""}
  </main>
</body>
</html>`;
}
