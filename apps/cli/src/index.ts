#!/usr/bin/env node
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { BedrockClient, ListFoundationModelsCommand } from "@aws-sdk/client-bedrock";
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
import { buildBundleManifest, compareBundleManifests, formatBundleManifest, loadCommittedBundleManifest, writeBundleManifest } from "../../../packages/agent-registry/src/manifest.js";
import { agentCardSchema, projectConfigSchema, type AgentCard, type ProjectConfig, type WorkflowDefinition } from "../../../packages/agent-registry/src/schemas.js";
import { compileContext } from "../../../packages/context-compiler/src/index.js";
import { selectRelevantSourceSummaries } from "../../../packages/context-selector/src/index.js";
import { buildEvaluationReport, evaluationScoringProfileSchema, evaluationSuiteSchema, formatEvaluationReport, type EvaluationObservation, type EvaluationScoringProfile } from "../../../packages/evaluation/src/index.js";
import { queueSnapshotSignature, queueWatcherScript } from "../../../packages/dashboard/src/queue-watcher.js";
import { buildIdeConfigSnippet, mergeIdeConfig, type IdeClient } from "../../../packages/ide-onboarding/src/index.js";
import { buildGovernanceReport, finalizeGovernanceProject, formatGovernanceReport, type GovernanceReport } from "../../../packages/governance/src/index.js";
import { bundleTrustStorePath, normalizePolicy, publicKeyFingerprint, readBundleTrustStore, signBundleManifest, verifyBundle, writeBundleTrustStore, type BundleTrustPolicy, type BundleVerification } from "../../../packages/bundle-trust/src/index.js";
import { agentWorkflowEnvPath, findAgentWorkflowRoot } from "../../../packages/runtime-root/src/index.js";
import { evaluateAgentAutonomy, resolveExecutionPolicy } from "../../../packages/policy-engine/src/index.js";
import { executeAllowedCommand } from "../../../packages/local-tools/src/command-executor.js";
import { indexProjectFiles } from "../../../packages/project-indexer/src/index.js";
import { checkServices } from "../../../packages/storage/src/doctor.js";
import {
  cancelWorkflowRun,
  createWorkflowRun,
  dismissAllFailedWorkflowRuns,
  dismissFailedWorkflowRun,
  getArtifactByUri,
  getLatestMemory,
  getWorkflowRunDetails,
  listArtifacts,
  listProjectFileSummaries,
  listProjectStorageSummaries,
  listWorkflowQueue,
  listWorkflowRunsForProject,
  listWorkflowRuns,
  migrateStorage,
  recordRunAction,
  requeueRunningWorkflowTasks,
  replayWorkflowRun,
  resumeWorkflowRunFromCheckpoint,
  resetStorage,
  retryFailedWorkflowRun,
  seedRegistry,
  upsertMemoryItem,
  upsertProject,
  upsertProjectFiles
} from "../../../packages/storage/src/postgres.js";
import { runWorkerOnce, runWorkerWatch } from "../../../packages/workflow-engine/src/executor.js";
import { providerFromEnv } from "../../../packages/model-providers/src/index.js";
import { selectModelRoute } from "../../../packages/model-providers/src/routing.js";
import { appendTuningApprovalHistory, buildCostQualityReport, buildPreferenceScorecard, buildRunExport, buildTuningApplicationPlan, buildTuningApprovalQueue, buildTuningPatchApplicationPlan, buildTuningPatchPlan, buildTuningProposals, decideTuningApprovals, formatCostQualityReport, formatPreferenceScorecard, formatTuningApplicationPlan, formatTuningApprovalHistory, formatTuningApprovalHistoryMarkdown, formatTuningApprovalQueue, formatTuningApprovalQueueMarkdown, formatTuningPatchPlan, formatTuningProposals, type CostQualityReport, type PreferenceScorecard, type TuningApplicationPlan, type TuningApprovalHistory, type TuningApprovalQueue, type TuningHistoryStatus, type TuningPatchPlan, type TuningPatchPlanDocument, type TuningProposalSet } from "../../../packages/run-reporter/src/index.js";

const program = new Command();
const rootDir = findAgentWorkflowRoot(import.meta.url);
const configuredEnvPath = agentWorkflowEnvPath(rootDir);
dotenv.config({ path: configuredEnvPath, quiet: true });
const defaultWorkerHeartbeatPath = path.join(rootDir, ".agent-workflow", "runtime", "worker-heartbeat.json");
const defaultSupervisorHeartbeatPath = path.join(rootDir, ".agent-workflow", "runtime", "supervisor-heartbeat.json");

program.hook("preAction", async (_command, actionCommand) => {
  if (["validate", "bundle-manifest", "bundle-verify", "bundle-sign", "bundle-trust"].includes(actionCommand.name())) return;
  const policy = normalizePolicy(process.env.AGENTFLOW_BUNDLE_TRUST_POLICY);
  const verification = await verifyBundle(rootDir, policy);
  if (!verification.allowed) throw new Error(`Bundle trust policy ${policy} rejected ${verification.status}: ${verification.reasons.join(" ")}`);
  if (policy === "warn" && verification.status !== "trusted") console.error(`WARNING: bundle ${verification.status}: ${verification.reasons.join(" ")}`);
});

type WorkerHeartbeat = {
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  limit: number;
  intervalMs: number;
  ticks: number;
  claimed: number;
  completed: number;
  failed: number;
  status: "starting" | "running" | "stopping" | "stopped";
  command: string;
};

type DashboardWorkerStatus = {
  heartbeatPath: string;
  configured: boolean;
  status: "running" | "stale" | "stopped" | "missing";
  pid: number | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  ageMs: number | null;
  limit: number | null;
  intervalMs: number | null;
  ticks: number;
  claimed: number;
  completed: number;
  failed: number;
  processAlive: boolean;
  command: string;
};

type SupervisorHeartbeat = {
  pid: number;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  message: string;
  startedAt: string;
  lastHeartbeatAt: string;
  ticks: number;
  dashboardPort: number;
  dashboardManaged: boolean;
  workerManaged: boolean;
  workerLimit: number;
  workerIntervalMs: number;
  monitorIntervalMs: number;
  command: string;
};

type DashboardSupervisorStatus = {
  heartbeatPath: string;
  configured: boolean;
  status: "running" | "stale" | "stopped" | "missing" | "failed";
  pid: number | null;
  processAlive: boolean;
  message: string;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  ageMs: number | null;
  ticks: number;
  dashboardPort: number | null;
  dashboardManaged: boolean;
  workerManaged: boolean;
  command: string;
};

type WorkflowPreset = {
  id: string;
  aliases: string[];
  label: string;
  description: string;
  project: string;
  task: string;
  kind: "agent" | "workflow";
  target: string;
};

type OrchestrationStep = {
  id: string;
  title: string;
  reason: string;
  kind: "agent" | "workflow" | "preset";
  target: string;
  task: string;
  skipIfPriorEmpty?: boolean;
};

type OrchestrationPlan = {
  projectDir: string;
  task: string;
  steps: OrchestrationStep[];
};

const workflowPresets: WorkflowPreset[] = [
  {
    id: "ux-pass",
    aliases: ["mira-ux-pass", "ux-review"],
    label: "UX Pass",
    description: "Ask Mira to review user experience and recommend the top fixes.",
    project: ".",
    task: "Do a UX pass on the current project. Summarize findings and recommend the top 3 fixes.",
    kind: "agent",
    target: "Mira"
  },
  {
    id: "pr-review",
    aliases: ["review-pr", "review"],
    label: "PR Review",
    description: "Run the PR review workflow on current local changes.",
    project: ".",
    task: "Review current changes and call out risks, regressions, missing tests, and recommended fixes.",
    kind: "workflow",
    target: "review-pr"
  },
  {
    id: "test-triage",
    aliases: ["debug-tests", "fix-tests"],
    label: "Test Triage",
    description: "Investigate test or CI failures.",
    project: ".",
    task: "Investigate test and CI failures. Identify failing areas, likely causes, and the next fix.",
    kind: "workflow",
    target: "debug-failure"
  },
  {
    id: "maintain-context",
    aliases: ["context", "refresh-context"],
    label: "Maintain Context",
    description: "Refresh durable project context and workflow memory.",
    project: ".",
    task: "Update durable project context, decisions, and workflow memory from the latest changes.",
    kind: "workflow",
    target: "maintain-context"
  },
  {
    id: "frontend-pass",
    aliases: ["frontend-review"],
    label: "Frontend Pass",
    description: "Ask the frontend specialist to review UI implementation risks.",
    project: ".",
    task: "Review the current frontend implementation and recommend focused UI, accessibility, and state-management fixes.",
    kind: "agent",
    target: "frontend"
  },
  {
    id: "production-readiness",
    aliases: ["prod-ready", "launch-check"],
    label: "Production Readiness",
    description: "Run a full production readiness check (frontend, security, site quality, summary).",
    project: ".",
    task: "Review production site readiness: frontend quality, security risks, SEO, mobile, and launch blockers.",
    kind: "workflow",
    target: "production-readiness"
  }
];

