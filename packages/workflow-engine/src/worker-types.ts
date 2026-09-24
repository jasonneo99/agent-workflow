export interface WorkerResult {
  claimed: number;
  completed: number;
  failed: number;
  providerFailures: Array<{ providerId: string; kind: string }>;
  providerIds?: string[];
  quarantinedProviderIds?: string[];
}

export type WorkerRunOptions = {
  workerId?: string;
  leaseSeconds?: number;
  projectRootUri?: string;
  concurrency?: number;
  perProjectConcurrency?: number;
  recoverExpiredLeases?: boolean;
  providerIds?: string[];
  defaultProviderId?: string;
  workerPlatform?: NodeJS.Platform;
  unavailableProjectRootUris?: Set<string>;
  shouldStop?: () => boolean;
};
