#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import dotenv from "dotenv";
import YAML from "yaml";
import {
  byId,
  loadAgentRecords,
  loadAgents,
  loadProjectConfig,
  loadYamlFile,
  loadWorkflowRecords,
  loadWorkflows
} from "../../../packages/agent-registry/src/loaders.js";
import { agentCardSchema, type AgentCard } from "../../../packages/agent-registry/src/schemas.js";
import { compileContext } from "../../../packages/context-compiler/src/index.js";
import { selectRelevantSourceSummaries } from "../../../packages/context-selector/src/index.js";
import { evaluateAgentAutonomy } from "../../../packages/policy-engine/src/index.js";
import { executeAllowedCommand } from "../../../packages/local-tools/src/command-executor.js";
import { indexProjectFiles } from "../../../packages/project-indexer/src/index.js";
import { checkServices } from "../../../packages/storage/src/doctor.js";
import {
  createWorkflowRun,
  getArtifactByUri,
  getWorkflowRunDetails,
  listArtifacts,
  listProjectFileSummaries,
  listWorkflowRuns,
  migrateStorage,
  recordRunAction,
  resetStorage,
  seedRegistry,
  upsertProject,
  upsertProjectFiles
} from "../../../packages/storage/src/postgres.js";
import { runWorkerOnce, runWorkerWatch } from "../../../packages/workflow-engine/src/executor.js";
import { providerFromEnv } from "../../../packages/model-providers/src/index.js";
import { buildRunExport } from "../../../packages/run-reporter/src/index.js";

const program = new Command();
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });

program
  .name("agentflow")
  .description("Portable, model-agnostic agent workflow runner")
  .version("0.1.0");

program
  .command("list")
  .description("List available agents and workflows")
  .option("-p, --project <dir>", "include project-local agents from .agent-workflow/agents")
  .action(async (options: { project?: string }) => {
    const agents = options.project
      ? await loadAgentsForProject(path.resolve(process.cwd(), options.project))
      : await loadAgents(rootDir);
    const workflows = await loadWorkflows(rootDir);

    console.log("Agents");
    for (const agent of agents) {
      console.log(`- ${agent.id} (${agent.display_name}) [${agent.category}] autonomy=${agent.autonomy}`);
    }

    console.log("\nWorkflows");
    for (const workflow of workflows) {
      console.log(`- ${workflow.id}: ${workflow.name} lead=${workflow.lead}`);
    }
  });

