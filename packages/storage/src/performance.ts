import { withClient } from "./client.js";

export interface PerformanceBaselineRow {
  id: string;
  project_id: string | null;
  workflow_id: string | null;
  workload_hash: string;
  metrics: Record<string, unknown>;
  created_at: string;
}

export interface PerformanceMetricRow {
  id: string;
  baseline_id: string | null;
  run_id: string | null;
  stage_id: string;
  latency_ms: number;
  cpu_ms: number | null;
  memory_mb: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function createPerformanceBaseline(input: {
  projectId?: string;
  workflowId?: string;
  workloadHash: string;
  metrics?: Record<string, unknown>;
}): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into performance_baselines (project_id, workflow_id, workload_hash, metrics)
       values ($1, $2, $3, $4)
       returning id`,
      [input.projectId ?? null, input.workflowId ?? null, input.workloadHash, JSON.stringify(input.metrics ?? {})]
    );
    return result.rows[0].id;
  });
}

export async function recordPerformanceMetric(input: {
  baselineId?: string;
  runId?: string;
  stageId: string;
  latencyMs: number;
  cpuMs?: number;
  memoryMb?: number;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  return withClient(async (client) => {
    const result = await client.query<{ id: string }>(
      `insert into performance_metrics (baseline_id, run_id, stage_id, latency_ms, cpu_ms, memory_mb, metadata)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        input.baselineId ?? null,
        input.runId ?? null,
        input.stageId,
        input.latencyMs,
        input.cpuMs ?? null,
        input.memoryMb ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return result.rows[0].id;
  });
}

export async function listPerformanceBaselines(projectId: string, limit = 20): Promise<PerformanceBaselineRow[]> {
  return withClient(async (client) => {
    const result = await client.query<PerformanceBaselineRow>(
      `select id::text, project_id::text, workflow_id, workload_hash, metrics, created_at::text
       from performance_baselines
       where project_id = $1
       order by created_at desc
       limit $2`,
      [projectId, limit]
    );
    return result.rows;
  });
}

export async function getPerformanceBaseline(id: string): Promise<PerformanceBaselineRow | null> {
  return withClient(async (client) => {
    const result = await client.query<PerformanceBaselineRow>(
      `select id::text, project_id::text, workflow_id, workload_hash, metrics, created_at::text
       from performance_baselines
       where id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  });
}

export async function listPerformanceMetrics(baselineId: string): Promise<PerformanceMetricRow[]> {
  return withClient(async (client) => {
    const result = await client.query<PerformanceMetricRow>(
      `select id::text, baseline_id::text, run_id::text, stage_id, latency_ms, cpu_ms, memory_mb, metadata, created_at::text
       from performance_metrics
       where baseline_id = $1
       order by created_at asc`,
      [baselineId]
    );
    return result.rows;
  });
}
