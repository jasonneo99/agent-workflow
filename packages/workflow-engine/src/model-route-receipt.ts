import type { StageExecutionOutput } from "../../model-providers/src/types.js";
import type { ProviderFallbackAttempt } from "../../model-providers/src/fallback.js";

export function buildModelRouteReceiptContent(input: {
  workflowId: string; stageId: string; agentId: string; route: unknown; fallbackProviderId?: string;
  fallbackUsed: boolean; latencyMs: number; stagePattern: unknown; quality: unknown; output: StageExecutionOutput;
  actualProviderId?: string; actualModel?: string; attempts?: ProviderFallbackAttempt[];
}): Record<string, unknown> {
  return {
    target: `${input.workflowId}/${input.stageId}`,
    workflowId: input.workflowId,
    stageId: input.stageId,
    agentId: input.agentId,
    route: input.route,
    fallbackProviderId: input.fallbackProviderId,
    fallbackUsed: input.fallbackUsed,
    actualProviderId: input.actualProviderId ?? input.fallbackProviderId,
    actualModel: input.actualModel,
    attempts: input.attempts ?? [],
    usage: input.output.usage,
    latencyMs: input.latencyMs,
    stagePattern: input.stagePattern,
    quality: input.quality
  };
}