program
  .command("validate")
  .description("Validate agent cards and workflow definitions")
  .action(async () => {
    const agents = await loadAgents(rootDir);
    const workflows = await loadWorkflows(rootDir);
    const agentIds = new Set(agents.map((agent) => agent.id));
    const errors: string[] = [];

    for (const workflow of workflows) {
      if (!agentIds.has(workflow.lead)) {
        errors.push(`workflow ${workflow.id} references missing lead agent ${workflow.lead}`);
      }

      for (const stage of workflow.stages) {
        if (!agentIds.has(stage.agent)) {
          errors.push(`workflow ${workflow.id} stage ${stage.id} references missing agent ${stage.agent}`);
        }

        for (const subagent of stage.subagents) {
          if (!agentIds.has(subagent)) {
            errors.push(`workflow ${workflow.id} stage ${stage.id} references missing subagent ${subagent}`);
          }
        }
      }
    }

    if (errors.length) {
      for (const error of errors) {
        console.error(`ERROR: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`Validated ${agents.length} agents and ${workflows.length} workflows.`);
  });

program
  .command("doctor")
  .description("Check local enterprise services and workflow definitions")
  .option("--simple", "skip enterprise service checks")
  .action(async (options: { simple?: boolean }) => {
    const agents = await loadAgents(rootDir);
    const workflows = await loadWorkflows(rootDir);
    console.log(`Definitions: ${agents.length} agents, ${workflows.length} workflows`);

    if (options.simple) {
      console.log("Simple profile: enterprise service checks skipped.");
      return;
    }

    const checks = await checkServices();
    let failed = false;
    for (const check of checks) {
      const status = check.reachable ? "OK" : "MISSING";
      console.log(`${status}: ${check.endpoint.name} - ${check.message}`);
      if (!check.reachable && check.endpoint.requiredFor === "enterprise") {
        failed = true;
      }
    }

    if (failed) {
      console.log("\nStart local enterprise services with:");
      console.log("docker compose -f infra/docker-compose.yml up -d");
      process.exitCode = 1;
    }
  });

program
  .command("provider-check")
  .description("Check selected model provider configuration")
  .action(async () => {
    const provider = providerFromEnv();
    if (!provider.check) {
      console.log(`Provider ready: ${provider.id}`);
      return;
    }

    const result = await provider.check();
    for (const detail of result.details) {
      console.log(detail);
    }
    if (!result.ready) {
      console.error(`Provider not ready: ${provider.id}`);
      process.exitCode = 1;
      return;
    }

    console.log(`Provider ready: ${provider.id}`);
  });

program
  .command("init-project")
  .description("Install AGENTS.md and .agent-workflow files into a project")
  .option("-p, --project <dir>", "project directory", ".")
  .option("--profile <profile>", "enterprise, simple, or tellara", "enterprise")
  .option("--force", "overwrite existing files")
  .action(async (options: { project: string; profile: string; force?: boolean }) => {
    if (!["enterprise", "simple", "tellara"].includes(options.profile)) {
      console.error(`Unknown profile: ${options.profile}. Use enterprise, simple, or tellara.`);
      process.exitCode = 1;
      return;
    }

    const projectDir = path.resolve(process.cwd(), options.project);
    const templateDir = path.join(rootDir, "templates", templateNameForProfile(options.profile));
    const result = await copyTemplate(templateDir, projectDir, Boolean(options.force));
    console.log(`Initialized ${options.profile} agent workflow files in ${projectDir}`);
    console.log(`Wrote ${result.written}; skipped ${result.skipped}.`);
    console.log("");
    console.log("Next steps:");
    console.log(`  npm run index-project -- --project ${projectDir}`);
    console.log(`  npm run agentflow -- run build-feature --project ${projectDir} --task "<task>" --no-brief`);
    if (options.profile === "simple") {
      console.log(`  npm run compile -- --workflow build-feature --project ${projectDir} --task "<task>"`);
    } else {
      console.log("  npm run worker -- --limit 6");
    }
  });

program
  .command("bootstrap-storage")
  .description("Seed enterprise storage with agent and workflow registry definitions")
  .action(async () => {
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

    const agents = await loadAgentRecords(rootDir);
    const workflows = await loadWorkflowRecords(rootDir);
    const result = await seedRegistry(agents, workflows);
    console.log(`Seeded ${result.agents} agents and ${result.workflows} workflows into enterprise storage.`);
  });

program
  .command("migrate-storage")
  .description("Apply additive enterprise storage migrations")
  .action(async () => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }

    await migrateStorage();
    console.log("Storage migrations applied.");
  });

program
  .command("reset-storage")
  .description("Clear local enterprise run history and indexed project data")
  .option("--include-registry", "also remove seeded agent and workflow definitions")
  .option("--yes", "confirm destructive cleanup")
  .action(async (options: { includeRegistry?: boolean; yes?: boolean }) => {
    if (!options.yes) {
      console.error("Refusing to reset storage without --yes.");
      console.error("This deletes local workflow runs, tasks, receipts, artifacts, indexed project files, memory, and projects.");
      console.error("Use --include-registry to also delete seeded agent and workflow definitions.");
      process.exitCode = 1;
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

    const result = await resetStorage({ includeRegistry: Boolean(options.includeRegistry) });
    console.log("Storage reset complete.");
    console.log(`Deleted artifacts: ${result.artifacts}`);
    console.log(`Deleted action receipts: ${result.actionReceipts}`);
    console.log(`Deleted workflow tasks: ${result.workflowTasks}`);
    console.log(`Deleted workflow runs: ${result.workflowRuns}`);
    console.log(`Deleted project files: ${result.projectFiles}`);
    console.log(`Deleted memory items: ${result.memoryItems}`);
    console.log(`Deleted projects: ${result.projects}`);
    if (options.includeRegistry) {
      console.log(`Deleted workflows: ${result.workflows ?? 0}`);
      console.log(`Deleted agents: ${result.agents ?? 0}`);
      console.log("Run `npm run bootstrap-storage` before queueing workflows.");
    }
  });

program
  .command("index-project")
  .description("Index project files into durable compact summaries")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--max-files <number>", "maximum files to index", "200")
  .option("--refine", "refine file summaries with the selected provider")
  .option("--force-refine", "refresh refined summaries even when content hash is unchanged")
  .action(async (options: { project: string; maxFiles: string; refine?: boolean; forceRefine?: boolean }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const projectDir = path.resolve(process.cwd(), options.project);
    const project = await loadProjectConfig(projectDir);
    const maxFiles = Number.parseInt(options.maxFiles, 10);
    const projectId = await upsertProject({
      name: project.project.name,
      rootUri: projectDir,
      profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
      config: project
    });
    const existingSummaries = await listProjectFileSummaries({
      projectRootUri: projectDir,
      limit: 1000
    });
    const result = await indexProjectFiles({
      projectDir,
      project,
      maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 200,
      refineProvider: options.refine ? providerFromEnv() : undefined,
      existingSummaries,
      forceRefine: Boolean(options.forceRefine)
    });

    const count = await upsertProjectFiles({ projectId, files: result.files });
    const skipped = result.files.filter((file) => file.metadata.skipped).length;
    console.log(`Indexed ${count} files for ${project.project.name}.`);
    if (options.refine) {
      console.log(`Refined ${result.refined}; reused ${result.reused}.`);
    }
    if (skipped) {
      console.log(`Skipped ${skipped} large files.`);
    }
  });

program
  .command("project-files")
  .description("List indexed project file summaries")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("-l, --limit <number>", "number of files to show", "50")
  .action(async (options: { project: string; limit: string }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const limit = Number.parseInt(options.limit, 10);
    const summaries = await listProjectFileSummaries({
      projectRootUri: projectDir,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 50
    });

    if (!summaries.length) {
      console.log("No indexed project files found.");
      return;
    }

    for (const summary of summaries) {
      console.log(`${summary.sourceUri} tokens=${summary.tokenEstimate}`);
      console.log(`  ${summary.summary.split("\n").join("\n  ")}`);
    }
  });

program
  .command("compile")
  .description("Compile a compact workflow brief for a project task")
  .requiredOption("-w, --workflow <id>", "workflow id")
  .requiredOption("-p, --project <dir>", "project directory")
  .requiredOption("-t, --task <task>", "task description")
  .option("--source-token-budget <number>", "token budget for indexed source summaries")
  .option("--source-max-files <number>", "maximum indexed source summaries to include")
  .action(async (options: { workflow: string; project: string; task: string; sourceTokenBudget?: string; sourceMaxFiles?: string }) => {
    const agents = await loadAgents(rootDir);
    const workflows = await loadWorkflows(rootDir);
    const workflow = resolveWorkflow(workflows, options.workflow);

    if (!workflow) {
      console.error(`Unknown workflow: ${options.workflow}`);
      process.exitCode = 1;
      return;
    }

    const projectDir = path.resolve(process.cwd(), options.project);
    const project = await loadProjectConfig(projectDir);
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
      })
    });

    console.log(brief);
  });

program
  .command("run")
  .description("Queue a workflow run in enterprise storage and print the compiled brief")
  .argument("<workflow>", "workflow id")
  .requiredOption("-p, --project <dir>", "project directory")
  .requiredOption("-t, --task <task>", "task description")
  .option("--no-brief", "queue the run without printing the compiled brief")
  .option("--source-token-budget <number>", "token budget for indexed source summaries")
  .option("--source-max-files <number>", "maximum indexed source summaries to include")
  .action(async (workflowId: string, options: { project: string; task: string; brief?: boolean; sourceTokenBudget?: string; sourceMaxFiles?: string }) => {
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

    const result = await queueWorkflow({
      workflowId,
      projectPath: options.project,
      task: options.task,
      sourceTokenBudget: options.sourceTokenBudget,
      sourceMaxFiles: options.sourceMaxFiles
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
  .option("--skip-index", "skip project indexing before queueing")
  .option("--index-max-files <number>", "maximum project files to index first", "100")
  .option("--refine-index", "refine indexed summaries with the selected provider")
  .option("--force-refine", "refresh refined summaries even when content hash is unchanged")
  .option("--worker-limit <number>", "maximum tasks to process per worker tick", "6")
  .option("--interval-ms <number>", "polling interval while waiting for run status", "1000")
  .option("--timeout-ms <number>", "maximum time to wait for completion", "900000")
  .option("-o, --out <dir>", "export directory; defaults to <project>/.agent-workflow/exports")
  .option("--source-token-budget <number>", "token budget for indexed source summaries")
  .option("--source-max-files <number>", "maximum indexed source summaries to include")
  .action(async (workflowId: string, options: {
    project: string;
    task: string;
    skipIndex?: boolean;
    indexMaxFiles: string;
    refineIndex?: boolean;
    forceRefine?: boolean;
    workerLimit: string;
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
    const intervalMs = parsePositiveInteger(options.intervalMs, 1000);
    const timeoutMs = parsePositiveInteger(options.timeoutMs, 900000);

    if (!options.skipIndex) {
      const indexResult = await indexProjectForRun({
        projectDir,
        maxFiles: indexMaxFiles,
        refine: Boolean(options.refineIndex),
        forceRefine: Boolean(options.forceRefine)
      });
      console.log(`Indexed ${indexResult.count} files for ${indexResult.projectName}.`);
      if (options.refineIndex) {
        console.log(`Refined ${indexResult.refined}; reused ${indexResult.reused}.`);
      }
      if (indexResult.skipped) {
        console.log(`Skipped ${indexResult.skipped} large files.`);
      }
    }

    const queued = await queueWorkflow({
      workflowId,
      projectPath: projectDir,
      task: options.task,
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
  .option("--skip-index", "skip project indexing before queueing")
  .option("--index-max-files <number>", "maximum project files to index first", "100")
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
    skipIndex?: boolean;
    indexMaxFiles: string;
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
    const agents = await loadAgentsForProject(projectDir);
    const agent = resolveAgent(agents, agentRef);

    if (!agent) {
      console.error(`Unknown agent: ${agentRef}`);
      process.exitCode = 1;
      return;
    }

    if (!options.skipIndex) {
      const indexResult = await indexProjectForRun({
        projectDir,
        maxFiles: indexMaxFiles,
        refine: Boolean(options.refineIndex),
        forceRefine: Boolean(options.forceRefine)
      });
      console.log(`Indexed ${indexResult.count} files for ${indexResult.projectName}.`);
      if (options.refineIndex) {
        console.log(`Refined ${indexResult.refined}; reused ${indexResult.reused}.`);
      }
      if (indexResult.skipped) {
        console.log(`Skipped ${indexResult.skipped} large files.`);
      }
    }

    const workflow = createAgentTaskWorkflow(agent);
    const builtinAgentIds = new Set((await loadAgents(rootDir)).map((item) => item.id));
    await seedRegistry(builtinAgentIds.has(agent.id) ? [] : [{
      path: `project/${agent.id}.yaml`,
      value: agent
    }], [{
      path: `runtime/${workflow.id}.yaml`,
      value: workflow
    }]);

    const queued = await queueWorkflow({
      workflowId: workflow.id,
      projectPath: projectDir,
      task: options.task,
      workflowOverride: workflow,
      sourceTokenBudget: options.sourceTokenBudget,
      sourceMaxFiles: options.sourceMaxFiles
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
  .command("status")
  .description("Show recent workflow runs or details for a run")
  .option("-r, --run <id>", "workflow run id")
  .option("-l, --limit <number>", "number of recent runs", "10")
  .option("--artifacts", "include artifact URIs when inspecting a run")
  .action(async (options: { run?: string; limit: string; artifacts?: boolean }) => {
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
      const details = await getWorkflowRunDetails(options.run);
      if (!details.run) {
        console.error(`Unknown workflow run: ${options.run}`);
        process.exitCode = 1;
        return;
      }

      console.log(`${details.run.id} ${details.run.status} ${details.run.workflowId}`);
      console.log(`Task: ${details.run.task}`);
      console.log(`Autonomy: ${details.run.autonomy}`);
      console.log("");
      console.log("Stages");
      for (const task of details.tasks) {
        console.log(`- ${task.stageId}: ${task.agentId} ${task.status} attempts=${task.attempts}`);
      }
      console.log("");
      console.log("Receipts");
      for (const receipt of details.receipts) {
        console.log(`- ${receipt.actionType} ${receipt.agentId}: ${receipt.summary}`);
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
    for (const run of runs) {
      console.log(`${run.id} ${run.status} ${run.workflowId} - ${run.task}`);
    }
  });

program
  .command("artifacts")
  .description("Inspect compiled briefs and stage output artifacts")
  .option("-r, --run <id>", "workflow run id")
  .option("-k, --kind <kind>", "artifact kind, for example compiled_brief or stage_output")
  .option("-u, --uri <uri>", "specific artifact URI")
  .option("--json", "print full artifact JSON")
  .option("--content", "print artifact content only")
  .action(async (options: { run?: string; kind?: string; uri?: string; json?: boolean; content?: boolean }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }

    if (options.uri) {
      const artifact = await getArtifactByUri(options.uri);
      if (!artifact) {
        console.error(`Unknown artifact URI: ${options.uri}`);
        process.exitCode = 1;
        return;
      }
      printArtifact(artifact, Boolean(options.json), Boolean(options.content));
      return;
    }

    if (!options.run) {
      console.error("Provide --run <id> or --uri <uri>.");
      process.exitCode = 1;
      return;
    }

    const artifacts = await listArtifacts({
      runId: options.run,
      kind: options.kind
    });

    if (!artifacts.length) {
      console.log("No artifacts found.");
      return;
    }

    for (const artifact of artifacts) {
      printArtifact(artifact, Boolean(options.json), Boolean(options.content));
    }
  });

program
  .command("export-run")
  .description("Export a workflow run report as Markdown and JSON")
  .requiredOption("-r, --run <id>", "workflow run id")
  .option("-o, --out <dir>", "export directory", "exports/runs")
  .action(async (options: { run: string; out: string }) => {
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
      outDir: path.resolve(process.cwd(), options.out)
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
  .command("schedule")
  .description("Run due project schedules from .agent-workflow/schedules.yaml")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--watch", "keep polling for due schedules")
  .option("--interval-ms <number>", "watch polling interval in milliseconds", "60000")
  .option("--dry-run", "print due schedules without running them")
  .action(async (options: { project: string; watch?: boolean; intervalMs: string; dryRun?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const intervalMs = parsePositiveInteger(options.intervalMs, 60000);

    do {
      const result = await runDueSchedules({
        projectDir,
        dryRun: Boolean(options.dryRun)
      });
      for (const line of result.lines) {
        console.log(line);
      }
      if (!options.watch) {
        return;
      }
      await sleep(intervalMs);
    } while (true);
  });

program
  .command("dashboard")
  .description("Start a local dashboard for workflow runs and artifacts")
  .option("--host <host>", "host to bind", "127.0.0.1")
  .option("--port <number>", "port to bind", "17888")
  .action(async (options: { host: string; port: string }) => {
    const port = parsePositiveInteger(options.port, 17888);
    const server = http.createServer(async (request, response) => {
      try {
        await handleDashboardRequest(request, response);
      } catch (error) {
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(port, options.host, resolve);
    });
    console.log(`Agent Workflow dashboard: http://${options.host}:${port}`);
  });

program
  .command("exec-command")
  .description("Execute an allowed local command and record an audit receipt")
  .requiredOption("-p, --project <dir>", "project directory")
  .requiredOption("-r, --run <id>", "workflow run id for receipt")
  .option("-a, --agent <id>", "agent id to associate with the action", "implementation-agent")
  .argument("<command...>", "command to execute")
  .action(async (commandParts: string[], options: { project: string; run: string; agent: string }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const project = await loadProjectConfig(projectDir);
    const commandLine = commandParts.join(" ");
    const result = await executeAllowedCommand({
      commandLine,
      cwd: projectDir,
      project
    });

    const summary = [
      `Command \`${result.commandLine}\` exited with ${result.exitCode}`,
      result.timedOut ? "after timing out" : `in ${result.durationMs}ms`
    ].join(" ");
    const artifactUri = await recordRunAction({
      runId: options.run,
      agentId: options.agent,
      actionType: "local_command",
      target: result.commandLine,
      summary,
      artifactKind: "command_output",
      artifactContent: {
        ...result
      }
    });

    console.log(summary);
    console.log(`Artifact: ${artifactUri}`);
    if (result.stdout.trim()) {
      console.log("");
      console.log("stdout");
      console.log(result.stdout.trim());
    }
    if (result.stderr.trim()) {
      console.log("");
      console.log("stderr");
      console.log(result.stderr.trim());
    }

    if (result.exitCode !== 0) {
      process.exitCode = result.exitCode ?? 1;
    }
  });

program
  .command("worker")
  .description("Execute queued workflow stage tasks")
  .option("-l, --limit <number>", "maximum tasks to execute", "1")
  .option("--watch", "keep polling for queued workflow tasks")
  .option("--interval-ms <number>", "watch polling interval in milliseconds", "2000")
  .action(async (options: { limit: string; watch?: boolean; intervalMs: string }) => {
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

    const limit = Number.parseInt(options.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) {
      console.error("--limit must be a positive integer");
      process.exitCode = 1;
      return;
    }

    if (!options.watch) {
      const result = await runWorkerOnce(limit);
      console.log(`Worker claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}.`);
      return;
    }

    const intervalMs = Number.parseInt(options.intervalMs, 10);
    if (!Number.isFinite(intervalMs) || intervalMs < 250) {
      console.error("--interval-ms must be an integer >= 250");
      process.exitCode = 1;
      return;
    }

    let stop = false;
    const stopWorker = () => {
      stop = true;
      console.log("Stopping worker after current tick...");
    };
    process.once("SIGINT", stopWorker);
    process.once("SIGTERM", stopWorker);

    console.log(`Worker watching. limit=${limit} intervalMs=${intervalMs}`);
    await runWorkerWatch({
      limitPerTick: limit,
      intervalMs,
      shouldStop: () => stop,
      onTick: (result) => {
        if (result.claimed > 0 || result.failed > 0) {
          console.log(`Worker claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}.`);
        }
      }
    });
  });

function requiredAgent<T extends { id: string }>(agents: Map<string, T>, id: string): T {
  const agent = agents.get(id);
  if (!agent) {
    throw new Error(`Missing required agent: ${id}`);
  }
  return agent;
}

async function loadAgentsForProject(projectDir: string): Promise<AgentCard[]> {
  const builtins = await loadAgents(rootDir);
  const projectAgentsDir = path.join(projectDir, ".agent-workflow", "agents");
  const projectAgents: AgentCard[] = [];

  try {
    const entries = await fs.readdir(projectAgentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".yaml")) {
        continue;
      }
      const agent = await loadYamlFile(path.join(projectAgentsDir, entry.name), agentCardSchema);
      projectAgents.push(agent);
    }
  } catch {
    return builtins;
  }

  const merged = new Map<string, AgentCard>();
  for (const agent of builtins) {
    merged.set(agent.id, agent);
  }
  for (const agent of projectAgents) {
    merged.set(agent.id, agent);
  }
  return [...merged.values()];
}

interface RunSummary {
  runId: string;
  status: string;
  workflowId: string;
  task: string;
  projectName: string;
  projectRootUri: string;
  completedTasks: number;
  failedTasks: number;
  totalTasks: number;
  stageResults: Array<{
    stageId: string;
    agentId: string;
    status: string;
    attempts: number;
  }>;
  keyFindings: string[];
  failures: string[];
  artifactUris: string[];
  recommendedNextAction: string;
}

async function summarizeWorkflowRun(runId: string): Promise<{ ok: true; value: RunSummary } | { ok: false }> {
  const details = await getWorkflowRunDetails(runId);
  if (!details.run) {
    return { ok: false };
  }

  const artifacts = await listArtifacts({ runId });
  const stageOutputs = artifacts.filter((artifact) => artifact.kind === "stage_output");
  const failures = details.receipts
    .filter((receipt) => receipt.actionType.includes("failed") || /failed|timed out|rejected/i.test(receipt.summary))
    .map((receipt) => `${receipt.agentId}: ${receipt.summary}`);
  const commandFailures = artifacts
    .filter((artifact) => artifact.kind === "command_output")
    .filter((artifact) => {
      const exitCode = artifact.content.exitCode;
      return typeof exitCode === "number" && exitCode !== 0 || artifact.content.timedOut === true;
    })
    .map((artifact) => {
      const commandLine = typeof artifact.content.commandLine === "string" ? artifact.content.commandLine : artifact.uri;
      return `Command failed: ${commandLine}`;
    });

  const findings = collectArtifactFindings(stageOutputs);
  const completedTasks = details.tasks.filter((task) => task.status === "completed").length;
  const failedTasks = details.tasks.filter((task) => task.status === "failed").length;

  return {
    ok: true,
    value: {
      runId,
      status: details.run.status,
      workflowId: details.run.workflowId,
      task: details.run.task,
      projectName: details.run.projectName,
      projectRootUri: details.run.projectRootUri,
      completedTasks,
      failedTasks,
      totalTasks: details.tasks.length,
      stageResults: details.tasks.map((task) => ({
        stageId: task.stageId,
        agentId: task.agentId,
        status: task.status,
        attempts: task.attempts
      })),
      keyFindings: findings.length ? findings.slice(0, 8) : details.receipts.slice(-5).map((receipt) => `${receipt.agentId}: ${receipt.summary}`),
      failures: [...failures, ...commandFailures].slice(0, 8),
      artifactUris: artifacts.map((artifact) => `${artifact.kind}: ${artifact.uri}`).slice(0, 12),
      recommendedNextAction: recommendNextAction(details.run.status, details.run.workflowId, failedTasks, [...failures, ...commandFailures])
    }
  };
}

function collectArtifactFindings(artifacts: Array<{ content: Record<string, unknown> }>): string[] {
  const findings: string[] = [];
  for (const artifact of artifacts) {
    for (const value of Object.values(artifact.content)) {
      collectFindingValue(value, findings);
    }
  }
  return [...new Set(findings.map((finding) => finding.trim()).filter(Boolean))];
}

function collectFindingValue(value: unknown, findings: string[]): void {
  if (findings.length >= 20) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > 20 && value.length < 280 && !/^[0-9a-f-]{24,}$/i.test(value)) {
      findings.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectFindingValue(item, findings);
    }
    return;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["summary", "finding", "issue", "risk", "nextAction", "recommendation"]) {
      if (key in record) {
        collectFindingValue(record[key], findings);
      }
    }
  }
}

