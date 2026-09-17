import { providerFromEnv } from "../../../packages/model-providers/src/index.js";

export const WORKER_PROVIDER_IDS = ["mock", "local", "byo", "bedrock", "codex-cli", "openai", "anthropic", "openai-compatible", "kiro"] as const;

export type WorkerProviderCapabilities = {
  ready: string[];
  unavailable: Array<{ providerId: string; reason: string }>;
};

export async function probeWorkerProviderCapabilities(timeoutMs = 10_000): Promise<WorkerProviderCapabilities> {
  const results = await Promise.all(WORKER_PROVIDER_IDS.map(async (providerId) => {
    try {
      const provider = providerFromEnv(providerId);
      if (!provider.check) return { providerId, ready: true, reason: "adapter available" };
      const result = await withTimeout(provider.check(), timeoutMs, `${providerId} readiness timed out`);
      return { providerId, ready: result.ready, reason: result.details.join("; ") || (result.ready ? "ready" : "not ready") };
    } catch (error) {
      return { providerId, ready: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }));
  return {
    ready: results.filter((item) => item.ready).map((item) => item.providerId),
    unavailable: results.filter((item) => !item.ready).map((item) => ({ providerId: item.providerId, reason: item.reason }))
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
