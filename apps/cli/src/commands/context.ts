import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import YAML from "yaml";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { buildSegmentedThresholdQueue, proposeContextThresholds, readLatestCalibration, repositoryHoldoutCorpusSchema, runRepositoryCalibration, writeCalibrationEvidence, writeSegmentedThresholdQueue } from "../../../../packages/context-calibration/src/index.js";
import { assertContextProjectPath, buildContextEfficiencyReport, contextRoutingPolicySchema, readShadowObservations, type ContextRoutingPolicy } from "../../../../packages/context-gateway/src/index.js";
import { findAgentWorkflowRoot } from "../../../../packages/runtime-root/src/index.js";
import { upsertProject } from "../../../../packages/storage/src/postgres.js";

export function registerContextCommands(program: Command): void {
  program.command("context-report").description("Report privacy-safe Context Gateway shadow evidence for a project")
    .requiredOption("-p, --project <dir>", "project directory").option("--json", "print JSON")
    .action(async (options: { project: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const project = await loadProjectConfig(projectDir);
      const projectId = await upsertProject({ name: project.project.name, rootUri: projectDir, profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom", config: project });
      const report = buildContextEfficiencyReport(await readShadowObservations({ projectRoot: projectDir, projectId }));
      if (options.json) console.log(JSON.stringify({ projectId, mode: "shadow", ...report }, null, 2));
      else console.log([`Context Gateway shadow report for ${project.project.name}`, `Observations: ${report.observations}; eligible reads: ${report.eligibleReads}`, `Estimated input tokens: ${report.totalEstimatedTokens}`, `Projected avoided frontier tokens: ${report.projectedFrontierTokensAvoided} (${report.projectedSavingsPercent}%)`, `Routes: direct=${report.routes.direct}, deterministic=${report.routes.deterministic}, delegate=${report.routes.delegate}, frontier=${report.routes.frontier}`, "Projection only: enforcement remains disabled until approved holdout evidence passes."].join("\n"));
    });

  program.command("context-calibrate").description("Run a versioned repository holdout and record regression-aware calibration evidence")
    .requiredOption("-p, --project <dir>", "project directory").option("--corpus <path>", "versioned holdout corpus", "evals/context-gateway-holdout.json").option("--json", "print JSON")
    .action(async (options: { project: string; corpus: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      await loadProjectConfig(projectDir);
      const corpusPath = path.isAbsolute(options.corpus) ? options.corpus : path.resolve(projectDir, options.corpus);
      await assertContextProjectPath(projectDir, corpusPath);
      const corpusRaw = await fs.readFile(corpusPath, "utf8");
      const corpus = repositoryHoldoutCorpusSchema.parse(JSON.parse(corpusRaw));
      const policy = await loadPolicy(projectDir);
      const calibration = await runRepositoryCalibration({ projectRoot: projectDir, corpus, corpusRaw, policy, baseline: await readLatestCalibration(projectDir) });
      const proposal = proposeContextThresholds(calibration.report, policy);
      const evidence = await writeCalibrationEvidence({ projectRoot: projectDir, report: calibration.report, cases: calibration.cases, proposal });
      const segmented = buildSegmentedThresholdQueue({ projectIdentity: projectDir, cases: calibration.cases, policy });
      const thresholdQueue = await writeSegmentedThresholdQueue(projectDir, segmented);
      const report = { ...calibration.report, proposal, segmentedProposalCount: segmented.proposals.length, thresholdQueue: path.relative(projectDir, thresholdQueue), evidence: path.relative(projectDir, evidence) };
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else console.log([`Context calibration: ${report.corpus} (${report.cases} cases)`, `Quality: ${(report.qualityPassRate * 100).toFixed(1)}%; citations: ${(report.citationPassRate * 100).toFixed(1)}%`, `Token savings: ${report.tokenSavingsPercent}%; p95 added latency: ${report.p95AddedLatencyMs}ms`, `Regression gate: ${report.regression.passed ? "pass" : "fail"}; enforcement ready: ${report.enforcementReady ? "yes" : "no"}`, `Threshold proposals: ${report.proposal.changes.length} (review required; policy unchanged)`, `Segmented proposals: ${report.segmentedProposalCount} (review queue: ${report.thresholdQueue})`, `Evidence: ${report.evidence}`].join("\n"));
      if (!report.enforcementReady) process.exitCode = 1;
    });
}

async function loadPolicy(projectDir: string): Promise<ContextRoutingPolicy> {
  const localPath = path.join(projectDir, ".agent-workflow", "context-routing.yaml");
  try { return contextRoutingPolicySchema.parse(YAML.parse(await fs.readFile(localPath, "utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return contextRoutingPolicySchema.parse(YAML.parse(await fs.readFile(path.join(findAgentWorkflowRoot(import.meta.url), "policies", "context-routing.yaml"), "utf8")));
}
