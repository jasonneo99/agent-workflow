import { readContextActions } from "../../../../packages/storage/src/context-actions.js";
import { readContextNotifications } from "../../../../packages/storage/src/context-notifications.js";
import { readContextIO } from "../../../../packages/storage/src/context-io.js";
import { readContextFollowups } from "../../../../packages/storage/src/context-followups.js";
import { readContextAttempts } from "../../../../packages/storage/src/context-attempts.js";
import { readContextHealth } from "../../../../packages/storage/src/context-health.js";
import { readContextApprovals,readContextApprovalReview } from "../../../../packages/storage/src/context-approvals.js";
import { isExecutableApprovalAction } from "../lib/builders-shared.js";
import { readProjectBrief } from "../../../../packages/storage/src/context-brief.js";
import { searchProjectContext } from "../../../../packages/storage/src/context-search.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import YAML from "yaml";
import { readProjectEvidenceGraph } from "../../../../packages/storage/src/project-evidence.js";
import { readContextInfluence } from "../../../../packages/storage/src/context-influence.js";
import { readContextCorrections, requestContextCorrection } from "../../../../packages/storage/src/context-corrections.js";
import { getActionApproval } from "../../../../packages/storage/src/action-approvals.js";
import { readContextDeletionImpact } from "../../../../packages/storage/src/context-deletion-impact.js";
import { loadProjectConfig } from "../../../../packages/agent-registry/src/loaders.js";
import { buildSegmentedThresholdQueue, proposeContextThresholds, readLatestCalibration, repositoryHoldoutCorpusSchema, runRepositoryCalibration, writeCalibrationEvidence, writeSegmentedThresholdQueue } from "../../../../packages/context-calibration/src/index.js";
import { assertContextProjectPath, buildContextEfficiencyReport, contextRoutingPolicySchema, readShadowObservations, type ContextRoutingPolicy } from "../../../../packages/context-gateway/src/index.js";
import { findAgentWorkflowRoot } from "../../../../packages/runtime-root/src/index.js";
import { upsertProject } from "../../../../packages/storage/src/postgres.js";

