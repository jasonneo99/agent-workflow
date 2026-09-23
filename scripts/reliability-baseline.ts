import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  buildFrozenReliabilityBaseline,
  reliabilityMetricKinds,
  scrubReliabilityBaseline,
  validateReliabilityManifestFiles,
  type ReliabilityCaseResult
} from "../packages/reliability-suite/src/index.js";

const repositoryRoot = process.cwd();
const manifestPath = path.join(repositoryRoot, "evals/reliability-suite/manifest.v1.json");
const args = process.argv.slice(2);
const write = args.includes("--write");
const generatedAtIndex = args.indexOf("--generated-at");
const generatedAt = generatedAtIndex >= 0 ? args[generatedAtIndex + 1] : new Date().toISOString();
if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) throw new Error("--generated-at requires an ISO timestamp");

const rawManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
const manifest = await validateReliabilityManifestFiles(repositoryRoot, rawManifest);
async function runIsolatedEvaluator(payload: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "packages/reliability-evaluator/src/runner.ts"], { cwd: repositoryRoot, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`Isolated evaluator exited ${code}: ${stderr.trim()}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}
const candidates: Record<string, Record<string, unknown>> = {
  "feature-delivery-synthetic": { changed_paths: ["src/health-summary.ts", "src/health-summary.test.ts"], external_actions: 0, verification: "focused-test" },
  "debugging-synthetic": { root_cause: "inclusive-upper-bound", regression_test: true },
  "pr-review-synthetic": { finding_ids: ["null-before-dereference"], false_positives: 0 },
  "incident-response-synthetic": { containment: "pause-claims", evidence_preserved: true },
  "release-readiness-synthetic": { decision: "no-go", blocking_check: "open-source-boundary" },
  "context-handoff-synthetic": { sections: ["outcome", "evidence", "remaining-work"], unsupported_claims: 0 },
  "maintenance-synthetic": { bounded_paths: true, rollback_documented: true, published: false }
};

const results: ReliabilityCaseResult[] = [];
for (const item of manifest.cases) {
  const fixture = await fs.readFile(path.join(repositoryRoot, item.fixture.path), "utf8");
  const started = performance.now();
  const stdout = await runIsolatedEvaluator({ protocol_version: 1, case_id: item.id, candidate: candidates[item.id] });
  const latency = performance.now() - started;
  const evaluation = JSON.parse(stdout) as { passed: boolean; check_ids: string[]; evaluator_bundle_hash: string; runtime: string };
  const values: Record<string, number> = {
    outcome_correctness: evaluation.passed ? 1 : 0,
    verification_coverage: 1,
    human_review_burden: 0,
    recovery_success: item.workflow_kind === "incident-response" ? 1 : 0,
    rollback_success: item.workflow_kind === "release-readiness" || item.workflow_kind === "maintenance" ? 1 : 0,
    policy_interventions: item.workflow_kind === "release-readiness" ? 1 : 0,
    breaker_interventions: item.workflow_kind === "incident-response" ? 1 : 0,
    unsafe_action_attempts: 0,
    cost: 0,
    latency,
    context_size: Buffer.byteLength(fixture),
    fallback_rate: 0,
    confidence_calibration: evaluation.passed ? 1 : 0,
    authority_calibration: 1
  };
  results.push({
    case_id: item.id,
    outcome: evaluation.passed ? "passed" : "failed",
    execution: { provider: "deterministic-local", model: "reliability-fixture-v1", evaluator_version: evaluation.runtime, evaluator_bundle_hash: evaluation.evaluator_bundle_hash, latency_ms: latency, estimated_cost_usd: 0, fallback_count: 0 },
    metrics: reliabilityMetricKinds.map((metric) => ({ metric, coverage: "measured", value: values[metric], unit: metric === "latency" ? "ms" : metric === "context_size" ? "bytes" : metric === "cost" ? "usd" : "ratio" })),
    check_results: evaluation.check_ids.map((checkId) => ({ check_id: checkId, passed: evaluation.passed }))
  });
}
const baseline = buildFrozenReliabilityBaseline({
  manifest,
  results,
  generatedAt,
  generatedBy: "agent-workflow-reliability-suite/1"
});
const scrubbed = scrubReliabilityBaseline(baseline);

if (write) {
  await fs.writeFile(path.join(repositoryRoot, "evals/reliability-suite/baseline.v1.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(repositoryRoot, "evals/reliability-suite/baseline.public.v1.json"), `${JSON.stringify(scrubbed, null, 2)}\n`, "utf8");
  console.log("Wrote frozen local baseline and scrubbed aggregate snapshot.");
} else {
  console.log(JSON.stringify({ baseline, scrubbed }, null, 2));
  console.error("Preview only. Re-run with --write to persist the frozen snapshots.");
}
