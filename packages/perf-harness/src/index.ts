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