function recommendNextAction(status: string, workflowId: string, failedTasks: number, failures: string[]): string {
  if (status === "failed" || failedTasks > 0 || failures.length) {
    return "Run `debug-failure` or a targeted specialist `agent-task` against the failing command or stage.";
  }
  if (workflowId.startsWith("agent-task-ux-reviewer")) {
    return "Ask `frontend-engineer` to implement the highest-impact UX findings, then rerun `ux-reviewer`.";
  }
  if (workflowId === "review-pr") {
    return "Address the highest-risk review findings, then rerun `review-pr` before shipping.";
  }
  if (workflowId === "build-feature") {
    return "Review generated artifacts, run project tests, and prepare a PR or release handoff.";
  }
  return "Review artifacts and choose the next specialist or workflow from the findings.";
}

function formatRunSummary(summary: RunSummary): string {
  return [
    `Run: ${summary.runId}`,
    `Status: ${summary.status}`,
    `Project: ${summary.projectName}`,
    `Workflow: ${summary.workflowId}`,
    `Task: ${summary.task}`,
    `Tasks: ${summary.completedTasks}/${summary.totalTasks} completed, ${summary.failedTasks} failed`,
    "",
    "Stages:",
    ...summary.stageResults.map((stage) => `- ${stage.stageId}: ${stage.agentId} ${stage.status} attempts=${stage.attempts}`),
    "",
    "Key findings:",
    ...(summary.keyFindings.length ? summary.keyFindings.map((finding, index) => `${index + 1}. ${finding}`) : ["- No findings captured."]),
    "",
    "Failures:",
    ...(summary.failures.length ? summary.failures.map((failure) => `- ${failure}`) : ["- None"]),
    "",
    "Recommended next action:",
    summary.recommendedNextAction,
    "",
    "Artifacts:",
    ...(summary.artifactUris.length ? summary.artifactUris.map((artifact) => `- ${artifact}`) : ["- None"])
  ].join("\n");
}

