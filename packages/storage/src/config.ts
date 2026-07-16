export interface ServiceEndpoint {
  name: string;
  host: string;
  port: number;
  requiredFor: "enterprise" | "optional";
}

export const defaultServiceEndpoints: ServiceEndpoint[] = [
  {
    name: "Postgres + pgvector",
    host: "127.0.0.1",
    port: Number(process.env.AGENTFLOW_POSTGRES_PORT ?? 15432),
    requiredFor: "enterprise"
  },
  {
    name: "Redis",
    host: "127.0.0.1",
    port: Number(process.env.AGENTFLOW_REDIS_PORT ?? 16379),
    requiredFor: "enterprise"
  },
  {
    name: "MinIO object storage",
    host: "127.0.0.1",
    port: Number(process.env.AGENTFLOW_MINIO_PORT ?? 19000),
    requiredFor: "enterprise"
  }
];
