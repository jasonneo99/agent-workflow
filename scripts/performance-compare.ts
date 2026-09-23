#!/usr/bin/env tsx
import { compareRegression } from "../packages/perf-harness/src/index.js";
import { getPerformanceBaseline } from "../packages/storage/src/performance.js";

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const baselineId = requiredArgument("--baseline");
const candidateId = requiredArgument("--candidate");
const budgetPercent = Number(requiredArgument("--budget"));
if (!Number.isFinite(budgetPercent) || budgetPercent < 0) throw new Error("--budget must be a non-negative percentage");
const baseline = await getPerformanceBaseline(baselineId);
const candidate = await getPerformanceBaseline(candidateId);
if (!baseline || !candidate) throw new Error("Both baseline and candidate performance records must exist");
if (baseline.workload_hash !== candidate.workload_hash) throw new Error("Baseline and candidate workload hashes do not match");

const baselineRoutes = (baseline.metrics.routes ?? {}) as Record<string, { count?: number; p95?: number; failures?: number }>;
const candidateRoutes = (candidate.metrics.routes ?? {}) as Record<string, { count?: number; p95?: number; failures?: number }>;
const results = Object.entries(baselineRoutes).map(([route, baselineMetric]) => {
  const candidateMetric = candidateRoutes[route];
  if (!candidateMetric || (baselineMetric.count ?? 0) < 3 || (candidateMetric.count ?? 0) < 3) {
    return { route, passed: false, reason: "missing or insufficient samples" };
  }
  const comparison = compareRegression({ baselineP95: baselineMetric.p95 ?? 0, candidateP95: candidateMetric.p95 ?? 0, budgetPercent });
  const failureFree = (candidateMetric.failures ?? 0) === 0;
  return { route, ...comparison, passed: comparison.passed && failureFree, failures: candidateMetric.failures ?? 0 };
});
const passed = results.length > 0 && results.every((result) => result.passed);
console.log(JSON.stringify({ baselineId, candidateId, workloadHash: baseline.workload_hash, budgetPercent, passed, results }, null, 2));
if (!passed) process.exitCode = 1;