program
  .name("agentflow")
  .description("Portable, model-agnostic agent workflow runner")
  .version("0.2.0");

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
    const committedManifest = await loadCommittedBundleManifest(rootDir);
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

    if (committedManifest) {
      const currentManifest = await buildBundleManifest(rootDir);
      errors.push(...compareBundleManifests(committedManifest, currentManifest));
    }

    if (errors.length) {
      for (const error of errors) {
        console.error(`ERROR: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log(`Validated ${agents.length} agents and ${workflows.length} workflows.`);
    if (committedManifest) {
      console.log(`Bundle manifest ${committedManifest.bundle.version} checksum ${committedManifest.checksum.value}`);
    }
  });

program
  .command("bundle-manifest")
  .description("Print or write the versioned reusable agent/workflow bundle manifest")
  .option("--write", "write agent-workflow.bundle.json")
  .action(async (options: { write?: boolean }) => {
    const manifest = await buildBundleManifest(rootDir);
    if (options.write) {
      const outputPath = await writeBundleManifest(rootDir, manifest);
      console.log(`Wrote ${path.relative(rootDir, outputPath)}`);
    } else {
      console.log(formatBundleManifest(manifest));
    }
  });

program
  .command("bundle-verify")
  .description("Verify bundle integrity, signature, compatibility, and signer trust")
  .option("--policy <policy>", "allow, warn, or require", process.env.AGENTFLOW_BUNDLE_TRUST_POLICY ?? "allow")
  .option("--json", "print machine-readable verification")
  .action(async (options: { policy: string; json?: boolean }) => {
    if (!["allow", "warn", "require"].includes(options.policy)) throw new Error("--policy must be allow, warn, or require");
    const result = await verifyBundle(rootDir, options.policy as BundleTrustPolicy);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`Bundle ${result.bundleId}@${result.bundleVersion}: ${result.status}`);
      console.log(`Policy: ${result.policy} (${result.allowed ? "allowed" : "rejected"})`);
      console.log(`Signer: ${result.signerId ?? "none"}`);
      console.log(`Fingerprint: ${result.keyFingerprint ?? "none"}`);
      for (const reason of result.reasons) console.log(`- ${reason}`);
    }
    if (!result.allowed) process.exitCode = 2;
  });

program
  .command("bundle-sign")
  .description("Create a detached Ed25519 signature using an external private key")
  .requiredOption("--private-key <file>", "PEM Ed25519 private key file")
  .requiredOption("--signer <id>", "signer identity")
  .option("--expires-at <timestamp>", "optional ISO-8601 expiration")
  .option("--out <file>", "signature output", path.join(rootDir, "agent-workflow.bundle.sig.json"))
  .action(async (options: { privateKey: string; signer: string; expiresAt?: string; out: string }) => {
    if (options.expiresAt && !Number.isFinite(Date.parse(options.expiresAt))) throw new Error("--expires-at must be an ISO-8601 timestamp");
    const manifest = await loadCommittedBundleManifest(rootDir);
    if (!manifest) throw new Error("Bundle manifest is missing.");
    const current = await buildBundleManifest(rootDir);
    const drift = compareBundleManifests(manifest, current);
    if (drift.length) throw new Error(`Refusing to sign a modified bundle: ${drift.join("; ")}`);
    const signature = signBundleManifest({ manifest, privateKey: await fs.readFile(path.resolve(options.privateKey), "utf8"), signerId: options.signer, expiresAt: options.expiresAt });
    const output = path.resolve(options.out);
    await fs.writeFile(output, `${JSON.stringify(signature, null, 2)}\n`, { encoding: "utf8", mode: 0o644 });
    console.log(`Wrote ${output}`);
    console.log(`Signer fingerprint: ${signature.signer.keyFingerprint}`);
  });

program
  .command("bundle-trust")
  .description("List, add, or remove trusted bundle signer public keys")
  .option("--public-key <file>", "PEM public key to trust")
  .option("--signer <id>", "signer identity for the trusted key")
  .option("--remove <fingerprint>", "remove a trusted fingerprint")
  .option("--json", "print trust store JSON")
  .action(async (options: { publicKey?: string; signer?: string; remove?: string; json?: boolean }) => {
    const store = await readBundleTrustStore();
    if (options.publicKey) {
      if (!options.signer) throw new Error("--signer is required with --public-key");
      const publicKey = await fs.readFile(path.resolve(options.publicKey), "utf8");
      const fingerprint = publicKeyFingerprint(publicKey);
      store.keys = [...store.keys.filter((key) => key.fingerprint !== fingerprint), { fingerprint, signerId: options.signer, publicKey, trustedAt: new Date().toISOString() }];
      await writeBundleTrustStore(store);
    }
    if (options.remove) {
      store.keys = store.keys.filter((key) => key.fingerprint !== options.remove);
      await writeBundleTrustStore(store);
    }
    if (options.json) console.log(JSON.stringify(store, null, 2));
    else {
      console.log(`Bundle trust store: ${bundleTrustStorePath()}`);
      console.log(store.keys.length ? store.keys.map((key) => `- ${key.signerId}: ${key.fingerprint}`).join("\n") : "- No trusted signer keys.");
    }
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
    if ((process.env.DEFAULT_MODEL_PROVIDER ?? "mock") === "auto") {
      const routes = await loadAutoRoutePreviews();
      console.log("Provider ready: auto");
      for (const route of routes) {
        console.log(`${route.tier}: ${route.providerId} (${route.estimatedCostTier})`);
        console.log(`  ${route.reason}`);
      }
      return;
    }

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
  .command("provider-use")
  .alias("model-use")
  .description("Switch DEFAULT_MODEL_PROVIDER in .env")
  .argument("<provider>", "auto, mock, byo, openai, openai-compatible, bedrock, or kiro")
  .option("--check", "run provider-check after switching")
  .action(async (provider: string, options: { check?: boolean }) => {
    const supported = ["auto", "mock", "byo", "openai", "openai-compatible", "bedrock", "kiro"];
    const providerId = normalizeProviderRef(provider);
    if (!supported.includes(providerId)) {
      console.error(`Unsupported provider: ${provider}`);
      console.error(`Use one of: ${supported.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    await updateEnvValue(configuredEnvPath, "DEFAULT_MODEL_PROVIDER", providerId);
    process.env.DEFAULT_MODEL_PROVIDER = providerId;
    console.log(`DEFAULT_MODEL_PROVIDER=${providerId}`);

    if (providerId === "openai") {
      console.log("Using OpenAI Responses API. Requires OPENAI_API_KEY.");
    } else if (providerId === "auto") {
      console.log("Using auto routing. Agent Workflow will pick a ready provider per stage tier.");
    } else if (providerId === "byo") {
      console.log("Using BYO model provider. Requires BYO_MODEL_BASE_URL and BYO_MODEL_NAME; BYO_MODEL_API_KEY is optional.");
    } else if (providerId === "kiro") {
      console.log("Using Kiro CLI provider. Requires `kiro-cli login` or KIRO_API_KEY, optional KIRO_AGENT.");
    } else if (providerId === "bedrock") {
      console.log("Using AWS Bedrock provider. Requires AWS credentials and optional BEDROCK_MODEL/AWS_REGION.");
    }

    if (options.check) {
      if (providerId === "auto") {
        const routes = await loadAutoRoutePreviews();
        for (const route of routes) {
          console.log(`${route.tier}: ${route.providerId} (${route.estimatedCostTier})`);
          console.log(`  ${route.reason}`);
        }
        return;
      }

      const selected = providerFromEnv();
      if (!selected.check) {
        console.log(`Provider ready: ${selected.id}`);
        return;
      }
      const result = await selected.check();
      for (const detail of result.details) {
        console.log(detail);
      }
      if (!result.ready) {
        console.error(`Provider not ready: ${selected.id}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Provider ready: ${selected.id}`);
    }
  });

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
    const result = await analyzeProjectForOnboarding(projectDir, options.profile as "enterprise" | "simple");

    if (options.write) {
      const writeResult = await writeOnboardingFiles(projectDir, result, Boolean(options.force));
      result.written = writeResult.written;
      result.skipped = writeResult.skipped;
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
    const [agents, workflows] = await Promise.all([loadAgents(rootDir), loadWorkflows(rootDir)]);
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

    const compiledMcpPath = path.join(rootDir, "dist", "apps", "mcp", "src", "index.js");
    const launcher = await pathExists(compiledMcpPath)
      ? { command: process.execPath, args: [compiledMcpPath] }
      : { command: "npm", args: ["run", "-s", "mcp"], cwd: rootDir };
    const snippets = clients.map((client) => buildIdeConfigSnippet(client, rootDir, launcher));
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
    const result = { projectDir, agentWorkflowRoot: rootDir, ready: checks.every((check) => check.ready), checks, files, snippets };
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
  .command("governance")
  .description("Inspect registered projects for health, policy drift, providers, queues, and remediation guidance")
  .option("--health <status>", "healthy, warning, critical, or all", "all")
  .option("--provider <provider>", "filter by provider")
  .option("--policy-profile <profile>", "filter by policy profile")
  .option("--stale-minutes <number>", "running age considered stale", "15")
  .option("--include-ephemeral", "include temporary provider-smoke projects")
  .option("--json", "print machine-readable governance report")
  .action(async (options: { health: string; provider?: string; policyProfile?: string; staleMinutes: string; includeEphemeral?: boolean; json?: boolean }) => {
    if (!["all", "healthy", "warning", "critical"].includes(options.health)) throw new Error("--health must be healthy, warning, critical, or all");
    const report = await loadGovernanceReport(parsePositiveInteger(options.staleMinutes, 15), Boolean(options.includeEphemeral));
    const projects = report.projects.filter((project) =>
      (options.health === "all" || project.health === options.health) &&
      (!options.provider || project.provider === options.provider) &&
      (!options.policyProfile || project.policyProfile === options.policyProfile)
    );
    const filtered = buildGovernanceReport(report.bundleVersion, report.servicesReady, projects, report.configuredProvider, report.definitionsReady);
    console.log(options.json ? JSON.stringify(filtered, null, 2) : formatGovernanceReport(filtered));
    if (!filtered.servicesReady || !filtered.definitionsReady || filtered.counts.critical > 0) process.exitCode = 2;
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
  .option("--policy-profile <name>", "execution policy profile (local, staging, production, or project-defined)")
  .option("--source-token-budget <number>", "token budget for indexed source summaries")
  .option("--source-max-files <number>", "maximum indexed source summaries to include")
  .action(async (options: { workflow: string; project: string; task: string; policyProfile?: string; sourceTokenBudget?: string; sourceMaxFiles?: string }) => {
    const agents = await loadAgents(rootDir);
    const workflows = await loadWorkflows(rootDir);
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
  .command("run")
  .description("Queue a workflow run in enterprise storage and print the compiled brief")
  .argument("<workflow>", "workflow id")
  .requiredOption("-p, --project <dir>", "project directory")
  .requiredOption("-t, --task <task>", "task description")
  .option("--policy-profile <name>", "execution policy profile (local, staging, production, or project-defined)")
  .option("--no-brief", "queue the run without printing the compiled brief")
  .option("--source-token-budget <number>", "token budget for indexed source summaries")
  .option("--source-max-files <number>", "maximum indexed source summaries to include")
  .action(async (workflowId: string, options: { project: string; task: string; policyProfile?: string; brief?: boolean; sourceTokenBudget?: string; sourceMaxFiles?: string }) => {
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
      policyProfile: options.policyProfile,
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
  .option("--policy-profile <name>", "execution policy profile (local, staging, production, or project-defined)")
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
    policyProfile?: string;
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
    policyProfile?: string;
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
      policyProfile: options.policyProfile,
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

    const result = await runWorkflowPreset({
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
  .option("--index-max-files <number>", "maximum project files to index before each step", "100")
  .option("--refine-index", "refine indexed summaries with the selected provider")
  .option("--force-refine", "refresh refined summaries even when content hash is unchanged")
  .option("--worker-limit <number>", "maximum workflow tasks to process per worker tick", "6")
  .option("--timeout-ms <number>", "maximum time to wait for each step", "900000")
  .option("-o, --out <dir>", "export directory; defaults to <project>/.agent-workflow/exports")
  .action(async (options: {
    project: string;
    task: string;
    dryRun?: boolean;
    indexMaxFiles: string;
    refineIndex?: boolean;
    forceRefine?: boolean;
    workerLimit: string;
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
    const plan = createOrchestrationPlan({ projectDir, task: options.task });
    if (options.dryRun) {
      console.log(formatOrchestrationPlan(plan));
      return;
    }

    const result = await runOrchestrationPlan(plan, {
      indexMaxFiles: parsePositiveInteger(options.indexMaxFiles, 100),
      refineIndex: Boolean(options.refineIndex),
      forceRefine: Boolean(options.forceRefine),
      workerLimit: parsePositiveInteger(options.workerLimit, 6),
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
      console.log(`Policy profile: ${details.run.policyProfile}`);
      console.log(`Policy snapshot: ${details.run.policySnapshotHash || "legacy run"}`);
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
  .command("resume-run")
  .description("Resume an interrupted run from the last completed checkpoint")
  .requiredOption("-r, --run <id>", "workflow run id")
  .option("--include-failed", "also requeue failed stages after preserving completed checkpoints")
  .option("--reason <text>", "receipt reason", "Checkpoint resume requested from CLI.")
  .action(async (options: { run: string; includeFailed?: boolean; reason: string }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const staleReport = await assessRunStaleInputs(options.run);
    const result = await resumeWorkflowRunFromCheckpoint({
      runId: options.run,
      actor: "cli",
      reason: options.reason,
      includeFailed: options.includeFailed === true
    });
    if (result.totalTasks === 0) {
      console.error(`Run cannot be resumed or does not exist: ${options.run}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Run: ${options.run}`);
    console.log(`Completed checkpoints preserved: ${result.completedTasks}/${result.totalTasks}`);
    console.log(`Requeued unfinished stages: ${result.requeuedTasks}`);
    console.log(formatStaleInputWarnings(staleReport).join("\n"));
    console.log("Process queued stages with:");
    console.log("npm run worker -- --limit 6");
  });

program
  .command("replay-run")
  .description("Create a new queued run from an existing run's stored task, policy, provider, and compiled context")
  .requiredOption("-r, --run <id>", "source workflow run id")
  .option("--reason <text>", "receipt reason", "Deterministic replay requested from CLI.")
  .action(async (options: { run: string; reason: string }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const staleReport = await assessRunStaleInputs(options.run);
    const result = await replayWorkflowRun({
      sourceRunId: options.run,
      actor: "cli",
      reason: options.reason
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
  .option("--worker-limit <number>", "maximum tasks to process per worker tick", "6")
  .option("--timeout-ms <number>", "maximum time to wait for each run", "900000")
  .option("-o, --out <dir>", "report directory; defaults to <project>/.agent-workflow/evaluations")
  .option("--scoring-profile <file>", "private scoring YAML under <project>/.agent-workflow/evaluations")
  .action(async (options: {
    suite: string;
    project: string;
    dryRun?: boolean;
    skipIndex?: boolean;
    indexMaxFiles: string;
    workerLimit: string;
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
      const indexed = await indexProjectForRun({
        projectDir,
        maxFiles: parsePositiveInteger(options.indexMaxFiles, 100),
        refine: false,
        forceRefine: false
      });
      console.log(`Indexed ${indexed.count} files for ${indexed.projectName}.`);
    }

    const observations: EvaluationObservation[] = [];
    for (const item of matrix) {
      const task = item.variant.prompt_suffix
        ? `${item.testCase.task}\n\nEvaluation prompt variant instructions:\n${item.variant.prompt_suffix}`
        : item.testCase.task;
      const queued = await queueWorkflow({
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
  .command("quality-report")
  .description("Show adaptive routing, cost mix, latency, fallback, and quality scoring for a workflow run")
  .requiredOption("-r, --run <id>", "workflow run id")
  .option("--json", "print report JSON")
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

    const report = await loadCostQualityReport(options.run);
    if (!report) {
      console.error(`Unknown workflow run: ${options.run}`);
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(formatCostQualityReport(report));
  });

program
  .command("feedback")
  .description("Record accepted, revised, or rejected feedback for a workflow run")
  .requiredOption("-r, --run <id>", "workflow run id")
  .requiredOption("--rating <rating>", "accepted, revised, or rejected")
  .option("--note <text>", "short note explaining what worked or needs to change", "")
  .action(async (options: { run: string; rating: string; note: string }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const result = await recordRunFeedback({
      runId: options.run,
      rating: options.rating,
      note: options.note,
      source: "cli"
    });
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }

    console.log(`Recorded ${result.rating} feedback for ${options.run}.`);
    console.log(`Artifact: ${result.artifactUri}`);
  });

program
  .command("preference-scorecard")
  .description("Aggregate feedback, quality, fallback, and routing performance by workflow, stage, agent, provider, and tier")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("-l, --limit <number>", "number of recent project runs to analyze", "25")
  .option("--json", "print scorecard JSON")
  .action(async (options: { project: string; limit: string; json?: boolean }) => {
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
    const scorecard = await loadPreferenceScorecard({
      projectDir,
      limit: parsePositiveInteger(options.limit, 25)
    });

    if (options.json) {
      console.log(JSON.stringify(scorecard, null, 2));
      return;
    }

    console.log(formatPreferenceScorecard(scorecard));
  });

program
  .command("tuning-proposals")
  .description("Generate reviewable prompt, context-budget, and routing tuning proposals from the preference scorecard")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("-l, --limit <number>", "number of recent project runs to analyze", "25")
  .option("--json", "print proposals JSON")
  .action(async (options: { project: string; limit: string; json?: boolean }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const proposalSet = await loadTuningProposals({
      projectDir: path.resolve(process.cwd(), options.project),
      limit: parsePositiveInteger(options.limit, 25)
    });

    if (options.json) {
      console.log(JSON.stringify(proposalSet, null, 2));
      return;
    }

    console.log(formatTuningProposals(proposalSet));
  });

program
  .command("apply-tuning-proposals")
  .description("Create project-local tuning overlay files from selected tuning proposals")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--ids <ids>", "comma-separated proposal ids to apply, or all", "all")
  .option("-l, --limit <number>", "number of recent project runs to analyze", "25")
  .option("--approved", "apply only approved proposals from .agent-workflow/tuning/approval-queue.json")
  .option("--write", "write generated overlay files into the project")
  .option("--json", "print application plan JSON")
  .action(async (options: { project: string; ids: string; limit: string; approved?: boolean; write?: boolean; json?: boolean }) => {
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
    const proposalSet = options.approved
      ? proposalSetFromApprovedQueue(await readTuningApprovalQueue(projectDir))
      : await loadTuningProposals({
        projectDir,
        limit: parsePositiveInteger(options.limit, 25)
      });
    const plan = buildTuningApplicationPlan(proposalSet, parseProposalIds(options.ids));

    if (options.write) {
      await writeTuningApplicationPlan(projectDir, plan);
      await recordTuningHistory(projectDir, plan.selectedIds, "applied", undefined, "Applied as project-local tuning overlays");
    }

    if (options.json) {
      console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
      return;
    }

    console.log(formatTuningApplicationPlan(plan));
    if (options.write) {
      for (const file of plan.files) {
        console.log(`Wrote ${file.relativePath}`);
      }
    } else {
      console.log("");
      console.log("Dry run only. Re-run with --write to create these project-local overlay files.");
    }
  });

program
  .command("queue-tuning-approvals")
  .description("Create a project-local approval queue from selected tuning proposals")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--ids <ids>", "comma-separated proposal ids to queue, or all", "all")
  .option("-l, --limit <number>", "number of recent project runs to analyze", "25")
  .option("--write", "write approval queue files into the project")
  .option("--json", "print approval queue JSON")
  .action(async (options: { project: string; ids: string; limit: string; write?: boolean; json?: boolean }) => {
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
    const proposalSet = await loadTuningProposals({
      projectDir,
      limit: parsePositiveInteger(options.limit, 25)
    });
    const existingQueue = await readTuningApprovalQueue(projectDir).catch(() => undefined);
    const queue = buildTuningApprovalQueue(proposalSet, parseProposalIds(options.ids), existingQueue);

    if (options.write) {
      await writeTuningApprovalQueue(projectDir, queue);
      const newIds = queue.items.filter((item) => !existingQueue?.items.some((existing) => existing.proposalId === item.proposalId)).map((item) => item.proposalId);
      await recordTuningHistory(projectDir, newIds, "queued");
    }

    if (options.json) {
      console.log(JSON.stringify({ ...queue, mode: options.write ? "write" : "dry-run" }, null, 2));
      return;
    }

    console.log(formatTuningApprovalQueue(queue));
    if (options.write) {
      console.log("Wrote .agent-workflow/tuning/approval-queue.json");
      console.log("Wrote .agent-workflow/tuning/approval-queue.md");
    } else {
      console.log("");
      console.log("Dry run only. Re-run with --write to create the project-local approval queue.");
    }
  });

program
  .command("tuning-approvals")
  .description("List, approve, or reject project-local tuning approval queue items")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--approve <ids>", "comma-separated approval ids or proposal ids to approve, or all")
  .option("--reject <ids>", "comma-separated approval ids or proposal ids to reject, or all")
  .option("--reviewer <name>", "reviewer name")
  .option("--note <text>", "decision note")
  .option("--json", "print approval queue JSON")
  .action(async (options: { project: string; approve?: string; reject?: string; reviewer?: string; note?: string; json?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const queue = await readTuningApprovalQueue(projectDir);
    const decisionCount = Number(Boolean(options.approve)) + Number(Boolean(options.reject));
    if (decisionCount > 1) {
      console.error("Use either --approve or --reject, not both.");
      process.exitCode = 1;
      return;
    }

    let nextQueue = queue;
    if (options.approve || options.reject) {
      const result = decideTuningApprovals({
        queue,
        ids: parseProposalIds(options.approve ?? options.reject),
        status: options.approve ? "approved" : "rejected",
        reviewer: options.reviewer,
        note: options.note
      });
      nextQueue = result.queue;
      await writeTuningApprovalQueue(projectDir, nextQueue);
      await recordTuningHistory(projectDir, result.selectedIds, options.approve ? "approved" : "rejected", options.reviewer, options.note);
      if (result.skippedIds.length) {
        console.error(`Skipped unknown ids: ${result.skippedIds.join(", ")}`);
      }
    }

    if (options.json) {
      console.log(JSON.stringify(nextQueue, null, 2));
      return;
    }

    console.log(formatTuningApprovalQueue(nextQueue));
  });

program
  .command("generate-tuning-patches")
  .description("Create reviewable patch-plan files from approved tuning proposals")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--ids <ids>", "comma-separated approved proposal ids or approval ids to include, or all", "all")
  .option("--write", "write patch-plan files into the project")
  .option("--json", "print patch plan JSON")
  .action(async (options: { project: string; ids: string; write?: boolean; json?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const queue = await readTuningApprovalQueue(projectDir);
    const plan = buildTuningPatchPlan(queue, parseProposalIds(options.ids));

    if (options.write) {
      await writeTuningPatchPlan(projectDir, plan);
    }

    if (options.json) {
      console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
      return;
    }

    console.log(formatTuningPatchPlan(plan));
    if (options.write) {
      for (const file of plan.files) {
        console.log(`Wrote ${file.relativePath}`);
      }
    } else {
      console.log("");
      console.log("Dry run only. Re-run with --write to create reviewable patch-plan files.");
    }
  });

program
  .command("apply-tuning-patches")
  .description("Apply reviewed tuning patch-plan items into project-local tuning note files")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--ids <ids>", "comma-separated approved proposal ids or approval ids to apply, or all", "all")
  .option("--write", "write applied tuning note files into the project")
  .option("--json", "print application plan JSON")
  .action(async (options: { project: string; ids: string; write?: boolean; json?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const patchPlan = await readTuningPatchPlan(projectDir);
    const plan = buildTuningPatchApplicationPlan(patchPlan, parseProposalIds(options.ids));

    if (options.write) {
      await writeTuningApplicationPlan(projectDir, plan);
      await recordTuningHistory(projectDir, plan.selectedIds, "applied");
    }

    if (options.json) {
      console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
      return;
    }

    console.log(formatTuningApplicationPlan(plan));
    if (options.write) {
      for (const file of plan.files) {
        console.log(`Wrote ${file.relativePath}`);
      }
    } else {
      console.log("");
      console.log("Dry run only. Re-run with --write to create applied project-local tuning notes.");
    }
  });

program
  .command("tuning-history")
  .description("List or append project-local tuning proposal lifecycle history")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--record <status>", "append applied, reverted, or superseded events")
  .option("--ids <ids>", "comma-separated proposal ids", "all")
  .option("--actor <name>", "actor name")
  .option("--note <text>", "event note")
  .option("--related-proposal <id>", "replacement or related proposal id")
  .option("--json", "print history JSON")
  .action(async (options: { project: string; record?: string; ids: string; actor?: string; note?: string; relatedProposal?: string; json?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    if (options.record) {
      const allowed: TuningHistoryStatus[] = ["applied", "reverted", "superseded"];
      if (!allowed.includes(options.record as TuningHistoryStatus)) throw new Error(`--record must be one of: ${allowed.join(", ")}`);
      if (options.ids === "all") throw new Error("--ids is required when recording a history event");
      await recordTuningHistory(projectDir, parseProposalIds(options.ids) as string[], options.record as TuningHistoryStatus, options.actor, options.note, options.relatedProposal);
    }
    const history = await readTuningApprovalHistory(projectDir).catch(() => ({
      kind: "agentflow_tuning_approval_history" as const,
      projectRootUri: projectDir,
      updatedAt: new Date(0).toISOString(),
      events: []
    }));
    console.log(options.json ? JSON.stringify(history, null, 2) : formatTuningApprovalHistory(history));
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
  .option("--heartbeat-file <path>", "worker heartbeat file path", defaultWorkerHeartbeatPath)
  .action(async (options: { limit: string; watch?: boolean; intervalMs: string; heartbeatFile: string }) => {
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
    let ticks = 0;
    const startedAt = new Date().toISOString();
    const heartbeatFile = path.resolve(process.cwd(), options.heartbeatFile);
    const writeHeartbeat = async (status: WorkerHeartbeat["status"], tick?: Awaited<ReturnType<typeof runWorkerOnce>>): Promise<void> => {
      if (tick) {
        ticks += 1;
      }
      const heartbeat: WorkerHeartbeat = {
        pid: process.pid,
        startedAt,
        lastHeartbeatAt: new Date().toISOString(),
        limit,
        intervalMs,
        ticks,
        claimed: tick?.claimed ?? 0,
        completed: tick?.completed ?? 0,
        failed: tick?.failed ?? 0,
        status,
        command: `agentflow worker --watch --limit ${limit} --interval-ms ${intervalMs}`
      };
      await fs.mkdir(path.dirname(heartbeatFile), { recursive: true });
      await fs.writeFile(heartbeatFile, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
    };
    const stopWorker = () => {
      stop = true;
      console.log("Stopping worker after current tick...");
    };
    process.once("SIGINT", stopWorker);
    process.once("SIGTERM", stopWorker);

    await writeHeartbeat("starting");
    console.log(`Worker watching. limit=${limit} intervalMs=${intervalMs} heartbeat=${heartbeatFile}`);
    await runWorkerWatch({
      limitPerTick: limit,
      intervalMs,
      shouldStop: () => stop,
      onTick: async (result) => {
        await writeHeartbeat(stop ? "stopping" : "running", result);
        if (result.claimed > 0 || result.failed > 0) {
          console.log(`Worker claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}.`);
        }
      }
    });
    await writeHeartbeat("stopped");
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

type FeedbackRating = "accepted" | "revised" | "rejected";

type DashboardRunStatus = Awaited<ReturnType<typeof listWorkflowRuns>>[number];

type RunUsageEstimate = {
  runId: string;
  routedStages: number;
  indexedProjectTokens: number;
  compiledBriefTokens: number;
  selectedSourceTokens: number;
  estimatedPromptTokens: number;
  estimatedBaselineTokens: number;
  estimatedTokensSaved: number;
  tokenReductionPercent: number | null;
  runDurationMs: number | null;
};

type DashboardUsageSummary = {
  includeMock: boolean;
  partial: boolean;
  note: string | null;
  runsAnalyzed: number;
  completedRuns: number;
  failedRuns: number;
  queuedRuns: number;
  runningRuns: number;
  mockRunsExcluded: number;
  mockStagesExcluded: number;
  routedStages: number;
  totalLatencyMs: number;
  averageLatencyMs: number | null;
  averageRunDurationMs: number | null;
  estimatedPromptTokens: number;
  estimatedBaselineTokens: number;
  estimatedTokensSaved: number;
  tokenReductionPercent: number | null;
  providerMix: Record<string, number>;
  costMix: Record<string, number>;
  modelTierMix: Record<string, number>;
  byoSavingsStages: number;
};

type DashboardProjectSummary = Awaited<ReturnType<typeof listProjectStorageSummaries>>[number];
type DashboardQueueItem = Awaited<ReturnType<typeof listWorkflowQueue>>[number];

type DashboardEvaluationRun = {
  runId: string;
  suiteId: string;
  suiteName: string;
  caseId: string;
  variantId: string;
  workflowId: string;
  provider: string;
  modelTier: string;
  status: string;
  averageQuality: number | null;
  totalLatencyMs: number;
  fallbackCount: number;
  estimatedCostMix: Record<string, number>;
  feedback: string | null;
  startedAt: string;
};

type DashboardEvaluationVariant = {
  id: string;
  provider: string;
  modelTier: string;
  runs: number;
  completed: number;
  averageQuality: number | null;
  averageLatencyMs: number | null;
  fallbackRate: number;
  estimatedCostMix: Record<string, number>;
  feedbackCounts: Record<string, number>;
};

type DashboardEvaluationSuite = {
  id: string;
  name: string;
  workflowId: string;
  runs: DashboardEvaluationRun[];
  variants: DashboardEvaluationVariant[];
  leader: string | null;
  latestAt: string;
};

type DashboardHomeHealth = {
  worker: DashboardWorkerStatus;
  supervisor: DashboardSupervisorStatus;
  queue: DashboardQueueItem[];
  projects: DashboardProjectSummary[];
  services: Awaited<ReturnType<typeof checkServices>>;
  provider: string;
  latestFailedRun: DashboardRunStatus | null;
};

type DashboardProjectDetail = {
  project: DashboardProjectSummary;
  files: Awaited<ReturnType<typeof listProjectFileSummaries>>;
  memory: Awaited<ReturnType<typeof getLatestMemory>>;
  runs: Awaited<ReturnType<typeof listWorkflowRunsForProject>>;
  contextFiles: Array<{
    label: string;
    relativePath: string;
    exists: boolean;
    preview: string;
  }>;
  initialized: boolean;
  allowWrites: boolean;
};

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

async function loadCostQualityReport(runId: string): Promise<CostQualityReport | null> {
  const details = await getWorkflowRunDetails(runId);
  if (!details.run) {
    return null;
  }

  const artifacts = await listArtifacts({ runId });
  return buildCostQualityReport({
    run: details.run,
    tasks: details.tasks,
    receipts: details.receipts,
    artifacts
  });
}

async function loadGovernanceReport(staleMinutes = 15, includeEphemeral = false): Promise<GovernanceReport> {
  const [summaries, services, packageRaw, agents, workflows] = await Promise.all([
    listProjectStorageSummaries(500),
    checkServices(),
    fs.readFile(path.join(rootDir, "package.json"), "utf8"),
    loadAgents(rootDir),
    loadWorkflows(rootDir)
  ]);
  const staleBefore = Date.now() - staleMinutes * 60_000;
  const governedSummaries = includeEphemeral ? summaries : summaries.filter((summary) =>
    !(summary.name === "Provider Smoke Project" && /agentflow-provider-smoke\./.test(summary.rootUri))
  );
  const projects = await Promise.all(governedSummaries.map(async (summary) => {
    const accessible = await pathExists(summary.rootUri);
    const agentsFile = accessible && await pathExists(path.join(summary.rootUri, "AGENTS.md"));
    let configStatus: "valid" | "missing" | "invalid" = "missing";
    let localConfig: ProjectConfig | null = null;
    if (accessible && await pathExists(path.join(summary.rootUri, ".agent-workflow", "project.yaml"))) {
      try {
        localConfig = await loadProjectConfig(summary.rootUri);
        configStatus = "valid";
      } catch {
        configStatus = "invalid";
      }
    }
    const runs = await listWorkflowRunsForProject({ projectRootUri: summary.rootUri, limit: 100 });
    const latest = runs[0] ?? null;
    let policyDrift: boolean | null = null;
    let configDrift: boolean | null = null;
    if (localConfig) {
      try {
        const currentPolicy = resolveExecutionPolicy(localConfig, latest?.policyProfile ?? localConfig.execution.policy_profile);
        policyDrift = latest?.policySnapshotHash ? currentPolicy.snapshotHash !== latest.policySnapshotHash : null;
      } catch {
        policyDrift = true;
      }
      try {
        const stored = projectConfigSchema.parse(summary.config);
        configDrift = createHash("sha256").update(JSON.stringify(stored)).digest("hex") !== createHash("sha256").update(JSON.stringify(localConfig)).digest("hex");
      } catch {
        configDrift = true;
      }
    }
    const active = runs.filter((run) => run.status === "queued" || run.status === "running");
    const staleActiveRuns = active.filter((run) => run.status === "running" && Date.parse(run.startedAt) < staleBefore).length;
    return finalizeGovernanceProject({
      id: summary.id,
      name: summary.name,
      rootUri: summary.rootUri,
      accessible,
      agentsFile,
      projectConfig: configStatus,
      policyProfile: localConfig?.execution.policy_profile ?? latest?.policyProfile ?? "unknown",
      policyDrift,
      configDrift,
      provider: latest?.providerOverride ?? process.env.DEFAULT_MODEL_PROVIDER ?? "mock",
      modelTier: latest?.modelTierOverride ?? null,
      indexedFiles: summary.indexedFiles,
      runCount: summary.runCount,
      activeRuns: summary.queuedRuns + summary.runningRuns,
      failedRuns: summary.failedRuns,
      staleActiveRuns,
      lastRunAt: summary.lastRunAt
    });
  }));
  const packageInfo = JSON.parse(packageRaw) as { version?: string };
  return buildGovernanceReport(packageInfo.version ?? "unknown", services.every((service) => service.reachable), projects.sort((a, b) =>
    ({ critical: 0, warning: 1, healthy: 2 })[a.health] - ({ critical: 0, warning: 1, healthy: 2 })[b.health] || a.name.localeCompare(b.name)
  ), process.env.DEFAULT_MODEL_PROVIDER ?? "mock", agents.length > 0 && workflows.length > 0);
}

async function loadDashboardEvaluations(limit = 250): Promise<DashboardEvaluationSuite[]> {
  const runs = (await listWorkflowRuns(limit)).filter((run) =>
    typeof run.evaluationMetadata?.suiteId === "string"
  );
  const evaluated: DashboardEvaluationRun[] = [];
  for (const run of runs) {
    const metadata = run.evaluationMetadata ?? {};
    const report = await loadCostQualityReport(run.id);
    if (!report) {
      continue;
    }
    const suiteId = stringValue(metadata.suiteId);
    const caseId = stringValue(metadata.caseId);
    const variantId = stringValue(metadata.variantId);
    if (!suiteId || !caseId || !variantId) {
      continue;
    }
    evaluated.push({
      runId: run.id,
      suiteId,
      suiteName: stringValue(metadata.suiteName) ?? suiteId,
      caseId,
      variantId,
      workflowId: run.workflowId,
      provider: run.providerOverride ?? Object.keys(report.providerMix)[0] ?? "unknown",
      modelTier: run.modelTierOverride ?? Object.keys(report.modelTierMix)[0] ?? "unknown",
      status: run.status,
      averageQuality: report.averageQuality,
      totalLatencyMs: report.totalLatencyMs,
      fallbackCount: report.fallbackCount,
      estimatedCostMix: report.estimatedCostMix,
      feedback: report.feedback.latest?.rating ?? null,
      startedAt: run.startedAt
    });
  }

  const suites = new Map<string, DashboardEvaluationRun[]>();
  for (const run of evaluated) {
    const selected = suites.get(run.suiteId) ?? [];
    selected.push(run);
    suites.set(run.suiteId, selected);
  }
  return [...suites.entries()].map(([id, suiteRuns]): DashboardEvaluationSuite => {
    const variantIds = [...new Set(suiteRuns.map((run) => run.variantId))];
    const variants = variantIds.map((variantId): DashboardEvaluationVariant => {
      const selected = suiteRuns.filter((run) => run.variantId === variantId);
      const scored = selected.filter((run) => run.averageQuality !== null);
      return {
        id: variantId,
        provider: selected[0]?.provider ?? "unknown",
        modelTier: selected[0]?.modelTier ?? "unknown",
        runs: selected.length,
        completed: selected.filter((run) => run.status === "completed").length,
        averageQuality: scored.length
          ? Math.round(scored.reduce((sum, run) => sum + (run.averageQuality ?? 0), 0) / scored.length * 1000) / 1000
          : null,
        averageLatencyMs: selected.length
          ? Math.round(selected.reduce((sum, run) => sum + run.totalLatencyMs, 0) / selected.length)
          : null,
        fallbackRate: Math.round(selected.reduce((sum, run) => sum + run.fallbackCount, 0) / Math.max(1, selected.length) * 1000) / 1000,
        estimatedCostMix: mergeCounts(selected.map((run) => run.estimatedCostMix)),
        feedbackCounts: countStrings(selected.flatMap((run) => run.feedback ? [run.feedback] : []))
      };
    }).sort((a, b) =>
      b.completed / Math.max(1, b.runs) - a.completed / Math.max(1, a.runs) ||
      (b.averageQuality ?? -1) - (a.averageQuality ?? -1) ||
      a.fallbackRate - b.fallbackRate ||
      (a.averageLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.averageLatencyMs ?? Number.MAX_SAFE_INTEGER)
    );
    return {
      id,
      name: suiteRuns[0]?.suiteName ?? id,
      workflowId: suiteRuns[0]?.workflowId ?? "unknown",
      runs: suiteRuns.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      variants,
      leader: variants[0]?.id ?? null,
      latestAt: suiteRuns.map((run) => run.startedAt).sort().at(-1) ?? ""
    };
  }).sort((a, b) => b.latestAt.localeCompare(a.latestAt));
}

function mergeCounts(items: Record<string, number>[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item)) {
      result[key] = (result[key] ?? 0) + value;
    }
  }
  return result;
}

function countStrings(items: string[]): Record<string, number> {
  return mergeCounts(items.map((item) => ({ [item]: 1 })));
}

async function loadDashboardUsageSummary(runs: DashboardRunStatus[], input: { includeMock: boolean }): Promise<DashboardUsageSummary> {
  const projectTokenTotals = new Map<string, number>();
  const metricRuns: DashboardRunStatus[] = [];
  const metricStages: CostQualityReport["stages"] = [];
  const estimates: RunUsageEstimate[] = [];
  let mockRunsExcluded = 0;
  let mockStagesExcluded = 0;

  for (const run of runs) {
    const details = await getWorkflowRunDetails(run.id);
    if (!details.run) {
      continue;
    }
    const artifacts = await listArtifacts({ runId: run.id });
    const report = buildCostQualityReport({
      run: details.run,
      tasks: details.tasks,
      receipts: details.receipts,
      artifacts
    });
    const mockStages = report.stages.filter((stage) => stage.providerId === "mock");
    const realStages = report.stages.filter((stage) => stage.providerId !== "mock");
    const mockOnlyRun = report.routedStages > 0 && realStages.length === 0;
    if (!input.includeMock && mockOnlyRun) {
      mockRunsExcluded += 1;
      mockStagesExcluded += mockStages.length;
      continue;
    }

    metricRuns.push(details.run);
    metricStages.push(...(input.includeMock ? report.stages : realStages));
    if (!input.includeMock) {
      mockStagesExcluded += mockStages.length;
    }
    estimates.push(await buildRunUsageEstimate({
      run: details.run,
      artifacts,
      routedStages: input.includeMock ? report.routedStages : Math.max(1, realStages.length),
      projectTokenTotals
    }));
  }

  const totalLatencyMs = metricStages.reduce((sum, stage) => sum + (stage.latencyMs ?? 0), 0);
  const latencyStages = metricStages.filter((stage) => stage.latencyMs !== null).length;
  const durations = estimates
    .map((estimate) => estimate.runDurationMs)
    .filter((duration): duration is number => duration !== null);
  const estimatedPromptTokens = estimates.reduce((sum, estimate) => sum + estimate.estimatedPromptTokens, 0);
  const estimatedBaselineTokens = estimates.reduce((sum, estimate) => sum + estimate.estimatedBaselineTokens, 0);
  const estimatedTokensSaved = estimates.reduce((sum, estimate) => sum + estimate.estimatedTokensSaved, 0);

  return {
    includeMock: input.includeMock,
    partial: false,
    note: null,
    runsAnalyzed: metricRuns.length,
    completedRuns: metricRuns.filter((run) => run.status === "completed").length,
    failedRuns: metricRuns.filter((run) => run.status === "failed").length,
    queuedRuns: metricRuns.filter((run) => run.status === "queued").length,
    runningRuns: metricRuns.filter((run) => run.status === "running").length,
    mockRunsExcluded,
    mockStagesExcluded,
    routedStages: metricStages.length,
    totalLatencyMs,
    averageLatencyMs: latencyStages ? Math.round(totalLatencyMs / latencyStages) : null,
    averageRunDurationMs: durations.length ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length) : null,
    estimatedPromptTokens,
    estimatedBaselineTokens,
    estimatedTokensSaved,
    tokenReductionPercent: estimatedBaselineTokens > 0 ? Math.round((estimatedTokensSaved / estimatedBaselineTokens) * 100) : null,
    providerMix: countDashboardStages(metricStages, (stage) => stage.providerId),
    costMix: countDashboardStages(metricStages, (stage) => stage.estimatedCostTier),
    modelTierMix: countDashboardStages(metricStages, (stage) => stage.modelTier),
    byoSavingsStages: metricStages.filter((stage) =>
      ["byo", "openai-compatible"].includes(stage.providerId) &&
      ["low", "medium", "none"].includes(stage.estimatedCostTier)
    ).length
  };
}

function fallbackDashboardUsageSummary(runs: DashboardRunStatus[], input: { includeMock: boolean; note: string }): DashboardUsageSummary {
  return {
    includeMock: input.includeMock,
    partial: true,
    note: input.note,
    runsAnalyzed: runs.length,
    completedRuns: runs.filter((run) => run.status === "completed").length,
    failedRuns: runs.filter((run) => run.status === "failed").length,
    queuedRuns: runs.filter((run) => run.status === "queued").length,
    runningRuns: runs.filter((run) => run.status === "running").length,
    mockRunsExcluded: 0,
    mockStagesExcluded: 0,
    routedStages: 0,
    totalLatencyMs: 0,
    averageLatencyMs: null,
    averageRunDurationMs: null,
    estimatedPromptTokens: 0,
    estimatedBaselineTokens: 0,
    estimatedTokensSaved: 0,
    tokenReductionPercent: null,
    providerMix: {},
    costMix: {},
    modelTierMix: {},
    byoSavingsStages: 0
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function loadDashboardProjectDetail(rootUri: string): Promise<DashboardProjectDetail | null> {
  const projects = await listProjectStorageSummaries(500);
  const project = projects.find((item) => item.rootUri === rootUri);
  if (!project) {
    return null;
  }
  const [files, memory, runs, contextFiles] = await Promise.all([
    listProjectFileSummaries({ projectRootUri: rootUri, limit: 20 }),
    getLatestMemory({ projectRootUri: rootUri, limit: 8 }),
    listWorkflowRunsForProject({ projectRootUri: rootUri, limit: 12 }),
    loadDashboardProjectContextFiles(rootUri)
  ]);
  const config = project.config as {
    actions?: { allowed_write_paths?: string[] };
    policies?: { allow_wide_open?: boolean };
  };
  return {
    project,
    files,
    memory,
    runs,
    contextFiles,
    initialized: contextFiles.some((file) => file.relativePath === ".agent-workflow/project.yaml" && file.exists),
    allowWrites: Boolean(config.policies?.allow_wide_open || (config.actions?.allowed_write_paths?.length ?? 0) > 0)
  };
}

async function loadDashboardProjectContextFiles(projectRootUri: string): Promise<DashboardProjectDetail["contextFiles"]> {
  const files = [
    ["AGENTS.md", "AGENTS.md"],
    ["Project Policy", ".agent-workflow/project.yaml"],
    ["Context", ".agent-workflow/context.md"],
    ["Commands", ".agent-workflow/commands.md"],
    ["Decisions", ".agent-workflow/decisions.md"],
    ["Schedules", ".agent-workflow/schedules.yaml"]
  ] as const;
  return Promise.all(files.map(async ([label, relativePath]) => {
    try {
      const raw = await fs.readFile(path.join(projectRootUri, relativePath), "utf8");
      return {
        label,
        relativePath,
        exists: true,
        preview: previewText(raw)
      };
    } catch {
      return {
        label,
        relativePath,
        exists: false,
        preview: ""
      };
    }
  }));
}

function previewText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 500) {
    return trimmed;
  }
  return `${trimmed.slice(0, 500)}\n...`;
}

async function buildRunUsageEstimate(input: {
  run: DashboardRunStatus;
  artifacts: Awaited<ReturnType<typeof listArtifacts>>;
  routedStages: number;
  projectTokenTotals?: Map<string, number>;
}): Promise<RunUsageEstimate> {
  const compiledBriefText = compiledBriefTextFromArtifacts(input.artifacts);
  const compiledBriefTokens = estimateDashboardTokens(compiledBriefText);
  const selectedSourceTokens = sumApproxSourceTokens(compiledBriefText);
  const indexedProjectTokens = await loadIndexedProjectTokenTotal(input.run.projectRootUri, input.projectTokenTotals);
  const routedStages = Math.max(1, input.routedStages);
  const estimatedPromptTokens = compiledBriefTokens * routedStages;
  const estimatedBaselineTokens = Math.max(indexedProjectTokens, selectedSourceTokens, compiledBriefTokens) * routedStages;
  const estimatedTokensSaved = Math.max(0, estimatedBaselineTokens - estimatedPromptTokens);

  return {
    runId: input.run.id,
    routedStages,
    indexedProjectTokens,
    compiledBriefTokens,
    selectedSourceTokens,
    estimatedPromptTokens,
    estimatedBaselineTokens,
    estimatedTokensSaved,
    tokenReductionPercent: estimatedBaselineTokens > 0 ? Math.round((estimatedTokensSaved / estimatedBaselineTokens) * 100) : null,
    runDurationMs: runDurationMs(input.run)
  };
}

async function loadIndexedProjectTokenTotal(projectRootUri: string, cache = new Map<string, number>()): Promise<number> {
  const cached = cache.get(projectRootUri);
  if (cached !== undefined) {
    return cached;
  }
  try {
    const summaries = await listProjectFileSummaries({
      projectRootUri,
      limit: 5000
    });
    const total = summaries.reduce((sum, summary) => sum + summary.tokenEstimate, 0);
    cache.set(projectRootUri, total);
    return total;
  } catch {
    cache.set(projectRootUri, 0);
    return 0;
  }
}

function compiledBriefTextFromArtifacts(artifacts: Awaited<ReturnType<typeof listArtifacts>>): string {
  const artifact = artifacts.find((item) => item.kind === "compiled_brief");
  if (!artifact) {
    return "";
  }
  const text = artifact.content.text;
  if (typeof text === "string") {
    return text;
  }
  return JSON.stringify(artifact.content);
}

function sumApproxSourceTokens(text: string): number {
  return [...text.matchAll(/Approx tokens:\s*(\d+)/gu)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
}

function estimateDashboardTokens(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

function runDurationMs(run: DashboardRunStatus): number | null {
  if (!run.finishedAt) {
    return null;
  }
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
    return null;
  }
  return finished - started;
}

function countDashboardStages(stages: CostQualityReport["stages"], keyFor: (stage: CostQualityReport["stages"][number]) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const stage of stages) {
    const key = keyFor(stage);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function loadPreferenceScorecard(input: {
  projectDir: string;
  limit: number;
}): Promise<PreferenceScorecard> {
  const runs = await listWorkflowRunsForProject({
    projectRootUri: input.projectDir,
    limit: input.limit
  });
  const reports: CostQualityReport[] = [];
  for (const run of runs) {
    const details = await getWorkflowRunDetails(run.id);
    if (!details.run) {
      continue;
    }
    const artifacts = await listArtifacts({ runId: run.id });
    reports.push(buildCostQualityReport({
      run: details.run,
      tasks: details.tasks,
      receipts: details.receipts,
      artifacts
    }));
  }
  return buildPreferenceScorecard({
    projectRootUri: input.projectDir,
    reports
  });
}

async function loadTuningProposals(input: {
  projectDir: string;
  limit: number;
}): Promise<TuningProposalSet> {
  const scorecard = await loadPreferenceScorecard(input);
  return buildTuningProposals(scorecard);
}

async function writeTuningApplicationPlan(projectDir: string, plan: TuningApplicationPlan): Promise<void> {
  for (const file of plan.files) {
    if (!file.relativePath.startsWith(".agent-workflow/tuning/")) {
      throw new Error(`Refusing to write tuning overlay outside .agent-workflow/tuning: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectDir, file.relativePath);
    const projectRoot = path.resolve(projectDir);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write tuning overlay outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

async function readTuningApprovalQueue(projectDir: string): Promise<TuningApprovalQueue> {
  const queuePath = path.join(projectDir, ".agent-workflow", "tuning", "approval-queue.json");
  const raw = await fs.readFile(queuePath, "utf8");
  const parsed = JSON.parse(raw) as TuningApprovalQueue;
  if (parsed.kind !== "agentflow_tuning_approval_queue" || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid tuning approval queue: ${queuePath}`);
  }
  return parsed;
}

async function writeTuningApprovalQueue(projectDir: string, queue: TuningApprovalQueue): Promise<void> {
  const tuningDir = path.join(projectDir, ".agent-workflow", "tuning");
  await fs.mkdir(tuningDir, { recursive: true });
  await fs.writeFile(path.join(tuningDir, "approval-queue.json"), `${JSON.stringify(queue, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(tuningDir, "approval-queue.md"), formatTuningApprovalQueueMarkdown(queue), "utf8");
}

async function readTuningApprovalHistory(projectDir: string): Promise<TuningApprovalHistory> {
  const historyPath = path.join(projectDir, ".agent-workflow", "tuning", "approval-history.json");
  const raw = await fs.readFile(historyPath, "utf8");
  const parsed = JSON.parse(raw) as TuningApprovalHistory;
  if (parsed.kind !== "agentflow_tuning_approval_history" || !Array.isArray(parsed.events)) throw new Error(`Invalid tuning approval history: ${historyPath}`);
  return parsed;
}

async function recordTuningHistory(projectDir: string, proposalIds: string[], status: TuningHistoryStatus, actor?: string, note?: string, relatedProposalId?: string): Promise<void> {
  if (!proposalIds.length) return;
  const existing = await readTuningApprovalHistory(projectDir).catch(() => undefined);
  const history = appendTuningApprovalHistory(existing, { projectRootUri: projectDir, proposalIds, status, actor, note, relatedProposalId });
  const tuningDir = path.join(projectDir, ".agent-workflow", "tuning");
  await fs.mkdir(tuningDir, { recursive: true });
  await fs.writeFile(path.join(tuningDir, "approval-history.json"), `${JSON.stringify(history, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(tuningDir, "approval-history.md"), formatTuningApprovalHistoryMarkdown(history), "utf8");
}

async function writeTuningPatchPlan(projectDir: string, plan: TuningPatchPlan): Promise<void> {
  for (const file of plan.files) {
    if (!file.relativePath.startsWith(".agent-workflow/tuning/patches/")) {
      throw new Error(`Refusing to write tuning patch plan outside .agent-workflow/tuning/patches: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectDir, file.relativePath);
    const projectRoot = path.resolve(projectDir);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write tuning patch plan outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

async function readTuningPatchPlan(projectDir: string): Promise<TuningPatchPlanDocument> {
  const patchPlanPath = path.join(projectDir, ".agent-workflow", "tuning", "patches", "patch-plan.json");
  const raw = await fs.readFile(patchPlanPath, "utf8");
  const parsed = JSON.parse(raw) as TuningPatchPlanDocument;
  if (parsed.kind !== "agentflow_tuning_patch_plan" || !Array.isArray(parsed.patches)) {
    throw new Error(`Invalid tuning patch plan: ${patchPlanPath}`);
  }
  return parsed;
}

function proposalSetFromApprovedQueue(queue: TuningApprovalQueue): TuningProposalSet {
  const proposals = queue.items.filter((item) => item.status === "approved").map((item) => item.proposal);
  return {
    projectRootUri: queue.projectRootUri,
    generatedAt: new Date().toISOString(),
    sourceRunsAnalyzed: queue.sourceRunsAnalyzed,
    proposals,
    summary: [
      `${proposals.length} approved tuning proposal(s) selected from the project-local approval queue.`,
      "Only approved proposals are included in this application plan."
    ]
  };
}

async function recordRunFeedback(input: {
  runId: string;
  rating: string;
  note: string;
  source: string;
}): Promise<{ ok: true; rating: FeedbackRating; artifactUri: string } | { ok: false; error: string }> {
  const rating = normalizeFeedbackRating(input.rating);
  if (!rating) {
    return { ok: false, error: "Rating must be accepted, revised, or rejected." };
  }

  const details = await getWorkflowRunDetails(input.runId);
  if (!details.run) {
    return { ok: false, error: `Unknown workflow run: ${input.runId}` };
  }

  const note = input.note.trim();
  const artifactContent = {
    runId: input.runId,
    workflowId: details.run.workflowId,
    task: details.run.task,
    projectName: details.run.projectName,
    projectRootUri: details.run.projectRootUri,
    rating,
    note,
    source: input.source,
    recordedAt: new Date().toISOString()
  };
  const artifactUri = await recordRunAction({
    runId: input.runId,
    agentId: "workflow-orchestrator",
    actionType: "run_feedback",
    target: input.runId,
    summary: `${rating}${note ? `: ${note}` : ""}`,
    artifactKind: "run_feedback",
    artifactContent
  });

  await upsertMemoryItem({
    projectRootUri: details.run.projectRootUri,
    sourceUri: `agentflow://feedback/${input.runId}/${Date.now()}`,
    summary: [
      `Workflow ${details.run.workflowId} feedback: ${rating}.`,
      `Task: ${details.run.task}`,
      note ? `Note: ${note}` : ""
    ].filter(Boolean).join(" "),
    metadata: {
      kind: "run_feedback",
      runId: input.runId,
      workflowId: details.run.workflowId,
      rating,
      note,
      source: input.source
    }
  });

  return { ok: true, rating, artifactUri };
}

function normalizeFeedbackRating(value: string): FeedbackRating | null {
  const normalized = normalizeLookup(value);
  if (normalized === "accept" || normalized === "accepted" || normalized === "good" || normalized === "approved") {
    return "accepted";
  }
  if (normalized === "revise" || normalized === "revised" || normalized === "edited" || normalized === "partial") {
    return "revised";
  }
  if (normalized === "reject" || normalized === "rejected" || normalized === "bad" || normalized === "wrong") {
    return "rejected";
  }
  return null;
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

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
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
  if (requestUrl.pathname === "/assets/queue-watcher.js") {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    response.end(queueWatcherScript());
    return;
  }
  if (request.method === "POST" && requestUrl.pathname === "/api/run-worker") {
    const form = await readFormBody(request);
    const result = await processDashboardRun({
      runId: form.get("runId") ?? "",
      mode: form.get("mode") ?? "batch",
      workerLimit: form.get("workerLimit") ?? "",
      timeoutMs: form.get("timeoutMs") ?? ""
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/queue-action") {
    const form = await readFormBody(request);
    const result = await processDashboardQueueAction({
      action: form.get("action") ?? "",
      runId: form.get("runId") ?? "",
      workerLimit: form.get("workerLimit") ?? "",
      project: form.get("project") ?? "",
      reason: form.get("reason") ?? "",
      confirmed: form.get("confirmed") === "on"
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/workflow-run") {
    const form = await readFormBody(request);
    const result = await queueDashboardWorkflowRun({
      workflowId: form.get("workflowId") ?? "",
      project: form.get("project") ?? "",
      task: form.get("task") ?? "",
      sourceTokenBudget: form.get("sourceTokenBudget") ?? "",
      sourceMaxFiles: form.get("sourceMaxFiles") ?? "",
      watch: form.get("watch") === "on",
      workerLimit: form.get("workerLimit") ?? "",
      timeoutMs: form.get("timeoutMs") ?? ""
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/project-index") {
    const form = await readFormBody(request);
    const result = await indexDashboardProject({
      project: form.get("project") ?? "",
      maxFiles: form.get("maxFiles") ?? "",
      refine: form.get("refine") === "on"
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/routing") {
    const form = await readFormBody(request);
    const result = await updateDashboardRouting({
      provider: form.get("provider") ?? "",
      autoProviders: form.get("autoProviders") ?? "",
      fastProvider: form.get("fastProvider") ?? "",
      standardProvider: form.get("standardProvider") ?? "",
      reasoningProvider: form.get("reasoningProvider") ?? "",
      fallbackProvider: form.get("fallbackProvider") ?? "",
      qualityThreshold: form.get("qualityThreshold") ?? ""
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/model") {
    const form = await readFormBody(request);
    const result = await updateDashboardModel({
      provider: form.get("provider") ?? "",
      model: form.get("model") ?? ""
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/follow-up") {
    const form = await readFormBody(request);
    const result = await runDashboardFollowUp({
      action: form.get("action") ?? "",
      runId: form.get("runId") ?? undefined,
      project: form.get("project") ?? undefined,
      ids: form.get("ids") ?? undefined,
      rating: form.get("rating") ?? undefined,
      note: form.get("note") ?? undefined
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (requestUrl.pathname === "/api/runs") {
    const runs = await listWorkflowRuns(50);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(runs, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/evaluations") {
    const suites = await loadDashboardEvaluations();
    const suiteId = requestUrl.searchParams.get("suite");
    const payload = suiteId ? suites.find((suite) => suite.id === suiteId) ?? null : suites;
    response.writeHead(payload ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/queue") {
    const queue = await listWorkflowQueue(100);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(queue, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/projects") {
    const projects = await listProjectStorageSummaries(100);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(projects, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/governance") {
    const report = await loadGovernanceReport(parsePositiveInteger(requestUrl.searchParams.get("staleMinutes") ?? "15", 15), requestUrl.searchParams.get("includeEphemeral") === "true");
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(filterGovernanceReport(report, requestUrl.searchParams), null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/bundles") {
    const verification = await verifyBundle(rootDir, normalizePolicy(requestUrl.searchParams.get("policy") ?? process.env.AGENTFLOW_BUNDLE_TRUST_POLICY));
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(verification, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/info") {
    const info = await loadDashboardInfo(dashboardUrlFromRequest(request));
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(info, null, 2));
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

  if (requestUrl.pathname === "/api/quality") {
    const runId = requestUrl.searchParams.get("id");
    if (!runId) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing id");
      return;
    }
    const report = await loadCostQualityReport(runId);
    if (!report) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Run not found");
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/preferences") {
    const project = requestUrl.searchParams.get("project");
    if (!project) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing project");
      return;
    }
    const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "25", 25);
    const scorecard = await loadPreferenceScorecard({
      projectDir: project,
      limit
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(scorecard, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/tuning") {
    const project = requestUrl.searchParams.get("project");
    if (!project) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing project");
      return;
    }
    const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "25", 25);
    const proposals = await loadTuningProposals({
      projectDir: project,
      limit
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(proposals, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/apply-tuning") {
    const project = requestUrl.searchParams.get("project");
    if (!project) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing project");
      return;
    }
    const limit = parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "25", 25);
    const proposals = await loadTuningProposals({
      projectDir: project,
      limit
    });
    const plan = buildTuningApplicationPlan(proposals, parseProposalIds(requestUrl.searchParams.get("ids") ?? "all"));
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ...plan, mode: "dry-run" }, null, 2));
    return;
  }

  if (requestUrl.pathname === "/run") {
    const runId = requestUrl.searchParams.get("id");
    if (!runId) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing id");
      return;
    }
    const details = await getWorkflowRunDetails(runId);
    if (!details.run) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Run not found");
      return;
    }
    const artifacts = await listArtifacts({ runId });
    const summary = await summarizeWorkflowRun(runId);
    const qualityReport = await loadCostQualityReport(runId);
    const usageEstimate = qualityReport
      ? await buildRunUsageEstimate({
        run: details.run,
        artifacts,
        routedStages: qualityReport.routedStages
      })
      : null;
    const preferenceScorecard = await loadPreferenceScorecard({
      projectDir: details.run.projectRootUri,
      limit: 25
    });
    const tuningProposals = buildTuningProposals(preferenceScorecard);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderRunDetailHtml({
      run: details.run,
      tasks: details.tasks,
      receipts: details.receipts,
      artifacts,
      summary: summary.ok ? summary.value : null,
      qualityReport,
      usageEstimate,
      preferenceScorecard,
      tuningProposals
    }));
    return;
  }

  if (requestUrl.pathname === "/queue") {
    const queue = await listWorkflowQueue(100);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderQueueHtml(queue));
    return;
  }

  if (requestUrl.pathname === "/evaluations") {
    const suites = await loadDashboardEvaluations();
    const requestedSuite = requestUrl.searchParams.get("suite");
    const selected = requestedSuite
      ? suites.find((suite) => suite.id === requestedSuite) ?? null
      : suites[0] ?? null;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderEvaluationsHtml(suites, selected));
    return;
  }

  if (requestUrl.pathname === "/governance") {
    const report = await loadGovernanceReport(parsePositiveInteger(requestUrl.searchParams.get("staleMinutes") ?? "15", 15), requestUrl.searchParams.get("includeEphemeral") === "true");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderGovernanceHtml(filterGovernanceReport(report, requestUrl.searchParams), requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/bundles") {
    const verification = await verifyBundle(rootDir, normalizePolicy(requestUrl.searchParams.get("policy") ?? process.env.AGENTFLOW_BUNDLE_TRUST_POLICY));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderBundleTrustHtml(verification));
    return;
  }

  if (requestUrl.pathname === "/runs") {
    const runs = await listWorkflowRuns(100);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderRunsHtml(runs));
    return;
  }

  if (requestUrl.pathname === "/projects") {
    const projects = await listProjectStorageSummaries(100);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderProjectsHtml(projects));
    return;
  }

  if (requestUrl.pathname === "/project") {
    const rootUri = requestUrl.searchParams.get("root");
    if (!rootUri) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing root");
      return;
    }
    const detail = await loadDashboardProjectDetail(rootUri);
    if (!detail) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Project not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderProjectDetailHtml(detail));
    return;
  }

  if (requestUrl.pathname === "/providers") {
    const info = await loadDashboardInfoFast(dashboardUrlFromRequest(request));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderProvidersHtml(info));
    return;
  }

  if (requestUrl.pathname === "/info") {
    const info = await loadDashboardInfo(dashboardUrlFromRequest(request));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardInfoHtml(info));
    return;
  }

  const [runs, workflows, worker, supervisor, queue, projects, services] = await Promise.all([
    listWorkflowRuns(25),
    loadWorkflows(rootDir),
    loadDashboardWorkerStatus(),
    loadDashboardSupervisorStatus(),
    listWorkflowQueue(100),
    listProjectStorageSummaries(100),
    checkServices()
  ]);
  const includeMock = requestUrl.searchParams.get("includeMock") === "true";
  const usage = await withTimeout(
    loadDashboardUsageSummary(runs.slice(0, 10), { includeMock }),
    1200,
    () => fallbackDashboardUsageSummary(runs, {
      includeMock,
      note: "Usage metrics timed out, so the dashboard rendered a fast run-status summary. Open run details or refresh for full cost/token estimates."
    })
  );
  const health: DashboardHomeHealth = {
    worker,
    supervisor,
    queue,
    projects,
    services,
    provider: process.env.DEFAULT_MODEL_PROVIDER ?? "mock",
    latestFailedRun: runs.find((run) => run.status === "failed") ?? null
  };
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(renderDashboardHtml(runs, workflows, usage, health));
}

function renderDashboardHtml(
  runs: Awaited<ReturnType<typeof listWorkflowRuns>>,
  workflows: Awaited<ReturnType<typeof loadWorkflows>>,
  usage: DashboardUsageSummary,
  health: DashboardHomeHealth
): string {
  const rows = runs.map((run) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${escapeHtml(run.workflowId)}</td>
      <td>${escapeHtml(run.projectName)}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.startedAt)}</td>
    </tr>
  `).join("");
  const workflowOptions = workflows
    .filter((workflow) => workflow.triggers.manual)
    .map((workflow) => `<option value="${escapeHtml(workflow.id)}">${escapeHtml(workflow.name)} (${escapeHtml(workflow.id)})</option>`)
    .join("");
  const defaultProject = process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "templates/project";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Dashboard</title>
  <style>
    ${dashboardCss()}
  </style>
</head>
<body>
  ${dashboardNav("dashboard")}
  <main>
    <div class="topbar">
      <div>
        <h1>Agent Workflow Dashboard</h1>
        <p class="muted">Local control center for reusable development agents, runs, queues, providers, and project context.</p>
      </div>
      <div class="actions">
        <a class="button secondary" href="/queue">Queue</a>
        <a class="button secondary" href="/projects">Projects</a>
        <a class="button secondary" href="/providers">Providers</a>
        <a class="button secondary" href="/info">Info</a>
        <a class="button secondary" href="/api/runs">JSON</a>
      </div>
    </div>
    <section class="panel">
      <h2>System Health</h2>
      ${renderDashboardHealthHtml(health)}
    </section>
    <section class="panel">
      <h2>Needs Attention</h2>
      ${renderDashboardAttentionHtml(health)}
    </section>
    <section class="panel">
      <h2>Quick Actions</h2>
      <div class="actions">
        ${workflowPresets.map((preset) => presetForm(preset.id, preset.label, preset.project)).join("")}
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Background Worker</h2>
          <span class="muted">${escapeHtml(workerStatusDetail(health.worker))}</span>
        </div>
        <a class="button secondary" href="/queue">Open Queue</a>
      </div>
      ${renderWorkerStatusHtml(health.worker)}
    </section>
    <section class="panel">
      <h2>Run Workflow</h2>
      <form class="workflow-form" method="post" action="/api/workflow-run">
        <label>Workflow
          <select name="workflowId">${workflowOptions}</select>
        </label>
        <label>Project path
          <input name="project" value="${escapeHtml(defaultProject)}" placeholder="/path/to/project">
        </label>
        <label class="wide">Task
          <textarea name="task" rows="4" placeholder="Describe the work to run"></textarea>
        </label>
        <label>Source token budget
          <input name="sourceTokenBudget" inputmode="numeric" placeholder="3000">
        </label>
        <label>Source max files
          <input name="sourceMaxFiles" inputmode="numeric" placeholder="20">
        </label>
        <label>Worker limit
          <input name="workerLimit" inputmode="numeric" value="6">
        </label>
        <label>Watch timeout ms
          <input name="timeoutMs" inputmode="numeric" value="60000">
        </label>
        <label class="check-row">
          <input type="checkbox" name="watch">
          Run and watch
        </label>
        <div class="form-actions"><button type="submit">Queue Run</button></div>
      </form>
      <p class="muted">Queue only returns immediately. Run and watch processes a bounded number of worker ticks in the browser request, then returns the run status and link.</p>
    </section>
    <section class="panel">
      <h2>Usage & Performance</h2>
      ${renderDashboardUsageHtml(usage)}
    </section>
    <table>
      <thead><tr><th>Run</th><th>Status</th><th>Workflow</th><th>Project</th><th>Task</th><th>Started</th></tr></thead>
      <tbody>${rows || "<tr><td colspan=\"6\">No runs found.</td></tr>"}</tbody>
    </table>
  </main>
</body>
</html>`;
}

function renderQueueHtml(queue: DashboardQueueItem[]): string {
  const active = queue.filter((item) => item.runStatus === "queued" || item.runStatus === "running");
  const failed = queue.filter((item) => item.runStatus === "failed");
  const rows = queue.map((item) => {
    const taskSummary = `${item.completedTasks}/${item.totalTasks} done, ${item.queuedTasks} queued, ${item.runningTasks} running, ${item.failedTasks} failed`;
    const currentStage = item.runningStageId
      ? `${item.runningStageId} (${item.runningAgentId ?? "unknown"})`
      : item.nextStageId
        ? `${item.nextStageId} (${item.nextAgentId ?? "unknown"})`
        : "none";
    return `
      <tr>
        <td><a href="/run?id=${encodeURIComponent(item.runId)}">${escapeHtml(item.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(item.workflowId)}</span></td>
        <td><span class="status ${escapeHtml(item.runStatus)}">${escapeHtml(item.runStatus)}</span></td>
        <td>${escapeHtml(item.projectName)}<br><span class="muted">${escapeHtml(item.projectRootUri)}</span></td>
        <td>${escapeHtml(item.task)}</td>
        <td>${escapeHtml(taskSummary)}<br><span class="muted">current: ${escapeHtml(currentStage)}</span></td>
        <td>${renderDashboardDateTime(item.oldestRunningAt ?? item.oldestQueuedAt ?? item.startedAt)}</td>
        <td><div class="actions">${queueItemForms(item)}</div></td>
      </tr>
    `;
  }).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Queue</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("queue")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Queue</h1>
        <span id="queue-watch-status" class="muted">Queue watcher starting…</span>
      </div>
      <a class="button secondary" href="/api/queue">JSON</a>
    </div>
    <section class="panel">
      <div class="meta-grid">
        <div><strong>Active Runs</strong>${formatNumber(active.length)}</div>
        <div><strong>Failed Runs</strong>${formatNumber(failed.length)}</div>
        <div><strong>Queued Tasks</strong>${formatNumber(queue.reduce((sum, item) => sum + item.queuedTasks, 0))}</div>
        <div><strong>Running Tasks</strong>${formatNumber(queue.reduce((sum, item) => sum + item.runningTasks, 0))}</div>
      </div>
      <div class="actions">
        ${queueProcessForm()}
      </div>
    </section>
    ${failed.length ? `<section class="panel warn-panel">
      <h2>Clear Failed Queue Items</h2>
      <p class="muted">Dismissal removes failed runs from this queue without deleting their history, artifacts, or receipts.</p>
      ${queueDismissAllForm()}
    </section>` : ""}
    <section class="panel">
      <h2>Runs Needing Attention</h2>
      <table>
        <thead><tr><th>Run</th><th>Status</th><th>Project</th><th>Task</th><th>Stage Tasks</th><th>Oldest Active</th><th>Actions</th></tr></thead>
        <tbody>${rows || "<tr><td colspan=\"7\">Queue is clear.</td></tr>"}</tbody>
      </table>
    </section>
  </main>
  <script>
    (() => {
      const status = document.getElementById("queue-watch-status");
      if (!("Worker" in window)) {
        status.textContent = "Live queue updates unavailable; refresh manually.";
        return;
      }
      const watcher = new Worker("/assets/queue-watcher.js");
      watcher.onmessage = (event) => {
        if (event.data.type === "error") {
          status.textContent = "Queue watcher reconnecting…";
          return;
        }
        status.textContent = event.data.active > 0
          ? "Watching " + event.data.active + " active run" + (event.data.active === 1 ? "" : "s") + " · updated " + new Date(event.data.checkedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
          : "Queue watcher idle · checked " + new Date(event.data.checkedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        if (event.data.changed) window.location.reload();
      };
      watcher.postMessage({ type: "start", signature: ${JSON.stringify(queueSnapshotSignature(queue))} });
      window.addEventListener("pagehide", () => watcher.postMessage({ type: "stop" }), { once: true });
    })();
  </script>
</body>
</html>`;
}

function renderRunsHtml(runs: DashboardRunStatus[]): string {
  const rows = runs.map((run) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a><br><span class="muted">${escapeHtml(run.id)}</span></td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${escapeHtml(run.workflowId)}</td>
      <td>${escapeHtml(run.projectName)}<br><span class="muted">${escapeHtml(run.projectRootUri)}</span></td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.startedAt)}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Runs</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("runs")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Runs</h1>
      </div>
      <a class="button secondary" href="/api/runs">JSON</a>
    </div>
    <section class="panel">
      <h2>Recent Runs</h2>
      <table>
        <thead><tr><th>Run</th><th>Status</th><th>Workflow</th><th>Project</th><th>Task</th><th>Started</th></tr></thead>
        <tbody>${rows || "<tr><td colspan=\"6\">No runs found.</td></tr>"}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function renderEvaluationsHtml(suites: DashboardEvaluationSuite[], selected: DashboardEvaluationSuite | null): string {
  const suiteLinks = suites.map((suite) => `
    <a class="suite-link ${selected?.id === suite.id ? "active" : ""}" href="/evaluations?suite=${encodeURIComponent(suite.id)}">
      <strong>${escapeHtml(suite.name)}</strong>
      <span>${escapeHtml(suite.workflowId)} · ${suite.runs.length} runs</span>
      <small>${renderDashboardDateTime(suite.latestAt)}</small>
    </a>
  `).join("");
  const variantRows = selected?.variants.map((variant) => `
    <tr class="${selected.leader === variant.id ? "leader-row" : ""}">
      <td><strong>${escapeHtml(variant.id)}</strong>${selected.leader === variant.id ? '<span class="flag good">leader</span>' : ""}</td>
      <td>${escapeHtml(variant.provider)}</td>
      <td>${escapeHtml(variant.modelTier)}</td>
      <td>${variant.completed}/${variant.runs}</td>
      <td>${variant.averageQuality ?? "n/a"}</td>
      <td>${variant.averageLatencyMs === null ? "n/a" : formatDuration(variant.averageLatencyMs)}</td>
      <td>${variant.fallbackRate}</td>
      <td>${escapeHtml(formatInlineCounts(variant.estimatedCostMix))}</td>
      <td>${escapeHtml(formatInlineCounts(variant.feedbackCounts))}</td>
    </tr>
  `).join("") ?? "";
  const runRows = selected?.runs.map((run) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</a></td>
      <td>${escapeHtml(run.caseId)}</td>
      <td>${escapeHtml(run.variantId)}</td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${run.averageQuality ?? "n/a"}</td>
      <td>${formatDuration(run.totalLatencyMs)}</td>
      <td>${run.fallbackCount}</td>
      <td>${escapeHtml(run.feedback ?? "none")}</td>
    </tr>
  `).join("") ?? "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Evaluations</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("evaluations")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Evaluations</h1>
        <p class="muted">Compare workflow quality, latency, fallback behavior, cost mix, and feedback across provider, tier, and prompt variants.</p>
      </div>
      <a class="button secondary" href="/api/evaluations${selected ? `?suite=${encodeURIComponent(selected.id)}` : ""}">JSON</a>
    </div>
    <div class="comparison-layout">
      <aside class="suite-list" aria-label="Evaluation suites">
        <h2>Suites</h2>
        ${suiteLinks || '<p class="muted">No evaluation runs found.</p>'}
      </aside>
      <div>
        ${selected ? `
          <section class="panel">
            <div class="section-heading">
              <div><h2>${escapeHtml(selected.name)}</h2><span class="muted">${escapeHtml(selected.workflowId)} · latest ${renderDashboardDateTime(selected.latestAt)}</span></div>
              <span class="flag good">Leader: ${escapeHtml(selected.leader ?? "none")}</span>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Variant</th><th>Provider</th><th>Tier</th><th>Completed</th><th>Quality</th><th>Latency</th><th>Fallbacks/run</th><th>Cost mix</th><th>Feedback</th></tr></thead>
                <tbody>${variantRows}</tbody>
              </table>
            </div>
          </section>
          <section class="panel">
            <h2>Run matrix</h2>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Run</th><th>Case</th><th>Variant</th><th>Status</th><th>Quality</th><th>Latency</th><th>Fallbacks</th><th>Feedback</th></tr></thead>
                <tbody>${runRows}</tbody>
              </table>
            </div>
          </section>
        ` : '<section class="panel"><h2>No evaluation data</h2><p>Run <code>agentflow evaluate</code> to populate this comparison view.</p></section>'}
      </div>
    </div>
  </main>
</body>
</html>`;
}

function filterGovernanceReport(report: GovernanceReport, params: URLSearchParams): GovernanceReport {
  const health = params.get("health");
  const provider = params.get("provider");
  const profile = params.get("policyProfile");
  const projects = report.projects.filter((project) =>
    (!health || health === "all" || project.health === health) &&
    (!provider || project.provider === provider) &&
    (!profile || project.policyProfile === profile)
  );
  return buildGovernanceReport(report.bundleVersion, report.servicesReady, projects, report.configuredProvider, report.definitionsReady);
}

function renderGovernanceHtml(report: GovernanceReport, params: URLSearchParams): string {
  const providers = [...new Set(report.projects.map((project) => project.provider))].sort();
  const profiles = [...new Set(report.projects.map((project) => project.policyProfile))].sort();
  const rows = report.projects.map((project) => `
    <tr>
      <td><strong>${escapeHtml(project.name)}</strong><br><span class="muted">${escapeHtml(project.rootUri)}</span></td>
      <td><span class="flag ${project.health === "healthy" ? "good" : project.health === "warning" ? "warn" : "bad"}">${project.health}</span></td>
      <td>${escapeHtml(project.policyProfile)}<br><span class="muted">policy drift: ${project.policyDrift ?? "unknown"}<br>config drift: ${project.configDrift ?? "unknown"}</span></td>
      <td>${escapeHtml(project.provider)}<br><span class="muted">${escapeHtml(project.modelTier ?? "default tier")}</span></td>
      <td>${project.activeRuns} active / ${project.staleActiveRuns} stale<br><span class="muted">${project.failedRuns} failed · ${project.runCount} total</span></td>
      <td>${project.indexedFiles}<br><span class="muted">config: ${project.projectConfig}</span></td>
      <td>${project.recommendations.length ? `<ul>${project.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : '<span class="flag good">No action</span>'}</td>
    </tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Governance</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("governance")}
  <main><div class="topbar"><div><a href="/">Dashboard</a><h1>Multi-project Governance</h1><p class="muted">Read-only project health, policy drift, provider, queue, and remediation inspection.</p></div><a class="button secondary" href="/api/governance?${escapeHtml(params.toString())}">JSON</a></div>
  <section class="panel"><div class="meta-grid"><div><strong>Healthy</strong>${report.counts.healthy}</div><div><strong>Warning</strong>${report.counts.warning}</div><div><strong>Critical</strong>${report.counts.critical}</div><div><strong>Services</strong>${report.servicesReady ? "ready" : "attention"}</div><div><strong>Definitions</strong>${report.definitionsReady ? "ready" : "attention"}</div><div><strong>Configured Provider</strong>${escapeHtml(report.configuredProvider)}</div></div>
  <form method="get" class="form-grid"><label>Health<select name="health"><option value="all">all</option>${["healthy", "warning", "critical"].map((value) => `<option${params.get("health") === value ? " selected" : ""}>${value}</option>`).join("")}</select></label><label>Provider<select name="provider"><option value="">all</option>${providers.map((value) => `<option${params.get("provider") === value ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label><label>Policy profile<select name="policyProfile"><option value="">all</option>${profiles.map((value) => `<option${params.get("policyProfile") === value ? " selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label><div class="form-actions"><button type="submit">Filter</button></div></form></section>
  <section class="panel"><div class="table-wrap"><table><thead><tr><th>Project</th><th>Health</th><th>Policy</th><th>Provider</th><th>Runs</th><th>Context</th><th>Recommended action</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No projects match these filters.</td></tr>'}</tbody></table></div></section></main></body></html>`;
}

function renderBundleTrustHtml(verification: BundleVerification): string {
  const statusClass = verification.status === "trusted" ? "good" : verification.allowed ? "warn" : "bad";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Bundle Trust</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("bundles")}
  <main><div class="topbar"><div><a href="/">Dashboard</a><h1>Workflow Bundle Trust</h1><p class="muted">Origin, integrity, compatibility, and signer trust. A signature never expands project execution permissions.</p></div><a class="button secondary" href="/api/bundles">JSON</a></div>
  <section class="panel"><div class="section-heading"><div><h2>${escapeHtml(verification.bundleId)} ${escapeHtml(verification.bundleVersion)}</h2><span class="muted">Manifest ${escapeHtml(verification.manifestChecksum)}</span></div><span class="flag ${statusClass}">${escapeHtml(verification.status)}</span></div>
  <div class="meta-grid"><div><strong>Policy</strong>${escapeHtml(verification.policy)}</div><div><strong>Decision</strong>${verification.allowed ? "allowed" : "rejected"}</div><div><strong>Signer</strong>${escapeHtml(verification.signerId ?? "none")}</div><div><strong>Trusted</strong>${verification.trusted}</div></div>
  <p><strong>Fingerprint:</strong> <code>${escapeHtml(verification.keyFingerprint ?? "none")}</code></p><p><strong>Signed:</strong> ${renderDashboardDateTime(verification.signedAt, "not signed")}<br><strong>Expires:</strong> ${renderDashboardDateTime(verification.expiresAt, "none")}</p>
  <h3>Verification</h3><ul>${verification.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>
  <section class="panel"><h2>Trust policy</h2><p>Set <code>AGENTFLOW_BUNDLE_TRUST_POLICY</code> to <code>allow</code>, <code>warn</code>, or <code>require</code>. Use the CLI to add public signer keys; private signing keys are never stored by Agent Workflow.</p></section></main></body></html>`;
}

function renderProjectsHtml(projects: DashboardProjectSummary[]): string {
  const rows = projects.map((project) => `
    <tr>
      <td><a href="/project?root=${encodeURIComponent(project.rootUri)}">${escapeHtml(project.name)}</a><br><span class="muted">${escapeHtml(project.rootUri)}</span></td>
      <td>${escapeHtml(project.profile)}</td>
      <td>${formatNumber(project.indexedFiles)}<br><span class="muted">${formatNumber(project.indexedTokens)} tokens</span></td>
      <td>${formatNumber(project.memoryItems)}</td>
      <td>${formatNumber(project.runCount)}<br><span class="muted">${project.completedRuns} ok / ${project.failedRuns} failed / ${project.queuedRuns + project.runningRuns} active</span></td>
      <td>${project.lastRunId ? `<a href="/run?id=${encodeURIComponent(project.lastRunId)}">${escapeHtml(project.lastRunId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(project.lastWorkflowId ?? "unknown")} ${escapeHtml(project.lastRunStatus ?? "")}</span>` : "none"}</td>
      <td>${renderDashboardDateTime(project.lastIndexedAt, "not indexed")}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Projects</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("projects")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Projects</h1>
      </div>
      <a class="button secondary" href="/api/projects">JSON</a>
    </div>
    <section class="panel">
      <h2>Known Projects</h2>
      <table>
        <thead><tr><th>Project</th><th>Profile</th><th>Indexed</th><th>Memory</th><th>Runs</th><th>Last Run</th><th>Last Indexed</th></tr></thead>
        <tbody>${rows || "<tr><td colspan=\"7\">No projects found. Run onboarding or index a project first.</td></tr>"}</tbody>
      </table>
    </section>
  </main>
</body>
</html>`;
}

function renderProjectDetailHtml(detail: DashboardProjectDetail): string {
  const project = detail.project;
  const contextRows = detail.contextFiles.map((file) => `
    <details class="artifact" ${file.exists ? "" : ""}>
      <summary>${escapeHtml(file.label)} <span class="muted">${escapeHtml(file.relativePath)} - ${file.exists ? "found" : "missing"}</span></summary>
      ${file.exists ? `<pre>${escapeHtml(file.preview)}</pre>` : "<p class=\"muted\">File not found in this project.</p>"}
    </details>
  `).join("");
  const runRows = detail.runs.map((run) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${escapeHtml(run.workflowId)}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.startedAt)}</td>
    </tr>
  `).join("");
  const fileRows = detail.files.map((file) => `
    <tr>
      <td>${escapeHtml(file.sourceUri)}</td>
      <td>${formatNumber(file.tokenEstimate)}</td>
      <td>${renderDashboardDateTime(file.updatedAt)}</td>
      <td>${escapeHtml(file.summary)}</td>
    </tr>
  `).join("");
  const memoryRows = detail.memory.map((item) => `
    <tr>
      <td>${escapeHtml(item.sourceUri)}</td>
      <td>${renderDashboardDateTime(item.updatedAt)}</td>
      <td>${escapeHtml(item.summary)}</td>
    </tr>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(project.name)} - Agent Workflow</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("projects")}
  <main>
    <div class="topbar">
      <div>
        <a href="/projects">Projects</a>
        <h1>${escapeHtml(project.name)}</h1>
        <p class="muted">${escapeHtml(project.rootUri)}</p>
      </div>
      <a class="button secondary" href="/api/preferences?project=${encodeURIComponent(project.rootUri)}">Preference JSON</a>
    </div>
    <section class="panel">
      <div class="meta-grid">
        <div><strong>Initialized</strong>${detail.initialized ? "yes" : "no"}</div>
        <div><strong>Profile</strong>${escapeHtml(project.profile)}</div>
        <div><strong>Write Policy</strong>${detail.allowWrites ? "configured" : "read-only or missing"}</div>
        <div><strong>Indexed Files</strong>${formatNumber(project.indexedFiles)}</div>
        <div><strong>Indexed Tokens</strong>${formatNumber(project.indexedTokens)}</div>
        <div><strong>Memory Items</strong>${formatNumber(project.memoryItems)}</div>
        <div><strong>Runs</strong>${formatNumber(project.runCount)}</div>
        <div><strong>Last Indexed</strong>${renderDashboardDateTime(project.lastIndexedAt, "not indexed")}</div>
      </div>
    </section>
    <section class="panel">
      <h2>Project Actions</h2>
      <div class="actions">
        ${projectIndexForm(project.rootUri)}
        ${projectActionForm(project.rootUri, "mira-ux-pass", "UX Pass")}
        ${projectActionForm(project.rootUri, "pr-review", "Review")}
        ${projectActionForm(project.rootUri, "production-readiness", "Production Readiness")}
        ${projectActionForm(project.rootUri, "maintain-context", "Maintain Context")}
      </div>
    </section>
    <section class="panel">
      <h2>Context Files</h2>
      ${contextRows}
    </section>
    <section class="panel">
      <h2>Recent Runs</h2>
      <table><thead><tr><th>Run</th><th>Status</th><th>Workflow</th><th>Task</th><th>Started</th></tr></thead><tbody>${runRows || "<tr><td colspan=\"5\">No runs.</td></tr>"}</tbody></table>
    </section>
    <section class="panel">
      <h2>Indexed Files</h2>
      <table><thead><tr><th>File</th><th>Tokens</th><th>Indexed</th><th>Summary</th></tr></thead><tbody>${fileRows || "<tr><td colspan=\"4\">No indexed files.</td></tr>"}</tbody></table>
    </section>
    <section class="panel">
      <h2>Memory</h2>
      <table><thead><tr><th>Source</th><th>Updated</th><th>Summary</th></tr></thead><tbody>${memoryRows || "<tr><td colspan=\"3\">No memory items.</td></tr>"}</tbody></table>
    </section>
  </main>
</body>
</html>`;
}

function renderRunDetailHtml(input: {
  run: NonNullable<Awaited<ReturnType<typeof getWorkflowRunDetails>>["run"]>;
  tasks: Awaited<ReturnType<typeof getWorkflowRunDetails>>["tasks"];
  receipts: Awaited<ReturnType<typeof getWorkflowRunDetails>>["receipts"];
  artifacts: Awaited<ReturnType<typeof listArtifacts>>;
  summary: RunSummary | null;
  qualityReport: CostQualityReport | null;
  usageEstimate: RunUsageEstimate | null;
  preferenceScorecard: PreferenceScorecard | null;
  tuningProposals: TuningProposalSet | null;
}): string {
  const completedTasks = input.tasks.filter((task) => task.status === "completed").length;
  const failedTasks = input.tasks.filter((task) => task.status === "failed").length;
  const activeTasks = input.tasks.filter((task) => task.status === "running" || task.status === "queued").length;
  const shouldRefresh = input.run.status === "queued" || input.run.status === "running";
  const summaryBlock = input.summary
    ? `<pre>${escapeHtml(formatRunSummary(input.summary))}</pre>`
    : "<p>No summary available.</p>";
  const taskRows = input.tasks.map((task) => `
    <tr><td>${escapeHtml(task.stageId)}</td><td>${escapeHtml(task.agentId)}</td><td>${escapeHtml(task.status)}</td><td>${task.attempts}</td></tr>
  `).join("");
  const receiptRows = input.receipts.map((receipt) => `
    <tr><td>${escapeHtml(receipt.actionType)}</td><td>${escapeHtml(receipt.agentId)}</td><td>${escapeHtml(receipt.summary)}</td></tr>
  `).join("");
  const artifactBlocks = input.artifacts.map((artifact) => `
    <details class="artifact">
      <summary>${escapeHtml(artifact.kind)} ${escapeHtml(artifact.uri)}</summary>
      <pre>${escapeHtml(JSON.stringify(artifact.content, null, 2))}</pre>
    </details>
  `).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${shouldRefresh ? "<meta http-equiv=\"refresh\" content=\"5\">" : ""}
  <title>Run ${escapeHtml(input.run.id.slice(0, 8))}</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("runs")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Run ${escapeHtml(input.run.id)}</h1>
      </div>
      <a class="button secondary" href="/api/run?id=${encodeURIComponent(input.run.id)}">JSON</a>
      <a class="button secondary" href="/api/quality?id=${encodeURIComponent(input.run.id)}">Quality JSON</a>
      <a class="button secondary" href="/api/preferences?project=${encodeURIComponent(input.run.projectRootUri)}">Preference JSON</a>
      <a class="button secondary" href="/api/tuning?project=${encodeURIComponent(input.run.projectRootUri)}">Tuning JSON</a>
    </div>
    <section class="panel">
      <div class="meta-grid">
        <div><strong>Status</strong><span class="status ${escapeHtml(input.run.status)}">${escapeHtml(input.run.status)}</span></div>
        <div><strong>Workflow</strong>${escapeHtml(input.run.workflowId)}</div>
        <div><strong>Project</strong>${escapeHtml(input.run.projectName)}</div>
        <div><strong>Started</strong>${renderDashboardDateTime(input.run.startedAt)}</div>
        <div><strong>Tasks</strong>${completedTasks}/${input.tasks.length} completed</div>
        <div><strong>Failed</strong>${failedTasks}</div>
        <div><strong>Active</strong>${activeTasks}</div>
        <div><strong>Receipts</strong>${input.receipts.length}</div>
      </div>
      <p>${escapeHtml(input.run.task)}</p>
      <div class="actions">
        ${workerActionForm(input.run.id, "batch", "Process Next Batch")}
        ${workerActionForm(input.run.id, "watch", "Run Until Complete")}
        ${queueRunActionForm(input.run.id, "resume-checkpoint", "Resume Checkpoint")}
        ${queueRunActionForm(input.run.id, "replay-run", "Replay Run")}
        ${runActionForm(input.run.id, "summarize", "Summarize Run")}
        ${runActionForm(input.run.id, "debug-failure", "Debug Failure")}
        ${runActionForm(input.run.id, "mira-ux-pass", "Ask Mira")}
        ${runActionForm(input.run.id, "frontend-pass", "Frontend Pass")}
        ${runActionForm(input.run.id, "maintain-context", "Maintain Context")}
      </div>
    </section>
    <section class="panel">
      <h2>Feedback</h2>
      ${input.qualityReport ? renderFeedbackHtml(input.run.id, input.qualityReport) : "<p>No feedback available.</p>"}
    </section>
    <section class="panel">
      <h2>Summary</h2>
      ${summaryBlock}
    </section>
    <section class="panel">
      <h2>Cost & Quality</h2>
      ${input.qualityReport ? renderCostQualityHtml(input.qualityReport) : "<p>No routing data available.</p>"}
    </section>
    <section class="panel">
      <h2>Token Savings Estimate</h2>
      ${input.usageEstimate ? renderRunUsageEstimateHtml(input.usageEstimate) : "<p>No token estimate available.</p>"}
    </section>
    <section class="panel">
      <h2>Preference Scorecard</h2>
      ${input.preferenceScorecard ? renderPreferenceScorecardHtml(input.preferenceScorecard) : "<p>No preference scorecard available.</p>"}
    </section>
    <section class="panel">
      <h2>Tuning Proposals</h2>
      ${input.tuningProposals ? renderTuningProposalsHtml(input.tuningProposals) : "<p>No tuning proposals available.</p>"}
    </section>
    <section class="panel">
      <h2>Stages</h2>
      <table><thead><tr><th>Stage</th><th>Agent</th><th>Status</th><th>Attempts</th></tr></thead><tbody>${taskRows}</tbody></table>
    </section>
    <section class="panel">
      <h2>Receipts</h2>
      <table><thead><tr><th>Action</th><th>Agent</th><th>Summary</th></tr></thead><tbody>${receiptRows || "<tr><td colspan=\"3\">No receipts.</td></tr>"}</tbody></table>
    </section>
    <section class="panel">
      <h2>Artifacts</h2>
      ${artifactBlocks || "<p>No artifacts.</p>"}
    </section>
  </main>
</body>
</html>`;
}

type DashboardInfo = {
  app: {
    name: string;
    version: string;
    rootDir: string;
    dashboardUrl: string;
  };
  provider: {
    selected: string;
    adapter: string;
    model?: string;
    modelEnv?: string;
    baseUrl?: string;
    apiKeyConfigured?: boolean;
    awsProfile?: string;
    canSelectModel: boolean;
    availableModels: string[];
    availableModelsError?: string;
    autoRoutes?: Array<{
      tier: string;
      providerId: string;
      estimatedCostTier: string;
      reason: string;
    }>;
    providerStatuses?: Array<{
      providerId: string;
      label: string;
      configured: boolean;
      status: "ready" | "missing" | "not configured";
      model?: string;
      baseUrl?: string;
      apiKeyStatus?: string;
      awsProfile?: string;
      awsRegion?: string;
      details: string[];
    }>;
    routingConfig: {
      provider: string;
      autoProviders: string;
      fastProvider: string;
      standardProvider: string;
      reasoningProvider: string;
      fallbackProvider: string;
      qualityThreshold: string;
    };
  };
  services: Array<{
    name: string;
    reachable: boolean;
    message: string;
    requiredFor: string;
  }>;
  registry: {
    agents: number;
    workflows: number;
  };
  bundle: {
    version: string;
    checksum: string;
    files: number;
    source: string;
  } | null;
  storage: {
    databaseUrlConfigured: boolean;
    redisUrlConfigured: boolean;
    objectStorageConfigured: boolean;
  };
  worker: DashboardWorkerStatus;
  supervisor: DashboardSupervisorStatus;
  commands: string[];
};

async function loadDashboardInfo(dashboardUrl: string): Promise<DashboardInfo> {
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8")) as { name?: string; version?: string };
  const selectedProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
  let adapter = selectedProvider;
  if (selectedProvider === "auto") {
    adapter = "auto-router";
  } else {
    try {
      adapter = providerFromEnv(selectedProvider).id;
    } catch {
      adapter = "unavailable";
    }
  }
  const [serviceChecks, agents, workflows, manifest, worker, supervisor] = await Promise.all([
    checkServices(),
    loadAgents(rootDir),
    loadWorkflows(rootDir),
    loadCommittedBundleManifest(rootDir),
    loadDashboardWorkerStatus(),
    loadDashboardSupervisorStatus()
  ]);

  return {
    app: {
      name: packageJson.name ?? "agent-workflow",
      version: packageJson.version ?? "0.0.0",
      rootDir,
      dashboardUrl
    },
    provider: await describeProvider(selectedProvider, adapter),
    services: serviceChecks.map((check) => ({
      name: check.endpoint.name,
      reachable: check.reachable,
      message: check.message,
      requiredFor: check.endpoint.requiredFor
    })),
    registry: {
      agents: agents.length,
      workflows: workflows.length
    },
    bundle: manifest ? {
      version: manifest.bundle.version,
      checksum: manifest.checksum.value,
      files: manifest.counts.files,
      source: manifest.bundle.source
    } : null,
    storage: {
      databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
      redisUrlConfigured: Boolean(process.env.REDIS_URL),
      objectStorageConfigured: Boolean(process.env.OBJECT_STORAGE_ENDPOINT && process.env.OBJECT_STORAGE_BUCKET)
    },
    worker,
    supervisor,
    commands: [
      "npm run doctor",
      "npm run validate",
      "npm run bundle-manifest",
      "npm run provider-check",
      "npm run dev:agentflow",
      "npm run worker:daemon",
      "npm run agentflow -- run-and-watch <workflow> --project <path> --task \"...\""
    ]
  };
}

async function loadDashboardInfoFast(dashboardUrl: string): Promise<DashboardInfo> {
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8")) as { name?: string; version?: string };
  const selectedProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
  let adapter = selectedProvider;
  if (selectedProvider === "auto") {
    adapter = "auto-router";
  } else {
    try {
      adapter = providerFromEnv(selectedProvider).id;
    } catch {
      adapter = "unavailable";
    }
  }
  const [serviceChecks, agents, workflows, manifest, worker, supervisor] = await Promise.all([
    checkServices(),
    loadAgents(rootDir),
    loadWorkflows(rootDir),
    loadCommittedBundleManifest(rootDir),
    loadDashboardWorkerStatus(),
    loadDashboardSupervisorStatus()
  ]);
  return {
    app: {
      name: packageJson.name ?? "agent-workflow",
      version: packageJson.version ?? "0.0.0",
      rootDir,
      dashboardUrl
    },
    provider: describeProviderFast(selectedProvider, adapter),
    services: serviceChecks.map((check) => ({
      name: check.endpoint.name,
      reachable: check.reachable,
      message: check.message,
      requiredFor: check.endpoint.requiredFor
    })),
    registry: {
      agents: agents.length,
      workflows: workflows.length
    },
    bundle: manifest ? {
      version: manifest.bundle.version,
      checksum: manifest.checksum.value,
      files: manifest.counts.files,
      source: manifest.bundle.source
    } : null,
    storage: {
      databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
      redisUrlConfigured: Boolean(process.env.REDIS_URL),
      objectStorageConfigured: Boolean(process.env.OBJECT_STORAGE_ENDPOINT && process.env.OBJECT_STORAGE_BUCKET)
    },
    worker,
    supervisor,
    commands: [
      "npm run doctor",
      "npm run validate",
      "npm run bundle-manifest",
      "npm run provider-check",
      "npm run dev:agentflow",
      "npm run worker:daemon",
      "npm run agentflow -- run-and-watch <workflow> --project <path> --task \"...\""
    ]
  };
}

async function loadDashboardWorkerStatus(): Promise<DashboardWorkerStatus> {
  const heartbeatPath = path.resolve(process.cwd(), process.env.AGENTFLOW_WORKER_HEARTBEAT ?? defaultWorkerHeartbeatPath);
  try {
    const heartbeat = JSON.parse(await fs.readFile(heartbeatPath, "utf8")) as Partial<WorkerHeartbeat>;
    const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? heartbeat.lastHeartbeatAt : null;
    const ageMs = lastHeartbeatAt ? Date.now() - Date.parse(lastHeartbeatAt) : null;
    const intervalMs = typeof heartbeat.intervalMs === "number" ? heartbeat.intervalMs : null;
    const staleAfterMs = Math.max((intervalMs ?? 2000) * 3, 15_000);
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    const processAlive = pid ? isProcessAlive(pid) : false;
    const heartbeatStatus = heartbeat.status ?? "stopped";
    const running = processAlive && ageMs !== null && ageMs <= staleAfterMs && heartbeatStatus !== "stopped" && heartbeatStatus !== "stopping";
    return {
      heartbeatPath,
      configured: true,
      status: running ? "running" : heartbeatStatus === "stopped" ? "stopped" : "stale",
      pid,
      startedAt: typeof heartbeat.startedAt === "string" ? heartbeat.startedAt : null,
      lastHeartbeatAt,
      ageMs,
      limit: typeof heartbeat.limit === "number" ? heartbeat.limit : null,
      intervalMs,
      ticks: typeof heartbeat.ticks === "number" ? heartbeat.ticks : 0,
      claimed: typeof heartbeat.claimed === "number" ? heartbeat.claimed : 0,
      completed: typeof heartbeat.completed === "number" ? heartbeat.completed : 0,
      failed: typeof heartbeat.failed === "number" ? heartbeat.failed : 0,
      processAlive,
      command: typeof heartbeat.command === "string" ? heartbeat.command : "npm run worker:daemon"
    };
  } catch {
    return {
      heartbeatPath,
      configured: false,
      status: "missing",
      pid: null,
      startedAt: null,
      lastHeartbeatAt: null,
      ageMs: null,
      limit: null,
      intervalMs: null,
      ticks: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
      processAlive: false,
      command: "npm run worker:daemon"
    };
  }
}

async function loadDashboardSupervisorStatus(): Promise<DashboardSupervisorStatus> {
  const heartbeatPath = path.resolve(process.cwd(), process.env.AGENTFLOW_SUPERVISOR_HEARTBEAT ?? defaultSupervisorHeartbeatPath);
  try {
    const heartbeat = JSON.parse(await fs.readFile(heartbeatPath, "utf8")) as Partial<SupervisorHeartbeat>;
    const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? heartbeat.lastHeartbeatAt : null;
    const ageMs = lastHeartbeatAt ? Date.now() - Date.parse(lastHeartbeatAt) : null;
    const monitorIntervalMs = typeof heartbeat.monitorIntervalMs === "number" ? heartbeat.monitorIntervalMs : 5000;
    const staleAfterMs = Math.max(monitorIntervalMs * 3, 20_000);
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    const processAlive = pid ? isProcessAlive(pid) : false;
    const heartbeatStatus = heartbeat.status ?? "stopped";
    const running = processAlive && ageMs !== null && ageMs <= staleAfterMs && heartbeatStatus === "running";
    return {
      heartbeatPath,
      configured: true,
      status: running ? "running" : heartbeatStatus === "failed" ? "failed" : heartbeatStatus === "stopped" ? "stopped" : "stale",
      pid,
      processAlive,
      message: typeof heartbeat.message === "string" ? heartbeat.message : "",
      startedAt: typeof heartbeat.startedAt === "string" ? heartbeat.startedAt : null,
      lastHeartbeatAt,
      ageMs,
      ticks: typeof heartbeat.ticks === "number" ? heartbeat.ticks : 0,
      dashboardPort: typeof heartbeat.dashboardPort === "number" ? heartbeat.dashboardPort : null,
      dashboardManaged: heartbeat.dashboardManaged === true,
      workerManaged: heartbeat.workerManaged === true,
      command: typeof heartbeat.command === "string" ? heartbeat.command : "npm run dev:agentflow"
    };
  } catch {
    return {
      heartbeatPath,
      configured: false,
      status: "missing",
      pid: null,
      processAlive: false,
      message: "No supervisor heartbeat found.",
      startedAt: null,
      lastHeartbeatAt: null,
      ageMs: null,
      ticks: 0,
      dashboardPort: null,
      dashboardManaged: false,
      workerManaged: false,
      command: "npm run dev:agentflow"
    };
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dashboardUrlFromRequest(request: http.IncomingMessage): string {
  const host = request.headers.host || "127.0.0.1";
  return `http://${host}`;
}

async function describeProvider(selected: string, adapter: string): Promise<DashboardInfo["provider"]> {
  if (selected === "auto") {
    return {
      selected,
      adapter,
      model: "tier-based",
      modelEnv: "AGENTFLOW_PROVIDER_*",
      canSelectModel: false,
      availableModels: [],
      autoRoutes: await loadAutoRoutePreviews(),
      providerStatuses: await loadAutoProviderStatuses(),
      routingConfig: loadRoutingConfig()
    };
  }

  if (selected === "openai") {
    const currentModel = process.env.OPENAI_MODEL || "default";
    const discovered = await discoverModelIds(() => loadOpenAIModelIds());
    return {
      selected,
      adapter,
      model: currentModel,
      modelEnv: "OPENAI_MODEL",
      apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
      canSelectModel: Boolean(process.env.OPENAI_API_KEY),
      availableModels: uniqueSorted([currentModel, ...discovered.models]),
      availableModelsError: discovered.error,
      routingConfig: loadRoutingConfig()
    };
  }
  if (selected === "byo") {
    const currentModel = process.env.BYO_MODEL_NAME || undefined;
    const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(process.env.BYO_MODEL_BASE_URL, process.env.BYO_MODEL_API_KEY));
    return {
      selected,
      adapter,
      model: currentModel,
      modelEnv: "BYO_MODEL_NAME",
      baseUrl: safeDisplayUrl(process.env.BYO_MODEL_BASE_URL),
      apiKeyConfigured: Boolean(process.env.BYO_MODEL_API_KEY),
      canSelectModel: Boolean(process.env.BYO_MODEL_BASE_URL),
      availableModels: uniqueSorted([currentModel, ...discovered.models]),
      availableModelsError: discovered.error,
      routingConfig: loadRoutingConfig()
    };
  }
  if (selected === "openai-compatible") {
    const currentModel = process.env.OPENAI_COMPATIBLE_MODEL || undefined;
    const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(process.env.OPENAI_COMPATIBLE_BASE_URL, process.env.OPENAI_COMPATIBLE_API_KEY));
    return {
      selected,
      adapter,
      model: currentModel,
      modelEnv: "OPENAI_COMPATIBLE_MODEL",
      baseUrl: safeDisplayUrl(process.env.OPENAI_COMPATIBLE_BASE_URL),
      apiKeyConfigured: Boolean(process.env.OPENAI_COMPATIBLE_API_KEY),
      canSelectModel: Boolean(process.env.OPENAI_COMPATIBLE_BASE_URL),
      availableModels: uniqueSorted([currentModel, ...discovered.models]),
      availableModelsError: discovered.error,
      routingConfig: loadRoutingConfig()
    };
  }
  if (selected === "bedrock") {
    const currentModel = process.env.BEDROCK_MODEL_ID || process.env.BEDROCK_MODEL || undefined;
    const discovered = await discoverModelIds(() => loadBedrockModelIds());
    return {
      selected,
      adapter,
      model: currentModel,
      modelEnv: "BEDROCK_MODEL",
      awsProfile: process.env.AWS_PROFILE || "default",
      canSelectModel: true,
      availableModels: uniqueSorted([currentModel, ...discovered.models]),
      availableModelsError: discovered.error,
      routingConfig: loadRoutingConfig()
    };
  }
  const model = selected === "kiro" ? "kiro-cli" : "mock";
  return {
    selected,
    adapter,
    model,
    canSelectModel: false,
    availableModels: [model],
    routingConfig: loadRoutingConfig()
  };
}

function describeProviderFast(selected: string, adapter: string): DashboardInfo["provider"] {
  const routingConfig = loadRoutingConfig();
  if (selected === "auto") {
    return {
      selected,
      adapter,
      model: "tier-based",
      modelEnv: "AGENTFLOW_PROVIDER_*",
      canSelectModel: false,
      availableModels: [],
      availableModelsError: "Live provider readiness was skipped for fast page load. Use provider-check for full validation.",
      routingConfig
    };
  }
  if (selected === "openai") {
    const currentModel = process.env.OPENAI_MODEL || "default";
    return {
      selected,
      adapter,
      model: currentModel,
      modelEnv: "OPENAI_MODEL",
      apiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
      canSelectModel: Boolean(process.env.OPENAI_API_KEY),
      availableModels: [currentModel],
      availableModelsError: "Live model listing was skipped for fast page load.",
      routingConfig
    };
  }
  if (selected === "byo") {
    const currentModel = process.env.BYO_MODEL_NAME || undefined;
    return {
      selected,
      adapter,
      model: currentModel,
      modelEnv: "BYO_MODEL_NAME",
      baseUrl: safeDisplayUrl(process.env.BYO_MODEL_BASE_URL),
      apiKeyConfigured: Boolean(process.env.BYO_MODEL_API_KEY),
      canSelectModel: Boolean(process.env.BYO_MODEL_BASE_URL),
      availableModels: currentModel ? [currentModel] : [],
      availableModelsError: "Live model listing was skipped for fast page load.",
      routingConfig
    };
  }
  if (selected === "openai-compatible") {
    const currentModel = process.env.OPENAI_COMPATIBLE_MODEL || undefined;
    return {
      selected,
      adapter,
      model: currentModel,
      modelEnv: "OPENAI_COMPATIBLE_MODEL",
      baseUrl: safeDisplayUrl(process.env.OPENAI_COMPATIBLE_BASE_URL),
      apiKeyConfigured: Boolean(process.env.OPENAI_COMPATIBLE_API_KEY),
      canSelectModel: Boolean(process.env.OPENAI_COMPATIBLE_BASE_URL),
      availableModels: currentModel ? [currentModel] : [],
      availableModelsError: "Live model listing was skipped for fast page load.",
      routingConfig
    };
  }
  if (selected === "bedrock") {
    const currentModel = process.env.BEDROCK_MODEL_ID || process.env.BEDROCK_MODEL || undefined;
    return {
      selected,
      adapter,
      model: currentModel,
      modelEnv: "BEDROCK_MODEL",
      awsProfile: process.env.AWS_PROFILE || "default",
      canSelectModel: true,
      availableModels: currentModel ? [currentModel] : [],
      availableModelsError: "Live Bedrock model listing was skipped for fast page load.",
      routingConfig
    };
  }
  const model = selected === "kiro" ? "kiro-cli" : "mock";
  return {
    selected,
    adapter,
    model,
    canSelectModel: false,
    availableModels: [model],
    routingConfig
  };
}

function loadRoutingConfig(): DashboardInfo["provider"]["routingConfig"] {
  return {
    provider: process.env.DEFAULT_MODEL_PROVIDER ?? "mock",
    autoProviders: process.env.AGENTFLOW_AUTO_PROVIDERS ?? "byo,bedrock,openai,openai-compatible,kiro",
    fastProvider: process.env.AGENTFLOW_PROVIDER_FAST ?? "auto",
    standardProvider: process.env.AGENTFLOW_PROVIDER_STANDARD ?? "auto",
    reasoningProvider: process.env.AGENTFLOW_PROVIDER_REASONING ?? "auto",
    fallbackProvider: process.env.AGENTFLOW_FALLBACK_PROVIDER ?? "",
    qualityThreshold: process.env.AGENTFLOW_QUALITY_THRESHOLD ?? "0.62"
  };
}

async function loadAutoRoutePreviews(): Promise<NonNullable<DashboardInfo["provider"]["autoRoutes"]>> {
  const tiers = ["fast", "standard", "reasoning"] as const;
  return Promise.all(tiers.map(async (tier) => {
    const route = await selectModelRoute({
      modelTier: tier,
      agentId: "auto-preview",
      stageId: tier,
      workflowId: "dashboard",
      compiledBrief: ""
    });
    return {
      tier,
      providerId: route.providerId,
      estimatedCostTier: route.estimatedCostTier,
      reason: route.reason
    };
  }));
}

async function loadAutoProviderStatuses(): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>> {
  const [openai, byo, compatible, bedrock, kiro, mock] = await Promise.all([
    inspectOpenAIStatus(),
    inspectOpenAICompatibleStatus({
      providerId: "byo",
      label: "BYO / OpenAI-compatible gateway",
      baseUrl: process.env.BYO_MODEL_BASE_URL,
      model: process.env.BYO_MODEL_NAME,
      apiKey: process.env.BYO_MODEL_API_KEY
    }),
    inspectOpenAICompatibleStatus({
      providerId: "openai-compatible",
      label: "OpenAI-compatible legacy",
      baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL,
      model: process.env.OPENAI_COMPATIBLE_MODEL,
      apiKey: process.env.OPENAI_COMPATIBLE_API_KEY
    }),
    inspectProviderStatus({
      providerId: "bedrock",
      label: "AWS Bedrock",
      configured: hasAwsConfiguration(),
      model: process.env.BEDROCK_MODEL ?? process.env.BEDROCK_MODEL_STANDARD ?? process.env.BEDROCK_MODEL_ID,
      apiKeyStatus: awsCredentialStatusLabel(),
      awsProfile: process.env.AWS_PROFILE || "default",
      awsRegion: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1",
      alwaysCheck: true
    }),
    inspectProviderStatus({
      providerId: "kiro",
      label: "Kiro CLI",
      configured: Boolean(process.env.KIRO_API_KEY || process.env.KIRO_AGENT || process.env.KIRO_CLI_BIN),
      model: process.env.KIRO_AGENT || "auto",
      apiKeyStatus: process.env.KIRO_API_KEY ? "configured" : "CLI login or missing"
    }),
    {
      providerId: "mock",
      label: "Mock",
      configured: true,
      status: "ready" as const,
      model: "mock",
      details: ["Always available for deterministic local validation."]
    }
  ]);
  return [openai, byo, compatible, bedrock, kiro, mock];
}

async function inspectOpenAIStatus(): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>[number]> {
  const configured = Boolean(process.env.OPENAI_API_KEY);
  if (!configured) {
    return {
      providerId: "openai",
      label: "OpenAI",
      configured,
      status: "not configured",
      model: process.env.OPENAI_MODEL,
      apiKeyStatus: "missing",
      details: ["OPENAI_API_KEY is not configured."]
    };
  }

  const discovered = await discoverModelIds(() => loadOpenAIModelIds());
  return {
    providerId: "openai",
    label: "OpenAI",
    configured,
    status: discovered.error ? "missing" : "ready",
    model: process.env.OPENAI_MODEL || "default",
    apiKeyStatus: "configured",
    details: discovered.error
      ? [`Model list check failed: ${discovered.error}`]
      : [`API key configured. ${discovered.models.length} models listed.`]
  };
}

async function inspectOpenAICompatibleStatus(input: {
  providerId: "byo" | "openai-compatible";
  label: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>[number]> {
  const configured = Boolean(input.baseUrl && input.model);
  if (!configured) {
    return {
      providerId: input.providerId,
      label: input.label,
      configured,
      status: "not configured",
      model: input.model,
      baseUrl: safeDisplayUrl(input.baseUrl),
      apiKeyStatus: input.apiKey ? "configured" : "not required or missing",
      details: ["Base URL and model name are required before this provider can be routed."]
    };
  }

  const discovered = await discoverModelIds(() => loadOpenAICompatibleModelIds(input.baseUrl, input.apiKey));
  return {
    providerId: input.providerId,
    label: input.label,
    configured,
    status: discovered.error ? "missing" : "ready",
    model: input.model,
    baseUrl: safeDisplayUrl(input.baseUrl),
    apiKeyStatus: input.apiKey ? "configured" : "not required",
    details: discovered.error
      ? [`Model list check failed: ${discovered.error}`]
      : [`Endpoint reachable. ${discovered.models.length} models listed.`]
  };
}

async function inspectProviderStatus(input: {
  providerId: "bedrock" | "kiro";
  label: string;
  configured: boolean;
  model?: string;
  apiKeyStatus?: string;
  awsProfile?: string;
  awsRegion?: string;
  alwaysCheck?: boolean;
}): Promise<NonNullable<DashboardInfo["provider"]["providerStatuses"]>[number]> {
  if (!input.configured && !input.alwaysCheck) {
    return {
      providerId: input.providerId,
      label: input.label,
      configured: false,
      status: "not configured",
      model: input.model,
      apiKeyStatus: input.apiKeyStatus,
      awsProfile: input.awsProfile,
      awsRegion: input.awsRegion,
      details: ["Provider-specific configuration was not found."]
    };
  }

  try {
    const provider = providerFromEnv(input.providerId);
    const result = provider.check ? await provider.check() : { ready: true, details: [`${input.providerId} configured.`] };
    return {
      providerId: input.providerId,
      label: input.label,
      configured: input.configured,
      status: result.ready ? "ready" : "missing",
      model: input.model,
      apiKeyStatus: input.apiKeyStatus,
      awsProfile: input.awsProfile,
      awsRegion: input.awsRegion,
      details: result.details.map(safeErrorMessage)
    };
  } catch (error) {
    return {
      providerId: input.providerId,
      label: input.label,
      configured: input.configured,
      status: "missing",
      model: input.model,
      apiKeyStatus: input.apiKeyStatus,
      awsProfile: input.awsProfile,
      awsRegion: input.awsRegion,
      details: [safeErrorMessage(error)]
    };
  }
}

function hasAwsConfiguration(): boolean {
  return Boolean(
    process.env.AWS_PROFILE
      || process.env.AWS_REGION
      || process.env.BEDROCK_REGION
      || process.env.BEDROCK_MODEL
      || process.env.BEDROCK_MODEL_STANDARD
      || process.env.AWS_ACCESS_KEY_ID
      || process.env.AWS_SESSION_TOKEN
      || process.env.AWS_WEB_IDENTITY_TOKEN_FILE
  );
}

function awsCredentialStatusLabel(): string {
  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_SESSION_TOKEN) {
    return "env credentials configured";
  }
  if (process.env.AWS_PROFILE) {
    return `profile ${process.env.AWS_PROFILE}`;
  }
  return "default credential chain";
}

async function discoverModelIds(loader: () => Promise<string[]>): Promise<{ models: string[]; error?: string }> {
  try {
    return { models: await loader() };
  } catch (error) {
    return { models: [], error: safeErrorMessage(error) };
  }
}

async function loadOpenAIModelIds(): Promise<string[]> {
  if (!process.env.OPENAI_API_KEY) {
    return [];
  }

  const response = await fetch("https://api.openai.com/v1/models", {
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    }
  });
  if (!response.ok) {
    throw new Error(`OpenAI models API returned ${response.status}`);
  }
  const parsed = await response.json() as { data?: Array<{ id?: string }> };
  return uniqueSorted(parsed.data?.map((model) => model.id).filter((id): id is string => Boolean(id)) ?? []);
}

async function loadOpenAICompatibleModelIds(baseUrl?: string, apiKey?: string): Promise<string[]> {
  if (!baseUrl) {
    return [];
  }

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/u, "")}/models`, { headers });
  if (!response.ok) {
    throw new Error(`models API returned ${response.status}`);
  }
  const parsed = await response.json() as { data?: Array<{ id?: string }> };
  return uniqueSorted(parsed.data?.map((model) => model.id).filter((id): id is string => Boolean(id)) ?? []);
}

async function loadBedrockModelIds(): Promise<string[]> {
  const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1";
  const client = new BedrockClient({ region });
  const response = await client.send(new ListFoundationModelsCommand({}));
  return uniqueSorted(response.modelSummaries?.map((model) => model.modelId).filter((modelId): modelId is string => Boolean(modelId)) ?? []);
}

function uniqueSorted(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))].sort((a, b) => a.localeCompare(b));
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function modelEnvForProvider(provider: string): string | undefined {
  if (provider === "openai") {
    return "OPENAI_MODEL";
  }
  if (provider === "byo") {
    return "BYO_MODEL_NAME";
  }
  if (provider === "openai-compatible") {
    return "OPENAI_COMPATIBLE_MODEL";
  }
  if (provider === "bedrock") {
    return "BEDROCK_MODEL";
  }
  return undefined;
}

async function updateDashboardModel(input: { provider: string; model: string }): Promise<DashboardFollowUpResult> {
  const selectedProvider = process.env.DEFAULT_MODEL_PROVIDER ?? "mock";
  if (input.provider !== selectedProvider) {
    return { ok: false, error: `Provider changed while editing. Current provider is ${selectedProvider}.` };
  }

  const model = input.model.trim();
  if (!model) {
    return { ok: false, error: "Missing model." };
  }

  const modelEnv = modelEnvForProvider(selectedProvider);
  if (!modelEnv) {
    return { ok: false, error: `${selectedProvider} does not support model selection.` };
  }

  await updateEnvValue(configuredEnvPath, modelEnv, model);
  process.env[modelEnv] = model;
  return {
    ok: true,
    title: "Model updated",
    output: [
      `${modelEnv}=${model}`,
      "New workflow tasks will use this model. Restart any already-running workers if you need them to pick up the change immediately."
    ].join("\n")
  };
}

async function updateDashboardRouting(input: {
  provider: string;
  autoProviders: string;
  fastProvider: string;
  standardProvider: string;
  reasoningProvider: string;
  fallbackProvider: string;
  qualityThreshold: string;
}): Promise<DashboardFollowUpResult> {
  const provider = normalizeDashboardProvider(input.provider, { allowBlank: false });
  if (!provider) {
    return { ok: false, error: `Unsupported provider: ${input.provider}` };
  }

  const autoProviders = orderedUnique(splitProviderList(input.autoProviders)
    .map((item) => normalizeDashboardProvider(item, { allowBlank: false }))
    .filter((item): item is string => Boolean(item && item !== "auto")));
  const fastProvider = normalizeDashboardProvider(input.fastProvider, { allowBlank: false });
  const standardProvider = normalizeDashboardProvider(input.standardProvider, { allowBlank: false });
  const reasoningProvider = normalizeDashboardProvider(input.reasoningProvider, { allowBlank: false });
  const fallbackProvider = normalizeDashboardProvider(input.fallbackProvider, { allowBlank: true });
  const threshold = input.qualityThreshold.trim() || "0.62";
  const parsedThreshold = Number(threshold);

  if (!fastProvider || !standardProvider || !reasoningProvider || fallbackProvider === undefined) {
    return { ok: false, error: "One or more routing providers are unsupported." };
  }
  if (!Number.isFinite(parsedThreshold) || parsedThreshold < 0 || parsedThreshold > 1) {
    return { ok: false, error: "Quality threshold must be a number between 0 and 1." };
  }

  const updates: Record<string, string> = {
    DEFAULT_MODEL_PROVIDER: provider,
    AGENTFLOW_ROUTING_MODE: provider === "auto" ? "adaptive" : process.env.AGENTFLOW_ROUTING_MODE || "adaptive",
    AGENTFLOW_AUTO_PROVIDERS: autoProviders.length ? autoProviders.join(",") : "byo,bedrock,openai,openai-compatible,kiro",
    AGENTFLOW_PROVIDER_FAST: fastProvider,
    AGENTFLOW_PROVIDER_STANDARD: standardProvider,
    AGENTFLOW_PROVIDER_REASONING: reasoningProvider,
    AGENTFLOW_FALLBACK_PROVIDER: fallbackProvider,
    AGENTFLOW_QUALITY_THRESHOLD: String(parsedThreshold)
  };

  const envPath = configuredEnvPath;
  for (const [key, value] of Object.entries(updates)) {
    await updateEnvValue(envPath, key, value);
    process.env[key] = value;
  }

  return {
    ok: true,
    title: "Routing updated",
    output: [
      `DEFAULT_MODEL_PROVIDER=${updates.DEFAULT_MODEL_PROVIDER}`,
      `AGENTFLOW_AUTO_PROVIDERS=${updates.AGENTFLOW_AUTO_PROVIDERS}`,
      `AGENTFLOW_PROVIDER_FAST=${updates.AGENTFLOW_PROVIDER_FAST}`,
      `AGENTFLOW_PROVIDER_STANDARD=${updates.AGENTFLOW_PROVIDER_STANDARD}`,
      `AGENTFLOW_PROVIDER_REASONING=${updates.AGENTFLOW_PROVIDER_REASONING}`,
      `AGENTFLOW_FALLBACK_PROVIDER=${updates.AGENTFLOW_FALLBACK_PROVIDER || "none"}`,
      `AGENTFLOW_QUALITY_THRESHOLD=${updates.AGENTFLOW_QUALITY_THRESHOLD}`,
      "New workflow tasks will use this routing. Already-running workers should be restarted if they need the updated environment."
    ].join("\n")
  };
}

function splitProviderList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function orderedUnique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeDashboardProvider(value: string, options: { allowBlank: boolean }): string | undefined {
  const trimmed = value.trim();
  if (!trimmed && options.allowBlank) {
    return "";
  }
  const normalized = normalizeProviderRef(trimmed);
  const supported = new Set(["auto", "mock", "byo", "openai", "openai-compatible", "bedrock", "kiro"]);
  return supported.has(normalized) ? normalized : undefined;
}

async function indexDashboardProject(input: {
  project: string;
  maxFiles: string;
  refine: boolean;
}): Promise<DashboardFollowUpResult> {
  const projectDir = input.project.trim();
  if (!projectDir) {
    return { ok: false, error: "Missing project path." };
  }
  const serviceChecks = await checkServices();
  const missing = serviceChecks.filter((check) => !check.reachable);
  if (missing.length) {
    return {
      ok: false,
      error: missing.map((check) => `${check.endpoint.name}: ${check.message}`).join("\n")
    };
  }
  const maxFiles = parsePositiveInteger(input.maxFiles || "120", 120);
  const resolvedProjectDir = path.resolve(process.cwd(), projectDir);
  try {
    const result = await indexProjectForRun({
      projectDir: resolvedProjectDir,
      maxFiles,
      refine: input.refine,
      forceRefine: false
    });
    return {
      ok: true,
      title: "Project Indexed",
      output: [
        `Project: ${result.projectName}`,
        `Path: ${resolvedProjectDir}`,
        `Indexed: ${result.count} files`,
        `Skipped: ${result.skipped} large files`,
        input.refine ? `Refined: ${result.refined}, reused: ${result.reused}` : "",
        `Open: /project?root=${encodeURIComponent(resolvedProjectDir)}`
      ].filter(Boolean).join("\n")
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function queueDashboardWorkflowRun(input: {
  workflowId: string;
  project: string;
  task: string;
  sourceTokenBudget?: string;
  sourceMaxFiles?: string;
  watch?: boolean;
  workerLimit?: string;
  timeoutMs?: string;
}): Promise<DashboardFollowUpResult> {
  const workflowId = input.workflowId.trim();
  const project = input.project.trim();
  const task = input.task.trim();
  if (!workflowId) {
    return { ok: false, error: "Missing workflow." };
  }
  if (!project) {
    return { ok: false, error: "Missing project path." };
  }
  if (!task) {
    return { ok: false, error: "Missing task." };
  }

  const queued = await queueWorkflow({
    workflowId,
    projectPath: project,
    task,
    sourceTokenBudget: input.sourceTokenBudget?.trim(),
    sourceMaxFiles: input.sourceMaxFiles?.trim()
  });

  if (!queued.ok) {
    return { ok: false, error: queued.error };
  }

  const runUrl = `/run?id=${encodeURIComponent(queued.run.runId)}`;
  const output = [
    `Run: ${queued.run.runId}`,
    `Workflow: ${queued.workflow.id}`,
    `Project: ${queued.projectDir}`,
    `Queued stages: ${queued.run.tasks}`,
    `Open: ${runUrl}`
  ];

  if (input.watch) {
    const workerLimit = parsePositiveInteger(input.workerLimit ?? "6", 6);
    const timeoutMs = parsePositiveInteger(input.timeoutMs ?? "60000", 60000);
    const ticks: string[] = [];
    const watchResult = await watchWorkflowRun({
      runId: queued.run.runId,
      workerLimit,
      intervalMs: 1000,
      timeoutMs,
      onTick: (tick) => {
        if (tick.claimed > 0 || tick.completed > 0 || tick.failed > 0) {
          ticks.push(`Worker claimed ${tick.claimed}, completed ${tick.completed}, failed ${tick.failed}.`);
        }
      }
    });
    output.push(
      "",
      `Status: ${watchResult.status}`,
      `Tasks: ${watchResult.completedTasks}/${watchResult.totalTasks} completed, ${watchResult.failedTasks} failed`,
      `Receipts: ${watchResult.receipts}`,
      ticks.length ? ticks.join("\n") : "Worker did not claim tasks during the watch window."
    );
  } else {
    output.push(
      "",
      "Process queued stages with:",
      "npm run worker -- --limit 6"
    );
  }

  return {
    ok: true,
    title: input.watch ? "Workflow run watched" : "Workflow queued",
    runId: queued.run.runId,
    output: output.join("\n")
  };
}

async function processDashboardRun(input: {
  runId: string;
  mode: string;
  workerLimit: string;
  timeoutMs: string;
}): Promise<DashboardFollowUpResult> {
  const runId = input.runId.trim();
  if (!runId) {
    return { ok: false, error: "Missing run id." };
  }

  const details = await getWorkflowRunDetails(runId);
  if (!details.run) {
    return { ok: false, error: `Unknown workflow run: ${runId}` };
  }

  const workerLimit = parsePositiveInteger(input.workerLimit || "6", 6);
  const timeoutMs = parsePositiveInteger(input.timeoutMs || "60000", 60000);
  if (input.mode === "watch") {
    const ticks: string[] = [];
    const watchResult = await watchWorkflowRun({
      runId,
      workerLimit,
      intervalMs: 1000,
      timeoutMs,
      onTick: (tick) => {
        if (tick.claimed > 0 || tick.completed > 0 || tick.failed > 0) {
          ticks.push(`Worker claimed ${tick.claimed}, completed ${tick.completed}, failed ${tick.failed}.`);
        }
      }
    });
    return {
      ok: true,
      title: `Run ${watchResult.status}`,
      runId,
      output: [
        `Run: ${runId}`,
        `Status: ${watchResult.status}`,
        `Tasks: ${watchResult.completedTasks}/${watchResult.totalTasks} completed, ${watchResult.failedTasks} failed`,
        `Receipts: ${watchResult.receipts}`,
        ticks.length ? ticks.join("\n") : "Worker did not claim tasks during the watch window.",
        `Open: /run?id=${encodeURIComponent(runId)}`
      ].join("\n")
    };
  }

  const workerResult = await runWorkerOnce(workerLimit);
  const updated = await getWorkflowRunDetails(runId);
  const completedTasks = updated.tasks.filter((task) => task.status === "completed").length;
  const failedTasks = updated.tasks.filter((task) => task.status === "failed").length;
  return {
    ok: true,
    title: "Worker batch processed",
    runId,
    output: [
      `Run: ${runId}`,
      `Worker claimed ${workerResult.claimed}, completed ${workerResult.completed}, failed ${workerResult.failed}.`,
      updated.run ? `Status: ${updated.run.status}` : "",
      `Tasks: ${completedTasks}/${updated.tasks.length} completed, ${failedTasks} failed`,
      `Receipts: ${updated.receipts.length}`,
      `Open: /run?id=${encodeURIComponent(runId)}`
    ].filter(Boolean).join("\n")
  };
}

async function processDashboardQueueAction(input: {
  action: string;
  runId: string;
  workerLimit: string;
  project: string;
  reason: string;
  confirmed: boolean;
}): Promise<DashboardFollowUpResult> {
  const action = input.action.trim();
  const runId = input.runId.trim();

  if (action === "process") {
    const workerLimit = parsePositiveInteger(input.workerLimit || "6", 6);
    const workerResult = await runWorkerOnce(workerLimit);
    return {
      ok: true,
      title: "Worker batch processed",
      output: [
        `Worker claimed ${workerResult.claimed}, completed ${workerResult.completed}, failed ${workerResult.failed}.`,
        "Open: /queue"
      ].join("\n")
    };
  }

  if (action === "dismiss-all-failed") {
    if (!input.confirmed) {
      return { ok: false, error: "Confirm bulk dismissal before clearing failed queue items." };
    }
    const project = input.project.trim();
    const reason = input.reason.trim() || "Bulk-dismissed from the dashboard queue.";
    const count = await dismissAllFailedWorkflowRuns({
      projectRootUri: project || undefined,
      actor: "dashboard",
      reason
    });
    return {
      ok: true,
      title: "Failed runs dismissed",
      output: [
        `Dismissed failed runs: ${count}`,
        project ? `Project filter: ${project}` : "Project filter: all projects",
        `Reason: ${reason}`,
        "History, artifacts, and receipts were preserved.",
        "Open: /queue"
      ].join("\n")
    };
  }

  if (!runId) {
    return { ok: false, error: "Missing run id." };
  }

  if (action === "cancel") {
    const cancelled = await cancelWorkflowRun(runId);
    return cancelled
      ? { ok: true, title: "Run cancelled", runId, output: `Run: ${runId}\nOpen: /queue` }
      : { ok: false, error: `Run is not queued/running or does not exist: ${runId}` };
  }

  if (action === "requeue-running") {
    const count = await requeueRunningWorkflowTasks(runId);
    return {
      ok: true,
      title: "Running tasks requeued",
      runId,
      output: [
        `Run: ${runId}`,
        `Requeued running tasks: ${count}`,
        `Open: /run?id=${encodeURIComponent(runId)}`
      ].join("\n")
    };
  }

  if (action === "retry-failed") {
    const count = await retryFailedWorkflowRun(runId);
    return {
      ok: true,
      title: "Failed tasks requeued",
      runId,
      output: [
        `Run: ${runId}`,
        `Requeued failed tasks: ${count}`,
        `Open: /run?id=${encodeURIComponent(runId)}`
      ].join("\n")
    };
  }

  if (action === "resume-checkpoint") {
    const staleReport = await assessRunStaleInputs(runId);
    const result = await resumeWorkflowRunFromCheckpoint({
      runId,
      actor: "dashboard",
      reason: "Checkpoint resume requested from dashboard.",
      includeFailed: true
    });
    return result.totalTasks > 0
      ? {
        ok: true,
        title: "Run resumed from checkpoint",
        runId,
        output: [
          `Run: ${runId}`,
          `Completed checkpoints preserved: ${result.completedTasks}/${result.totalTasks}`,
          `Requeued unfinished stages: ${result.requeuedTasks}`,
          ...formatStaleInputWarnings(staleReport),
          `Open: /run?id=${encodeURIComponent(runId)}`
        ].join("\n")
      }
      : { ok: false, error: `Run cannot be resumed or does not exist: ${runId}` };
  }

  if (action === "replay-run") {
    const staleReport = await assessRunStaleInputs(runId);
    const replayed = await replayWorkflowRun({
      sourceRunId: runId,
      actor: "dashboard",
      reason: "Replay requested from dashboard."
    });
    return replayed
      ? {
        ok: true,
        title: "Run replay queued",
        runId: replayed.runId,
        output: [
          `Source run: ${runId}`,
          `Replay run: ${replayed.runId}`,
          `Queued stages: ${replayed.tasks}`,
          ...formatStaleInputWarnings(staleReport),
          `Open: /run?id=${encodeURIComponent(replayed.runId)}`
        ].join("\n")
      }
      : { ok: false, error: `Unknown workflow run: ${runId}` };
  }

  if (action === "dismiss-failed") {
    const reason = input.reason.trim() || "Dismissed from the dashboard queue.";
    const dismissed = await dismissFailedWorkflowRun({ runId, actor: "dashboard", reason });
    return dismissed
      ? {
        ok: true,
        title: "Failed run dismissed",
        runId,
        output: [
          `Run: ${runId}`,
          `Reason: ${reason}`,
          "History, artifacts, and receipts were preserved.",
          "Open: /queue"
        ].join("\n")
      }
      : { ok: false, error: `Run has no failed queue items or does not exist: ${runId}` };
  }

  return { ok: false, error: `Unsupported queue action: ${action || "none"}` };
}

function safeDisplayUrl(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
  } catch {
    return value.replace(/:\/\/[^/@]+@/, "://[REDACTED]@").replace(/[?].*$/, "");
  }
}

function renderDashboardInfoHtml(info: DashboardInfo): string {
  const serviceRows = info.services.map((service) => `
    <tr>
      <td>${escapeHtml(service.name)}</td>
      <td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "reachable" : "missing"}</span></td>
      <td>${escapeHtml(service.message)}</td>
      <td>${escapeHtml(service.requiredFor)}</td>
    </tr>
  `).join("");
  const commands = info.commands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const providerRows = [
    ["Selected", info.provider.selected],
    ["Adapter", info.provider.adapter],
    ["Model", info.provider.model ?? "not set"],
    ["API key", typeof info.provider.apiKeyConfigured === "boolean" ? info.provider.apiKeyConfigured ? "configured" : "not configured" : "not used"]
  ].map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</div>`).join("");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Info</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("info")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Settings</h1>
      </div>
      <a class="button secondary" href="/api/info">JSON</a>
    </div>
    <section class="panel">
      <h2>Runtime</h2>
      <div class="meta-grid">
        <div><strong>App</strong>${escapeHtml(info.app.name)} ${escapeHtml(info.app.version)}</div>
        <div><strong>Root</strong>${escapeHtml(info.app.rootDir)}</div>
        <div><strong>Dashboard</strong>${escapeHtml(info.app.dashboardUrl)}</div>
        <div><strong>Registry</strong>${info.registry.agents} agents, ${info.registry.workflows} workflows</div>
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Provider Summary</h2>
          <span class="muted">Model and routing controls live on the Providers page.</span>
        </div>
        <a class="button secondary" href="/providers">Open Providers</a>
      </div>
      <div class="meta-grid">${providerRows}</div>
    </section>
    <section class="panel">
      <h2>Enterprise Services</h2>
      <table><thead><tr><th>Service</th><th>Status</th><th>Message</th><th>Required For</th></tr></thead><tbody>${serviceRows}</tbody></table>
    </section>
    <section class="panel">
      <h2>Local Supervisor</h2>
      ${renderSupervisorStatusHtml(info.supervisor)}
    </section>
    <section class="panel">
      <h2>Background Worker</h2>
      ${renderWorkerStatusHtml(info.worker)}
    </section>
    <section class="panel">
      <h2>Bundle Manifest</h2>
      ${info.bundle ? `<div class="meta-grid">
        <div><strong>Version</strong>${escapeHtml(info.bundle.version)}</div>
        <div><strong>Files</strong>${info.bundle.files}</div>
        <div><strong>Checksum</strong><code>${escapeHtml(info.bundle.checksum)}</code></div>
        <div><strong>Source</strong>${escapeHtml(info.bundle.source)}</div>
      </div>` : "<p>No committed bundle manifest found.</p>"}
    </section>
    <section class="panel">
      <h2>Storage Config</h2>
      <div class="meta-grid">
        <div><strong>DATABASE_URL</strong>${info.storage.databaseUrlConfigured ? "configured" : "missing"}</div>
        <div><strong>REDIS_URL</strong>${info.storage.redisUrlConfigured ? "configured" : "missing"}</div>
        <div><strong>Object storage</strong>${info.storage.objectStorageConfigured ? "configured" : "missing"}</div>
      </div>
    </section>
    <section class="panel">
      <h2>Useful Commands</h2>
      <ul>${commands}</ul>
    </section>
  </main>
</body>
</html>`;
}

function renderProvidersHtml(info: DashboardInfo): string {
  const providerRows = [
    ["Selected", info.provider.selected],
    ["Adapter", info.provider.adapter],
    ["Model", info.provider.model ?? "not set"],
    ["Model env", info.provider.modelEnv ?? "not used"],
    ["Base URL", info.provider.baseUrl ?? "not used"],
    ["API key", typeof info.provider.apiKeyConfigured === "boolean" ? info.provider.apiKeyConfigured ? "configured" : "not configured" : "not used"],
    ["AWS profile", info.provider.awsProfile ?? "not used"]
  ].map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong>${escapeHtml(value)}</div>`).join("");
  const modelOptions = info.provider.availableModels.map((model) => {
    const selected = model === info.provider.model ? " selected" : "";
    return `<option value="${escapeHtml(model)}"${selected}>${escapeHtml(model)}</option>`;
  }).join("");
  const modelControl = info.provider.availableModels.length
    ? `<select name="model">${modelOptions}</select>`
    : `<input name="model" value="${escapeHtml(info.provider.model ?? "")}" placeholder="Model name">`;
  const modelSelector = info.provider.canSelectModel ? `
      <form class="inline-form" method="post" action="/api/model">
        <input type="hidden" name="provider" value="${escapeHtml(info.provider.selected)}">
        ${modelControl}
        <button type="submit">Use Model</button>
      </form>
      <p class="muted">${info.provider.availableModels.length ? `${info.provider.availableModels.length} models listed from the active provider.` : "No models were listed; enter a model name manually."} Secrets are never displayed.</p>
      ${info.provider.availableModelsError ? `<p class="warn-box">${escapeHtml(info.provider.availableModelsError)}</p>` : ""}`
    : info.provider.selected === "auto"
      ? `<p class="muted">Auto mode selects provider/model by stage tier. Use routing controls to tune it.</p>`
      : `<p class="muted">This provider has no selectable live model list.</p>`;
  const providerIds = ["auto", "byo", "bedrock", "openai", "openai-compatible", "kiro", "mock"];
  const executionProviderIds = ["auto", "byo", "bedrock", "openai", "openai-compatible", "kiro", "mock"];
  const fallbackProviderIds = ["", "openai", "bedrock", "byo", "openai-compatible", "kiro", "mock"];
  const optionList = (values: string[], selectedValue: string, blankLabel = "none") => values.map((value) => {
    const selected = value === selectedValue ? " selected" : "";
    return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(value || blankLabel)}</option>`;
  }).join("");
  const autoRouteRows = info.provider.autoRoutes?.map((route) => `
    <tr><td>${escapeHtml(route.tier)}</td><td>${escapeHtml(route.providerId)}</td><td>${escapeHtml(route.estimatedCostTier)}</td><td>${escapeHtml(route.reason)}</td></tr>
  `).join("") ?? "";
  const providerStatusRows = info.provider.providerStatuses?.map((provider) => `
    <tr>
      <td>${escapeHtml(provider.label)}<br><span class="muted">${escapeHtml(provider.providerId)}</span></td>
      <td><span class="status ${provider.status === "ready" ? "completed" : provider.status === "missing" ? "failed" : "queued"}">${escapeHtml(provider.status)}</span></td>
      <td>${provider.configured ? "yes" : "no"}</td>
      <td>${escapeHtml(provider.model ?? "not set")}</td>
      <td>${escapeHtml(provider.baseUrl ?? "not used")}</td>
      <td>${escapeHtml(provider.apiKeyStatus ?? "not used")}</td>
      <td>${escapeHtml([provider.awsProfile ? `profile: ${provider.awsProfile}` : "", provider.awsRegion ? `region: ${provider.awsRegion}` : ""].filter(Boolean).join(", ") || "not used")}</td>
      <td>${escapeHtml(provider.details.join(" "))}</td>
    </tr>
  `).join("") ?? "";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Providers</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("providers")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Providers & Models</h1>
      </div>
      <a class="button secondary" href="/api/info">Info JSON</a>
    </div>
    <section class="panel">
      <h2>Selected Provider</h2>
      <div class="meta-grid">${providerRows}</div>
      ${modelSelector}
    </section>
    <section class="panel">
      <h2>Routing Controls</h2>
      <form class="routing-form" method="post" action="/api/routing">
        <label>Provider mode
          <select name="provider">${optionList(providerIds, info.provider.routingConfig.provider)}</select>
        </label>
        <label>Auto priority
          <input name="autoProviders" value="${escapeHtml(info.provider.routingConfig.autoProviders)}" placeholder="byo,bedrock,openai">
        </label>
        <label>Fast tier
          <select name="fastProvider">${optionList(executionProviderIds, info.provider.routingConfig.fastProvider)}</select>
        </label>
        <label>Standard tier
          <select name="standardProvider">${optionList(executionProviderIds, info.provider.routingConfig.standardProvider)}</select>
        </label>
        <label>Reasoning tier
          <select name="reasoningProvider">${optionList(executionProviderIds, info.provider.routingConfig.reasoningProvider)}</select>
        </label>
        <label>Fallback provider
          <select name="fallbackProvider">${optionList(fallbackProviderIds, info.provider.routingConfig.fallbackProvider)}</select>
        </label>
        <label>Quality threshold
          <input name="qualityThreshold" value="${escapeHtml(info.provider.routingConfig.qualityThreshold)}" inputmode="decimal">
        </label>
        <div class="form-actions"><button type="submit">Save Routing</button></div>
      </form>
    </section>
    ${autoRouteRows ? `<section class="panel"><h2>Auto Routing Preview</h2><table><thead><tr><th>Tier</th><th>Provider</th><th>Cost</th><th>Reason</th></tr></thead><tbody>${autoRouteRows}</tbody></table></section>` : ""}
    ${providerStatusRows ? `<section class="panel"><h2>Available Provider Status</h2><table><thead><tr><th>Provider</th><th>Status</th><th>Configured</th><th>Model</th><th>Base URL</th><th>API Key / Auth</th><th>AWS</th><th>Details</th></tr></thead><tbody>${providerStatusRows}</tbody></table><p class="muted">Secrets are never displayed.</p></section>` : ""}
  </main>
</body>
</html>`;
}

function renderTuningProposalsHtml(proposalSet: TuningProposalSet): string {
  const summary = proposalSet.summary.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const rows = proposalSet.proposals.slice(0, 8).map((proposal) => `
    <tr>
      <td>${escapeHtml(proposal.id)}<br><span class="flag ${proposal.priority === "high" ? "bad" : proposal.priority === "medium" ? "warn" : "good"}">${escapeHtml(proposal.priority)}</span></td>
      <td>${escapeHtml(proposal.kind)}</td>
      <td>${escapeHtml(proposal.workflowId)}<br><span class="muted">${escapeHtml(proposal.stageId)} / ${escapeHtml(proposal.agentId)}</span></td>
      <td>${escapeHtml(proposal.recommendation)}</td>
      <td>${escapeHtml(proposal.patchHint)}</td>
    </tr>
  `).join("");

  return `
    <ul>${summary}</ul>
    <form class="inline-form" method="post" action="/api/follow-up">
      <input type="hidden" name="action" value="apply-tuning-dry-run">
      <input type="hidden" name="project" value="${escapeHtml(proposalSet.projectRootUri)}">
      <input name="ids" value="all" aria-label="Proposal ids">
      <button type="submit">Dry Run Apply</button>
    </form>
    <table>
      <thead><tr><th>ID</th><th>Kind</th><th>Target</th><th>Recommendation</th><th>Patch Hint</th></tr></thead>
      <tbody>${rows || "<tr><td colspan=\"5\">No tuning proposals yet.</td></tr>"}</tbody>
    </table>
  `;
}

function renderPreferenceScorecardHtml(scorecard: PreferenceScorecard): string {
  const recommendations = scorecard.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const rows = scorecard.groups.slice(0, 8).map((group) => `
    <tr>
      <td>${escapeHtml(group.workflowId)}<br><span class="muted">${escapeHtml(group.stageId)}</span></td>
      <td>${escapeHtml(group.agentId)}</td>
      <td>${escapeHtml(group.providerId)} / ${escapeHtml(group.modelTier)}</td>
      <td>${group.runs}</td>
      <td>${group.accepted}/${group.revised}/${group.rejected}</td>
      <td>${group.feedbackScore}</td>
      <td>${group.averageQuality ?? "n/a"}</td>
      <td>${group.fallbackRate}</td>
      <td>${escapeHtml(group.recommendation)}</td>
    </tr>
  `).join("");

  return `
    <div class="meta-grid compact">
      <div><strong>Runs</strong>${scorecard.runsAnalyzed}</div>
      <div><strong>Feedback</strong>${escapeHtml(formatInlineCounts(scorecard.feedbackCounts))}</div>
    </div>
    <ul>${recommendations}</ul>
    <table>
      <thead><tr><th>Workflow</th><th>Agent</th><th>Provider/Tier</th><th>Runs</th><th>A/R/R</th><th>Score</th><th>Quality</th><th>Fallback</th><th>Recommendation</th></tr></thead>
      <tbody>${rows || "<tr><td colspan=\"9\">No scored combinations yet.</td></tr>"}</tbody>
    </table>
  `;
}

function renderCostQualityHtml(report: CostQualityReport): string {
  const stageRows = report.stages.map((stage) => `
    <tr>
      <td>${escapeHtml(stage.stageId)}</td>
      <td>${escapeHtml(stage.agentId)}</td>
      <td>${escapeHtml(stage.providerId)}${stage.model ? `<br><span class="muted">${escapeHtml(stage.model)}</span>` : ""}</td>
      <td>${escapeHtml(stage.modelTier)}${stage.requestedModelTier !== stage.modelTier ? `<br><span class="muted">requested ${escapeHtml(stage.requestedModelTier)}</span>` : ""}</td>
      <td>${escapeHtml(stage.estimatedCostTier)}</td>
      <td>${stage.qualityScore ?? "n/a"} ${stage.qualityPassed === false ? "<span class=\"flag bad\">Review</span>" : stage.qualityPassed === true ? "<span class=\"flag good\">Pass</span>" : ""}</td>
      <td>${stage.fallbackUsed ? escapeHtml(stage.fallbackProviderId ?? "yes") : "no"}</td>
      <td>${stage.latencyMs ?? "n/a"}</td>
    </tr>
  `).join("");
  const recommendations = report.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  return `
    <div class="metric-grid">
      ${metricCard("Quality", report.averageQuality ?? "n/a", `${report.qualityPassCount} pass / ${report.qualityFailCount} review`)}
      ${metricCard("Fallbacks", report.fallbackCount, "retry count")}
      ${metricCard("Latency", `${report.totalLatencyMs}ms`, `avg ${report.averageLatencyMs ?? "n/a"}ms`)}
      ${metricCard("BYO Savings", report.estimatedByoSavingsStages, "local or low-cost stages")}
    </div>
    <div class="meta-grid compact">
      <div><strong>Providers</strong>${escapeHtml(formatInlineCounts(report.providerMix))}</div>
      <div><strong>Cost Mix</strong>${escapeHtml(formatInlineCounts(report.estimatedCostMix))}</div>
      <div><strong>Model Tiers</strong>${escapeHtml(formatInlineCounts(report.modelTierMix))}</div>
    </div>
    <table>
      <thead><tr><th>Stage</th><th>Agent</th><th>Provider</th><th>Tier</th><th>Cost</th><th>Quality</th><th>Fallback</th><th>Latency ms</th></tr></thead>
      <tbody>${stageRows || "<tr><td colspan=\"8\">No routing receipts found.</td></tr>"}</tbody>
    </table>
    <h3>Recommendations</h3>
    <ul>${recommendations}</ul>
  `;
}

function renderDashboardUsageHtml(summary: DashboardUsageSummary): string {
  const modeLabel = summary.includeMock ? "Including mock/test runs" : "Real providers only";
  const toggleHref = summary.includeMock ? "/" : "/?includeMock=true";
  const toggleLabel = summary.includeMock ? "Hide Mock/Test Runs" : "Include Mock/Test Runs";
  const excluded = summary.includeMock
    ? "Mock/test runs are included in these diagnostics."
    : `${summary.mockRunsExcluded} mock/test runs and ${summary.mockStagesExcluded} mock stages excluded from cost metrics.`;
  const partialNotice = summary.partial && summary.note
    ? `<p class="warn-box">${escapeHtml(summary.note)}</p>`
    : "";
  return `
    ${partialNotice}
    <div class="section-heading">
      <div>
        <strong>${escapeHtml(modeLabel)}</strong>
        <span class="muted">${escapeHtml(excluded)}</span>
      </div>
      <a class="button secondary" href="${escapeHtml(toggleHref)}">${escapeHtml(toggleLabel)}</a>
    </div>
    <div class="metric-grid">
      ${metricCard("Runs", summary.runsAnalyzed, `${summary.completedRuns} complete / ${summary.failedRuns} failed / ${summary.queuedRuns + summary.runningRuns} active`)}
      ${metricCard("Model Stages", summary.routedStages, `${summary.byoSavingsStages} BYO or local-compatible`)}
      ${metricCard("Avg Latency", summary.averageLatencyMs === null ? "n/a" : formatDuration(summary.averageLatencyMs), `${formatDuration(summary.totalLatencyMs)} total model latency`)}
      ${metricCard("Avg Run Time", summary.averageRunDurationMs === null ? "n/a" : formatDuration(summary.averageRunDurationMs), "completed runs")}
      ${metricCard("Est. Prompt Tokens", formatNumber(summary.estimatedPromptTokens), "compiled brief x routed stages")}
      ${metricCard("Est. Tokens Saved", formatNumber(summary.estimatedTokensSaved), `${summary.tokenReductionPercent ?? "n/a"}% vs indexed context baseline`)}
    </div>
    <div class="meta-grid compact">
      <div><strong>Providers</strong>${escapeHtml(formatInlineCounts(summary.providerMix))}</div>
      <div><strong>Cost Mix</strong>${escapeHtml(formatInlineCounts(summary.costMix))}</div>
      <div><strong>Model Tiers</strong>${escapeHtml(formatInlineCounts(summary.modelTierMix))}</div>
      <div><strong>Est. Baseline</strong>${escapeHtml(formatNumber(summary.estimatedBaselineTokens))} indexed-context tokens</div>
    </div>
    <p class="muted">Token savings are estimated from recent home-page runs, indexed project summaries, and compiled briefs. They show context avoided, not exact provider billing tokens. Mock is test-only and excluded by default.</p>
  `;
}

function renderRunUsageEstimateHtml(estimate: RunUsageEstimate): string {
  return `
    <div class="metric-grid">
      ${metricCard("Est. Prompt Tokens", formatNumber(estimate.estimatedPromptTokens), `${estimate.routedStages} routed stages`)}
      ${metricCard("Est. Tokens Saved", formatNumber(estimate.estimatedTokensSaved), `${estimate.tokenReductionPercent ?? "n/a"}% reduction`)}
      ${metricCard("Indexed Context", formatNumber(estimate.indexedProjectTokens), "project baseline")}
      ${metricCard("Compiled Brief", formatNumber(estimate.compiledBriefTokens), "per-stage compact context")}
      ${metricCard("Selected Sources", formatNumber(estimate.selectedSourceTokens), "source summary budget")}
      ${metricCard("Run Duration", estimate.runDurationMs === null ? "n/a" : formatDuration(estimate.runDurationMs), "wall-clock")}
    </div>
    <p class="muted">Estimate compares the indexed project context baseline with the compact compiled brief that each model-routed stage received.</p>
  `;
}

function renderWorkerStatusHtml(worker: DashboardWorkerStatus): string {
  const age = worker.ageMs === null ? "n/a" : formatDuration(Math.max(0, worker.ageMs));
  return `
    <div class="meta-grid">
      <div><strong>Status</strong><span class="status ${worker.status === "running" ? "completed" : worker.status === "missing" ? "queued" : "failed"}">${escapeHtml(worker.status)}</span></div>
      <div><strong>PID</strong>${worker.pid ?? "none"}</div>
      <div><strong>Process</strong>${worker.processAlive ? "alive" : "not running"}</div>
      <div><strong>Last Heartbeat</strong>${renderDashboardDateTime(worker.lastHeartbeatAt, "none")}</div>
      <div><strong>Heartbeat Age</strong>${escapeHtml(age)}</div>
      <div><strong>Tick Count</strong>${formatNumber(worker.ticks)}</div>
      <div><strong>Worker Limit</strong>${worker.limit ?? "n/a"}</div>
      <div><strong>Interval</strong>${worker.intervalMs ? formatDuration(worker.intervalMs) : "n/a"}</div>
    </div>
    <div class="meta-grid compact">
      <div><strong>Last Tick</strong>${worker.claimed} claimed / ${worker.completed} completed / ${worker.failed} failed</div>
      <div><strong>Heartbeat File</strong>${escapeHtml(worker.heartbeatPath)}</div>
      <div><strong>Start Command</strong><code>${escapeHtml(worker.command || "npm run worker:daemon")}</code></div>
    </div>
  `;
}

function renderSupervisorStatusHtml(supervisor: DashboardSupervisorStatus): string {
  const age = supervisor.ageMs === null ? "n/a" : formatDuration(Math.max(0, supervisor.ageMs));
  return `
    <div class="meta-grid">
      <div><strong>Status</strong><span class="status ${supervisor.status === "running" ? "completed" : supervisor.status === "missing" ? "queued" : "failed"}">${escapeHtml(supervisor.status)}</span></div>
      <div><strong>PID</strong>${supervisor.pid ?? "none"}</div>
      <div><strong>Process</strong>${supervisor.processAlive ? "alive" : "not running"}</div>
      <div><strong>Last Heartbeat</strong>${renderDashboardDateTime(supervisor.lastHeartbeatAt, "none")}</div>
      <div><strong>Heartbeat Age</strong>${escapeHtml(age)}</div>
      <div><strong>Tick Count</strong>${formatNumber(supervisor.ticks)}</div>
      <div><strong>Dashboard</strong>${supervisor.dashboardManaged ? "managed" : "external or stopped"}</div>
      <div><strong>Worker</strong>${supervisor.workerManaged ? "managed" : "external or stopped"}</div>
    </div>
    <div class="meta-grid compact">
      <div><strong>Message</strong>${escapeHtml(supervisor.message || "n/a")}</div>
      <div><strong>Heartbeat File</strong>${escapeHtml(supervisor.heartbeatPath)}</div>
      <div><strong>Start Command</strong><code>${escapeHtml(supervisor.command || "npm run dev:agentflow")}</code></div>
    </div>
  `;
}

function renderDashboardHealthHtml(health: DashboardHomeHealth): string {
  const queuedTasks = health.queue.reduce((sum, item) => sum + item.queuedTasks, 0);
  const runningTasks = health.queue.reduce((sum, item) => sum + item.runningTasks, 0);
  const failedRuns = health.queue.filter((item) => item.runStatus === "failed").length;
  const servicesReady = health.services.every((service) => service.reachable);
  const activeProjects = health.projects.filter((project) => project.runCount > 0 || project.indexedFiles > 0).length;
  const providerStatus = health.provider === "mock" ? "mock" : health.provider;
  return `
    <div class="health-grid">
      ${healthCard({
        label: "Supervisor",
        status: health.supervisor.status === "running" ? "good" : health.supervisor.status === "missing" ? "warn" : "bad",
        value: health.supervisor.status,
        detail: supervisorStatusDetail(health.supervisor),
        href: "/info"
      })}
      ${healthCard({
        label: "Worker",
        status: health.worker.status === "running" ? "good" : health.worker.status === "missing" ? "warn" : "bad",
        value: health.worker.status,
        detail: workerStatusDetail(health.worker),
        href: "/info"
      })}
      ${healthCard({
        label: "Queue",
        status: failedRuns > 0 ? "bad" : queuedTasks + runningTasks > 0 ? "warn" : "good",
        value: `${queuedTasks + runningTasks} active`,
        detail: failedRuns > 0 ? `${failedRuns} failed run${failedRuns === 1 ? "" : "s"} need review` : "Queue is ready for new work",
        href: "/queue"
      })}
      ${healthCard({
        label: "Provider",
        status: providerStatus === "mock" ? "warn" : "good",
        value: providerStatus,
        detail: providerStatus === "mock" ? "Mock is useful for smoke tests, not real agent output" : "Configured for live model execution",
        href: "/providers"
      })}
      ${healthCard({
        label: "Storage",
        status: servicesReady ? "good" : "bad",
        value: servicesReady ? "ready" : "attention",
        detail: servicesReady ? "Postgres, Redis, and object storage are reachable" : "One or more enterprise services are unavailable",
        href: "/info"
      })}
      ${healthCard({
        label: "Projects",
        status: activeProjects > 0 ? "good" : "warn",
        value: formatNumber(activeProjects),
        detail: `${formatNumber(health.projects.length)} known project${health.projects.length === 1 ? "" : "s"} in local storage`,
        href: "/projects"
      })}
      ${healthCard({
        label: "Latest Failed Run",
        status: health.latestFailedRun ? "bad" : "good",
        value: health.latestFailedRun ? health.latestFailedRun.id.slice(0, 8) : "none",
        detail: health.latestFailedRun ? compactDashboardText(`${health.latestFailedRun.workflowId}: ${health.latestFailedRun.task}`, 120) : "No recent failed run in the home window",
        href: health.latestFailedRun ? `/run?id=${encodeURIComponent(health.latestFailedRun.id)}` : "/runs"
      })}
    </div>
  `;
}

function healthCard(input: { label: string; status: "good" | "warn" | "bad"; value: string; detail: string; href: string }): string {
  return `<a class="health-card ${input.status}" href="${escapeHtml(input.href)}"><strong>${escapeHtml(input.label)}</strong><span>${escapeHtml(input.value)}</span><small>${escapeHtml(input.detail)}</small></a>`;
}

function renderDashboardAttentionHtml(health: DashboardHomeHealth): string {
  const queuedTasks = health.queue.reduce((sum, item) => sum + item.queuedTasks, 0);
  const runningTasks = health.queue.reduce((sum, item) => sum + item.runningTasks, 0);
  const failedRuns = health.queue.filter((item) => item.runStatus === "failed");
  const missingServices = health.services.filter((service) => !service.reachable);
  const items: string[] = [];

  if (health.worker.status !== "running") {
    items.push(attentionItem({
      title: "Start the background worker",
      detail: workerStatusDetail(health.worker),
      href: "/info",
      action: "Open Settings"
    }));
  }
  if (health.supervisor.status !== "running") {
    items.push(attentionItem({
      title: "Use one-command local dev",
      detail: supervisorStatusDetail(health.supervisor),
      href: "/info",
      action: "Open Settings"
    }));
  }
  if (failedRuns.length > 0) {
    items.push(attentionItem({
      title: "Review failed workflow runs",
      detail: `${failedRuns.length} failed run${failedRuns.length === 1 ? " is" : "s are"} waiting in the queue.`,
      href: "/queue",
      action: "Open Queue"
    }));
  }
  if (queuedTasks + runningTasks > 0) {
    items.push(attentionItem({
      title: "Process active queue work",
      detail: `${queuedTasks} queued and ${runningTasks} running stage task${queuedTasks + runningTasks === 1 ? "" : "s"} are active.`,
      href: "/queue",
      action: "Open Queue"
    }));
  }
  if (health.provider === "mock") {
    items.push(attentionItem({
      title: "Switch away from mock for real output",
      detail: "Mock is great for validation, but live development runs need OpenAI, BYO, Bedrock, or another configured provider.",
      href: "/providers",
      action: "Open Providers"
    }));
  }
  if (missingServices.length > 0) {
    items.push(attentionItem({
      title: "Restore enterprise services",
      detail: missingServices.map((service) => service.endpoint.name).join(", "),
      href: "/info",
      action: "Open Settings"
    }));
  }
  if (health.latestFailedRun) {
    items.push(attentionItem({
      title: "Inspect latest failed run",
      detail: compactDashboardText(`${health.latestFailedRun.workflowId}: ${health.latestFailedRun.task}`, 140),
      href: `/run?id=${encodeURIComponent(health.latestFailedRun.id)}`,
      action: "Open Run"
    }));
  }

  if (!items.length) {
    return "<p class=\"muted\">No immediate action needed. The worker, storage, queue, and recent runs look healthy.</p>";
  }
  return `<div class="attention-list">${items.join("")}</div>`;
}

function attentionItem(input: { title: string; detail: string; href: string; action: string }): string {
  return `<div class="attention-item"><div><strong>${escapeHtml(input.title)}</strong><span>${escapeHtml(input.detail)}</span></div><a class="button secondary" href="${escapeHtml(input.href)}">${escapeHtml(input.action)}</a></div>`;
}

function compactDashboardText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function workerStatusDetail(worker: DashboardWorkerStatus): string {
  if (worker.status === "running") {
    return `Worker is processing queued stages. Last heartbeat ${worker.ageMs === null ? "unknown" : `${formatDuration(Math.max(0, worker.ageMs))} ago`}.`;
  }
  if (worker.status === "missing") {
    return "No worker heartbeat found. Start one with npm run worker:daemon.";
  }
  if (worker.status === "stopped") {
    return "Worker stopped cleanly. Start one with npm run worker:daemon.";
  }
  return "Worker heartbeat is stale. Restart with npm run worker:daemon, or requeue interrupted stages from Queue.";
}

function supervisorStatusDetail(supervisor: DashboardSupervisorStatus): string {
  if (supervisor.status === "running") {
    return `Managed by dev:agentflow. Last heartbeat ${supervisor.ageMs === null ? "unknown" : `${formatDuration(Math.max(0, supervisor.ageMs))} ago`}.`;
  }
  if (supervisor.status === "missing") {
    return "Supervisor is not running. Start everything with npm run dev:agentflow.";
  }
  if (supervisor.status === "stopped") {
    return "Supervisor stopped cleanly. Restart with npm run dev:agentflow.";
  }
  if (supervisor.status === "failed") {
    return `Supervisor failed: ${supervisor.message || "unknown error"}`;
  }
  return "Supervisor heartbeat is stale. Restart with npm run dev:agentflow.";
}

function dashboardNav(active: "dashboard" | "queue" | "projects" | "runs" | "evaluations" | "governance" | "bundles" | "providers" | "info"): string {
  const items = [
    ["dashboard", "/", "Dashboard"],
    ["queue", "/queue", "Queue"],
    ["projects", "/projects", "Projects"],
    ["runs", "/runs", "Runs"],
    ["evaluations", "/evaluations", "Evaluations"],
    ["governance", "/governance", "Governance"],
    ["bundles", "/bundles", "Bundles"],
    ["providers", "/providers", "Providers"],
    ["info", "/info", "Settings"]
  ] as const;
  return `<nav class="side-nav" aria-label="Dashboard navigation">
    <strong>Agent Workflow</strong>
    ${items.map(([id, href, label]) => `<a class="${active === id ? "active" : ""}" href="${href}">${label}</a>`).join("")}
  </nav>`;
}

function renderFeedbackHtml(runId: string, report: CostQualityReport): string {
  const latest = report.feedback.latest
    ? `<p><strong>Latest:</strong> ${escapeHtml(report.feedback.latest.rating)}${report.feedback.latest.note ? ` - ${escapeHtml(report.feedback.latest.note)}` : ""}</p>`
    : "<p>No feedback recorded yet.</p>";
  return `
    ${latest}
    <div class="actions">
      ${feedbackForm(runId, "accepted", "Accept")}
      ${feedbackForm(runId, "revised", "Mark Revised")}
      ${feedbackForm(runId, "rejected", "Reject")}
    </div>
  `;
}

function metricCard(label: string, value: string | number, detail: string): string {
  return `<div class="metric"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(String(value))}</span><small>${escapeHtml(detail)}</small></div>`;
}

function formatInlineCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts);
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(", ") : "none";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function renderDashboardDateTime(value: string | null | undefined, fallback = "n/a"): string {
  if (!value) {
    return escapeHtml(fallback);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return escapeHtml(value);
  }
  const label = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(parsed);
  return `<time datetime="${escapeHtml(parsed.toISOString())}" title="${escapeHtml(value)}">${escapeHtml(label)}</time>`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${formatOneDecimal(ms / 1000)}s`;
  }
  return `${formatOneDecimal(ms / 60_000)}m`;
}

function formatOneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function renderDashboardActionResult(result: DashboardFollowUpResult): string {
  const body = result.ok
    ? `<h1>${escapeHtml(result.title)}</h1><pre>${escapeHtml(result.output)}</pre>${result.runId ? `<p><a class="button" href="/run?id=${encodeURIComponent(result.runId)}">Open new run</a></p>` : ""}`
    : `<h1>Action failed</h1><pre>${escapeHtml(result.error)}</pre>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dashboard Action</title>
  <style>${dashboardCss()}</style>
</head>
<body>${dashboardNav("dashboard")}<main><p><a href="/">Dashboard</a></p>${body}</main></body>
</html>`;
}

function dashboardCss(): string {
  return `
    main { max-width: 1180px; margin: 0 auto; padding: 32px 20px 32px 216px; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; background: #f7f8fb; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    h3 { font-size: 14px; margin: 16px 0 8px; }
    p { line-height: 1.5; }
    ul { margin: 0; padding-left: 20px; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #e2e7f0; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e8edf5; font-size: 14px; vertical-align: top; }
    th { color: #4b5870; background: #f0f3f8; font-size: 12px; text-transform: uppercase; }
    a { color: #1d4ed8; text-decoration: none; }
    pre { overflow: auto; background: #101828; color: #eef4ff; padding: 14px; font-size: 13px; line-height: 1.45; }
    .side-nav { position: fixed; inset: 0 auto 0 0; width: 176px; background: #111827; color: #dbe4f0; padding: 20px 14px; display: grid; align-content: start; gap: 6px; z-index: 10; }
    .side-nav strong { color: white; font-size: 14px; margin: 0 0 12px; }
    .side-nav a { color: #cbd5e1; padding: 9px 10px; border: 1px solid transparent; }
    .side-nav a:hover, .side-nav a.active { color: white; background: #1f2937; border-color: #334155; }
    .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
    .panel { background: white; border: 1px solid #e2e7f0; padding: 16px; margin-bottom: 16px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .button, button { appearance: none; border: 1px solid #1d4ed8; background: #1d4ed8; color: white; padding: 8px 11px; font-size: 14px; cursor: pointer; }
    input, select, textarea { border: 1px solid #cbd5e1; padding: 8px 10px; font-size: 14px; min-width: 180px; background: white; font: inherit; }
    .feedback-form { display: flex; gap: 6px; flex-wrap: wrap; }
    .worker-form { display: inline-flex; }
    .dismiss-form { display: inline-flex; gap: 6px; flex-wrap: wrap; }
    .dismiss-form input { min-width: 140px; max-width: 190px; }
    .bulk-dismiss-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; align-items: end; }
    .bulk-dismiss-form label { display: grid; gap: 5px; color: #4b5870; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .bulk-dismiss-form input { width: 100%; min-width: 0; box-sizing: border-box; color: #172033; font-weight: 400; text-transform: none; }
    .bulk-dismiss-form .check-row { display: flex; align-items: center; gap: 8px; min-height: 36px; text-transform: none; font-weight: 500; }
    .bulk-dismiss-form .check-row input { width: auto; }
    .inline-form { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    .routing-form, .workflow-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; margin: 12px 0; align-items: end; }
    .routing-form label, .workflow-form label { display: grid; gap: 5px; color: #4b5870; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .routing-form input, .routing-form select, .workflow-form input, .workflow-form select, .workflow-form textarea { width: 100%; min-width: 0; box-sizing: border-box; color: #172033; font-weight: 400; text-transform: none; }
    .workflow-form .check-row { display: flex; align-items: center; gap: 8px; min-height: 36px; }
    .workflow-form .check-row input { width: auto; min-width: 0; }
    .wide { grid-column: 1 / -1; }
    .form-actions { display: flex; align-items: end; }
    .secondary { background: white; color: #1d4ed8; }
    .danger { border-color: #b91c1c; background: #b91c1c; color: white; }
    .warn-panel { border-color: #fcd34d; background: #fffbeb; }
    .section-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
    .section-heading div { display: grid; gap: 4px; }
    .health-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    .health-card { border: 1px solid #e2e7f0; padding: 12px; display: grid; gap: 5px; color: #172033; background: #fff; min-height: 104px; }
    .health-card strong { font-size: 12px; color: #4b5870; text-transform: uppercase; }
    .health-card span { font-size: 22px; font-weight: 700; }
    .health-card small { color: #64748b; line-height: 1.35; }
    .health-card.good { border-color: #bbf7d0; background: #f0fdf4; }
    .health-card.warn { border-color: #fde68a; background: #fffbeb; }
    .health-card.bad { border-color: #fecaca; background: #fef2f2; }
    .attention-list { display: grid; gap: 8px; }
    .attention-item { border: 1px solid #e2e7f0; padding: 12px; display: flex; justify-content: space-between; gap: 12px; align-items: center; background: #fff; }
    .attention-item div { display: grid; gap: 4px; }
    .attention-item span { color: #64748b; font-size: 14px; line-height: 1.4; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .metric { border: 1px solid #e2e7f0; padding: 12px; display: grid; gap: 4px; }
    .metric span { font-size: 22px; font-weight: 700; }
    .metric small, .muted { color: #64748b; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .meta-grid div { display: grid; gap: 5px; font-size: 14px; }
    .comparison-layout { display: grid; grid-template-columns: minmax(210px, 260px) minmax(0, 1fr); gap: 16px; align-items: start; }
    .suite-list { background: white; border: 1px solid #e2e7f0; padding: 14px; display: grid; gap: 8px; position: sticky; top: 20px; }
    .suite-link { display: grid; gap: 4px; padding: 10px; color: #172033; border: 1px solid #e2e7f0; }
    .suite-link:hover, .suite-link.active { border-color: #93c5fd; background: #eff6ff; }
    .suite-link span, .suite-link small { color: #64748b; }
    .leader-row { background: #f0fdf4; }
    .table-wrap { width: 100%; overflow-x: auto; }
    .compact { margin-bottom: 12px; }
    .artifact { border: 1px solid #e2e7f0; margin-bottom: 8px; padding: 10px; }
    .artifact summary { cursor: pointer; }
    .flag { display: inline-block; margin-left: 6px; padding: 2px 5px; font-size: 11px; }
    .good { background: #dcfce7; color: #166534; }
    .warn { background: #fef3c7; color: #92400e; }
    .bad { background: #fee2e2; color: #991b1b; }
    .warn-box { background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; padding: 10px 12px; }
    .status { display: inline-block; min-width: 78px; padding: 3px 8px; border-radius: 999px; font-size: 12px; text-align: center; background: #eef2ff; color: #3730a3; }
    .completed { background: #dcfce7; color: #166534; }
    .failed { background: #fee2e2; color: #991b1b; }
    .cancelled { background: #e5e7eb; color: #374151; }
    .running, .queued { background: #fef3c7; color: #92400e; }
    @media (max-width: 820px) {
      main { padding: 94px 12px 24px; }
      .side-nav { right: 0; bottom: auto; width: auto; grid-auto-flow: column; grid-auto-columns: max-content; overflow-x: auto; padding: 10px 12px; }
      .side-nav strong { display: none; }
      .topbar, .section-heading { display: grid; }
      .attention-item { display: grid; }
      .comparison-layout { grid-template-columns: 1fr; }
      .suite-list { position: static; }
      table { display: block; overflow-x: auto; }
    }
  `;
}

function runActionForm(runId: string, action: string, label: string): string {
  return `<form method="post" action="/api/follow-up"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button type="submit">${escapeHtml(label)}</button></form>`;
}

function workerActionForm(runId: string, mode: "batch" | "watch", label: string): string {
  return `<form class="worker-form" method="post" action="/api/run-worker"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="mode" value="${escapeHtml(mode)}"><input type="hidden" name="workerLimit" value="6"><input type="hidden" name="timeoutMs" value="${mode === "watch" ? "60000" : "1000"}"><button type="submit">${escapeHtml(label)}</button></form>`;
}

function queueProcessForm(): string {
  return `<form class="worker-form" method="post" action="/api/queue-action"><input type="hidden" name="action" value="process"><input name="workerLimit" inputmode="numeric" value="6" aria-label="Worker limit"><button type="submit">Process Worker Batch</button></form>`;
}

function queueItemForms(item: DashboardQueueItem): string {
  const forms = [
    `<a class="button secondary" href="/run?id=${encodeURIComponent(item.runId)}">Open</a>`
  ];
  if (item.runningTasks > 0) {
    forms.push(queueRunActionForm(item.runId, "requeue-running", "Requeue Running"));
  }
  if (item.queuedTasks > 0 || item.runningTasks > 0 || item.failedTasks > 0 || item.runStatus === "failed") {
    forms.push(queueRunActionForm(item.runId, "resume-checkpoint", "Resume Checkpoint"));
  }
  if (item.failedTasks > 0 || item.runStatus === "failed") {
    forms.push(queueRunActionForm(item.runId, "retry-failed", "Retry Failed"));
    forms.push(queueDismissRunForm(item.runId));
  }
  if (item.runStatus === "queued" || item.runStatus === "running") {
    forms.push(queueRunActionForm(item.runId, "cancel", "Cancel"));
  }
  return forms.join("");
}

function queueRunActionForm(runId: string, action: string, label: string): string {
  return `<form class="worker-form" method="post" action="/api/queue-action"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button type="submit">${escapeHtml(label)}</button></form>`;
}

function queueDismissRunForm(runId: string): string {
  return `<form class="dismiss-form" method="post" action="/api/queue-action"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="action" value="dismiss-failed"><input name="reason" aria-label="Dismissal reason" placeholder="Optional reason"><button class="danger" type="submit">Dismiss</button></form>`;
}

function queueDismissAllForm(): string {
  return `<form class="bulk-dismiss-form" method="post" action="/api/queue-action">
    <input type="hidden" name="action" value="dismiss-all-failed">
    <label>Project path (optional)<input name="project" placeholder="All projects"></label>
    <label>Reason<input name="reason" placeholder="Bulk-dismissed after review"></label>
    <label class="check-row"><input type="checkbox" name="confirmed" required> I reviewed these failures and want to dismiss them.</label>
    <button class="danger" type="submit">Dismiss Failed Runs</button>
  </form>`;
}

function feedbackForm(runId: string, rating: FeedbackRating, label: string): string {
  return `<form class="feedback-form" method="post" action="/api/follow-up"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="action" value="feedback"><input type="hidden" name="rating" value="${escapeHtml(rating)}"><input name="note" placeholder="Optional note"><button type="submit">${escapeHtml(label)}</button></form>`;
}

function presetForm(action: string, label: string, project?: string): string {
  const projectInput = project ? `<input type="hidden" name="project" value="${escapeHtml(project)}">` : "";
  return `<form method="post" action="/api/follow-up"><input type="hidden" name="action" value="${escapeHtml(action)}">${projectInput}<button type="submit">${escapeHtml(label)}</button></form>`;
}

function projectActionForm(project: string, action: string, label: string): string {
  return `<form method="post" action="/api/follow-up"><input type="hidden" name="project" value="${escapeHtml(project)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button type="submit">${escapeHtml(label)}</button></form>`;
}

function projectIndexForm(project: string): string {
  return `<form class="inline-form" method="post" action="/api/project-index"><input type="hidden" name="project" value="${escapeHtml(project)}"><input name="maxFiles" inputmode="numeric" value="120" aria-label="Max files"><label class="check-row"><input type="checkbox" name="refine"> Refine</label><button type="submit">Index Project</button></form>`;
}

type DashboardFollowUpResult =
  | { ok: true; title: string; output: string; runId?: string }
  | { ok: false; error: string };

async function readFormBody(request: http.IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function runDashboardFollowUp(input: {
  action: string;
  runId?: string;
  project?: string;
  ids?: string;
  rating?: string;
  note?: string;
}): Promise<DashboardFollowUpResult> {
  const action = input.action;
  if (action === "summarize") {
    if (!input.runId) {
      return { ok: false, error: "Missing run id." };
    }
    const summary = await summarizeWorkflowRun(input.runId);
    if (!summary.ok) {
      return { ok: false, error: `Unknown workflow run: ${input.runId}` };
    }
    return {
      ok: true,
      title: "Run Summary",
      output: formatRunSummary(summary.value)
    };
  }

  if (action === "feedback") {
    if (!input.runId) {
      return { ok: false, error: "Missing run id." };
    }
    const result = await recordRunFeedback({
      runId: input.runId,
      rating: input.rating ?? "",
      note: input.note ?? "",
      source: "dashboard"
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return {
      ok: true,
      title: "Feedback Recorded",
      output: `Recorded ${result.rating} feedback.\nArtifact: ${result.artifactUri}`,
      runId: input.runId
    };
  }

  const sourceRun = input.runId ? await getWorkflowRunDetails(input.runId) : null;
  const preset = resolveWorkflowPreset(action);
  const sourceProject = sourceRun?.run?.projectRootUri ?? input.project ?? preset?.project;
  if (!sourceProject) {
    return { ok: false, error: "Missing project path or source run. Open a run detail page first, or use a dashboard quick action with a configured project." };
  }

  const sourceTask = sourceRun?.run?.task ?? "dashboard preset";
  const sourceLabel = input.runId ? `from run ${input.runId}` : "from dashboard preset";

  if (action === "apply-tuning-dry-run") {
    const proposalSet = await loadTuningProposals({
      projectDir: sourceProject,
      limit: 25
    });
    const plan = buildTuningApplicationPlan(proposalSet, parseProposalIds(input.ids));
    return {
      ok: true,
      title: "Tuning Overlay Dry Run",
      output: `${formatTuningApplicationPlan(plan)}\n\nRun this command to write the overlay files:\nnpm run agentflow -- apply-tuning-proposals --project ${shellQuote(sourceProject)} --ids ${shellQuote(input.ids?.trim() || "all")} --write`
    };
  }

  if (action === "debug-failure") {
    return runDashboardWorkflow({
      title: "Debug Failure",
      workflow: "debug-failure",
      projectDir: sourceProject,
      task: `Investigate failures ${sourceLabel}: ${sourceTask}`
    });
  }

  if (action === "mira-ux-pass") {
    return runDashboardAgentTask({
      title: "Mira UX Pass",
      agent: "Mira",
      projectDir: sourceProject,
      task: `Do a UX pass ${sourceLabel}: ${sourceTask}`
    });
  }

  if (action === "frontend-pass") {
    return runDashboardAgentTask({
      title: "Frontend Pass",
      agent: "frontend",
      projectDir: sourceProject,
      task: `Review and plan frontend fixes ${sourceLabel}: ${sourceTask}`
    });
  }

  if (action === "maintain-context") {
    return runDashboardWorkflow({
      title: "Maintain Context",
      workflow: "maintain-context",
      projectDir: sourceProject,
      task: `Update durable project context ${sourceLabel}: ${sourceTask}`
    });
  }

  if (preset) {
    return runWorkflowPreset({
      presetRef: preset.id,
      project: input.project ?? sourceProject
    });
  }

  return { ok: false, error: `Unknown dashboard action: ${action}` };
}

function printPresetList(): void {
  console.log("Presets");
  for (const preset of workflowPresets) {
    const aliases = preset.aliases.length ? ` aliases=${preset.aliases.join(",")}` : "";
    console.log(`- ${preset.id}: ${preset.description}${aliases}`);
  }
}

function resolveWorkflowPreset(presetRef: string): WorkflowPreset | null {
  const normalized = presetRef.toLowerCase();
  return workflowPresets.find((preset) => preset.id === normalized || preset.aliases.includes(normalized)) ?? null;
}

async function runWorkflowPreset(input: {
  presetRef: string;
  project?: string;
  task?: string;
  indexMaxFiles?: number;
  refineIndex?: boolean;
  forceRefine?: boolean;
  workerLimit?: number;
  timeoutMs?: number;
  outDir?: string;
}): Promise<DashboardFollowUpResult> {
  const preset = resolveWorkflowPreset(input.presetRef);
  if (!preset) {
    const available = workflowPresets.map((item) => item.id).join(", ");
    return { ok: false, error: `Unknown preset: ${input.presetRef}. Available presets: ${available}` };
  }

  const projectDir = path.resolve(process.cwd(), input.project ?? preset.project);
  const task = input.task ?? preset.task;

  if (preset.kind === "agent") {
    return runDashboardAgentTask({
      title: preset.label,
      agent: preset.target,
      projectDir,
      task,
      indexMaxFiles: input.indexMaxFiles,
      refineIndex: input.refineIndex,
      forceRefine: input.forceRefine,
      timeoutMs: input.timeoutMs,
      outDir: input.outDir
    });
  }

  return runDashboardWorkflow({
    title: preset.label,
    workflow: preset.target,
    projectDir,
    task,
    indexMaxFiles: input.indexMaxFiles,
    refineIndex: input.refineIndex,
    forceRefine: input.forceRefine,
    workerLimit: input.workerLimit,
    timeoutMs: input.timeoutMs,
    outDir: input.outDir
  });
}

function createOrchestrationPlan(input: { projectDir: string; task: string }): OrchestrationPlan {
  const normalizedTask = normalizeLookup(input.task);
  const steps: OrchestrationStep[] = [];
  const addStep = (step: Omit<OrchestrationStep, "id">): void => {
    const duplicate = steps.some((existing) => existing.kind === step.kind && existing.target === step.target);
    if (!duplicate) {
      steps.push({ ...step, id: `step-${steps.length + 1}` });
    }
  };
  const includesAny = (terms: string[]): boolean => terms.some((term) => normalizedTask.includes(normalizeLookup(term)));

  if (includesAny(["ux", "user experience", "design", "layout", "visual", "accessibility", "mobile", "responsive", "conversion", "onboarding", "homepage"])) {
    addStep({
      title: "UX review",
      reason: "The request touches user experience, visual quality, conversion, accessibility, or responsive behavior.",
      kind: "agent",
      target: "Mira",
      task: `Review UX for this request and produce prioritized findings: ${input.task}`
    });
  }

  if (includesAny(["frontend", "ui", "css", "html", "javascript", "component", "page", "site", "mobile", "responsive", "layout"])) {
    addStep({
      title: "Frontend implementation review",
      reason: "The request likely involves browser-facing code or static site implementation details.",
      kind: "agent",
      target: "frontend",
      task: `Review frontend implementation needs, risks, and concrete fixes for: ${input.task}`
    });
  }

  if (includesAny(["security", "auth", "permission", "secret", "xss", "production", "wordpress", "external"])) {
    addStep({
      title: "Security and production risk review",
      reason: "The request mentions production, external systems, WordPress, or security-sensitive areas.",
      kind: "agent",
      target: "security",
      task: `Review security and production risks for: ${input.task}`
    });
  }

  if (includesAny(["test", "tests", "failing", "failure", "bug", "error", "ci", "build failed", "broken"])) {
    addStep({
      title: "Failure and test triage",
      reason: "The request includes failures, tests, CI, bugs, or build issues.",
      kind: "workflow",
      target: "debug-failure",
      task: `Investigate failures, likely causes, and next fixes for: ${input.task}`
    });
  }

  if (includesAny(["review", "audit", "risk", "production", "deploy", "launch", "ship", "seo", "content", "site"])) {
    addStep({
      title: "Change review",
      reason: "The request calls for review, launch readiness, production confidence, SEO, or site-wide risk assessment.",
      kind: "workflow",
      target: "review-pr",
      task: `Review the project for risks, regressions, missing checks, and recommended actions related to: ${input.task}`,
      skipIfPriorEmpty: true
    });
  }

  if (includesAny(["implement", "fix", "add", "build", "change", "update", "create"]) && !includesAny(["review", "audit", "pass"])) {
    addStep({
      title: "Feature implementation plan",
      reason: "The request asks for implementation or changes, so the build-feature workflow should plan and execute within policy.",
      kind: "workflow",
      target: "build-feature",
      task: `Implement or plan the requested change within project policy: ${input.task}`
    });
  }

  if (includesAny(["context", "memory", "docs", "documentation", "remember", "decisions"])) {
    addStep({
      title: "Context maintenance",
      reason: "The request mentions durable memory, docs, context, or decisions.",
      kind: "workflow",
      target: "maintain-context",
      task: `Update durable project context and decisions for: ${input.task}`
    });
  }

  if (!steps.length) {
    addStep({
      title: "General project review",
      reason: "No narrow route matched, so start with a conservative project review.",
      kind: "workflow",
      target: "review-pr",
      task: `Review and recommend the next action for: ${input.task}`
    });
  }

  return {
    projectDir: input.projectDir,
    task: input.task,
    steps
  };
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

function formatOrchestrationPlan(plan: OrchestrationPlan): string {
  return [
    "Orchestration Plan",
    `Project: ${plan.projectDir}`,
    `Task: ${plan.task}`,
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

async function runOrchestrationPlan(plan: OrchestrationPlan, options: {
  indexMaxFiles: number;
  refineIndex: boolean;
  forceRefine: boolean;
  workerLimit: number;
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
      ? await runDashboardAgentTask({
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
        ? await runWorkflowPreset({
          presetRef: step.target,
          project: plan.projectDir,
          task: step.task,
          indexMaxFiles: options.indexMaxFiles,
          refineIndex: options.refineIndex,
          forceRefine: options.forceRefine,
          workerLimit: options.workerLimit,
          timeoutMs: options.timeoutMs,
          outDir: options.outDir
        })
        : await runDashboardWorkflow({
          title: step.title,
          workflow: step.target,
          projectDir: plan.projectDir,
          task: step.task,
          indexMaxFiles: options.indexMaxFiles,
          refineIndex: options.refineIndex,
          forceRefine: options.forceRefine,
          workerLimit: options.workerLimit,
          timeoutMs: options.timeoutMs,
          outDir: options.outDir
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

async function runDashboardWorkflow(input: {
  title: string;
  workflow: string;
  projectDir: string;
  task: string;
  indexMaxFiles?: number;
  refineIndex?: boolean;
  forceRefine?: boolean;
  workerLimit?: number;
  timeoutMs?: number;
  outDir?: string;
}): Promise<DashboardFollowUpResult> {
  await indexProjectForRun({
    projectDir: input.projectDir,
    maxFiles: input.indexMaxFiles ?? 100,
    refine: input.refineIndex ?? false,
    forceRefine: input.forceRefine ?? false
  });
  const queued = await queueWorkflow({
    workflowId: input.workflow,
    projectPath: input.projectDir,
    task: input.task
  });
  if (!queued.ok) {
    return { ok: false, error: queued.error };
  }
  const watchResult = await watchWorkflowRun({
    runId: queued.run.runId,
    workerLimit: input.workerLimit ?? 6,
    intervalMs: 1000,
    timeoutMs: input.timeoutMs ?? 900000
  });
  const exportResult = await exportWorkflowRun({
    runId: queued.run.runId,
    outDir: input.outDir ?? path.join(input.projectDir, ".agent-workflow", "exports")
  });
  const summary = await summarizeWorkflowRun(queued.run.runId);
  return {
    ok: true,
    title: `${input.title}: ${watchResult.status}`,
    runId: queued.run.runId,
    output: [
      `Run: ${queued.run.runId}`,
      exportResult.ok ? `Exported Markdown: ${exportResult.markdownPath}` : "",
      exportResult.ok ? `Exported JSON: ${exportResult.jsonPath}` : "",
      summary.ok ? formatRunSummary(summary.value) : ""
    ].filter(Boolean).join("\n\n")
  };
}

async function runDashboardAgentTask(input: {
  title: string;
  agent: string;
  projectDir: string;
  task: string;
  indexMaxFiles?: number;
  refineIndex?: boolean;
  forceRefine?: boolean;
  timeoutMs?: number;
  outDir?: string;
}): Promise<DashboardFollowUpResult> {
  await indexProjectForRun({
    projectDir: input.projectDir,
    maxFiles: input.indexMaxFiles ?? 100,
    refine: input.refineIndex ?? false,
    forceRefine: input.forceRefine ?? false
  });
  const agents = await loadAgentsForProject(input.projectDir);
  const agent = resolveAgent(agents, input.agent);
  if (!agent) {
    return { ok: false, error: `Unknown agent: ${input.agent}` };
  }
  const workflow = createAgentTaskWorkflow(agent);
  const builtinAgentIds = new Set((await loadAgents(rootDir)).map((item) => item.id));
  await seedRegistry(builtinAgentIds.has(agent.id) ? [] : [{ path: `project/${agent.id}.yaml`, value: agent }], [{ path: `runtime/${workflow.id}.yaml`, value: workflow }]);
  const queued = await queueWorkflow({
    workflowId: workflow.id,
    projectPath: input.projectDir,
    task: input.task,
    workflowOverride: workflow
  });
  if (!queued.ok) {
    return { ok: false, error: queued.error };
  }
  const watchResult = await watchWorkflowRun({
    runId: queued.run.runId,
    workerLimit: 1,
    intervalMs: 1000,
    timeoutMs: input.timeoutMs ?? 600000
  });
  const exportResult = await exportWorkflowRun({
    runId: queued.run.runId,
    outDir: input.outDir ?? path.join(input.projectDir, ".agent-workflow", "exports")
  });
  const summary = await summarizeWorkflowRun(queued.run.runId);
  return {
    ok: true,
    title: `${input.title}: ${watchResult.status}`,
    runId: queued.run.runId,
    output: [
      `Run: ${queued.run.runId}`,
      `Agent: ${agent.id} (${agent.display_name})`,
      exportResult.ok ? `Exported Markdown: ${exportResult.markdownPath}` : "",
      exportResult.ok ? `Exported JSON: ${exportResult.jsonPath}` : "",
      summary.ok ? formatRunSummary(summary.value) : ""
    ].filter(Boolean).join("\n\n")
  };
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

function normalizeProviderRef(value: string): string {
  const normalized = normalizeLookup(value);
  const aliases: Record<string, string> = {
    auto: "auto",
    automatic: "auto",
    smart: "auto",
    router: "auto",
    "auto-router": "auto",
    openai: "openai",
    "open-ai": "openai",
    gpt: "openai",
    kiro: "kiro",
    byo: "byo",
    "bring-your-own": "byo",
    "bring-your-own-model": "byo",
    "byo-model": "byo",
    mock: "mock",
    test: "mock",
    local: "openai-compatible",
    ollama: "openai-compatible",
    "openai-compatible": "openai-compatible",
    "open-ai-compatible": "openai-compatible",
    compatible: "openai-compatible",
    bedrock: "bedrock",
    aws: "bedrock"
  };
  return aliases[normalized] ?? normalized;
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

type SourceSummaryWithHash = {
  sourceUri: string;
  tokenEstimate: number;
  summary: string;
  contentHash?: string;
  score?: number;
  matchedTerms?: string[];
};

type RunInputSnapshot = {
  schemaVersion: 1;
  capturedAt: string;
  bundle: {
    version: string;
    checksum: string;
  } | null;
  projectConfigHash: string;
  policySnapshotHash: string;
  workflowHash: string;
  selectedSources: Array<{
    sourceUri: string;
    contentHash: string | null;
  }>;
};

type RunStaleInputReport = {
  available: boolean;
  warnings: string[];
  snapshot: RunInputSnapshot | null;
};

async function buildRunInputSnapshot(input: {
  projectConfig: ProjectConfig;
  policySnapshotHash: string;
  workflow: WorkflowDefinition;
  sourceSummaries: SourceSummaryWithHash[];
}): Promise<RunInputSnapshot> {
  const manifest = await buildBundleManifest(rootDir).catch(() => null);
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    bundle: manifest
      ? {
        version: manifest.bundle.version,
        checksum: manifest.checksum.value
      }
      : null,
    projectConfigHash: stableHash(input.projectConfig),
    policySnapshotHash: input.policySnapshotHash,
    workflowHash: stableHash(input.workflow),
    selectedSources: input.sourceSummaries.map((summary) => ({
      sourceUri: summary.sourceUri,
      contentHash: summary.contentHash ?? null
    }))
  };
}

async function assessRunStaleInputs(runId: string): Promise<RunStaleInputReport> {
  const details = await getWorkflowRunDetails(runId);
  if (!details.run) {
    return {
      available: false,
      warnings: [`Unknown workflow run: ${runId}`],
      snapshot: null
    };
  }
  const artifacts = await listArtifacts({ runId, kind: "compiled_brief" });
  const snapshot = readRunInputSnapshot(artifacts.at(-1)?.content);
  if (!snapshot) {
    return {
      available: false,
      warnings: ["This run was created before run-input snapshots were recorded; stale input detection is limited."],
      snapshot: null
    };
  }

  const warnings: string[] = [];
  try {
    const currentConfig = await loadProjectConfig(details.run.projectRootUri);
    const currentConfigHash = stableHash(currentConfig);
    if (currentConfigHash !== snapshot.projectConfigHash) {
      warnings.push("Project config changed since the run was queued.");
    }
    try {
      const currentPolicy = resolveExecutionPolicy(currentConfig, details.run.policyProfile);
      if (currentPolicy.snapshotHash !== snapshot.policySnapshotHash) {
        warnings.push(`Execution policy profile '${details.run.policyProfile}' changed since the run was queued.`);
      }
    } catch (error) {
      warnings.push(`Execution policy profile '${details.run.policyProfile}' can no longer be resolved: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    warnings.push(`Project config could not be loaded for stale-checking: ${error instanceof Error ? error.message : String(error)}`);
  }

  const currentBundle = await buildBundleManifest(rootDir).catch(() => null);
  if (!snapshot.bundle) {
    warnings.push("Original bundle checksum was not recorded for this run.");
  } else if (!currentBundle) {
    warnings.push("Current bundle checksum could not be computed.");
  } else {
    if (currentBundle.bundle.version !== snapshot.bundle.version) {
      warnings.push(`Bundle version changed from ${snapshot.bundle.version} to ${currentBundle.bundle.version}.`);
    }
    if (currentBundle.checksum.value !== snapshot.bundle.checksum) {
      warnings.push("Agent/workflow bundle checksum changed since the run was queued.");
    }
  }

  const workflows = await loadWorkflows(rootDir).catch(() => []);
  const currentWorkflow = resolveWorkflow(workflows, details.run!.workflowId);
  if (!currentWorkflow) {
    warnings.push(`Current workflow definition is unavailable: ${details.run.workflowId}.`);
  } else if (stableHash(currentWorkflow) !== snapshot.workflowHash) {
    warnings.push(`Workflow definition '${details.run.workflowId}' changed since the run was queued; replay will use the stored workflow snapshot when available.`);
  }

  for (const source of snapshot.selectedSources) {
    if (!source.contentHash) {
      warnings.push(`Selected source '${source.sourceUri}' did not record a content hash.`);
      continue;
    }
    if (source.contentHash === "skipped-large-file") {
      continue;
    }
    const absolutePath = path.join(details.run.projectRootUri, source.sourceUri);
    try {
      const currentHash = createHash("sha256").update(await fs.readFile(absolutePath)).digest("hex");
      if (currentHash !== source.contentHash) {
        warnings.push(`Selected source changed: ${source.sourceUri}.`);
      }
    } catch {
      warnings.push(`Selected source is missing or unreadable: ${source.sourceUri}.`);
    }
  }

  return {
    available: true,
    warnings,
    snapshot
  };
}

function readRunInputSnapshot(content: Record<string, unknown> | undefined): RunInputSnapshot | null {
  const metadata = objectValue(content?.metadata);
  const snapshot = objectValue(metadata?.runInputSnapshot);
  if (!snapshot || snapshot.schemaVersion !== 1) {
    return null;
  }
  const bundle = objectValue(snapshot.bundle);
  return {
    schemaVersion: 1,
    capturedAt: stringValue(snapshot.capturedAt) ?? "",
    bundle: bundle
      ? {
        version: stringValue(bundle.version) ?? "unknown",
        checksum: stringValue(bundle.checksum) ?? ""
      }
      : null,
    projectConfigHash: stringValue(snapshot.projectConfigHash) ?? "",
    policySnapshotHash: stringValue(snapshot.policySnapshotHash) ?? "",
    workflowHash: stringValue(snapshot.workflowHash) ?? "",
    selectedSources: Array.isArray(snapshot.selectedSources)
      ? snapshot.selectedSources.map((item) => {
        const source = objectValue(item) ?? {};
        return {
          sourceUri: stringValue(source.sourceUri) ?? "",
          contentHash: stringValue(source.contentHash) ?? null
        };
      }).filter((item) => item.sourceUri)
      : []
  };
}

function formatStaleInputWarnings(report: RunStaleInputReport): string[] {
  if (!report.available) {
    return report.warnings.map((warning) => `Stale-check limited: ${warning}`);
  }
  if (!report.warnings.length) {
    return ["Stale-check: no changed project inputs detected."];
  }
  return [
    "Stale-check warnings:",
    ...report.warnings.map((warning) => `- ${warning}`)
  ];
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function queueWorkflow(input: {
  workflowId: string;
  projectPath: string;
  task: string;
  policyProfile?: string;
  modelTierOverride?: "fast" | "standard" | "reasoning";
  providerOverride?: string;
  evaluationMetadata?: Record<string, unknown>;
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

  const configuredProject = await loadProjectConfig(projectDir);
  let resolvedPolicy: ReturnType<typeof resolveExecutionPolicy>;
  try {
    resolvedPolicy = resolveExecutionPolicy(configuredProject, input.policyProfile);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const project = resolvedPolicy.project;
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
  const sourceSummaries = await loadSourceSummaries({
    projectDir,
    project,
    workflow,
    agents: selectedAgentList,
    task: input.task,
    sourceTokenBudget: input.sourceTokenBudget,
    sourceMaxFiles: input.sourceMaxFiles
  });
  const brief = await compileContext({
    task: input.task,
    projectDir,
    project,
    workflow,
    agents: selectedAgentList,
    sourceSummaries,
    preferenceNotes: await loadPreferenceNotes(projectDir)
  });
  const runInputSnapshot = await buildRunInputSnapshot({
    projectConfig: configuredProject,
    policySnapshotHash: resolvedPolicy.snapshotHash,
    workflow,
    sourceSummaries
  });

  const run = await createWorkflowRun({
    projectName: project.project.name,
    projectRootUri: projectDir,
    projectProfile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
    projectConfig: configuredProject,
    workflow,
    task: input.task,
    autonomy: String(project.project.autonomy),
    policyProfile: resolvedPolicy.profile,
    policySnapshot: resolvedPolicy.snapshot,
    policySnapshotHash: resolvedPolicy.snapshotHash,
    modelTierOverride: input.modelTierOverride,
    providerOverride: input.providerOverride,
    evaluationMetadata: input.evaluationMetadata,
    compiledBrief: brief,
    compiledBriefMetadata: {
      runInputSnapshot
    }
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
  scrub?: boolean;
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
    artifacts,
    scrub: input.scrub
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
  return "project";
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseProposalIds(value: string | undefined): string[] | "all" {
  if (!value || value.trim().toLowerCase() === "all") {
    return "all";
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

async function updateEnvValue(filePath: string, key: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await exists(filePath) ? await fs.readFile(filePath, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const nextLine = `${key}=${value}`;
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return nextLine;
    }
    return line;
  });

  if (!replaced) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") {
      nextLines.push(nextLine);
    } else {
      nextLines.splice(Math.max(0, nextLines.length - 1), 0, nextLine);
    }
  }

  await fs.writeFile(filePath, `${nextLines.join("\n").replace(/\n+$/u, "")}\n`, "utf8");
}

type OnboardingResult = {
  projectDir: string;
  profile: "enterprise" | "simple";
  detected: {
    name: string;
    packageManager?: string;
    frameworks: string[];
    languages: string[];
    markers: string[];
  };
  recommendations: {
    contextInclude: string[];
    contextExclude: string[];
    allowedCommands: string[];
    blockedCommands: string[];
    suggestedAgents: string[];
    defaultWorkflows: string[];
    nextCommands: string[];
  };
  config: ProjectConfig;
  dryRun: {
    valid: boolean;
    notes: string[];
  };
  written?: string[];
  skipped?: string[];
};

async function analyzeProjectForOnboarding(projectDir: string, profile: "enterprise" | "simple"): Promise<OnboardingResult> {
  if (!await exists(projectDir)) {
    throw new Error(`Project directory does not exist: ${projectDir}`);
  }

  const packageJson = await readJsonFile<Record<string, unknown>>(path.join(projectDir, "package.json"));
  const packageScripts = objectValue(packageJson?.scripts);
  const dependencies = {
    ...objectValue(packageJson?.dependencies),
    ...objectValue(packageJson?.devDependencies)
  };
  const packageManager = await detectPackageManager(projectDir, packageJson);
  const commandPrefix = commandPrefixForPackageManager(packageManager);
  const markers = await detectMarkers(projectDir);
  const frameworks = detectFrameworks(dependencies, markers);
  const languages = detectLanguages(packageJson, markers);
  const name = stringValue(packageJson?.name) ?? path.basename(projectDir);
  const allowedCommands = recommendCommands(packageScripts, commandPrefix, markers);
  const contextInclude = recommendContextIncludes(markers, frameworks, languages);
  const contextExclude = recommendContextExcludes(frameworks, languages);
  const allowedWritePaths = recommendWritePaths(frameworks, languages);
  const suggestedAgents = recommendAgents(frameworks, languages, markers);
  const defaultWorkflows = recommendWorkflows(frameworks, languages, markers);
  const recommendedFirstWorkflow = defaultWorkflows.includes("production-readiness") ? "production-readiness" : "review-pr";
  const recommendedFirstTask = recommendedFirstWorkflow === "production-readiness"
    ? "Review production readiness, UX, SEO, mobile experience, security, and launch risks"
    : "Review the current project setup and code quality risks";

  const config: ProjectConfig = {
    project: {
      name,
      summary: summarizeDetectedProject(frameworks, languages, markers),
      default_workflows: defaultWorkflows,
      autonomy: profile === "enterprise" ? 3 : 2
    },
    context: {
      include: contextInclude,
      exclude: contextExclude,
      max_project_tokens: frameworks.includes("static-site") ? 14000 : 12000
    },
    storage: {
      cache_summaries: profile === "enterprise",
      semantic_index: profile === "enterprise"
    },
    execution: {
      policy_profile: "local",
      policy_profiles: {}
    },
    policies: {
      allow_wide_open: false,
      require_approval_for_external_actions: true,
      require_receipts: true
    },
    actions: {
      allowed_commands: allowedCommands,
      blocked_commands: [
        "rm *",
        "git reset *",
        "git clean *",
        "sudo *",
        "curl *",
        "wget *",
        "ssh *",
        "scp *"
      ],
      command_timeout_ms: 120000,
      max_output_chars: 20000,
      allowed_write_paths: allowedWritePaths,
      blocked_write_paths: [
        ".git/**",
        "node_modules/**",
        ".env",
        ".env.*",
        ".agent-workflow/schedule-state.json",
        "**/.next/**",
        "**/dist/**",
        "**/build/**",
        "**/coverage/**"
      ],
      max_write_bytes: 250000
    }
  };

  return {
    projectDir,
    profile,
    detected: {
      name,
      packageManager,
      frameworks,
      languages,
      markers
    },
    recommendations: {
      contextInclude,
      contextExclude,
      allowedCommands,
      blockedCommands: config.actions.blocked_commands,
      suggestedAgents,
      defaultWorkflows,
      nextCommands: [
        `npm run onboard-project -- --project ${projectDir} --profile ${profile} --write`,
        `npm run index-project -- --project ${projectDir} --max-files 100`,
        `npm run agentflow -- run-and-watch ${recommendedFirstWorkflow} --project ${projectDir} --task "${recommendedFirstTask}" --index-max-files 100 --worker-limit 6`
      ]
    },
    config,
    dryRun: {
      valid: true,
      notes: [
        "No files written unless --write is provided.",
        "External network commands are blocked by default.",
        "Writes to .env, .git, node_modules, build output, and coverage output are blocked.",
        "Review allowed commands before enabling higher autonomy."
      ]
    }
  };
}

async function writeOnboardingFiles(projectDir: string, result: OnboardingResult, force: boolean): Promise<{ written: string[]; skipped: string[] }> {
  const workflowDir = path.join(projectDir, ".agent-workflow");
  await fs.mkdir(workflowDir, { recursive: true });
  const files = new Map<string, string>([
    [
      path.join(projectDir, "AGENTS.md"),
      [
        "# AGENTS.md",
        "",
        "This project uses Agent Workflow for reusable agent workflows, project-specific context, and safe automation.",
        "",
        "## Project Rules",
        "",
        "- Read `.agent-workflow/project.yaml` before choosing a workflow.",
        "- Use `.agent-workflow/context.md` for product, user, team, and personalization context.",
        "- Use `.agent-workflow/commands.md` for setup, test, build, and release commands.",
        "- Use `.agent-workflow/decisions.md` for durable project decisions.",
        "- Keep reusable agents and workflows outside this project in the shared Agent Workflow repo.",
        "- Keep project-specific preferences and constraints inside this project.",
        "- Write receipts for automatic actions."
      ].join("\n")
    ],
    [
      path.join(workflowDir, "project.yaml"),
      YAML.stringify(result.config)
    ],
    [
      path.join(workflowDir, "context.md"),
      [
        `# ${result.detected.name} Context`,
        "",
        result.config.project.summary,
        "",
        "## Detected Stack",
        "",
        `- Package manager: ${result.detected.packageManager ?? "none detected"}`,
        `- Frameworks: ${result.detected.frameworks.join(", ") || "none detected"}`,
        `- Languages: ${result.detected.languages.join(", ") || "none detected"}`,
        "",
        "## Personalization Notes",
        "",
        "- Add project-specific product goals, audience, tone, architectural preferences, and reporting preferences here.",
        "- Keep durable preferences here instead of repeating them in every prompt."
      ].join("\n")
    ],
    [
      path.join(workflowDir, "commands.md"),
      [
        "# Agent Workflow Commands",
        "",
        "Recommended safe commands detected during onboarding:",
        "",
        ...result.recommendations.allowedCommands.map((command) => `- \`${command}\``)
      ].join("\n")
    ],
    [
      path.join(workflowDir, "decisions.md"),
      [
        "# Agent Workflow Decisions",
        "",
        "- Initial project configuration generated by `agentflow onboard-project`.",
        "- Update this file with durable architecture and workflow decisions."
      ].join("\n")
    ],
    [
      path.join(workflowDir, "schedules.yaml"),
      YAML.stringify({
        schedules: [
          {
            id: "weekly-context-maintenance",
            enabled: false,
            every_minutes: 10080,
            workflow: "maintain-context",
            task: "Update durable project context, decisions, and command notes.",
            index_max_files: 100,
            worker_limit: 6
          }
        ]
      })
    ]
  ]);

  const written: string[] = [];
  const skipped: string[] = [];
  for (const [filePath, content] of files) {
    const relativePath = path.relative(projectDir, filePath);
    if (!force && await exists(filePath)) {
      skipped.push(relativePath);
      continue;
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${content.replace(/\n+$/u, "")}\n`, "utf8");
    written.push(relativePath);
  }
  return { written, skipped };
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

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function detectPackageManager(projectDir: string, packageJson: Record<string, unknown> | null): Promise<string | undefined> {
  const packageManager = stringValue(packageJson?.packageManager);
  if (packageManager) {
    return packageManager.split("@")[0];
  }
  if (await exists(path.join(projectDir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await exists(path.join(projectDir, "yarn.lock"))) {
    return "yarn";
  }
  if (await exists(path.join(projectDir, "bun.lockb")) || await exists(path.join(projectDir, "bun.lock"))) {
    return "bun";
  }
  if (await exists(path.join(projectDir, "package-lock.json"))) {
    return "npm";
  }
  return packageJson ? "npm" : undefined;
}

function commandPrefixForPackageManager(packageManager: string | undefined): string {
  if (packageManager === "pnpm") {
    return "pnpm";
  }
  if (packageManager === "yarn") {
    return "yarn";
  }
  if (packageManager === "bun") {
    return "bun";
  }
  return "npm run";
}

async function detectMarkers(projectDir: string): Promise<string[]> {
  const markerChecks: Array<[string, string]> = [
    ["package.json", "package-json"],
    ["tsconfig.json", "typescript"],
    ["next.config.js", "next"],
    ["next.config.mjs", "next"],
    ["vite.config.ts", "vite"],
    ["vite.config.js", "vite"],
    ["tailwind.config.ts", "tailwind"],
    ["tailwind.config.js", "tailwind"],
    ["components.json", "shadcn"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["manage.py", "django"],
    ["composer.json", "php"],
    ["wp-config.php", "wordpress"],
    ["index.html", "static-site"],
    ["Dockerfile", "docker"],
    ["docker-compose.yml", "docker-compose"],
    ["docker-compose.yaml", "docker-compose"]
  ];
  const markers: string[] = [];
  for (const [file, marker] of markerChecks) {
    if (await exists(path.join(projectDir, file)) && !markers.includes(marker)) {
      markers.push(marker);
    }
  }
  return markers;
}

function detectFrameworks(dependencies: Record<string, unknown>, markers: string[]): string[] {
  const frameworks = new Set<string>();
  if (dependencies.next || markers.includes("next")) frameworks.add("next");
  if (dependencies.react || dependencies["@vitejs/plugin-react"]) frameworks.add("react");
  if (dependencies.vue || dependencies["@vitejs/plugin-vue"]) frameworks.add("vue");
  if (dependencies.svelte || dependencies["@sveltejs/kit"]) frameworks.add("svelte");
  if (dependencies.astro) frameworks.add("astro");
  if (dependencies.express) frameworks.add("express");
  if (dependencies.fastify) frameworks.add("fastify");
  if (markers.includes("vite")) frameworks.add("vite");
  if (markers.includes("tailwind")) frameworks.add("tailwind");
  if (markers.includes("shadcn")) frameworks.add("shadcn");
  if (markers.includes("django")) frameworks.add("django");
  if (markers.includes("wordpress")) frameworks.add("wordpress");
  if (markers.includes("static-site")) frameworks.add("static-site");
  if (markers.includes("docker") || markers.includes("docker-compose")) frameworks.add("docker");
  return [...frameworks];
}

function detectLanguages(packageJson: Record<string, unknown> | null, markers: string[]): string[] {
  const languages = new Set<string>();
  if (packageJson) languages.add("javascript");
  if (markers.includes("typescript")) languages.add("typescript");
  if (markers.includes("python")) languages.add("python");
  if (markers.includes("php") || markers.includes("wordpress")) languages.add("php");
  if (markers.includes("static-site")) languages.add("html");
  return [...languages];
}

function recommendCommands(scripts: Record<string, unknown>, commandPrefix: string, markers: string[]): string[] {
  const commands = new Set<string>();
  for (const script of ["test", "typecheck", "lint", "build", "check", "verify"]) {
    if (scripts[script]) {
      commands.add(commandPrefix === "npm run" ? `npm run ${script}` : `${commandPrefix} ${script}`);
    }
  }
  if (markers.includes("python")) {
    commands.add("python -m pytest");
  }
  if (markers.includes("php")) {
    commands.add("composer test");
  }
  return [...commands].length ? [...commands] : ["npm test", "npm run typecheck", "npm run lint"];
}

function recommendContextIncludes(markers: string[], frameworks: string[], languages: string[]): string[] {
  const includes = new Set([
    "AGENTS.md",
    ".agent-workflow/**",
    "README.md",
    "docs/**"
  ]);
  if (languages.includes("javascript") || languages.includes("typescript")) {
    includes.add("package.json");
    includes.add("src/**");
    includes.add("app/**");
    includes.add("pages/**");
    includes.add("components/**");
    includes.add("lib/**");
    includes.add("test/**");
    includes.add("tests/**");
  }
  if (languages.includes("python")) {
    includes.add("pyproject.toml");
    includes.add("requirements.txt");
    includes.add("**/*.py");
  }
  if (languages.includes("php") || frameworks.includes("wordpress")) {
    includes.add("composer.json");
    includes.add("wp-content/**");
    includes.add("**/*.php");
  }
  if (frameworks.includes("static-site")) {
    includes.add("index.html");
    includes.add("site/**");
    includes.add("assets/**");
  }
  if (markers.includes("docker") || markers.includes("docker-compose")) {
    includes.add("Dockerfile");
    includes.add("docker-compose.yml");
    includes.add("docker-compose.yaml");
  }
  return [...includes];
}

function recommendContextExcludes(frameworks: string[], languages: string[]): string[] {
  const excludes = new Set([
    "node_modules/**",
    ".git/**",
    "dist/**",
    "build/**",
    "coverage/**",
    ".next/**",
    ".turbo/**",
    ".cache/**",
    ".agent-workflow/schedule-state.json",
    "**/*.jpg",
    "**/*.jpeg",
    "**/*.png",
    "**/*.webp",
    "**/*.gif",
    "**/*.woff",
    "**/*.woff2",
    "**/*.ttf"
  ]);
  if (languages.includes("python")) {
    excludes.add(".venv/**");
    excludes.add("venv/**");
    excludes.add("__pycache__/**");
  }
  if (frameworks.includes("wordpress")) {
    excludes.add("wp-content/uploads/**");
  }
  return [...excludes];
}

function recommendWritePaths(frameworks: string[], languages: string[]): string[] {
  const paths = new Set([
    ".agent-workflow/**",
    "AGENTS.md",
    "README.md",
    "docs/**"
  ]);
  if (languages.includes("javascript") || languages.includes("typescript")) {
    ["src/**", "app/**", "pages/**", "components/**", "lib/**", "test/**", "tests/**", "package.json"].forEach((item) => paths.add(item));
  }
  if (languages.includes("python")) {
    ["**/*.py", "pyproject.toml", "requirements.txt", "tests/**"].forEach((item) => paths.add(item));
  }
  if (languages.includes("php") || frameworks.includes("wordpress")) {
    ["**/*.php", "wp-content/themes/**", "wp-content/plugins/**", "composer.json"].forEach((item) => paths.add(item));
  }
  if (frameworks.includes("static-site")) {
    ["index.html", "site/**", "assets/**"].forEach((item) => paths.add(item));
  }
  return [...paths];
}

function recommendAgents(frameworks: string[], languages: string[], markers: string[]): string[] {
  const agents = new Set(["technical-architect", "implementation-agent", "test-engineer", "docs-maintainer"]);
  if (frameworks.some((framework) => ["react", "next", "vite", "vue", "svelte", "astro", "tailwind", "shadcn", "static-site"].includes(framework))) {
    agents.add("frontend-engineer");
    agents.add("ux-reviewer");
  }
  if (frameworks.some((framework) => ["express", "fastify", "django"].includes(framework)) || languages.includes("php")) {
    agents.add("backend-engineer");
  }
  if (markers.includes("docker") || markers.includes("docker-compose")) {
    agents.add("ci-debugger");
  }
  agents.add("security-reviewer");
  return [...agents];
}

function recommendWorkflows(frameworks: string[], _languages: string[], _markers: string[]): string[] {
  const workflows = new Set(["build-feature", "review-pr", "debug-failure", "maintain-context"]);
  if (frameworks.some((framework) => ["react", "next", "vite", "vue", "svelte", "astro", "static-site", "wordpress"].includes(framework))) {
    workflows.add("production-readiness");
  }
  return [...workflows];
}

function summarizeDetectedProject(frameworks: string[], languages: string[], markers: string[]): string {
  const stack = [...frameworks, ...languages].filter(Boolean);
  if (stack.length) {
    return `Detected ${stack.join(", ")} project. Generated onboarding config should be reviewed and personalized for users, product goals, quality gates, and deployment constraints.`;
  }
  if (markers.length) {
    return `Detected project markers: ${markers.join(", ")}. Generated onboarding config should be reviewed and personalized before live workflow runs.`;
  }
  return "Generic project. Generated onboarding config should be reviewed and personalized before live workflow runs.";
}

async function loadSourceSummaries(input: {
  projectDir: string;
  project: Awaited<ReturnType<typeof loadProjectConfig>>;
  workflow: Awaited<ReturnType<typeof loadWorkflows>>[number];
  agents: Awaited<ReturnType<typeof loadAgents>>;
  task: string;
  sourceTokenBudget?: string;
  sourceMaxFiles?: string;
}): Promise<SourceSummaryWithHash[]> {
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

async function loadPreferenceNotes(projectDir: string): Promise<string[]> {
  try {
    const memory = await getLatestMemory({
      projectRootUri: projectDir,
      limit: 25
    });
    const feedbackItems = memory
      .filter((item) => item.metadata?.kind === "run_feedback")
      .slice(0, 8);

    return feedbackItems.map((item) => {
      const rating = typeof item.metadata.rating === "string" ? item.metadata.rating : "unknown";
      const workflowId = typeof item.metadata.workflowId === "string" ? item.metadata.workflowId : "unknown-workflow";
      const note = typeof item.metadata.note === "string" && item.metadata.note.trim() ? ` Note: ${item.metadata.note.trim()}` : "";
      return `${rating} feedback for ${workflowId}.${note} (${item.updatedAt})`;
    });
  } catch {
    return [];
  }
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
