import { executeStageWithProviderFallback, providerFromEnv } from "../../model-providers/src/index.js";
import { scoreStageOutput } from "../../model-providers/src/quality.js";
import { providerFallbackCandidates, selectModelRoute, type ModelRouteDecision } from "../../model-providers/src/routing.js";
import type { StageExecutionInput, StageExecutionOutput } from "../../model-providers/src/types.js";

export async function executeRoutedModelStage(stageInput: StageExecutionInput): Promise<{
  route: ModelRouteDecision;
  output: StageExecutionOutput;
  quality: ReturnType<typeof scoreStageOutput>;
  fallbackProviderId: string | undefined;
  fallbackUsed: boolean;
}> {
  const route = await selectModelRoute(stageInput);
  const routedStageInput = { ...stageInput, modelTier: route.modelTier };
  const routedExecution = await executeStageWithProviderFallback({
    stage: routedStageInput,
    primaryProviderId: route.providerId,
    fallbackProviderIds: providerFallbackCandidates(route.providerId, route.modelTier),
    providerFactory: providerFromEnv
  });
  let output: StageExecutionOutput = {
    ...routedExecution.output,
    artifact: { ...routedExecution.output.artifact, providerAttempts: routedExecution.attempts }
  };
  let quality = scoreStageOutput(routedStageInput, output);
  let fallbackProviderId = routedExecution.providerId !== route.providerId ? routedExecution.providerId : process.env.AGENTFLOW_FALLBACK_PROVIDER;
  let fallbackUsed = routedExecution.providerId !== route.providerId;
  const qualityFallbackProviderId = process.env.AGENTFLOW_FALLBACK_PROVIDER;
  const qualityFallbackAlreadyTried = routedExecution.attempts.some((attempt) => attempt.providerId === qualityFallbackProviderId);

  if (!quality.passed && qualityFallbackProviderId && qualityFallbackProviderId !== routedExecution.providerId && !qualityFallbackAlreadyTried) {
    const fallbackOutput = await providerFromEnv(qualityFallbackProviderId).executeStage(routedStageInput);
    const fallbackQuality = scoreStageOutput(routedStageInput, fallbackOutput);
    if (fallbackQuality.score >= quality.score) {
      output = fallbackOutput;
      quality = fallbackQuality;
      fallbackProviderId = qualityFallbackProviderId;
      fallbackUsed = true;
    }
  }
  return { route, output, quality, fallbackProviderId, fallbackUsed };
}
