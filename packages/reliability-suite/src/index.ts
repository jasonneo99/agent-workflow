import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const reliabilityWorkflowKinds = [
  "feature-delivery",
  "debugging",
  "pr-review",
  "incident-response",
  "release-readiness",
  "context-handoff",
  "maintenance"
] as const;

export const reliabilityMetricKinds = [
  "outcome_correctness",
  "verification_coverage",
  "human_review_burden",
  "recovery_success",
  "rollback_success",
  "policy_interventions",
  "breaker_interventions",
  "unsafe_action_attempts",
  "cost",
  "latency",
  "context_size",
  "fallback_rate",
  "confidence_calibration",
  "authority_calibration"
] as const;

const reliabilityCheckSchema = z.object({
  id: z.string().min(1),
  visibility: z.enum(["public", "hidden"]),
  evaluator: z.string().min(1),
  evaluator_version: z.string().min(1)
});

const reliabilityCaseSchema = z.object({
  id: z.string().min(1),
  workflow_kind: z.enum(reliabilityWorkflowKinds),
  workflow: z.string().min(1),
  fixture: z.object({
    kind: z.enum(["synthetic", "public"]),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }),
  checks: z.array(reliabilityCheckSchema).min(1)
});

export const reliabilitySuiteManifestSchema = z.object({
  schema_version: z.literal(1),
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  local_only: z.literal(true),
  private_case_bodies_stored: z.literal(false),
  cases: z.array(reliabilityCaseSchema).min(reliabilityWorkflowKinds.length),
  required_metrics: z.array(z.enum(reliabilityMetricKinds))
}).superRefine((manifest, context) => {
  const caseIds = new Set<string>();
  const coveredKinds = new Set<string>();
  for (const item of manifest.cases) {
    if (caseIds.has(item.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: `Duplicate case id: ${item.id}` });
    }
    caseIds.add(item.id);
    coveredKinds.add(item.workflow_kind);
  }
  for (const kind of reliabilityWorkflowKinds) {
    if (!coveredKinds.has(kind)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: `Missing workflow kind: ${kind}` });
    }
  }
  const metricKinds = new Set(manifest.required_metrics);
  for (const metric of reliabilityMetricKinds) {
    if (!metricKinds.has(metric)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["required_metrics"], message: `Missing required metric: ${metric}` });
    }
  }
});

export const reliabilityMetricObservationSchema = z.object({
  metric: z.enum(reliabilityMetricKinds),
  coverage: z.enum(["measured", "partial", "unavailable"]),
  value: z.number().finite().optional(),
  unit: z.string().min(1).optional(),
  reason: z.string().min(1).optional()
}).superRefine((observation, context) => {
  if (observation.coverage === "measured" && observation.value === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Measured metrics require a value." });
  }
  if (observation.coverage !== "measured" && !observation.reason) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "Partial and unavailable metrics require a reason." });
  }
  if (observation.coverage === "unavailable" && observation.value !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "Unavailable metrics cannot carry a value." });
  }
});

export const reliabilityCaseResultSchema = z.object({
  case_id: z.string().min(1),
  outcome: z.enum(["passed", "failed", "blocked", "not_run"]),
  execution: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    evaluator_version: z.string().min(1),
    evaluator_bundle_hash: z.string().regex(/^[a-f0-9]{64}$/u),
    latency_ms: z.number().nonnegative(),
    estimated_cost_usd: z.number().nonnegative(),
    fallback_count: z.number().int().nonnegative()
  }).optional(),
  metrics: z.array(reliabilityMetricObservationSchema),
  check_results: z.array(z.object({
    check_id: z.string().min(1),
    passed: z.boolean(),
    details: z.string().optional()
  })).default([])
});

export const reliabilityBaselineSchema = z.object({
  schema_version: z.literal(1),
  suite_id: z.string().min(1),
  suite_version: z.string().min(1),
  manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  frozen: z.literal(true),
  generated_by: z.string().min(1),
  generated_at: z.string().datetime(),
  results: z.array(reliabilityCaseResultSchema),
  summary: z.object({
    cases: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    not_run: z.number().int().nonnegative(),
    metric_coverage: z.record(z.object({
      measured: z.number().int().nonnegative(),
      partial: z.number().int().nonnegative(),
      unavailable: z.number().int().nonnegative()
    }))
  })
});

