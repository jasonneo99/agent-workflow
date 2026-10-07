import type { CliContext } from "../lib/context.js";
import type { Command } from "commander";
import type { DashboardFollowUpResult } from "../lib/cli-types.js";
import { summarizeWorkflowRun } from "../lib/builders-learning.js";
import { exportWorkflowRun, watchWorkflowRun } from "../lib/builders-local-llm.js";
import { assessRunStaleInputs, createAgentTaskWorkflow, formatIndexResult, formatRunEta, formatRunSummary, formatStaleInputWarnings, loadObservabilityReport, runDashboardAgentTask, runDashboardWorkflow, runWorkflowPreset, workflowPresets } from "../lib/builders-runs.js";
import { indexProjectForRun, loadAgentsForProject, loadCostQualityReport, loadPreferenceNotes, loadSourceSummaries, queueWorkflow, requiredAgent } from "../lib/builders-shared.js";
import { byId, loadAgents, loadProjectConfig, loadWorkflows } from "../../../../packages/agent-registry/src/loaders.js";
import { compileContext } from "../../../../packages/context-compiler/src/index.js";
import { constructDynamicWorkflow, workflowArchetypes } from "../../../../packages/dynamic-workflow/src/index.js";
import { type EvaluationObservation, type EvaluationScoringProfile, buildEvaluationGateReport, buildEvaluationReport, evaluationGateSchema, evaluationScoringProfileSchema, evaluationSuiteSchema, formatEvaluationGateReport, formatEvaluationReport } from "../../../../packages/evaluation/src/index.js";
import { formatObservabilityReport } from "../../../../packages/observability/src/index.js";
import { evaluateAgentAutonomy, resolveExecutionPolicy } from "../../../../packages/policy-engine/src/index.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { dismissFailedWorkflowRun, getWorkflowRunDetails, listActionApprovals, listArtifacts, listWorkflowRuns, replayWorkflowRun, resumeWorkflowRunFromCheckpoint, seedRegistry, upsertMemoryItem } from "../../../../packages/storage/src/postgres.js";
import { buildWorkflowGraphReport, formatWorkflowGraphReport } from "../../../../packages/workflow-inspector/src/index.js";
import { type RunEta, estimateRunEta } from "../dashboard/run-eta.js";
import { parseBoundedPositiveInteger, parsePositiveInteger } from "../numeric-options.js";
import { type OrchestrationPlan, createOrchestrationPlan } from "../orchestration-plan.js";
import { resolveAgent, resolveWorkflow } from "../reference-resolution.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { sourceSubjectHash } from "../../../../packages/workflow-engine/src/source-subject.js";
import type { StructuredAcceptanceContract } from "../../../../packages/model-providers/src/types.js";

