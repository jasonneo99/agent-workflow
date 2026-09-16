import pg from "pg";

const { Pool } = pg;
const pools = new Map<string, pg.Pool>();

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://agentflow:agentflow@localhost:15432/agentflow";
}

export async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const connectionString = databaseUrl();
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: boundedPoolSize(process.env.AGENTFLOW_DATABASE_POOL_MAX),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 5_000,
      allowExitOnIdle: true
    });
    pool.on("error", () => {
      if (pools.get(connectionString) === pool) pools.delete(connectionString);
    });
    pools.set(connectionString, pool);
  }
  const client = await pool.connect();
  try {
    return await fn(client as unknown as pg.Client);
  } finally {
    client.release();
  }
}

export function boundedPoolSize(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 20)) : 10;
}
