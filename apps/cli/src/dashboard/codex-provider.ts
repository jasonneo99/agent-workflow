import { configuredCodexCliModelForTier } from "../../../../packages/model-providers/src/codex-cli.js";
import type { ModelTier } from "../../../../packages/model-providers/src/types.js";

export type CodexCliTierModelPreview = {
  tier: ModelTier;
  model: string;
  source: "env" | "catalog" | "unavailable";
};

const tiers = ["fast", "standard", "reasoning"] as const;

export function codexCliTierModelPreview(): CodexCliTierModelPreview[] {
  return tiers.map((tier) => {
    const model = configuredCodexCliModelForTier(tier);
    return {
      tier,
      model: model ?? "CLI default",
      source: model ? "env" : "unavailable"
    };
  });
}

export function codexCliModelSummary(preview = codexCliTierModelPreview()): string {
  const models = [...new Set(preview.map((item) => item.model))];
  if (models.length === 1) return models[0] ?? "CLI default";
  return "tier-based";
}
