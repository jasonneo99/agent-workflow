import pg from "pg";

const { Client } = pg;

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? "postgres://agentflow:agentflow@localhost:15432/agentflow";
}

export async function withClient<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
