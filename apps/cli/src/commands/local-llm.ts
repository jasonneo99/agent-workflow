import type { CliContext } from "../lib/context.js";
import type { Command } from "commander";
import type { LocalLlmRoutingNoteApplicationPlan } from "../lib/cli-types.js";
import { buildDashboardLocalProviderEvidence, buildDashboardRouteReceiptTrends, buildLocalLlmDownloadRecommendationReport, buildLocalLlmPrunePlanReport, buildLocalLlmSmokeOutcomeTrend, loadCostQualityReportsForDashboardRuns, loadDashboardCandidateComparisonReport, loadDashboardLocalHoldoutRoutingStatus, loadLocalLlmRoutingRecommendationReport, loadLocalLlmSetupChecklistReport, loadLocalLlmSetupGuideReport, loadPreferenceScorecard, parseModelTierOption, parseProposalIds, recordTuningHistory, writeCandidateComparisonPlan, writeLocalLlmRoutingRecommendationReport } from "../lib/builders-learning.js";
import { buildLocalHoldoutResultSummary, buildLocalHoldoutRoutingPromotion, buildLocalLlmRoutingNoteApplicationPlan, buildLocalLlmRoutingNotePlan, emptyLocalHoldoutResultSummary, formatLocalHoldoutResultSummary, formatLocalHoldoutRoutingPromotion, formatLocalLlmBenchmarkReceiptReport, formatLocalLlmCacheTrendReport, formatLocalLlmCostLedgerReport, formatLocalLlmDownloadRecommendationReport, formatLocalLlmInstallationPlanReport, formatLocalLlmInventoryReport, formatLocalLlmPrunePlanReport, formatLocalLlmRouteSmokeResult, formatLocalLlmRoutingDecisionSnapshotReport, formatLocalLlmRoutingNoteApplicationPlan, formatLocalLlmRoutingNotePlan, formatLocalLlmRoutingRecommendationReport, formatLocalLlmSetupChecklistReport, formatLocalLlmSetupGuideReport, formatRouteDecisionFeedbackResult, loadLocalHoldoutModelPlan, loadLocalLlmBenchmarkReceiptReport, loadLocalLlmCacheTrendReport, loadLocalLlmCostLedgerReport, loadLocalLlmInstallationPlanReport, loadLocalLlmInventoryReport, loadLocalLlmRoutingDecisionSnapshotReport, readLocalHoldoutResultSummary, readLocalLlmRoutingNotePlan, recordRouteDecisionFeedback, runLocalLlmRouteSmoke, writeLocalHoldoutResultSummary, writeLocalHoldoutRoutingPromotion, writeLocalLlmBenchmarkReceiptReport, writeLocalLlmDownloadRecommendationReport, writeLocalLlmInstallationPlanReport, writeLocalLlmInventoryReport, writeLocalLlmPrunePlanReport, writeLocalLlmRoutingNotePlan, writeLocalLlmSetupGuideReport } from "../lib/builders-local-llm.js";
import { type CandidateVariantPlan, buildCandidateComparisonPlan, formatCandidateComparisonPlan } from "../../../../packages/run-reporter/src/index.js";
import { listWorkflowRunsForProject } from "../../../../packages/storage/src/postgres.js";
import { parseNonNegativeInteger, parseOptionalNumber, parsePositiveInteger } from "../numeric-options.js";
import { normalizeProviderRef } from "../reference-resolution.js";
import fs from "node:fs/promises";
import path from "node:path";

