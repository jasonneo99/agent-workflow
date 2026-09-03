export interface ServiceEndpoint {
  name: string;
  host: string;
  port: number;
  requiredFor: "enterprise" | "optional";
}

export function defaultServiceEndpoints(env: NodeJS.ProcessEnv = process.env): ServiceEndpoint[] {
  return [
    {
      name: "Postgres + pgvector",
      ...endpointFromUrl(env.DATABASE_URL, {
        host: env.AGENTFLOW_POSTGRES_HOST ?? "127.0.0.1",
        port: Number(env.AGENTFLOW_POSTGRES_PORT ?? 15432),
        defaultUrlPort: 5432
      }),
      requiredFor: "enterprise"
    },
    {
      name: "Redis",
      ...endpointFromUrl(env.REDIS_URL, {
        host: env.AGENTFLOW_REDIS_HOST ?? "127.0.0.1",
        port: Number(env.AGENTFLOW_REDIS_PORT ?? 16379),
        defaultUrlPort: 6379
      }),
      requiredFor: "enterprise"
    },
    {
      name: "MinIO object storage",
      ...endpointFromUrl(env.OBJECT_STORAGE_ENDPOINT, {
        host: env.AGENTFLOW_MINIO_HOST ?? "127.0.0.1",
        port: Number(env.AGENTFLOW_MINIO_PORT ?? 19000),
        defaultUrlPort: 443
      }),
      requiredFor: "enterprise"
    }
  ];
}

function endpointFromUrl(
  rawUrl: string | undefined,
  fallback: { host: string; port: number; defaultUrlPort: number }
): { host: string; port: number } {
  if (!rawUrl) return { host: fallback.host, port: fallback.port };

  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.hostname || fallback.host,
      port: Number(parsed.port || inferredDefaultPort(parsed.protocol, fallback.defaultUrlPort))
    };
  } catch {
    return { host: fallback.host, port: fallback.port };
  }
}

function inferredDefaultPort(protocol: string, fallbackPort: number): number {
  if (protocol === "http:") return 80;
  if (protocol === "https:") return 443;
  if (protocol === "redis:") return 6379;
  if (protocol === "postgres:" || protocol === "postgresql:") return 5432;
  return fallbackPort;
}