interface ScheduleEntry {
  id: string;
  enabled?: boolean;
  every_minutes?: number;
  workflow?: string;
  agent?: string;
  task: string;
  index_max_files?: number;
  worker_limit?: number;
}

async function runDueSchedules(input: { projectDir: string; dryRun: boolean }): Promise<{ lines: string[] }> {
  const serviceChecks = await checkServices();
  const missing = serviceChecks.filter((check) => !check.reachable);
  if (missing.length) {
    return {
      lines: missing.map((check) => `MISSING: ${check.endpoint.name} - ${check.message}`)
    };
  }

  const schedules = await loadProjectSchedules(input.projectDir);
  if (!schedules.length) {
    return { lines: [`No schedules found in ${path.join(input.projectDir, ".agent-workflow", "schedules.yaml")}`] };
  }

  const statePath = path.join(input.projectDir, ".agent-workflow", "schedule-state.json");
  const state = await readScheduleState(statePath);
  const now = Date.now();
  const lines: string[] = [];
  let stateChanged = false;

  for (const schedule of schedules) {
    if (schedule.enabled === false) {
      continue;
    }
    const lastRunAt = state[schedule.id]?.lastRunAt ? Date.parse(state[schedule.id].lastRunAt) : 0;
    const everyMs = Math.max(1, schedule.every_minutes ?? 1440) * 60_000;
    const due = !lastRunAt || now - lastRunAt >= everyMs;
    if (!due) {
      continue;
    }

    const label = schedule.workflow ? `workflow ${schedule.workflow}` : `agent ${schedule.agent}`;
    if (input.dryRun) {
      lines.push(`DUE ${schedule.id}: ${label} - ${schedule.task}`);
      continue;
    }

    const indexResult = await indexProjectForRun({
      projectDir: input.projectDir,
      maxFiles: schedule.index_max_files ?? 100,
      refine: false,
      forceRefine: false
    });
    lines.push(`Indexed ${indexResult.count} files for ${indexResult.projectName}.`);

    let queuedRunId: string | null = null;
    if (schedule.agent) {
      const agents = await loadAgentsForProject(input.projectDir);
      const agent = resolveAgent(agents, schedule.agent);
      if (!agent) {
        lines.push(`FAILED ${schedule.id}: unknown agent ${schedule.agent}`);
        continue;
      }
      const workflow = createAgentTaskWorkflow(agent);
      const builtinAgentIds = new Set((await loadAgents(rootDir)).map((item) => item.id));
      await seedRegistry(builtinAgentIds.has(agent.id) ? [] : [{ path: `project/${agent.id}.yaml`, value: agent }], [{ path: `runtime/${workflow.id}.yaml`, value: workflow }]);
      const queued = await queueWorkflow({
        workflowId: workflow.id,
        projectPath: input.projectDir,
        task: schedule.task,
        workflowOverride: workflow
      });
      if (!queued.ok) {
        lines.push(`FAILED ${schedule.id}: ${queued.error}`);
        continue;
      }
      queuedRunId = queued.run.runId;
    } else if (schedule.workflow) {
      const queued = await queueWorkflow({
        workflowId: schedule.workflow,
        projectPath: input.projectDir,
        task: schedule.task
      });
      if (!queued.ok) {
        lines.push(`FAILED ${schedule.id}: ${queued.error}`);
        continue;
      }
      queuedRunId = queued.run.runId;
    } else {
      lines.push(`FAILED ${schedule.id}: provide workflow or agent`);
      continue;
    }

    const watchResult = await watchWorkflowRun({
      runId: queuedRunId,
      workerLimit: schedule.worker_limit ?? 6,
      intervalMs: 1000,
      timeoutMs: 900000
    });
    const exportResult = await exportWorkflowRun({
      runId: queuedRunId,
      outDir: path.join(input.projectDir, ".agent-workflow", "exports")
    });
    state[schedule.id] = {
      lastRunAt: new Date().toISOString(),
      lastRunId: queuedRunId,
      lastStatus: watchResult.status
    };
    stateChanged = true;
    lines.push(`RAN ${schedule.id}: ${queuedRunId} ${watchResult.status}`);
    if (exportResult.ok) {
      lines.push(`Exported Markdown: ${exportResult.markdownPath}`);
      lines.push(`Exported JSON: ${exportResult.jsonPath}`);
    }
  }

  if (stateChanged) {
    await writeScheduleState(statePath, state);
  }
  return { lines: lines.length ? lines : ["No schedules due."] };
}

