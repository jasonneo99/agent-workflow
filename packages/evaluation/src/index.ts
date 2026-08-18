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

export const evaluationScoringProfileSchema = z.object({
  version: z.literal(1).default(1),
  id: z.string().min(1),
  weights: z.object({
    pass_rate: z.number().default(1),
    quality: z.number().default(1),
    latency: z.number().default(0),
    fallback_rate: z.number().default(0),
    accepted_feedback_rate: z.number().default(0),
    revised_feedback_rate: z.number().default(0),
    rejected_feedback_rate: z.number().default(0)
  }).default({}),
  case_weights: z.record(z.number().positive()).default({}),
  latency_budget_ms: z.number().positive().default(30000)
});

export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;
export type EvaluationCase = EvaluationSuite["cases"][number];
export type EvaluationVariant = EvaluationSuite["variants"][number];
export type EvaluationScoringProfile = z.infer<typeof evaluationScoringProfileSchema>;

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
  privateScore: number | null;
}

export interface EvaluationReport {
  suiteId: string;
  suiteName: string;
  workflow: string;
  generatedAt: string;
  rows: EvaluationResultRow[];
  variants: EvaluationVariantSummary[];
  winner: string | null;
  scoringProfile: { id: string; checksum: string } | null;
}

export function buildEvaluationReport(
  suite: EvaluationSuite,
  observations: EvaluationObservation[],
  scoring?: { profile: EvaluationScoringProfile; checksum: string }
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
    const summary: EvaluationVariantSummary = {
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
      feedbackCounts: countBy(selected.filter((row) => row.feedbackRating !== null), (row) => row.feedbackRating ?? "none"),
      privateScore: null
    };
    summary.privateScore = scoring ? scoreEvaluationVariant(summary, scoring.profile, selected) : null;
    return summary;
  }).sort((a, b) =>
    (scoring ? (b.privateScore ?? -Infinity) - (a.privateScore ?? -Infinity) : 0) ||
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
    winner: variants[0]?.variantId ?? null,
    scoringProfile: scoring ? { id: scoring.profile.id, checksum: scoring.checksum } : null
  };
}

export function scoreEvaluationVariant(summary: EvaluationVariantSummary, profile: EvaluationScoringProfile, rows: EvaluationResultRow[] = []): number {
  const weighted = rows.map((row) => ({ row, weight: profile.case_weights[row.caseId] ?? 1 }));
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  const weightedRate = (select: (row: EvaluationResultRow) => number): number =>
    weighted.reduce((sum, item) => sum + select(item.row) * item.weight, 0) / Math.max(1, totalWeight);
  const passRate = rows.length ? weightedRate((row) => Number(row.passed)) : summary.passRate;
  const quality = rows.length ? weightedRate((row) => row.averageQuality ?? 0) : summary.averageQuality ?? 0;
  const latencyMs = rows.length ? weightedRate((row) => row.totalLatencyMs) : summary.averageLatencyMs ?? profile.latency_budget_ms;
  const fallbackRate = rows.length ? weightedRate((row) => row.fallbackCount) : summary.fallbackRate;
  const feedbackRate = (rating: string): number => rows.length
    ? weightedRate((row) => Number(row.feedbackRating === rating))
    : (summary.feedbackCounts[rating] ?? 0) / Math.max(1, Object.values(summary.feedbackCounts).reduce((sum, count) => sum + count, 0));
  const latencyScore = Math.max(0, 1 - latencyMs / profile.latency_budget_ms);
  const value =
    passRate * profile.weights.pass_rate +
    quality * profile.weights.quality +
    latencyScore * profile.weights.latency +
    fallbackRate * profile.weights.fallback_rate +
    feedbackRate("accepted") * profile.weights.accepted_feedback_rate +
    feedbackRate("revised") * profile.weights.revised_feedback_rate +
    feedbackRate("rejected") * profile.weights.rejected_feedback_rate;
  return round(value);
}

export function formatEvaluationReport(report: EvaluationReport): string {
  return [
    `# Evaluation: ${report.suiteName}`,
    "",
    `- Suite: ${report.suiteId}`,
    `- Workflow: ${report.workflow}`,
    `- Generated: ${report.generatedAt}`,
    `- Winner: ${report.winner ?? "none"}`,
    `- Scoring: ${report.scoringProfile ? `${report.scoringProfile.id} (${report.scoringProfile.checksum})` : "shared default ranking"}`,
    "",
    "## Variant comparison",
    "",
    "| Variant | Provider | Tier | Score | Pass rate | Quality | Avg latency | Fallbacks/run | Feedback |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.variants.map((variant) =>
      `| ${variant.variantId} | ${variant.provider} | ${variant.modelTier} | ${variant.privateScore ?? "default"} | ${variant.passRate} | ${variant.averageQuality ?? "n/a"} | ${variant.averageLatencyMs ?? "n/a"}ms | ${variant.fallbackRate} | ${formatCounts(variant.feedbackCounts)} |`
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
