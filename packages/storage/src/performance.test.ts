import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("performance storage helpers use parameterized queries and jsonb", () => {
  const source = readFileSync(new URL("./performance.ts", import.meta.url), "utf8");
  assert.match(source, /export async function createPerformanceBaseline/);
  assert.match(source, /export async function recordPerformanceMetric/);
  assert.match(source, /export async function listPerformanceBaselines/);
  assert.match(source, /export async function listPerformanceMetrics/);
  assert.match(source, /export async function getPerformanceBaseline/);
  assert.match(source, /withClient/);
  assert.match(source, /insert into performance_baselines/);
  assert.match(source, /insert into performance_metrics/);
  assert.match(source, /JSON\.stringify\(input\.metrics/);
  assert.match(source, /JSON\.stringify\(input\.metadata/);
  assert.doesNotMatch(source, /\$\{input\./);
});

test("canonical runtime migration contains performance tables and indexes", () => {
  const sql = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS performance_baselines/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS performance_metrics/);
  assert.match(sql, /workload_hash text NOT NULL/);
  assert.match(sql, /latency_ms double precision NOT NULL CHECK \(latency_ms >= 0\)/);
  assert.match(sql, /performance_baselines_project_created_idx/);
  assert.match(sql, /performance_metrics_run_stage_idx/);
  assert.match(sql, /performance_metrics_baseline_created_idx/);
  assert.match(sql, /ON DELETE CASCADE/);
});

test("canonical runtime migration contains hot-path indexes", () => {
  const sql = readFileSync(new URL("./postgres.ts", import.meta.url), "utf8");
  assert.match(sql, /CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS workflow_runs_workflow_status_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS workflow_tasks_run_status_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS action_receipts_run_created_idx/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS artifacts_task_kind_idx/);
  assert.match(sql, /ON workflow_runs\(project_id, status, created_at DESC\)/);
});

test("init.sql syncs performance tables and hot-path indexes for fresh installs", () => {
  const init = readFileSync(new URL("../../../infra/init.sql", import.meta.url), "utf8");
  assert.match(init, /CREATE TABLE IF NOT EXISTS performance_baselines/);
  assert.match(init, /CREATE TABLE IF NOT EXISTS performance_metrics/);
  assert.match(init, /CREATE INDEX IF NOT EXISTS workflow_runs_project_status_idx/);
  assert.match(init, /CREATE INDEX IF NOT EXISTS workflow_tasks_run_status_idx/);
});

test("perf harness scripts execute real HTTP workloads and enforce comparisons", () => {
  const baseline = readFileSync(new URL("../../../scripts/performance-baseline.ts", import.meta.url), "utf8");
  const compare = readFileSync(new URL("../../../scripts/performance-compare.ts", import.meta.url), "utf8");
  const docs = readFileSync(new URL("../../../docs/performance/speed-tests.md", import.meta.url), "utf8");
  assert.match(baseline, /workloadHash/);
  assert.match(baseline, /fetch/);
  assert.match(compare, /--baseline/);
  assert.match(compare, /--candidate/);
  assert.match(compare, /--budget/);
  assert.match(compare, /process\.exitCode = 1/);
  assert.match(docs, /performance_baselines/);
  assert.match(docs, /performance_metrics/);
  assert.match(docs, /EXPLAIN ANALYZE/);
  assert.match(docs, /Validation Evidence Needed Before Handoff/);
});
