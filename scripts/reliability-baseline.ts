import fs from "node:fs/promises";
import path from "node:path";
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
const results: ReliabilityCaseResult[] = manifest.cases.map((item) => ({
  case_id: item.id,
  outcome: "not_run",
  metrics: reliabilityMetricKinds.map((metric) => ({
    metric,
    coverage: "unavailable",
    reason: "Frozen pre-execution baseline; no live model or workflow call was made."
  })),
  check_results: []
}));
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