export function registerRunsCommands(program: Command, ctx: CliContext): void {
  function formatOrchestrationPlan(plan: OrchestrationPlan): string {
    return [
      "Orchestration Plan",
      `Project: ${plan.projectDir}`,
      `Task: ${plan.task}`,
      `Execution profile: ${plan.executionProfile}`,
      "",
      ...plan.steps.map((step, index) => [
        `${index + 1}. ${step.title}`,
        `   kind: ${step.kind}`,
        `   target: ${step.target}`,
        `   reason: ${step.reason}`,
        `   task: ${step.task}`
      ].join("\n"))
    ].join("\n");
  }

  function hasActionableFindings(output: string): boolean {
    const normalized = output.toLowerCase();
    // If the run failed, treat it as "has findings" (something needs attention)
    if (normalized.includes("status: failed")) {
      return true;
    }
    // Patterns that indicate NO useful findings were produced
    const emptyPatterns = [
      "no immediate security risks",
      "no significant",
      "no issues found",
      "no actionable",
      "no risks identified",
      "all passing",
      "no findings captured",
      "- none"
    ];
    const findingsSection = normalized.includes("key findings:")
      ? normalized.slice(normalized.indexOf("key findings:"))
      : normalized;
    const hasEmpty = emptyPatterns.some((pattern) => findingsSection.includes(pattern));
    // If all key findings are generic/empty, skip
    if (hasEmpty && !normalized.includes("risk") && !normalized.includes("fix") && !normalized.includes("vulnerability")) {
      return false;
    }
    // If there are specific findings mentioned, keep going
    return true;
  }

  async function loadPrivateEvaluationScoring(
    projectDir: string,
    profilePath: string
  ): Promise<{ profile: EvaluationScoringProfile; checksum: string }> {
    const privateRoot = path.resolve(projectDir, ".agent-workflow", "evaluations");
    const resolved = path.resolve(projectDir, profilePath);
    if (resolved !== privateRoot && !resolved.startsWith(`${privateRoot}${path.sep}`)) {
      throw new Error("Private scoring profiles must be stored under <project>/.agent-workflow/evaluations");
    }
    const [realPrivateRoot, realResolved] = await Promise.all([fs.realpath(privateRoot), fs.realpath(resolved)]);
    if (realResolved !== realPrivateRoot && !realResolved.startsWith(`${realPrivateRoot}${path.sep}`)) {
      throw new Error("Private scoring profile symlinks must remain under <project>/.agent-workflow/evaluations");
    }
    const raw = await fs.readFile(realResolved, "utf8");
    return {
      profile: evaluationScoringProfileSchema.parse(YAML.parse(raw)),
      checksum: createHash("sha256").update(raw).digest("hex").slice(0, 16)
    };
  }

  function parseExecutionProfile(value: string): "adaptive" | "full" {
    if (value === "adaptive" || value === "full") return value;
    throw new Error("Execution profile must be 'adaptive' or 'full'.");
  }

  async function persistOrchestrationMemory(plan: OrchestrationPlan, runIds: string[], outputs: string[]): Promise<void> {
    try {
      const completedSteps = outputs.filter((output) => output.startsWith("Completed"));
      const summaryLines = [
        `Orchestration: ${plan.task}`,
        `Date: ${new Date().toISOString().split("T")[0]}`,
        `Steps: ${completedSteps.length}`,
        `Run IDs: ${runIds.join(", ")}`,
        "",
        ...completedSteps.map((output) => {
          // Extract just the first line (step title + status) for compact memory
          const firstLine = output.split("\n")[0];
          return `- ${firstLine}`;
        })
      ];

      await upsertMemoryItem({
        projectRootUri: plan.projectDir,
        sourceUri: `orchestration/${new Date().toISOString().split("T")[0]}/${plan.task.slice(0, 60).replace(/[^a-z0-9]+/gi, "-")}`,
        summary: summaryLines.join("\n"),
        metadata: {
          kind: "orchestration_memory",
          task: plan.task,
          runIds,
          stepCount: plan.steps.length,
          completedAt: new Date().toISOString(),
          hadFindings: outputs.some((output) => hasActionableFindings(output))
        }
      });
    } catch {
      // Memory persistence is best-effort — don't fail orchestration if storage is unavailable
    }
  }

  function printPresetList(): void {
    console.log("Presets");
    for (const preset of workflowPresets) {
      const aliases = preset.aliases.length ? ` aliases=${preset.aliases.join(",")}` : "";
      console.log(`- ${preset.id}: ${preset.description}${aliases}`);
    }
  }

  async function runOrchestrationPlan(plan: OrchestrationPlan, options: {
    indexMaxFiles: number;
    refineIndex: boolean;
    forceRefine: boolean;
    workerLimit: number;
    workerConcurrency?: number;
    timeoutMs: number;
    outDir?: string;
  }): Promise<DashboardFollowUpResult> {
    const outputs: string[] = [formatOrchestrationPlan(plan)];
    const runIds: string[] = [];
    let priorStepsHadFindings = true;

    for (const step of plan.steps) {
      // Conditional skip: if step is marked skipIfPriorEmpty and prior steps found nothing actionable
      if (step.skipIfPriorEmpty && !priorStepsHadFindings) {
        outputs.push(`Skipped ${step.id} (${step.title}): prior steps found no actionable issues.`);
        continue;
      }

      const result = step.kind === "agent"
        ? await runDashboardAgentTask(ctx, {
          title: step.title,
          agent: step.target,
          projectDir: plan.projectDir,
          task: step.task,
          indexMaxFiles: options.indexMaxFiles,
          refineIndex: options.refineIndex,
          forceRefine: options.forceRefine,
          timeoutMs: options.timeoutMs,
          outDir: options.outDir
        })
        : step.kind === "preset"
          ? await runWorkflowPreset(ctx, {
            presetRef: step.target,
            project: plan.projectDir,
            task: step.task,
            indexMaxFiles: options.indexMaxFiles,
            refineIndex: options.refineIndex,
            forceRefine: options.forceRefine,
            workerLimit: options.workerLimit,
            workerConcurrency: options.workerConcurrency,
            timeoutMs: options.timeoutMs,
            outDir: options.outDir
          })
          : await runDashboardWorkflow(ctx, {
            title: step.title,
            workflow: step.target,
            projectDir: plan.projectDir,
            task: step.task,
            indexMaxFiles: options.indexMaxFiles,
            refineIndex: options.refineIndex,
            forceRefine: options.forceRefine,
            workerLimit: options.workerLimit,
            workerConcurrency: options.workerConcurrency,
            timeoutMs: options.timeoutMs,
            outDir: options.outDir,
            adaptive: step.adaptive,
            evaluationSource: step.adaptive ? "codex-adaptive-orchestration" : "codex-full-orchestration"
          });

      if (!result.ok) {
        return {
          ok: false,
          error: [
            `Orchestration stopped at ${step.id} (${step.title}).`,
            result.error,
            "",
            outputs.join("\n\n")
          ].join("\n")
        };
      }

      if (result.runId) {
        runIds.push(result.runId);
      }
      outputs.push([`Completed ${step.id}: ${result.title}`, result.output].join("\n\n"));

      // Track whether this step produced actionable findings for conditional skipping
      if (result.ok) {
        priorStepsHadFindings = hasActionableFindings(result.output);
      }
    }

    // Persist compact memory for future runs
    await persistOrchestrationMemory(plan, runIds, outputs);

    return {
      ok: true,
      title: `Orchestration completed: ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}`,
      runId: runIds[runIds.length - 1],
      output: [
        `Run ids: ${runIds.length ? runIds.join(", ") : "none"}`,
        "",
        ...outputs,
        "",
        "Recommended next action:",
        "Open the exported reports for any failed or high-risk findings, then run a narrower agent task for the highest-impact fix."
      ].join("\n")
    };
  }

  program
    .command("compile")
    .description("Compile a compact workflow brief for a project task")
    .requiredOption("-w, --workflow <id>", "workflow id")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("-t, --task <task>", "task description")
    .option("--policy-profile <name>", "execution policy profile (local, staging, production, or project-defined)")
    .option("--source-token-budget <number>", "token budget for indexed source summaries")
    .option("--source-max-files <number>", "maximum indexed source summaries to include")
    .action(async (options: { workflow: string; project: string; task: string; policyProfile?: string; sourceTokenBudget?: string; sourceMaxFiles?: string }) => {
      const agents = await loadAgents(ctx.rootDir);
      const workflows = await loadWorkflows(ctx.rootDir);
      const workflow = resolveWorkflow(workflows, options.workflow);

      if (!workflow) {
        console.error(`Unknown workflow: ${options.workflow}`);
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const configuredProject = await loadProjectConfig(projectDir);
      const project = resolveExecutionPolicy(configuredProject, options.policyProfile).project;
      const agentIndex = byId(agents);
      const selectedAgents = new Map<string, typeof agents[number]>();

      selectedAgents.set(workflow.lead, requiredAgent(agentIndex, workflow.lead));
      for (const stage of workflow.stages) {
        selectedAgents.set(stage.agent, requiredAgent(agentIndex, stage.agent));
        for (const subagent of stage.subagents) {
          selectedAgents.set(subagent, requiredAgent(agentIndex, subagent));
        }
      }

      for (const agent of selectedAgents.values()) {
        const decision = evaluateAgentAutonomy(agent, project);
        if (!decision.allowed) {
          console.error(`Policy rejected ${agent.id}: ${decision.reasons.join("; ")}`);
          process.exitCode = 1;
          return;
        }
      }

      const brief = await compileContext({
        task: options.task,
        projectDir,
        project,
        workflow,
        agents: [...selectedAgents.values()],
        sourceSummaries: await loadSourceSummaries({
          projectDir,
          project,
          workflow,
          agents: [...selectedAgents.values()],
          task: options.task,
          sourceTokenBudget: options.sourceTokenBudget,
          sourceMaxFiles: options.sourceMaxFiles
        }),
        preferenceNotes: await loadPreferenceNotes(projectDir)
      });

      console.log(brief);
    });

  program
    .command("workflow-graph")
    .alias("graph")
    .description("Inspect a workflow graph, policy fit, approvals, agents, and context budgets without queueing work")
    .requiredOption("-w, --workflow <id>", "workflow id or alias")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--policy-profile <name>", "execution policy profile (local, staging, production, or project-defined)")
    .option("--json", "print machine-readable graph report")
    .option("--mermaid", "print only the Mermaid flowchart")
    .action(async (options: { workflow: string; project: string; policyProfile?: string; json?: boolean; mermaid?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const agents = await loadAgentsForProject(ctx, projectDir);
      const workflows = await loadWorkflows(ctx.rootDir);
      const workflow = resolveWorkflow(workflows, options.workflow);
      if (!workflow) {
        console.error(`Unknown workflow: ${options.workflow}`);
        process.exitCode = 1;
        return;
      }

      const configuredProject = await loadProjectConfig(projectDir);
      const resolvedPolicy = resolveExecutionPolicy(configuredProject, options.policyProfile);
      const report = buildWorkflowGraphReport({
        workflow,
        agents,
        project: configuredProject,
        resolvedPolicy
      });

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (options.mermaid) {
        console.log(report.mermaid);
        return;
      }
      console.log(formatWorkflowGraphReport(report));
    });

  program
    .command("dynamic-plan")
    .description("Construct and validate a policy-bounded workflow DAG from a natural-language goal")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("-t, --task <task>", "natural-language goal")
    .option("--execution-profile <profile>", "adaptive or full", "adaptive")
    .option("--json", "print the generated workflow JSON")
    .action(async (options: { project: string; task: string; executionProfile: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const project = await loadProjectConfig(projectDir);
      const executionProfile = parseExecutionProfile(options.executionProfile);
      const workflow = constructDynamicWorkflow({ goal: options.task, project, agents: await loadAgentsForProject(ctx, projectDir), executionProfile });
      if (options.json) {
        console.log(JSON.stringify(workflow, null, 2));
        return;
      }
      console.log(`Dynamic Workflow: ${workflow.id}`);
      console.log(`Archetype: ${workflow.dynamic?.archetype}`);
      console.log(`Definition: v${workflow.dynamic?.version} ${workflow.dynamic?.definition_hash}`);
      console.log(`Stages: ${workflow.stages.map((stage) => stage.id).join(" -> ")}`);
      console.log(`Available archetypes: ${workflowArchetypes.map((item) => item.id).join(", ")}`);
    });

  program
    .command("dynamic-run")
    .description("Construct, persist, and queue a validated dynamic workflow from a natural-language goal")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("-t, --task <task>", "natural-language goal")
    .option("--policy-profile <name>", "execution policy profile")
    .option("--requester <name>", "who asked for this run (notified on block/approval)")
    .option("--requester-channel <channel>", "how to reach the requester: cli, dashboard, codex, command")
    .option("--execution-profile <profile>", "adaptive or full", "adaptive")
    .option("--no-brief", "queue without printing the compiled brief")
    .action(async (options: { project: string; task: string; policyProfile?: string; executionProfile: string; brief?: boolean; requester?: string; requesterChannel?: string }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const configuredProject = await loadProjectConfig(projectDir);
      const executionProfile = parseExecutionProfile(options.executionProfile);
      const workflow = constructDynamicWorkflow({ goal: options.task, project: configuredProject, agents: await loadAgentsForProject(ctx, projectDir), executionProfile });
      await seedRegistry([], [{ path: `runtime/${workflow.id}.yaml`, value: workflow }]);
      const result = await queueWorkflow(ctx, { workflowId: workflow.id, projectPath: projectDir, task: options.task, policyProfile: options.policyProfile, workflowOverride: workflow, requester: options.requester, requesterChannel: options.requesterChannel });
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      console.log(`Run: ${result.run.runId}`);
      console.log(`Workflow: ${workflow.id} (${workflow.dynamic?.archetype})`);
      console.log(`Definition hash: ${workflow.dynamic?.definition_hash}`);
      if (options.brief) console.log(`\n${result.brief}`);
    });

  program
    .command("run")
    .description("Queue a workflow run in enterprise storage and print the compiled brief")
    .option("--acceptance-requirements <file>", "JSON requirements with explicit sourcePaths and pending deliverables; source identity is measured before atomic enrollment")
    .argument("<workflow>", "workflow id")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("-t, --task <task>", "task description")
    .option("--policy-profile <name>", "execution policy profile (local, staging, production, or project-defined)")
    .option("--requester <name>", "who asked for this run (notified on block/approval)")
    .option("--requester-channel <channel>", "how to reach the requester: cli, dashboard, codex, command")
    .option("--no-brief", "queue the run without printing the compiled brief")
    .option("--source-token-budget <number>", "token budget for indexed source summaries")
    .option("--source-max-files <number>", "maximum indexed source summaries to include")
    .action(async (workflowId: string, options: { project: string; task: string; acceptanceRequirements?: string; policyProfile?: string; brief?: boolean; sourceTokenBudget?: string; sourceMaxFiles?: string; requester?: string; requesterChannel?: string }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        console.error("\nStart local enterprise services with:");
        console.error("docker compose -f infra/docker-compose.yml up -d");
        process.exitCode = 1;
        return;
      }

      const result = await queueWorkflow(ctx, {
        workflowId,
        acceptanceRequirementsFile: options.acceptanceRequirements,
        projectPath: options.project,
        task: options.task,
        policyProfile: options.policyProfile,
        sourceTokenBudget: options.sourceTokenBudget,
        sourceMaxFiles: options.sourceMaxFiles,
        requester: options.requester,
        requesterChannel: options.requesterChannel
      });

      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }

      console.log(`Queued workflow run ${result.run.runId}`);
      console.log(`Project ${result.run.projectId}`);
      console.log(`Workflow ${result.workflow.id}`);
      console.log(`Queued ${result.run.tasks} stage tasks`);

      if (options.brief !== false) {
        console.log("");
        console.log(result.brief);
      }
    });

  program
    .command("run-and-watch")
    .description("Index, queue, process, export, and summarize a workflow run")
    .argument("<workflow>", "workflow id or alias")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("-t, --task <task>", "task description")
    .option("--policy-profile <name>", "execution policy profile (local, staging, production, or project-defined)")
    .option("--skip-index", "skip project indexing before queueing")
    .option("--index-max-files <number>", "maximum project files to index first", "100")
    .option("--full-index", "force a full project index instead of the default incremental refresh")
    .option("--refine-index", "refine indexed summaries with the selected provider")
    .option("--force-refine", "refresh refined summaries even when content hash is unchanged")
    .option("--worker-limit <number>", "maximum tasks to process per worker tick", "6")
    .option("--worker-concurrency <number>", "maximum tasks to execute at the same time per worker tick", "1")
    .option("--interval-ms <number>", "polling interval while waiting for run status", "1000")
    .option("--timeout-ms <number>", "maximum time to wait for completion", "900000")
    .option("-o, --out <dir>", "export directory; defaults to <project>/.agent-workflow/exports")
    .option("--source-token-budget <number>", "token budget for indexed source summaries")
    .option("--source-max-files <number>", "maximum indexed source summaries to include")
    .action(async (workflowId: string, options: {
      project: string;
      task: string;
      policyProfile?: string;
      skipIndex?: boolean;
      indexMaxFiles: string;
      fullIndex?: boolean;
      refineIndex?: boolean;
      forceRefine?: boolean;
      workerLimit: string;
      workerConcurrency: string;
      intervalMs: string;
      timeoutMs: string;
      out?: string;
      sourceTokenBudget?: string;
      sourceMaxFiles?: string;
    }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        console.error("\nStart local enterprise services with:");
        console.error("docker compose -f infra/docker-compose.yml up -d");
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const indexMaxFiles = parsePositiveInteger(options.indexMaxFiles, 100);
      const workerLimit = parsePositiveInteger(options.workerLimit, 6);
      const workerConcurrency = parseBoundedPositiveInteger(options.workerConcurrency, 1, 16);
      const intervalMs = parsePositiveInteger(options.intervalMs, 1000);
      const timeoutMs = parsePositiveInteger(options.timeoutMs, 900000);

      if (!options.skipIndex) {
        const indexResult = await indexProjectForRun(ctx, {
          projectDir,
          maxFiles: indexMaxFiles,
          refine: Boolean(options.refineIndex),
          forceRefine: Boolean(options.forceRefine),
          fullIndex: Boolean(options.fullIndex)
        });
        console.log(formatIndexResult(indexResult));
      }

      const queued = await queueWorkflow(ctx, {
        workflowId,
        projectPath: projectDir,
        task: options.task,
        policyProfile: options.policyProfile,
        sourceTokenBudget: options.sourceTokenBudget,
        sourceMaxFiles: options.sourceMaxFiles
      });

      if (!queued.ok) {
        console.error(queued.error);
        process.exitCode = 1;
        return;
      }

      console.log(`Queued workflow run ${queued.run.runId}`);
      console.log(`Project ${queued.run.projectId}`);
      console.log(`Workflow ${queued.workflow.id}`);
      console.log(`Queued ${queued.run.tasks} stage tasks`);

      const watchResult = await watchWorkflowRun({
        runId: queued.run.runId,
        workerLimit,
        workerConcurrency,
        projectRootUri: queued.projectDir,
        intervalMs,
        timeoutMs,
        onTick: (tick) => {
          if (tick.claimed > 0 || tick.failed > 0) {
            console.log(`Worker claimed ${tick.claimed}, completed ${tick.completed}, failed ${tick.failed}.`);
          }
        }
      });

      const outDir = path.resolve(process.cwd(), options.out ?? path.join(projectDir, ".agent-workflow", "exports"));
      const exportResult = await exportWorkflowRun({
        runId: queued.run.runId,
        outDir
      });
      if (!exportResult.ok) {
        console.error(`Unknown workflow run: ${queued.run.runId}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Run ${watchResult.status}`);
      console.log(`Tasks: ${watchResult.completedTasks}/${watchResult.totalTasks} completed, ${watchResult.failedTasks} failed.`);
      console.log(`Receipts: ${watchResult.receipts}`);
      console.log(`Exported Markdown: ${exportResult.markdownPath}`);
      console.log(`Exported JSON: ${exportResult.jsonPath}`);
      const summary = await summarizeWorkflowRun(queued.run.runId);
      if (summary.ok) {
        console.log("");
        console.log(formatRunSummary(summary.value));
      }

      if (watchResult.status !== "completed") {
        process.exitCode = watchResult.status === "failed" ? 1 : 2;
      }
    });

  program
    .command("agent-task")
    .description("Run one specialist agent directly, then export the result")
    .argument("<agent>", "agent id, display name, or alias")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("-t, --task <task>", "task description")
    .option("--policy-profile <name>", "execution policy profile (local, staging, production, or project-defined)")
    .option("--requester <name>", "who asked for this run (notified on block/approval)")
    .option("--requester-channel <channel>", "how to reach the requester: cli, dashboard, codex, command")
    .option("--skip-index", "skip project indexing before queueing")
    .option("--index-max-files <number>", "maximum project files to index first", "100")
    .option("--full-index", "force a full project index instead of the default incremental refresh")
    .option("--refine-index", "refine indexed summaries with the selected provider")
    .option("--force-refine", "refresh refined summaries even when content hash is unchanged")
    .option("--interval-ms <number>", "polling interval while waiting for run status", "1000")
    .option("--timeout-ms <number>", "maximum time to wait for completion", "600000")
    .option("-o, --out <dir>", "export directory; defaults to <project>/.agent-workflow/exports")
    .option("--source-token-budget <number>", "token budget for indexed source summaries")
    .option("--source-max-files <number>", "maximum indexed source summaries to include")
    .action(async (agentRef: string, options: {
      project: string;
      task: string;
      policyProfile?: string;
      requester?: string;
      requesterChannel?: string;
      skipIndex?: boolean;
      indexMaxFiles: string;
      fullIndex?: boolean;
      refineIndex?: boolean;
      forceRefine?: boolean;
      intervalMs: string;
      timeoutMs: string;
      out?: string;
      sourceTokenBudget?: string;
      sourceMaxFiles?: string;
    }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        console.error("\nStart local enterprise services with:");
        console.error("docker compose -f infra/docker-compose.yml up -d");
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const indexMaxFiles = parsePositiveInteger(options.indexMaxFiles, 100);
      const intervalMs = parsePositiveInteger(options.intervalMs, 1000);
      const timeoutMs = parsePositiveInteger(options.timeoutMs, 600000);
      const agents = await loadAgentsForProject(ctx, projectDir);
      const agent = resolveAgent(agents, agentRef);

      if (!agent) {
        console.error(`Unknown agent: ${agentRef}`);
        process.exitCode = 1;
        return;
      }

      if (!options.skipIndex) {
        const indexResult = await indexProjectForRun(ctx, {
          projectDir,
          maxFiles: indexMaxFiles,
          refine: Boolean(options.refineIndex),
          forceRefine: Boolean(options.forceRefine),
          fullIndex: Boolean(options.fullIndex)
        });
        console.log(formatIndexResult(indexResult));
      }

      const workflow = createAgentTaskWorkflow(agent);
      const builtinAgentIds = new Set((await loadAgents(ctx.rootDir)).map((item) => item.id));
      await seedRegistry(builtinAgentIds.has(agent.id) ? [] : [{
        path: `project/${agent.id}.yaml`,
        value: agent
      }], [{
        path: `runtime/${workflow.id}.yaml`,
        value: workflow
      }]);

      const queued = await queueWorkflow(ctx, {
        workflowId: workflow.id,
        projectPath: projectDir,
        task: options.task,
        policyProfile: options.policyProfile,
        workflowOverride: workflow,
        sourceTokenBudget: options.sourceTokenBudget,
        sourceMaxFiles: options.sourceMaxFiles,
        requester: options.requester,
        requesterChannel: options.requesterChannel
      });

      if (!queued.ok) {
        console.error(queued.error);
        process.exitCode = 1;
        return;
      }

      console.log(`Queued agent task run ${queued.run.runId}`);
      console.log(`Project ${queued.run.projectId}`);
      console.log(`Agent ${agent.id} (${agent.display_name})`);
      console.log(`Workflow ${queued.workflow.id}`);

      const watchResult = await watchWorkflowRun({
        runId: queued.run.runId,
        workerLimit: 1,
        intervalMs,
        timeoutMs,
        onTick: (tick) => {
          if (tick.claimed > 0 || tick.failed > 0) {
            console.log(`Worker claimed ${tick.claimed}, completed ${tick.completed}, failed ${tick.failed}.`);
          }
        }
      });

      const outDir = path.resolve(process.cwd(), options.out ?? path.join(projectDir, ".agent-workflow", "exports"));
      const exportResult = await exportWorkflowRun({
        runId: queued.run.runId,
        outDir
      });
      if (!exportResult.ok) {
        console.error(`Unknown workflow run: ${queued.run.runId}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Run ${watchResult.status}`);
      console.log(`Tasks: ${watchResult.completedTasks}/${watchResult.totalTasks} completed, ${watchResult.failedTasks} failed.`);
      console.log(`Receipts: ${watchResult.receipts}`);
      console.log(`Exported Markdown: ${exportResult.markdownPath}`);
      console.log(`Exported JSON: ${exportResult.jsonPath}`);
      const summary = await summarizeWorkflowRun(queued.run.runId);
      if (summary.ok) {
        console.log("");
        console.log(formatRunSummary(summary.value));
      }

      if (watchResult.status !== "completed") {
        process.exitCode = watchResult.status === "failed" ? 1 : 2;
      }
    });

  program
    .command("preset")
    .description("Run a named workflow preset")
    .argument("[preset]", "preset id or alias")
    .option("--list", "list available presets")
    .option("-p, --project <dir>", "override preset project directory")
    .option("-t, --task <task>", "override preset task description")
    .action(async (presetRef: string | undefined, options: { list?: boolean; project?: string; task?: string }) => {
      if (options.list || !presetRef) {
        printPresetList();
        return;
      }

      const result = await runWorkflowPreset(ctx, {
        presetRef,
        project: options.project,
        task: options.task
      });

      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }

      console.log(result.title);
      console.log("");
      console.log(result.output);
    });

  program
    .command("orchestrate")
    .description("Plan and run a natural-language task across the right agents and workflows")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("-t, --task <task>", "natural-language task description")
    .option("--dry-run", "print the orchestration plan without running it")
    .option("--execution-profile <profile>", "adaptive for one risk-scaled run, or full for exhaustive orchestration", "adaptive")
    .option("--index-max-files <number>", "maximum project files to index before each step", "100")
    .option("--refine-index", "refine indexed summaries with the selected provider")
    .option("--force-refine", "refresh refined summaries even when content hash is unchanged")
    .option("--worker-limit <number>", "maximum workflow tasks to process per worker tick", "6")
    .option("--worker-concurrency <number>", "maximum workflow tasks to execute at the same time per worker tick", "1")
    .option("--timeout-ms <number>", "maximum time to wait for each step", "900000")
    .option("-o, --out <dir>", "export directory; defaults to <project>/.agent-workflow/exports")
    .action(async (options: {
      project: string;
      task: string;
      dryRun?: boolean;
      executionProfile: string;
      indexMaxFiles: string;
      refineIndex?: boolean;
      forceRefine?: boolean;
      workerLimit: string;
      workerConcurrency: string;
      timeoutMs: string;
      out?: string;
    }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        console.error("\nStart local enterprise services with:");
        console.error("docker compose -f infra/docker-compose.yml up -d");
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const plan = createOrchestrationPlan({ projectDir, task: options.task, executionProfile: parseExecutionProfile(options.executionProfile) });
      if (options.dryRun) {
        console.log(formatOrchestrationPlan(plan));
        return;
      }

      const result = await runOrchestrationPlan(plan, {
        indexMaxFiles: parsePositiveInteger(options.indexMaxFiles, 100),
        refineIndex: Boolean(options.refineIndex),
        forceRefine: Boolean(options.forceRefine),
        workerLimit: parsePositiveInteger(options.workerLimit, 6),
        workerConcurrency: parseBoundedPositiveInteger(options.workerConcurrency, 1, 16),
        timeoutMs: parsePositiveInteger(options.timeoutMs, 900000),
        outDir: options.out ? path.resolve(process.cwd(), options.out) : undefined
      });

      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }

      console.log(result.title);
      console.log("");
      console.log(result.output);
    });

  program
    .command("status")
    .description("Show recent workflow runs or details for a run")
    .option("-r, --run <id>", "workflow run id")
    .option("-l, --limit <number>", "number of recent runs", "10")
    .option("--artifacts", "include artifact URIs when inspecting a run")
    .option("--json", "print JSON")
    .action(async (options: { run?: string; limit: string; artifacts?: boolean; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      if (options.run) {
        const [details, historicalRuns, approvals] = await Promise.all([
          getWorkflowRunDetails(options.run),
          listWorkflowRuns(250),
          listActionApprovals({ runId: options.run, limit: 100 })
        ]);
        if (!details.run) {
          console.error(`Unknown workflow run: ${options.run}`);
          process.exitCode = 1;
          return;
        }

        if (options.json) {
          const payload: { run: unknown; eta: RunEta; stages: unknown; receipts: unknown; approvals: unknown; artifacts?: unknown } = {
            run: details.run,
            eta: estimateRunEta({ run: details.run, tasks: details.tasks, historicalRuns }),
            stages: details.tasks,
            receipts: details.receipts,
            approvals: approvals.map((approval) => ({
              approvalId: approval.id,
              runId: approval.runId,
              stageId: approval.stageId,
              actionType: approval.actionType,
              target: approval.target,
              rationale: approval.rationale,
              status: approval.status,
              allowedDecisions: ["approve", "approve-and-execute", "reject"],
              actionEndpoint: "/api/server-approval-action"
            }))
          };
          if (options.artifacts) {
            payload.artifacts = await listArtifacts({ runId: options.run });
          }
          console.log(JSON.stringify(payload, null, 2));
          return;
        }

        console.log(`${details.run.id} ${details.run.status} ${details.run.workflowId}`);
        console.log(`Task: ${details.run.task}`);
        console.log(`Autonomy: ${details.run.autonomy}`);
        console.log(`Policy profile: ${details.run.policyProfile}`);
        console.log(`Policy snapshot: ${details.run.policySnapshotHash || "legacy run"}`);
        console.log(`ETA: ${formatRunEta(estimateRunEta({ run: details.run, tasks: details.tasks, historicalRuns }))}`);
        console.log("");
        console.log("Stages");
        for (const task of details.tasks) {
          const executor = task.executorSnapshot ? ` executor=${task.executorSnapshot.executorId}/${task.executorSnapshot.operation}@${task.executorSnapshot.requestedHost}` : "";
          console.log(`- ${task.stageId}: ${task.agentId} ${task.status} attempts=${task.attempts}${executor}`);
        }
        console.log("");
        console.log("Receipts");
        for (const receipt of details.receipts) {
          console.log(`- ${receipt.actionType} ${receipt.agentId}: ${receipt.summary}`);
        }
        if (approvals.length) {
          console.log("");
          console.log("Approvals");
          for (const approval of approvals) {
            console.log(`- ${approval.id} ${approval.status} ${approval.actionType}: ${approval.target}`);
            console.log(`  ${approval.rationale}`);
          }
        }
        if (options.artifacts) {
          const artifacts = await listArtifacts({ runId: options.run });
          console.log("");
          console.log("Artifacts");
          for (const artifact of artifacts) {
            console.log(`- ${artifact.kind}: ${artifact.uri}`);
          }
        }
        return;
      }

      const limit = Number.parseInt(options.limit, 10);
      const runs = await listWorkflowRuns(Number.isFinite(limit) && limit > 0 ? limit : 10);
      if (options.json) {
        console.log(JSON.stringify(runs.map((run) => ({ ...run, eta: estimateRunEta({ run, tasks: [{ status: run.status }], historicalRuns: runs }) })), null, 2));
        return;
      }
      for (const run of runs) {
        const eta = estimateRunEta({ run, tasks: [{ status: run.status }], historicalRuns: runs });
        console.log(`${run.id} ${run.status} ${run.workflowId} ETA=${formatRunEta(eta)} - ${run.task}`);
      }
    });

  program
    .command("resume-run")
    .description("Resume an interrupted run from the last completed checkpoint")
    .requiredOption("-r, --run <id>", "workflow run id")
    .option("--include-failed", "also requeue failed stages after preserving completed checkpoints")
    .option("--revalidate-source", "bind fresh recovery acceptance to the current frozen source scope")
    .option("--reason <text>", "receipt reason", "Checkpoint resume requested from CLI.")
    .action(async (options: { run: string; includeFailed?: boolean; revalidateSource?: boolean; reason: string }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const staleReport = await assessRunStaleInputs(ctx, options.run);
      let revalidatedSubjectHash: string | undefined;
      if (options.revalidateSource) {
        if (!options.includeFailed) throw new Error("Source revalidation requires terminal replacement recovery.");
        const details = await getWorkflowRunDetails(options.run);
        const contract = details.run?.evaluationMetadata.acceptanceContract as StructuredAcceptanceContract | undefined;
        if (!details.run?.projectRootUri || !contract?.sourcePaths?.length) throw new Error("Source revalidation requires an enrolled frozen source scope.");
        revalidatedSubjectHash = await sourceSubjectHash(details.run.projectRootUri, contract.sourcePaths);
      }
      const result = await resumeWorkflowRunFromCheckpoint({
        runId: options.run,
        actor: "cli",
        reason: options.reason,
        includeFailed: options.includeFailed === true,
        revalidatedSubjectHash
      });
      if (result.totalTasks === 0) {
        console.error(`Run cannot be resumed or does not exist: ${options.run}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Run: ${options.run}`);
      console.log(`Completed checkpoints preserved: ${result.completedTasks}/${result.totalTasks}`);
      console.log(`Requeued unfinished stages: ${result.requeuedTasks}`);
      if (result.replacementRunId) {
        console.log(`Replacement run: ${result.replacementRunId}`);
        console.log("The source run remains terminal and immutable; process the replacement run.");
      }
      console.log(formatStaleInputWarnings(staleReport).join("\n"));
      console.log("Process queued stages with:");
      console.log(result.replacementRunId
        ? `npm run worker -- --limit 6 # replacement ${result.replacementRunId}`
        : "npm run worker -- --limit 6");
    });

  program
    .command("dismiss")
    .description("Dismiss a failed or blocked run: moves it to cancelled so it no longer appears in queues")
    .argument("<run-id>", "workflow run id to dismiss")
    .option("--reason <text>", "reason recorded in the dismissal receipt", "Dismissed from CLI.")
    .option("--actor <name>", "person or tool dismissing", process.env.AGENTFLOW_REQUESTER ?? process.env.USER ?? "cli")
    .action(async (runId: string, options: { reason: string; actor: string }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }
      const ok = await dismissFailedWorkflowRun({ runId, actor: options.actor, reason: options.reason });
      if (!ok) {
        console.error(`Could not dismiss run ${runId}: not found or not in a dismissible state (failed/blocked/cancelled).`);
        process.exitCode = 1;
        return;
      }
      console.log(`Dismissed run ${runId}.`);
    });

  program
    .command("replay-run")
    .description("Create a new queued run from an existing run's stored task, policy, provider, and compiled context")
    .requiredOption("-r, --run <id>", "source workflow run id")
    .option("--reason <text>", "receipt reason", "Deterministic replay requested from CLI.")
    .option("--acceptance-requirements <file>", "explicit pending acceptance requirements for a legacy source; frozen contracts cannot be replaced")
    .option("--revalidate-source", "explicitly bind a clean replay to current bytes of the unchanged frozen source scope")
    .action(async (options: { run: string; reason: string; acceptanceRequirements?: string; revalidateSource?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const staleReport = await assessRunStaleInputs(ctx, options.run);
      let revalidatedSubjectHash: string | undefined;
      if (options.revalidateSource) {
        if (options.acceptanceRequirements) throw new Error("Choose legacy enrollment or frozen source revalidation, not both.");
        const details = await getWorkflowRunDetails(options.run);
        const contract = details.run?.evaluationMetadata.acceptanceContract as StructuredAcceptanceContract | undefined;
        if (!details.run?.projectRootUri || !contract?.sourcePaths?.length) throw new Error("Source revalidation requires an enrolled frozen source scope.");
        revalidatedSubjectHash = await sourceSubjectHash(details.run.projectRootUri, contract.sourcePaths);
      }
      let acceptanceRequirements: Pick<StructuredAcceptanceContract, "subjectHash" | "sourcePaths" | "deliverables"> | undefined;
      if (options.acceptanceRequirements) {
        const file = path.resolve(options.acceptanceRequirements);
        if ((await fs.stat(file)).size > 256_000) throw new Error("Acceptance requirements exceed 256000 bytes.");
        const requirements = JSON.parse(await fs.readFile(file, "utf8"));
        if (!Array.isArray(requirements.sourcePaths) || !Array.isArray(requirements.deliverables)) throw new Error("Acceptance requirements need sourcePaths and pending deliverables.");
        const details = await getWorkflowRunDetails(options.run);
        if (!details.run?.projectRootUri) throw new Error("Replay source project root is unavailable.");
        acceptanceRequirements = { sourcePaths: requirements.sourcePaths, deliverables: requirements.deliverables,
          subjectHash: await sourceSubjectHash(details.run.projectRootUri, requirements.sourcePaths) };
      }
      const result = await replayWorkflowRun({
        sourceRunId: options.run,
        actor: "cli",
        reason: options.reason,
        acceptanceRequirements,
        revalidatedSubjectHash
      });
      if (!result) {
        console.error(`Unknown workflow run: ${options.run}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Replayed source run ${options.run}`);
      console.log(`Queued workflow run ${result.runId}`);
      console.log(`Project ${result.projectId}`);
      console.log(`Queued ${result.tasks} stage tasks`);
      console.log(formatStaleInputWarnings(staleReport).join("\n"));
      console.log("Process queued stages with:");
      console.log("npm run worker -- --limit 6");
    });

  program
    .command("export-run")
    .description("Export a workflow run report as Markdown and JSON")
    .requiredOption("-r, --run <id>", "workflow run id")
    .option("-o, --out <dir>", "export directory", "exports/runs")
    .option("--scrub", "redact secrets and high-risk project details for sharing")
    .action(async (options: { run: string; out: string; scrub?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const exportResult = await exportWorkflowRun({
        runId: options.run,
        outDir: path.resolve(process.cwd(), options.out),
        scrub: Boolean(options.scrub)
      });
      if (!exportResult.ok) {
        console.error(`Unknown workflow run: ${options.run}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Exported Markdown: ${exportResult.markdownPath}`);
      console.log(`Exported JSON: ${exportResult.jsonPath}`);
    });

  program
    .command("summarize-run")
    .description("Print a compact decision-ready summary for a workflow run")
    .requiredOption("-r, --run <id>", "workflow run id")
    .option("--json", "print summary JSON")
    .action(async (options: { run: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const summary = await summarizeWorkflowRun(options.run);
      if (!summary.ok) {
        console.error(`Unknown workflow run: ${options.run}`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(summary.value, null, 2));
        return;
      }

      console.log(formatRunSummary(summary.value));
    });

  program
    .command("evaluate")
    .description("Run a synthetic or project-local evaluation suite across provider, tier, and prompt variants")
    .requiredOption("-s, --suite <file>", "evaluation suite YAML file")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--dry-run", "validate and print the evaluation matrix without running it")
    .option("--skip-index", "skip project indexing before evaluation")
    .option("--index-max-files <number>", "maximum project files to index first", "100")
    .option("--full-index", "force a full project index instead of the default incremental refresh")
    .option("--worker-limit <number>", "maximum tasks to process per worker tick", "6")
    .option("--worker-concurrency <number>", "maximum tasks to execute at the same time per worker tick", "1")
    .option("--timeout-ms <number>", "maximum time to wait for each run", "900000")
    .option("-o, --out <dir>", "report directory; defaults to <project>/.agent-workflow/evaluations")
    .option("--scoring-profile <file>", "private scoring YAML under <project>/.agent-workflow/evaluations")
    .action(async (options: {
      suite: string;
      project: string;
      dryRun?: boolean;
      skipIndex?: boolean;
      indexMaxFiles: string;
      fullIndex?: boolean;
      workerLimit: string;
      workerConcurrency: string;
      timeoutMs: string;
      out?: string;
      scoringProfile?: string;
    }) => {
      const suitePath = path.resolve(process.cwd(), options.suite);
      const suite = evaluationSuiteSchema.parse(YAML.parse(await fs.readFile(suitePath, "utf8")));
      const projectDir = path.resolve(process.cwd(), options.project);
      const scoring = options.scoringProfile ? await loadPrivateEvaluationScoring(projectDir, options.scoringProfile) : undefined;
      const matrix = suite.cases.flatMap((testCase) => suite.variants.map((variant) => ({ testCase, variant })));

      console.log(`Evaluation ${suite.id}: ${matrix.length} run(s), workflow ${suite.workflow}`);
      console.log(`Scoring: ${scoring ? `${scoring.profile.id} (${scoring.checksum})` : "shared default ranking"}`);
      for (const item of matrix) {
        console.log(`- ${item.testCase.id} / ${item.variant.id}: ${item.variant.provider} ${item.variant.model_tier}`);
      }
      if (options.dryRun) {
        return;
      }

      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      if (!options.skipIndex) {
        const indexed = await indexProjectForRun(ctx, {
          projectDir,
          maxFiles: parsePositiveInteger(options.indexMaxFiles, 100),
          refine: false,
          forceRefine: false,
          fullIndex: Boolean(options.fullIndex)
        });
        console.log(formatIndexResult(indexed));
      }

      const observations: EvaluationObservation[] = [];
      for (const item of matrix) {
        const task = item.variant.prompt_suffix
          ? `${item.testCase.task}\n\nEvaluation prompt variant instructions:\n${item.variant.prompt_suffix}`
          : item.testCase.task;
        const queued = await queueWorkflow(ctx, {
          workflowId: suite.workflow,
          projectPath: projectDir,
          task,
          policyProfile: "evaluation",
          modelTierOverride: item.variant.model_tier,
          providerOverride: item.variant.provider,
          evaluationMetadata: {
            suiteId: suite.id,
            suiteName: suite.name,
            caseId: item.testCase.id,
            variantId: item.variant.id,
            promptSuffix: item.variant.prompt_suffix
          }
        });
        if (!queued.ok) {
          throw new Error(`Could not queue ${item.testCase.id}/${item.variant.id}: ${queued.error}`);
        }
        console.log(`Running ${item.testCase.id}/${item.variant.id}: ${queued.run.runId}`);
        await watchWorkflowRun({
          runId: queued.run.runId,
          workerLimit: parsePositiveInteger(options.workerLimit, 6),
          workerConcurrency: parseBoundedPositiveInteger(options.workerConcurrency, 1, 16),
          projectRootUri: projectDir,
          intervalMs: 1000,
          timeoutMs: parsePositiveInteger(options.timeoutMs, 900000)
        });
        const report = await loadCostQualityReport(queued.run.runId);
        if (!report) {
          throw new Error(`Evaluation run disappeared: ${queued.run.runId}`);
        }
        observations.push({
          caseId: item.testCase.id,
          variantId: item.variant.id,
          runId: queued.run.runId,
          report
        });
      }

      const report = buildEvaluationReport(suite, observations, scoring);
      const outDir = path.resolve(process.cwd(), options.out ?? path.join(projectDir, ".agent-workflow", "evaluations"));
      await fs.mkdir(outDir, { recursive: true });
      const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
      const jsonPath = path.join(outDir, `${suite.id}-${stamp}.json`);
      const markdownPath = path.join(outDir, `${suite.id}-${stamp}.md`);
      await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      await fs.writeFile(markdownPath, `${formatEvaluationReport(report)}\n`, "utf8");
      console.log("");
      console.log(formatEvaluationReport(report));
      console.log("");
      console.log(`JSON: ${jsonPath}`);
      console.log(`Markdown: ${markdownPath}`);
      if (report.rows.some((row) => !row.passed)) {
        process.exitCode = 2;
      }
    });

  program
    .command("observe")
    .description("Export OpenTelemetry-compatible spans and metrics for a workflow run")
    .requiredOption("-r, --run <id>", "workflow run id")
    .option("--json", "print OpenTelemetry-style JSON")
    .action(async (options: { run: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const report = await loadObservabilityReport(ctx, options.run);
      if (!report) {
        console.error(`Unknown workflow run: ${options.run}`);
        process.exitCode = 1;
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(formatObservabilityReport(report));
    });

  program
    .command("gate")
    .description("Evaluate a workflow run against project-local quality, latency, fallback, and cost gates")
    .requiredOption("-r, --run <id>", "candidate workflow run id")
    .option("-p, --project <dir>", "project directory; defaults to the run project")
    .option("-g, --gate <file>", "gate YAML file; defaults to <project>/.agent-workflow/evaluation-gates.yaml")
    .option("--baseline-run <id>", "baseline workflow run id for regression budgets")
    .option("--json", "print report JSON")
    .action(async (options: { run: string; project?: string; gate?: string; baselineRun?: string; json?: boolean }) => {
      const serviceChecks = await checkServices();
      const missing = serviceChecks.filter((check) => !check.reachable);
      if (missing.length) {
        for (const check of missing) {
          console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
        }
        process.exitCode = 1;
        return;
      }

      const candidate = await loadCostQualityReport(options.run);
      if (!candidate) {
        console.error(`Unknown workflow run: ${options.run}`);
        process.exitCode = 1;
        return;
      }
      const details = await getWorkflowRunDetails(options.run);
      const projectDir = path.resolve(process.cwd(), options.project ?? details.run?.projectRootUri ?? ".");
      const gatePath = path.resolve(process.cwd(), options.gate ?? path.join(projectDir, ".agent-workflow", "evaluation-gates.yaml"));
      let gateRaw = "";
      try {
        gateRaw = await fs.readFile(gatePath, "utf8");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          console.error(`Gate config not found: ${gatePath}`);
          console.error("Create one at <project>/.agent-workflow/evaluation-gates.yaml or pass --gate <file>.");
          process.exitCode = 1;
          return;
        }
        throw error;
      }
      const gate = evaluationGateSchema.parse(YAML.parse(gateRaw));
      const baselineRunId = options.baselineRun ?? gate.baseline_run_id;
      const baseline = baselineRunId ? await loadCostQualityReport(baselineRunId) : null;
      if (baselineRunId && !baseline) {
        console.error(`Unknown baseline workflow run: ${baselineRunId}`);
        process.exitCode = 1;
        return;
      }

      const report = buildEvaluationGateReport({ gate, candidate, baseline });
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatEvaluationGateReport(report));
      }
      if (!report.passed) {
        process.exitCode = 2;
      }
    });

}