async function loadProjectSchedules(projectDir: string): Promise<ScheduleEntry[]> {
  const schedulePath = path.join(projectDir, ".agent-workflow", "schedules.yaml");
  try {
    const raw = await fs.readFile(schedulePath, "utf8");
    const parsed = YAML.parse(raw) as { schedules?: ScheduleEntry[] } | ScheduleEntry[];
    return Array.isArray(parsed) ? parsed : parsed.schedules ?? [];
  } catch {
    return [];
  }
}

async function readScheduleState(statePath: string): Promise<Record<string, { lastRunAt: string; lastRunId: string; lastStatus: string }>> {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8")) as Record<string, { lastRunAt: string; lastRunId: string; lastStatus: string }>;
  } catch {
    return {};
  }
}

async function writeScheduleState(statePath: string, state: Record<string, { lastRunAt: string; lastRunId: string; lastStatus: string }>): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function handleDashboardRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname === "/api/runs") {
    const runs = await listWorkflowRuns(50);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(runs, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/run") {
    const runId = requestUrl.searchParams.get("id");
    if (!runId) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing id");
      return;
    }
    const details = await getWorkflowRunDetails(runId);
    const artifacts = await listArtifacts({ runId });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ...details, artifacts }, null, 2));
    return;
  }

  const runs = await listWorkflowRuns(50);
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(renderDashboardHtml(runs));
}