export function registerContextCommands(program: Command): void {
  program.command("context-actions").description("Reconcile bounded action receipt and approval history without mutation")
    .requiredOption("-p, --project <dir>", "project directory").option("--kind <category>", "all, approvals or receipts", "all").option("--json", "print JSON")
    .action(async(options:{project:string;kind:string})=>console.log(JSON.stringify(await readContextActions(await fs.realpath(path.resolve(options.project)),options.kind))));

  program.command("context-notifications").description("Read bounded notification history without dispatch or acknowledgment")
    .requiredOption("-p, --project <dir>", "project directory").option("--status <state>", "all, pending, delivered, failed, delivery_uncertain or coalesced", "all").option("--json", "print JSON")
    .action(async(options:{project:string;status:string})=>console.log(JSON.stringify(await readContextNotifications(await fs.realpath(path.resolve(options.project)),options.status))));

  program.command("context-io").description("Read bounded project file and command I/O receipts without content bodies")
    .requiredOption("-p, --project <dir>", "project directory").option("--kind <category>", "all, inputs, outputs or commands", "all").option("--json", "print JSON")
    .action(async(options:{project:string;kind:string})=>console.log(JSON.stringify(await readContextIO(await fs.realpath(path.resolve(options.project)),options.kind))));

  program.command("context-followups").description("Read durable follow-up relationships, handoffs and existing approval evidence")
    .requiredOption("-p, --project <dir>", "project directory").option("--json", "print JSON")
    .action(async(options:{project:string})=>console.log(JSON.stringify(await readContextFollowups(await fs.realpath(path.resolve(options.project))))));
  program.command("context-attempts").description("Read bounded task and provider attempt journals from existing receipts")
    .requiredOption("-p, --project <dir>", "project directory").option("--json", "print JSON")
    .action(async(options:{project:string})=>console.log(JSON.stringify(await readContextAttempts(await fs.realpath(path.resolve(options.project))))));
  program.command("context-health").description("Read bounded project capability health without repair or execution")
    .requiredOption("-p, --project <dir>", "project directory").option("--json", "print JSON")
    .action(async(options:{project:string})=>console.log(JSON.stringify(await readContextHealth(await fs.realpath(path.resolve(options.project))))));
  program.command("context-approvals").description("Read project-scoped contextual approval cards or canonical review")
    .requiredOption("-p, --project <dir>", "project directory").option("--approval <id>", "existing approval identity").option("--json", "print JSON")
    .action(async(options:{project:string;approval?:string})=>{
      const project=await fs.realpath(path.resolve(options.project));
      if(!options.approval){console.log(JSON.stringify(await readContextApprovals(project)));return;}
      const review=await readContextApprovalReview(project,options.approval),a=review.approval,executable=isExecutableApprovalAction(a.actionType);
      const actions=review.reviewTruncated?[]:a.status==='pending'?['approve','reject',...(executable?['approve_execute']:[])]:a.status==='approved'?[...(executable?['execute']:[]),'dismiss']:a.status==='failed'?[...(executable?['retry']:[]),'dismiss']:[];
      console.log(JSON.stringify({...review,actions}));
    });
  program.command("context-brief").description("Read an evidence-backed project brief; never grants execution authority")
    .requiredOption("-p, --project <dir>", "project directory").option("--json", "print JSON")
    .action(async(options:{project:string})=>console.log(JSON.stringify(await readProjectBrief(await fs.realpath(path.resolve(options.project))))));
  program.command("context-search").description("Search existing project evidence stores with literal bounded results")
    .requiredOption("-p, --project <dir>", "project directory").requiredOption("--query <text>", "literal search text").option("--kind <type>", "evidence type", "").option("--json", "print JSON")
    .action(async(options:{project:string;query:string;kind:string})=>console.log(JSON.stringify(await searchProjectContext(await fs.realpath(path.resolve(options.project)),options.query,options.kind))));
  program.command("context-deletion-impact").description("Preview bounded recorded deletion impact; never authorizes or performs deletion")
    .requiredOption("-p, --project <dir>", "project directory").requiredOption("--node <id>", "project evidence node").option("--json", "print JSON")
    .action(async(options:{project:string;node:string})=>console.log(JSON.stringify(await readContextDeletionImpact(await fs.realpath(path.resolve(options.project)),options.node))));
  program.command("context-correction-review").description("Read the canonical existing correction approval scoped to a project")
    .requiredOption("-p, --project <dir>", "project directory").requiredOption("--approval <id>", "existing approval").option("--json", "print JSON")
    .action(async (options:{project:string;approval:string}) => {
      const project=await fs.realpath(path.resolve(options.project)), approval=await getActionApproval(options.approval);
      if (!approval || approval.projectRootUri!==project || approval.actionType!=="context_correction") throw new Error("Correction approval is unavailable in this project.");
      console.log(JSON.stringify({schemaVersion:1,project,authority:"none",approval}));
    });
  program.command("context-correction").description("Read bounded correction history or request an attributed correction through existing approvals")
    .requiredOption("-p, --project <dir>", "project directory").requiredOption("--node <id>", "evidence node")
    .option("--request", "read immutable correction proposal JSON from stdin").option("--json", "print JSON")
    .action(async (options: {project:string;node:string;request?:boolean}) => {
      const project = await fs.realpath(path.resolve(options.project));
      if (!options.request) { console.log(JSON.stringify(await readContextCorrections(project, options.node))); return; }
      let text = "";
      for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 16000) throw new Error("Correction proposal exceeds the input limit."); }
      const input = JSON.parse(text);
      console.log(JSON.stringify(await requestContextCorrection(project, {...input, nodeId:options.node})));
    });
  program.command("context-influence").description("Read context attribution from the existing run receipt chain")
    .requiredOption("-p, --project <dir>", "project directory").requiredOption("--run <id>", "workflow run id").option("--json", "print JSON")
    .action(async (options: { project: string; run: string }) => {
      console.log(JSON.stringify(await readContextInfluence(path.resolve(options.project), options.run), null, 2));
    });
  program.command("project-evidence").description("Read the project-only evidence graph; evidence grants no execution authority")
    .requiredOption("-p, --project <dir>", "project directory").option("--json", "print JSON")
    .action(async (options: { project: string }) => {
      console.log(JSON.stringify(await readProjectEvidenceGraph(path.resolve(options.project)), null, 2));
    });
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
