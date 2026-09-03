import pg from "pg";
import { defaultServiceEndpoints } from "./config.js";
import { checkServices, type ServiceCheck } from "./doctor.js";

const { Client } = pg;

export type StorageVerificationStatus = "match" | "mismatch" | "attention" | "blocked";

export interface StorageVerificationInput {
  sourceEnv?: NodeJS.ProcessEnv;
  targetEnv?: NodeJS.ProcessEnv;
  targetHost?: string;
  sourceDatabaseUrl?: string;
  sourceRedisUrl?: string;
  sourceObjectStorageEndpoint?: string;
  sourceObjectStorageBucket?: string;
  targetDatabaseUrl?: string;
  targetRedisUrl?: string;
  targetObjectStorageEndpoint?: string;
  targetObjectStorageBucket?: string;
}

export interface StorageEndpointSummary {
  databaseUrl: string;
  redisUrl: string;
  objectStorageEndpoint: string;
  objectStorageBucket: string;
}

export interface StorageTableSnapshot {
  table: string;
  exists: boolean;
  count: number | null;
  fingerprint: string | null;
}

export interface StorageBreakdown {
  name: string;
  values: Record<string, number>;
}

export interface StorageSnapshot {
  endpoint: StorageEndpointSummary;
  checks: ServiceCheck[];
  tables: StorageTableSnapshot[];
  breakdowns: StorageBreakdown[];
  sampledProjectRoots: string[];
  warnings: string[];
}

export interface StorageVerificationDiff {
  table: string;
  sourceCount: number | null;
  targetCount: number | null;
  sourceFingerprint: string | null;
  targetFingerprint: string | null;
  status: "match" | "mismatch" | "missing";
}

export interface StorageVerificationReport {
  kind: "agentflow_storage_verification_report";
  generatedAt: string;
  status: StorageVerificationStatus;
  source: StorageSnapshot;
  target: StorageSnapshot;
  diffs: StorageVerificationDiff[];
  warnings: string[];
  notes: string[];
}

const durableTables = [
  "agents",
  "workflows",
  "projects",
  "project_files",
  "project_index_state",
  "workflow_runs",
  "workflow_tasks",
  "action_receipts",
  "action_approvals",
  "artifacts",
  "memory_items"
];

const fingerprintExpressions: Record<string, string> = {
  agents: "id || ':' || display_name || ':' || category",
  workflows: "id || ':' || name",
  projects: "id::text || ':' || root_uri || ':' || profile",
  project_files: "project_id::text || ':' || source_uri || ':' || content_hash || ':' || token_estimate::text",
  project_index_state: "project_id::text || ':' || coalesce(head_commit, '') || ':' || indexed_files::text || ':' || deleted_files::text",
  workflow_runs: "id::text || ':' || project_id::text || ':' || workflow_id || ':' || status || ':' || policy_snapshot_hash",
  workflow_tasks: "id::text || ':' || run_id::text || ':' || stage_id || ':' || agent_id || ':' || status || ':' || attempts::text",
  action_receipts: "id::text || ':' || run_id::text || ':' || agent_id || ':' || action_type || ':' || target",
  action_approvals: "id::text || ':' || run_id::text || ':' || coalesce(task_id::text, '') || ':' || action_type || ':' || target || ':' || status",
  artifacts: "uri || ':' || coalesce(run_id::text, '') || ':' || coalesce(task_id::text, '') || ':' || kind",
  memory_items: "project_id::text || ':' || source_uri || ':' || content_hash"
};

