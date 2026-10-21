import type { CliContext } from "../lib/context.js";
import type { Command } from "commander";
import type { DashboardProjectAliasMergePlan, OnboardingResult, ProjectDiscoveryReport } from "../lib/cli-types.js";
import { writeProjectBundleState } from "../lib/builders-bundle.js";
import { discoverProjectRoadmap, publishRoadmapSnapshotIfChanged } from "../lib/builders-learning.js";
import { adoptDiscoveredProjects, analyzeProjectForOnboarding, buildDashboardProjectAliasMergePlan, discoverLocalProjects, ensureConfiguredRoadmapPath, formatDiscoveryAdoptionResult, loadDashboardProjectIdentityGroups, parseSpotlightMode, splitCommaList, writeOnboardingFiles } from "../lib/builders-project.js";
import { buildReusePlanForTask, exists, loadAgentsForProject, loadSourceSummaries, pathExists, selectWorkflowAgents } from "../lib/builders-shared.js";
import { loadAgents, loadProjectConfig, loadWorkflows } from "../../../../packages/agent-registry/src/loaders.js";
import { type IdeClient, buildIdeConfigSnippet, mergeIdeConfig } from "../../../../packages/ide-onboarding/src/index.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { resolveExecutionPolicy } from "../../../../packages/policy-engine/src/index.js";
import { type GovernedReusePlan } from "../../../../packages/reuse-engine/src/index.js";
import { resolveContainedProjectPath } from "../../../../packages/roadmap-planner/src/index.js";
import { checkServices } from "../../../../packages/storage/src/doctor.js";
import { listProjectFileSummaries, listProjectStorageSummaries } from "../../../../packages/storage/src/postgres.js";
import { parsePositiveInteger } from "../numeric-options.js";
import { resolveWorkflow } from "../reference-resolution.js";
import { loadTemplateManifestEntries } from "../template-manifest.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function registerProjectCommands(program: Command, ctx: CliContext): void {
  async function copyTemplate(templateDir: string, targetDir: string, force: boolean): Promise<{ written: number; skipped: number }> {
    const entries = (await loadTemplateManifestEntries(path.dirname(templateDir), path.basename(templateDir)))
      .map((relativePath) => path.join(templateDir, relativePath));
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

  async function ensureProjectRoadmap(projectDir: string): Promise<{ relativePath: string; created: boolean }> {
    const roadmap = await discoverProjectRoadmap(projectDir);
    if (roadmap.exists) return { relativePath: roadmap.relativePath, created: false };
    const filePath = await resolveContainedProjectPath({ projectRootUri: projectDir, relativePath: roadmap.relativePath, label: "roadmap_path" });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "# Roadmap\n", { encoding: "utf8", flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    return { relativePath: roadmap.relativePath, created: true };
  }

  function formatDashboardProjectAliasMergePlan(plan: DashboardProjectAliasMergePlan): string {
    const lines = [
      `Project alias merge plan (${plan.dryRun ? "dry-run" : "execute"})`,
      `Generated: ${plan.generatedAt}`,
      `Identities: ${plan.identityCount}`,
      `Registered projects: ${plan.projectCount}`,
      `Merge candidates: ${plan.candidateCount}`,
      `Source project rows: ${plan.sourceProjectCount}`,
      "",
      ...plan.summary.map((item) => `- ${item}`)
    ];
    for (const group of plan.groups) {
      lines.push(
        "",
        `## ${group.target.name}`,
        `Canonical: ${group.canonicalRootUri}`,
        `Target: ${group.target.id} ${group.target.rootUri}`,
        `Risk: ${group.risk}`,
        `Sources: ${group.sources.length}`,
        `Impact: ${group.impactedRows.workflowRuns} runs, ${group.impactedRows.projectFiles} indexed files, ${group.impactedRows.memoryItems} memory items, ${group.impactedRows.activeRuns} active runs`
      );
      for (const source of group.sources) {
        lines.push(`- ${source.id} ${source.rootUri} (${source.runCount} runs, ${source.indexedFiles} files, ${source.memoryItems} memory)`);
      }
      if (group.conflictWarnings.length) {
        lines.push("Warnings:");
        for (const warning of group.conflictWarnings) lines.push(`- ${warning}`);
      }
    }
    return lines.join("\n");
  }

  function formatDiscoveryReport(report: ProjectDiscoveryReport): string {
    const lines = [
      "# Agent Workflow Project Discovery",
      "",
      `Generated: ${report.generatedAt}`,
      `Roots: ${report.roots.join(", ")}`,
      `Spotlight: requested=${report.spotlight.requested}, used=${report.spotlight.used}`,
      `Candidates: ${report.candidates.length}`,
      ""
    ];
    if (report.warnings.length) {
      lines.push("## Warnings", "", ...report.warnings.map((warning) => `- ${warning}`), "");
    }
    lines.push("## Candidates", "");
    if (!report.candidates.length) {
      lines.push("No candidate projects found.", "");
    }
    for (const candidate of report.candidates) {
      lines.push(
        `- ${candidate.rootUri}`,
        `  - name: ${candidate.name}`,
        `  - confidence: ${candidate.confidence}`,
        `  - source: ${candidate.source}`,
        `  - initialized: ${candidate.initialized}`,
        `  - registered: ${candidate.registered}`,
        `  - markers: ${candidate.markers.join(", ")}`,
        `  - next: ${candidate.suggestedCommands[0] ?? "review manually"}`
      );
    }
    lines.push("", "## Next Commands", "", ...report.nextCommands.map((command) => `- ${command}`));
    return lines.join("\n");
  }

  function formatGovernedReusePlan(plan: GovernedReusePlan): string {
    const lines = [
      `Governed reuse recommendation: ${plan.recommendation}`,
      `Approval required: ${plan.requiresApproval ? "yes" : "no"}`,
      `Fingerprint: ${plan.fingerprint.fingerprint}`,
      "",
      "Run candidates:"
    ];
    if (!plan.candidates.length) lines.push("- none; run fresh");
    for (const candidate of plan.candidates) {
      lines.push(`- ${candidate.runId}: ${candidate.recommendation}; similarity=${candidate.taskSimilarity}; current=${candidate.evidenceCurrent ? "yes" : "no"}; saved=${candidate.projectedSavings.stages} stage(s), ${candidate.projectedSavings.tokens} tokens, ${candidate.projectedSavings.latencyMs}ms, ${candidate.projectedSavings.costUsd === null ? "cost unavailable" : `$${candidate.projectedSavings.costUsd.toFixed(6)}`}`);
      if (candidate.staleReasons.length) lines.push(`  stale: ${candidate.staleReasons.join(", ")}`);
    }
    lines.push("", "Memory matches:");
    if (!plan.memory.length) lines.push("- none");
    for (const memory of plan.memory) lines.push(`- ${memory.kind} ${memory.sourceUri}: similarity=${memory.similarity}`);
    lines.push("", "No evidence is reused until an operator explicitly accepts the recommendation.");
    return lines.join("\n");
  }

  function printOnboardingResult(result: OnboardingResult, wrote: boolean): void {
    console.log(`Project: ${result.detected.name}`);
    console.log(`Path: ${result.projectDir}`);
    console.log(`Profile: ${result.profile}`);
    console.log("");
    console.log("Detected");
    console.log(`- package manager: ${result.detected.packageManager ?? "none"}`);
    console.log(`- frameworks: ${result.detected.frameworks.join(", ") || "none"}`);
    console.log(`- languages: ${result.detected.languages.join(", ") || "none"}`);
    console.log(`- markers: ${result.detected.markers.join(", ") || "none"}`);
    console.log("");
    console.log("Recommended commands");
    for (const command of result.recommendations.allowedCommands) {
      console.log(`- ${command}`);
    }
    console.log("");
    console.log("Suggested project-local agents");
    for (const agent of result.recommendations.suggestedAgents) {
      console.log(`- ${agent}`);
    }
    console.log("");
    console.log("Default workflows");
    for (const workflow of result.recommendations.defaultWorkflows) {
      console.log(`- ${workflow}`);
    }
    console.log("");
    console.log("Context includes");
    for (const include of result.recommendations.contextInclude) {
      console.log(`- ${include}`);
    }
    console.log("");
    if (wrote) {
      console.log("Written");
      for (const file of result.written ?? []) {
        console.log(`- ${file}`);
      }
      if (result.skipped?.length) {
        console.log("");
        console.log("Skipped existing files");
        for (const file of result.skipped) {
          console.log(`- ${file}`);
        }
        console.log("Use --force to overwrite skipped files.");
      }
    } else {
      console.log("Dry run only. Add --write to create .agent-workflow files.");
    }
    console.log("");
    console.log("Next commands");
    for (const command of result.recommendations.nextCommands) {
      console.log(`- ${command}`);
    }
  }

  async function publishRoadmapSnapshotOnly(projectDir: string): Promise<void> {
    await publishRoadmapSnapshotIfChanged(projectDir, "project-onboarding");
  }

  function templateNameForProfile(profile: string): string {
    if (profile === "simple") {
      return "project-simple";
    }
    return "project";
  }

  async function writeDiscoveryReport(report: ProjectDiscoveryReport): Promise<void> {
    const discoveryDir = path.join(ctx.rootDir, ".agent-workflow", "discovery");
    await fs.mkdir(discoveryDir, { recursive: true });
    await fs.writeFile(path.join(discoveryDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(discoveryDir, "latest.md"), `${formatDiscoveryReport(report)}\n`, "utf8");
  }

  program
    .command("init-project")
    .description("Install AGENTS.md and .agent-workflow files into a project")
    .option("-p, --project <dir>", "project directory", ".")
    .option("--profile <profile>", "enterprise or simple", "enterprise")
    .option("--force", "overwrite existing files")
    .action(async (options: { project: string; profile: string; force?: boolean }) => {
      if (!["enterprise", "simple"].includes(options.profile)) {
        console.error(`Unknown profile: ${options.profile}. Use enterprise or simple.`);
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const templateDir = path.join(ctx.rootDir, "templates", templateNameForProfile(options.profile));
      const hadBundleState = await exists(path.join(projectDir, ".agent-workflow", "bundle-state.json"));
      const existingRoadmap = await discoverProjectRoadmap(projectDir);
      const result = await copyTemplate(templateDir, projectDir, Boolean(options.force));
      const roadmap = existingRoadmap.exists
        ? { relativePath: existingRoadmap.relativePath, created: false }
        : await ensureProjectRoadmap(projectDir);
      await ensureConfiguredRoadmapPath(projectDir, roadmap.relativePath);
      const bundleState = await writeProjectBundleState(ctx, projectDir, Boolean(options.force) || !hadBundleState);
      console.log(`Initialized ${options.profile} agent workflow files in ${projectDir}`);
      console.log(`Wrote ${result.written}; skipped ${result.skipped}.`);
      console.log(`${bundleState.status === "written" ? "Wrote" : "Skipped"} ${bundleState.relativePath}.`);
      console.log(`${roadmap.created ? "Created" : "Using"} roadmap ${roadmap.relativePath}.`);
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
    .command("onboard-project")
    .description("Analyze a project and recommend or write a tailored Agent Workflow config")
    .requiredOption("-p, --project <dir>", "project directory")
    .option("--profile <profile>", "enterprise or simple", "enterprise")
    .option("--write", "write .agent-workflow/project.yaml and support files")
    .option("--force", "overwrite existing .agent-workflow/project.yaml when writing")
    .option("--json", "print machine-readable onboarding output")
    .action(async (options: { project: string; profile: string; write?: boolean; force?: boolean; json?: boolean }) => {
      if (!["enterprise", "simple"].includes(options.profile)) {
        console.error(`Unknown profile: ${options.profile}. Use enterprise or simple.`);
        process.exitCode = 1;
        return;
      }

      const projectDir = path.resolve(process.cwd(), options.project);
      const result = await analyzeProjectForOnboarding(ctx, projectDir, options.profile as "enterprise" | "simple");

      if (options.write) {
        const writeResult = await writeOnboardingFiles(ctx, projectDir, result, Boolean(options.force));
        result.written = writeResult.written;
        result.skipped = writeResult.skipped;
        const services = await checkServices();
        if (services.every((service) => service.reachable)) {
          await publishRoadmapSnapshotOnly(projectDir);
        }
      }

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      printOnboardingResult(result, Boolean(options.write));
    });

  program
    .command("ide-onboard")
    .description("Generate, install, and validate Agent Workflow MCP setup for VS Code, Cursor, and Codex")
    .option("-p, --project <dir>", "target project directory", ".")
    .option("--client <client>", "vscode, cursor, codex, or all", "all")
    .option("--write", "merge MCP configuration into the target project")
    .option("--check", "probe enterprise services and the configured model provider")
    .option("--json", "print machine-readable output")
    .action(async (options: { project: string; client: string; write?: boolean; check?: boolean; json?: boolean }) => {
      const clients: IdeClient[] = options.client === "all"
        ? ["vscode", "cursor", "codex"]
        : [options.client as IdeClient];
      if (clients.some((client) => !["vscode", "cursor", "codex"].includes(client))) {
        throw new Error("--client must be vscode, cursor, codex, or all");
      }
      const projectDir = path.resolve(process.cwd(), options.project);
      const checks: Array<{ name: string; ready: boolean; detail: string }> = [];
      checks.push({ name: "project", ready: await pathExists(projectDir), detail: projectDir });
      checks.push({ name: "AGENTS.md", ready: await pathExists(path.join(projectDir, "AGENTS.md")), detail: "durable project guidance" });
      checks.push({ name: "project config", ready: await pathExists(path.join(projectDir, ".agent-workflow", "project.yaml")), detail: ".agent-workflow/project.yaml" });
      const [agents, workflows] = await Promise.all([loadAgents(ctx.rootDir), loadWorkflows(ctx.rootDir)]);
      checks.push({ name: "definitions", ready: agents.length > 0 && workflows.length > 0, detail: `${agents.length} agents, ${workflows.length} workflows` });

      if (options.check) {
        for (const check of await checkServices()) checks.push({ name: check.endpoint.name, ready: check.reachable, detail: check.message });
        const provider = providerFromEnv();
        if (provider.check) {
          const result = await provider.check();
          checks.push({ name: `provider:${provider.id}`, ready: result.ready, detail: result.details.join("; ") });
        } else {
          checks.push({ name: `provider:${provider.id}`, ready: true, detail: "provider adapter loaded" });
        }
      }

      const compiledMcpPath = path.join(ctx.rootDir, "dist", "apps", "mcp", "src", "index.js");
      const launcher = await pathExists(compiledMcpPath)
        ? { command: process.execPath, args: [compiledMcpPath] }
        : { command: "npm", args: ["run", "-s", "mcp"], cwd: ctx.rootDir };
      const snippets = clients.map((client) => buildIdeConfigSnippet(client, ctx.rootDir, launcher));
      const files: Array<{ client: IdeClient; path: string; status: "preview" | "written" | "unchanged" }> = [];
      for (const snippet of snippets) {
        const target = path.join(projectDir, snippet.relativePath);
        let existing: string | undefined;
        try { existing = await fs.readFile(target, "utf8"); } catch {}
        const content = mergeIdeConfig(snippet.client, existing, snippet);
        let status: "preview" | "written" | "unchanged" = "preview";
        if (options.write) {
          status = existing === content ? "unchanged" : "written";
          if (status === "written") {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, content, "utf8");
          }
        }
        files.push({ client: snippet.client, path: target, status });
      }
      const result = { projectDir, agentWorkflowRoot: ctx.rootDir, ready: checks.every((check) => check.ready), checks, files, snippets };
      if (options.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`IDE onboarding: ${projectDir}`);
        for (const check of checks) console.log(`${check.ready ? "OK" : "MISSING"}: ${check.name} - ${check.detail}`);
        for (const file of files) console.log(`${file.status.toUpperCase()}: ${file.client} - ${file.path}`);
        if (!options.write) {
          for (const snippet of snippets) console.log(`\n# ${snippet.client}: ${snippet.relativePath}\n${snippet.content.trimEnd()}`);
          console.log("\nPreview only. Re-run with --write to merge workspace MCP configuration.");
        }
        console.log("Restart or reload the selected IDE after writing MCP configuration.");
      }
      if (!result.ready) process.exitCode = 1;
    });

  program
    .command("discover-projects")
    .description("Dry-run local project discovery across governed roots without indexing file contents")
    .option("--roots <list>", "comma-separated roots to scan", path.join(os.homedir(), "Projects"))
    .option("--max-depth <number>", "maximum directory depth below each root", "5")
    .option("--max-candidates <number>", "maximum candidates to return", "200")
    .option("--spotlight <mode>", "macOS Spotlight mode: auto, on, or off", "auto")
    .option("--write", "write report under .agent-workflow/discovery")
    .option("--json", "print JSON")
    .action(async (options: { roots: string; maxDepth: string; maxCandidates: string; spotlight: string; write?: boolean; json?: boolean }) => {
      const report = await discoverLocalProjects(ctx, {
        roots: splitCommaList(options.roots).map((item) => path.resolve(process.cwd(), item)),
        maxDepth: parsePositiveInteger(options.maxDepth, 5),
        maxCandidates: parsePositiveInteger(options.maxCandidates, 200),
        spotlight: parseSpotlightMode(options.spotlight)
      });
      if (options.write) {
        await writeDiscoveryReport(report);
      }
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(formatDiscoveryReport(report));
    });

  program
    .command("adopt-discovered-projects")
    .description("Initialize and/or index discovered project candidates after explicit opt-in")
    .option("--roots <list>", "comma-separated roots to scan", path.join(os.homedir(), "Projects"))
    .option("--paths <list>", "comma-separated candidate paths to adopt; omit with --all")
    .option("--all", "select all discovered candidates")
    .option("--initialize", "write Agent Workflow project files for selected candidates that are not initialized")
    .option("--index", "register and index selected initialized candidates")
    .option("--profile <profile>", "enterprise or simple", "enterprise")
    .option("--max-depth <number>", "maximum directory depth below each root", "5")
    .option("--max-candidates <number>", "maximum candidates to return", "200")
    .option("--max-files <number>", "maximum files to index for each selected project", "100")
    .option("--spotlight <mode>", "macOS Spotlight mode: auto, on, or off", "auto")
    .option("--write", "perform the selected initialization and indexing actions")
    .option("--json", "print JSON")
    .action(async (options: {
      roots: string;
      paths?: string;
      all?: boolean;
      initialize?: boolean;
      index?: boolean;
      profile: string;
      maxDepth: string;
      maxCandidates: string;
      maxFiles: string;
      spotlight: string;
      write?: boolean;
      json?: boolean;
    }) => {
      if (!["enterprise", "simple"].includes(options.profile)) {
        console.error(`Unknown profile: ${options.profile}. Use enterprise or simple.`);
        process.exitCode = 1;
        return;
      }
      const result = await adoptDiscoveredProjects(ctx, {
        roots: splitCommaList(options.roots).map((item) => path.resolve(process.cwd(), item)),
        paths: splitCommaList(options.paths ?? ""),
        all: Boolean(options.all),
        initialize: Boolean(options.initialize),
        index: Boolean(options.index),
        profile: options.profile as "enterprise" | "simple",
        maxDepth: parsePositiveInteger(options.maxDepth, 5),
        maxCandidates: parsePositiveInteger(options.maxCandidates, 200),
        maxFiles: parsePositiveInteger(options.maxFiles, 100),
        spotlight: parseSpotlightMode(options.spotlight),
        write: Boolean(options.write)
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatDiscoveryAdoptionResult(result));
      if (!result.ok) process.exitCode = 1;
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
    .command("project-alias-merge-plan")
    .description("Preview a dry-run plan for consolidating duplicate project identity aliases")
    .option("--json", "Print machine-readable JSON")
    .option("-l, --limit <number>", "number of registered project rows to inspect", "500")
    .action(async (options: { json?: boolean; limit: string }) => {
      const limit = parsePositiveInteger(options.limit, 500);
      const projects = await listProjectStorageSummaries(limit);
      const identities = await loadDashboardProjectIdentityGroups(projects);
      const plan = buildDashboardProjectAliasMergePlan(projects, identities);
      if (options.json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      console.log(formatDashboardProjectAliasMergePlan(plan));
    });

  program
    .command("reuse-plan")
    .description("Find governed exact and semantic reuse candidates for a workflow task")
    .requiredOption("-w, --workflow <id>", "workflow id")
    .requiredOption("-p, --project <dir>", "project directory")
    .requiredOption("-t, --task <task>", "task description")
    .option("--policy-profile <name>", "execution policy profile")
    .option("--json", "print JSON")
    .action(async (options: { workflow: string; project: string; task: string; policyProfile?: string; json?: boolean }) => {
      const projectDir = path.resolve(process.cwd(), options.project);
      const configuredProject = await loadProjectConfig(projectDir);
      const resolvedPolicy = resolveExecutionPolicy(configuredProject, options.policyProfile);
      const workflows = await loadWorkflows(ctx.rootDir);
      const workflow = resolveWorkflow(workflows, options.workflow);
      if (!workflow) throw new Error(`Unknown workflow: ${options.workflow}`);
      const agents = [...selectWorkflowAgents(await loadAgentsForProject(ctx, projectDir), workflow).values()];
      const sourceSummaries = await loadSourceSummaries({ projectDir, project: resolvedPolicy.project, workflow, agents, task: options.task });
      const plan = await buildReusePlanForTask({
        projectDir,
        task: options.task,
        workflow,
        policySnapshotHash: resolvedPolicy.snapshotHash,
        sourceSummaries
      });
      if (options.json) console.log(JSON.stringify(plan, null, 2));
      else console.log(formatGovernedReusePlan(plan));
    });

}
