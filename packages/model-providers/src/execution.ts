import { ModelCandidatesExhaustedError } from "./fallback.js";
import type { ModelProvider, StageExecutionInput, StageExecutionOutput } from "./types.js";

export type ProviderExecutionAttempt = {
  providerId: string;
  outcome: "failed" | "skipped";
  reason: string;
};

export async function executeStageWithProviderFallback(input: {
  stage: StageExecutionInput;
  primaryProviderId: string;
  fallbackProviderIds: string[];
  providerFactory: (providerId: string) => ModelProvider;
}): Promise<{ providerId: string; output: StageExecutionOutput; attempts: ProviderExecutionAttempt[] }> {
  const attempts: ProviderExecutionAttempt[] = [];
  const candidates = [input.primaryProviderId, ...input.fallbackProviderIds.filter((id) => id !== input.primaryProviderId)];
  let lastError: unknown;
  for (const [index, providerId] of candidates.entries()) {
    let provider: ModelProvider;
    try {
      provider = input.providerFactory(providerId);
    } catch (error) {
      attempts.push({ providerId, outcome: "skipped", reason: boundedReason(error) });
      continue;
    }
    if (index > 0 && provider.check) {
      const readiness = await provider.check();
      if (!readiness.ready) {
        attempts.push({ providerId, outcome: "skipped", reason: readiness.details.join("; ").slice(0, 500) });
        continue;
      }
    }
    try {
      return { providerId, output: await provider.executeStage(input.stage), attempts };
    } catch (error) {
      lastError = error;
      attempts.push({ providerId, outcome: "failed", reason: boundedReason(error) });
      if (!(error instanceof ModelCandidatesExhaustedError) || !error.providerFallbackAllowed) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No configured model provider could execute the stage.");
}

function boundedReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:sk|key|token|secret)[-_][a-z0-9_-]{8,}/giu, "[redacted]")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .slice(0, 500);
}