export async function buildStorageVerificationReport(input: StorageVerificationInput): Promise<StorageVerificationReport> {
  const sourceEnv = input.sourceEnv ?? process.env;
  const targetEnv = input.targetEnv ?? {};
  const targetHost = input.targetHost ?? sourceEnv.AGENTFLOW_SHARED_STORAGE_HOST ?? targetEnv.AGENTFLOW_SHARED_STORAGE_HOST;
  const source = storageEndpointSummary({
    databaseUrl: input.sourceDatabaseUrl ?? sourceEnv.DATABASE_URL,
    redisUrl: input.sourceRedisUrl ?? sourceEnv.REDIS_URL,
    objectStorageEndpoint: input.sourceObjectStorageEndpoint ?? sourceEnv.OBJECT_STORAGE_ENDPOINT,
    objectStorageBucket: input.sourceObjectStorageBucket ?? sourceEnv.OBJECT_STORAGE_BUCKET
  });
  const target = storageEndpointSummary({
    databaseUrl: input.targetDatabaseUrl ?? targetEnv.DATABASE_URL ?? endpointUrlWhenHostMatches(source.databaseUrl, targetHost),
    redisUrl: input.targetRedisUrl ?? targetEnv.REDIS_URL ?? endpointUrlWhenHostMatches(source.redisUrl, targetHost),
    objectStorageEndpoint: input.targetObjectStorageEndpoint ?? targetEnv.OBJECT_STORAGE_ENDPOINT ?? endpointUrlWhenHostMatches(source.objectStorageEndpoint, targetHost),
    objectStorageBucket: input.targetObjectStorageBucket ?? targetEnv.OBJECT_STORAGE_BUCKET
  }, targetHost);

  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    inspectStorage(source),
    inspectStorage(target)
  ]);
  const diffs = compareStorageSnapshots(sourceSnapshot, targetSnapshot);
  const warnings = [
    ...sourceSnapshot.warnings.map((warning) => `source ${warning}`),
    ...targetSnapshot.warnings.map((warning) => `target ${warning}`),
    ...sameEndpointWarnings(source, target)
  ];
  const status: StorageVerificationStatus = warnings.some((warning) => warning.includes("database is not reachable") || warning.includes("database inspection failed"))
    ? "blocked"
    : diffs.some((diff) => diff.status !== "match")
      ? "mismatch"
      : warnings.length
        ? "attention"
        : "match";

  return {
    kind: "agentflow_storage_verification_report",
    generatedAt: new Date().toISOString(),
    status,
    source: redactSnapshot(sourceSnapshot),
    target: redactSnapshot(targetSnapshot),
    diffs,
    warnings,
    notes: [
      "Read-only verification. This command does not copy, delete, overwrite, or mutate source or target storage.",
      "Fingerprints summarize durable row identity and status fields; they are intended for migration proof, not cryptographic backup integrity.",
      "Object storage verification currently covers artifact metadata rows and endpoint reachability. Full bucket object enumeration is a future extension."
    ]
  };
}

export function compareStorageSnapshots(source: StorageSnapshot, target: StorageSnapshot): StorageVerificationDiff[] {
  const sourceByTable = new Map(source.tables.map((table) => [table.table, table]));
  const targetByTable = new Map(target.tables.map((table) => [table.table, table]));
  return durableTables.map((table) => {
    const sourceTable = sourceByTable.get(table);
    const targetTable = targetByTable.get(table);
    const missing = sourceTable?.exists !== true || targetTable?.exists !== true;
    const matches = !missing &&
      sourceTable.count === targetTable.count &&
      sourceTable.fingerprint === targetTable.fingerprint;
    return {
      table,
      sourceCount: sourceTable?.count ?? null,
      targetCount: targetTable?.count ?? null,
      sourceFingerprint: sourceTable?.fingerprint ?? null,
      targetFingerprint: targetTable?.fingerprint ?? null,
      status: missing ? "missing" : matches ? "match" : "mismatch"
    };
  });
}

