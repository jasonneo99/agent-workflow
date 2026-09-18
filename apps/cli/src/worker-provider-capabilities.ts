import { projectConfigSchema } from "../../../packages/agent-registry/src/schemas.js";
import { providerFromEnv } from "../../../packages/model-providers/src/index.js";
import type { ModelProvider } from "../../../packages/model-providers/src/types.js";

export const WORKER_PROVIDER_IDS = ["mock", "local", "byo", "bedrock", "codex-cli", "openai", "anthropic", "openai-compatible", "kiro"] as const;

export type WorkerProviderCapabilities = {
  ready: string[];
  unavailable: Array<{ providerId: string; reason: string }>;
};

const EXECUTION_CANARY_PROVIDERS = new Set(["codex-cli"]);

export async function probeWorkerProviderCapabilities(timeoutMs = 60_000): Promise<WorkerProviderCapabilities> {
  const results = await Promise.all(WORKER_PROVIDER_IDS.map(async (providerId) => {
    try {
      const provider = providerFromEnv(providerId);
      const result = provider.check
        ? await withTimeout(provider.check(), timeoutMs, `${providerId} readiness timed out`)
        : { ready: true, details: ["adapter available"] };
      if (!result.ready) return { providerId, ready: false, reason: result.details.join("; ") || "not ready" };
      if (EXECUTION_CANARY_PROVIDERS.has(providerId)) {
        const canary = await probeWorkerProviderExecution(providerId, provider, timeoutMs);
        return { providerId, ready: canary.ready, reason: canary.reason };
      }
      return { providerId, ready: true, reason: result.details.join("; ") || "ready" };
    } catch (error) {
      return { providerId, ready: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }));
  return {
    ready: results.filter((item) => item.ready).map((item) => item.providerId),
    unavailable: results.filter((item) => !item.ready).map((item) => ({ providerId: item.providerId, reason: item.reason }))
  };
}

export async function probeWorkerProviderExecution(providerId: string, provider = providerFromEnv(providerId), timeoutMs = 60_000): Promise<{ ready: boolean; reason: string }> {
  try {
    const output = await withTimeout(provider.executeStage({
      runId: "worker-provider-canary",
      taskId: `worker-provider-canary-${providerId}`,
      projectConfig: projectConfigSchema.parse({ project: { name: "Worker provider canary", autonomy: 0 } }),
      workflowId: "provider-smoke",
      workflowTask: "Verify that this worker can execute one bounded provider request.",
      stageId: "canary",
      agentId: "auto-test-runner",
      agentName: "Provider canary",
      agentPrompt: "Return a concise readiness result without tools, filesystem access, or side effects.",
      stageGoal: "Confirm provider inference readiness.",
      compiledBrief: "Provider execution canary. No project context or actions are available.",
      modelTier: "fast",
      priorReceipts: []
    }), timeoutMs, `${providerId} inference canary timed out`);
    return output.summary.trim()
      ? { ready: true, reason: "bounded inference canary passed" }
      : { ready: false, reason: "bounded inference canary returned no summary" };
  } catch (error) {
    return { ready: false, reason: error instanceof Error ? error.message : String(error) };
  }
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
