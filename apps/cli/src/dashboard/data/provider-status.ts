import type { DashboardInfo } from "../../lib/cli-types.js";
import { discoverModelIds, uniqueSorted } from "../../lib/builders-learning.js";
import { safeErrorMessage } from "../../lib/builders-shared.js";
import { providerFromEnv } from "../../../../../packages/model-providers/src/index.js";
import { configuredOpenAIModelForTier, loadOpenAIModelCatalog, resolveOpenAIModelForTier, selectOpenAIModelFromCatalog } from "../../../../../packages/model-providers/src/openai.js";
import { formatTierModelPreview, loadGenericTierModelPreview } from "../anthropic-provider.js";
import { codexCliModelSummary, codexCliTierModelPreview } from "../codex-provider.js";
import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock";

export function awsCredentialStatusLabel(): string {
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN) {
    return "env credentials configured";
  }
  if (process.env.AWS_PROFILE) {
    return `profile ${process.env.AWS_PROFILE}`;
  }
  return "default credential chain";
}

export function hasAwsConfiguration(): boolean {
  return Boolean(
    process.env.AWS_PROFILE
      || process.env.AWS_REGION
      || process.env.BEDROCK_REGION
      || process.env.BEDROCK_MODEL
      || process.env.BEDROCK_MODEL_STANDARD
      || process.env.AWS_ACCESS_KEY_ID
      || process.env.AWS_SESSION_TOKEN
      || process.env.AWS_WEB_IDENTITY_TOKEN_FILE
  );
}

export async function inspectBedrockStatus(): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>[number]> {
  const model = process.env.BEDROCK_MODEL ?? process.env.BEDROCK_MODEL_ID ?? "auto";
  const awsProfile = process.env.AWS_PROFILE || "default";
  const awsRegion = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const discovered = await discoverModelIds(() => loadBedrockModelIds());
  const tierModels = loadGenericTierModelPreview({
    catalog: discovered.models,
    provider: "bedrock",
    baseModel: model,
    tierEnvPrefix: "BEDROCK_MODEL"
  });
  const configuredModels = (["fast", "standard", "reasoning"] as const)
    .map((tier) => process.env[`BEDROCK_MODEL_${tier.toUpperCase()}`] || model)
    .filter((item) => item !== "auto");
  const configuredModelsAvailable = configuredModels.every((item) => discovered.models.includes(item));
  return {
    providerId: "bedrock",
    label: "AWS Bedrock",
    configured: hasAwsConfiguration(),
    status: discovered.error || !configuredModelsAvailable ? "missing" : "ready",
    model,
    apiKeyStatus: awsCredentialStatusLabel(),
    awsProfile,
    awsRegion,
    tierModels,
    details: discovered.error
      ? [`Bedrock model list check failed: ${discovered.error}`]
      : !configuredModelsAvailable
        ? [`Configured Bedrock model not listed: ${configuredModels.filter((item) => !discovered.models.includes(item)).join(", ")}`]
        : [`AWS credential chain can list ${discovered.models.length} foundation models. ${formatTierModelPreview(tierModels)}`]
  };
}

export async function inspectCodexCliStatus(): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>[number]> {
  const selected = (process.env.DEFAULT_MODEL_PROVIDER ?? "").trim() === "codex-cli";
  const configured = selected || Boolean(process.env.CODEX_CLI_BIN || process.env.CODEX_CLI_AUTH_MODE);
  const tierModels = codexCliTierModelPreview();
  try {
    const provider = providerFromEnv("codex-cli");
    const readiness = provider.check ? await provider.check() : { ready: true, details: ["Codex CLI is ready."] };
    return {
      providerId: "codex-cli",
      label: "Codex CLI / ChatGPT",
      configured,
      status: readiness.ready ? "ready" : "missing",
      model: codexCliModelSummary(tierModels),
      apiKeyStatus: readiness.ready ? "ChatGPT authenticated" : "login required",
      details: readiness.details,
      tierModels
    };
  } catch (error) {
    return {
      providerId: "codex-cli",
      label: "Codex CLI / ChatGPT",
      configured,
      status: "missing",
      model: codexCliModelSummary(tierModels),
      apiKeyStatus: "login required",
      details: [safeErrorMessage(error)],
      tierModels
    };
  }
}