export function formatStorageVerificationReport(report: StorageVerificationReport): string {
  return [
    `Shared storage verification report (${report.generatedAt})`,
    `Status: ${report.status}`,
    "",
    "Source:",
    `- Database: ${report.source.endpoint.databaseUrl}`,
    `- Redis: ${report.source.endpoint.redisUrl}`,
    `- Object storage: ${report.source.endpoint.objectStorageEndpoint}`,
    `- Bucket: ${report.source.endpoint.objectStorageBucket}`,
    "",
    "Target:",
    `- Database: ${report.target.endpoint.databaseUrl}`,
    `- Redis: ${report.target.endpoint.redisUrl}`,
    `- Object storage: ${report.target.endpoint.objectStorageEndpoint}`,
    `- Bucket: ${report.target.endpoint.objectStorageBucket}`,
    "",
    "Source checks:",
    ...report.source.checks.map(formatServiceCheck),
    "",
    "Target checks:",
    ...report.target.checks.map(formatServiceCheck),
    "",
    "Durable table comparison:",
    ...report.diffs.map((diff) => `- ${diff.table}: ${diff.status} (source=${diff.sourceCount ?? "missing"}, target=${diff.targetCount ?? "missing"})`),
    "",
    "Source breakdowns:",
    ...formatBreakdowns(report.source.breakdowns),
    "",
    "Target breakdowns:",
    ...formatBreakdowns(report.target.breakdowns),
    "",
    "Warnings:",
    ...(report.warnings.length ? report.warnings.map((warning) => `- ${warning}`) : ["- none"]),
    "",
    "Notes:",
    ...report.notes.map((note) => `- ${note}`)
  ].join("\n");
}

async function inspectStorage(endpoint: StorageEndpointSummary): Promise<StorageSnapshot> {
  const checks = await checkServices(defaultServiceEndpoints({
    DATABASE_URL: endpoint.databaseUrl,
    REDIS_URL: endpoint.redisUrl,
    OBJECT_STORAGE_ENDPOINT: endpoint.objectStorageEndpoint
  }));
  const warnings = serviceWarnings(checks);
  if (!checks.find((check) => check.endpoint.name === "Postgres + pgvector")?.reachable) {
    return {
      endpoint,
      checks,
      tables: durableTables.map((table) => ({ table, exists: false, count: null, fingerprint: null })),
      breakdowns: [],
      sampledProjectRoots: [],
      warnings: ["database is not reachable", ...warnings]
    };
  }

  const client = new Client({ connectionString: endpoint.databaseUrl });
  try {
    await client.connect();
    const tables = [];
    for (const table of durableTables) {
      tables.push(await inspectTable(client, table));
    }
    const breakdowns = await loadBreakdowns(client);
    const sampledProjectRoots = await loadSampledProjectRoots(client);
    return {
      endpoint,
      checks,
      tables,
      breakdowns,
      sampledProjectRoots,
      warnings
    };
  } catch (error) {
    return {
      endpoint,
      checks,
      tables: durableTables.map((table) => ({ table, exists: false, count: null, fingerprint: null })),
      breakdowns: [],
      sampledProjectRoots: [],
      warnings: [`database inspection failed: ${error instanceof Error ? error.message : String(error)}`, ...warnings]
    };
  } finally {
    await client.end();
  }
}

async function inspectTable(client: pg.Client, table: string): Promise<StorageTableSnapshot> {
  const existsResult = await client.query<{ exists: boolean }>("select to_regclass($1) is not null as exists", [table]);
  if (!existsResult.rows[0]?.exists) {
    return { table, exists: false, count: null, fingerprint: null };
  }
  const expression = fingerprintExpressions[table];
  const result = await client.query<{ count: number; fingerprint: string | null }>(
    `select count(*)::int as count,
            md5(coalesce(string_agg(coalesce((${expression}), ''), E'\n' order by coalesce((${expression}), '')), '')) as fingerprint
       from ${table}`
  );
  const row = result.rows[0];
  return {
    table,
    exists: true,
    count: row?.count ?? 0,
    fingerprint: row?.fingerprint ?? null
  };
}

async function loadBreakdowns(client: pg.Client): Promise<StorageBreakdown[]> {
  const specs = [
    { name: "workflow_runs.status", table: "workflow_runs", column: "status" },
    { name: "workflow_tasks.status", table: "workflow_tasks", column: "status" },
    { name: "action_approvals.status", table: "action_approvals", column: "status" },
    { name: "artifacts.kind", table: "artifacts", column: "kind" }
  ];
  const breakdowns: StorageBreakdown[] = [];
  for (const spec of specs) {
    const existsResult = await client.query<{ exists: boolean }>("select to_regclass($1) is not null as exists", [spec.table]);
    if (!existsResult.rows[0]?.exists) continue;
    const result = await client.query<{ key: string; count: number }>(
      `select ${spec.column} as key, count(*)::int as count
         from ${spec.table}
        group by ${spec.column}
        order by ${spec.column}`
    );
    breakdowns.push({
      name: spec.name,
      values: Object.fromEntries(result.rows.map((row) => [row.key, row.count]))
    });
  }
  return breakdowns;
}

