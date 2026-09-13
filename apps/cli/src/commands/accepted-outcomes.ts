import path from "node:path";
import type { Command } from "commander";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { buildAcceptedWorkflowOutcomeReport, buildCostQualityReport } from "../../../../packages/run-reporter/src/index.js";
import { getWorkflowRunDetails, listArtifacts, listWorkflowRunsForProject } from "../../../../packages/storage/src/postgres.js";

export function registerAcceptedOutcomeCommands(program: Command): void {
  program
    .command("accepted-outcomes")
    .description("Report measured cost and frontier input tokens per accepted workflow")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--limit <number>", "recent workflow runs to inspect", "100")
    .option("--json", "print JSON")
    .action(async (options: { project: string; limit: string; json?: boolean }) => {
      const projectRoot = path.resolve(process.cwd(), options.project);
      await loadProjectConfig(projectRoot);
      const limit = Math.max(1, Math.min(1000, Number.parseInt(options.limit, 10) || 100));
      const runs = await listWorkflowRunsForProject({ projectRootUri: projectRoot, limit });
      const outcomes = [];
      for (const run of runs) {
        const details = await getWorkflowRunDetails(run.id);
        if (!details.run) continue;
        const artifacts = await listArtifacts({ runId: run.id });
        const report = buildCostQualityReport({ run: details.run, tasks: details.tasks, receipts: details.receipts, artifacts });
        if (report.outcome) outcomes.push({ runId: run.id, workflowId: run.workflowId, ...report.outcome });
      }
      const summary = buildAcceptedWorkflowOutcomeReport(outcomes);
      const result = { project: path.basename(projectRoot), runsInspected: runs.length, ...summary, outcomes: outcomes.filter((item) => item.accepted) };
      console.log(options.json ? JSON.stringify(result, null, 2) : [
        `Accepted workflow outcomes for ${result.project}`,
        `Accepted: ${result.acceptedWorkflows}; measured: ${result.measuredAcceptedWorkflows}`,
        `Frontier input tokens: ${result.totalFrontierInputTokens} total; ${result.averageFrontierInputTokensPerAcceptedWorkflow ?? "unavailable"} average per measured accepted workflow`,
        `Measured cost: ${result.totalMeasuredCostUsd === null ? "unavailable" : `$${result.totalMeasuredCostUsd.toFixed(6)} total`}`
      ].join("\n"));
    });
}
