import type { WorkerResult, WorkerRunOptions } from "./worker-types.js";

export type WorkerWatchInput = {
  limitPerTick: number;
  intervalMs: number;
  workerId?: string;
  leaseSeconds?: number;
  projectRootUri?: string;
  concurrency?: number;
  perProjectConcurrency?: number;
  providerIds?: string[];
  defaultProviderId?: string;
  workerPlatform?: NodeJS.Platform;
  providerRecoveryCooldownMs?: number;
  recoverProvider?: (providerId: string) => Promise<boolean>;
  waitForWake?: (timeoutMs: number) => Promise<unknown>;
  shouldStop: () => boolean;
  onTick: (result: WorkerResult) => void | Promise<void>;
};

export async function runWorkerWatchLoop(
  input: WorkerWatchInput,
  runOnce: (limit: number, options: WorkerRunOptions) => Promise<WorkerResult>
): Promise<void> {
  const unavailableProjectRootUris = new Set<string>();
  const providerIds = input.providerIds ? new Set(input.providerIds) : undefined;
  const quarantinedProviders = new Map<string, number>();
  while (!input.shouldStop()) {
    if (providerIds && input.recoverProvider) {
      const cooldownMs = Math.max(1_000, input.providerRecoveryCooldownMs ?? 60_000);
      for (const [providerId, quarantinedAt] of quarantinedProviders) {
        if (Date.now() - quarantinedAt < cooldownMs) continue;
        if (await input.recoverProvider(providerId)) {
          quarantinedProviders.delete(providerId);
          providerIds.add(providerId);
        } else {
          quarantinedProviders.set(providerId, Date.now());
        }
      }
    }
    const result = await runContinuouslyReplenishedBatch(input, runOnce, {
      providerIds: providerIds ? [...providerIds] : undefined,
      unavailableProjectRootUris
    });
    if (providerIds) {
      for (const failure of result.providerFailures) {
        providerIds.delete(failure.providerId);
        quarantinedProviders.set(failure.providerId, Date.now());
      }
      result.providerIds = [...providerIds];
      result.quarantinedProviderIds = [...quarantinedProviders.keys()];
    }
    await input.onTick(result);
    if (input.waitForWake) await input.waitForWake(input.intervalMs);
    else await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  }
}

async function runContinuouslyReplenishedBatch(
  input: WorkerWatchInput,
  runOnce: (limit: number, options: WorkerRunOptions) => Promise<WorkerResult>,
  shared: { providerIds?: string[]; unavailableProjectRootUris: Set<string> }
): Promise<WorkerResult> {
  const aggregate: WorkerResult = {
    claimed: 0,
    completed: 0,
    failed: 0,
    providerFailures: [],
    providerIds: shared.providerIds ?? [],
    quarantinedProviderIds: []
  };
  const concurrency = Math.max(1, Math.min(16, input.concurrency ?? 1));
  const limit = Math.max(1, input.limitPerTick);
  let remaining = limit;
  let callsInFlight = 0;
  const options = (): WorkerRunOptions => ({
    workerId: input.workerId,
    leaseSeconds: input.leaseSeconds,
    projectRootUri: input.projectRootUri,
    concurrency: 1,
    perProjectConcurrency: input.perProjectConcurrency,
    providerIds: shared.providerIds,
    defaultProviderId: input.defaultProviderId,
    workerPlatform: input.workerPlatform,
    unavailableProjectRootUris: shared.unavailableProjectRootUris,
    shouldStop: input.shouldStop
  });

  const lane = async (): Promise<void> => {
    while (!input.shouldStop() && remaining > 0) {
      callsInFlight += 1;
      let tick: WorkerResult;
      try {
        tick = await runOnce(1, options());
      } finally {
        callsInFlight -= 1;
      }
      mergeWorkerResult(aggregate, tick!);
      if (tick!.claimed > 0) {
        remaining -= tick!.claimed;
        continue;
      }
      // Another lane can complete a stage and make its dependent stage runnable.
      // Keep this slot warm instead of abandoning it until the slowest batch item
      // finishes, which previously caused visible head-of-line queue delays.
      if (callsInFlight > 0 && remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, input.intervalMs)));
        continue;
      }
      return;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, limit) }, lane));
  return aggregate;
}

function mergeWorkerResult(target: WorkerResult, source: WorkerResult): void {
  target.claimed += source.claimed;
  target.completed += source.completed;
  target.failed += source.failed;
  target.providerFailures.push(...source.providerFailures);
}