export async function inspectOpenAIStatus(): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>[number]> {
  const configured = Boolean(process.env.OPENAI_API_KEY);
  if (!configured) {
    return {
      providerId: "openai",
      label: "OpenAI",
      configured,
      status: "not configured",
      model: process.env.OPENAI_MODEL || "auto",
      apiKeyStatus: "missing",
      details: ["OPENAI_API_KEY is not configured."]
    };
  }

  const discovered = await discoverModelIds(() => loadOpenAIModelIds());
  const tierModels = await loadOpenAITierModelPreview(discovered.models);
  const configuredModels = (["fast", "standard", "reasoning"] as const)
    .map((tier) => configuredOpenAIModelForTier(tier))
    .filter((model) => model !== "auto");
  const configuredModelsAvailable = configuredModels.every((model) => discovered.models.includes(model));
  return {
    providerId: "openai",
    label: "OpenAI",
    configured,
    status: discovered.error || !configuredModelsAvailable ? "missing" : "ready",
    model: process.env.OPENAI_MODEL || "auto",
    apiKeyStatus: "configured",
    tierModels,
    details: discovered.error
      ? [`Model list check failed: ${discovered.error}`]
      : !configuredModelsAvailable
        ? [`Configured OpenAI model not listed: ${configuredModels.filter((model) => !discovered.models.includes(model)).join(", ")}`]
        : [`API key configured. ${discovered.models.length} models listed. ${formatTierModelPreview(tierModels)}`]
  };
}

export async function inspectProviderStatus(input: {
  providerId: "bedrock" | "kiro";
  label: string;
  configured: boolean;
  model?: string;
  apiKeyStatus?: string;
  awsProfile?: string;
  awsRegion?: string;
  alwaysCheck?: boolean;
}): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>[number]> {
  if (!input.configured && !input.alwaysCheck) {
    return {
      providerId: input.providerId,
      label: input.label,
      configured: false,
      status: "not configured",
      model: input.model,
      apiKeyStatus: input.apiKeyStatus,
      awsProfile: input.awsProfile,
      awsRegion: input.awsRegion,
      details: ["Provider-specific configuration was not found."]
    };
  }

  try {
    const provider = providerFromEnv(input.providerId);
    const result = provider.check ? await provider.check() : { ready: true, details: [`${input.providerId} configured.`] };
    return {
      providerId: input.providerId,
      label: input.label,
      configured: input.configured,
      status: result.ready ? "ready" : "missing",
      model: input.model,
      apiKeyStatus: input.apiKeyStatus,
      awsProfile: input.awsProfile,
      awsRegion: input.awsRegion,
      details: result.details.map(safeErrorMessage)
    };
  } catch (error) {
    return {
      providerId: input.providerId,
      label: input.label,
      configured: input.configured,
      status: "missing",
      model: input.model,
      apiKeyStatus: input.apiKeyStatus,
      awsProfile: input.awsProfile,
      awsRegion: input.awsRegion,
      details: [safeErrorMessage(error)]
    };
  }
}

export async function loadBedrockModelIds(): Promise<string[]> {
  const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const client = new BedrockClient({ region });
  const response = await client.send(new ListFoundationModelsCommand({}));
  return uniqueSorted(response.modelSummaries?.map((model) => model.modelId).filter((modelId): modelId is string => Boolean(modelId)) ?? []);
}

export async function loadOpenAIModelIds(): Promise<string[]> {
  return loadOpenAIModelCatalog();
}

export async function loadOpenAITierModelPreview(catalog: string[]): Promise<NonNullable<DashboardInfo["provider"]["tierModels"]>> {
  return Promise.all((["fast", "standard", "reasoning"] as const).map(async (tier) => {
    const configured = configuredOpenAIModelForTier(tier);
    if (configured !== "auto") {
      return { tier, model: configured, source: "env" as const };
    }
    const model = selectOpenAIModelFromCatalog(catalog, tier);
    if (model) {
      return { tier, model, source: "catalog" as const };
    }
    try {
      const resolved = await resolveOpenAIModelForTier(tier);
      return { tier, model: resolved.model, source: resolved.source };
    } catch {
      return { tier, model: "unavailable", source: "unavailable" as const };
    }
  }));
}