function renderDashboardHtml(runs: Awaited<ReturnType<typeof listWorkflowRuns>>): string {
  const rows = runs.map((run) => `
    <tr>
      <td><a href="/api/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${escapeHtml(run.workflowId)}</td>
      <td>${escapeHtml(run.projectName)}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${escapeHtml(run.startedAt)}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Dashboard</title>
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f7f8fb; }
    main { max-width: 1180px; margin: 0 auto; padding: 32px 20px; }
    h1 { font-size: 28px; margin: 0 0 18px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #e2e7f0; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e8edf5; font-size: 14px; vertical-align: top; }
    th { color: #4b5870; background: #f0f3f8; font-size: 12px; text-transform: uppercase; }
    a { color: #1d4ed8; text-decoration: none; }
    .status { display: inline-block; min-width: 78px; padding: 3px 8px; border-radius: 999px; font-size: 12px; text-align: center; background: #eef2ff; color: #3730a3; }
    .completed { background: #dcfce7; color: #166534; }
    .failed { background: #fee2e2; color: #991b1b; }
    .running, .queued { background: #fef3c7; color: #92400e; }
  </style>
</head>
<body>
  <main>
    <h1>Agent Workflow Dashboard</h1>
    <table>
      <thead><tr><th>Run</th><th>Status</th><th>Workflow</th><th>Project</th><th>Task</th><th>Started</th></tr></thead>
      <tbody>${rows || "<tr><td colspan=\"6\">No runs found.</td></tr>"}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function resolveWorkflow<T extends { id: string }>(workflows: T[], workflowId: string): T | undefined {
  const aliases: Record<string, string> = {
    "review-change": "review-pr",
    review: "review-pr",
    "pull-request-review": "review-pr",
    "fix-failure": "debug-failure",
    debug: "debug-failure",
    release: "ship-release",
    ship: "ship-release",
    "context-maintenance": "maintain-context",
    "update-context": "maintain-context"
  };
  return byId(workflows).get(aliases[workflowId] ?? workflowId);
}

function resolveAgent<T extends { id: string; display_name: string }>(agents: T[], agentRef: string): T | undefined {
  const normalizedRef = normalizeLookup(agentRef);
  const aliases: Record<string, string> = {
    mira: "ux-reviewer",
    ux: "ux-reviewer",
    "ux-pass": "ux-reviewer",
    "ux-review": "ux-reviewer",
    frontend: "frontend-engineer",
    backend: "backend-engineer",
    database: "database-engineer",
    db: "database-engineer",
    security: "security-reviewer",
    test: "test-engineer",
    tests: "test-engineer",
    ci: "ci-debugger",
    docs: "docs-maintainer",
    release: "release-manager",
    product: "product-strategist",
    architect: "technical-architect",
    architecture: "technical-architect"
  };
  const resolvedId = aliases[normalizedRef] ?? agentRef;
  const agentIndex = byId(agents);
  return agentIndex.get(resolvedId)
    ?? agents.find((agent) => normalizeLookup(agent.display_name) === normalizedRef)
    ?? agents.find((agent) => normalizeLookup(agent.id) === normalizedRef);
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function createAgentTaskWorkflow(agent: Awaited<ReturnType<typeof loadAgents>>[number]): Awaited<ReturnType<typeof loadWorkflows>>[number] {
  return {
    id: `agent-task-${agent.id}`,
    name: `Agent Task - ${agent.display_name}`,
    description: `Run ${agent.display_name} directly as a one-stage specialist task.`,
    lead: agent.id,
    default_autonomy: agent.autonomy,
    triggers: {
      manual: true,
      events: []
    },
    stages: [
      {
        id: "specialist-task",
        agent: agent.id,
        goal: agent.purpose,
        subagents: [],
        context: {
          load: ["AGENTS.md", ".agent-workflow/**"],
          max_tokens: agent.context_budget.max_tokens
        },
        approval_required: false,
        output: agent.outputs.schema
      }
    ]
  };
}

async function queueWorkflow(input: {
  workflowId: string;
  projectPath: string;
  task: string;
  workflowOverride?: Awaited<ReturnType<typeof loadWorkflows>>[number];
  sourceTokenBudget?: string;
  sourceMaxFiles?: string;
}): Promise<
  | {
    ok: true;
    projectDir: string;
    workflow: Awaited<ReturnType<typeof loadWorkflows>>[number];
    brief: string;
    run: Awaited<ReturnType<typeof createWorkflowRun>>;
  }
  | { ok: false; error: string }
> {
  const projectDir = path.resolve(process.cwd(), input.projectPath);
  const agents = await loadAgentsForProject(projectDir);
  const workflows = await loadWorkflows(rootDir);
  const workflow = input.workflowOverride ?? resolveWorkflow(workflows, input.workflowId);

  if (!workflow) {
    return { ok: false, error: `Unknown workflow: ${input.workflowId}` };
  }

  const project = await loadProjectConfig(projectDir);
  const selectedAgents = selectWorkflowAgents(agents, workflow);

  for (const agent of selectedAgents.values()) {
    const decision = evaluateAgentAutonomy(agent, project);
    if (!decision.allowed) {
      return {
        ok: false,
        error: `Policy rejected ${agent.id}: ${decision.reasons.join("; ")}`
      };
    }
  }

  const selectedAgentList = [...selectedAgents.values()];
  const brief = await compileContext({
    task: input.task,
    projectDir,
    project,
    workflow,
    agents: selectedAgentList,
    sourceSummaries: await loadSourceSummaries({
      projectDir,
      project,
      workflow,
      agents: selectedAgentList,
      task: input.task,
      sourceTokenBudget: input.sourceTokenBudget,
      sourceMaxFiles: input.sourceMaxFiles
    })
  });

  const run = await createWorkflowRun({
    projectName: project.project.name,
    projectRootUri: projectDir,
    projectProfile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
    projectConfig: project,
    workflow,
    task: input.task,
    autonomy: String(project.project.autonomy),
    compiledBrief: brief
  });

  return {
    ok: true,
    projectDir,
    workflow,
    brief,
    run
  };
}

async function indexProjectForRun(input: {
  projectDir: string;
  maxFiles: number;
  refine: boolean;
  forceRefine: boolean;
}): Promise<{
  projectName: string;
  count: number;
  skipped: number;
  refined: number;
  reused: number;
}> {
  const project = await loadProjectConfig(input.projectDir);
  const projectId = await upsertProject({
    name: project.project.name,
    rootUri: input.projectDir,
    profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
    config: project
  });
  const existingSummaries = await listProjectFileSummaries({
    projectRootUri: input.projectDir,
    limit: 1000
  });
  const result = await indexProjectFiles({
    projectDir: input.projectDir,
    project,
    maxFiles: input.maxFiles,
    refineProvider: input.refine ? providerFromEnv() : undefined,
    existingSummaries,
    forceRefine: input.forceRefine
  });

  const count = await upsertProjectFiles({ projectId, files: result.files });
  return {
    projectName: project.project.name,
    count,
    skipped: result.files.filter((file) => file.metadata.skipped).length,
    refined: result.refined,
    reused: result.reused
  };
}

async function watchWorkflowRun(input: {
  runId: string;
  workerLimit: number;
  intervalMs: number;
  timeoutMs: number;
  onTick?: (result: Awaited<ReturnType<typeof runWorkerOnce>>) => void;
}): Promise<{
  status: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  receipts: number;
}> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= input.timeoutMs) {
    const workerResult = await runWorkerOnce(input.workerLimit);
    input.onTick?.(workerResult);

    const details = await getWorkflowRunDetails(input.runId);
    if (!details.run) {
      throw new Error(`Unknown workflow run: ${input.runId}`);
    }

    const failedTasks = details.tasks.filter((task) => task.status === "failed").length;
    const completedTasks = details.tasks.filter((task) => task.status === "completed").length;
    if (["completed", "failed"].includes(details.run.status)) {
      return {
        status: details.run.status,
        totalTasks: details.tasks.length,
        completedTasks,
        failedTasks,
        receipts: details.receipts.length
      };
    }

    if (workerResult.claimed === 0) {
      await sleep(input.intervalMs);
    }
  }

  const details = await getWorkflowRunDetails(input.runId);
  if (!details.run) {
    throw new Error(`Unknown workflow run: ${input.runId}`);
  }

  return {
    status: "timed_out",
    totalTasks: details.tasks.length,
    completedTasks: details.tasks.filter((task) => task.status === "completed").length,
    failedTasks: details.tasks.filter((task) => task.status === "failed").length,
    receipts: details.receipts.length
  };
}

async function exportWorkflowRun(input: {
  runId: string;
  outDir: string;
}): Promise<
  | { ok: true; markdownPath: string; jsonPath: string }
  | { ok: false }
> {
  const details = await getWorkflowRunDetails(input.runId);
  if (!details.run) {
    return { ok: false };
  }

  const artifacts = await listArtifacts({ runId: input.runId });
  const document = buildRunExport({
    run: details.run,
    tasks: details.tasks,
    receipts: details.receipts,
    artifacts
  });
  await fs.mkdir(input.outDir, { recursive: true });
  const markdownPath = path.join(input.outDir, `${input.runId}.md`);
  const jsonPath = path.join(input.outDir, `${input.runId}.json`);
  await fs.writeFile(markdownPath, document.markdown, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(document.json, null, 2)}\n`, "utf8");

  return {
    ok: true,
    markdownPath,
    jsonPath
  };
}