export type ReliabilitySuiteManifest = z.infer<typeof reliabilitySuiteManifestSchema>;
export type ReliabilityCaseResult = z.infer<typeof reliabilityCaseResultSchema>;
export type ReliabilityBaseline = z.infer<typeof reliabilityBaselineSchema>;

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export async function validateReliabilityManifestFiles(
  repositoryRoot: string,
  manifestInput: unknown
): Promise<ReliabilitySuiteManifest> {
  const manifest = reliabilitySuiteManifestSchema.parse(manifestInput);
  const root = path.resolve(repositoryRoot);
  for (const item of manifest.cases) {
    const fixturePath = path.resolve(root, item.fixture.path);
    if (fixturePath !== root && !fixturePath.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Reliability fixture escapes repository root: ${item.fixture.path}`);
    }
    const contents = await fs.readFile(fixturePath);
    const actualHash = createHash("sha256").update(contents).digest("hex");
    if (actualHash !== item.fixture.sha256) {
      throw new Error(`Reliability fixture hash mismatch: ${item.fixture.path}`);
    }
  }
  return manifest;
}

export function buildFrozenReliabilityBaseline(input: {
  manifest: ReliabilitySuiteManifest;
  results: ReliabilityCaseResult[];
  generatedAt: string;
  generatedBy: string;
}): ReliabilityBaseline {
  const manifest = reliabilitySuiteManifestSchema.parse(input.manifest);
  const parsedResults = input.results.map((result) => reliabilityCaseResultSchema.parse(result));
  const knownCases = new Set(manifest.cases.map((item) => item.id));
  const resultIds = new Set<string>();
  for (const result of parsedResults) {
    if (!knownCases.has(result.case_id)) throw new Error(`Unknown reliability case: ${result.case_id}`);
    if (resultIds.has(result.case_id)) throw new Error(`Duplicate reliability result: ${result.case_id}`);
    resultIds.add(result.case_id);
  }
  for (const item of manifest.cases) {
    if (!resultIds.has(item.id)) throw new Error(`Missing reliability result: ${item.id}`);
  }

  const metricCoverage = Object.fromEntries(reliabilityMetricKinds.map((metric) => [metric, {
    measured: 0,
    partial: 0,
    unavailable: 0
  }]));
  for (const result of parsedResults) {
    const seen = new Set<string>();
    for (const observation of result.metrics) {
      if (seen.has(observation.metric)) throw new Error(`Duplicate ${observation.metric} metric for ${result.case_id}`);
      seen.add(observation.metric);
      metricCoverage[observation.metric][observation.coverage] += 1;
    }
    for (const metric of manifest.required_metrics) {
      if (!seen.has(metric)) throw new Error(`Missing ${metric} metric for ${result.case_id}`);
    }
  }

  return reliabilityBaselineSchema.parse({
    schema_version: 1,
    suite_id: manifest.id,
    suite_version: manifest.version,
    manifest_sha256: canonicalSha256(manifest),
    frozen: true,
    generated_by: input.generatedBy,
    generated_at: input.generatedAt,
    results: parsedResults,
    summary: {
      cases: parsedResults.length,
      passed: parsedResults.filter((item) => item.outcome === "passed").length,
      failed: parsedResults.filter((item) => item.outcome === "failed").length,
      blocked: parsedResults.filter((item) => item.outcome === "blocked").length,
      not_run: parsedResults.filter((item) => item.outcome === "not_run").length,
      metric_coverage: metricCoverage
    }
  });
}

export function scrubReliabilityBaseline(baseline: ReliabilityBaseline): object {
  const parsed = reliabilityBaselineSchema.parse(baseline);
  return {
    schema_version: parsed.schema_version,
    suite_id: parsed.suite_id,
    suite_version: parsed.suite_version,
    manifest_sha256: parsed.manifest_sha256,
    frozen: parsed.frozen,
    generated_at: parsed.generated_at,
    summary: parsed.summary
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
