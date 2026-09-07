import type { ModelTier } from "./types.js";

export type ModelSelectionPolicy = "lowest-cost" | "balanced" | "best-coding" | "maximum-reasoning";

export type CatalogModelSelection = {
  model: string;
  source: "env" | "catalog";
};

export type CatalogProviderKind = "openai" | "compatible" | "bedrock";

export type CatalogCandidate = {
  id: string;
  eligible: boolean;
  excludedReason?: string;
  tierRank: number;
  versionRank: number;
  sizeRank: number;
  familyRank: number;
  totalRank: number;
};

export type CatalogSelectionExplanation = {
  provider: CatalogProviderKind;
  tier: ModelTier;
  policy: ModelSelectionPolicy;
  selectedModel?: string;
  candidates: CatalogCandidate[];
};

export function modelSelectionPolicyFromEnv(): ModelSelectionPolicy {
  return normalizeModelSelectionPolicy(process.env.AGENTFLOW_MODEL_POLICY);
}

export function normalizeModelSelectionPolicy(value?: string): ModelSelectionPolicy {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "lowest-cost" || normalized === "balanced" || normalized === "best-coding" || normalized === "maximum-reasoning") {
    return normalized;
  }
  return "best-coding";
}

export function selectModelFromCatalog(modelIds: string[], tier: ModelTier, options: { provider?: CatalogProviderKind; policy?: ModelSelectionPolicy } = {}): string | undefined {
  return explainModelCatalogSelection(modelIds, tier, options).selectedModel;
}

