#!/usr/bin/env tsx
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { summarize } from "../packages/perf-harness/src/index.js";
import { createPerformanceBaseline } from "../packages/storage/src/performance.js";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = argument("--base-url", "http://127.0.0.1:17888").replace(/\/$/u, "");
const samples = Math.max(3, Math.min(100, Number(argument("--samples", "15")) || 15));
const routes = argument("--routes", "/api/queue?limit=50,/api/runs?limit=50,/api/activity?limit=50").split(",").map((item) => item.trim()).filter(Boolean);
const workload = { kind: "agentflow_dashboard_http_v1", routes, samples };
const workloadHash = createHash("sha256").update(JSON.stringify(workload)).digest("hex");
const metrics: Record<string, unknown> = { workload, measuredAt: new Date().toISOString(), routes: {} };

for (const route of routes) {
  const values: number[] = [];
  let failures = 0;
  for (let index = 0; index < samples + 1; index += 1) {
    const started = performance.now();
    const response = await fetch(`${baseUrl}${route}`, { signal: AbortSignal.timeout(15_000) });
    await response.arrayBuffer();
    const durationMs = performance.now() - started;
    if (!response.ok) failures += 1;
    if (index > 0) values.push(durationMs);
  }
  (metrics.routes as Record<string, unknown>)[route] = { ...summarize(values), failures };
}

const id = await createPerformanceBaseline({ workloadHash, metrics });
console.log(JSON.stringify({ id, workloadHash, metrics }, null, 2));