export function registerLocalLlmCommands(program: Command, ctx: CliContext): void {
  async function writeLocalLlmRoutingNoteApplicationPlan(projectDir: string, plan: LocalLlmRoutingNoteApplicationPlan): Promise<void> {
    const projectRoot = path.resolve(projectDir);
    for (const file of plan.files) {
      const allowed =
        file.relativePath === ".agent-workflow/tuning/routing-preferences.md" ||
        file.relativePath === ".agent-workflow/tuning/local-routing-note-application.md" ||
        file.relativePath === ".agent-workflow/tuning/local-routing-note-application.json";
      if (!allowed) {
        throw new Error(`Refusing to write local LLM routing note application outside approved tuning files: ${file.relativePath}`);
      }
      const targetPath = path.resolve(projectRoot, file.relativePath);
      if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
        throw new Error(`Refusing to write local LLM routing note application outside project: ${file.relativePath}`);
      }
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, file.content, "utf8");
    }
  }

  program
    .command("local-holdout-comparison")
    .description("Prepare a local-LLM versus hosted-provider holdout comparison plan for safe routing promotion")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--hosted-provider <provider>", "hosted baseline provider id", "openai")
    .option("--local-provider <provider>", "local candidate provider id", "local")
    .option("--hosted-tier <tier>", "fast, standard, or reasoning", "standard")
    .option("--local-tier <tier>", "fast, standard, or reasoning", "fast")
    .option("--hosted-prompt <text>", "hosted baseline prompt suffix")
    .option("--local-prompt <text>", "local candidate prompt suffix")
    .option("--write", "write plan and private evaluation suite files into the project")
    .option("--json", "print local holdout comparison plan JSON")
    .action(async (options: {
      project: string;
      hostedProvider: string;
      localProvider: string;
      hostedTier: string;
      localTier: string;
      hostedPrompt?: string;
      localPrompt?: string;
      write?: boolean;
      json?: boolean;
    }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const { modelPlan, source } = await loadLocalHoldoutModelPlan(projectDir, Boolean(options.write));
      const baseline: Partial<CandidateVariantPlan> = {
        provider: normalizeProviderRef(options.hostedProvider),
        modelTier: parseModelTierOption(options.hostedTier),
        promptSuffix: options.hostedPrompt ?? "Use the hosted baseline provider with current project-local Agent Workflow instructions."
      };
      const candidate: Partial<CandidateVariantPlan> = {
        provider: normalizeProviderRef(options.localProvider),
        modelTier: parseModelTierOption(options.localTier),
        promptSuffix: options.localPrompt ?? "Use the local LLM candidate only for low-risk developer work, preserving evidence, brevity, and safety boundaries."
      };
      const plan = buildCandidateComparisonPlan({ modelPlan, baseline, candidate });

      if (options.write) {
        await writeCandidateComparisonPlan(projectDir, plan);
      }

      const localHoldout = {
        kind: "agentflow_local_holdout_comparison",
        mode: options.write ? "write" : "dry-run",
        purpose: "Compare a local LLM candidate against a hosted baseline before raising local routing risk thresholds.",
        source,
        providerPair: {
          hosted: plan.baseline,
          local: plan.candidate
        },
        promotionBoundary: {
          defaultScope: "low-risk read-only developer stages",
          requiresEvidence: ["suite pass", "quality gate", "fallback rate", "latency", "avoided hosted calls", "project owner review"],
          blockedUses: ["authorization decisions", "approval bypass", "command policy", "secret handling", "production deployment"]
        },
        plan
      };

      if (options.json) {
        console.log(JSON.stringify(localHoldout, null, 2));
        return;
      }

      console.log("Local LLM Holdout Comparison");
      console.log(`Project: ${projectDir}`);
      console.log(`Mode: ${localHoldout.mode}`);
      console.log(`Source: ${source}`);
      console.log(`Hosted baseline: ${plan.baseline.provider}/${plan.baseline.modelTier}`);
      console.log(`Local candidate: ${plan.candidate.provider}/${plan.candidate.modelTier}`);
      console.log(`Suites: ${plan.suites.length}`);
      console.log("");
      console.log(formatCandidateComparisonPlan(plan));
      console.log("");
      console.log("Promotion boundary:");
      console.log("- Start with low-risk read-only developer stages.");
      console.log("- Do not use local model output to bypass authorization, approval, command policy, or production gates.");
      console.log("- Promote only after suite, quality, latency, fallback, and avoided-cost evidence is reviewed.");
      if (options.write) {
        for (const file of plan.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create project-local local-vs-hosted comparison files.");
      }
    });

  program
    .command("local-holdout-results")
    .description("Capture current local-LLM versus hosted-provider holdout outcomes as project-local promotion evidence")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--write", "write result summary files into the project")
    .option("--json", "print local holdout result summary JSON")
    .action(async (options: { project: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadDashboardCandidateComparisonReport({ projectDir });
      const result = buildLocalHoldoutResultSummary(report);
      if (options.write) {
        await writeLocalHoldoutResultSummary(projectDir, result);
      }
      if (options.json) {
        console.log(JSON.stringify({ ...result, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }
      console.log(formatLocalHoldoutResultSummary(result));
      if (options.write) {
        for (const file of result.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to persist local holdout result evidence.");
      }
    });

  program
    .command("local-holdout-promote")
    .description("Approve local LLM routing for low-risk project-local stages from captured holdout evidence")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--approved", "confirm owner approval for the project-local routing preference")
    .option("--write", "write reviewed project-local routing preference files")
    .option("--json", "print promotion plan JSON")
    .action(async (options: { project: string; approved?: boolean; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const results = await readLocalHoldoutResultSummary(projectDir).catch(() => emptyLocalHoldoutResultSummary(projectDir, "Capture local holdout results before promoting local routing."));
      const promotion = buildLocalHoldoutRoutingPromotion(projectDir, results, Boolean(options.approved));
      if (options.write) {
        if (promotion.status !== "ready") {
          console.error(promotion.reason);
          process.exitCode = 1;
        } else {
          await writeLocalHoldoutRoutingPromotion(projectDir, promotion);
        }
      }
      if (options.json) {
        console.log(JSON.stringify({ ...promotion, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }
      console.log(formatLocalHoldoutRoutingPromotion(promotion));
      if (options.write && promotion.status === "ready") {
        for (const file of promotion.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else if (!options.write) {
        console.log("");
        console.log("Dry run only. Re-run with --approved --write to persist the reviewed project-local routing preference.");
      }
    });

  program
    .command("local-llm-checklist")
    .description("Check local LLM setup, catalog selection, and first low-risk route receipt")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--json", "print local LLM checklist JSON")
    .action(async (options: { project: string; limit: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const scorecard = await loadPreferenceScorecard({ projectDir, limit: parsePositiveInteger(options.limit, 50) });
      const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: parsePositiveInteger(options.limit, 50) });
      const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
      const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
      const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(projectDir, localProviderEvidence);
      const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
      const smokeOutcomes = buildLocalLlmSmokeOutcomeTrend(projectDir, projectRuns, recentRouteReports);
      const report = await loadLocalLlmSetupChecklistReport(ctx, {
        projectDir,
        localHoldoutRouting,
        routeReceiptTrends,
        smokeOutcomes
      });
      console.log(options.json ? JSON.stringify(report, null, 2) : formatLocalLlmSetupChecklistReport(report));
      if (report.status === "fail") process.exitCode = 1;
    });

  program
    .command("local-llm-smoke")
    .description("Run one low-risk provider-smoke stage to generate local LLM route receipt evidence")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--timeout-ms <number>", "maximum time to wait for the smoke run", "120000")
    .option("--json", "print smoke result JSON")
    .action(async (options: { project: string; timeoutMs: string; json?: boolean }) => {
      const result = await runLocalLlmRouteSmoke(ctx, {
        projectDir: path.resolve(process.cwd(), options.project),
        timeoutMs: parsePositiveInteger(options.timeoutMs, 120000)
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatLocalLlmRouteSmokeResult(result));
      if (result.status === "failed") process.exitCode = 1;
    });

  program
    .command("local-llm-setup-guide")
    .description("Detect local OpenAI-compatible runtimes and prepare reviewed project-local setup/routing notes")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--approved", "confirm owner approval to write healthy project-local routing notes")
    .option("--write", "write project-local setup guide files, and routing note files only when healthy and approved")
    .option("--json", "print setup guide JSON")
    .action(async (options: { project: string; limit: string; approved?: boolean; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const scorecard = await loadPreferenceScorecard({ projectDir, limit: parsePositiveInteger(options.limit, 50) });
      const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: parsePositiveInteger(options.limit, 50) });
      const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
      const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
      const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(projectDir, localProviderEvidence);
      const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
      const smokeOutcomes = buildLocalLlmSmokeOutcomeTrend(projectDir, projectRuns, recentRouteReports);
      const checklist = await loadLocalLlmSetupChecklistReport(ctx, { projectDir, localHoldoutRouting, routeReceiptTrends, smokeOutcomes });
      const guide = await loadLocalLlmSetupGuideReport({
        projectDir,
        checklist,
        approved: Boolean(options.approved)
      });
      if (options.write) {
        await writeLocalLlmSetupGuideReport(projectDir, guide);
      }
      console.log(options.json ? JSON.stringify({ ...guide, mode: options.write ? "write" : "dry-run" }, null, 2) : formatLocalLlmSetupGuideReport(guide));
      if (options.write && guide.files.length) {
        for (const file of guide.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      }
      if (guide.status === "blocked") process.exitCode = 1;
    });

  program
    .command("local-llm-download-recommendations")
    .description("Recommend local model downloads from hardware, runtime catalog, task mix, and local smoke evidence")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--write", "write project-local recommendation files")
    .option("--json", "print recommendation JSON")
    .action(async (options: { project: string; limit: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const scorecard = await loadPreferenceScorecard({ projectDir, limit: parsePositiveInteger(options.limit, 50) });
      const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: parsePositiveInteger(options.limit, 50) });
      const recentRouteReports = await loadCostQualityReportsForDashboardRuns(projectRuns.slice(0, Math.min(projectRuns.length, 50)));
      const localProviderEvidence = buildDashboardLocalProviderEvidence(scorecard);
      const localHoldoutRouting = await loadDashboardLocalHoldoutRoutingStatus(projectDir, localProviderEvidence);
      const routeReceiptTrends = buildDashboardRouteReceiptTrends(projectDir, recentRouteReports);
      const smokeOutcomes = buildLocalLlmSmokeOutcomeTrend(projectDir, projectRuns, recentRouteReports);
      const checklist = await loadLocalLlmSetupChecklistReport(ctx, { projectDir, localHoldoutRouting, routeReceiptTrends, smokeOutcomes });
      const setupGuide = await loadLocalLlmSetupGuideReport({ projectDir, checklist, approved: false });
      const report = buildLocalLlmDownloadRecommendationReport({ projectDir, scorecard, checklist, setupGuide });
      if (options.write) {
        await writeLocalLlmDownloadRecommendationReport(projectDir, report);
      }
      console.log(options.json ? JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2) : formatLocalLlmDownloadRecommendationReport(report));
      if (options.write) {
        for (const file of report.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      }
    });

  program
    .command("local-llm-benchmarks")
    .description("Prepare or execute tiny local-only benchmark receipts for installed local model candidates")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--execute", "call the local OpenAI-compatible runtime for tiny benchmark prompts")
    .option("--timeout-ms <number>", "per-prompt timeout when executing", "20000")
    .option("--write", "write project-local benchmark receipt files")
    .option("--json", "print benchmark receipt JSON")
    .action(async (options: { project: string; limit: string; execute?: boolean; timeoutMs: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadLocalLlmBenchmarkReceiptReport(ctx, {
        projectDir,
        limit: parsePositiveInteger(options.limit, 50),
        execute: Boolean(options.execute),
        timeoutMs: parsePositiveInteger(options.timeoutMs, 20000)
      });
      if (options.write) {
        await writeLocalLlmBenchmarkReceiptReport(projectDir, report);
      }
      console.log(options.json ? JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2) : formatLocalLlmBenchmarkReceiptReport(report));
      if (options.write) {
        for (const file of report.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      }
    });

  program
    .command("local-llm-install-plan")
    .description("Write reviewed runtime-specific local model installation commands from recommendations")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--model <ids>", "comma-separated recommendation ids or model ids, or recommended", "recommended")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--write", "write project-local installation plan files")
    .option("--json", "print installation plan JSON")
    .action(async (options: { project: string; model: string; limit: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadLocalLlmInstallationPlanReport(ctx, {
        projectDir,
        selectedModels: options.model,
        limit: parsePositiveInteger(options.limit, 50)
      });
      if (options.write) {
        await writeLocalLlmInstallationPlanReport(projectDir, report);
      }
      console.log(options.json ? JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2) : formatLocalLlmInstallationPlanReport(report));
      if (options.write) {
        for (const file of report.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      }
    });

  program
    .command("local-llm-inventory")
    .description("Inspect local model cache roots, installed model evidence, and storage pressure")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--write", "write project-local inventory files")
    .option("--json", "print inventory JSON")
    .action(async (options: { project: string; limit: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadLocalLlmInventoryReport(ctx, {
        projectDir,
        limit: parsePositiveInteger(options.limit, 50)
      });
      if (options.write) {
        await writeLocalLlmInventoryReport(projectDir, report);
      }
      console.log(options.json ? JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2) : formatLocalLlmInventoryReport(report));
      if (options.write) {
        for (const file of report.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      }
    });

  program
    .command("local-llm-prune-plan")
    .description("Write reviewed cleanup commands for stale local model cache candidates without deleting anything")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--model <ids>", "comma-separated model ids, prune action ids, or candidates", "candidates")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--write", "write project-local prune plan files")
    .option("--json", "print prune plan JSON")
    .action(async (options: { project: string; model: string; limit: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const inventory = await loadLocalLlmInventoryReport(ctx, {
        projectDir,
        limit: parsePositiveInteger(options.limit, 50)
      });
      const report = buildLocalLlmPrunePlanReport(projectDir, inventory, options.model);
      if (options.write) {
        await writeLocalLlmPrunePlanReport(projectDir, report);
      }
      console.log(options.json ? JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2) : formatLocalLlmPrunePlanReport(report));
      if (options.write) {
        for (const file of report.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      }
    });

  program
    .command("local-llm-cache-trends")
    .description("Track local model cache growth, prune candidates, and local-vs-hosted route usage over time")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--write", "append the current snapshot to project-local trend history")
    .option("--json", "print trend history JSON")
    .action(async (options: { project: string; limit: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadLocalLlmCacheTrendReport(ctx, {
        projectDir,
        limit: parsePositiveInteger(options.limit, 50),
        write: Boolean(options.write)
      });
      console.log(options.json ? JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2) : formatLocalLlmCacheTrendReport(report));
      if (options.write) {
        for (const file of report.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      }
    });

  program
    .command("local-llm-cost-ledger")
    .description("Estimate per-project local model savings from avoided hosted stages, latency, and cache storage")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--write", "append the current estimate to project-local cost ledger history")
    .option("--json", "print cost ledger JSON")
    .action(async (options: { project: string; limit: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadLocalLlmCostLedgerReport(ctx, {
        projectDir,
        limit: parsePositiveInteger(options.limit, 50),
        write: Boolean(options.write)
      });
      console.log(options.json ? JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2) : formatLocalLlmCostLedgerReport(report));
      if (options.write) {
        for (const file of report.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      }
    });

  program
    .command("local-llm-routing-recommendations")
    .description("Recommend where local model routing should expand, hold, or retreat from savings and quality evidence")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--write", "write project-local routing recommendation files")
    .option("--json", "print routing recommendations JSON")
    .action(async (options: { project: string; limit: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadLocalLlmRoutingRecommendationReport(ctx, {
        projectDir,
        limit: parsePositiveInteger(options.limit, 50)
      });
      if (options.write) {
        await writeLocalLlmRoutingRecommendationReport(projectDir, report);
      }
      console.log(options.json ? JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2) : formatLocalLlmRoutingRecommendationReport(report));
      if (options.write) {
        for (const file of report.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      }
    });

  program
    .command("local-llm-routing-note-plan")
    .description("Prepare reviewed project-local routing-note patch plans from savings-aware local routing recommendations")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated recommendation ids to include, or all", "all")
    .option("--write", "write review plan files into .agent-workflow/tuning")
    .option("--json", "print routing note plan JSON")
    .action(async (options: { project: string; ids: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const recommendations = await loadLocalLlmRoutingRecommendationReport(ctx, {
        projectDir,
        limit: 50
      });
      const plan = buildLocalLlmRoutingNotePlan(recommendations, parseProposalIds(options.ids));
      if (options.write) {
        await writeLocalLlmRoutingNotePlan(projectDir, plan);
      }
      if (options.json) {
        console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }
      console.log(formatLocalLlmRoutingNotePlan(plan));
      if (options.write) {
        for (const file of plan.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to create reviewed local routing note files.");
      }
    });

  program
    .command("apply-local-llm-routing-note-plan")
    .description("Apply reviewed local routing-note plan items into project-local routing preferences")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--ids <ids>", "comma-separated note or recommendation ids to apply, or all", "all")
    .option("--approved", "confirm the reviewed notes are approved for project-local application")
    .option("--write", "append selected notes to .agent-workflow/tuning/routing-preferences.md")
    .option("--json", "print routing note application JSON")
    .action(async (options: { project: string; ids: string; approved?: boolean; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const notePlan = await readLocalLlmRoutingNotePlan(projectDir);
      const plan = await buildLocalLlmRoutingNoteApplicationPlan({
        projectDir,
        notePlan,
        selectedIds: parseProposalIds(options.ids),
        approved: Boolean(options.approved)
      });
      if (options.write) {
        if (!options.approved) {
          throw new Error("Refusing to write routing preferences without --approved.");
        }
        await writeLocalLlmRoutingNoteApplicationPlan(projectDir, plan);
        await recordTuningHistory(projectDir, plan.appliedNoteIds, "applied", undefined, "Applied reviewed local LLM routing note plan");
      }
      if (options.json) {
        console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }
      console.log(formatLocalLlmRoutingNoteApplicationPlan(plan));
      if (options.write) {
        for (const file of plan.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --approved --write to append selected routing notes.");
      }
    });

  program
    .command("local-llm-routing-decision-snapshot")
    .description("Capture compact project-local routing decision snapshots for timeline comparison")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("-l, --limit <number>", "number of recent project runs to inspect", "50")
    .option("--write", "append a changed decision snapshot under .agent-workflow/model-improvement")
    .option("--json", "print snapshot history JSON")
    .action(async (options: { project: string; limit: string; write?: boolean; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const report = await loadLocalLlmRoutingDecisionSnapshotReport(ctx, {
        projectDir,
        limit: parsePositiveInteger(options.limit, 50),
        write: Boolean(options.write)
      });
      if (options.json) {
        console.log(JSON.stringify({ ...report, mode: options.write ? "write" : "dry-run" }, null, 2));
        return;
      }
      console.log(formatLocalLlmRoutingDecisionSnapshotReport(report));
      if (options.write) {
        for (const file of report.files) {
          console.log(`Wrote ${file.relativePath}`);
        }
      } else {
        console.log("");
        console.log("Dry run only. Re-run with --write to persist the current decision snapshot.");
      }
    });

  program
    .command("local-route-feedback")
    .description("Record project-local feedback for a route decision drilldown row")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("--workflow <id>", "workflow id")
    .requiredOption("--stage <id>", "stage id")
    .requiredOption("--agent <id>", "agent id")
    .requiredOption("--provider <id>", "provider id")
    .requiredOption("--tier <tier>", "model tier")
    .requiredOption("--class <class>", "local-selected, local-skipped, hosted-fallback, or hosted-selected")
    .requiredOption("--rating <rating>", "helpful, costly, or neutral")
    .option("--note <text>", "short note explaining why this route decision helped or hurt", "")
    .option("--runs <number>", "number of grouped receipts", "0")
    .option("--fallbacks <number>", "number of grouped fallback receipts", "0")
    .option("--quality <number>", "average quality score")
    .option("--latency-ms <number>", "average latency in milliseconds")
    .option("--json", "print route decision feedback JSON")
    .action(async (options: {
      project: string;
      workflow: string;
      stage: string;
      agent: string;
      provider: string;
      tier: string;
      class: string;
      rating: string;
      note: string;
      runs: string;
      fallbacks: string;
      quality?: string;
      latencyMs?: string;
      json?: boolean;
    }) => {
      const result = await recordRouteDecisionFeedback({
        projectDir: path.resolve(process.cwd(), options.project),
        workflowId: options.workflow,
        stageId: options.stage,
        agentId: options.agent,
        providerId: options.provider,
        modelTier: options.tier,
        routeClass: options.class,
        rating: options.rating,
        note: options.note,
        runs: parseNonNegativeInteger(options.runs, 0),
        fallbackCount: parseNonNegativeInteger(options.fallbacks, 0),
        averageQuality: parseOptionalNumber(options.quality),
        averageLatencyMs: parseOptionalNumber(options.latencyMs),
        source: "cli"
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(formatRouteDecisionFeedbackResult(result));
    });

}
