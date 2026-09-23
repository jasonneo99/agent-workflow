import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildFrozenReliabilityBaseline,
  canonicalSha256,
  reliabilityMetricKinds,
  reliabilityMetricObservationSchema,
  reliabilityBaselineSchema,
  reliabilitySuiteManifestSchema,
  reliabilityWorkflowKinds,
  scrubReliabilityBaseline,
  validateReliabilityManifestFiles,
  type ReliabilityCaseResult
} from "./index.js";

const manifest = reliabilitySuiteManifestSchema.parse({
  schema_version: 1,
  id: "agent-workflow-reliability-v1",
  version: "1.0.0",
  description: "Synthetic local reliability baseline",
  local_only: true,
  private_case_bodies_stored: false,
  cases: reliabilityWorkflowKinds.map((kind) => ({
    id: `${kind}-synthetic`,
    workflow_kind: kind,
    workflow: kind,
    fixture: { kind: "synthetic", path: `evals/reliability-suite/fixtures/${kind}.json`, sha256: "a".repeat(64) },
    checks: [{ id: `${kind}-outcome`, visibility: "hidden", evaluator: "deterministic", evaluator_version: "1" }]
  })),
  required_metrics: reliabilityMetricKinds
});

function result(caseId: string): ReliabilityCaseResult {
  return {
    case_id: caseId,
    outcome: "not_run",
    metrics: reliabilityMetricKinds.map((metric) => ({ metric, coverage: "unavailable", reason: "Frozen pre-execution baseline." })),
    check_results: []
  };
}

test("manifest requires all representative workflow kinds", () => {
  const incomplete = { ...manifest, cases: manifest.cases.slice(1) };
  assert.equal(reliabilitySuiteManifestSchema.safeParse(incomplete).success, false);
});

test("unavailable metrics cannot masquerade as zero", () => {
  assert.equal(reliabilityMetricObservationSchema.safeParse({ metric: "cost", coverage: "unavailable", value: 0, reason: "missing" }).success, false);
  assert.equal(reliabilityMetricObservationSchema.safeParse({ metric: "cost", coverage: "unavailable" }).success, false);
});

test("frozen baseline is complete, reproducible, and scrubbed", () => {
  const results = manifest.cases.map((item) => result(item.id));
  const baseline = buildFrozenReliabilityBaseline({
    manifest,
    results,
    generatedAt: "2026-09-23T00:00:00.000Z",
    generatedBy: "agent-workflow-reliability-suite/1"
  });
  assert.equal(baseline.summary.cases, 7);
  assert.equal(baseline.summary.not_run, 7);
  assert.equal(baseline.manifest_sha256, canonicalSha256(manifest));
  const scrubbed = scrubReliabilityBaseline(baseline) as Record<string, unknown>;
  assert.equal("results" in scrubbed, false);
  assert.equal("generated_by" in scrubbed, false);
});

test("baseline rejects missing case results", () => {
  assert.throws(() => buildFrozenReliabilityBaseline({
    manifest,
    results: manifest.cases.slice(1).map((item) => result(item.id)),
    generatedAt: "2026-09-23T00:00:00.000Z",
    generatedBy: "test"
  }), /Missing reliability result/u);
});

test("committed manifest covers all workflows and binds fixture contents", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const value = JSON.parse(await fs.readFile(path.join(repositoryRoot, "evals/reliability-suite/manifest.v1.json"), "utf8"));
  const committed = await validateReliabilityManifestFiles(repositoryRoot, value);
  assert.deepEqual(new Set(committed.cases.map((item) => item.workflow_kind)), new Set(reliabilityWorkflowKinds));
});

test("committed frozen baseline matches the manifest and public snapshot is aggregate-only", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const committedManifest = reliabilitySuiteManifestSchema.parse(JSON.parse(await fs.readFile(path.join(repositoryRoot, "evals/reliability-suite/manifest.v1.json"), "utf8")));
  const baseline = reliabilityBaselineSchema.parse(JSON.parse(await fs.readFile(path.join(repositoryRoot, "evals/reliability-suite/baseline.v1.json"), "utf8")));
  const publicBaseline = JSON.parse(await fs.readFile(path.join(repositoryRoot, "evals/reliability-suite/baseline.public.v1.json"), "utf8")) as Record<string, unknown>;
  assert.equal(baseline.manifest_sha256, canonicalSha256(committedManifest));
  assert.equal(baseline.summary.cases, reliabilityWorkflowKinds.length);
  assert.equal(baseline.summary.not_run, reliabilityWorkflowKinds.length);
  assert.equal("results" in publicBaseline, false);
  assert.deepEqual(publicBaseline, scrubReliabilityBaseline(baseline));
});
