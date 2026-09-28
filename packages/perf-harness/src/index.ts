/**
 * Pure performance measurement helpers. Persistence is injected by callers so
 * this package does not depend on infrastructure or process-global paths.
 */
import { performance } from 'perf_hooks';

export type MeasureOptions = {
  labels?: Record<string, string>;
  record?: (sample: PerformanceSample) => void | Promise<void>;
};

export type PerformanceSample = { name: string; value: number; unit: string; labels: Record<string, string> };

export async function measure<T>(name: string, fn: () => Promise<T> | T, opts: MeasureOptions): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  const durationMs = performance.now() - start;
  await opts.record?.({ name, value: durationMs, unit: 'ms', labels: opts.labels ?? {} });
  return { result, durationMs };
}

export function measureSync<T>(name: string, fn: () => T, opts: MeasureOptions): { result: T; durationMs: number } {
  const start = performance.now();
  const result = fn();
  const durationMs = performance.now() - start;
  void opts.record?.({ name, value: durationMs, unit: 'ms', labels: opts.labels ?? {} });
  return { result, durationMs };
}

export function summarize(values: number[]): { count: number; p50: number; p95: number; average: number; min: number; max: number } {
  if (!values.length) return { count: 0, p50: 0, p95: 0, average: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (value: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
  return {
    count: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    average: values.reduce((total, item) => total + item, 0) / values.length,
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0
  };
}

export function compareRegression(input: { baselineP95: number; candidateP95: number; budgetPercent: number }): { deltaPercent: number; passed: boolean } {
  if (input.baselineP95 <= 0) return { deltaPercent: Number.POSITIVE_INFINITY, passed: false };
  const deltaPercent = ((input.candidateP95 - input.baselineP95) / input.baselineP95) * 100;
  return { deltaPercent, passed: deltaPercent <= input.budgetPercent };
}

export function calcThroughput(count: number, durationMs: number): number {
  return durationMs > 0 ? (count / durationMs) * 1000 : 0;
}

export type WorkflowTiming = {
  totalMs: number;
  queueDelayMs: number;
  modelLatencyMs: number;
  commandExecutionMs: number;
  approvalWaitMs: number;
  orchestrationOverheadMs: number;
  retries: number;
  usefulParallelism: number;
};

export function compareWorkflowToDirect(input: { direct: WorkflowTiming; workflow: WorkflowTiming; maximumMultiplier: number }) {
  const valid = (timing: WorkflowTiming) => Object.values(timing).every((value) => Number.isFinite(value) && value >= 0);
  if (!valid(input.direct) || !valid(input.workflow) || input.direct.totalMs <= 0 || input.maximumMultiplier < 1) throw new Error("Workflow comparison requires finite non-negative measurements and a positive direct baseline");
  const multiplier = input.workflow.totalMs / input.direct.totalMs;
  const contributors = [
    ["queue", input.workflow.queueDelayMs],
    ["model", input.workflow.modelLatencyMs],
    ["command", input.workflow.commandExecutionMs],
    ["approval", input.workflow.approvalWaitMs],
    ["orchestration", input.workflow.orchestrationOverheadMs]
  ] as const;
  const dominantContributor = [...contributors].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "unknown";
  const recommendations = [] as string[];
  if (input.workflow.queueDelayMs > input.direct.totalMs * 0.1) recommendations.push("Reduce queue delay or increase eligible worker capacity.");
  if (input.workflow.orchestrationOverheadMs > input.direct.totalMs * 0.2) recommendations.push("Collapse redundant stages or reuse fresh evidence.");
  if (input.workflow.usefulParallelism < 1.2 && input.workflow.totalMs > input.direct.totalMs) recommendations.push("Parallelize independent stages after conflict analysis.");
  if (input.workflow.retries > input.direct.retries) recommendations.push("Address retry causes before relaxing latency budgets.");
  return { multiplier, passed: multiplier <= input.maximumMultiplier, dominantContributor, recommendations };
}