function printArtifact(
  artifact: {
    id: string;
    runId: string;
    taskId: string | null;
    kind: string;
    uri: string;
    content: Record<string, unknown>;
    createdAt: string;
  },
  asJson: boolean,
  contentOnly: boolean
): void {
  if (contentOnly) {
    console.log(JSON.stringify(artifact.content, null, 2));
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(artifact, null, 2));
    return;
  }

  const summary = typeof artifact.content.summary === "string"
    ? artifact.content.summary
    : typeof artifact.content.text === "string"
      ? `${artifact.content.text.slice(0, 160)}${artifact.content.text.length > 160 ? "..." : ""}`
      : "";

  console.log(`${artifact.kind} ${artifact.uri}`);
  if (artifact.taskId) {
    console.log(`  task: ${artifact.taskId}`);
  }
  if (summary) {
    console.log(`  ${summary}`);
  }
}

function selectWorkflowAgents<T extends { id: string }>(agents: T[], workflow: { lead: string; stages: Array<{ agent: string; subagents: string[] }> }): Map<string, T> {
  const agentIndex = byId(agents);
  const selectedAgents = new Map<string, T>();
  selectedAgents.set(workflow.lead, requiredAgent(agentIndex, workflow.lead));
  for (const stage of workflow.stages) {
    selectedAgents.set(stage.agent, requiredAgent(agentIndex, stage.agent));
    for (const subagent of stage.subagents) {
      selectedAgents.set(subagent, requiredAgent(agentIndex, subagent));
    }
  }
  return selectedAgents;
}

