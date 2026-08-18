import { z } from "zod";
import type { CostQualityReport } from "../../run-reporter/src/index.js";

export const evaluationSuiteSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().default(""),
  workflow: z.string().min(1),
  cases: z.array(z.object({
    id: z.string().min(1),
    task: z.string().min(1),
    expectations: z.object({
      status: z.enum(["completed", "failed"]).default("completed"),
      minimum_average_quality: z.number().min(0).max(1).default(0.7),
      maximum_fallbacks: z.number().int().nonnegative().default(0)
    }).default({ status: "completed", minimum_average_quality: 0.7, maximum_fallbacks: 0 })
  })).min(1),
  variants: z.array(z.object({
    id: z.string().min(1),
    provider: z.string().min(1),
    model_tier: z.enum(["fast", "standard", "reasoning"]),
    prompt_suffix: z.string().default("")
  })).min(1)
});

export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;
export type EvaluationCase = EvaluationSuite["cases"][number];
export type EvaluationVariant = EvaluationSuite["variants"][number];

export interface EvaluationObservation {
  caseId: string;
  variantId: string;
  runId: string;
  report: CostQualityReport;
}

export interface EvaluationResultRow {
  caseId: string;
  variantId: string;
  runId: string;
  provider: string;
  modelTier: string;
  status: string;
  averageQuality: number | null;
  fallbackCount: number;
  totalLatencyMs: number;
  estimatedCostMix: Record<string, number>;
  feedbackRating: "accepted" | "revised" | "rejected" | null;
  passed: boolean;
  failures: string[];
}

export interface EvaluationVariantSummary {
  variantId: string;
  provider: string;
  modelTier: string;
  runs: number;
  passed: number;
  passRate: number;
  averageQuality: number | null;
  averageLatencyMs: number | null;
  fallbackRate: number;
  feedbackCounts: Record<string, number>;
}

export interface EvaluationReport {
  suiteId: string;
  suiteName: string;
  workflow: string;
  generatedAt: string;
  rows: EvaluationResultRow[];
  variants: EvaluationVariantSummary[];
  winner: string | null;
}

export function buildEvaluationReport(
  suite: EvaluationSuite,
  observations: EvaluationObservation[]
): EvaluationReport {
  const caseMap = new Map(suite.cases.map((item) => [item.id, item]));
  const variantMap = new Map(suite.variants.map((item) => [item.id, item]));
  const rows = observations.map((observation): EvaluationResultRow => {
    const testCase = required(caseMap.get(observation.caseId), `Unknown evaluation case: ${observation.caseId}`);
    const variant = required(variantMap.get(observation.variantId), `Unknown evaluation variant: ${observation.variantId}`);
    const failures: string[] = [];
    if (observation.report.status !== testCase.expectations.status) {
      failures.push(`status ${observation.report.status} did not match ${testCase.expectations.status}`);
    }
    if (observation.report.averageQuality === null || observation.report.averageQuality < testCase.expectations.minimum_average_quality) {
      failures.push(`quality ${observation.report.averageQuality ?? "n/a"} was below ${testCase.expectations.minimum_average_quality}`);
    }
    if (observation.report.fallbackCount > testCase.expectations.maximum_fallbacks) {
      failures.push(`fallbacks ${observation.report.fallbackCount} exceeded ${testCase.expectations.maximum_fallbacks}`);
    }
    return {
      caseId: testCase.id,
      variantId: variant.id,
      runId: observation.runId,
      provider: variant.provider,
      modelTier: variant.model_tier,
      status: observation.report.status,
      averageQuality: observation.report.averageQuality,
      fallbackCount: observation.report.fallbackCount,
      totalLatencyMs: observation.report.totalLatencyMs,
      estimatedCostMix: observation.report.estimatedCostMix,
      feedbackRating: observation.report.feedback.latest?.rating ?? null,
      passed: failures.length === 0,
      failures
    };
  });

  const variants = suite.variants.map((variant): EvaluationVariantSummary => {
    const selected = rows.filter((row) => row.variantId === variant.id);
    const quality = selected.filter((row) => row.averageQuality !== null);
    return {
      variantId: variant.id,
      provider: variant.provider,
      modelTier: variant.model_tier,
      runs: selected.length,
      passed: selected.filter((row) => row.passed).length,
      passRate: round(selected.filter((row) => row.passed).length / Math.max(1, selected.length)),
      averageQuality: quality.length
        ? round(quality.reduce((sum, row) => sum + (row.averageQuality ?? 0), 0) / quality.length)
        : null,
      averageLatencyMs: selected.length
        ? Math.round(selected.reduce((sum, row) => sum + row.totalLatencyMs, 0) / selected.length)
        : null,
      fallbackRate: round(selected.reduce((sum, row) => sum + row.fallbackCount, 0) / Math.max(1, selected.length)),
      feedbackCounts: countBy(selected.filter((row) => row.feedbackRating !== null), (row) => row.feedbackRating ?? "none")
    };
  }).sort((a, b) =>
    b.passRate - a.passRate ||
    (b.averageQuality ?? -1) - (a.averageQuality ?? -1) ||
    a.fallbackRate - b.fallbackRate ||
    (a.averageLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.averageLatencyMs ?? Number.MAX_SAFE_INTEGER)
  );

  return {
    suiteId: suite.id,
    suiteName: suite.name,
    workflow: suite.workflow,
    generatedAt: new Date().toISOString(),
    rows,
    variants,
    winner: variants[0]?.variantId ?? null
  };
}

export function formatEvaluationReport(report: EvaluationReport): string {
  return [
    `# Evaluation: ${report.suiteName}`,
    "",
    `- Suite: ${report.suiteId}`,
    `- Workflow: ${report.workflow}`,
    `- Generated: ${report.generatedAt}`,
    `- Winner: ${report.winner ?? "none"}`,
    "",
    "## Variant comparison",
    "",
    "| Variant | Provider | Tier | Pass rate | Quality | Avg latency | Fallbacks/run | Feedback |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...report.variants.map((variant) =>
      `| ${variant.variantId} | ${variant.provider} | ${variant.modelTier} | ${variant.passRate} | ${variant.averageQuality ?? "n/a"} | ${variant.averageLatencyMs ?? "n/a"}ms | ${variant.fallbackRate} | ${formatCounts(variant.feedbackCounts)} |`
    ),
    "",
    "## Runs",
    "",
    ...report.rows.map((row) =>
      `- ${row.caseId} / ${row.variantId}: ${row.passed ? "PASS" : "FAIL"} — quality=${row.averageQuality ?? "n/a"}, latency=${row.totalLatencyMs}ms, fallbacks=${row.fallbackCount}, run=${row.runId}${row.failures.length ? `\n  - ${row.failures.join("; ")}` : ""}`
    )
  ].join("\n");
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) {
    throw new Error(message);
  }
  return value;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function countBy<T>(items: T[], keyFor: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFor(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}=${value}`).join(", ") : "none";
}
