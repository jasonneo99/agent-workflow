export interface StorageEndpointCoordinates {
  databaseUrl: string;
  redisUrl: string;
  objectStorageEndpoint: string;
  objectStorageBucket: string;
}

export function storageEndpointCoordinates(input: Partial<StorageEndpointCoordinates>, targetHost?: string): StorageEndpointCoordinates {
  return {
    databaseUrl: input.databaseUrl ?? (targetHost ? `postgres://agentflow:agentflow@${targetHost}:15432/agentflow` : "postgres://agentflow:agentflow@localhost:15432/agentflow"),
    redisUrl: input.redisUrl ?? (targetHost ? `redis://${targetHost}:16379` : "redis://localhost:16379"),
    objectStorageEndpoint: input.objectStorageEndpoint ?? (targetHost ? `http://${targetHost}:19000` : "http://localhost:19000"),
    objectStorageBucket: input.objectStorageBucket ?? "agentflow-artifacts"
  };
}

export function redactStorageUrl(value: string): string {
  try { const parsed = new URL(value); if (parsed.username) parsed.username = "user"; if (parsed.password) parsed.password = "redacted"; return parsed.toString(); }
  catch { return value.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://user:redacted@"); }
}

export function storageEndpointWarnings(source: StorageEndpointCoordinates, target: StorageEndpointCoordinates, databaseWarning = "source and target database URLs point to the same endpoint"): string[] {
  const warnings: string[] = [];
  if (canonicalStorageUrl(source.databaseUrl) === canonicalStorageUrl(target.databaseUrl)) warnings.push(databaseWarning);
  if (canonicalStorageUrl(source.redisUrl) === canonicalStorageUrl(target.redisUrl)) warnings.push("source and target Redis URLs point to the same endpoint");
  if (canonicalStorageUrl(source.objectStorageEndpoint) === canonicalStorageUrl(target.objectStorageEndpoint) && source.objectStorageBucket === target.objectStorageBucket) warnings.push("source and target object storage point to the same endpoint and bucket");
  return warnings;
}

export function endpointUrlWhenHostMatches(value: string, host: string | undefined): string | undefined {
  if (!host) return undefined;
  try { return new URL(value).hostname === host ? value : undefined; } catch { return undefined; }
}

function canonicalStorageUrl(value: string): string {
  try { const parsed = new URL(value); parsed.username = ""; parsed.password = ""; return parsed.toString(); } catch { return value; }
}