function templateNameForProfile(profile: string): string {
  if (profile === "simple") {
    return "project-simple";
  }
  if (profile === "tellara") {
    return "project-tellara";
  }
  return "project";
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyTemplate(templateDir: string, targetDir: string, force: boolean): Promise<{ written: number; skipped: number }> {
  const entries = await walk(templateDir);
  let written = 0;
  let skipped = 0;
  for (const sourcePath of entries) {
    const relativePath = path.relative(templateDir, sourcePath);
    const targetPath = path.join(targetDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    if (!force && await exists(targetPath)) {
      console.log(`skip existing ${relativePath}`);
      skipped += 1;
      continue;
    }

    await fs.copyFile(sourcePath, targetPath);
    console.log(`write ${relativePath}`);
    written += 1;
  }
  return { written, skipped };
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadSourceSummaries(input: {
  projectDir: string;
  project: Awaited<ReturnType<typeof loadProjectConfig>>;
  workflow: Awaited<ReturnType<typeof loadWorkflows>>[number];
  agents: Awaited<ReturnType<typeof loadAgents>>;
  task: string;
  sourceTokenBudget?: string;
  sourceMaxFiles?: string;
}): Promise<Array<{ sourceUri: string; tokenEstimate: number; summary: string }>> {
  try {
    const summaries = await listProjectFileSummaries({
      projectRootUri: input.projectDir,
      limit: 500
    });
    const tokenBudget = Number.parseInt(input.sourceTokenBudget ?? "", 10);
    const maxFiles = Number.parseInt(input.sourceMaxFiles ?? "", 10);
    return selectRelevantSourceSummaries({
      task: input.task,
      project: input.project,
      workflow: input.workflow,
      agents: input.agents,
      summaries,
      maxTokens: Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : undefined,
      maxFiles: Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : undefined
    });
  } catch {
    return [];
  }
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