async function loadSampledProjectRoots(client: pg.Client): Promise<string[]> {
  const existsResult = await client.query<{ exists: boolean }>("select to_regclass('projects') is not null as exists");
  if (!existsResult.rows[0]?.exists) return [];
  const result = await client.query<{ rootUri: string }>(
    `select root_uri as "rootUri"
       from projects
      order by root_uri asc
      limit 20`
  );
  return result.rows.map((row) => row.rootUri);
}

function storageEndpointSummary(
  input: { databaseUrl?: string; redisUrl?: string; objectStorageEndpoint?: string; objectStorageBucket?: string },
  targetHost?: string
): StorageEndpointSummary {
  return {
    databaseUrl: input.databaseUrl ?? (targetHost ? `postgres://agentflow:agentflow@${targetHost}:15432/agentflow` : "postgres://agentflow:agentflow@localhost:15432/agentflow"),
    redisUrl: input.redisUrl ?? (targetHost ? `redis://${targetHost}:16379` : "redis://localhost:16379"),
    objectStorageEndpoint: input.objectStorageEndpoint ?? (targetHost ? `http://${targetHost}:19000` : "http://localhost:19000"),
    objectStorageBucket: input.objectStorageBucket ?? "agentflow-artifacts"
  };
}

function redactSnapshot(snapshot: StorageSnapshot): StorageSnapshot {
  return {
    ...snapshot,
    endpoint: {
      databaseUrl: redactUrl(snapshot.endpoint.databaseUrl),
      redisUrl: redactUrl(snapshot.endpoint.redisUrl),
      objectStorageEndpoint: redactUrl(snapshot.endpoint.objectStorageEndpoint),
      objectStorageBucket: snapshot.endpoint.objectStorageBucket
    }
  };
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "user";
    if (parsed.password) parsed.password = "redacted";
    return parsed.toString();
  } catch {
    return value.replace(/:\/\/([^:@/]+):([^@/]+)@/, "://user:redacted@");
  }
}

function sameEndpointWarnings(source: StorageEndpointSummary, target: StorageEndpointSummary): string[] {
  const warnings: string[] = [];
  if (canonicalUrl(source.databaseUrl) === canonicalUrl(target.databaseUrl)) {
    warnings.push("source and target database URLs point to the same endpoint; this verifies one shared storage plane, not a migration copy");
  }
  if (canonicalUrl(source.redisUrl) === canonicalUrl(target.redisUrl)) {
    warnings.push("source and target Redis URLs point to the same endpoint");
  }
  if (canonicalUrl(source.objectStorageEndpoint) === canonicalUrl(target.objectStorageEndpoint) && source.objectStorageBucket === target.objectStorageBucket) {
    warnings.push("source and target object storage point to the same endpoint and bucket");
  }
  return warnings;
}

function endpointUrlWhenHostMatches(value: string, host: string | undefined): string | undefined {
  if (!host) return undefined;
  try {
    return new URL(value).hostname === host ? value : undefined;
  } catch {
    return undefined;
  }
}

function canonicalUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value;
  }
}

function serviceWarnings(checks: ServiceCheck[]): string[] {
  return checks
    .filter((check) => !check.reachable)
    .map((check) => `${check.endpoint.name} is not reachable: ${check.message}`);
}

function formatServiceCheck(check: ServiceCheck): string {
  return `- ${check.reachable ? "OK" : "MISSING"} ${check.endpoint.name}: ${check.message}`;
}

function formatBreakdowns(breakdowns: StorageBreakdown[]): string[] {
  if (!breakdowns.length) return ["- none"];
  return breakdowns.map((breakdown) => {
    const values = Object.entries(breakdown.values)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ");
    return `- ${breakdown.name}: ${values || "none"}`;
  });
}