export function explainModelCatalogSelection(modelIds: string[], tier: ModelTier, options: { provider?: CatalogProviderKind; policy?: ModelSelectionPolicy } = {}): CatalogSelectionExplanation {
  const provider = options.provider ?? "compatible";
  const policy = options.policy ?? modelSelectionPolicyFromEnv();
  const candidates = uniqueModelIds(modelIds)
    .map((id) => scoreModel(id, tier, policy, provider))
    .sort((a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      b.tierRank - a.tierRank ||
      b.versionRank - a.versionRank ||
      b.sizeRank - a.sizeRank ||
      b.familyRank - a.familyRank ||
      a.id.localeCompare(b.id)
    );
  return {
    provider,
    tier,
    policy,
    selectedModel: candidates.find((candidate) => candidate.eligible)?.id,
    candidates
  };
}

function uniqueModelIds(modelIds: string[]): string[] {
  return [...new Set(modelIds.map((id) => id.trim()).filter(Boolean))];
}

function excludedReason(id: string, provider: CatalogProviderKind): string | undefined {
  const normalized = id.toLowerCase();
  if (/embedding|moderation|rerank|tts|transcribe|whisper|audio|image|vision|realtime|search/u.test(normalized)) {
    return "not a text generation model";
  }
  if (provider === "bedrock") {
    return /embed|titan-embed|stable-diffusion|stability|image|rerank/u.test(normalized) ? "not a Bedrock text generation model" : undefined;
  }
  if (provider === "openai") {
    return /^gpt-/u.test(normalized) ? undefined : "not an OpenAI GPT model";
  }
  return undefined;
}

function scoreModel(id: string, tier: ModelTier, policy: ModelSelectionPolicy, provider: CatalogProviderKind): CatalogCandidate {
  const normalized = id.toLowerCase();
  const reason = excludedReason(id, provider);
  const ranks = {
    tierRank: reason ? 0 : tierRank(normalized, tier, policy),
    versionRank: reason ? 0 : versionRank(normalized),
    sizeRank: reason ? 0 : sizeRank(normalized),
    familyRank: reason ? 0 : familyRank(normalized)
  };
  return {
    id,
    eligible: !reason,
    excludedReason: reason,
    ...ranks,
    totalRank: ranks.tierRank * 1000 + ranks.versionRank * 100 + ranks.sizeRank + ranks.familyRank
  };
}

function tierRank(id: string, tier: ModelTier, policy: ModelSelectionPolicy): number {
  if (policy === "lowest-cost") {
    if (/luna|mini|nano|lite|small|haiku|flash|speed|instant|8b|7b/u.test(id)) return 9;
    if (/coder|code|terra|pro|sonnet|medium|14b|32b/u.test(id)) return tier === "reasoning" ? 3 : 6;
    if (/sol|opus|reason|r1|thinking|large|70b|405b|astra/u.test(id)) return tier === "reasoning" ? 5 : 1;
    return 4;
  }
  if (policy === "maximum-reasoning") {
    if (/astra|opus|reason|thinking|r1|o\d|405b/u.test(id)) return 9;
    if (/sol|sonnet|pro|large|70b/u.test(id)) return 7;
    if (/coder|code|terra|medium|32b|14b/u.test(id)) return 5;
    if (/luna|mini|nano|lite|small|haiku|flash|8b|7b/u.test(id)) return 2;
    return 4;
  }
  if (policy === "balanced") {
    if (tier === "fast" && /luna|mini|nano|lite|small|haiku|flash|speed|instant|8b|7b/u.test(id)) return 8;
    if (/terra|sonnet|pro|medium|coder|code|32b|14b/u.test(id)) return 7;
    if (tier === "reasoning" && /sol|opus|reason|r1|thinking|large|70b|405b|astra/u.test(id)) return 8;
    if (/sol|large|70b|opus/u.test(id)) return 5;
    return 4;
  }
  if (tier === "fast") {
    if (/luna|mini|nano|lite|small|haiku|flash|speed|instant|8b|7b/u.test(id)) return 7;
    if (/terra|pro|sonnet|medium|14b|32b/u.test(id)) return 4;
    if (/sol|opus|reason|r1|thinking|large|70b|405b|astra/u.test(id)) return 1;
    return 3;
  }
  if (tier === "reasoning") {
    if (/astra|opus|reason|thinking|r1|o\d|405b/u.test(id)) return 8;
    if (/sol|sonnet|pro|large|70b/u.test(id)) return 6;
    if (/terra|medium|32b|14b/u.test(id)) return 4;
    if (/luna|mini|nano|lite|small|haiku|flash|8b|7b/u.test(id)) return 1;
    return 3;
  }
  if (/coder|code/u.test(id)) return 8;
  if (/terra|sonnet|pro|medium|32b|14b/u.test(id)) return 7;
  if (/sol|large|70b|opus/u.test(id)) return 5;
  if (/luna|mini|nano|lite|small|haiku|flash|8b|7b/u.test(id)) return 3;
  if (/astra|reason|thinking|r1|405b/u.test(id)) return 2;
  return 4;
}

function versionRank(id: string): number {
  const gptVersion = id.match(/gpt-(\d+(?:\.\d+)?)/u)?.[1];
  if (gptVersion) {
    return Number.parseFloat(gptVersion);
  }
  const claudeVersion = id.match(/claude-(\d+)-(\d+)/u);
  if (claudeVersion) {
    return Number.parseInt(claudeVersion[1] ?? "0", 10) + Number.parseInt(claudeVersion[2] ?? "0", 10) / 10;
  }
  const firstVersion = id.match(/(\d+(?:\.\d+)?)/u)?.[1];
  return firstVersion ? Number.parseFloat(firstVersion) : 0;
}

function sizeRank(id: string): number {
  const match = id.match(/(\d+)b/u);
  if (!match) return 0;
  return Number.parseInt(match[1] ?? "0", 10);
}

function familyRank(id: string): number {
  if (/astra|opus/u.test(id)) return 8;
  if (/sol|sonnet/u.test(id)) return 7;
  if (/terra|pro/u.test(id)) return 6;
  if (/luna|haiku|flash/u.test(id)) return 5;
  if (/coder|code/u.test(id)) return 4;
  return 1;
}
