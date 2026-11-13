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
  /** Limit claims to this exact run without recovering other runs' leases. */
  runId?: string;
  concurrency?: number;
  perProjectConcurrency?: number;
  recoverExpiredLeases?: boolean;
  providerIds?: string[];
  /** Optional hard execution allowlist, including retries and fallback providers. */
  strictProviderIds?: string[];
  defaultProviderId?: string;
  workerPlatform?: NodeJS.Platform;
  unavailableProjectRootUris?: Set<string>;
  shouldStop?: () => boolean;
  /** Optional advisory-only fast-model observation. Deterministic sampling
   * retains an unguided baseline and never grants tools or authority. */
  guidePlane?: {enabled:true;sampleRate?:number;assignment?:{cohort:'guided'|'unguided';bucket:number;sampleRate:number}};
};
