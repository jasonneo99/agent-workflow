import fs from "node:fs/promises";
import path from "node:path";
import { adversarialSuiteSchema, adversarialThreatClasses } from "../packages/guarded-autonomy/src/index.js";
import { reliabilityBaselineSchema, reliabilityMetricKinds } from "../packages/reliability-suite/src/index.js";

const root = process.cwd();
const baseline = reliabilityBaselineSchema.parse(JSON.parse(await fs.readFile(path.join(root, "evals/reliability-suite/baseline.v1.json"), "utf8")));
const adversarial = adversarialSuiteSchema.parse(JSON.parse(await fs.readFile(path.join(root, "evals/reliability-suite/adversarial.v1.json"), "utf8")));
const failures: string[] = [];

if (!baseline.frozen) failures.push("baseline is not frozen");
if (baseline.results.length !== 7) failures.push("baseline must contain all seven representative workflows");
if (baseline.results.some((item) => item.outcome !== "passed")) failures.push("every baseline workflow must pass");
for (const metric of reliabilityMetricKinds) {
  if ((baseline.summary.metric_coverage[metric]?.unavailable ?? 0) > 0) failures.push(`${metric} has unavailable baseline coverage`);
}
if (new Set(adversarial.cases.map((item) => item.threat_class)).size !== adversarialThreatClasses.length) failures.push("adversarial threat coverage is incomplete");
if (adversarial.cases.some((item) => item.network_allowed)) failures.push("adversarial case permits network access");

if (failures.length) {
  console.error(`Reliability release gate failed:\n- ${failures.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log(`Reliability release gate passed: ${baseline.results.length} workflows, ${adversarial.cases.length} adversarial cases, frozen baseline ${baseline.manifest_sha256}.`);
}
