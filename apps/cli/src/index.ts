#!/usr/bin/env node
import fsSync from "node:fs";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
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
import { buildEvaluationGateReport, buildEvaluationReport, evaluationGateSchema, evaluationScoringProfileSchema, evaluationSuiteSchema, formatEvaluationGateReport, formatEvaluationReport, type EvaluationObservation, type EvaluationScoringProfile } from "../../../packages/evaluation/src/index.js";
import { queueSnapshotSignature, queueWatcherScript } from "../../../packages/dashboard/src/queue-watcher.js";
import { buildIdeConfigSnippet, mergeIdeConfig, type IdeClient } from "../../../packages/ide-onboarding/src/index.js";
import { buildGovernanceReport, finalizeGovernanceProject, formatGovernanceReport, type GovernanceReport } from "../../../packages/governance/src/index.js";
import { buildBundleCompatibilityReport, buildBundleLifecyclePlan, buildBundlePinPlan, buildBundleRegistryReport, buildBundleUpgradePreview, bundleTrustStorePath, formatBundleCompatibilityReport, formatBundleLifecyclePlan, formatBundlePinPlan, formatBundleRegistryReport, formatBundleUpgradePreview, loadBundleRegistry, normalizePolicy, publicKeyFingerprint, readBundleTrustStore, signBundleManifest, verifyBundle, writeBundleLifecyclePlan, writeBundlePin, writeBundleTrustStore, type BundleCompatibilityReport, type BundleRegistryReport, type BundleTrustPolicy, type BundleUpgradePreview, type BundleVerification, type ProjectBundlePin, type ProjectBundleState } from "../../../packages/bundle-trust/src/index.js";
import { agentWorkflowEnvPath, findAgentWorkflowRoot } from "../../../packages/runtime-root/src/index.js";
import { evaluateAgentAutonomy, resolveExecutionPolicy } from "../../../packages/policy-engine/src/index.js";
import { executeAllowedCommand } from "../../../packages/local-tools/src/command-executor.js";
import { executeAllowedFileWrite } from "../../../packages/local-tools/src/file-writer.js";
import { indexProjectFiles } from "../../../packages/project-indexer/src/index.js";
import { checkServices } from "../../../packages/storage/src/doctor.js";
import {
  cancelWorkflowRun,
  completeApprovalRequestRun,
  createWorkflowRun,
  deleteProjectFiles,
  decideActionApproval,
  dismissAllFailedWorkflowRuns,
  dismissFailedWorkflowRun,
  getActionApproval,
  getArtifactById,
  getArtifactByUri,
  getLatestMemory,
  getProjectIndexState,
  getWorkflowRunDetails,
  findRunActionByIdempotencyKey,
  listActionApprovals,
  listArtifactLifecycle,
  listArtifacts,
  listProjectFileSummaries,
  listProjectStorageSummaries,
  listWorkflowQueue,
  listWorkflowStageHealthForRuns,
  listWorkflowStageRunsForRuns,
  listWorkflowRunsForProject,
  listWorkflowRuns,
  migrateStorage,
  markActionApprovalExecution,
  recordRunAction,
  requestActionApproval,
  requeueExpiredWorkflowTaskLeases,
  requeueRunningWorkflowTasks,
  replayWorkflowRun,
  resumeWorkflowRunFromCheckpoint,
  resetStorage,
  retryFailedWorkflowRun,
  seedRegistry,
  upsertMemoryItem,
  upsertProject,
  upsertProjectIndexState,
  upsertProjectFiles
} from "../../../packages/storage/src/postgres.js";
import { runWorkerOnce, runWorkerWatch } from "../../../packages/workflow-engine/src/executor.js";
import { providerFromEnv } from "../../../packages/model-providers/src/index.js";
import { selectModelRoute } from "../../../packages/model-providers/src/routing.js";
import { appendTuningApprovalHistory, buildCandidateComparisonPlan, buildCostQualityReport, buildModelImprovementPlan, buildPreferenceScorecard, buildRunExport, buildTuningApplicationPlan, buildTuningApprovalQueue, buildTuningPatchApplicationPlan, buildTuningPatchPlan, buildTuningProposals, decideTuningApprovals, formatCandidateComparisonPlan, formatCostQualityReport, formatModelImprovementPlan, formatPreferenceScorecard, formatTuningApplicationPlan, formatTuningApprovalHistory, formatTuningApprovalHistoryMarkdown, formatTuningApprovalQueue, formatTuningApprovalQueueMarkdown, formatTuningPatchPlan, formatTuningProposals, type CandidateComparisonPlan, type CandidateVariantPlan, type CostQualityReport, type ModelImprovementPlan, type PreferenceScorecard, type TuningApplicationPlan, type TuningApprovalHistory, type TuningApprovalQueue, type TuningHistoryStatus, type TuningPatchPlan, type TuningPatchPlanDocument, type TuningProposalSet } from "../../../packages/run-reporter/src/index.js";
import { buildObservabilityReport, formatObservabilityReport, type ObservabilityReport } from "../../../packages/observability/src/index.js";
import { buildWorkflowGraphReport, formatWorkflowGraphReport, type WorkflowGraphReport } from "../../../packages/workflow-inspector/src/index.js";
import { buildSchemaSummary, buildVsCodeSettings } from "../../../packages/schema-registry/src/index.js";
import { buildDefinitionMigrationPlan, formatDefinitionMigrationPlan, loadDefinitionMigrationCatalog, type DefinitionMigrationPlan } from "../../../packages/definition-migrations/src/index.js";
import { formatContractTestReport, runDefinitionContractTests, type ContractTestReport } from "../../../packages/contract-tests/src/index.js";

const program = new Command();
const rootDir = findAgentWorkflowRoot(import.meta.url);
const configuredEnvPath = agentWorkflowEnvPath(rootDir);
dotenv.config({ path: configuredEnvPath, quiet: true });
const defaultWorkerHeartbeatPath = path.join(rootDir, ".agent-workflow", "runtime", "worker-heartbeat.json");
const defaultWorkerHeartbeatDir = path.join(rootDir, ".agent-workflow", "runtime", "workers");
const defaultSupervisorHeartbeatPath = path.join(rootDir, ".agent-workflow", "runtime", "supervisor-heartbeat.json");
const defaultBundleRegistryPath = path.join(rootDir, "registries", "bundles.json");

program.hook("preAction", async (_command, actionCommand) => {
  if (["validate", "schemas", "contract-test", "bundle-manifest", "bundle-compat", "bundle-registry", "bundle-pin", "bundle-lifecycle-plan", "bundle-upgrade-preview", "definition-migrations", "bundle-verify", "bundle-sign", "bundle-trust", "server-readiness", "server-projects", "server-resolve-project", "server-request-preview", "server-route-preview"].includes(actionCommand.name())) return;
  const policy = normalizePolicy(process.env.AGENTFLOW_BUNDLE_TRUST_POLICY);
  const verification = await verifyBundle(rootDir, policy);
  if (!verification.allowed) throw new Error(`Bundle trust policy ${policy} rejected ${verification.status}: ${verification.reasons.join(" ")}`);
  if (policy === "warn" && verification.status !== "trusted") console.error(`WARNING: bundle ${verification.status}: ${verification.reasons.join(" ")}`);
});

type WorkerHeartbeat = {
  pid: number;
  workerId: string;
  projectRootUri: string | null;
  concurrency: number;
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
  workerId: string | null;
  projectRootUri: string | null;
  concurrency: number | null;
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
  lanes: DashboardWorkerLane[];
};

type DashboardWorkerLane = Omit<DashboardWorkerStatus, "lanes">;

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
  .version("0.2.1");

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
  .command("contract-test")
  .description("Run contract tests for reusable definitions, project-local agents, and provider adapters")
  .option("--definitions <dir>", "definition bundle root with agents/ and workflows/", rootDir)
  .option("-p, --project <dir>", "project directory with optional .agent-workflow/agents")
  .option("--provider <provider>", "provider adapter to check", "mock")
  .option("--live-provider", "allow execution against non-mock providers")
  .option("--json", "print machine-readable contract report")
  .action(async (options: { definitions: string; project?: string; provider: string; liveProvider?: boolean; json?: boolean }) => {
    const providerId = normalizeProviderRef(options.provider);
    const provider = providerFromEnv(providerId);
    if (provider.id !== "mock" && !options.liveProvider) {
      console.error(`Provider ${provider.id} will be loaded but not executed. Pass --live-provider to run the adapter contract against a live model.`);
    }
    const report = await runDefinitionContractTests({
      definitionsDir: path.resolve(process.cwd(), options.definitions),
      projectDir: options.project ? path.resolve(process.cwd(), options.project) : undefined,
      provider,
      liveProvider: Boolean(options.liveProvider)
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatContractTestReport(report));
    if (!report.passed) process.exitCode = 1;
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
  .command("bundle-compat")
  .description("Check the current bundle against runtime, Node.js, and MCP compatibility requirements")
  .option("--runtime-version <version>", "Agent Workflow runtime version to check; defaults to this package version")
  .option("--node-version <version>", "Node.js version to check; defaults to the current process version")
  .option("--mcp-version <version>", "MCP SDK version to check; defaults to the manifest MCP requirement")
  .option("--json", "print machine-readable compatibility report")
  .action(async (options: { runtimeVersion?: string; nodeVersion?: string; mcpVersion?: string; json?: boolean }) => {
    const manifest = await loadCommittedBundleManifest(rootDir);
    if (!manifest) throw new Error("Bundle manifest is missing.");
    const packageJson = await readJsonFile<{ version?: string }>(path.join(rootDir, "package.json"));
    const report = buildBundleCompatibilityReport(manifest, {
      agentWorkflow: options.runtimeVersion ?? packageJson?.version ?? "0.0.0",
      node: options.nodeVersion ?? process.version.slice(1),
      mcp: options.mcpVersion ?? manifest.compatibility.mcp
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatBundleCompatibilityReport(report));
    if (!report.compatible) process.exitCode = 2;
  });

program
  .command("bundle-registry")
  .description("List trusted bundle registry entries and local install status")
  .option("--registry <file>", "bundle registry JSON file", defaultBundleRegistryPath)
  .option("--json", "print machine-readable registry report")
  .action(async (options: { registry: string; json?: boolean }) => {
    const registryPath = path.resolve(process.cwd(), options.registry);
    const registry = await loadBundleRegistry(registryPath);
    const manifest = await loadCommittedBundleManifest(rootDir);
    const report = buildBundleRegistryReport({
      registry,
      registryPath,
      installedManifest: manifest,
      installedChecksum: manifest?.checksum.value
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatBundleRegistryReport(report));
  });

program
  .command("bundle-pin")
  .description("Prepare or write a project-local bundle version pin")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--bundle-id <id>", "registry bundle id", "agent-workflow-core")
  .option("--version <version>", "version to pin; defaults to registry latest")
  .option("--checksum <sha256>", "optional expected bundle checksum")
  .option("--registry <file>", "bundle registry JSON file", defaultBundleRegistryPath)
  .option("--actor <id>", "actor recorded in the pin", process.env.USER ?? "local-user")
  .option("--reason <text>", "reason recorded in the pin", "Project-local bundle version pin.")
  .option("--write", "write .agent-workflow/bundle-pin.json")
  .option("--json", "print machine-readable pin plan")
  .action(async (options: { project: string; bundleId: string; version?: string; checksum?: string; registry: string; actor: string; reason: string; write?: boolean; json?: boolean }) => {
    const registryPath = path.resolve(process.cwd(), options.registry);
    const registry = await loadBundleRegistry(registryPath);
    const plan = buildBundlePinPlan({
      registry,
      projectDir: path.resolve(process.cwd(), options.project),
      bundleId: options.bundleId,
      version: options.version,
      checksum: options.checksum,
      actor: options.actor,
      reason: options.reason,
      write: Boolean(options.write)
    });
    if (options.write && plan.pin) {
      await writeBundlePin(plan);
    }
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatBundlePinPlan(plan));
    if (plan.status === "unknown-bundle") process.exitCode = 2;
  });

program
  .command("bundle-lifecycle-plan")
  .description("Prepare reviewed upgrade or rollback command plans without executing them")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--bundle-id <id>", "registry bundle id", "agent-workflow-core")
  .option("--mode <mode>", "upgrade or rollback", "upgrade")
  .option("--target-version <version>", "target version; required for rollback and defaults to registry latest for upgrade")
  .option("--registry <file>", "bundle registry JSON file", defaultBundleRegistryPath)
  .option("--write", "write .agent-workflow/bundle-lifecycle-plan.json")
  .option("--json", "print machine-readable lifecycle plan")
  .action(async (options: { project: string; bundleId: string; mode: string; targetVersion?: string; registry: string; write?: boolean; json?: boolean }) => {
    if (options.mode !== "upgrade" && options.mode !== "rollback") throw new Error("--mode must be upgrade or rollback");
    const registryPath = path.resolve(process.cwd(), options.registry);
    const registry = await loadBundleRegistry(registryPath);
    const plan = buildBundleLifecyclePlan({
      registry,
      projectDir: path.resolve(process.cwd(), options.project),
      bundleId: options.bundleId,
      mode: options.mode,
      targetVersion: options.targetVersion,
      write: Boolean(options.write)
    });
    if (options.write && plan.status === "ready") {
      await writeBundleLifecyclePlan(plan);
    }
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatBundleLifecyclePlan(plan));
    if (plan.status !== "ready") process.exitCode = 2;
  });

program
  .command("bundle-upgrade-preview")
  .description("Preview project bundle migration notes and safe upgrade actions without changing files")
  .option("-p, --project <dir>", "project directory with .agent-workflow/bundle-state.json")
  .option("--from-version <version>", "source bundle version to compare from")
  .option("--from-checksum <checksum>", "source bundle checksum to compare from")
  .option("--from-bundle-id <id>", "source bundle id to compare from")
  .option("--json", "print machine-readable upgrade preview")
  .action(async (options: { project?: string; fromVersion?: string; fromChecksum?: string; fromBundleId?: string; json?: boolean }) => {
    const manifest = await loadCommittedBundleManifest(rootDir);
    if (!manifest) throw new Error("Bundle manifest is missing.");
    const statePath = options.project ? path.join(path.resolve(process.cwd(), options.project), ".agent-workflow", "bundle-state.json") : undefined;
    const state = statePath ? await readJsonFile<ProjectBundleState>(statePath) : null;
    const preview = buildBundleUpgradePreview(manifest, {
      state: state ?? undefined,
      statePath,
      fromVersion: options.fromVersion,
      fromChecksum: options.fromChecksum,
      fromBundleId: options.fromBundleId
    });
    console.log(options.json ? JSON.stringify(preview, null, 2) : formatBundleUpgradePreview(preview));
    if (preview.status === "checksum-drift" || preview.status === "different-bundle") process.exitCode = 2;
  });

program
  .command("bundle-adopt")
  .description("Record the current reusable bundle as adopted by a project")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--force", "overwrite an existing .agent-workflow/bundle-state.json")
  .option("--json", "print machine-readable adoption output")
  .action(async (options: { project: string; force?: boolean; json?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const result = await writeProjectBundleState(projectDir, Boolean(options.force));
    const statePath = path.join(projectDir, result.relativePath);
    const state = await readJsonFile<ProjectBundleState>(statePath);
    const output = { projectDir, statePath, status: result.status, state };
    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    console.log(`${result.status === "written" ? "Recorded" : "Skipped existing"} bundle state: ${statePath}`);
    if (result.status === "skipped") console.log("Use --force after reviewing bundle-upgrade-preview to replace the recorded baseline.");
  });

program
  .command("definition-migrations")
  .description("Preview definition contract migration steps, validation, and rollback guidance")
  .option("-p, --project <dir>", "project directory with .agent-workflow/bundle-state.json")
  .option("--from-version <version>", "source bundle version to compare from")
  .option("--from-checksum <checksum>", "source bundle checksum to compare from")
  .option("--json", "print machine-readable migration plan")
  .action(async (options: { project?: string; fromVersion?: string; fromChecksum?: string; json?: boolean }) => {
    const manifest = await loadCommittedBundleManifest(rootDir);
    if (!manifest) throw new Error("Bundle manifest is missing.");
    const catalog = await loadDefinitionMigrationCatalog(rootDir);
    const statePath = options.project ? path.join(path.resolve(process.cwd(), options.project), ".agent-workflow", "bundle-state.json") : undefined;
    const state = statePath ? await readJsonFile<ProjectBundleState>(statePath) : null;
    const plan = buildDefinitionMigrationPlan({
      manifest,
      catalog,
      state: state ?? undefined,
      statePath,
      fromVersion: options.fromVersion,
      fromChecksum: options.fromChecksum
    });
    console.log(options.json ? JSON.stringify(plan, null, 2) : formatDefinitionMigrationPlan(plan));
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
    const hadBundleState = await exists(path.join(projectDir, ".agent-workflow", "bundle-state.json"));
    const result = await copyTemplate(templateDir, projectDir, Boolean(options.force));
    const bundleState = await writeProjectBundleState(projectDir, Boolean(options.force) || !hadBundleState);
    console.log(`Initialized ${options.profile} agent workflow files in ${projectDir}`);
    console.log(`Wrote ${result.written}; skipped ${result.skipped}.`);
    console.log(`${bundleState.status === "written" ? "Wrote" : "Skipped"} ${bundleState.relativePath}.`);
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
  .command("schemas")
  .description("List JSON Schemas and optionally write VS Code/Cursor YAML validation settings")
  .option("-p, --project <dir>", "project directory for editor settings")
  .option("--write-vscode", "write .vscode/settings.json YAML schema associations")
  .option("--json", "print machine-readable schema registry output")
  .action(async (options: { project?: string; writeVscode?: boolean; json?: boolean }) => {
    const schemas = buildSchemaSummary(rootDir);
    const vscode = buildVsCodeSettings(rootDir);
    let settingsPath: string | undefined;
    let settingsStatus: "not-requested" | "written" | "unchanged" = "not-requested";

    if (options.writeVscode) {
      if (!options.project) throw new Error("--write-vscode requires --project");
      const projectDir = path.resolve(process.cwd(), options.project);
      settingsPath = path.join(projectDir, ".vscode", "settings.json");
      const existing = objectValue(await readJsonFile<Record<string, unknown>>(settingsPath));
      const existingYamlSchemas = objectValue(existing["yaml.schemas"]);
      const nextSettings = {
        ...existing,
        "yaml.schemas": {
          ...existingYamlSchemas,
          ...objectValue(vscode["yaml.schemas"])
        }
      };
      const nextContent = `${JSON.stringify(nextSettings, null, 2)}\n`;
      let currentContent: string | undefined;
      try { currentContent = await fs.readFile(settingsPath, "utf8"); } catch {}
      settingsStatus = currentContent === nextContent ? "unchanged" : "written";
      if (settingsStatus === "written") {
        await fs.mkdir(path.dirname(settingsPath), { recursive: true });
        await fs.writeFile(settingsPath, nextContent, "utf8");
      }
    }

    const result = { schemas, vscode, settingsPath, settingsStatus };
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("Agent Workflow Schemas");
    for (const schema of schemas) {
      console.log(`- ${schema.id}: ${schema.path}`);
      console.log(`  Files: ${schema.fileGlobs.join(", ")}`);
    }
    if (settingsPath) console.log(`${settingsStatus.toUpperCase()}: ${settingsPath}`);
    else console.log("\nEditor setup: npm run agentflow -- schemas --write-vscode --project /path/to/project");
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
  .command("roles")
  .description("Inspect project team roles and recent approval decisions by role")
  .option("-p, --project <dir>", "filter by project directory")
  .option("-l, --limit <number>", "number of recent approvals to inspect", "50")
  .option("--role <role>", "filter approvals by decided or executed role")
  .option("--status <status>", "filter approvals by status, or all", "all")
  .option("--action <action>", "filter approvals by action type")
  .option("--export", "write Markdown and JSON role audit snapshot files")
  .option("-o, --out <dir>", "export directory; defaults to project-local or repo-local .agent-workflow/exports/roles")
  .option("--json", "print machine-readable role governance report")
  .action(async (options: { project?: string; limit: string; role?: string; status: string; action?: string; export?: boolean; out?: string; json?: boolean }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }
    const report = await loadRoleGovernanceReport({
      projectRootUri: options.project,
      limit: parsePositiveInteger(options.limit, 50),
      role: options.role,
      status: options.status,
      actionType: options.action
    });
    if (options.export) {
      const exported = await writeRoleAuditSnapshot(report, options.out);
      console.log(`Role audit snapshot written:`);
      console.log(`- Markdown: ${exported.markdownPath}`);
      console.log(`- JSON: ${exported.jsonPath}`);
      if (!options.json) return;
    }
    console.log(options.json ? JSON.stringify(report, null, 2) : formatRoleGovernanceReport(report));
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
    await migrateStorage();
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
  .option("--incremental", "only refresh files changed since the last indexed commit")
  .option("--since-commit <sha>", "reference commit for incremental indexing")
  .option("--refine", "refine file summaries with the selected provider")
  .option("--force-refine", "refresh refined summaries even when content hash is unchanged")
  .option("--watch", "keep polling for changed files and refresh incrementally")
  .option("--interval-ms <number>", "watch polling interval in milliseconds", "10000")
  .action(async (options: { project: string; maxFiles: string; incremental?: boolean; sinceCommit?: string; refine?: boolean; forceRefine?: boolean; watch?: boolean; intervalMs: string }) => {
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
    const parsedMaxFiles = Number.isFinite(maxFiles) && maxFiles > 0 ? maxFiles : 200;
    const runOnce = async (incrementalOverride: boolean) => {
      const projectId = await upsertProject({
        name: project.project.name,
        rootUri: projectDir,
        profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
        config: project
      });
      const state = await getProjectIndexState({ projectId });
      return indexProjectWithStorage({
        projectId,
        projectDir,
        project,
        maxFiles: parsedMaxFiles,
        refineProvider: options.refine ? providerFromEnv() : undefined,
        forceRefine: Boolean(options.forceRefine),
        incremental: incrementalOverride,
        sinceCommit: options.sinceCommit ?? state?.headCommit ?? undefined
      });
    };

    const incremental = Boolean(options.incremental || options.sinceCommit || options.watch);
    const result = await runOnce(incremental);
    console.log(formatIndexResult(result));
    if (!options.watch) {
      return;
    }

    const intervalMs = parsePositiveInteger(options.intervalMs, 10_000);
    console.log(`Watching ${projectDir} for incremental indexing every ${intervalMs}ms. Press Ctrl+C to stop.`);
    while (true) {
      await sleep(intervalMs);
      const tick = await runOnce(true);
      if (tick.count > 0 || tick.deleted > 0 || tick.fullIndexFallback || tick.truncated) {
        console.log(formatIndexResult(tick));
      }
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
    const agents = await loadAgentsForProject(projectDir);
    const workflows = await loadWorkflows(rootDir);
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
      const indexResult = await indexProjectForRun({
        projectDir,
        maxFiles: indexMaxFiles,
        refine: Boolean(options.refineIndex),
        forceRefine: Boolean(options.forceRefine),
        fullIndex: Boolean(options.fullIndex)
      });
      console.log(formatIndexResult(indexResult));
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
        forceRefine: Boolean(options.forceRefine),
        fullIndex: Boolean(options.fullIndex)
      });
      console.log(formatIndexResult(indexResult));
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
  .option("--worker-concurrency <number>", "maximum workflow tasks to execute at the same time per worker tick", "1")
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
  .command("approvals")
  .description("List, approve, or reject pending agent-requested actions")
  .option("--status <status>", "pending, approved, executed, failed, rejected, or all", "pending")
  .option("-r, --run <id>", "filter by workflow run id")
  .option("-p, --project <dir>", "filter by project directory")
  .option("--approve <id>", "approval id to approve")
  .option("--reject <id>", "approval id to reject")
  .option("--execute <id>", "execute an approved action")
  .option("--actor <name>", "person or tool making the decision", "cli")
  .option("--actor-role <role>", "project role for audit receipts, such as operator, approver, workflow_author, or auditor")
  .option("--note <text>", "decision note")
  .option("-l, --limit <number>", "number of approvals to show", "25")
  .option("--json", "print JSON")
  .action(async (options: { status: string; run?: string; project?: string; approve?: string; reject?: string; execute?: string; actor: string; actorRole?: string; note?: string; limit: string; json?: boolean }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }

    if ([options.approve, options.reject, options.execute].filter(Boolean).length > 1) {
      console.error("Choose only one of --approve, --reject, or --execute.");
      process.exitCode = 1;
      return;
    }

    if (options.execute) {
      const result = await executeApprovedAction({
        approvalId: options.execute,
        actor: options.actor,
        actorRole: normalizeActorRole(options.actorRole, "operator")
      });
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(result.title);
      console.log(result.output);
      return;
    }

    if (options.approve || options.reject) {
      const approvalId = options.approve ?? options.reject ?? "";
      const approvalForGate = await getActionApproval(approvalId);
      if (!approvalForGate) {
        console.error("Approval was not found or is no longer pending.");
        process.exitCode = 1;
        return;
      }
      const project = await loadProjectConfig(approvalForGate.projectRootUri);
      const actorRole = normalizeActorRole(options.actorRole, "approver");
      const gate = evaluateRoleGate(project, actorRole, options.approve ? "can_approve_actions" : "can_reject_actions");
      if (!gate.allowed) {
        console.error(gate.message);
        process.exitCode = 1;
        return;
      }
      const approval = await decideActionApproval({
        approvalId,
        decision: options.approve ? "approved" : "rejected",
        actor: options.actor,
        actorRole,
        note: options.note
      });
      if (!approval) {
        console.error("Approval was not found or is no longer pending.");
        process.exitCode = 1;
        return;
      }
      if (options.json) {
        console.log(JSON.stringify(approval, null, 2));
        return;
      }
      console.log(`${approval.status}: ${approval.id}`);
      console.log(`${approval.actionType} ${approval.target}`);
      console.log(`Run: ${approval.runId}`);
      return;
    }

    const status = options.status === "all" ? undefined : options.status;
    const approvals = await listActionApprovals({
      status,
      runId: options.run,
      projectRootUri: options.project ? path.resolve(process.cwd(), options.project) : undefined,
      limit: parsePositiveInteger(options.limit, 25)
    });
    if (options.json) {
      console.log(JSON.stringify(approvals, null, 2));
      return;
    }
    if (!approvals.length) {
      console.log("No action approvals found.");
      return;
    }
    for (const approval of approvals) {
      console.log(`${approval.id} ${approval.status} ${approval.actionType} ${approval.target}`);
      console.log(`  Run: ${approval.runId} ${approval.workflowId}`);
      console.log(`  Stage: ${approval.stageId} (${approval.agentId})`);
      console.log(`  Project: ${approval.projectRootUri}`);
      console.log(`  Rationale: ${approval.rationale}`);
      console.log(`  Role preview: ${rolePreviewForApproval(approval)}`);
      if (approval.decidedBy) {
        console.log(`  Decided: ${approval.decidedBy}${approval.decidedRole ? ` (${approval.decidedRole})` : ""} at ${approval.decidedAt ?? "unknown"}${approval.decisionNote ? ` - ${approval.decisionNote}` : ""}`);
      }
    }
  });

program
  .command("request-approval")
  .description("Create a run-level approval request for deployment or autonomy decisions")
  .requiredOption("-p, --project <dir>", "project directory")
  .requiredOption("--type <type>", "deployment or autonomy")
  .requiredOption("--target <target>", "approval target, such as staging, production, or autonomy level")
  .requiredOption("--rationale <text>", "why this approval is needed")
  .option("-w, --workflow <id>", "workflow context for the approval request")
  .option("--policy-profile <name>", "execution policy profile snapshot to attach")
  .option("--actor <name>", "person or tool requesting approval", "cli")
  .option("--actor-role <role>", "project role for audit receipts", "operator")
  .option("--json", "print JSON")
  .action(async (options: { project: string; type: string; target: string; rationale: string; workflow?: string; policyProfile?: string; actor: string; actorRole: string; json?: boolean }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }

    const result = await requestRunLevelApproval({
      projectPath: options.project,
      type: options.type,
      target: options.target,
      rationale: options.rationale,
      workflowId: options.workflow,
      policyProfile: options.policyProfile,
      actor: options.actor,
      actorRole: normalizeActorRole(options.actorRole, "operator")
    });
    if (!result.ok) {
      console.error(result.error);
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(result.title);
    console.log(result.output);
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
  .command("artifact-lifecycle")
  .description("Inspect read-only artifact inventory, age buckets, and storage lifecycle hints")
  .option("-p, --project <dir>", "filter by project directory")
  .option("-k, --kind <kind>", "filter by artifact kind")
  .option("-l, --limit <number>", "number of recent artifacts to inspect", "500")
  .option("--prune-plan", "include a dry-run prune plan; does not delete anything")
  .option("--archive-plan", "include a dry-run archive plan; does not archive anything")
  .option("--restore-plan", "include a dry-run restore plan from archived artifact snapshots; does not restore anything")
  .option("--min-age-days <number>", "override minimum artifact age for prune candidates")
  .option("--min-bytes <number>", "override minimum artifact JSON size for prune candidates")
  .option("--include-audit", "allow audit artifacts in the dry-run prune plan")
  .option("--queue-approvals", "queue approval requests for dry-run prune candidates; does not execute pruning")
  .option("--queue-archive-approvals", "queue approval requests for dry-run archive candidates; does not execute archiving")
  .option("--queue-restore-approvals", "queue approval requests for dry-run restore candidates; does not execute restore")
  .option("--actor <name>", "person or tool requesting lifecycle approvals", "cli")
  .option("--actor-role <role>", "project role for approval request audit", "operator")
  .option("--json", "print machine-readable artifact lifecycle report")
  .action(async (options: { project?: string; kind?: string; limit: string; prunePlan?: boolean; archivePlan?: boolean; restorePlan?: boolean; minAgeDays?: string; minBytes?: string; includeAudit?: boolean; queueApprovals?: boolean; queueArchiveApprovals?: boolean; queueRestoreApprovals?: boolean; actor: string; actorRole: string; json?: boolean }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }
    if ((options.queueApprovals || options.queueArchiveApprovals || options.queueRestoreApprovals) && !options.project) {
      console.error("Queueing lifecycle approvals requires --project so project-local lifecycle policy and roles can be checked.");
      process.exitCode = 1;
      return;
    }
    const report = await loadArtifactLifecycleReport({
      projectRootUri: options.project,
      kind: options.kind,
      limit: parsePositiveInteger(options.limit, 500),
      prunePlan: Boolean(options.prunePlan || options.queueApprovals),
      archivePlan: Boolean(options.archivePlan || options.queueArchiveApprovals),
      restorePlan: Boolean(options.restorePlan || options.queueRestoreApprovals),
      minAgeDays: options.minAgeDays ? parseNonNegativeInteger(options.minAgeDays, 30) : undefined,
      minBytes: options.minBytes ? parseNonNegativeInteger(options.minBytes, 20_000) : undefined,
      includeAudit: options.includeAudit === true ? true : undefined
    });
    if (options.queueApprovals) {
      report.approvalQueues.push(await queueArtifactLifecycleApprovals({
        report,
        action: "prune",
        actor: options.actor,
        actorRole: normalizeActorRole(options.actorRole, "operator")
      }));
    }
    if (options.queueArchiveApprovals) {
      report.approvalQueues.push(await queueArtifactLifecycleApprovals({
        report,
        action: "archive",
        actor: options.actor,
        actorRole: normalizeActorRole(options.actorRole, "operator")
      }));
    }
    if (options.queueRestoreApprovals) {
      report.approvalQueues.push(await queueArtifactLifecycleApprovals({
        report,
        action: "restore",
        actor: options.actor,
        actorRole: normalizeActorRole(options.actorRole, "operator")
      }));
    }
    console.log(options.json ? JSON.stringify(report, null, 2) : formatArtifactLifecycleReport(report));
  });

program
  .command("backup-report")
  .description("Inspect read-only backup inventory and restore-drill readiness for local enterprise storage")
  .option("-p, --project <dir>", "filter by project directory")
  .option("-l, --limit <number>", "number of recent artifacts, approvals, and queue rows to inspect", "500")
  .option("--json", "print machine-readable backup readiness report")
  .action(async (options: { project?: string; limit: string; json?: boolean }) => {
    const projectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
    const report = await loadBackupRestoreReport({
      projectRootUri,
      limit: parsePositiveInteger(options.limit, 500)
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatBackupRestoreReport(report));
  });

program
  .command("restore-drill")
  .description("Verify archived/restored artifact lineage without mutating storage")
  .option("-p, --project <dir>", "filter by project directory")
  .option("-l, --limit <number>", "number of restored artifact snapshots to inspect", "100")
  .option("--json", "print machine-readable restore verification report")
  .action(async (options: { project?: string; limit: string; json?: boolean }) => {
    const projectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
    const report = await loadRestoreDrillReport({
      projectRootUri,
      limit: parsePositiveInteger(options.limit, 100)
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatRestoreDrillReport(report));
  });

program
  .command("server-readiness")
  .description("Inspect read-only governed server-mode readiness without enabling remote execution")
  .option("-p, --project <dir>", "filter by project directory")
  .option("-l, --limit <number>", "number of registered projects to inspect", "100")
  .option("--json", "print machine-readable server readiness report")
  .action(async (options: { project?: string; limit: string; json?: boolean }) => {
    const projectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
    const report = await loadServerReadinessReport({
      projectRootUri,
      limit: parsePositiveInteger(options.limit, 100)
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatServerReadinessReport(report));
  });

program
  .command("server-projects")
  .description("Preview registered project ids for governed server-mode clients without accepting arbitrary paths")
  .option("-p, --project <dir>", "filter by local project directory")
  .option("-l, --limit <number>", "number of registered projects to inspect", "100")
  .option("--include-roots", "include local filesystem roots for operator diagnostics")
  .option("--json", "print machine-readable registered project report")
  .action(async (options: { project?: string; limit: string; includeRoots?: boolean; json?: boolean }) => {
    const projectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
    const report = await loadServerProjectRegistryReport({
      projectRootUri,
      limit: parsePositiveInteger(options.limit, 100),
      includeRoots: Boolean(options.includeRoots)
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatServerProjectRegistryReport(report));
  });

program
  .command("server-resolve-project")
  .description("Resolve one registered project id for governed server-mode routing without accepting filesystem paths")
  .requiredOption("--project-id <id>", "registered project id from server-projects")
  .option("--include-root", "include the local filesystem root for operator diagnostics")
  .option("--json", "print machine-readable project resolution")
  .action(async (options: { projectId: string; includeRoot?: boolean; json?: boolean }) => {
    const result = await resolveServerProjectReference({
      projectId: options.projectId,
      includeRoot: Boolean(options.includeRoot)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatServerProjectResolution(result));
    if (!result.resolved) process.exitCode = 2;
  });

program
  .command("server-request-preview")
  .description("Preview a governed server-mode workflow request envelope without queueing work")
  .requiredOption("--project-id <id>", "registered project id from server-projects")
  .requiredOption("-w, --workflow <id>", "workflow id to request")
  .requiredOption("-t, --task <text>", "natural-language task")
  .option("--actor <name>", "requesting actor", "local-preview")
  .option("--actor-role <role>", "project role for the request", "operator")
  .option("--idempotency-key <key>", "client-provided idempotency key")
  .option("--json", "print machine-readable request preview")
  .action(async (options: { projectId: string; workflow: string; task: string; actor: string; actorRole: string; idempotencyKey?: string; json?: boolean }) => {
    const report = await loadServerRequestPreview({
      projectId: options.projectId,
      workflowId: options.workflow,
      task: options.task,
      actor: options.actor,
      actorRole: options.actorRole,
      idempotencyKey: options.idempotencyKey
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatServerRequestPreview(report));
    if (report.status === "blocked") process.exitCode = 2;
  });

program
  .command("server-route-preview")
  .description("Resolve a governed server-mode workflow request into an internal route without queueing work")
  .requiredOption("--project-id <id>", "registered project id from server-projects")
  .requiredOption("-w, --workflow <id>", "workflow id to request")
  .requiredOption("-t, --task <text>", "natural-language task")
  .option("--actor <name>", "requesting actor", "local-preview")
  .option("--actor-role <role>", "project role for the request", "operator")
  .option("--idempotency-key <key>", "client-provided idempotency key")
  .option("--json", "print machine-readable route preview")
  .action(async (options: { projectId: string; workflow: string; task: string; actor: string; actorRole: string; idempotencyKey?: string; json?: boolean }) => {
    const report = await loadServerRoutePreview({
      projectId: options.projectId,
      workflowId: options.workflow,
      task: options.task,
      actor: options.actor,
      actorRole: options.actorRole,
      idempotencyKey: options.idempotencyKey
    });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatServerRoutePreview(report));
    if (report.status === "blocked") process.exitCode = 2;
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
      const indexed = await indexProjectForRun({
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

    const report = await loadObservabilityReport(options.run);
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
  .command("learning-report")
  .description("Read-only local learning report from run history, feedback, failures, routing, and eval evidence")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
  .option("--json", "print learning report JSON")
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

    const report = await loadLearningReport({
      projectDir: path.resolve(process.cwd(), options.project),
      limit: parsePositiveInteger(options.limit, 50)
    });

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(formatLearningReport(report));
  });

program
  .command("learning-proposals")
  .description("Generate local learning proposals from the read-only learning report")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--ids <ids>", "comma-separated proposal ids to queue for approval, or all", "all")
  .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
  .option("--write", "write proposal and approval inbox files under .agent-workflow/learning")
  .option("--json", "print learning proposals JSON")
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
    const report = await loadLearningReport({
      projectDir,
      limit: parsePositiveInteger(options.limit, 50)
    });
    const proposalSet = buildLearningProposalSet(report);
    const existingQueue = await readLearningApprovalQueue(projectDir).catch(() => undefined);
    const queue = buildLearningApprovalQueue(proposalSet, parseProposalIds(options.ids), existingQueue);

    if (options.write) {
      await writeLearningProposals(projectDir, proposalSet);
      await writeLearningApprovalQueue(projectDir, queue);
    }

    if (options.json) {
      console.log(JSON.stringify({ ...proposalSet, approvalQueue: queue, mode: options.write ? "write" : "dry-run" }, null, 2));
      return;
    }

    console.log(formatLearningProposalSet(proposalSet));
    console.log("");
    console.log(formatLearningApprovalQueue(queue));
    if (options.write) {
      console.log("");
      console.log("Wrote .agent-workflow/learning/proposals.json");
      console.log("Wrote .agent-workflow/learning/proposals.md");
      console.log("Wrote .agent-workflow/learning/approval-inbox.json");
      console.log("Wrote .agent-workflow/learning/approval-inbox.md");
    } else {
      console.log("");
      console.log("Dry run only. Re-run with --write to create the project-local learning proposal inbox.");
    }
  });

program
  .command("learning-approvals")
  .description("List, approve, or reject project-local learning proposal inbox items")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--approve <ids>", "comma-separated approval ids or proposal ids to approve, or all")
  .option("--reject <ids>", "comma-separated approval ids or proposal ids to reject, or all")
  .option("--reviewer <name>", "reviewer name")
  .option("--note <text>", "decision note")
  .option("--json", "print learning approval queue JSON")
  .action(async (options: { project: string; approve?: string; reject?: string; reviewer?: string; note?: string; json?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const queue = await readLearningApprovalQueue(projectDir);
    const decisionCount = Number(Boolean(options.approve)) + Number(Boolean(options.reject));
    if (decisionCount > 1) {
      console.error("Use either --approve or --reject, not both.");
      process.exitCode = 1;
      return;
    }

    let nextQueue = queue;
    if (options.approve || options.reject) {
      const result = decideLearningApprovals({
        queue,
        ids: parseProposalIds(options.approve ?? options.reject),
        status: options.approve ? "approved" : "rejected",
        reviewer: options.reviewer,
        note: options.note
      });
      nextQueue = result.queue;
      await writeLearningApprovalQueue(projectDir, nextQueue);
      if (result.skippedIds.length) {
        console.error(`Skipped unknown ids: ${result.skippedIds.join(", ")}`);
      }
    }

    if (options.json) {
      console.log(JSON.stringify(nextQueue, null, 2));
      return;
    }

    console.log(formatLearningApprovalQueue(nextQueue));
  });

program
  .command("learning-daemon")
  .description("Run the local learning daemon in observe or propose mode")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--mode <mode>", "daemon mode: observe or propose", "observe")
  .option("--once", "run a single daemon tick and exit")
  .option("-l, --limit <number>", "number of recent project runs to analyze", "50")
  .option("--interval-ms <number>", "watch polling interval in milliseconds", "60000")
  .option("--daemon-id <id>", "stable daemon identity for dashboard visibility")
  .option("--heartbeat-file <path>", "learning daemon heartbeat file path")
  .option("--json", "print final daemon status JSON")
  .action(async (options: { project: string; mode: string; once?: boolean; limit: string; intervalMs: string; daemonId?: string; heartbeatFile?: string; json?: boolean }) => {
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
    const mode = parseLearningDaemonMode(options.mode);
    const limit = parsePositiveInteger(options.limit, 50);
    const intervalMs = parsePositiveInteger(options.intervalMs, 60000);
    if (intervalMs < 1000) {
      console.error("--interval-ms must be >= 1000");
      process.exitCode = 1;
      return;
    }
    const daemonId = normalizeWorkerId(options.daemonId) ?? "learning-daemon";
    const heartbeatFile = path.resolve(process.cwd(), options.heartbeatFile ?? path.join(projectDir, ".agent-workflow", "learning", "daemon-status.json"));
    const startedAt = new Date().toISOString();
    let stop = false;
    let ticks = 0;
    let lastStatus: LearningDaemonHeartbeat | null = null;
    const writeStatus = async (status: LearningDaemonHeartbeat["status"], update?: Awaited<ReturnType<typeof runLearningDaemonTick>>, lastError?: string): Promise<LearningDaemonHeartbeat> => {
      const heartbeat: LearningDaemonHeartbeat = {
        kind: "agentflow_learning_daemon_status",
        pid: process.pid,
        daemonId,
        projectRootUri: projectDir,
        mode,
        status,
        startedAt,
        lastHeartbeatAt: new Date().toISOString(),
        lastReportAt: update?.report.generatedAt ?? lastStatus?.lastReportAt ?? null,
        intervalMs,
        limit,
        ticks,
        proposals: update?.proposalSet.proposals.length ?? lastStatus?.proposals ?? 0,
        inboxItems: update?.approvalQueue.items.length ?? lastStatus?.inboxItems ?? 0,
        lastError,
        command: `agentflow learning-daemon --project ${shellQuote(projectDir)} --mode ${mode} --limit ${limit} --interval-ms ${intervalMs} --daemon-id ${shellQuote(daemonId)}`
      };
      await writeLearningDaemonStatus(projectDir, heartbeat, heartbeatFile);
      lastStatus = heartbeat;
      return heartbeat;
    };

    const runTick = async (): Promise<void> => {
      ticks += 1;
      try {
        const update = await runLearningDaemonTick({ projectDir, mode, limit });
        await writeStatus(stop ? "stopping" : "running", update);
        if (!options.json) {
          console.log(`Learning daemon tick ${ticks}: report=${update.report.runsAnalyzed} run(s), proposals=${update.proposalSet.proposals.length}, inbox=${update.approvalQueue.items.length}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeStatus("failed", undefined, message);
        throw error;
      }
    };

    await writeStatus("starting");
    await runTick();
    if (options.once) {
      const stopped = await writeStatus("stopped");
      if (options.json) console.log(JSON.stringify(stopped, null, 2));
      return;
    }

    const stopDaemon = () => {
      stop = true;
      console.log("Stopping learning daemon after current tick...");
    };
    process.once("SIGINT", stopDaemon);
    process.once("SIGTERM", stopDaemon);
    if (!options.json) {
      console.log(`Learning daemon watching. id=${daemonId} mode=${mode} project=${projectDir} intervalMs=${intervalMs} heartbeat=${heartbeatFile}`);
    }
    while (!stop) {
      await sleep(intervalMs);
      if (!stop) await runTick();
    }
    const stopped = await writeStatus("stopped");
    if (options.json) console.log(JSON.stringify(stopped, null, 2));
  });

program
  .command("learning-daemon-status")
  .description("Show local learning daemon status for a project")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--json", "print daemon status JSON")
  .action(async (options: { project: string; json?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const status = await loadLearningDaemonStatus(projectDir);
    if (options.json) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(formatLearningDaemonStatus(status));
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
  .command("model-improvement-plan")
  .description("Prepare scrubbed eval-case and provider dataset-plan proposals from approved project-local feedback")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--ids <ids>", "comma-separated approved proposal ids or approval ids to include, or all", "all")
  .option("--write", "write plan files into the project")
  .option("--json", "print model-improvement plan JSON")
  .action(async (options: { project: string; ids: string; write?: boolean; json?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const queue = await readTuningApprovalQueue(projectDir);
    const plan = buildModelImprovementPlan(queue, parseProposalIds(options.ids));

    if (options.write) {
      await writeModelImprovementPlan(projectDir, plan);
    }

    if (options.json) {
      console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
      return;
    }

    console.log(formatModelImprovementPlan(plan));
    if (options.write) {
      for (const file of plan.files) {
        console.log(`Wrote ${file.relativePath}`);
      }
    } else {
      console.log("");
      console.log("Dry run only. Re-run with --write to create project-local model-improvement plan files.");
    }
  });

program
  .command("candidate-comparison-plan")
  .description("Prepare opt-in baseline-versus-candidate evaluation suites from a model-improvement plan")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--baseline-provider <provider>", "baseline provider id", "auto")
  .option("--candidate-provider <provider>", "candidate provider id", "auto")
  .option("--baseline-tier <tier>", "fast, standard, or reasoning", "standard")
  .option("--candidate-tier <tier>", "fast, standard, or reasoning", "reasoning")
  .option("--baseline-prompt <text>", "baseline prompt suffix")
  .option("--candidate-prompt <text>", "candidate prompt suffix")
  .option("--write", "write plan and private evaluation suite files into the project")
  .option("--json", "print candidate comparison plan JSON")
  .action(async (options: {
    project: string;
    baselineProvider: string;
    candidateProvider: string;
    baselineTier: string;
    candidateTier: string;
    baselinePrompt?: string;
    candidatePrompt?: string;
    write?: boolean;
    json?: boolean;
  }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const modelPlan = await readModelImprovementPlan(projectDir);
    const baseline: Partial<CandidateVariantPlan> = {
      provider: normalizeProviderRef(options.baselineProvider),
      modelTier: parseModelTierOption(options.baselineTier)
    };
    const candidate: Partial<CandidateVariantPlan> = {
      provider: normalizeProviderRef(options.candidateProvider),
      modelTier: parseModelTierOption(options.candidateTier)
    };
    if (options.baselinePrompt) baseline.promptSuffix = options.baselinePrompt;
    if (options.candidatePrompt) candidate.promptSuffix = options.candidatePrompt;
    const plan = buildCandidateComparisonPlan({ modelPlan, baseline, candidate });

    if (options.write) {
      await writeCandidateComparisonPlan(projectDir, plan);
    }

    if (options.json) {
      console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
      return;
    }

    console.log(formatCandidateComparisonPlan(plan));
    if (options.write) {
      for (const file of plan.files) {
        console.log(`Wrote ${file.relativePath}`);
      }
    } else {
      console.log("");
      console.log("Dry run only. Re-run with --write to create local comparison plan and evaluation suite files.");
    }
  });

program
  .command("promotion-note-plan")
  .description("Prepare reviewed project-local routing-note patch plans from promotable candidate comparisons")
  .requiredOption("-p, --project <dir>", "project directory")
  .option("--suite <ids>", "comma-separated suite ids to include, or all", "all")
  .option("--write", "write review plan files into .agent-workflow/tuning")
  .option("--json", "print promotion note plan JSON")
  .action(async (options: { project: string; suite: string; write?: boolean; json?: boolean }) => {
    const projectDir = path.resolve(process.cwd(), options.project);
    const report = await loadDashboardCandidateComparisonReport({ projectDir });
    const plan = buildPromotionRoutingNotePlan(report, parseProposalIds(options.suite));

    if (options.write) {
      await writePromotionRoutingNotePlan(projectDir, plan);
    }

    if (options.json) {
      console.log(JSON.stringify({ ...plan, mode: options.write ? "write" : "dry-run" }, null, 2));
      return;
    }

    console.log(formatPromotionRoutingNotePlan(plan));
    if (options.write) {
      for (const file of plan.files) {
        console.log(`Wrote ${file.relativePath}`);
      }
    } else {
      console.log("");
      console.log("Dry run only. Re-run with --write to create reviewable promotion note files.");
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
  .option("--worker-id <id>", "stable worker identity for leases and dashboard visibility")
  .option("--lease-seconds <number>", "running task lease duration in seconds", "900")
  .option("-p, --project <dir>", "only claim queued tasks for one project root")
  .option("--all-projects", "use project worker-pool defaults without restricting queue claims to that project")
  .option("--concurrency <number>", "maximum tasks this worker may execute at the same time", "1")
  .option("--heartbeat-file <path>", "worker heartbeat file path", defaultWorkerHeartbeatPath)
  .action(async (options: { limit: string; watch?: boolean; intervalMs: string; workerId?: string; leaseSeconds: string; project?: string; allProjects?: boolean; concurrency: string; heartbeatFile: string }) => {
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

    const configuredProjectRootUri = options.project ? path.resolve(process.cwd(), options.project) : undefined;
    const workerDefaults = configuredProjectRootUri ? await loadProjectWorkerPoolDefaults(configuredProjectRootUri) : {};
    const limit = Number.parseInt(cliOptionValue(options.limit, ["--limit", "-l"], String(workerDefaults.limit ?? 1)), 10);
    if (!Number.isFinite(limit) || limit < 1) {
      console.error("--limit must be a positive integer");
      process.exitCode = 1;
      return;
    }
    const workerId = normalizeWorkerId(cliOptionValue(options.workerId, ["--worker-id"], workerDefaults.workerId));
    const leaseSeconds = Number.parseInt(cliOptionValue(options.leaseSeconds, ["--lease-seconds"], String(workerDefaults.leaseSeconds ?? 900)), 10);
    if (!Number.isFinite(leaseSeconds) || leaseSeconds < 30) {
      console.error("--lease-seconds must be an integer >= 30");
      process.exitCode = 1;
      return;
    }
    const concurrency = parseBoundedPositiveInteger(cliOptionValue(options.concurrency, ["--concurrency"], String(workerDefaults.concurrency ?? 1)), 1, 16);
    const projectScoped = workerDefaults.projectScoped !== false && !options.allProjects;
    const projectRootUri = configuredProjectRootUri && projectScoped ? configuredProjectRootUri : undefined;

    if (!options.watch) {
      const result = await runWorkerOnce(limit, { workerId, leaseSeconds, projectRootUri, concurrency });
      console.log(`Worker ${workerId} claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}.`);
      if (projectRootUri) console.log(`Project scope: ${projectRootUri}`);
      console.log(`Concurrency: ${concurrency}`);
      return;
    }

    const intervalMs = Number.parseInt(cliOptionValue(options.intervalMs, ["--interval-ms"], String(workerDefaults.intervalMs ?? 2000)), 10);
    if (!Number.isFinite(intervalMs) || intervalMs < 250) {
      console.error("--interval-ms must be an integer >= 250");
      process.exitCode = 1;
      return;
    }

    let stop = false;
    let ticks = 0;
    const startedAt = new Date().toISOString();
    const heartbeatFile = path.resolve(process.cwd(), options.heartbeatFile);
    const registryHeartbeatFile = path.join(defaultWorkerHeartbeatDir, `${safeWorkerHeartbeatFileSegment(workerId)}-${process.pid}.json`);
    const writeHeartbeat = async (status: WorkerHeartbeat["status"], tick?: Awaited<ReturnType<typeof runWorkerOnce>>): Promise<void> => {
      if (tick) {
        ticks += 1;
      }
      const heartbeat: WorkerHeartbeat = {
        pid: process.pid,
        workerId,
        projectRootUri: projectRootUri ?? null,
        concurrency,
        startedAt,
        lastHeartbeatAt: new Date().toISOString(),
        limit,
        intervalMs,
        ticks,
        claimed: tick?.claimed ?? 0,
        completed: tick?.completed ?? 0,
        failed: tick?.failed ?? 0,
        status,
        command: `agentflow worker --watch --limit ${limit} --interval-ms ${intervalMs} --worker-id ${workerId} --lease-seconds ${leaseSeconds}${projectRootUri ? ` --project ${shellQuote(projectRootUri)}` : ""} --concurrency ${concurrency}`
      };
      await fs.mkdir(path.dirname(heartbeatFile), { recursive: true });
      await fs.writeFile(heartbeatFile, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
      await fs.mkdir(path.dirname(registryHeartbeatFile), { recursive: true });
      if (registryHeartbeatFile !== heartbeatFile) {
        await fs.writeFile(registryHeartbeatFile, `${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
      }
    };
    const stopWorker = () => {
      stop = true;
      console.log("Stopping worker after current tick...");
    };
    process.once("SIGINT", stopWorker);
    process.once("SIGTERM", stopWorker);

    await writeHeartbeat("starting");
    console.log(`Worker watching. id=${workerId} limit=${limit} concurrency=${concurrency} project=${projectRootUri ?? "all"} intervalMs=${intervalMs} leaseSeconds=${leaseSeconds} heartbeat=${heartbeatFile}`);
    await runWorkerWatch({
      limitPerTick: limit,
      intervalMs,
      workerId,
      leaseSeconds,
      projectRootUri,
      concurrency,
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

program
  .command("recover-leases")
  .description("Requeue running workflow tasks whose worker lease has expired")
  .option("-r, --run <id>", "limit recovery to one workflow run")
  .option("-p, --project <dir>", "limit recovery to one project root")
  .option("--reason <text>", "audit reason", "Expired worker lease recovery requested.")
  .action(async (options: { run?: string; project?: string; reason: string }) => {
    const serviceChecks = await checkServices();
    const missing = serviceChecks.filter((check) => !check.reachable);
    if (missing.length) {
      for (const check of missing) {
        console.error(`MISSING: ${check.endpoint.name} - ${check.message}`);
      }
      process.exitCode = 1;
      return;
    }
    const result = await requeueExpiredWorkflowTaskLeases({
      runId: options.run,
      projectRootUri: options.project ? path.resolve(process.cwd(), options.project) : undefined,
      actor: "cli",
      reason: options.reason
    });
    console.log(`Requeued expired leases: ${result.requeuedTasks} task(s) across ${result.affectedRuns} run(s).`);
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

type LearningReport = {
  kind: "agentflow_learning_report";
  generatedAt: string;
  projectDir: string;
  limit: number;
  autonomyMode: "observe";
  runsAnalyzed: number;
  runStatusCounts: Record<string, number>;
  feedbackCounts: Record<string, number>;
  evaluationRuns: number;
  latestEvaluationAt: string | null;
  failedRuns: Array<{
    runId: string;
    workflowId: string;
    task: string;
    startedAt: string;
  }>;
  repeatedFailurePatterns: Array<{
    workflowId: string;
    stageId: string;
    agentId: string;
    failedTasks: number;
    totalTasks: number;
    failureRate: number;
  }>;
  costOpportunities: Array<{
    workflowId: string;
    stageId: string;
    agentId: string;
    providerId: string;
    modelTier: string;
    runs: number;
    fallbackRate: number;
    averageLatencyMs: number | null;
    recommendation: string;
  }>;
  proposalPreview: {
    total: number;
    highPriority: number;
    byKind: Record<string, number>;
  };
  evalGaps: string[];
  safeAutomaticActions: string[];
  approvalRequiredActions: string[];
  privacyBoundaries: string[];
  nextCommands: string[];
};

type LearningProposalPriority = "high" | "medium" | "low";
type LearningProposalKind = "repeated_failure" | "cost_routing" | "eval_gap" | "feedback_gap" | "proposal_followup";
type LearningRiskLevel = "low" | "medium" | "high";
type LearningApprovalStatus = "pending" | "approved" | "rejected";

type LearningProposalSet = {
  kind: "agentflow_learning_proposals";
  projectRootUri: string;
  generatedAt: string;
  sourceReportGeneratedAt: string;
  sourceRunsAnalyzed: number;
  proposals: LearningProposal[];
  summary: string[];
};

type LearningProposal = {
  id: string;
  priority: LearningProposalPriority;
  kind: LearningProposalKind;
  riskLevel: LearningRiskLevel;
  title: string;
  target: string;
  rationale: string;
  evidence: string[];
  recommendation: string;
  approvalRequired: boolean;
};

type LearningApprovalQueue = {
  kind: "agentflow_learning_approval_queue";
  projectRootUri: string;
  generatedAt: string;
  sourceGeneratedAt: string;
  sourceRunsAnalyzed: number;
  skippedIds: string[];
  items: LearningApprovalItem[];
};

type LearningApprovalItem = {
  id: string;
  proposalId: string;
  status: LearningApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  reviewer?: string;
  note?: string;
  proposal: LearningProposal;
};

type LearningApprovalDecisionResult = {
  queue: LearningApprovalQueue;
  selectedIds: string[];
  skippedIds: string[];
};

type LearningDaemonMode = "observe" | "propose";

type LearningDaemonHeartbeat = {
  kind: "agentflow_learning_daemon_status";
  pid: number;
  daemonId: string;
  projectRootUri: string;
  mode: LearningDaemonMode;
  status: "starting" | "running" | "stopping" | "stopped" | "failed";
  startedAt: string;
  lastHeartbeatAt: string;
  lastReportAt: string | null;
  lastError?: string;
  intervalMs: number;
  limit: number;
  ticks: number;
  proposals: number;
  inboxItems: number;
  command: string;
};

type DashboardLearningDaemonStatus = {
  heartbeatPath: string;
  configured: boolean;
  projectRootUri: string;
  daemonId: string | null;
  mode: LearningDaemonMode | null;
  status: "running" | "stale" | "stopped" | "missing" | "failed";
  pid: number | null;
  processAlive: boolean;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  lastReportAt: string | null;
  ageMs: number | null;
  intervalMs: number | null;
  limit: number | null;
  ticks: number;
  proposals: number;
  inboxItems: number;
  lastError: string;
  command: string;
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

type DashboardActionApproval = Awaited<ReturnType<typeof listActionApprovals>>[number];
type DashboardArtifactLifecycleRow = Awaited<ReturnType<typeof listArtifactLifecycle>>[number];

type DashboardRoleProject = {
  id: string;
  name: string;
  rootUri: string;
  configStatus: "valid" | "missing" | "invalid";
  enforcement: "preview" | "enforce";
  separationOfDuties: "off" | "preview" | "enforce";
  defaultActorRole: string;
  roles: Array<{
    id: string;
    description: string;
    readOnly: boolean;
    capabilities: string[];
  }>;
};

type DashboardRoleDecisionSummary = {
  role: string;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  executed: number;
  failed: number;
  other: number;
};

type DashboardRoleAuditExportSummary = {
  jsonPath: string;
  markdownPath: string | null;
  fileName: string;
  generatedAt: string;
  projectPath: string | null;
  role: string | null;
  status: string;
  actionType: string | null;
  approvalCount: number;
  projectCount: number;
  roleCount: number;
};

type DashboardRoleAuditViewResult =
  | {
    ok: true;
    projectDir: string | null;
    fileName: string;
    markdownPath: string;
    jsonPath: string | null;
    markdown: string;
    summary: DashboardRoleAuditExportSummary | null;
  }
  | { ok: false; error: string; projectDir?: string | null };

type DashboardRoleGovernanceReport = {
  kind: "agentflow_role_governance_report";
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  filters: {
    role: string | null;
    status: string;
    actionType: string | null;
  };
  projects: DashboardRoleProject[];
  statusCounts: Record<string, number>;
  actionCounts: Record<string, number>;
  decisionsByRole: DashboardRoleDecisionSummary[];
  recentApprovals: DashboardActionApproval[];
  recentRoleAuditExports: DashboardRoleAuditExportSummary[];
};

type ArtifactLifecycleReport = {
  kind: "agentflow_artifact_lifecycle_report";
  generatedAt: string;
  projectRootUri: string | null;
  artifactKind: string | null;
  limit: number;
  retentionPolicy: ArtifactLifecyclePolicy;
  prunePlan: ArtifactPrunePlan | null;
  archivePlan: ArtifactLifecycleActionPlan | null;
  restorePlan: ArtifactLifecycleActionPlan | null;
  approvalQueues: ArtifactLifecycleApprovalQueue[];
  totalArtifacts: number;
  estimatedBytes: number;
  byProject: Record<string, number>;
  byKind: Record<string, number>;
  byAgeBucket: Record<string, number>;
  byRunStatus: Record<string, number>;
  reviewHints: string[];
  recentArtifacts: Array<DashboardArtifactLifecycleRow & {
    ageBucket: string;
    lifecycleHint: string;
  }>;
};

type ArtifactLifecycleAction = "prune" | "archive" | "restore";
type ArtifactLifecycleApprovalActionType = "artifact_prune" | "artifact_archive" | "artifact_restore";
type ArtifactLifecycleRequestedActionType = "artifact_prune_requested" | "artifact_archive_requested" | "artifact_restore_requested";

type ArtifactLifecycleApprovalQueue = {
  mode: "approval-request";
  action: ArtifactLifecycleAction;
  generatedAt: string;
  requestedBy: string;
  requestedByRole: string;
  totalRequested: number;
  skipped: string[];
  approvals: Array<{
    approvalId: string;
    status: string;
    artifactUri: string;
    runId: string;
    target: string;
    artifactId: string;
    idempotencyKey: string;
  }>;
};

type ArtifactLifecyclePolicy = {
  source: "project" | "default";
  retentionDays: number;
  minPruneBytes: number;
  retainAuditArtifacts: boolean;
  legalHold: boolean;
  requireApprovalForPrune: boolean;
  allowArchiveExecution: boolean;
  allowRestoreExecution: boolean;
  allowPruneExecution: boolean;
};

type ArtifactPrunePlan = {
  mode: "dry-run";
  generatedAt: string;
  criteria: {
    policySource: "project" | "default" | "override";
    minAgeDays: number;
    minBytes: number;
    includeAudit: boolean;
    legalHold: boolean;
    requireApproval: boolean;
  };
  totalCandidates: number;
  estimatedBytesRecoverable: number;
  approvalRequired: boolean;
  notes: string[];
  candidates: Array<{
    artifactId: string;
    uri: string;
    runId: string;
    taskId: string | null;
    projectName: string;
    projectRootUri: string;
    workflowId: string;
    runStatus: string;
    kind: string;
    contentBytes: number;
    createdAt: string;
    ageDays: number | null;
    reason: string;
    receiptPreview: ArtifactLifecycleReceiptPreview;
  }>;
};

type ArtifactLifecycleActionPlan = {
  mode: "dry-run";
  action: "archive" | "restore";
  generatedAt: string;
  criteria: ArtifactPrunePlan["criteria"];
  totalCandidates: number;
  estimatedBytesRecoverable: number;
  approvalRequired: boolean;
  notes: string[];
  candidates: Array<{
    artifactId: string;
    uri: string;
    runId: string;
    taskId: string | null;
    projectName: string;
    projectRootUri: string;
    workflowId: string;
    runStatus: string;
    kind: string;
    contentBytes: number;
    createdAt: string;
    ageDays: number | null;
    reason: string;
    receiptPreview: ArtifactLifecycleReceiptPreview;
  }>;
};

type ArtifactLifecycleReceiptPreview = {
  actionType: ArtifactLifecycleRequestedActionType;
      target: string;
      summary: string;
      metadata: {
        mode: "dry-run";
        action: ArtifactLifecycleAction;
        artifactId: string;
        runId: string;
        taskId: string | null;
        kind: string;
        contentBytes: number;
        reason: string;
      };
};

type BackupRestoreReport = {
  kind: "agentflow_backup_restore_report";
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  services: Awaited<ReturnType<typeof checkServices>>;
  inventory: {
    projects: number;
    runs: number;
    completedRuns: number;
    failedRuns: number;
    queuedRuns: number;
    runningRuns: number;
    indexedFiles: number;
    indexedTokens: number;
    memoryItems: number;
    artifacts: number;
    estimatedArtifactBytes: number;
    archivedArtifacts: number;
    restoredArtifacts: number;
    byKind: Record<string, { count: number; bytes: number }>;
    byProject: Record<string, { artifacts: number; bytes: number }>;
  };
  restoreDrill: {
    status: "ready" | "attention";
    servicesReachable: boolean;
    projectRegistered: boolean;
    archivedSnapshotsAvailable: boolean;
    restoredSnapshotsAvailable: boolean;
    pendingLifecycleApprovals: number;
    activeQueueItems: number;
    latestArtifactAt: string | null;
    checks: Array<{ label: string; status: "pass" | "warn"; detail: string }>;
  };
  recommendedCommands: string[];
  notes: string[];
};

type RestoreDrillReport = {
  kind: "agentflow_restore_drill_report";
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  status: "pass" | "attention";
  services: Awaited<ReturnType<typeof checkServices>>;
  restoredSnapshotsInspected: number;
  passed: number;
  warnings: number;
  checks: RestoreDrillCheck[];
  recommendedCommands: string[];
  notes: string[];
};

type RestoreDrillCheck = {
  restoredArtifactId: string;
  restoredArtifactUri: string;
  runId: string;
  sourceArchiveUri: string | null;
  originalUri: string | null;
  status: "pass" | "warn";
  contentHashMatches: boolean;
  originalStillPresent: boolean | null;
  detail: string;
};

type ServerReadinessStatus = "local-only" | "ready" | "attention" | "blocked";
type ServerReadinessCheckStatus = "pass" | "warn" | "fail";

type ServerReadinessReport = {
  kind: "agentflow_server_readiness_report";
  generatedAt: string;
  status: ServerReadinessStatus;
  projectRootUri: string | null;
  limit: number;
  mode: {
    enabled: boolean;
    bind: string;
    port: string;
    networkExposed: boolean;
    authMode: string;
    tokenConfigured: boolean;
    allowedOrigins: string[];
  };
  services: Awaited<ReturnType<typeof checkServices>>;
  projects: Array<{
    id: string;
    name: string;
    rootUri: string;
    configStatus: "valid" | "missing" | "invalid";
    roleEnforcement: "preview" | "enforce";
    separationOfDuties: "off" | "preview" | "enforce";
    roles: string[];
  }>;
  endpointClasses: Array<{
    name: string;
    exposure: "read-only" | "mutation";
    requiredControls: string[];
    implemented: boolean;
    ready: boolean;
  }>;
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
  recommendedCommands: string[];
  notes: string[];
};

type ServerProjectRegistryReport = {
  kind: "agentflow_server_project_registry_report";
  generatedAt: string;
  projectRootUri: string | null;
  limit: number;
  includeRoots: boolean;
  services: Awaited<ReturnType<typeof checkServices>>;
  projects: Array<{
    projectId: string;
    name: string;
    rootUri: string | null;
    rootHash: string;
    configStatus: "valid" | "missing" | "invalid";
    defaultWorkflows: string[];
    policyProfile: string;
    roleEnforcement: "preview" | "enforce";
    requestExample: {
      projectId: string;
      workflow: string;
      task: string;
    };
  }>;
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
  notes: string[];
};

type ServerProjectResolution = {
  kind: "agentflow_server_project_resolution";
  generatedAt: string;
  projectId: string;
  resolved: boolean;
  reason: string | null;
  project: null | {
    projectId: string;
    name: string;
    rootUri: string | null;
    rootHash: string;
    configStatus: "valid" | "missing" | "invalid";
    defaultWorkflows: string[];
    policyProfile: string;
    roleEnforcement: "preview" | "enforce";
  };
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
};

type ServerRequestPreviewReport = {
  kind: "agentflow_server_request_preview";
  generatedAt: string;
  status: "ready" | "attention" | "blocked";
  envelope: {
    requestId: string;
    idempotencyKey: string;
    actor: string;
    actorRole: string;
    projectId: string;
    workflow: string;
    task: string;
    policyProfile: string | null;
    source: "server-request-preview";
  };
  controls: {
    serverModeEnabled: boolean;
    authMode: string;
    authConfigured: boolean;
    projectResolved: boolean;
    roleGate: "pass" | "warn" | "fail";
    workflowFound: boolean;
    idempotencyProvided: boolean;
    wouldQueue: false;
  };
  checks: Array<{
    label: string;
    status: ServerReadinessCheckStatus;
    detail: string;
  }>;
  notes: string[];
};

type ServerRoutePreviewReport = {
  kind: "agentflow_server_route_preview";
  generatedAt: string;
  status: "ready" | "attention" | "blocked";
  dryRun: true;
  envelope: ServerRequestPreviewReport["envelope"];
  controls: ServerRequestPreviewReport["controls"];
  route: null | {
    projectId: string;
    projectName: string;
    projectRootUri: string;
    workflowId: string;
    task: string;
    policyProfile: string;
    actor: string;
    actorRole: string;
    idempotencyKey: string;
    commandPreview: string;
  };
  checks: ServerRequestPreviewReport["checks"];
  notes: string[];
};

type ServerQueueReport = {
  kind: "agentflow_server_queue_report";
  generatedAt: string;
  status: "queued" | "ready" | "attention" | "blocked";
  dryRun: boolean;
  envelope: ServerRequestPreviewReport["envelope"];
  route: ServerRoutePreviewReport["route"];
  queuedRun: null | {
    runId: string;
    projectId: string;
    projectRootUri: string;
    workflowId: string;
    tasks: number;
    runUrl: string;
    actorReceiptUri: string | null;
    reused: boolean;
  };
  controls: Omit<ServerRequestPreviewReport["controls"], "wouldQueue"> & {
    authAccepted: boolean;
    executeRequested: boolean;
    queueExecutionEnabled: boolean;
    clientProvidedIdempotency: boolean;
    wouldQueue: boolean;
  };
  checks: ServerRequestPreviewReport["checks"];
  notes: string[];
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

async function loadObservabilityReport(runId: string): Promise<ReturnType<typeof buildObservabilityReport> | null> {
  const details = await getWorkflowRunDetails(runId);
  if (!details.run) {
    return null;
  }

  const artifacts = await listArtifacts({ runId });
  return buildObservabilityReport({
    run: details.run,
    tasks: details.tasks,
    receipts: details.receipts,
    artifacts,
    version: program.version()
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

async function loadRoleGovernanceReport(input: { projectRootUri?: string; limit?: number; role?: string | null; status?: string | null; actionType?: string | null } = {}): Promise<DashboardRoleGovernanceReport> {
  const projectRootUri = input.projectRootUri ? path.resolve(process.cwd(), input.projectRootUri) : null;
  const limit = input.limit ?? 50;
  const roleFilter = input.role?.trim() || null;
  const statusFilter = input.status?.trim() || "all";
  const actionFilter = input.actionType?.trim() || null;
  const [summaries, approvals] = await Promise.all([
    listProjectStorageSummaries(500),
    listActionApprovals({
      projectRootUri: projectRootUri ?? undefined,
      limit
    })
  ]);
  const selectedSummaries = projectRootUri
    ? summaries.filter((summary) => summary.rootUri === projectRootUri)
    : summaries;
  const projects = await Promise.all(selectedSummaries.map(loadDashboardRoleProject));
  const filteredApprovals = approvals.filter((approval) =>
    (statusFilter === "all" || approval.status === statusFilter) &&
    (!actionFilter || approval.actionType === actionFilter) &&
    (!roleFilter || approvalMatchesRoleFilter(approval, roleFilter))
  );
  const recentRoleAuditExports = await listDashboardRoleAuditExports(projectRootUri, 8);
  return {
    kind: "agentflow_role_governance_report",
    generatedAt: new Date().toISOString(),
    projectRootUri,
    limit,
    filters: {
      role: roleFilter,
      status: statusFilter,
      actionType: actionFilter
    },
    projects: projects.sort((a, b) => a.name.localeCompare(b.name)),
    statusCounts: countStrings(filteredApprovals.map((approval) => approval.status)),
    actionCounts: countStrings(filteredApprovals.map((approval) => approval.actionType)),
    decisionsByRole: summarizeApprovalDecisionsByRole(filteredApprovals),
    recentApprovals: filteredApprovals,
    recentRoleAuditExports
  };
}

function approvalMatchesRoleFilter(approval: DashboardActionApproval, role: string): boolean {
  const roles = [
    approval.decidedRole,
    approval.executedRole,
    approval.status === "pending" ? "pending" : null,
    !approval.decidedRole && approval.status !== "pending" ? "unrecorded" : null
  ].filter(Boolean);
  return roles.some((candidate) => candidate === role);
}

async function loadDashboardRoleProject(summary: DashboardProjectSummary): Promise<DashboardRoleProject> {
  let configStatus: DashboardRoleProject["configStatus"] = "missing";
  let config: ProjectConfig | null = null;
  if (await pathExists(path.join(summary.rootUri, ".agent-workflow", "project.yaml"))) {
    try {
      config = await loadProjectConfig(summary.rootUri);
      configStatus = "valid";
    } catch {
      configStatus = "invalid";
    }
  } else {
    try {
      config = projectConfigSchema.parse(summary.config);
      configStatus = "valid";
    } catch {
      config = null;
    }
  }
  return {
    id: summary.id,
    name: summary.name,
    rootUri: summary.rootUri,
    configStatus,
    enforcement: config?.team.enforcement ?? "preview",
    separationOfDuties: config?.team.separation_of_duties.mode ?? "off",
    defaultActorRole: config?.team.default_actor_role ?? "operator",
    roles: Object.entries(config?.team.roles ?? {}).map(([id, role]) => ({
      id,
      description: role.description ?? "",
      readOnly: Boolean(role.read_only),
      capabilities: roleCapabilities(role)
    })).sort((a, b) => a.id.localeCompare(b.id))
  };
}

function roleCapabilities(role: ProjectConfig["team"]["roles"][string]): string[] {
  return [
    ["request approvals", role.can_request_approvals],
    ["approve actions", role.can_approve_actions],
    ["reject actions", role.can_reject_actions],
    ["execute approved actions", role.can_execute_approved_actions],
    ["author workflows", role.can_author_workflows],
    ["read only", role.read_only]
  ].filter((entry): entry is [string, true] => entry[1] === true).map(([label]) => label);
}

function summarizeApprovalDecisionsByRole(approvals: DashboardActionApproval[]): DashboardRoleDecisionSummary[] {
  const byRole = new Map<string, DashboardRoleDecisionSummary>();
  for (const approval of approvals) {
    const role = approval.decidedRole ?? (approval.status === "pending" ? "pending" : "unrecorded");
    const summary = byRole.get(role) ?? {
      role,
      total: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      executed: 0,
      failed: 0,
      other: 0
    };
    summary.total += 1;
    if (approval.status === "pending") summary.pending += 1;
    else if (approval.status === "approved") summary.approved += 1;
    else if (approval.status === "rejected") summary.rejected += 1;
    else if (approval.status === "executed") summary.executed += 1;
    else if (approval.status === "failed") summary.failed += 1;
    else summary.other += 1;
    byRole.set(role, summary);
  }
  return [...byRole.values()].sort((a, b) => b.total - a.total || a.role.localeCompare(b.role));
}

function formatRoleGovernanceReport(report: DashboardRoleGovernanceReport): string {
  const lines = [
    `Role governance (${report.generatedAt})`,
    `Project: ${report.projectRootUri ?? "all registered projects"}`,
    `Recent approvals: ${report.recentApprovals.length}`,
    `Filters: role=${report.filters.role ?? "all"} status=${report.filters.status} action=${report.filters.actionType ?? "all"}`,
    "",
    "Configured roles:"
  ];
  for (const project of report.projects) {
    lines.push(`- ${project.name} [${project.configStatus}]`);
    lines.push(`  ${project.rootUri}`);
    lines.push(`  enforcement=${project.enforcement} separationOfDuties=${project.separationOfDuties} default=${project.defaultActorRole}`);
    for (const role of project.roles) {
      lines.push(`  - ${role.id}: ${role.capabilities.join(", ") || "no capabilities"}${role.description ? ` - ${role.description}` : ""}`);
    }
  }
  lines.push("", "Recent decisions by role:");
  for (const role of report.decisionsByRole) {
    lines.push(`- ${role.role}: total=${role.total} pending=${role.pending} approved=${role.approved} rejected=${role.rejected} executed=${role.executed} failed=${role.failed}`);
  }
  return lines.join("\n");
}

async function writeRoleAuditSnapshot(report: DashboardRoleGovernanceReport, outDir?: string): Promise<{ markdownPath: string; jsonPath: string }> {
  const baseDir = outDir?.trim()
    ? path.resolve(process.cwd(), outDir)
    : path.join(report.projectRootUri ?? rootDir, ".agent-workflow", "exports", "roles");
  await fs.mkdir(baseDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filterSegment = safeFileSegment([
    report.filters.role ?? "all-roles",
    report.filters.status,
    report.filters.actionType ?? "all-actions"
  ].join("-"));
  const markdownPath = path.join(baseDir, `${stamp}-${filterSegment}.md`);
  const jsonPath = path.join(baseDir, `${stamp}-${filterSegment}.json`);
  await fs.writeFile(markdownPath, `${formatRoleAuditSnapshotMarkdown(report)}\n`, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { markdownPath, jsonPath };
}

async function listDashboardRoleAuditExports(projectDir: string | null, limit: number): Promise<DashboardRoleAuditExportSummary[]> {
  const exportDir = path.join(projectDir ?? rootDir, ".agent-workflow", "exports", "roles");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(exportDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const summaries = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const jsonPath = path.join(exportDir, entry.name);
      try {
        const payload = JSON.parse(await fs.readFile(jsonPath, "utf8")) as unknown;
        return roleAuditSummaryFromPayload(jsonPath, payload);
      } catch {
        return null;
      }
    }));
  return summaries
    .filter((summary): summary is DashboardRoleAuditExportSummary => summary !== null)
    .sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt))
    .slice(0, Math.max(0, limit));
}

function roleAuditSummaryFromPayload(jsonPath: string, payload: unknown): DashboardRoleAuditExportSummary | null {
  const record = objectValue(payload);
  if (record.kind !== "agentflow_role_governance_report") return null;
  const filters = objectValue(record.filters);
  const generatedAt = stringValue(record.generatedAt);
  const status = stringValue(filters.status) ?? "all";
  if (!generatedAt) return null;
  const markdownPath = jsonPath.replace(/\.json$/u, ".md");
  const recentApprovals = Array.isArray(record.recentApprovals) ? record.recentApprovals : [];
  const projects = Array.isArray(record.projects) ? record.projects : [];
  const decisionsByRole = Array.isArray(record.decisionsByRole) ? record.decisionsByRole : [];
  return {
    jsonPath,
    markdownPath: fsSync.existsSync(markdownPath) ? markdownPath : null,
    fileName: path.basename(markdownPath),
    generatedAt,
    projectPath: stringValue(record.projectRootUri) ?? null,
    role: stringValue(filters.role) ?? null,
    status,
    actionType: stringValue(filters.actionType) ?? null,
    approvalCount: recentApprovals.length,
    projectCount: projects.length,
    roleCount: decisionsByRole.length
  };
}

async function loadDashboardRoleAuditView(params: URLSearchParams): Promise<DashboardRoleAuditViewResult> {
  const projectInput = params.get("project")?.trim() || "";
  const projectDir = projectInput ? path.resolve(process.cwd(), projectInput) : null;
  const fileInput = params.get("file")?.trim() || "";
  const fileName = path.basename(fileInput);
  if (!fileName || fileName !== fileInput || !fileName.endsWith(".md")) {
    return { ok: false, error: "Missing or invalid role audit file name.", projectDir };
  }
  const exportDir = path.resolve(projectDir ?? rootDir, ".agent-workflow", "exports", "roles");
  const markdownPath = path.resolve(exportDir, fileName);
  if (!isPathInside(markdownPath, exportDir)) {
    return { ok: false, error: "Role audit file must be inside the local role export folder.", projectDir };
  }
  try {
    const markdown = await fs.readFile(markdownPath, "utf8");
    const jsonPath = markdownPath.replace(/\.md$/u, ".json");
    let summary: DashboardRoleAuditExportSummary | null = null;
    if (fsSync.existsSync(jsonPath)) {
      try {
        summary = roleAuditSummaryFromPayload(jsonPath, JSON.parse(await fs.readFile(jsonPath, "utf8")) as unknown);
      } catch {
        summary = null;
      }
    }
    return { ok: true, projectDir, fileName, markdownPath, jsonPath: fsSync.existsSync(jsonPath) ? jsonPath : null, markdown, summary };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: false, error: "Role audit export was not found.", projectDir };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error), projectDir };
  }
}

function formatRoleAuditSnapshotMarkdown(report: DashboardRoleGovernanceReport): string {
  return [
    "# Role Audit Snapshot",
    "",
    `Generated: ${report.generatedAt}`,
    `Project: ${report.projectRootUri ?? "all registered projects"}`,
    `Filters: role=${report.filters.role ?? "all"} status=${report.filters.status} action=${report.filters.actionType ?? "all"}`,
    `Recent approvals: ${report.recentApprovals.length}`,
    "",
    "## Decision Counts",
    "",
    "| Role | Total | Pending | Approved | Rejected | Executed | Failed |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...(report.decisionsByRole.length
      ? report.decisionsByRole.map((role) => `| ${escapeMarkdownTable(role.role)} | ${role.total} | ${role.pending} | ${role.approved} | ${role.rejected} | ${role.executed} | ${role.failed} |`)
      : ["| none | 0 | 0 | 0 | 0 | 0 | 0 |"]),
    "",
    "## Configured Roles",
    "",
    ...report.projects.flatMap((project) => [
      `### ${project.name}`,
      "",
      `Root: \`${project.rootUri}\``,
      `Config: ${project.configStatus}`,
      `Enforcement: ${project.enforcement}`,
      `Separation of duties: ${project.separationOfDuties}`,
      "",
      "| Role | Capabilities | Description |",
      "| --- | --- | --- |",
      ...(project.roles.length
        ? project.roles.map((role) => `| ${escapeMarkdownTable(role.id)} | ${escapeMarkdownTable(role.capabilities.join(", ") || "none")} | ${escapeMarkdownTable(role.description || "")} |`)
        : ["| none | none | No roles configured. |"]),
      ""
    ]),
    "## Recent Approval Activity",
    "",
    "| Status | Action | Decision Role | Execution Role | Project | Updated |",
    "| --- | --- | --- | --- | --- | --- |",
    ...(report.recentApprovals.length
      ? report.recentApprovals.map((approval) => `| ${escapeMarkdownTable(approval.status)} | ${escapeMarkdownTable(approval.actionType)} | ${escapeMarkdownTable(approval.decidedRole ?? "none")} | ${escapeMarkdownTable(approval.executedRole ?? "none")} | ${escapeMarkdownTable(approval.projectName)} | ${escapeMarkdownTable(approval.updatedAt)} |`)
      : ["| none | none | none | none | none | none |"])
  ].join("\n");
}

function escapeMarkdownTable(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

async function loadArtifactLifecycleReport(input: { projectRootUri?: string; kind?: string; limit?: number; prunePlan?: boolean; archivePlan?: boolean; restorePlan?: boolean; minAgeDays?: number; minBytes?: number; includeAudit?: boolean } = {}): Promise<ArtifactLifecycleReport> {
  const projectRootUri = input.projectRootUri ? path.resolve(process.cwd(), input.projectRootUri) : null;
  const artifactKind = input.kind?.trim() || null;
  const limit = input.limit ?? 500;
  const retentionPolicy = await resolveArtifactLifecyclePolicy(projectRootUri);
  const artifacts = await listArtifactLifecycle({
    projectRootUri: projectRootUri ?? undefined,
    kind: artifactKind ?? undefined,
    limit
  });
  const recentArtifacts = artifacts.map((artifact) => {
    const ageBucket = artifactAgeBucket(artifact.createdAt);
    return {
      ...artifact,
      ageBucket,
      lifecycleHint: artifactLifecycleHint(artifact, ageBucket)
    };
  });
  const estimatedBytes = recentArtifacts.reduce((sum, artifact) => sum + artifact.contentBytes + artifact.uri.length, 0);
  const reviewHints = buildArtifactLifecycleHints(recentArtifacts, estimatedBytes, limit);
  const policySource = input.minAgeDays !== undefined || input.minBytes !== undefined || input.includeAudit !== undefined ? "override" : retentionPolicy.source;
  const prunePlan = input.prunePlan
    ? buildArtifactPrunePlan(recentArtifacts, {
      policySource,
      minAgeDays: input.minAgeDays ?? retentionPolicy.retentionDays,
      minBytes: input.minBytes ?? retentionPolicy.minPruneBytes,
      includeAudit: input.includeAudit ?? !retentionPolicy.retainAuditArtifacts,
      legalHold: retentionPolicy.legalHold,
      requireApproval: retentionPolicy.requireApprovalForPrune
    })
    : null;
  const archivePlan = input.archivePlan
    ? buildArtifactArchivePlan(recentArtifacts, prunePlan?.criteria ?? {
      policySource,
      minAgeDays: input.minAgeDays ?? retentionPolicy.retentionDays,
      minBytes: input.minBytes ?? retentionPolicy.minPruneBytes,
      includeAudit: input.includeAudit ?? !retentionPolicy.retainAuditArtifacts,
      legalHold: retentionPolicy.legalHold,
      requireApproval: retentionPolicy.requireApprovalForPrune
    })
    : null;
  const restorePlan = input.restorePlan
    ? await buildArtifactRestorePlan(recentArtifacts, prunePlan?.criteria ?? archivePlan?.criteria ?? {
      policySource,
      minAgeDays: input.minAgeDays ?? retentionPolicy.retentionDays,
      minBytes: input.minBytes ?? retentionPolicy.minPruneBytes,
      includeAudit: true,
      legalHold: retentionPolicy.legalHold,
      requireApproval: retentionPolicy.requireApprovalForPrune
    })
    : null;
  return {
    kind: "agentflow_artifact_lifecycle_report",
    generatedAt: new Date().toISOString(),
    projectRootUri,
    artifactKind,
    limit,
    retentionPolicy,
    prunePlan,
    archivePlan,
    restorePlan,
    approvalQueues: [],
    totalArtifacts: recentArtifacts.length,
    estimatedBytes,
    byProject: countStrings(recentArtifacts.map((artifact) => artifact.projectName)),
    byKind: countStrings(recentArtifacts.map((artifact) => artifact.kind)),
    byAgeBucket: countStrings(recentArtifacts.map((artifact) => artifact.ageBucket)),
    byRunStatus: countStrings(recentArtifacts.map((artifact) => artifact.runStatus)),
    reviewHints,
    recentArtifacts
  };
}

async function resolveArtifactLifecyclePolicy(projectRootUri: string | null): Promise<ArtifactLifecyclePolicy> {
  const fallback: ArtifactLifecyclePolicy = {
    source: "default",
    retentionDays: 30,
    minPruneBytes: 20_000,
    retainAuditArtifacts: true,
    legalHold: false,
    requireApprovalForPrune: true,
    allowArchiveExecution: false,
    allowRestoreExecution: false,
    allowPruneExecution: false
  };
  if (!projectRootUri || !await pathExists(path.join(projectRootUri, ".agent-workflow", "project.yaml"))) {
    return fallback;
  }
  try {
    const project = await loadProjectConfig(projectRootUri);
    return lifecyclePolicyFromProject(project, "project");
  } catch {
    return fallback;
  }
}

async function queueArtifactLifecycleApprovals(input: {
  report: ArtifactLifecycleReport;
  action: ArtifactLifecycleAction;
  actor: string;
  actorRole: string;
}): Promise<ArtifactLifecycleApprovalQueue> {
  const projectRootUri = input.report.projectRootUri;
  if (!projectRootUri) {
    return {
      mode: "approval-request",
      action: input.action,
      generatedAt: new Date().toISOString(),
      requestedBy: input.actor,
      requestedByRole: input.actorRole,
      totalRequested: 0,
      skipped: ["A project is required before lifecycle approvals can be queued."],
      approvals: []
    };
  }
  const plan = artifactLifecyclePlanForAction(input.report, input.action);
  if (!plan) {
    return {
      mode: "approval-request",
      action: input.action,
      generatedAt: new Date().toISOString(),
      requestedBy: input.actor,
      requestedByRole: input.actorRole,
      totalRequested: 0,
      skipped: [`A dry-run ${input.action} plan is required before lifecycle approvals can be queued.`],
      approvals: []
    };
  }
  if (input.report.retentionPolicy.legalHold) {
    return {
      mode: "approval-request",
      action: input.action,
      generatedAt: new Date().toISOString(),
      requestedBy: input.actor,
      requestedByRole: input.actorRole,
      totalRequested: 0,
      skipped: ["Project legal hold is enabled; lifecycle approval requests were not queued."],
      approvals: []
    };
  }

  const project = await loadProjectConfig(projectRootUri);
  const requestRoleGate = evaluateRoleGate(project, input.actorRole, "can_request_approvals");
  if (!requestRoleGate.allowed) {
    return {
      mode: "approval-request",
      action: input.action,
      generatedAt: new Date().toISOString(),
      requestedBy: input.actor,
      requestedByRole: input.actorRole,
      totalRequested: 0,
      skipped: [requestRoleGate.message],
      approvals: []
    };
  }

  const agents = await loadAgentRecords(rootDir);
  const workflows = await loadWorkflowRecords(rootDir);
  await seedRegistry(agents, workflows);

  const approvals: ArtifactLifecycleApprovalQueue["approvals"] = [];
  const approvalActionType = artifactLifecycleApprovalActionType(input.action);
  for (const candidate of plan.candidates) {
    const idempotencyKey = stableHash({
      actionType: approvalActionType,
      artifactId: candidate.artifactId,
      uri: candidate.uri,
      runId: candidate.runId,
      projectRootUri,
      criteria: plan.criteria
    });
    const approval = await requestActionApproval({
      runId: candidate.runId,
      taskId: candidate.taskId,
      stageId: "artifact-lifecycle",
      agentId: "workflow-orchestrator",
      actionType: approvalActionType,
      target: candidate.uri,
      rationale: `Artifact lifecycle ${input.action} approval requested for ${candidate.artifactId}: ${candidate.reason}`,
      policyDecision: {
        approvalRequired: plan.approvalRequired,
        policySource: plan.criteria.policySource,
        retentionPolicy: input.report.retentionPolicy,
        criteria: plan.criteria,
        roleGate: requestRoleGate.message,
        destructiveCapabilityEnabled: lifecycleExecutionCapabilityEnabled(input.report.retentionPolicy, input.action),
        destructiveExecutionAvailable: false
      },
      payload: {
        ...candidate.receiptPreview.metadata,
        target: candidate.receiptPreview.target,
        summary: candidate.receiptPreview.summary,
        projectRootUri,
        requestedBy: input.actor,
        requestedByRole: input.actorRole,
        queuedAt: new Date().toISOString()
      },
      idempotencyKey
    });
    approvals.push({
      approvalId: approval.approvalId,
      status: approval.status,
      artifactUri: approval.artifactUri,
      runId: candidate.runId,
      target: candidate.uri,
      artifactId: candidate.artifactId,
      idempotencyKey
    });
  }

  return {
    mode: "approval-request",
    action: input.action,
    generatedAt: new Date().toISOString(),
    requestedBy: input.actor,
    requestedByRole: input.actorRole,
    totalRequested: approvals.length,
    skipped: approvals.length ? [] : [`No ${input.action} candidates were available to queue.`],
    approvals
  };
}

function artifactLifecyclePlanForAction(report: ArtifactLifecycleReport, action: ArtifactLifecycleAction): ArtifactPrunePlan | ArtifactLifecycleActionPlan | null {
  if (action === "prune") return report.prunePlan;
  if (action === "archive") return report.archivePlan;
  return report.restorePlan;
}

function artifactLifecycleApprovalActionType(action: ArtifactLifecycleAction): ArtifactLifecycleApprovalActionType {
  if (action === "archive") return "artifact_archive";
  if (action === "restore") return "artifact_restore";
  return "artifact_prune";
}

function formatArtifactLifecycleReport(report: ArtifactLifecycleReport): string {
  const lines = [
    `Artifact lifecycle (${report.generatedAt})`,
    `Project: ${report.projectRootUri ?? "all registered projects"}`,
    `Kind: ${report.artifactKind ?? "all"}`,
    `Artifacts inspected: ${report.totalArtifacts}`,
    `Estimated JSON storage: ${formatBytes(report.estimatedBytes)}`,
    "",
    "Retention policy:",
    `- Source: ${report.retentionPolicy.source}`,
    `- Retention days: ${report.retentionPolicy.retentionDays}`,
    `- Minimum prune bytes: ${report.retentionPolicy.minPruneBytes}`,
    `- Retain audit artifacts: ${report.retentionPolicy.retainAuditArtifacts}`,
    `- Legal hold: ${report.retentionPolicy.legalHold}`,
    `- Approval required: ${report.retentionPolicy.requireApprovalForPrune}`,
    `- Archive execution enabled: ${report.retentionPolicy.allowArchiveExecution}`,
    `- Restore execution enabled: ${report.retentionPolicy.allowRestoreExecution}`,
    `- Prune execution enabled: ${report.retentionPolicy.allowPruneExecution}`,
    "",
    `By kind: ${formatInlineCounts(report.byKind) || "none"}`,
    `By age: ${formatInlineCounts(report.byAgeBucket) || "none"}`,
    `By run status: ${formatInlineCounts(report.byRunStatus) || "none"}`,
    "",
    "Review hints:",
    ...(report.reviewHints.length ? report.reviewHints.map((hint) => `- ${hint}`) : ["- No lifecycle concerns found in the inspected artifact window."]),
    ...(report.prunePlan ? [
      "",
      "Dry-run prune plan:",
      `- Candidates: ${report.prunePlan.totalCandidates}`,
      `- Estimated recoverable: ${formatBytes(report.prunePlan.estimatedBytesRecoverable)}`,
      `- Criteria: source=${report.prunePlan.criteria.policySource} minAgeDays=${report.prunePlan.criteria.minAgeDays} minBytes=${report.prunePlan.criteria.minBytes} includeAudit=${report.prunePlan.criteria.includeAudit} legalHold=${report.prunePlan.criteria.legalHold} requireApproval=${report.prunePlan.criteria.requireApproval}`,
      ...report.prunePlan.notes.map((note) => `- ${note}`),
      ...report.prunePlan.candidates.slice(0, 20).map((candidate) => `- ${candidate.artifactId} ${candidate.uri} (${formatBytes(candidate.contentBytes)}): ${candidate.reason} [receipt=${candidate.receiptPreview.actionType}]`)
    ] : []),
    ...(report.archivePlan ? formatArtifactLifecycleActionPlan(report.archivePlan) : []),
    ...(report.restorePlan ? formatArtifactLifecycleActionPlan(report.restorePlan) : []),
    ...report.approvalQueues.flatMap((queue) => [
      "",
      `Lifecycle ${queue.action} approval queue:`,
      `- Requested: ${queue.totalRequested}`,
      `- Requested by: ${queue.requestedBy} (${queue.requestedByRole})`,
      ...queue.skipped.map((item) => `- Skipped: ${item}`),
      ...queue.approvals.slice(0, 20).map((approval) => `- ${approval.approvalId} ${approval.status} ${approval.target}`)
    ]),
    "",
    "Recent artifacts:",
    ...report.recentArtifacts.slice(0, 20).map((artifact) => `- ${artifact.kind} ${artifact.uri} (${artifact.ageBucket}, ${formatBytes(artifact.contentBytes)}, ${artifact.lifecycleHint})`)
  ];
  return lines.join("\n");
}

async function loadBackupRestoreReport(input: {
  projectRootUri?: string;
  limit: number;
}): Promise<BackupRestoreReport> {
  const projectRootUri = input.projectRootUri?.trim() || undefined;
  const services = await checkServices();
  const servicesReachable = services.every((service) => service.reachable);
  if (!servicesReachable) {
    return emptyBackupRestoreReport({
      projectRootUri,
      limit: input.limit,
      services,
      note: "Enterprise services are not all reachable. Start local services before collecting a complete backup inventory."
    });
  }

  const [allProjects, artifacts, approvals, queue] = await Promise.all([
    listProjectStorageSummaries(500),
    listArtifactLifecycle({ projectRootUri, limit: input.limit }),
    listActionApprovals({ projectRootUri, limit: input.limit }),
    listWorkflowQueue(Math.min(input.limit, 500), { projectRootUri })
  ]);
  const projects = projectRootUri ? allProjects.filter((project) => project.rootUri === projectRootUri) : allProjects;
  const byKind: BackupRestoreReport["inventory"]["byKind"] = {};
  const byProject: BackupRestoreReport["inventory"]["byProject"] = {};
  for (const artifact of artifacts) {
    const kind = byKind[artifact.kind] ?? { count: 0, bytes: 0 };
    kind.count += 1;
    kind.bytes += artifact.contentBytes;
    byKind[artifact.kind] = kind;

    const project = byProject[artifact.projectName] ?? { artifacts: 0, bytes: 0 };
    project.artifacts += 1;
    project.bytes += artifact.contentBytes;
    byProject[artifact.projectName] = project;
  }

  const lifecycleApprovals = approvals.filter((approval) => approval.actionType.startsWith("artifact_"));
  const pendingLifecycleApprovals = lifecycleApprovals.filter((approval) => approval.status === "pending" || approval.status === "approved" || approval.status === "failed").length;
  const activeQueueItems = queue.filter((item) => item.queuedTasks > 0 || item.runningTasks > 0 || item.failedTasks > 0).length;
  const archivedArtifacts = artifacts.filter((artifact) => artifact.kind === "archived_artifact").length;
  const restoredArtifacts = artifacts.filter((artifact) => artifact.kind === "restored_artifact").length;
  const projectRegistered = projectRootUri ? projects.some((project) => project.rootUri === projectRootUri) : projects.length > 0;
  const checks = [
    {
      label: "Enterprise services",
      status: servicesReachable ? "pass" as const : "warn" as const,
      detail: servicesReachable ? "Postgres, Redis, and object storage endpoints are reachable." : "One or more enterprise services are unreachable."
    },
    {
      label: "Project registration",
      status: projectRegistered ? "pass" as const : "warn" as const,
      detail: projectRootUri ? (projectRegistered ? "Selected project is registered in local storage." : "Selected project is not registered yet.") : `${projects.length} project(s) are registered.`
    },
    {
      label: "Backup inventory",
      status: artifacts.length ? "pass" as const : "warn" as const,
      detail: artifacts.length ? `${artifacts.length} recent artifact(s) are visible for backup planning.` : "No artifacts were found in the inspected window."
    },
    {
      label: "Restore drill source",
      status: archivedArtifacts ? "pass" as const : "warn" as const,
      detail: archivedArtifacts ? `${archivedArtifacts} archived artifact snapshot(s) can be used for restore drills.` : "No archived artifact snapshots are available yet."
    },
    {
      label: "Operational blockers",
      status: pendingLifecycleApprovals || activeQueueItems ? "warn" as const : "pass" as const,
      detail: `${pendingLifecycleApprovals} pending/approved lifecycle approval(s); ${activeQueueItems} active queue item(s).`
    }
  ];
  const status = checks.every((check) => check.status === "pass") ? "ready" : "attention";
  return {
    kind: "agentflow_backup_restore_report",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectRootUri ?? null,
    limit: input.limit,
    services,
    inventory: {
      projects: projects.length,
      runs: projects.reduce((sum, project) => sum + project.runCount, 0),
      completedRuns: projects.reduce((sum, project) => sum + project.completedRuns, 0),
      failedRuns: projects.reduce((sum, project) => sum + project.failedRuns, 0),
      queuedRuns: projects.reduce((sum, project) => sum + project.queuedRuns, 0),
      runningRuns: projects.reduce((sum, project) => sum + project.runningRuns, 0),
      indexedFiles: projects.reduce((sum, project) => sum + project.indexedFiles, 0),
      indexedTokens: projects.reduce((sum, project) => sum + project.indexedTokens, 0),
      memoryItems: projects.reduce((sum, project) => sum + project.memoryItems, 0),
      artifacts: artifacts.length,
      estimatedArtifactBytes: artifacts.reduce((sum, artifact) => sum + artifact.contentBytes + artifact.uri.length, 0),
      archivedArtifacts,
      restoredArtifacts,
      byKind,
      byProject
    },
    restoreDrill: {
      status,
      servicesReachable,
      projectRegistered,
      archivedSnapshotsAvailable: archivedArtifacts > 0,
      restoredSnapshotsAvailable: restoredArtifacts > 0,
      pendingLifecycleApprovals,
      activeQueueItems,
      latestArtifactAt: artifacts[0]?.createdAt ?? null,
      checks
    },
    recommendedCommands: backupRestoreCommands(projectRootUri),
    notes: backupRestoreNotes({ status, projectRootUri, projectRegistered, archivedArtifacts, restoredArtifacts, pendingLifecycleApprovals, activeQueueItems })
  };
}

function emptyBackupRestoreReport(input: {
  projectRootUri?: string;
  limit: number;
  services: Awaited<ReturnType<typeof checkServices>>;
  note: string;
}): BackupRestoreReport {
  return {
    kind: "agentflow_backup_restore_report",
    generatedAt: new Date().toISOString(),
    projectRootUri: input.projectRootUri ?? null,
    limit: input.limit,
    services: input.services,
    inventory: {
      projects: 0,
      runs: 0,
      completedRuns: 0,
      failedRuns: 0,
      queuedRuns: 0,
      runningRuns: 0,
      indexedFiles: 0,
      indexedTokens: 0,
      memoryItems: 0,
      artifacts: 0,
      estimatedArtifactBytes: 0,
      archivedArtifacts: 0,
      restoredArtifacts: 0,
      byKind: {},
      byProject: {}
    },
    restoreDrill: {
      status: "attention",
      servicesReachable: false,
      projectRegistered: false,
      archivedSnapshotsAvailable: false,
      restoredSnapshotsAvailable: false,
      pendingLifecycleApprovals: 0,
      activeQueueItems: 0,
      latestArtifactAt: null,
      checks: input.services.map((service) => ({
        label: service.endpoint.name,
        status: service.reachable ? "pass" as const : "warn" as const,
        detail: service.message
      }))
    },
    recommendedCommands: backupRestoreCommands(input.projectRootUri),
    notes: [input.note]
  };
}

function formatBackupRestoreReport(report: BackupRestoreReport): string {
  return [
    `Backup and restore readiness (${report.generatedAt})`,
    `Project: ${report.projectRootUri ?? "all registered projects"}`,
    `Status: ${report.restoreDrill.status}`,
    "",
    "Services:",
    ...report.services.map((service) => `- ${service.endpoint.name}: ${service.reachable ? "OK" : "MISSING"} (${service.message})`),
    "",
    "Inventory:",
    `- Projects: ${report.inventory.projects}`,
    `- Runs: ${report.inventory.runs} (${report.inventory.completedRuns} completed, ${report.inventory.failedRuns} failed, ${report.inventory.queuedRuns + report.inventory.runningRuns} active)`,
    `- Context: ${report.inventory.indexedFiles} indexed files, ${report.inventory.indexedTokens} estimated tokens, ${report.inventory.memoryItems} memory items`,
    `- Artifacts: ${report.inventory.artifacts} inspected, ${formatBytes(report.inventory.estimatedArtifactBytes)} estimated JSON payload`,
    `- Archive snapshots: ${report.inventory.archivedArtifacts}`,
    `- Restore snapshots: ${report.inventory.restoredArtifacts}`,
    `- Artifact kinds: ${formatBackupKindCounts(report.inventory.byKind) || "none"}`,
    "",
    "Restore drill checks:",
    ...report.restoreDrill.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
    "",
    "Recommended commands:",
    ...report.recommendedCommands.map((command) => `- ${command}`),
    "",
    "Notes:",
    ...(report.notes.length ? report.notes.map((note) => `- ${note}`) : ["- No backup or restore drill concerns found in the inspected window."])
  ].join("\n");
}

function backupRestoreCommands(projectRootUri?: string): string[] {
  const projectArg = projectRootUri ? ` --project ${shellQuote(projectRootUri)}` : "";
  return [
    `agentflow backup-report${projectArg} --json`,
    `agentflow artifact-lifecycle${projectArg} --archive-plan`,
    `agentflow artifact-lifecycle${projectArg} --restore-plan`,
    `agentflow approvals${projectArg} --status all`
  ];
}

function backupRestoreNotes(input: {
  status: "ready" | "attention";
  projectRootUri?: string;
  projectRegistered: boolean;
  archivedArtifacts: number;
  restoredArtifacts: number;
  pendingLifecycleApprovals: number;
  activeQueueItems: number;
}): string[] {
  const notes: string[] = [];
  if (input.projectRootUri && !input.projectRegistered) {
    notes.push("Run project onboarding or index the project before relying on project-scoped backup inventory.");
  }
  if (!input.archivedArtifacts) {
    notes.push("Run an archive-plan and approved archive execution to create a copied snapshot before restore-drill validation.");
  }
  if (!input.restoredArtifacts) {
    notes.push("Run a restore-plan from an archived snapshot to prove restore lineage without overwriting existing artifacts.");
  }
  if (input.pendingLifecycleApprovals) {
    notes.push("Resolve pending, approved, or failed lifecycle approvals before treating backup posture as clean.");
  }
  if (input.activeQueueItems) {
    notes.push("Clear queued, running, or failed workflow stages before taking a backup intended for handoff.");
  }
  if (!notes.length && input.status === "ready") {
    notes.push("Read-only backup inventory and restore-drill evidence are present for the inspected scope.");
  }
  return notes;
}

function formatBackupKindCounts(counts: BackupRestoreReport["inventory"]["byKind"]): string {
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, value]) => `${kind}=${value.count}/${formatBytes(value.bytes)}`)
    .join(", ");
}

async function loadRestoreDrillReport(input: {
  projectRootUri?: string;
  limit: number;
}): Promise<RestoreDrillReport> {
  const projectRootUri = input.projectRootUri?.trim() || undefined;
  const services = await checkServices();
  const servicesReachable = services.every((service) => service.reachable);
  if (!servicesReachable) {
    return {
      kind: "agentflow_restore_drill_report",
      generatedAt: new Date().toISOString(),
      projectRootUri: projectRootUri ?? null,
      limit: input.limit,
      status: "attention",
      services,
      restoredSnapshotsInspected: 0,
      passed: 0,
      warnings: services.filter((service) => !service.reachable).length,
      checks: [],
      recommendedCommands: restoreDrillCommands(projectRootUri),
      notes: ["Enterprise services are not all reachable. Start local services before running restore verification."]
    };
  }

  const restoredRows = await listArtifactLifecycle({ projectRootUri, kind: "restored_artifact", limit: input.limit });
  const checks: RestoreDrillCheck[] = [];
  for (const row of restoredRows) {
    const restoredArtifact = await getArtifactByUri(row.uri);
    const restoreSource = restoredArtifact ? objectFromRecord(restoredArtifact.content, "restoreSource") : {};
    const restoreMetadata = restoredArtifact ? objectFromRecord(restoredArtifact.content, "restoreMetadata") : {};
    const sourceArchiveUri = stringFromRecord(restoreSource, "archivedArtifactUri");
    const originalUri = stringFromRecord(restoreMetadata, "originalUri") || stringFromRecord(restoredArtifact?.content ?? {}, "restoredTargetUri");
    const archivedArtifact = sourceArchiveUri ? await getArtifactByUri(sourceArchiveUri) : null;
    const originalArtifact = originalUri ? await getArtifactByUri(originalUri) : null;
    const restoredContent = restoredArtifact?.content.restoredContent;
    const archivedContent = archivedArtifact?.content.archivedContent;
    const contentHashMatches = restoredContent !== undefined && archivedContent !== undefined && stableHash(restoredContent) === stableHash(archivedContent);
    const missing = [
      restoredArtifact ? "" : "restored artifact row missing",
      sourceArchiveUri ? "" : "source archive URI missing",
      archivedArtifact ? "" : "source archive artifact missing",
      originalUri ? "" : "original URI missing",
      contentHashMatches ? "" : "restored content hash does not match archived content"
    ].filter(Boolean);
    checks.push({
      restoredArtifactId: row.id,
      restoredArtifactUri: row.uri,
      runId: row.runId,
      sourceArchiveUri: sourceArchiveUri ?? null,
      originalUri: originalUri ?? null,
      status: missing.length ? "warn" : "pass",
      contentHashMatches,
      originalStillPresent: originalUri ? Boolean(originalArtifact) : null,
      detail: missing.length ? missing.join("; ") : "Restore lineage and copied content hash verified."
    });
  }

  const warnings = checks.filter((check) => check.status === "warn").length;
  const notes = [
    restoredRows.length ? "" : "No restored_artifact snapshots were found. Run archive and restore approvals first, then rerun restore-drill.",
    warnings ? "One or more restored snapshots need review before treating restore evidence as verified." : "",
    restoredRows.length && !warnings ? "Restore drill passed for the inspected restored artifact snapshots." : ""
  ].filter(Boolean);
  return {
    kind: "agentflow_restore_drill_report",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectRootUri ?? null,
    limit: input.limit,
    status: restoredRows.length > 0 && warnings === 0 ? "pass" : "attention",
    services,
    restoredSnapshotsInspected: restoredRows.length,
    passed: checks.filter((check) => check.status === "pass").length,
    warnings,
    checks,
    recommendedCommands: restoreDrillCommands(projectRootUri),
    notes
  };
}

function formatRestoreDrillReport(report: RestoreDrillReport): string {
  return [
    `Restore drill (${report.generatedAt})`,
    `Project: ${report.projectRootUri ?? "all registered projects"}`,
    `Status: ${report.status}`,
    `Restored snapshots inspected: ${report.restoredSnapshotsInspected}`,
    `Passed: ${report.passed}`,
    `Warnings: ${report.warnings}`,
    "",
    "Services:",
    ...report.services.map((service) => `- ${service.endpoint.name}: ${service.reachable ? "OK" : "MISSING"} (${service.message})`),
    "",
    "Lineage checks:",
    ...(report.checks.length ? report.checks.map((check) => [
      `- ${check.status.toUpperCase()} ${check.restoredArtifactId}`,
      `  restored: ${check.restoredArtifactUri}`,
      `  archive: ${check.sourceArchiveUri ?? "missing"}`,
      `  original: ${check.originalUri ?? "missing"}${check.originalStillPresent === null ? "" : ` (${check.originalStillPresent ? "present" : "not present"})`}`,
      `  content hash: ${check.contentHashMatches ? "match" : "mismatch"}`,
      `  detail: ${check.detail}`
    ].join("\n")) : ["- No restored artifact snapshots found."]),
    "",
    "Recommended commands:",
    ...report.recommendedCommands.map((command) => `- ${command}`),
    "",
    "Notes:",
    ...(report.notes.length ? report.notes.map((note) => `- ${note}`) : ["- No restore drill notes."])
  ].join("\n");
}

function restoreDrillCommands(projectRootUri?: string): string[] {
  const projectArg = projectRootUri ? ` --project ${shellQuote(projectRootUri)}` : "";
  return [
    `agentflow restore-drill${projectArg} --json`,
    `agentflow backup-report${projectArg}`,
    `agentflow artifact-lifecycle${projectArg} --restore-plan`
  ];
}

async function loadServerReadinessReport(input: {
  projectRootUri?: string;
  limit: number;
}): Promise<ServerReadinessReport> {
  const projectRootUri = input.projectRootUri?.trim() ? path.resolve(process.cwd(), input.projectRootUri) : undefined;
  const enabled = envFlag("AGENTFLOW_SERVER_MODE");
  const bind = process.env.AGENTFLOW_SERVER_BIND?.trim() || "127.0.0.1";
  const port = process.env.AGENTFLOW_SERVER_PORT?.trim() || "17888";
  const authMode = process.env.AGENTFLOW_SERVER_AUTH?.trim() || "none";
  const tokenConfigured = Boolean(process.env.AGENTFLOW_SERVER_TOKEN?.trim());
  const allowedOrigins = parseEnvList(process.env.AGENTFLOW_SERVER_ALLOWED_ORIGINS);
  const networkExposed = !isLoopbackBind(bind);
  const services = await checkServices();
  const servicesReachable = services.every((service) => service.reachable);
  const summaries = servicesReachable
    ? (await listProjectStorageSummaries(input.limit)).filter((summary) => !projectRootUri || summary.rootUri === projectRootUri)
    : [];
  const projects = await Promise.all(summaries.map(loadServerReadinessProject));
  const roleEnforcementReady = projects.length > 0 && projects.every((project) => project.configStatus === "valid" && project.roleEnforcement === "enforce");
  const projectRegistered = projectRootUri ? projects.some((project) => project.rootUri === projectRootUri) : projects.length > 0;
  const endpointClasses = serverEndpointClasses({
    enabled,
    authMode,
    tokenConfigured,
    projectRegistered,
    roleEnforcementReady
  });
  const checks: ServerReadinessReport["checks"] = [
    {
      label: "Server mode opt-in",
      status: enabled ? "pass" : "warn",
      detail: enabled ? "AGENTFLOW_SERVER_MODE is enabled." : "Server mode is not enabled. Local CLI, MCP stdio, dashboard, and worker remain the recommended default."
    },
    {
      label: "Network binding",
      status: !networkExposed || enabled ? "pass" : "fail",
      detail: networkExposed
        ? `${bind} can expose the runtime beyond this machine. Use only with explicit server mode, authentication, and registered projects.`
        : `${bind} is loopback/local-only.`
    },
    {
      label: "Authentication",
      status: !enabled ? "warn" : authMode === "token" && tokenConfigured || authMode === "oidc-proxy" ? "pass" : "fail",
      detail: !enabled
        ? "Auth is not required for local-only diagnostics, but it is required before server mode exposes mutation endpoints."
        : authMode === "token"
          ? (tokenConfigured ? "Bearer-token auth is configured." : "AGENTFLOW_SERVER_TOKEN is required when AGENTFLOW_SERVER_AUTH=token.")
          : authMode === "oidc-proxy"
            ? "OIDC reverse-proxy auth mode is selected; configure TLS and identity outside Agent Workflow."
            : "Set AGENTFLOW_SERVER_AUTH=token or AGENTFLOW_SERVER_AUTH=oidc-proxy before shared use."
    },
    {
      label: "Allowed origins",
      status: !enabled || allowedOrigins.length > 0 ? "pass" : "fail",
      detail: allowedOrigins.length
        ? allowedOrigins.join(", ")
        : enabled
          ? "Set AGENTFLOW_SERVER_ALLOWED_ORIGINS before exposing browser-facing server endpoints."
          : "Allowed origins are not required while server mode is disabled."
    },
    {
      label: "Enterprise services",
      status: servicesReachable ? "pass" : "fail",
      detail: servicesReachable ? "Postgres, Redis, and object storage are reachable for durable runs and receipts." : "One or more enterprise services are unreachable."
    },
    {
      label: "Registered projects",
      status: projectRegistered ? "pass" : "fail",
      detail: projectRootUri
        ? (projectRegistered ? "Selected project is registered in local storage." : "Selected project is not registered. Remote requests must use registered project ids, not arbitrary paths.")
        : `${projects.length} project(s) are registered in local storage.`
    },
    {
      label: "Role enforcement",
      status: !enabled ? "warn" : roleEnforcementReady ? "pass" : "warn",
      detail: roleEnforcementReady
        ? "Inspected projects use enforce mode for role checks."
        : "Use team.enforcement: enforce before shared server mutation endpoints are enabled."
    },
    {
      label: "Mutation endpoints",
      status: endpointClasses.some((endpoint) => endpoint.exposure === "mutation" && endpoint.implemented) ? "fail" : "pass",
      detail: "Governed HTTP mutation endpoints are not implemented in this version; local dashboard POST actions remain intended for loopback developer use."
    }
  ];
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const status: ServerReadinessStatus = !enabled
    ? "local-only"
    : failures > 0
      ? "blocked"
      : warnings > 0
        ? "attention"
        : "ready";
  return {
    kind: "agentflow_server_readiness_report",
    generatedAt: new Date().toISOString(),
    status,
    projectRootUri: projectRootUri ?? null,
    limit: input.limit,
    mode: {
      enabled,
      bind,
      port,
      networkExposed,
      authMode,
      tokenConfigured,
      allowedOrigins
    },
    services,
    projects,
    endpointClasses,
    checks,
    recommendedCommands: serverReadinessCommands(projectRootUri),
    notes: serverReadinessNotes({ status, enabled, networkExposed, projectRegistered, roleEnforcementReady })
  };
}

async function loadServerReadinessProject(summary: DashboardProjectSummary): Promise<ServerReadinessReport["projects"][number]> {
  const roleProject = await loadDashboardRoleProject(summary);
  return {
    id: roleProject.id,
    name: roleProject.name,
    rootUri: roleProject.rootUri,
    configStatus: roleProject.configStatus,
    roleEnforcement: roleProject.enforcement,
    separationOfDuties: roleProject.separationOfDuties,
    roles: roleProject.roles.map((role) => role.id)
  };
}

function serverEndpointClasses(input: {
  enabled: boolean;
  authMode: string;
  tokenConfigured: boolean;
  projectRegistered: boolean;
  roleEnforcementReady: boolean;
}): ServerReadinessReport["endpointClasses"] {
  const authReady = input.authMode === "oidc-proxy" || input.authMode === "token" && input.tokenConfigured;
  return [
    {
      name: "Read-only status and reports",
      exposure: "read-only",
      requiredControls: ["registered projects", "safe redaction", "no secret values"],
      implemented: false,
      ready: input.enabled && input.projectRegistered
    },
    {
      name: "Workflow queueing and worker controls",
      exposure: "mutation",
      requiredControls: ["auth", "project id", "operator role", "policy recheck", "idempotency key", "receipt"],
      implemented: false,
      ready: input.enabled && authReady && input.projectRegistered && input.roleEnforcementReady
    },
    {
      name: "Approval decisions and execution",
      exposure: "mutation",
      requiredControls: ["auth", "approver/operator roles", "separation of duties", "policy recheck", "receipt"],
      implemented: false,
      ready: input.enabled && authReady && input.projectRegistered && input.roleEnforcementReady
    },
    {
      name: "Lifecycle archive/restore/prune",
      exposure: "mutation",
      requiredControls: ["auth", "explicit approval", "destructive capability flags", "policy recheck", "receipt"],
      implemented: false,
      ready: false
    }
  ];
}

function formatServerReadinessReport(report: ServerReadinessReport): string {
  return [
    `Server mode readiness (${report.generatedAt})`,
    `Status: ${report.status}`,
    `Project: ${report.projectRootUri ?? "all registered projects"}`,
    "",
    "Mode:",
    `- Enabled: ${report.mode.enabled ? "yes" : "no"}`,
    `- Bind: ${report.mode.bind}:${report.mode.port}${report.mode.networkExposed ? " (network-exposed)" : " (loopback/local)"}`,
    `- Auth: ${report.mode.authMode}`,
    `- Token configured: ${report.mode.tokenConfigured ? "yes" : "no"}`,
    `- Allowed origins: ${report.mode.allowedOrigins.join(", ") || "none"}`,
    "",
    "Checks:",
    ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
    "",
    "Projects:",
    ...(report.projects.length ? report.projects.map((project) => `- ${project.name} (${project.id}): ${project.configStatus}, roles=${project.roles.join(", ") || "none"}, enforcement=${project.roleEnforcement}, separation=${project.separationOfDuties}`) : ["- No registered projects inspected."]),
    "",
    "Endpoint classes:",
    ...report.endpointClasses.map((endpoint) => `- ${endpoint.name}: ${endpoint.exposure}, implemented=${endpoint.implemented ? "yes" : "no"}, ready=${endpoint.ready ? "yes" : "no"} (${endpoint.requiredControls.join("; ")})`),
    "",
    "Recommended commands:",
    ...report.recommendedCommands.map((command) => `- ${command}`),
    "",
    "Notes:",
    ...report.notes.map((note) => `- ${note}`)
  ].join("\n");
}

function serverReadinessCommands(projectRootUri?: string): string[] {
  const projectArg = projectRootUri ? ` --project ${shellQuote(projectRootUri)}` : "";
  return [
    `agentflow server-readiness${projectArg} --json`,
    `agentflow roles${projectArg}`,
    "agentflow governance",
    `agentflow backup-report${projectArg}`
  ];
}

function serverReadinessNotes(input: {
  status: ServerReadinessStatus;
  enabled: boolean;
  networkExposed: boolean;
  projectRegistered: boolean;
  roleEnforcementReady: boolean;
}): string[] {
  const notes: string[] = [];
  if (!input.enabled) {
    notes.push("Local-first mode is active. Use CLI and MCP stdio for Codex, VS Code, Cursor, and local automation.");
  }
  if (input.networkExposed) {
    notes.push("Network binding can expose local workflow controls. Keep Postgres, Redis, MinIO, provider keys, and project files private behind the Agent Workflow process.");
  }
  if (!input.projectRegistered) {
    notes.push("Register and index projects before server mode accepts project ids from remote clients.");
  }
  if (!input.roleEnforcementReady) {
    notes.push("Set team.enforcement: enforce for shared projects before enabling remote mutation endpoints.");
  }
  if (input.status === "ready") {
    notes.push("Readiness checks pass for the documented contract. Remote execution endpoints are still not implemented in this version.");
  }
  return notes;
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function parseEnvList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function isLoopbackBind(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
}

async function loadServerProjectRegistryReport(input: {
  projectRootUri?: string;
  limit: number;
  includeRoots: boolean;
}): Promise<ServerProjectRegistryReport> {
  const projectRootUri = input.projectRootUri?.trim() ? path.resolve(process.cwd(), input.projectRootUri) : undefined;
  const services = await checkServices();
  const servicesReachable = services.every((service) => service.reachable);
  const summaries = servicesReachable
    ? (await listProjectStorageSummaries(input.limit)).filter((summary) => !projectRootUri || summary.rootUri === projectRootUri)
    : [];
  const projects = await Promise.all(summaries.map((summary) => loadServerProjectRegistryEntry(summary, input.includeRoots)));
  const checks: ServerProjectRegistryReport["checks"] = [
    {
      label: "Enterprise services",
      status: servicesReachable ? "pass" : "fail",
      detail: servicesReachable ? "Project registry can be read from local enterprise storage." : "Start enterprise services before reading registered project ids."
    },
    {
      label: "Project ids",
      status: projects.length > 0 ? "pass" : "fail",
      detail: projects.length > 0 ? `${projects.length} registered project id(s) are available for server-mode clients.` : "No registered projects were found."
    },
    {
      label: "Filesystem roots",
      status: input.includeRoots ? "warn" : "pass",
      detail: input.includeRoots ? "Local roots are included for operator diagnostics. Do not expose this shape as a remote client contract." : "Local roots are redacted; clients should use projectId."
    },
    {
      label: "Arbitrary paths",
      status: "pass",
      detail: "Preview payloads use projectId and do not accept project filesystem paths."
    }
  ];
  const notes = [
    "Use these projectId values for future server-mode requests instead of raw filesystem paths.",
    input.includeRoots ? "Root paths are visible because --include-roots was requested." : "Root paths are hidden by default for safer client-facing previews.",
    "This report does not register, remove, or mutate projects."
  ];
  return {
    kind: "agentflow_server_project_registry_report",
    generatedAt: new Date().toISOString(),
    projectRootUri: projectRootUri ?? null,
    limit: input.limit,
    includeRoots: input.includeRoots,
    services,
    projects,
    checks,
    notes
  };
}

async function loadServerProjectRegistryEntry(summary: DashboardProjectSummary, includeRoots: boolean): Promise<ServerProjectRegistryReport["projects"][number]> {
  const config = await loadRegisteredProjectConfig(summary);
  const defaultWorkflow = config?.project.default_workflows[0] ?? "review-pr";
  return {
    projectId: summary.id,
    name: summary.name,
    rootUri: includeRoots ? summary.rootUri : null,
    rootHash: stableHash(summary.rootUri),
    configStatus: config ? "valid" : await pathExists(path.join(summary.rootUri, ".agent-workflow", "project.yaml")) ? "invalid" : "missing",
    defaultWorkflows: config?.project.default_workflows ?? [],
    policyProfile: config?.execution.policy_profile ?? "local",
    roleEnforcement: config?.team.enforcement ?? "preview",
    requestExample: {
      projectId: summary.id,
      workflow: defaultWorkflow,
      task: `Run ${defaultWorkflow} for ${summary.name}`
    }
  };
}

async function loadRegisteredProjectConfig(summary: DashboardProjectSummary): Promise<ProjectConfig | null> {
  if (await pathExists(path.join(summary.rootUri, ".agent-workflow", "project.yaml"))) {
    try {
      return await loadProjectConfig(summary.rootUri);
    } catch {
      return null;
    }
  }
  try {
    return projectConfigSchema.parse(summary.config);
  } catch {
    return null;
  }
}

function formatServerProjectRegistryReport(report: ServerProjectRegistryReport): string {
  return [
    `Server project registry (${report.generatedAt})`,
    `Project filter: ${report.projectRootUri ?? "all registered projects"}`,
    `Roots included: ${report.includeRoots ? "yes" : "no"}`,
    "",
    "Checks:",
    ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
    "",
    "Projects:",
    ...(report.projects.length ? report.projects.map((project) => [
      `- ${project.name} (${project.projectId})`,
      `  root: ${project.rootUri ?? `redacted; hash=${project.rootHash.slice(0, 12)}`}`,
      `  config: ${project.configStatus}, policy=${project.policyProfile}, roles=${project.roleEnforcement}`,
      `  workflows: ${project.defaultWorkflows.join(", ") || "none configured"}`,
      `  request: ${JSON.stringify(project.requestExample)}`
    ].join("\n")) : ["- No registered projects found."]),
    "",
    "Notes:",
    ...report.notes.map((note) => `- ${note}`)
  ].join("\n");
}

async function resolveServerProjectReference(input: {
  projectId: string;
  includeRoot: boolean;
}): Promise<ServerProjectResolution> {
  const projectId = input.projectId.trim();
  const rejectedReason = rejectProjectIdReason(projectId);
  if (rejectedReason) {
    return {
      kind: "agentflow_server_project_resolution",
      generatedAt: new Date().toISOString(),
      projectId,
      resolved: false,
      reason: rejectedReason,
      project: null,
      checks: [
        {
          label: "Project id shape",
          status: "fail",
          detail: rejectedReason
        }
      ]
    };
  }

  const services = await checkServices();
  const servicesReachable = services.every((service) => service.reachable);
  if (!servicesReachable) {
    return {
      kind: "agentflow_server_project_resolution",
      generatedAt: new Date().toISOString(),
      projectId,
      resolved: false,
      reason: "enterprise services unreachable",
      project: null,
      checks: services.map((service) => ({
        label: service.endpoint.name,
        status: service.reachable ? "pass" : "fail",
        detail: service.message
      }))
    };
  }

  const summaries = await listProjectStorageSummaries(500);
  const summary = summaries.find((project) => project.id === projectId);
  if (!summary) {
    return {
      kind: "agentflow_server_project_resolution",
      generatedAt: new Date().toISOString(),
      projectId,
      resolved: false,
      reason: "project id is not registered",
      project: null,
      checks: [
        {
          label: "Registered project",
          status: "fail",
          detail: "No registered project matched this id."
        }
      ]
    };
  }

  const registryEntry = await loadServerProjectRegistryEntry(summary, input.includeRoot);
  return {
    kind: "agentflow_server_project_resolution",
    generatedAt: new Date().toISOString(),
    projectId,
    resolved: true,
    reason: null,
    project: {
      projectId: registryEntry.projectId,
      name: registryEntry.name,
      rootUri: registryEntry.rootUri,
      rootHash: registryEntry.rootHash,
      configStatus: registryEntry.configStatus,
      defaultWorkflows: registryEntry.defaultWorkflows,
      policyProfile: registryEntry.policyProfile,
      roleEnforcement: registryEntry.roleEnforcement
    },
    checks: [
      {
        label: "Project id shape",
        status: "pass",
        detail: "Project reference is an id, not a filesystem path."
      },
      {
        label: "Registered project",
        status: "pass",
        detail: "Project id resolved to one registered local project."
      },
      {
        label: "Filesystem root",
        status: input.includeRoot ? "warn" : "pass",
        detail: input.includeRoot ? "Local root is included for operator diagnostics." : "Local root is redacted from the response."
      }
    ]
  };
}

function rejectProjectIdReason(projectId: string): string | null {
  if (!projectId) return "project id is required";
  if (projectId.includes("/") || projectId.includes("\\") || projectId.includes("~")) return "project id must not be a filesystem path";
  if (projectId === "." || projectId === ".." || projectId.includes("..")) return "project id must not contain path traversal markers";
  if (!/^[a-zA-Z0-9._:-]+$/.test(projectId)) return "project id contains unsupported characters";
  return null;
}

function formatServerProjectResolution(result: ServerProjectResolution): string {
  if (!result.resolved || !result.project) {
    return [
      `Server project resolution (${result.generatedAt})`,
      `Project id: ${result.projectId}`,
      "Resolved: no",
      `Reason: ${result.reason ?? "unknown"}`,
      "",
      "Checks:",
      ...result.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`)
    ].join("\n");
  }
  return [
    `Server project resolution (${result.generatedAt})`,
    `Project id: ${result.projectId}`,
    "Resolved: yes",
    `Name: ${result.project.name}`,
    `Root: ${result.project.rootUri ?? `redacted; hash=${result.project.rootHash.slice(0, 12)}`}`,
    `Config: ${result.project.configStatus}`,
    `Policy profile: ${result.project.policyProfile}`,
    `Role enforcement: ${result.project.roleEnforcement}`,
    `Default workflows: ${result.project.defaultWorkflows.join(", ") || "none configured"}`,
    "",
    "Checks:",
    ...result.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`)
  ].join("\n");
}

async function loadServerRequestPreview(input: {
  projectId: string;
  workflowId: string;
  task: string;
  actor: string;
  actorRole: string;
  idempotencyKey?: string;
}): Promise<ServerRequestPreviewReport> {
  const projectResolution = await resolveServerProjectReference({ projectId: input.projectId, includeRoot: true });
  const workflows = await loadWorkflows(rootDir);
  const workflowFound = workflows.some((workflow) => workflow.id === input.workflowId);
  const projectRoot = projectResolution.project?.rootUri ?? null;
  const projectConfig = projectRoot ? await loadRegisteredProjectConfig({
    id: projectResolution.project?.projectId ?? input.projectId,
    name: projectResolution.project?.name ?? "unknown",
    rootUri: projectRoot,
    profile: "enterprise",
    config: {},
    updatedAt: "",
    indexedFiles: 0,
    indexedTokens: 0,
    lastIndexedAt: null,
    memoryItems: 0,
    runCount: 0,
    completedRuns: 0,
    failedRuns: 0,
    queuedRuns: 0,
    runningRuns: 0,
    lastRunAt: null,
    lastRunId: null,
    lastWorkflowId: null,
    lastRunStatus: null
  }) : null;
  const roleGate = projectConfig
    ? evaluateRoleGate(projectConfig, input.actorRole, "can_request_approvals")
    : { allowed: false, message: "Project config is unavailable; role capability cannot be checked." };
  const roleStatus: ServerRequestPreviewReport["controls"]["roleGate"] = !projectConfig
    ? "fail"
    : projectConfig.team.enforcement === "enforce" && !roleGate.allowed
      ? "fail"
      : roleGate.allowed
        ? "pass"
        : "warn";
  const serverModeEnabled = envFlag("AGENTFLOW_SERVER_MODE");
  const authMode = process.env.AGENTFLOW_SERVER_AUTH?.trim() || "none";
  const authConfigured = authMode === "oidc-proxy" || authMode === "token" && Boolean(process.env.AGENTFLOW_SERVER_TOKEN?.trim());
  const idempotencyProvided = Boolean(input.idempotencyKey?.trim());
  const envelope = {
    requestId: `req_${stableHash([input.projectId, input.workflowId, input.task, input.actor, new Date().toISOString()]).slice(0, 16)}`,
    idempotencyKey: input.idempotencyKey?.trim() || `preview_${stableHash([input.projectId, input.workflowId, input.task, input.actor, input.actorRole]).slice(0, 24)}`,
    actor: input.actor.trim() || "local-preview",
    actorRole: input.actorRole.trim() || "operator",
    projectId: input.projectId.trim(),
    workflow: input.workflowId.trim(),
    task: input.task.trim(),
    policyProfile: projectConfig?.execution.policy_profile ?? null,
    source: "server-request-preview" as const
  };
  const checks: ServerRequestPreviewReport["checks"] = [
    {
      label: "Project id",
      status: projectResolution.resolved ? "pass" : "fail",
      detail: projectResolution.resolved ? "Project id resolves to one registered project." : projectResolution.reason ?? "Project id did not resolve."
    },
    {
      label: "Workflow",
      status: workflowFound ? "pass" : "fail",
      detail: workflowFound ? "Workflow id exists in the installed bundle." : "Workflow id was not found in the installed bundle."
    },
    {
      label: "Task",
      status: envelope.task ? "pass" : "fail",
      detail: envelope.task ? "Task text is present." : "Task text is required."
    },
    {
      label: "Actor role",
      status: roleStatus,
      detail: roleGate.message
    },
    {
      label: "Server auth",
      status: !serverModeEnabled ? "warn" : authConfigured ? "pass" : "fail",
      detail: !serverModeEnabled ? "Server mode is disabled; this is a local preview only." : authConfigured ? "Server auth is configured for the selected mode." : "Server auth is required before remote mutation requests."
    },
    {
      label: "Idempotency",
      status: idempotencyProvided ? "pass" : "warn",
      detail: idempotencyProvided ? "Client idempotency key is present." : "Preview generated a suggested idempotency key; remote mutation endpoints should require a client-provided key."
    },
    {
      label: "Execution",
      status: "pass",
      detail: "Preview only. No workflow was queued and no worker task was executed."
    }
  ];
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  return {
    kind: "agentflow_server_request_preview",
    generatedAt: new Date().toISOString(),
    status: failures > 0 ? "blocked" : warnings > 0 ? "attention" : "ready",
    envelope,
    controls: {
      serverModeEnabled,
      authMode,
      authConfigured,
      projectResolved: projectResolution.resolved,
      roleGate: roleStatus,
      workflowFound,
      idempotencyProvided,
      wouldQueue: false
    },
    checks,
    notes: [
      "This is a contract preview for future governed server-mode mutation requests.",
      "Use projectId instead of a filesystem path.",
      "Remote execution endpoints are not implemented by this command."
    ]
  };
}

function formatServerRequestPreview(report: ServerRequestPreviewReport): string {
  return [
    `Server request preview (${report.generatedAt})`,
    `Status: ${report.status}`,
    "",
    "Envelope:",
    `- requestId: ${report.envelope.requestId}`,
    `- idempotencyKey: ${report.envelope.idempotencyKey}`,
    `- actor: ${report.envelope.actor}`,
    `- actorRole: ${report.envelope.actorRole}`,
    `- projectId: ${report.envelope.projectId}`,
    `- workflow: ${report.envelope.workflow}`,
    `- task: ${report.envelope.task}`,
    `- policyProfile: ${report.envelope.policyProfile ?? "unknown"}`,
    `- wouldQueue: ${report.controls.wouldQueue ? "yes" : "no"}`,
    "",
    "Checks:",
    ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
    "",
    "Notes:",
    ...report.notes.map((note) => `- ${note}`)
  ].join("\n");
}

async function loadServerRoutePreview(input: {
  projectId: string;
  workflowId: string;
  task: string;
  actor: string;
  actorRole: string;
  idempotencyKey?: string;
}): Promise<ServerRoutePreviewReport> {
  const requestPreview = await loadServerRequestPreview(input);
  const resolution = await resolveServerProjectReference({ projectId: input.projectId, includeRoot: true });
  const route = requestPreview.status === "blocked" || !resolution.project?.rootUri
    ? null
    : {
        projectId: requestPreview.envelope.projectId,
        projectName: resolution.project.name,
        projectRootUri: resolution.project.rootUri,
        workflowId: requestPreview.envelope.workflow,
        task: requestPreview.envelope.task,
        policyProfile: requestPreview.envelope.policyProfile ?? "local",
        actor: requestPreview.envelope.actor,
        actorRole: requestPreview.envelope.actorRole,
        idempotencyKey: requestPreview.envelope.idempotencyKey,
        commandPreview: `agentflow run-and-watch ${shellQuote(requestPreview.envelope.workflow)} --project ${shellQuote(resolution.project.rootUri)} --task ${shellQuote(requestPreview.envelope.task)}`
      };
  return {
    kind: "agentflow_server_route_preview",
    generatedAt: new Date().toISOString(),
    status: requestPreview.status,
    dryRun: true,
    envelope: requestPreview.envelope,
    controls: requestPreview.controls,
    route,
    checks: [
      ...requestPreview.checks,
      {
        label: "Route adapter",
        status: route ? "pass" : "fail",
        detail: route ? "Request envelope resolves to an internal project route. No workflow was queued." : "Route was not produced because the request preview is blocked or project root is unavailable."
      }
    ],
    notes: [
      "Dry-run route preview only.",
      "The route contains the local root for internal execution planning; do not expose it as the remote client contract.",
      "Future server endpoints should require the same preview checks before queueing work."
    ]
  };
}

function formatServerRoutePreview(report: ServerRoutePreviewReport): string {
  return [
    `Server route preview (${report.generatedAt})`,
    `Status: ${report.status}`,
    `Dry run: ${report.dryRun ? "yes" : "no"}`,
    "",
    "Envelope:",
    `- projectId: ${report.envelope.projectId}`,
    `- workflow: ${report.envelope.workflow}`,
    `- actorRole: ${report.envelope.actorRole}`,
    `- idempotencyKey: ${report.envelope.idempotencyKey}`,
    "",
    "Route:",
    ...(report.route ? [
      `- project: ${report.route.projectName}`,
      `- root: ${report.route.projectRootUri}`,
      `- workflow: ${report.route.workflowId}`,
      `- policyProfile: ${report.route.policyProfile}`,
      `- commandPreview: ${report.route.commandPreview}`
    ] : ["- No route produced."]),
    "",
    "Checks:",
    ...report.checks.map((check) => `- ${check.status.toUpperCase()} ${check.label}: ${check.detail}`),
    "",
    "Notes:",
    ...report.notes.map((note) => `- ${note}`)
  ].join("\n");
}

async function processServerQueueRequest(request: http.IncomingMessage, body: unknown): Promise<ServerQueueReport> {
  const payload = objectValue(body);
  const executeRequested = payload.execute === true;
  const routePreview = await loadServerRoutePreview({
    projectId: stringValue(payload.projectId) ?? "",
    workflowId: stringValue(payload.workflow) ?? stringValue(payload.workflowId) ?? "",
    task: stringValue(payload.task) ?? "",
    actor: stringValue(payload.actor) ?? "server-client",
    actorRole: stringValue(payload.actorRole) ?? "operator",
    idempotencyKey: stringValue(payload.idempotencyKey) ?? undefined
  });
  const auth = validateServerMutationAuth(request);
  const queueExecutionEnabled = envFlag("AGENTFLOW_SERVER_ENABLE_QUEUE");
  const serverModeEnabled = envFlag("AGENTFLOW_SERVER_MODE");
  const clientProvidedIdempotency = Boolean(stringValue(payload.idempotencyKey)?.trim());
  const checks: ServerQueueReport["checks"] = [
    ...routePreview.checks,
    {
      label: "Authenticated mutation",
      status: auth.ok ? "pass" : "fail",
      detail: auth.ok ? `Authenticated with ${auth.method}.` : auth.error
    },
    {
      label: "Queue execution gate",
      status: !executeRequested ? "warn" : serverModeEnabled && queueExecutionEnabled ? "pass" : "fail",
      detail: !executeRequested
        ? "Dry-run preview only. Set execute=true to request queueing."
        : serverModeEnabled && queueExecutionEnabled
          ? "Server mode and queue execution are explicitly enabled."
          : "Queueing requires AGENTFLOW_SERVER_MODE=1 and AGENTFLOW_SERVER_ENABLE_QUEUE=1."
    },
    {
      label: "Client idempotency",
      status: clientProvidedIdempotency ? "pass" : "fail",
      detail: clientProvidedIdempotency ? "Client idempotency key is present." : "Queue requests require a client-provided idempotency key."
    }
  ];
  let queuedRun: ServerQueueReport["queuedRun"] = null;
  const canQueue = executeRequested
    && routePreview.status !== "blocked"
    && routePreview.route
    && auth.ok
    && serverModeEnabled
    && queueExecutionEnabled
    && clientProvidedIdempotency;
  if (canQueue && routePreview.route) {
    const existingRun = await findServerQueueRunByIdempotency({
      projectId: routePreview.route.projectId,
      projectRootUri: routePreview.route.projectRootUri,
      workflowId: routePreview.route.workflowId,
      idempotencyKey: routePreview.envelope.idempotencyKey
    });
    if (existingRun) {
      queuedRun = {
        runId: existingRun.runId,
        projectId: existingRun.projectId,
        projectRootUri: routePreview.route.projectRootUri,
        workflowId: existingRun.workflowId,
        tasks: existingRun.tasks,
        runUrl: `/run?id=${encodeURIComponent(existingRun.runId)}`,
        actorReceiptUri: null,
        reused: true
      };
      checks.push({
        label: "Workflow queue",
        status: "pass",
        detail: `Reused existing workflow run ${existingRun.runId} for this idempotency key.`
      });
    } else {
      const queued = await queueWorkflow({
        workflowId: routePreview.route.workflowId,
        projectPath: routePreview.route.projectRootUri,
        task: routePreview.route.task,
        policyProfile: routePreview.route.policyProfile,
        evaluationMetadata: {
          source: "server-queue",
          requestId: routePreview.envelope.requestId,
          idempotencyKey: routePreview.envelope.idempotencyKey,
          actor: routePreview.envelope.actor,
          actorRole: routePreview.envelope.actorRole,
          authMethod: auth.method
        }
      });
      if (queued.ok) {
        const actorReceiptUri = await recordRunAction({
          runId: queued.run.runId,
          agentId: "workflow-orchestrator",
          actionType: "server_queue_request",
          target: routePreview.route.projectId,
          summary: `Server queue request from ${routePreview.envelope.actor} as ${routePreview.envelope.actorRole}`,
          artifactKind: "server_queue_request",
          artifactContent: {
            requestId: routePreview.envelope.requestId,
            idempotencyKey: routePreview.envelope.idempotencyKey,
            actor: routePreview.envelope.actor,
            actorRole: routePreview.envelope.actorRole,
            authMethod: auth.method,
            projectId: routePreview.route.projectId,
            workflowId: routePreview.route.workflowId,
            policyProfile: routePreview.route.policyProfile,
            receivedAt: new Date().toISOString()
          },
          idempotencyKey: `server-queue-${stableHash(routePreview.envelope.idempotencyKey).slice(0, 24)}`
        });
        queuedRun = {
          runId: queued.run.runId,
          projectId: queued.run.projectId,
          projectRootUri: queued.projectDir,
          workflowId: queued.workflow.id,
          tasks: queued.run.tasks,
          runUrl: `/run?id=${encodeURIComponent(queued.run.runId)}`,
          actorReceiptUri,
          reused: false
        };
        checks.push({
          label: "Workflow queue",
          status: "pass",
          detail: `Queued workflow run ${queued.run.runId}.`
        });
      } else {
        checks.push({
          label: "Workflow queue",
          status: "fail",
          detail: queued.error
        });
      }
    }
  }
  const failures = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const status: ServerQueueReport["status"] = queuedRun
    ? "queued"
    : failures > 0
      ? "blocked"
      : warnings > 0
        ? "attention"
        : "ready";
  return {
    kind: "agentflow_server_queue_report",
    generatedAt: new Date().toISOString(),
    status,
    dryRun: !queuedRun,
    envelope: routePreview.envelope,
    route: routePreview.route,
    queuedRun,
    controls: {
      ...routePreview.controls,
      authAccepted: auth.ok,
      executeRequested,
      queueExecutionEnabled,
      clientProvidedIdempotency,
      wouldQueue: Boolean(queuedRun)
    },
    checks,
    notes: [
      queuedRun ? "Workflow was queued. Process stages with a scoped worker or worker pool." : "No workflow was queued by this request.",
      "This endpoint accepts registered project ids only; it does not accept project filesystem paths.",
      "Queue execution remains disabled unless server mode, token/OIDC auth, explicit execution, and the queue gate are all enabled."
    ]
  };
}

async function findServerQueueRunByIdempotency(input: {
  projectId: string;
  projectRootUri: string;
  workflowId: string;
  idempotencyKey: string;
}): Promise<null | { runId: string; projectId: string; workflowId: string; tasks: number }> {
  const runs = await listWorkflowRunsForProject({ projectRootUri: input.projectRootUri, limit: 500 });
  const existing = runs.find((run) =>
    run.workflowId === input.workflowId &&
    stringValue(run.evaluationMetadata?.source) === "server-queue" &&
    stringValue(run.evaluationMetadata?.idempotencyKey) === input.idempotencyKey
  );
  if (!existing) return null;
  const details = await getWorkflowRunDetails(existing.id);
  return {
    runId: existing.id,
    projectId: input.projectId,
    workflowId: existing.workflowId,
    tasks: details.tasks.length
  };
}

function validateServerMutationAuth(request: http.IncomingMessage): { ok: true; method: string } | { ok: false; method: string; error: string } {
  const authMode = process.env.AGENTFLOW_SERVER_AUTH?.trim() || "token";
  if (authMode === "oidc-proxy") {
    const actor = firstHeader(request.headers["x-agentflow-actor"] ?? request.headers["x-forwarded-email"]);
    return actor
      ? { ok: true, method: "oidc-proxy" }
      : { ok: false, method: "oidc-proxy", error: "OIDC proxy auth requires x-agentflow-actor or x-forwarded-email." };
  }
  const expectedToken = process.env.AGENTFLOW_SERVER_TOKEN?.trim();
  if (!expectedToken) {
    return { ok: false, method: "bearer-token", error: "AGENTFLOW_SERVER_TOKEN is required for server mutation endpoints." };
  }
  const authorization = firstHeader(request.headers.authorization);
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!token || token !== expectedToken) {
    return { ok: false, method: "bearer-token", error: "Bearer token is missing or invalid." };
  }
  return { ok: true, method: "bearer-token" };
}

function firstHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function formatArtifactLifecycleActionPlan(plan: ArtifactLifecycleActionPlan): string[] {
  return [
    "",
    `Dry-run ${plan.action} plan:`,
    `- Candidates: ${plan.totalCandidates}`,
    `- Estimated recoverable: ${formatBytes(plan.estimatedBytesRecoverable)}`,
    `- Criteria: source=${plan.criteria.policySource} minAgeDays=${plan.criteria.minAgeDays} minBytes=${plan.criteria.minBytes} includeAudit=${plan.criteria.includeAudit} legalHold=${plan.criteria.legalHold} requireApproval=${plan.criteria.requireApproval}`,
    ...plan.notes.map((note) => `- ${note}`),
    ...plan.candidates.slice(0, 20).map((candidate) => `- ${candidate.artifactId} ${candidate.uri} (${formatBytes(candidate.contentBytes)}): ${candidate.reason} [receipt=${candidate.receiptPreview.actionType}]`)
  ];
}

function artifactAgeBucket(value: string): string {
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  const days = ageMs / 86_400_000;
  if (days <= 1) return "0-1d";
  if (days <= 7) return "2-7d";
  if (days <= 30) return "8-30d";
  if (days <= 90) return "31-90d";
  return "90d+";
}

function artifactLifecycleHint(artifact: DashboardArtifactLifecycleRow, ageBucket: string): string {
  if (artifact.kind === "action_approval" || artifact.kind === "run_feedback" || artifact.kind === "command_output" || artifact.kind === "file_write") {
    return "retain for audit";
  }
  if (artifact.runStatus === "failed" || artifact.runStatus === "running" || artifact.runStatus === "queued") {
    return "retain until run reviewed";
  }
  if ((ageBucket === "31-90d" || ageBucket === "90d+") && artifact.contentBytes > 20_000) {
    return "candidate for future prune plan";
  }
  return "retain by default";
}

function buildArtifactLifecycleHints(artifacts: ArtifactLifecycleReport["recentArtifacts"], estimatedBytes: number, limit: number): string[] {
  const hints: string[] = [];
  const futurePruneCandidates = artifacts.filter((artifact) => artifact.lifecycleHint === "candidate for future prune plan");
  const failedRunArtifacts = artifacts.filter((artifact) => artifact.runStatus === "failed").length;
  const auditArtifacts = artifacts.filter((artifact) => artifact.lifecycleHint === "retain for audit").length;
  if (artifacts.length === limit) hints.push("Report hit the inspection limit; increase --limit before making lifecycle decisions.");
  if (futurePruneCandidates.length) hints.push(`${futurePruneCandidates.length} older large artifact(s) look like candidates for a future dry-run prune plan.`);
  if (failedRunArtifacts) hints.push(`${failedRunArtifacts} artifact(s) belong to failed runs; review failures before pruning any related evidence.`);
  if (auditArtifacts) hints.push(`${auditArtifacts} artifact(s) are audit evidence and should be retained unless project retention policy says otherwise.`);
  if (estimatedBytes === 0) hints.push("No artifact storage was found in the inspected window.");
  return hints;
}

function buildArtifactPrunePlan(artifacts: ArtifactLifecycleReport["recentArtifacts"], criteria: ArtifactPrunePlan["criteria"]): ArtifactPrunePlan {
  if (criteria.legalHold) {
    return {
      mode: "dry-run",
      generatedAt: new Date().toISOString(),
      criteria,
      totalCandidates: 0,
      estimatedBytesRecoverable: 0,
      approvalRequired: criteria.requireApproval,
      notes: [
        "Dry run only. This plan does not delete, archive, or mutate artifacts.",
        "Project legal hold is enabled; prune candidates are suppressed."
      ],
      candidates: []
    };
  }
  const candidates = artifacts.flatMap((artifact) => {
    const ageDays = artifactAgeDays(artifact.createdAt);
    const reason = artifactPruneReason(artifact, ageDays, criteria);
    if (!reason) return [];
    return [{
      artifactId: artifact.id,
      uri: artifact.uri,
      runId: artifact.runId,
      taskId: artifact.taskId,
      projectName: artifact.projectName,
      projectRootUri: artifact.projectRootUri,
      workflowId: artifact.workflowId,
      runStatus: artifact.runStatus,
      kind: artifact.kind,
      contentBytes: artifact.contentBytes,
      createdAt: artifact.createdAt,
      ageDays,
      reason,
      receiptPreview: {
        actionType: "artifact_prune_requested" as const,
        target: artifact.uri,
        summary: `Would request pruning ${artifact.kind} artifact ${artifact.id}`,
        metadata: {
          mode: "dry-run" as const,
          action: "prune" as const,
          artifactId: artifact.id,
          runId: artifact.runId,
          taskId: artifact.taskId,
          kind: artifact.kind,
          contentBytes: artifact.contentBytes,
          reason
        }
      }
    }];
  });
  const estimatedBytesRecoverable = candidates.reduce((sum, candidate) => sum + candidate.contentBytes + candidate.uri.length, 0);
  const auditCount = artifacts.filter(isAuditArtifact).length;
  const notes = [
    "Dry run only. This plan does not delete, archive, or mutate artifacts.",
    "Any future prune execution must recheck current storage state, project policy, and approval requirements.",
    criteria.includeAudit ? "Audit artifacts were allowed into candidate selection by request." : `${auditCount} audit artifact(s) were excluded from candidate selection.`
  ];
  if (!candidates.length) {
    notes.push("No artifacts matched the current prune criteria.");
  }
  return {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    criteria,
    totalCandidates: candidates.length,
    estimatedBytesRecoverable,
    approvalRequired: criteria.requireApproval,
    notes,
    candidates
  };
}

function buildArtifactArchivePlan(artifacts: ArtifactLifecycleReport["recentArtifacts"], criteria: ArtifactPrunePlan["criteria"]): ArtifactLifecycleActionPlan {
  if (criteria.legalHold) {
    return emptyArtifactLifecycleActionPlan("archive", criteria, "Project legal hold is enabled; archive candidates are suppressed.");
  }
  const candidates = artifacts.flatMap((artifact) => {
    const ageDays = artifactAgeDays(artifact.createdAt);
    const reason = artifactPruneReason(artifact, ageDays, criteria);
    if (!reason) return [];
    return [artifactLifecycleCandidate(artifact, ageDays, reason.replace("belongs to", "is ready for archive review and belongs to"), "archive")];
  });
  return {
    mode: "dry-run",
    action: "archive",
    generatedAt: new Date().toISOString(),
    criteria,
    totalCandidates: candidates.length,
    estimatedBytesRecoverable: candidates.reduce((sum, candidate) => sum + candidate.contentBytes + candidate.uri.length, 0),
    approvalRequired: criteria.requireApproval,
    notes: [
      "Dry run only. This plan does not archive, move, delete, or mutate artifacts.",
      "Approved archive execution copies artifacts into archived snapshots, records lifecycle receipts, and preserves restore metadata.",
      criteria.includeAudit ? "Audit artifacts were allowed into archive candidate selection by request." : `${artifacts.filter(isAuditArtifact).length} audit artifact(s) were excluded from archive candidate selection.`,
      ...(candidates.length ? [] : ["No artifacts matched the current archive criteria."])
    ],
    candidates
  };
}

async function buildArtifactRestorePlan(artifacts: ArtifactLifecycleReport["recentArtifacts"], criteria: ArtifactPrunePlan["criteria"]): Promise<ArtifactLifecycleActionPlan> {
  if (criteria.legalHold) {
    return emptyArtifactLifecycleActionPlan("restore", criteria, "Project legal hold is enabled; restore candidates are suppressed.");
  }
  const archivedArtifacts = artifacts.filter((artifact) => artifact.kind === "archived_artifact");
  const candidates: ArtifactLifecycleActionPlan["candidates"] = [];
  for (const artifact of archivedArtifacts) {
    const fullArtifact = await getArtifactByUri(artifact.uri);
    if (!fullArtifact || fullArtifact.content.originalActionType !== "artifact_archive") continue;
    const restoreMetadata = objectFromRecord(fullArtifact.content, "restoreMetadata");
    const target = stringFromRecord(restoreMetadata, "originalUri") || stringFromRecord(fullArtifact.content, "target");
    if (!target) continue;
    const ageDays = artifactAgeDays(artifact.createdAt);
    const reason = `Archived artifact snapshot can be reviewed for restore target ${target}.`;
    candidates.push({
      artifactId: artifact.id,
      uri: target,
      runId: artifact.runId,
      taskId: artifact.taskId,
      projectName: artifact.projectName,
      projectRootUri: artifact.projectRootUri,
      workflowId: artifact.workflowId,
      runStatus: artifact.runStatus,
      kind: "archived_artifact",
      contentBytes: artifact.contentBytes,
      createdAt: artifact.createdAt,
      ageDays,
      reason,
      receiptPreview: artifactLifecycleReceiptPreview({
        action: "restore",
        artifactId: artifact.id,
        uri: target,
        runId: artifact.runId,
        taskId: artifact.taskId,
        kind: "archived_artifact",
        contentBytes: artifact.contentBytes,
        reason
      })
    });
  }
  return {
    mode: "dry-run",
    action: "restore",
    generatedAt: new Date().toISOString(),
    criteria,
    totalCandidates: candidates.length,
    estimatedBytesRecoverable: 0,
    approvalRequired: criteria.requireApproval,
    notes: [
      "Dry run only. This plan does not restore, move, delete, or mutate artifacts.",
      "Restore candidates come only from archived artifact snapshots.",
      ...(candidates.length ? [] : ["No archived artifact snapshots were found in the inspected artifact window."])
    ],
    candidates
  };
}

function emptyArtifactLifecycleActionPlan(action: "archive" | "restore", criteria: ArtifactPrunePlan["criteria"], note: string): ArtifactLifecycleActionPlan {
  return {
    mode: "dry-run",
    action,
    generatedAt: new Date().toISOString(),
    criteria,
    totalCandidates: 0,
    estimatedBytesRecoverable: 0,
    approvalRequired: criteria.requireApproval,
    notes: [
      "Dry run only. This plan does not mutate artifacts.",
      note
    ],
    candidates: []
  };
}

function artifactLifecycleCandidate(
  artifact: ArtifactLifecycleReport["recentArtifacts"][number],
  ageDays: number | null,
  reason: string,
  action: ArtifactLifecycleAction
): ArtifactLifecycleActionPlan["candidates"][number] {
  return {
    artifactId: artifact.id,
    uri: artifact.uri,
    runId: artifact.runId,
    taskId: artifact.taskId,
    projectName: artifact.projectName,
    projectRootUri: artifact.projectRootUri,
    workflowId: artifact.workflowId,
    runStatus: artifact.runStatus,
    kind: artifact.kind,
    contentBytes: artifact.contentBytes,
    createdAt: artifact.createdAt,
    ageDays,
    reason,
    receiptPreview: artifactLifecycleReceiptPreview({
      action,
      artifactId: artifact.id,
      uri: artifact.uri,
      runId: artifact.runId,
      taskId: artifact.taskId,
      kind: artifact.kind,
      contentBytes: artifact.contentBytes,
      reason
    })
  };
}

function artifactLifecycleReceiptPreview(input: {
  action: ArtifactLifecycleAction;
  artifactId: string;
  uri: string;
  runId: string;
  taskId: string | null;
  kind: string;
  contentBytes: number;
  reason: string;
}): ArtifactLifecycleReceiptPreview {
  const requestedActionType: Record<ArtifactLifecycleAction, ArtifactLifecycleRequestedActionType> = {
    prune: "artifact_prune_requested",
    archive: "artifact_archive_requested",
    restore: "artifact_restore_requested"
  };
  return {
    actionType: requestedActionType[input.action],
    target: input.uri,
    summary: `Would request ${input.action} for ${input.kind} artifact ${input.artifactId}`,
    metadata: {
      mode: "dry-run",
      action: input.action,
      artifactId: input.artifactId,
      runId: input.runId,
      taskId: input.taskId,
      kind: input.kind,
      contentBytes: input.contentBytes,
      reason: input.reason
    }
  };
}

function artifactPruneReason(artifact: ArtifactLifecycleReport["recentArtifacts"][number], ageDays: number | null, criteria: ArtifactPrunePlan["criteria"]): string | null {
  if (!criteria.includeAudit && isAuditArtifact(artifact)) return null;
  if (artifact.runStatus !== "completed" && artifact.runStatus !== "dismissed" && artifact.runStatus !== "cancelled") return null;
  if (ageDays === null || ageDays < criteria.minAgeDays) return null;
  if (artifact.contentBytes < criteria.minBytes) return null;
  return `${artifact.kind} is ${ageDays} day(s) old, ${formatBytes(artifact.contentBytes)}, and belongs to a ${artifact.runStatus} run.`;
}

function artifactAgeDays(value: string): number | null {
  const ageMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return Math.floor(ageMs / 86_400_000);
}

function isAuditArtifact(artifact: { kind: string }): boolean {
  return artifact.kind === "action_approval" || artifact.kind === "run_feedback" || artifact.kind === "command_output" || artifact.kind === "file_write";
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T | Promise<T>): Promise<T> {
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

async function loadLearningReport(input: {
  projectDir: string;
  limit: number;
}): Promise<LearningReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const limit = Math.max(1, input.limit);
  const runs = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit });
  const scorecard = await loadPreferenceScorecard({ projectDir, limit });
  const proposals = buildTuningProposals(scorecard);
  const stageHealth = runs.length ? await listWorkflowStageHealthForRuns({ runIds: runs.map((run) => run.id) }) : [];
  const evaluationRuns = runs.filter((run) => typeof run.evaluationMetadata?.suiteId === "string");
  const reports = (await Promise.all(runs.slice(0, Math.min(runs.length, 20)).map((run) => loadCostQualityReport(run.id)))).filter((report): report is CostQualityReport => report !== null);
  const failedRuns = runs
    .filter((run) => run.status === "failed")
    .slice(0, 10)
    .map((run) => ({
      runId: run.id,
      workflowId: run.workflowId,
      task: run.task,
      startedAt: run.startedAt
    }));
  const repeatedFailurePatterns = stageHealth
    .filter((stage) => stage.failedTasks > 0)
    .map((stage) => ({
      workflowId: inferStageWorkflowId(runs, reports, stage.stageId),
      stageId: stage.stageId,
      agentId: inferStageAgentId(reports, stage.stageId),
      failedTasks: stage.failedTasks,
      totalTasks: stage.totalTasks,
      failureRate: stage.totalTasks > 0 ? Number((stage.failedTasks / stage.totalTasks).toFixed(3)) : 0
    }))
    .sort((left, right) => right.failedTasks - left.failedTasks || right.failureRate - left.failureRate)
    .slice(0, 10);
  const costOpportunities = scorecard.groups
    .filter((group) => group.recommendation !== "Keep current routing." || group.fallbackRate > 0 || (group.averageLatencyMs ?? 0) > 30_000)
    .sort((left, right) => right.feedbackScore - left.feedbackScore || right.fallbackRate - left.fallbackRate)
    .slice(0, 10)
    .map((group) => ({
      workflowId: group.workflowId,
      stageId: group.stageId,
      agentId: group.agentId,
      providerId: group.providerId,
      modelTier: group.modelTier,
      runs: group.runs,
      fallbackRate: group.fallbackRate,
      averageLatencyMs: group.averageLatencyMs,
      recommendation: group.recommendation
    }));
  const proposalKinds = countStrings(proposals.proposals.map((proposal) => proposal.kind));
  const evalGaps: string[] = [];
  if (runs.length === 0) evalGaps.push("Run at least one workflow before learning can identify patterns.");
  if (Object.values(scorecard.feedbackCounts).reduce((sum, value) => sum + value, 0) === 0) evalGaps.push("Record accepted, revised, or rejected feedback so learning can personalize recommendations.");
  if (evaluationRuns.length === 0) evalGaps.push("Run or create an evaluation suite before promoting routing, prompt, or context-budget changes.");
  if (failedRuns.length > 0 && repeatedFailurePatterns.length === 0) evalGaps.push("Failed runs exist, but stage-level health did not isolate a repeated failing stage yet.");
  if (proposals.proposals.some((proposal) => proposal.kind === "feedback_needed")) evalGaps.push("Some routes need human feedback before the daemon can rank them confidently.");
  if (!evalGaps.length) evalGaps.push("Learning evidence is ready for proposal generation, but application should still require approval.");
  return {
    kind: "agentflow_learning_report",
    generatedAt: new Date().toISOString(),
    projectDir,
    limit,
    autonomyMode: "observe",
    runsAnalyzed: runs.length,
    runStatusCounts: countStrings(runs.map((run) => run.status)),
    feedbackCounts: scorecard.feedbackCounts,
    evaluationRuns: evaluationRuns.length,
    latestEvaluationAt: evaluationRuns.map((run) => run.startedAt).sort().at(-1) ?? null,
    failedRuns,
    repeatedFailurePatterns,
    costOpportunities,
    proposalPreview: {
      total: proposals.proposals.length,
      highPriority: proposals.proposals.filter((proposal) => proposal.priority === "high").length,
      byKind: proposalKinds
    },
    evalGaps,
    safeAutomaticActions: [
      "Read local run history, receipts, feedback, eval summaries, and queue status.",
      "Detect repeated failures, high-cost routes, stale context, and eval gaps.",
      "Generate compact local learning reports and dry-run proposal previews.",
      "Update learning files and future learning database rows that Agent Workflow created and owns when propose mode or an explicit learning command requests it.",
      "Queue approval requests for behavior-changing improvements."
    ],
    approvalRequiredActions: [
      "Apply project-local tuning notes.",
      "Modify reusable agents, workflows, package code, docs, schemas, provider settings, or project source.",
      "Run commands, tests, web/model research, network calls, or external tools.",
      "Change production policy, deployment, storage lifecycle, server mode, or any private-data export."
    ],
    privacyBoundaries: [
      "Local evidence stays on this machine by default.",
      "Web/model research is opt-in and must not include private source, feedback, logs, prompts, eval cases, or artifacts without explicit approval.",
      "Open-source learning should generalize developer workflow patterns and avoid product-specific behavior."
    ],
    nextCommands: [
      `npm run agentflow -- learning-report --project ${shellQuote(projectDir)} --json`,
      `npm run agentflow -- learning-proposals --project ${shellQuote(projectDir)} --write`,
      `npm run agentflow -- preference-scorecard --project ${shellQuote(projectDir)}`,
      `npm run agentflow -- tuning-proposals --project ${shellQuote(projectDir)}`,
      `npm run agentflow -- run-and-watch model-improvement --project ${shellQuote(projectDir)} --task "Improve local developer workflow quality and cost"`
    ]
  };
}

function inferStageWorkflowId(runs: DashboardRunStatus[], reports: CostQualityReport[], stageId: string): string {
  const report = reports.find((item) => item.stages.some((stage) => stage.stageId === stageId));
  return report?.workflowId ?? runs[0]?.workflowId ?? "unknown";
}

function inferStageAgentId(reports: CostQualityReport[], stageId: string): string {
  const stage = reports.flatMap((report) => report.stages).find((item) => item.stageId === stageId);
  return stage?.agentId ?? "unknown";
}

function formatLearningReport(report: LearningReport): string {
  return [
    `Learning report (${report.generatedAt})`,
    `Project: ${report.projectDir}`,
    `Mode: ${report.autonomyMode}`,
    `Runs analyzed: ${report.runsAnalyzed}`,
    `Run statuses: ${formatInlineCounts(report.runStatusCounts) || "none"}`,
    `Feedback: ${formatInlineCounts(report.feedbackCounts) || "none"}`,
    `Evaluation runs: ${report.evaluationRuns}${report.latestEvaluationAt ? ` latest=${report.latestEvaluationAt}` : ""}`,
    `Proposal preview: total=${report.proposalPreview.total} high=${report.proposalPreview.highPriority} ${formatInlineCounts(report.proposalPreview.byKind)}`,
    "",
    "Repeated failure patterns:",
    ...(report.repeatedFailurePatterns.length ? report.repeatedFailurePatterns.map((pattern) => `- ${pattern.workflowId}/${pattern.stageId}/${pattern.agentId}: ${pattern.failedTasks}/${pattern.totalTasks} failed (${pattern.failureRate})`) : ["- none"]),
    "",
    "Cost and routing opportunities:",
    ...(report.costOpportunities.length ? report.costOpportunities.map((item) => `- ${item.workflowId}/${item.stageId}/${item.agentId}: ${item.providerId}/${item.modelTier}, fallback=${item.fallbackRate}, latency=${item.averageLatencyMs ?? "n/a"}ms - ${item.recommendation}`) : ["- none"]),
    "",
    "Evaluation gaps:",
    ...report.evalGaps.map((item) => `- ${item}`),
    "",
    "Safe automatic actions:",
    ...report.safeAutomaticActions.map((item) => `- ${item}`),
    "",
    "Approval required:",
    ...report.approvalRequiredActions.map((item) => `- ${item}`),
    "",
    "Privacy boundaries:",
    ...report.privacyBoundaries.map((item) => `- ${item}`),
    "",
    "Next commands:",
    ...report.nextCommands.map((command) => `- ${command}`)
  ].join("\n");
}

function buildLearningProposalSet(report: LearningReport): LearningProposalSet {
  const proposals: LearningProposal[] = [];
  const addProposal = (input: Omit<LearningProposal, "id">): void => {
    proposals.push({
      ...input,
      id: `learn-${String(proposals.length + 1).padStart(3, "0")}`
    });
  };

  for (const pattern of report.repeatedFailurePatterns.slice(0, 5)) {
    addProposal({
      priority: pattern.failureRate >= 0.5 ? "high" : "medium",
      kind: "repeated_failure",
      riskLevel: "medium",
      title: `Investigate repeated failures in ${pattern.stageId}`,
      target: `${pattern.workflowId}/${pattern.stageId}/${pattern.agentId}`,
      rationale: `${pattern.failedTasks} of ${pattern.totalTasks} recent stage task(s) failed.`,
      evidence: [
        `workflow=${pattern.workflowId}`,
        `stage=${pattern.stageId}`,
        `agent=${pattern.agentId}`,
        `failureRate=${pattern.failureRate}`
      ],
      recommendation: "Queue a debug-failure run or add targeted eval coverage before changing workflow behavior.",
      approvalRequired: true
    });
  }

  for (const item of report.costOpportunities.slice(0, 5)) {
    addProposal({
      priority: item.fallbackRate >= 0.5 ? "high" : "medium",
      kind: "cost_routing",
      riskLevel: "medium",
      title: `Review routing for ${item.stageId}`,
      target: `${item.workflowId}/${item.stageId}/${item.agentId}`,
      rationale: `Route ${item.providerId}/${item.modelTier} has fallback=${item.fallbackRate}, latency=${item.averageLatencyMs ?? "n/a"}ms, runs=${item.runs}.`,
      evidence: [
        `provider=${item.providerId}`,
        `modelTier=${item.modelTier}`,
        `fallbackRate=${item.fallbackRate}`,
        `averageLatencyMs=${item.averageLatencyMs ?? "n/a"}`
      ],
      recommendation: item.recommendation,
      approvalRequired: true
    });
  }

  for (const gap of report.evalGaps) {
    const feedbackGap = gap.toLowerCase().includes("feedback");
    addProposal({
      priority: feedbackGap ? "medium" : "low",
      kind: feedbackGap ? "feedback_gap" : "eval_gap",
      riskLevel: "low",
      title: feedbackGap ? "Collect developer feedback" : "Improve evaluation evidence",
      target: report.projectDir,
      rationale: gap,
      evidence: [`runsAnalyzed=${report.runsAnalyzed}`, `evaluationRuns=${report.evaluationRuns}`],
      recommendation: feedbackGap
        ? "Record accepted, revised, or rejected feedback on recent workflow runs before promoting tuning changes."
        : "Create or run a small local evaluation suite before applying prompt, routing, or context-budget changes.",
      approvalRequired: false
    });
  }

  if (report.proposalPreview.total > 0) {
    addProposal({
      priority: report.proposalPreview.highPriority > 0 ? "high" : "medium",
      kind: "proposal_followup",
      riskLevel: "medium",
      title: "Review tuning proposal candidates",
      target: report.projectDir,
      rationale: `${report.proposalPreview.total} tuning proposal candidate(s), including ${report.proposalPreview.highPriority} high-priority item(s), are available.`,
      evidence: Object.entries(report.proposalPreview.byKind).map(([kind, count]) => `${kind}=${count}`),
      recommendation: "Queue tuning approvals and inspect patch plans before applying project-local tuning notes.",
      approvalRequired: true
    });
  }

  return {
    kind: "agentflow_learning_proposals",
    projectRootUri: report.projectDir,
    generatedAt: new Date().toISOString(),
    sourceReportGeneratedAt: report.generatedAt,
    sourceRunsAnalyzed: report.runsAnalyzed,
    proposals,
    summary: summarizeLearningProposals(proposals, report)
  };
}

function summarizeLearningProposals(proposals: LearningProposal[], report: LearningReport): string[] {
  if (!proposals.length) {
    return ["No learning proposal candidates were found in the inspected run window."];
  }
  const counts = countStrings(proposals.map((proposal) => proposal.kind));
  return [
    `${proposals.length} proposal candidate(s) from ${report.runsAnalyzed} run(s).`,
    `${proposals.filter((proposal) => proposal.priority === "high").length} high-priority proposal(s).`,
    `${proposals.filter((proposal) => proposal.approvalRequired).length} proposal(s) require approval before any behavior-changing action.`,
    `Kinds: ${formatInlineCounts(counts) || "none"}.`
  ];
}

function buildLearningApprovalQueue(
  proposalSet: LearningProposalSet,
  selectedIds: string[] | "all" = "all",
  existingQueue?: LearningApprovalQueue
): LearningApprovalQueue {
  const requestedIds = selectedIds === "all" ? proposalSet.proposals.map((proposal) => proposal.id) : selectedIds;
  const requestedIdSet = new Set(requestedIds);
  const selected = proposalSet.proposals.filter((proposal) => requestedIdSet.has(proposal.id));
  const selectedIdSet = new Set(selected.map((proposal) => proposal.id));
  const existingByProposal = new Map((existingQueue?.items ?? []).map((item) => [item.proposalId, item]));
  const generatedAt = new Date().toISOString();
  return {
    kind: "agentflow_learning_approval_queue",
    projectRootUri: proposalSet.projectRootUri,
    generatedAt,
    sourceGeneratedAt: proposalSet.generatedAt,
    sourceRunsAnalyzed: proposalSet.sourceRunsAnalyzed,
    skippedIds: requestedIds.filter((id) => !selectedIdSet.has(id)),
    items: selected.map((proposal) => {
      const existing = existingByProposal.get(proposal.id);
      return {
        id: existing?.id ?? `learn-approval-${proposal.id.replace(/^learn-/, "")}`,
        proposalId: proposal.id,
        status: existing?.status ?? "pending",
        createdAt: existing?.createdAt ?? generatedAt,
        decidedAt: existing?.decidedAt,
        reviewer: existing?.reviewer,
        note: existing?.note,
        proposal
      };
    })
  };
}

function decideLearningApprovals(input: {
  queue: LearningApprovalQueue;
  ids: string[] | "all";
  status: Exclude<LearningApprovalStatus, "pending">;
  reviewer?: string;
  note?: string;
}): LearningApprovalDecisionResult {
  const idSet = input.ids === "all" ? null : new Set(input.ids);
  const decidedAt = new Date().toISOString();
  const selectedIds: string[] = [];
  const matchedIds = new Set<string>();
  const items = input.queue.items.map((item) => {
    const selected = idSet === null || idSet.has(item.id) || idSet.has(item.proposalId);
    if (!selected) return item;
    selectedIds.push(item.proposalId);
    matchedIds.add(item.id);
    matchedIds.add(item.proposalId);
    return {
      ...item,
      status: input.status,
      decidedAt,
      reviewer: input.reviewer,
      note: input.note
    };
  });
  return {
    queue: {
      ...input.queue,
      generatedAt: decidedAt,
      items
    },
    selectedIds,
    skippedIds: input.ids === "all" ? [] : input.ids.filter((id) => !matchedIds.has(id))
  };
}

function formatLearningProposalSet(proposalSet: LearningProposalSet): string {
  return [
    `Learning Proposals: ${proposalSet.projectRootUri}`,
    `Generated: ${proposalSet.generatedAt}`,
    `Runs analyzed: ${proposalSet.sourceRunsAnalyzed}`,
    "",
    "Summary",
    proposalSet.summary.map((item) => `- ${item}`).join("\n"),
    "",
    "Proposals",
    proposalSet.proposals.length
      ? proposalSet.proposals.map((proposal) => [
        `- ${proposal.id} [${proposal.priority}] ${proposal.kind}: ${proposal.title}`,
        `  - Target: ${proposal.target}`,
        `  - Risk: ${proposal.riskLevel}${proposal.approvalRequired ? " approval-required" : " report-only"}`,
        `  - Rationale: ${proposal.rationale}`,
        `  - Recommendation: ${proposal.recommendation}`
      ].join("\n")).join("\n")
      : "- No learning proposals yet."
  ].join("\n");
}

function formatLearningProposalMarkdown(proposalSet: LearningProposalSet): string {
  const sections = proposalSet.proposals.map((proposal) => [
    `## ${proposal.id} - ${proposal.title}`,
    "",
    `- Priority: ${proposal.priority}`,
    `- Kind: ${proposal.kind}`,
    `- Risk: ${proposal.riskLevel}`,
    `- Target: ${proposal.target}`,
    `- Approval required: ${proposal.approvalRequired ? "yes" : "no"}`,
    `- Rationale: ${proposal.rationale}`,
    `- Recommendation: ${proposal.recommendation}`,
    "",
    "Evidence:",
    ...proposal.evidence.map((item) => `- ${item}`),
    ""
  ].join("\n"));
  return [
    "# Agent Workflow Learning Proposals",
    "",
    `Project: ${proposalSet.projectRootUri}`,
    `Generated: ${proposalSet.generatedAt}`,
    `Source report: ${proposalSet.sourceReportGeneratedAt}`,
    `Source runs analyzed: ${proposalSet.sourceRunsAnalyzed}`,
    "",
    "## Summary",
    "",
    ...proposalSet.summary.map((item) => `- ${item}`),
    "",
    ...sections
  ].join("\n");
}

function formatLearningApprovalQueue(queue: LearningApprovalQueue): string {
  const counts = countStrings(queue.items.map((item) => item.status));
  return [
    `Learning Approval Inbox: ${queue.projectRootUri}`,
    `Generated: ${queue.generatedAt}`,
    `Source runs analyzed: ${queue.sourceRunsAnalyzed}`,
    `Counts: pending=${counts.pending ?? 0} approved=${counts.approved ?? 0} rejected=${counts.rejected ?? 0}`,
    queue.skippedIds.length ? `Skipped unknown ids: ${queue.skippedIds.join(", ")}` : "",
    "",
    queue.items.length
      ? queue.items.map((item) => [
        `- ${item.proposalId} ${item.status}: ${item.proposal.title}`,
        `  - Approval id: ${item.id}`,
        `  - Risk: ${item.proposal.riskLevel}${item.proposal.approvalRequired ? " approval-required" : " report-only"}`,
        `  - Recommendation: ${item.proposal.recommendation}`,
        item.note ? `  - Note: ${item.note}` : ""
      ].filter(Boolean).join("\n")).join("\n")
      : "- No learning approval items."
  ].filter(Boolean).join("\n");
}

function formatLearningApprovalQueueMarkdown(queue: LearningApprovalQueue): string {
  const sections = queue.items.map((item) => [
    `## ${item.proposalId} - ${item.status}`,
    "",
    `- Approval id: ${item.id}`,
    `- Title: ${item.proposal.title}`,
    `- Priority: ${item.proposal.priority}`,
    `- Kind: ${item.proposal.kind}`,
    `- Risk: ${item.proposal.riskLevel}`,
    `- Target: ${item.proposal.target}`,
    `- Approval required: ${item.proposal.approvalRequired ? "yes" : "no"}`,
    `- Created: ${item.createdAt}`,
    item.decidedAt ? `- Decided: ${item.decidedAt}` : "",
    item.reviewer ? `- Reviewer: ${item.reviewer}` : "",
    item.note ? `- Note: ${item.note}` : "",
    `- Rationale: ${item.proposal.rationale}`,
    `- Recommendation: ${item.proposal.recommendation}`,
    "",
    "Evidence:",
    ...item.proposal.evidence.map((evidence) => `- ${evidence}`),
    ""
  ].filter(Boolean).join("\n"));
  return [
    "# Agent Workflow Learning Approval Inbox",
    "",
    `Project: ${queue.projectRootUri}`,
    `Generated: ${queue.generatedAt}`,
    `Source proposals: ${queue.sourceGeneratedAt}`,
    `Source runs analyzed: ${queue.sourceRunsAnalyzed}`,
    "",
    ...sections
  ].join("\n");
}

async function loadDashboardModelImprovementReport(input: {
  projectDir: string;
  limit: number;
}): Promise<DashboardModelImprovementReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const scorecard = await loadPreferenceScorecard({ projectDir, limit: input.limit });
  const proposals = buildTuningProposals(scorecard);
  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: input.limit });
  const evaluationRunList = projectRuns.filter((run) => typeof run.evaluationMetadata?.suiteId === "string");
  const proposalCounts = countStrings(proposals.proposals.map((proposal) => proposal.kind));
  const highPriorityProposals = proposals.proposals.filter((proposal) => proposal.priority === "high").length;
  const feedbackNeeded = proposals.proposals.filter((proposal) => proposal.kind === "feedback_needed").length;
  const routingProposals = proposals.proposals.filter((proposal) => proposal.kind === "routing_preference").length;
  const feedbackTotal = Object.values(scorecard.feedbackCounts).reduce((sum, value) => sum + value, 0);
  const readiness: string[] = [];
  if (scorecard.runsAnalyzed === 0) {
    readiness.push("Run at least one workflow before diagnosing model improvement.");
  }
  if (feedbackTotal === 0) {
    readiness.push("Record accepted, revised, or rejected feedback before applying tuning.");
  }
  if (evaluationRunList.length === 0) {
    readiness.push("Add or run an evaluation suite before promoting routing or prompt changes.");
  }
  if (highPriorityProposals > 0) {
    readiness.push("Review high-priority proposals before repeating affected workflows.");
  }
  if (!readiness.length) {
    readiness.push("Local evidence is ready for baseline-versus-candidate comparison.");
  }
  const promotionReady = scorecard.runsAnalyzed > 0 && feedbackTotal > 0 && evaluationRunList.length > 0 && highPriorityProposals === 0;
  return {
    generatedAt: new Date().toISOString(),
    projectDir,
    scorecard,
    proposals,
    evaluationRuns: evaluationRunList.length,
    latestEvaluationAt: evaluationRunList.map((run) => run.startedAt).sort().at(-1) ?? null,
    proposalCounts,
    highPriorityProposals,
    feedbackNeeded,
    routingProposals,
    promotionReady,
    readiness,
    nextCommands: [
      `npm run agentflow -- quality-report --run <run-id>`,
      `npm run agentflow -- feedback --run <run-id> --rating accepted|revised|rejected --note "<why>"`,
      `npm run agentflow -- tuning-proposals --project ${shellQuote(projectDir)}`,
      `npm run agentflow -- run-and-watch model-improvement --project ${shellQuote(projectDir)} --task "Improve quality while reducing cost"`
    ]
  };
}

async function loadDashboardCandidateComparisonReport(input: {
  projectDir: string;
}): Promise<DashboardCandidateComparisonReport> {
  const projectDir = path.resolve(process.cwd(), input.projectDir);
  const modelPlanPath = path.join(projectDir, ".agent-workflow", "model-improvement", "model-improvement-plan.json");
  const comparisonPlanPath = path.join(projectDir, ".agent-workflow", "model-improvement", "candidate-comparison-plan.json");
  const modelPlanResult = await readDashboardJsonFile<Omit<ModelImprovementPlan, "files">>(modelPlanPath, (value) =>
    value.kind === "agentflow_model_improvement_plan" && Array.isArray(value.evalCases)
  );
  const comparisonPlanResult = await readDashboardJsonFile<Omit<CandidateComparisonPlan, "files">>(comparisonPlanPath, (value) =>
    value.kind === "agentflow_candidate_comparison_plan" && Array.isArray(value.suites)
  );
  const comparisonPlan = comparisonPlanResult.value;
  const suiteFiles = (comparisonPlan?.suites ?? []).map((suite) => {
    const relativePath = suite.suitePath;
    const absolutePath = path.resolve(projectDir, relativePath);
    return {
      path: relativePath,
      exists: absolutePath.startsWith(`${projectDir}${path.sep}`) && fsSync.existsSync(absolutePath)
    };
  });
  const evaluationSuites = comparisonPlan ? await loadDashboardEvaluations(500) : [];
  const outcomes = (comparisonPlan?.suites ?? []).map((suite) => {
    const evaluation = evaluationSuites.find((item) => item.id === suite.id);
    const baseline = evaluation?.variants.find((variant) => variant.id.startsWith("baseline-")) ?? null;
    const candidate = evaluation?.variants.find((variant) => variant.id.startsWith("candidate-")) ?? null;
    return {
      suiteId: suite.id,
      runs: evaluation?.runs.length ?? 0,
      leader: evaluation?.leader ?? null,
      latestAt: evaluation?.latestAt || null,
      baselineRuns: baseline?.runs ?? 0,
      candidateRuns: candidate?.runs ?? 0,
      baselineQuality: baseline?.averageQuality ?? null,
      candidateQuality: candidate?.averageQuality ?? null,
      qualityDelta: baseline?.averageQuality !== null && baseline?.averageQuality !== undefined && candidate?.averageQuality !== null && candidate?.averageQuality !== undefined
        ? Math.round((candidate.averageQuality - baseline.averageQuality) * 1000) / 1000
        : null,
      baselineLatencyMs: baseline?.averageLatencyMs ?? null,
      candidateLatencyMs: candidate?.averageLatencyMs ?? null,
      latencyDeltaMs: baseline?.averageLatencyMs !== null && baseline?.averageLatencyMs !== undefined && candidate?.averageLatencyMs !== null && candidate?.averageLatencyMs !== undefined
        ? candidate.averageLatencyMs - baseline.averageLatencyMs
        : null,
      gateReady: Boolean((baseline?.runs ?? 0) > 0 && (candidate?.runs ?? 0) > 0)
    };
  });
  const promotionRecommendations = outcomes.map((outcome) =>
    buildCandidatePromotionRecommendation({
      projectDir,
      suite: comparisonPlan?.suites.find((suite) => suite.id === outcome.suiteId) ?? null,
      outcome
    })
  );
  const promotionNoteFiles = await readPromotionRoutingNoteFiles(projectDir);
  const readiness: string[] = [];
  if (!modelPlanResult.exists) {
    readiness.push("Write a model-improvement plan before preparing candidate comparisons.");
  } else if (modelPlanResult.error) {
    readiness.push(`Model-improvement plan is unreadable: ${modelPlanResult.error}`);
  }
  if (!comparisonPlanResult.exists) {
    readiness.push("Run candidate-comparison-plan with --write to create local comparison files.");
  } else if (comparisonPlanResult.error) {
    readiness.push(`Candidate comparison plan is unreadable: ${comparisonPlanResult.error}`);
  }
  const missingSuites = suiteFiles.filter((suite) => !suite.exists).length;
  if (missingSuites) {
    readiness.push(`${missingSuites} generated evaluation suite file(s) are missing.`);
  }
  const unevaluatedSuites = outcomes.filter((outcome) => outcome.runs === 0).length;
  if (comparisonPlan && unevaluatedSuites) {
    readiness.push(`${unevaluatedSuites} candidate comparison suite(s) have not been evaluated yet.`);
  }
  if (!readiness.length) {
    readiness.push("Candidate comparison evidence is present. Run the gate before promoting routing or prompt changes.");
  }
  return {
    generatedAt: new Date().toISOString(),
    projectDir,
    modelPlanPath,
    comparisonPlanPath,
    modelPlanExists: modelPlanResult.exists,
    comparisonPlanExists: comparisonPlanResult.exists,
    modelPlanError: modelPlanResult.error,
    comparisonPlanError: comparisonPlanResult.error,
    modelPlan: modelPlanResult.value,
    comparisonPlan,
    suiteFiles,
    outcomes,
    promotionRecommendations,
    promotionNoteFiles,
    readiness,
    nextCommands: [
      `npm run agentflow -- model-improvement-plan --project ${shellQuote(projectDir)} --write`,
      `npm run agentflow -- candidate-comparison-plan --project ${shellQuote(projectDir)} --write`,
      ...(comparisonPlan?.suites.map((suite) => suite.command) ?? []),
      `npm run agentflow -- gate --run <candidate-run-id> --baseline-run <baseline-run-id> --project ${shellQuote(projectDir)}`
    ]
  };
}

function buildCandidatePromotionRecommendation(input: {
  projectDir: string;
  suite: Omit<CandidateComparisonPlan, "files">["suites"][number] | null;
  outcome: DashboardCandidateComparisonReport["outcomes"][number];
}): DashboardCandidateComparisonReport["promotionRecommendations"][number] {
  const rationale: string[] = [];
  const suiteCommand = input.suite?.command ?? `npm run agentflow -- evaluate -s .agent-workflow/evaluations/${input.outcome.suiteId}.yaml -p ${shellQuote(input.projectDir)}`;
  if (!input.outcome.gateReady || input.outcome.qualityDelta === null) {
    rationale.push("Baseline and candidate evidence must both be present before promotion.");
    if (input.outcome.baselineRuns === 0) {
      rationale.push("No baseline evaluation run is recorded.");
    }
    if (input.outcome.candidateRuns === 0) {
      rationale.push("No candidate evaluation run is recorded.");
    }
    return {
      suiteId: input.outcome.suiteId,
      decision: "run_more_evals",
      severity: "warning",
      rationale,
      nextAction: suiteCommand
    };
  }
  const latencyDelta = input.outcome.latencyDeltaMs;
  const isMaterialQualityGain = input.outcome.qualityDelta >= 0.05;
  const isQualityRegression = input.outcome.qualityDelta < 0;
  const isLatencyRegression = latencyDelta !== null && latencyDelta > 500;
  if (isQualityRegression) {
    rationale.push(`Candidate quality is lower than baseline by ${input.outcome.qualityDelta}.`);
    if (latencyDelta !== null) {
      rationale.push(`Latency delta is ${formatDurationDelta(latencyDelta)}.`);
    }
    return {
      suiteId: input.outcome.suiteId,
      decision: "keep_baseline",
      severity: "warning",
      rationale,
      nextAction: "Keep the current baseline routing and review candidate prompt/provider changes before retesting."
    };
  }
  if (isLatencyRegression && !isMaterialQualityGain) {
    rationale.push(`Candidate quality delta is ${input.outcome.qualityDelta}, but latency is ${formatDurationDelta(latencyDelta)} slower.`);
    rationale.push("The quality gain is not large enough to justify a slower default route.");
    return {
      suiteId: input.outcome.suiteId,
      decision: "run_more_evals",
      severity: "warning",
      rationale,
      nextAction: "Add more representative eval cases or retest with a cheaper/faster candidate before changing routing."
    };
  }
  rationale.push(`Candidate quality delta is ${input.outcome.qualityDelta}.`);
  if (latencyDelta !== null) {
    rationale.push(`Latency delta is ${formatDurationDelta(latencyDelta)}.`);
  }
  rationale.push("Promotion should still be applied as a reviewed project-local routing note.");
  return {
    suiteId: input.outcome.suiteId,
    decision: "propose_routing_note",
    severity: "ready",
    rationale,
    nextAction: `Create a reviewed project-local note under .agent-workflow/tuning/ after running the gate command for ${input.outcome.suiteId}.`
  };
}

function buildPromotionRoutingNotePlan(
  report: DashboardCandidateComparisonReport,
  selectedSuiteIds: string[] | "all" = "all"
): DashboardPromotionRoutingNotePlan {
  const requestedSuiteIds = selectedSuiteIds === "all"
    ? report.promotionRecommendations.map((recommendation) => recommendation.suiteId)
    : selectedSuiteIds;
  const requestedSet = new Set(requestedSuiteIds);
  const selectedRecommendations = report.promotionRecommendations.filter((recommendation) =>
    requestedSet.has(recommendation.suiteId) && recommendation.decision === "propose_routing_note"
  );
  const selectedSet = new Set(selectedRecommendations.map((recommendation) => recommendation.suiteId));
  const generatedAt = new Date().toISOString();
  const notes = selectedRecommendations.map((recommendation) => {
    const suite = report.comparisonPlan?.suites.find((item) => item.id === recommendation.suiteId) ?? null;
    const outcome = report.outcomes.find((item) => item.suiteId === recommendation.suiteId) ?? null;
    const gateCommand = report.comparisonPlan?.gateCommands.find((command) => command.includes("--gate") || command.includes(" gate ")) ?? report.comparisonPlan?.gateCommands[0] ?? null;
    return {
      suiteId: recommendation.suiteId,
      workflowId: suite?.workflowId ?? "unknown",
      baseline: report.comparisonPlan?.baseline ?? null,
      candidate: report.comparisonPlan?.candidate ?? null,
      qualityDelta: outcome?.qualityDelta ?? null,
      latencyDeltaMs: outcome?.latencyDeltaMs ?? null,
      gateCommand,
      rationale: recommendation.rationale,
      draftNote: [
        `Prefer the candidate route for ${suite?.workflowId ?? recommendation.suiteId} only after the recorded gate passes.`,
        report.comparisonPlan?.candidate
          ? `Candidate: ${report.comparisonPlan.candidate.provider}/${report.comparisonPlan.candidate.modelTier}.`
          : "Candidate route details were not available.",
        outcome?.qualityDelta !== null && outcome?.qualityDelta !== undefined
          ? `Observed quality delta: ${outcome.qualityDelta}.`
          : "Quality delta must be confirmed before applying.",
        outcome?.latencyDeltaMs !== null && outcome?.latencyDeltaMs !== undefined
          ? `Observed latency delta: ${formatDurationDelta(outcome.latencyDeltaMs)}.`
          : "Latency delta must be confirmed before applying."
      ].join(" ")
    };
  });
  const document = {
    kind: "agentflow_promotion_routing_note_plan" as const,
    projectRootUri: report.projectDir,
    generatedAt,
    sourceComparisonPlanGeneratedAt: report.comparisonPlan?.generatedAt ?? null,
    selectedSuiteIds: selectedRecommendations.map((recommendation) => recommendation.suiteId),
    skippedSuiteIds: requestedSuiteIds.filter((suiteId) => !selectedSet.has(suiteId)),
    notes
  };
  return {
    ...document,
    files: [
      {
        relativePath: ".agent-workflow/tuning/promotion-routing-note-plan.md",
        content: formatPromotionRoutingNotePlanMarkdown(document)
      },
      {
        relativePath: ".agent-workflow/tuning/promotion-routing-note-plan.json",
        content: `${JSON.stringify(document, null, 2)}\n`
      }
    ]
  };
}

function formatPromotionRoutingNotePlan(plan: DashboardPromotionRoutingNotePlan): string {
  return [
    `Promotion Routing Note Plan: ${plan.projectRootUri}`,
    `Generated: ${plan.generatedAt}`,
    `Selected promotable suites: ${plan.selectedSuiteIds.length ? plan.selectedSuiteIds.join(", ") : "none"}`,
    plan.skippedSuiteIds.length ? `Skipped suites: ${plan.skippedSuiteIds.join(", ")}` : "",
    "",
    "Files",
    plan.files.map((file) => `- ${file.relativePath} (${file.content.length} bytes)`).join("\n")
  ].filter(Boolean).join("\n");
}

function formatPromotionRoutingNotePlanMarkdown(plan: Omit<DashboardPromotionRoutingNotePlan, "files">): string {
  return [
    "# Agent Workflow Promotion Routing Note Plan",
    "",
    `Generated: ${plan.generatedAt}`,
    `Project: ${plan.projectRootUri}`,
    plan.sourceComparisonPlanGeneratedAt ? `Source comparison plan: ${plan.sourceComparisonPlanGeneratedAt}` : "Source comparison plan: unavailable",
    "",
    "This plan is review-only. It does not change live routing. Apply any routing preference only after a project-local gate passes and a human reviews the note.",
    "",
    "## Draft Notes",
    "",
    plan.notes.length
      ? plan.notes.map((note) => [
        `### ${note.suiteId}`,
        "",
        `- Workflow: ${note.workflowId}`,
        `- Baseline: ${note.baseline ? `${note.baseline.provider}/${note.baseline.modelTier}` : "unavailable"}`,
        `- Candidate: ${note.candidate ? `${note.candidate.provider}/${note.candidate.modelTier}` : "unavailable"}`,
        `- Quality delta: ${note.qualityDelta ?? "unavailable"}`,
        `- Latency delta: ${note.latencyDeltaMs === null ? "unavailable" : formatDurationDelta(note.latencyDeltaMs)}`,
        note.gateCommand ? `- Gate: ${note.gateCommand}` : "- Gate: run a baseline-versus-candidate gate before applying.",
        "",
        "Rationale:",
        note.rationale.map((item) => `- ${item}`).join("\n"),
        "",
        "Draft routing note:",
        "",
        note.draftNote,
        ""
      ].join("\n")).join("\n")
      : "_No promotable candidate comparison suites selected._",
    ""
  ].join("\n");
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

async function readLearningApprovalQueue(projectDir: string): Promise<LearningApprovalQueue> {
  const queuePath = path.join(projectDir, ".agent-workflow", "learning", "approval-inbox.json");
  const raw = await fs.readFile(queuePath, "utf8");
  const parsed = JSON.parse(raw) as LearningApprovalQueue;
  if (parsed.kind !== "agentflow_learning_approval_queue" || !Array.isArray(parsed.items)) {
    throw new Error(`Invalid learning approval inbox: ${queuePath}`);
  }
  return parsed;
}

async function writeLearningProposals(projectDir: string, proposalSet: LearningProposalSet): Promise<void> {
  const learningDir = path.join(projectDir, ".agent-workflow", "learning");
  await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
  await fs.writeFile(path.join(learningDir, "proposals.json"), `${JSON.stringify(proposalSet, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(learningDir, "proposals.md"), formatLearningProposalMarkdown(proposalSet), "utf8");
}

async function writeLearningApprovalQueue(projectDir: string, queue: LearningApprovalQueue): Promise<void> {
  const learningDir = path.join(projectDir, ".agent-workflow", "learning");
  await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
  await fs.writeFile(path.join(learningDir, "approval-inbox.json"), `${JSON.stringify(queue, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(learningDir, "approval-inbox.md"), formatLearningApprovalQueueMarkdown(queue), "utf8");
}

async function runLearningDaemonTick(input: {
  projectDir: string;
  mode: LearningDaemonMode;
  limit: number;
}): Promise<{ report: LearningReport; proposalSet: LearningProposalSet; approvalQueue: LearningApprovalQueue }> {
  const report = await loadLearningReport({ projectDir: input.projectDir, limit: input.limit });
  const proposalSet = buildLearningProposalSet(report);
  const existingQueue = await readLearningApprovalQueue(input.projectDir).catch(() => undefined);
  const approvalQueue = buildLearningApprovalQueue(proposalSet, "all", existingQueue);
  await writeLearningReport(input.projectDir, report);
  if (input.mode === "propose") {
    await writeLearningProposals(input.projectDir, proposalSet);
    await writeLearningApprovalQueue(input.projectDir, approvalQueue);
  }
  return { report, proposalSet, approvalQueue };
}

async function writeLearningReport(projectDir: string, report: LearningReport): Promise<void> {
  const reportsDir = path.join(projectDir, ".agent-workflow", "learning", "reports");
  await ensureProjectSubdir(projectDir, reportsDir, ".agent-workflow/learning/reports");
  await fs.writeFile(path.join(reportsDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(reportsDir, "latest.md"), `${formatLearningReport(report)}\n`, "utf8");
}

async function writeLearningDaemonStatus(projectDir: string, status: LearningDaemonHeartbeat, heartbeatFile: string): Promise<void> {
  const learningDir = path.join(projectDir, ".agent-workflow", "learning");
  await ensureProjectSubdir(projectDir, learningDir, ".agent-workflow/learning");
  const resolvedHeartbeat = path.resolve(heartbeatFile);
  const projectRoot = path.resolve(projectDir);
  if (!resolvedHeartbeat.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Refusing to write learning daemon status outside project: ${heartbeatFile}`);
  }
  await fs.mkdir(path.dirname(resolvedHeartbeat), { recursive: true });
  await fs.writeFile(resolvedHeartbeat, `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

async function ensureProjectSubdir(projectDir: string, targetDir: string, label: string): Promise<void> {
  const projectRoot = path.resolve(projectDir);
  const resolved = path.resolve(targetDir);
  if (!resolved.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`Refusing to write outside project ${label}: ${targetDir}`);
  }
  await fs.mkdir(resolved, { recursive: true });
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

async function writeModelImprovementPlan(projectDir: string, plan: ModelImprovementPlan): Promise<void> {
  for (const file of plan.files) {
    if (!file.relativePath.startsWith(".agent-workflow/model-improvement/")) {
      throw new Error(`Refusing to write model-improvement plan outside .agent-workflow/model-improvement: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectDir, file.relativePath);
    const projectRoot = path.resolve(projectDir);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write model-improvement plan outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

async function readModelImprovementPlan(projectDir: string): Promise<Omit<ModelImprovementPlan, "files">> {
  const planPath = path.join(projectDir, ".agent-workflow", "model-improvement", "model-improvement-plan.json");
  const raw = await fs.readFile(planPath, "utf8");
  const parsed = JSON.parse(raw) as Omit<ModelImprovementPlan, "files">;
  if (parsed.kind !== "agentflow_model_improvement_plan" || !Array.isArray(parsed.evalCases) || !Array.isArray(parsed.datasetPlans)) {
    throw new Error(`Invalid model-improvement plan: ${planPath}`);
  }
  return parsed;
}

async function writeCandidateComparisonPlan(projectDir: string, plan: CandidateComparisonPlan): Promise<void> {
  for (const file of plan.files) {
    const allowed =
      file.relativePath.startsWith(".agent-workflow/model-improvement/") ||
      file.relativePath.startsWith(".agent-workflow/evaluations/");
    if (!allowed) {
      throw new Error(`Refusing to write candidate comparison plan outside project-local Agent Workflow paths: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectDir, file.relativePath);
    const projectRoot = path.resolve(projectDir);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write candidate comparison plan outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

async function writePromotionRoutingNotePlan(projectDir: string, plan: DashboardPromotionRoutingNotePlan): Promise<void> {
  for (const file of plan.files) {
    if (!file.relativePath.startsWith(".agent-workflow/tuning/")) {
      throw new Error(`Refusing to write promotion routing note plan outside .agent-workflow/tuning: ${file.relativePath}`);
    }
    const targetPath = path.resolve(projectDir, file.relativePath);
    const projectRoot = path.resolve(projectDir);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Refusing to write promotion routing note plan outside project: ${file.relativePath}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, file.content, "utf8");
  }
}

async function readPromotionRoutingNoteFiles(projectDir: string): Promise<DashboardPromotionNoteFileSummary[]> {
  const files = [
    ".agent-workflow/tuning/promotion-routing-note-plan.md",
    ".agent-workflow/tuning/promotion-routing-note-plan.json"
  ];
  const projectRoot = path.resolve(projectDir);
  const summaries: DashboardPromotionNoteFileSummary[] = [];
  for (const relativePath of files) {
    const targetPath = path.resolve(projectRoot, relativePath);
    if (!targetPath.startsWith(`${projectRoot}${path.sep}`)) {
      summaries.push({ path: relativePath, exists: false, bytes: 0, modifiedAt: null, preview: null, error: "path escaped project" });
      continue;
    }
    try {
      const stat = await fs.stat(targetPath);
      const content = await fs.readFile(targetPath, "utf8");
      summaries.push({
        path: relativePath,
        exists: true,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        preview: relativePath.endsWith(".md") ? truncateDashboardPreview(content, 4000) : null,
        error: null
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        summaries.push({ path: relativePath, exists: false, bytes: 0, modifiedAt: null, preview: null, error: null });
      } else {
        summaries.push({
          path: relativePath,
          exists: true,
          bytes: 0,
          modifiedAt: null,
          preview: null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return summaries;
}

function truncateDashboardPreview(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars).trimEnd()}\n\n...truncated for dashboard preview...`;
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
      workerConcurrency: form.get("workerConcurrency") ?? "",
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
      workerConcurrency: form.get("workerConcurrency") ?? "",
      project: form.get("project") ?? "",
      reason: form.get("reason") ?? "",
      confirmed: form.get("confirmed") === "on"
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/approval-action") {
    const form = await readFormBody(request);
    const result = await processDashboardApprovalAction({
      approvalId: form.get("approvalId") ?? "",
      decision: form.get("decision") ?? "",
      actorRole: form.get("actorRole") ?? "",
      note: form.get("note") ?? ""
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/artifact-lifecycle-action") {
    const form = await readFormBody(request);
    const result = await processDashboardArtifactLifecycleAction({
      action: form.get("action") ?? "",
      project: form.get("project") ?? "",
      kind: form.get("kind") ?? "",
      limit: form.get("limit") ?? "",
      minAgeDays: form.get("minAgeDays") ?? "",
      minBytes: form.get("minBytes") ?? "",
      includeAudit: form.get("includeAudit") === "true",
      actorRole: form.get("actorRole") ?? ""
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
      workerConcurrency: form.get("workerConcurrency") ?? "",
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

  if (request.method === "POST" && requestUrl.pathname === "/api/graph-handoff-export") {
    const form = await readFormBody(request);
    const result = await exportDashboardWorkflowGraphHandoff(form);
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (requestUrl.pathname === "/graph-handoff") {
    const result = await loadDashboardGraphHandoffView(requestUrl.searchParams);
    response.writeHead(result.ok ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardGraphHandoffView(result));
    return;
  }

  if (requestUrl.pathname === "/role-audit") {
    const result = await loadDashboardRoleAuditView(requestUrl.searchParams);
    response.writeHead(result.ok ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardRoleAuditView(result));
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

  if (request.method === "POST" && requestUrl.pathname === "/api/bundle-lifecycle-plan") {
    const form = await readFormBody(request);
    const result = await processDashboardBundleLifecyclePlan({
      project: form.get("project") ?? "",
      bundleId: form.get("bundleId") ?? "",
      mode: form.get("mode") ?? "",
      targetVersion: form.get("targetVersion") ?? "",
      registry: form.get("registry") ?? "",
      write: form.get("write") === "on"
    });
    response.writeHead(result.ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
    response.end(renderDashboardActionResult(result));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/role-audit-export") {
    const form = await readFormBody(request);
    const result = await processDashboardRoleAuditExport({
      project: form.get("project") ?? "",
      limit: form.get("limit") ?? "",
      role: form.get("role") ?? "",
      status: form.get("status") ?? "",
      actionType: form.get("action") ?? "",
      out: form.get("out") ?? ""
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
      workflowId: form.get("workflowId") ?? undefined,
      stageId: form.get("stageId") ?? undefined,
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
    const queue = await listWorkflowQueue(100, {
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(queue, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/approvals") {
    const status = requestUrl.searchParams.get("status") ?? "pending";
    const approvals = await listActionApprovals({
      status: status === "all" ? undefined : status,
      runId: requestUrl.searchParams.get("run") ?? undefined,
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100)
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(approvals, null, 2));
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

  if (requestUrl.pathname === "/api/roles") {
    const report = await loadRoleGovernanceReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50),
      role: requestUrl.searchParams.get("role") ?? undefined,
      status: requestUrl.searchParams.get("status") ?? undefined,
      actionType: requestUrl.searchParams.get("action") ?? undefined
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/artifact-lifecycle") {
    const report = await loadArtifactLifecycleReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      kind: requestUrl.searchParams.get("kind") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500),
      prunePlan: requestUrl.searchParams.get("prunePlan") === "true",
      archivePlan: requestUrl.searchParams.get("archivePlan") === "true",
      restorePlan: requestUrl.searchParams.get("restorePlan") === "true",
      minAgeDays: requestUrl.searchParams.has("minAgeDays") ? parseNonNegativeInteger(requestUrl.searchParams.get("minAgeDays") ?? "", 30) : undefined,
      minBytes: requestUrl.searchParams.has("minBytes") ? parseNonNegativeInteger(requestUrl.searchParams.get("minBytes") ?? "", 20_000) : undefined,
      includeAudit: requestUrl.searchParams.has("includeAudit") ? requestUrl.searchParams.get("includeAudit") === "true" : undefined
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/backup-report") {
    const report = await loadBackupRestoreReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500)
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/server-readiness") {
    const report = await loadServerReadinessReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100)
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/server-projects") {
    const report = await loadServerProjectRegistryReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100),
      includeRoots: requestUrl.searchParams.get("includeRoots") === "true"
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/server-project") {
    const projectId = requestUrl.searchParams.get("projectId") ?? "";
    const result = await resolveServerProjectReference({
      projectId,
      includeRoot: requestUrl.searchParams.get("includeRoot") === "true"
    });
    response.writeHead(result.resolved ? 200 : 404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(result, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/server-request-preview") {
    const report = await loadServerRequestPreview({
      projectId: requestUrl.searchParams.get("projectId") ?? "",
      workflowId: requestUrl.searchParams.get("workflow") ?? "",
      task: requestUrl.searchParams.get("task") ?? "",
      actor: requestUrl.searchParams.get("actor") ?? "dashboard-preview",
      actorRole: requestUrl.searchParams.get("actorRole") ?? "operator",
      idempotencyKey: requestUrl.searchParams.get("idempotencyKey") ?? undefined
    });
    response.writeHead(report.status === "blocked" ? 400 : 200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/server-route-preview") {
    const report = await loadServerRoutePreview({
      projectId: requestUrl.searchParams.get("projectId") ?? "",
      workflowId: requestUrl.searchParams.get("workflow") ?? "",
      task: requestUrl.searchParams.get("task") ?? "",
      actor: requestUrl.searchParams.get("actor") ?? "dashboard-preview",
      actorRole: requestUrl.searchParams.get("actorRole") ?? "operator",
      idempotencyKey: requestUrl.searchParams.get("idempotencyKey") ?? undefined
    });
    response.writeHead(report.status === "blocked" ? 400 : 200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/api/server-queue") {
    const body = await readJsonBody(request);
    const report = await processServerQueueRequest(request, body);
    response.writeHead(report.status === "blocked" ? 400 : report.status === "queued" ? 201 : 200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/bundles") {
    const readiness = await loadDashboardBundleReadiness(requestUrl.searchParams);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(readiness, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/bundle-registry") {
    const report = await loadDashboardBundleRegistry(requestUrl.searchParams);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/workflow-graph") {
    const report = await loadDashboardWorkflowGraph(requestUrl.searchParams);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/info" || requestUrl.pathname === "/api/settings") {
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

  if (requestUrl.pathname === "/api/observability") {
    const runId = requestUrl.searchParams.get("id");
    if (!runId) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing id");
      return;
    }
    const report = await loadObservabilityReport(runId);
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

  if (requestUrl.pathname === "/api/model-improvement") {
    const project = requestUrl.searchParams.get("project");
    if (!project) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing project");
      return;
    }
    const report = await loadDashboardModelImprovementReport({
      projectDir: project,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/learning-report") {
    const project = requestUrl.searchParams.get("project");
    if (!project) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing project");
      return;
    }
    const report = await loadLearningReport({
      projectDir: project,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
    });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/learning-proposals") {
    const project = requestUrl.searchParams.get("project");
    if (!project) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing project");
      return;
    }
    const report = await loadLearningReport({
      projectDir: project,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
    });
    const proposalSet = buildLearningProposalSet(report);
    const existingQueue = await readLearningApprovalQueue(project).catch(() => undefined);
    const queue = buildLearningApprovalQueue(proposalSet, parseProposalIds(requestUrl.searchParams.get("ids") ?? "all"), existingQueue);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ...proposalSet, approvalQueue: queue, mode: "dry-run" }, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/learning-daemon-status") {
    const project = requestUrl.searchParams.get("project");
    if (!project) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing project");
      return;
    }
    const status = await loadLearningDaemonStatus(project);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(status, null, 2));
    return;
  }

  if (requestUrl.pathname === "/api/candidate-comparisons") {
    const project = requestUrl.searchParams.get("project");
    if (!project) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing project");
      return;
    }
    const report = await loadDashboardCandidateComparisonReport({ projectDir: project });
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(report, null, 2));
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
    const observabilityReport = buildObservabilityReport({
      run: details.run,
      tasks: details.tasks,
      receipts: details.receipts,
      artifacts,
      version: program.version()
    });
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
      observabilityReport,
      usageEstimate,
      preferenceScorecard,
      tuningProposals
    }));
    return;
  }

  if (requestUrl.pathname === "/queue") {
    const queue = await listWorkflowQueue(100, {
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined
    });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderQueueHtml(queue, requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/approvals") {
    const status = requestUrl.searchParams.get("status") ?? "pending";
    const approvals = await listActionApprovals({
      status: status === "all" ? undefined : status,
      runId: requestUrl.searchParams.get("run") ?? undefined,
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100)
    });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderApprovalsHtml(approvals, status));
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

  if (requestUrl.pathname === "/workflow-graph") {
    const report = await loadDashboardWorkflowGraph(requestUrl.searchParams);
    const workflows = await loadWorkflows(rootDir);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderWorkflowGraphDashboardHtml(report, workflows, requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/model-improvement") {
    const projects = await listProjectStorageSummaries(100);
    const project = requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? projects[0]?.rootUri ?? "";
    const report = project
      ? await loadDashboardModelImprovementReport({
        projectDir: project,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      })
      : null;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderModelImprovementHtml(report, projects, requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/learning") {
    const projects = await listProjectStorageSummaries(100);
    const project = requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? projects[0]?.rootUri ?? "";
    const report = project
      ? await loadLearningReport({
        projectDir: project,
        limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50)
      })
      : null;
    const learningQueue = project ? await readLearningApprovalQueue(project).catch(() => null) : null;
    const learningDaemon = project ? await loadLearningDaemonStatus(project) : null;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderLearningDashboardHtml(report, learningQueue, learningDaemon, projects, requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/candidate-comparisons") {
    const projects = await listProjectStorageSummaries(100);
    const project = requestUrl.searchParams.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? projects[0]?.rootUri ?? "";
    const report = project ? await loadDashboardCandidateComparisonReport({ projectDir: project }) : null;
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderCandidateComparisonsHtml(report, projects, requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/governance") {
    const report = await loadGovernanceReport(parsePositiveInteger(requestUrl.searchParams.get("staleMinutes") ?? "15", 15), requestUrl.searchParams.get("includeEphemeral") === "true");
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderGovernanceHtml(filterGovernanceReport(report, requestUrl.searchParams), requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/roles") {
    const report = await loadRoleGovernanceReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "50", 50),
      role: requestUrl.searchParams.get("role") ?? undefined,
      status: requestUrl.searchParams.get("status") ?? undefined,
      actionType: requestUrl.searchParams.get("action") ?? undefined
    });
    const projects = await listProjectStorageSummaries(100);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderRolesHtml(report, projects, requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/artifact-lifecycle") {
    const report = await loadArtifactLifecycleReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      kind: requestUrl.searchParams.get("kind") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500),
      prunePlan: requestUrl.searchParams.get("prunePlan") === "true",
      archivePlan: requestUrl.searchParams.get("archivePlan") === "true",
      restorePlan: requestUrl.searchParams.get("restorePlan") === "true",
      minAgeDays: requestUrl.searchParams.has("minAgeDays") ? parseNonNegativeInteger(requestUrl.searchParams.get("minAgeDays") ?? "", 30) : undefined,
      minBytes: requestUrl.searchParams.has("minBytes") ? parseNonNegativeInteger(requestUrl.searchParams.get("minBytes") ?? "", 20_000) : undefined,
      includeAudit: requestUrl.searchParams.has("includeAudit") ? requestUrl.searchParams.get("includeAudit") === "true" : undefined
    });
    const projects = await listProjectStorageSummaries(100);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderArtifactLifecycleHtml(report, projects, requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/backup-report") {
    const report = await loadBackupRestoreReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "500", 500)
    });
    const projects = await listProjectStorageSummaries(100);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderBackupRestoreHtml(report, projects, requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/server-readiness") {
    const report = await loadServerReadinessReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100)
    });
    const registry = await loadServerProjectRegistryReport({
      projectRootUri: requestUrl.searchParams.get("project") ?? undefined,
      limit: parsePositiveInteger(requestUrl.searchParams.get("limit") ?? "100", 100),
      includeRoots: requestUrl.searchParams.get("includeRoots") === "true"
    });
    const projects = await listProjectStorageSummaries(100);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderServerReadinessHtml(report, registry, projects, requestUrl.searchParams));
    return;
  }

  if (requestUrl.pathname === "/bundles") {
    const readiness = await loadDashboardBundleReadiness(requestUrl.searchParams);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderBundleTrustHtml(readiness, requestUrl.searchParams));
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
    const info = await withTimeout(
      loadDashboardInfo(dashboardUrlFromRequest(request)),
      3000,
      () => loadDashboardInfoFast(dashboardUrlFromRequest(request))
    );
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderProvidersHtml(info));
    return;
  }

  if (requestUrl.pathname === "/info" || requestUrl.pathname === "/settings") {
    const info = await withTimeout(
      loadDashboardInfo(dashboardUrlFromRequest(request)),
      1200,
      () => loadDashboardInfoFast(dashboardUrlFromRequest(request))
    );
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
        <a class="button secondary" href="/workflow-graph">Graph</a>
        <a class="button secondary" href="/providers">Providers</a>
        <a class="button secondary" href="/settings">Settings</a>
        <a class="button secondary" href="/api/runs">JSON</a>
      </div>
    </div>
    <section class="panel">
      <h2>System Health</h2>
      ${renderDashboardHealthHtml(health)}
    </section>
    ${renderDashboardOperationsSnapshotHtml(health)}
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
        <label>Worker concurrency
          <input name="workerConcurrency" inputmode="numeric" value="1">
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

function renderQueueHtml(queue: DashboardQueueItem[], params: URLSearchParams): string {
  const projectFilter = params.get("project")?.trim() || "";
  const active = queue.filter((item) => item.runStatus === "queued" || item.runStatus === "running");
  const failed = queue.filter((item) => item.runStatus === "failed");
  const expiredLeaseRows = queue.filter((item) => hasExpiredLease(item));
  const rows = queue.map((item) => {
    const taskSummary = `${item.completedTasks}/${item.totalTasks} done, ${item.queuedTasks} queued, ${item.runningTasks} running, ${item.failedTasks} failed`;
    const currentStage = item.runningStageId
      ? `${item.runningStageId} (${item.runningAgentId ?? "unknown"})`
      : item.nextStageId
        ? `${item.nextStageId} (${item.nextAgentId ?? "unknown"})`
        : "none";
    const leaseDetail = item.runningWorkerId
      ? `worker: ${item.runningWorkerId}${item.runningLeaseExpiresAt ? `; lease expires ${renderDashboardDateTime(item.runningLeaseExpiresAt)}` : ""}`
      : item.runningTasks > 0
        ? "worker: unknown"
        : "worker: none";
    return `
      <tr>
        <td><a href="/run?id=${encodeURIComponent(item.runId)}">${escapeHtml(item.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(item.workflowId)}</span></td>
        <td><span class="status ${escapeHtml(item.runStatus)}">${escapeHtml(item.runStatus)}</span></td>
        <td>${escapeHtml(item.projectName)}<br><span class="muted">${escapeHtml(item.projectRootUri)}</span></td>
        <td>${escapeHtml(item.task)}</td>
        <td>${escapeHtml(taskSummary)}<br><span class="muted">current: ${escapeHtml(currentStage)}</span><br><span class="muted">${escapeHtml(leaseDetail)}</span></td>
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
        ${queueProcessForm(projectFilter)}
        ${expiredLeaseRows.length ? queueRecoverExpiredLeasesForm() : ""}
      </div>
      <form class="workflow-form" method="get" action="/queue">
        <label class="wide">Project filter<input name="project" value="${escapeHtml(projectFilter)}" placeholder="/path/to/project or blank for all"></label>
        <div class="form-actions"><button type="submit">Filter Queue</button></div>
      </form>
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

function renderApprovalsHtml(
  approvals: Awaited<ReturnType<typeof listActionApprovals>>,
  status: string
): string {
  const rows = approvals.map((approval) => `
    <tr>
      <td>${escapeHtml(approval.id.slice(0, 8))}<br><span class="muted">${escapeHtml(approval.id)}</span></td>
      <td><span class="status ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span></td>
      <td>${escapeHtml(approval.actionType)}<br><span class="muted">${escapeHtml(approval.stageId)} (${escapeHtml(approval.agentId)})</span></td>
      <td><code>${escapeHtml(approval.target)}</code><br><span class="muted">${escapeHtml(formatApprovalPayload(approval.payload))}</span></td>
      <td><a href="/run?id=${encodeURIComponent(approval.runId)}">${escapeHtml(approval.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(approval.workflowId)}</span></td>
      <td>${escapeHtml(approval.projectName)}<br><span class="muted">${escapeHtml(approval.projectRootUri)}</span></td>
      <td>${escapeHtml(approval.rationale)}<br><span class="muted">${escapeHtml(rolePreviewForApproval(approval))}</span>${approval.decidedBy ? `<br><span class="muted">Decided by ${escapeHtml(approval.decidedBy)}${approval.decidedRole ? ` (${escapeHtml(approval.decidedRole)})` : ""} at ${renderDashboardDateTime(approval.decidedAt)}</span>` : ""}</td>
      <td>${approval.status === "pending" ? approvalDecisionForms(approval.id) : approval.status === "approved" && isExecutableApprovalAction(approval.actionType) ? approvalExecuteForm(approval.id) : escapeHtml(approval.decisionNote ?? "")}</td>
    </tr>
  `).join("");
  const filterLink = (value: string, label: string) => `<a class="button ${status === value ? "" : "secondary"}" href="/approvals?status=${encodeURIComponent(value)}">${escapeHtml(label)}</a>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Approvals</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("approvals")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Approvals</h1>
        <p class="muted">Human inbox for agent-requested local commands, file writes, deployment decisions, and autonomy decisions.</p>
      </div>
      <a class="button secondary" href="/api/approvals?status=${encodeURIComponent(status)}">JSON</a>
    </div>
    <section class="panel">
      <div class="actions">
        ${filterLink("pending", "Pending")}
        ${filterLink("approved", "Approved")}
        ${filterLink("executed", "Executed")}
        ${filterLink("failed", "Failed")}
        ${filterLink("rejected", "Rejected")}
        ${filterLink("all", "All")}
      </div>
    </section>
    <section class="panel">
      <h2>Action Requests</h2>
      <table>
        <thead><tr><th>Approval</th><th>Status</th><th>Action</th><th>Target</th><th>Run</th><th>Project</th><th>Rationale</th><th>Decision</th></tr></thead>
        <tbody>${rows || "<tr><td colspan=\"8\">No approvals found.</td></tr>"}</tbody>
      </table>
    </section>
  </main>
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

type DashboardWorkflowGraphRun = {
  id: string;
  status: string;
  workflowId: string;
  task: string;
  startedAt: string;
  finishedAt: string | null;
  providerOverride: string | null;
  modelTierOverride: string | null;
  evaluationMetadata: Record<string, unknown>;
};

type DashboardWorkflowStageHealth = Awaited<ReturnType<typeof listWorkflowStageHealthForRuns>>[number];
type DashboardWorkflowStageRun = Awaited<ReturnType<typeof listWorkflowStageRunsForRuns>>[number];

type DashboardGraphExportSummary = {
  jsonPath: string;
  markdownPath: string | null;
  fileName: string;
  generatedAt: string;
  graphPath: string;
  projectPath: string;
  workflowId: string;
  workflowName: string;
  projectName: string;
  focusedStageId: string | null;
  runCount: number;
  stageHealthCount: number;
};

type DashboardGraphHandoffViewResult =
  | {
    ok: true;
    projectDir: string;
    fileName: string;
    markdownPath: string;
    jsonPath: string | null;
    markdown: string;
    summary: DashboardGraphExportSummary | null;
  }
  | { ok: false; error: string; projectDir?: string };

type DashboardWorkflowGraphReport = WorkflowGraphReport & {
  runs: DashboardWorkflowGraphRun[];
  runStatusFilter: string;
  runWarnings: string[];
  stageHealth: DashboardWorkflowStageHealth[];
  focusedStageId: string;
  focusedStageRuns: DashboardWorkflowStageRun[];
  focusedStageFixRuns: DashboardWorkflowGraphRun[];
  focusedStageVerificationRuns: DashboardWorkflowGraphRun[];
  recentGraphExports: DashboardGraphExportSummary[];
};

async function loadDashboardWorkflowGraph(params: URLSearchParams): Promise<DashboardWorkflowGraphReport> {
  const projectDir = path.resolve(process.cwd(), params.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project");
  const workflows = await loadWorkflows(rootDir);
  const workflowId = params.get("workflow")?.trim() || workflows.find((workflow) => workflow.triggers.manual)?.id || workflows[0]?.id;
  if (!workflowId) throw new Error("No workflow definitions are available.");
  const workflow = resolveWorkflow(workflows, workflowId);
  if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
  const project = await loadProjectConfig(projectDir);
  const resolvedPolicy = resolveExecutionPolicy(project, params.get("policyProfile")?.trim() || undefined);
  const report = buildWorkflowGraphReport({
    workflow,
    agents: await loadAgentsForProject(projectDir),
    project,
    resolvedPolicy
  });
  const runLimit = parseDashboardRunLimit(params.get("runLimit") ?? "50", 50);
  const runStatusFilter = parseDashboardRunStatusFilter(params.get("runStatus") ?? "all");
  const requestedStageFocus = params.get("stage")?.trim() || "";
  const focusedStageId = report.stages.some((stage) => stage.id === requestedStageFocus) ? requestedStageFocus : "";
  const safeRunLimit = Math.min(Math.max(runLimit, 0), 250);
  const runWarnings: string[] = [];
  let runs: DashboardWorkflowGraphRun[] = [];
  let stageHealth: DashboardWorkflowStageHealth[] = [];
  let focusedStageRuns: DashboardWorkflowStageRun[] = [];
  let focusedStageFixRuns: DashboardWorkflowGraphRun[] = [];
  let focusedStageVerificationRuns: DashboardWorkflowGraphRun[] = [];
  let recentGraphExports: DashboardGraphExportSummary[] = [];
  if (safeRunLimit > 0) {
    try {
      const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: safeRunLimit });
      runs = projectRuns
        .filter((run) => run.workflowId === workflow.id)
        .filter((run) => dashboardRunMatchesStatus(run.status, runStatusFilter))
        .map((run) => ({
          id: run.id,
          status: run.status,
          workflowId: run.workflowId,
          task: run.task,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          providerOverride: run.providerOverride,
          modelTierOverride: run.modelTierOverride,
          evaluationMetadata: run.evaluationMetadata
        }));
      stageHealth = await listWorkflowStageHealthForRuns({ runIds: runs.map((run) => run.id) });
      if (focusedStageId) {
        focusedStageRuns = await listWorkflowStageRunsForRuns({ runIds: runs.map((run) => run.id), stageId: focusedStageId });
        focusedStageFixRuns = projectRuns
          .filter((run) => isFocusedStageFixRun(run, report.workflow.id, focusedStageId))
          .slice(0, 8)
          .map((run) => ({
            id: run.id,
            status: run.status,
            workflowId: run.workflowId,
            task: run.task,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            providerOverride: run.providerOverride,
            modelTierOverride: run.modelTierOverride,
            evaluationMetadata: run.evaluationMetadata
          }));
        focusedStageVerificationRuns = projectRuns
          .filter((run) => isFocusedStageVerificationRun(run, report.workflow.id, focusedStageId))
          .slice(0, 8)
          .map((run) => ({
            id: run.id,
            status: run.status,
            workflowId: run.workflowId,
            task: run.task,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            providerOverride: run.providerOverride,
            modelTierOverride: run.modelTierOverride,
            evaluationMetadata: run.evaluationMetadata
          }));
      }
    } catch (error) {
      runWarnings.push(`Run history unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    recentGraphExports = await listDashboardGraphHandoffExports(projectDir, 8);
  } catch (error) {
    runWarnings.push(`Graph handoff exports unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { ...report, runs, runStatusFilter, runWarnings, stageHealth, focusedStageId, focusedStageRuns, focusedStageFixRuns, focusedStageVerificationRuns, recentGraphExports };
}

function isFocusedStageFixRun(run: Awaited<ReturnType<typeof listWorkflowRunsForProject>>[number], workflowId: string, stageId: string): boolean {
  const metadata = run.evaluationMetadata ?? {};
  return metadata.kind === "stage_fix_suggestion"
    && metadata.sourceWorkflowId === workflowId
    && metadata.sourceStageId === stageId;
}

function isFocusedStageVerificationRun(run: Awaited<ReturnType<typeof listWorkflowRunsForProject>>[number], workflowId: string, stageId: string): boolean {
  const metadata = run.evaluationMetadata ?? {};
  return metadata.kind === "stage_fix_verification"
    && metadata.sourceWorkflowId === workflowId
    && metadata.sourceStageId === stageId;
}

async function listDashboardGraphHandoffExports(projectDir: string, limit: number): Promise<DashboardGraphExportSummary[]> {
  const exportDir = path.join(projectDir, ".agent-workflow", "exports", "graphs");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(exportDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const summaries = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => {
      const jsonPath = path.join(exportDir, entry.name);
      try {
        const payload = JSON.parse(await fs.readFile(jsonPath, "utf8")) as unknown;
        return graphHandoffSummaryFromPayload(projectDir, jsonPath, payload);
      } catch {
        return null;
      }
    }));
  return summaries
    .filter((summary): summary is DashboardGraphExportSummary => summary !== null)
    .sort((left, right) => Date.parse(right.generatedAt) - Date.parse(left.generatedAt))
    .slice(0, Math.max(0, limit));
}

function graphHandoffSummaryFromPayload(projectDir: string, jsonPath: string, payload: unknown): DashboardGraphExportSummary | null {
  const record = objectValue(payload);
  if (record.kind !== "agentflow_graph_handoff") return null;
  const workflow = objectValue(record.workflow);
  const project = objectValue(record.project);
  const focusedStage = objectValue(record.focusedStage);
  const generatedAt = stringValue(record.generatedAt);
  const graphPath = stringValue(record.graphPath);
  const workflowId = stringValue(workflow.id);
  const projectName = stringValue(project.name) ?? "project";
  if (!generatedAt || !graphPath || !workflowId) return null;
  const workflowName = stringValue(workflow.name) ?? workflowId;
  const markdownPath = jsonPath.replace(/\.json$/u, ".md");
  return {
    jsonPath,
    markdownPath: fsSync.existsSync(markdownPath) ? markdownPath : null,
    fileName: path.basename(markdownPath),
    generatedAt,
    graphPath,
    projectPath: projectDir,
    workflowId,
    workflowName,
    projectName,
    focusedStageId: stringValue(focusedStage.id) ?? null,
    runCount: Array.isArray(record.runs) ? record.runs.length : 0,
    stageHealthCount: Array.isArray(record.stageHealth) ? record.stageHealth.length : 0
  };
}

function renderWorkflowGraphDashboardHtml(report: DashboardWorkflowGraphReport, workflows: WorkflowDefinition[], params: URLSearchParams): string {
  const workflowOptions = workflows
    .filter((workflow) => workflow.triggers.manual)
    .map((workflow) => `<option value="${escapeHtml(workflow.id)}"${workflow.id === report.workflow.id ? " selected" : ""}>${escapeHtml(workflow.name)} (${escapeHtml(workflow.id)})</option>`)
    .join("");
  const projectValue = params.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project";
  const policyValue = params.get("policyProfile")?.trim() || report.project.policyProfile;
  const viewParam = params.get("view");
  const view = viewParam === "mind-map" || viewParam === "network" ? viewParam : "graph";
  const orientation: "horizontal" | "radial" = params.get("orientation") === "radial" ? "radial" : "horizontal";
  const categoryFilter = params.get("category")?.trim() || "";
  const approvalFilter = params.get("approval")?.trim() || "all";
  const policyFilter = params.get("policyStatus")?.trim() || "all";
  const runLimit = String(parseDashboardRunLimit(params.get("runLimit") ?? "50", 50));
  const runStatusFilter = report.runStatusFilter;
  const focusedStageId = report.focusedStageId;
  const capture = params.get("capture") === "1";
  const baseHrefOptions = { orientation, category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter, runLimit, runStatus: runStatusFilter, capture, stage: focusedStageId };
  const graphHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "graph" });
  const mindMapHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "mind-map" });
  const networkHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "network" });
  const networkHorizontalHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "network", orientation: "horizontal" });
  const networkRadialHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "network", orientation: "radial" });
  const captureHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view, capture: true });
  const exitCaptureHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view, capture: false });
  const clearStageHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view, stage: "" });
  const jsonHref = `/api/workflow-graph?workflow=${encodeURIComponent(report.workflow.id)}&project=${encodeURIComponent(projectValue)}&policyProfile=${encodeURIComponent(policyValue)}`;
  const filteredStages = filterWorkflowGraphStages(report, { category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter });
  const categories = uniqueSorted(report.stages.map((stage) => stage.agentCategory ?? "uncategorized"));
  const stageCards = filteredStages.map((stage, index) => {
    const subagents = stage.subagents.length
      ? stage.subagents.map((subagent) => `<span class="chip">${escapeHtml(subagent.id)}</span>`).join("")
      : `<span class="muted">No subagents</span>`;
    const className = stage.policyAllowed ? stage.approvalRequired || stage.policyApprovalRequired ? "warn" : "good" : "bad";
    return `<div class="graph-stage ${className}">
      <div class="graph-step">${index + 1}</div>
      <div>
        <h3>${escapeHtml(stage.id)}</h3>
        <p>${escapeHtml(stage.goal)}</p>
        <div class="meta-grid compact">
          <div><strong>Agent</strong>${escapeHtml(stage.agentDisplayName ?? stage.agentId)}</div>
          <div><strong>Tier</strong>${escapeHtml(stage.modelTier ?? "not set")}</div>
          <div><strong>Context</strong>${formatNumber(stage.contextMaxTokens)} tokens</div>
          <div><strong>Policy</strong>${stage.policyAllowed ? "allowed" : "blocked"}</div>
        </div>
        <div class="chip-row">${subagents}</div>
      </div>
    </div>`;
  }).join("");
  const stageRows = filteredStages.map((stage) => `
    <tr id="${escapeHtml(stageAnchorId(stage.id))}"><td>${stage.order}</td><td>${escapeHtml(stage.id)}</td><td>${escapeHtml(stage.agentId)}</td><td>${escapeHtml(stage.subagents.map((item) => item.id).join(", ") || "none")}</td><td>${formatNumber(stage.contextMaxTokens)}</td><td>${stage.approvalRequired || stage.policyApprovalRequired ? "yes" : "no"}</td><td>${stage.policyAllowed ? "allowed" : "blocked"}</td></tr>
  `).join("") || '<tr><td colspan="7">No stages match the selected filters.</td></tr>';
  const warnings = [...report.warnings, ...report.runWarnings];
  const warningHtml = warnings.length
    ? `<section class="panel warn-panel"><h2>Warnings</h2><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></section>`
    : "";
  const visual = view === "mind-map"
    ? `<section class="panel"><h2>Mind Map</h2>${renderWorkflowMindMapHtml(report, filteredStages)}</section>`
    : view === "network"
      ? `<section class="panel"><h2>Network Map</h2>${renderNetworkOrientationActions(orientation, networkHorizontalHref, networkRadialHref)}${renderWorkflowNetworkHtml(report, filteredStages, orientation, (stageId) => workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view: "network", stage: stageId }), focusedStageId)}</section>`
      : `<section class="panel"><h2>Connection Graph</h2><div class="graph-flow">${stageCards}</div></section>`;
  const categoryOptions = [`<option value="">all</option>`, ...categories.map((category) => `<option value="${escapeHtml(category)}"${categoryFilter === category ? " selected" : ""}>${escapeHtml(category)}</option>`)].join("");
  const approvalOptions = ["all", "required", "not-required"].map((value) => `<option value="${value}"${approvalFilter === value ? " selected" : ""}>${value}</option>`).join("");
  const policyOptions = ["all", "allowed", "blocked"].map((value) => `<option value="${value}"${policyFilter === value ? " selected" : ""}>${value}</option>`).join("");
  const runStatusOptions = ["all", "active", "failed", "completed", "queued", "running", "cancelled"].map((value) => `<option value="${value}"${runStatusFilter === value ? " selected" : ""}>${value}</option>`).join("");
  const captureActions = capture
    ? `<a class="button secondary" href="${escapeHtml(exitCaptureHref)}">Exit Capture</a><button type="button" onclick="window.print()">Print</button>`
    : `<a class="button secondary" href="${escapeHtml(captureHref)}">Capture View</a>`;
  const exportHandoffForm = workflowGraphHandoffExportForm({
    workflowId: report.workflow.id,
    project: projectValue,
    policyProfile: policyValue,
    view,
    orientation,
    category: categoryFilter,
    approval: approvalFilter,
    policyStatus: policyFilter,
    runStatus: runStatusFilter,
    runLimit,
    stage: focusedStageId
  });
  const quickRunLinks = [
    { label: "All Runs", runStatus: "all", runLimit: "50" },
    { label: "Active Runs", runStatus: "active", runLimit: "50" },
    { label: "Failed Runs", runStatus: "failed", runLimit: "50" },
    { label: "Definition Only", runStatus: "all", runLimit: "0" }
  ].map((item) => {
    const active = runStatusFilter === item.runStatus && runLimit === item.runLimit;
    const href = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { ...baseHrefOptions, view, runLimit: item.runLimit, runStatus: item.runStatus });
    return `<a class="button ${active ? "" : "secondary"}" href="${escapeHtml(href)}">${escapeHtml(item.label)}</a>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Graph</title><style>${dashboardCss()}</style></head><body${capture ? ' class="capture-page"' : ""}>
  ${capture ? "" : dashboardNav("workflow-graph")}
  <main>
    <div class="topbar"><div>${capture ? "" : '<a href="/">Dashboard</a>'}<h1>Agent Graph</h1><p class="muted">Read-only view of workflow stages, primary agents, subagents, context budgets, approvals, and policy fit.</p></div><div class="actions print-hide"><a class="button secondary capture-hide" href="${escapeHtml(jsonHref)}">JSON</a>${exportHandoffForm}${captureActions}</div></div>
    <section class="panel capture-hide"><form method="get" class="workflow-form"><input type="hidden" name="view" value="${escapeHtml(view)}"><input type="hidden" name="orientation" value="${escapeHtml(orientation)}"><input type="hidden" name="stage" value="${escapeHtml(focusedStageId)}"><label>Workflow<select name="workflow">${workflowOptions}</select></label><label class="wide">Project path<input name="project" value="${escapeHtml(projectValue)}"></label><label>Policy profile<input name="policyProfile" value="${escapeHtml(policyValue)}"></label><label>Agent category<select name="category">${categoryOptions}</select></label><label>Approval<select name="approval">${approvalOptions}</select></label><label>Policy status<select name="policyStatus">${policyOptions}</select></label><label>Run status<select name="runStatus">${runStatusOptions}</select></label><label>Runs shown<input name="runLimit" inputmode="numeric" value="${escapeHtml(runLimit)}"></label><div class="form-actions"><button type="submit">Render Graph</button></div></form><div class="actions quick-actions">${quickRunLinks}</div></section>
    ${warningHtml}
    <section class="panel"><div class="metric-grid">
      ${metricCard("Workflow", report.workflow.id, report.workflow.name)}
      ${metricCard("Stages", report.totals.stages, `${report.totals.subagentLinks} subagent links`)}
      ${metricCard("Visible", filteredStages.length, "stages after filters")}
      ${metricCard("Runs", report.runs.length, `${escapeHtml(runStatusFilter)} ${escapeHtml(report.workflow.id)} runs`)}
      ${metricCard("Context Budget", formatNumber(report.totals.contextBudgetTokens), "compiled source-token ceiling")}
      ${metricCard("Approvals", report.totals.approvalStages, `${report.totals.blockedStages} blocked stages`)}
    </div></section>
    <section class="panel capture-hide">
      <div class="section-heading">
        <div>
          <h2>Graph View</h2>
          <span class="muted">Switch between implementation flow, planning map, and run history network.</span>
        </div>
      </div>
      <div class="segmented-actions" role="group" aria-label="Graph view">
        <a class="segment ${view === "graph" ? "active" : ""}" href="${escapeHtml(graphHref)}"><strong>Flow</strong><span>Stages in order</span></a>
        <a class="segment ${view === "mind-map" ? "active" : ""}" href="${escapeHtml(mindMapHref)}"><strong>Map</strong><span>Workflow branches</span></a>
        <a class="segment ${view === "network" ? "active" : ""}" href="${escapeHtml(networkHref)}"><strong>Network</strong><span>Runs and agents</span></a>
      </div>
    </section>
    ${visual}
    ${renderRecentGraphExportsHtml(report.recentGraphExports, projectValue)}
    ${renderFocusedStageRunsHtml(report, projectValue, clearStageHref)}
    <section class="panel"><h2>Stage Matrix</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Stage</th><th>Agent</th><th>Subagents</th><th>Tokens</th><th>Approval</th><th>Policy</th></tr></thead><tbody>${stageRows}</tbody></table></div></section>
    <section class="panel"><h2>Mermaid</h2><pre>${escapeHtml(report.mermaid)}</pre></section>
  </main></body></html>`;
}

function renderRecentGraphExportsHtml(exports: DashboardGraphExportSummary[], project: string): string {
  const projectDir = path.resolve(process.cwd(), project);
  const rows = exports.map((item) => `
    <tr>
      <td>${renderDashboardDateTime(item.generatedAt)}</td>
      <td><strong>${escapeHtml(item.workflowId)}</strong><br><span class="muted">${escapeHtml(item.workflowName)}</span></td>
      <td>${escapeHtml(item.focusedStageId ?? "all stages")}</td>
      <td>${formatNumber(item.runCount)}</td>
      <td>${formatNumber(item.stageHealthCount)}</td>
      <td><a class="button secondary" href="${escapeHtml(item.graphPath)}">Open Graph</a></td>
      <td>${item.markdownPath ? `<a href="${escapeHtml(graphHandoffViewerHref(item.projectPath, item.fileName))}">View</a><br><code>${escapeHtml(item.markdownPath)}</code>` : "<code>missing</code>"}</td>
      <td><code>${escapeHtml(item.jsonPath)}</code></td>
    </tr>
  `).join("") || '<tr><td colspan="8">No graph handoff exports yet. Use Export Handoff to save the current graph state beside project reports.</td></tr>';
  return `<section class="panel capture-hide">
    <div class="section-heading">
      <div>
        <h2>Recent Graph Handoffs</h2>
        <span class="muted">Project-local graph exports that can be reopened, shared, or attached to a review.</span>
      </div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Generated</th><th>Workflow</th><th>Stage</th><th>Runs</th><th>Health Rows</th><th>Graph</th><th>Markdown</th><th>JSON</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${renderGraphExportLifecycleHtml(projectDir, exports.length)}
  </section>`;
}

function renderGraphExportLifecycleHtml(projectDir: string, exportCount: number): string {
  const exportDir = path.join(projectDir, ".agent-workflow", "exports", "graphs");
  const quotedExportDir = shellQuote(exportDir);
  const quotedProjectDir = shellQuote(projectDir);
  const commands = [
    `du -sh ${quotedExportDir}`,
    `find ${quotedExportDir} -maxdepth 1 -type f \\( -name '*.md' -o -name '*.json' \\) -print | sort | tail -40`,
    `find ${quotedExportDir} -maxdepth 1 -type f \\( -name '*.md' -o -name '*.json' \\) -mtime +30 -print`,
    `tar -czf agentflow-graph-handoffs.tgz -C ${quotedProjectDir} .agent-workflow/exports/graphs`
  ].join("\n");
  return `<details class="lifecycle-help">
    <summary>Export lifecycle commands</summary>
    <p class="muted">${formatNumber(exportCount)} recent handoff export${exportCount === 1 ? "" : "s"} shown. These commands inspect, preview prune candidates, or package graph handoffs without deleting files.</p>
    <pre>${escapeHtml(commands)}</pre>
  </details>`;
}

function graphHandoffViewerHref(project: string, fileName: string): string {
  const query = new URLSearchParams({ project, file: fileName });
  return `/graph-handoff?${query.toString()}`;
}

async function loadDashboardGraphHandoffView(params: URLSearchParams): Promise<DashboardGraphHandoffViewResult> {
  const projectInput = params.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project";
  const projectDir = path.resolve(process.cwd(), projectInput);
  const fileInput = params.get("file")?.trim() || "";
  const fileName = path.basename(fileInput);
  if (!fileName || fileName !== fileInput || !fileName.endsWith(".md")) {
    return { ok: false, error: "Missing or invalid graph handoff file name.", projectDir };
  }
  const exportDir = path.resolve(projectDir, ".agent-workflow", "exports", "graphs");
  const markdownPath = path.resolve(exportDir, fileName);
  if (!isPathInside(markdownPath, exportDir)) {
    return { ok: false, error: "Graph handoff file must be inside the project graph export folder.", projectDir };
  }
  try {
    const markdown = await fs.readFile(markdownPath, "utf8");
    const jsonPath = markdownPath.replace(/\.md$/u, ".json");
    let summary: DashboardGraphExportSummary | null = null;
    if (fsSync.existsSync(jsonPath)) {
      try {
        summary = graphHandoffSummaryFromPayload(projectDir, jsonPath, JSON.parse(await fs.readFile(jsonPath, "utf8")) as unknown);
      } catch {
        summary = null;
      }
    }
    return { ok: true, projectDir, fileName, markdownPath, jsonPath: fsSync.existsSync(jsonPath) ? jsonPath : null, markdown, summary };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { ok: false, error: "Graph handoff export was not found.", projectDir };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error), projectDir };
  }
}

function renderDashboardGraphHandoffView(result: DashboardGraphHandoffViewResult): string {
  const backHref = result.ok
    ? `/workflow-graph?project=${encodeURIComponent(result.projectDir)}`
    : `/workflow-graph${result.projectDir ? `?project=${encodeURIComponent(result.projectDir)}` : ""}`;
  const body = result.ok
    ? `<div class="topbar"><div><a href="${escapeHtml(backHref)}">Graph</a><h1>Graph Handoff</h1><p class="muted">${escapeHtml(result.fileName)}</p></div><div class="actions">${result.summary ? `<a class="button secondary" href="${escapeHtml(result.summary.graphPath)}">Open Saved Graph</a>` : ""}</div></div>
      <section class="panel"><div class="meta-grid compact">
        <div><strong>Project</strong>${escapeHtml(result.projectDir)}</div>
        <div><strong>Markdown</strong>${escapeHtml(result.markdownPath)}</div>
        <div><strong>JSON</strong>${escapeHtml(result.jsonPath ?? "missing")}</div>
        <div><strong>Generated</strong>${result.summary ? renderDashboardDateTime(result.summary.generatedAt) : "unknown"}</div>
      </div>${renderGraphExportLifecycleHtml(result.projectDir, result.summary ? 1 : 0)}</section>
      <section class="panel"><h2>Handoff Markdown</h2><pre class="markdown-view">${escapeHtml(result.markdown)}</pre></section>`
    : `<div class="topbar"><div><a href="${escapeHtml(backHref)}">Graph</a><h1>Graph Handoff</h1><p class="muted">Unable to open the requested export.</p></div></div><section class="panel warn-panel"><pre>${escapeHtml(result.error)}</pre></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Graph Handoff</title><style>${dashboardCss()}</style></head><body>${dashboardNav("workflow-graph")}<main>${body}</main></body></html>`;
}

function isPathInside(candidatePath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function filterWorkflowGraphStages(report: WorkflowGraphReport, filters: { category: string; approval: string; policyStatus: string }): WorkflowGraphReport["stages"] {
  return report.stages.filter((stage) => {
    const category = stage.agentCategory ?? "uncategorized";
    const needsApproval = stage.approvalRequired || stage.policyApprovalRequired;
    if (filters.category && category !== filters.category) return false;
    if (filters.approval === "required" && !needsApproval) return false;
    if (filters.approval === "not-required" && needsApproval) return false;
    if (filters.policyStatus === "allowed" && !stage.policyAllowed) return false;
    if (filters.policyStatus === "blocked" && stage.policyAllowed) return false;
    return true;
  });
}

function workflowGraphDashboardHref(
  workflowId: string,
  project: string,
  policyProfile: string,
  options: { view: string; orientation?: "horizontal" | "radial"; category: string; approval: string; policyStatus: string; runLimit: string; runStatus: string; capture: boolean; stage?: string }
): string {
  const query = new URLSearchParams({
    workflow: workflowId,
    project,
    policyProfile,
    view: options.view
  });
  if (options.view === "network" && options.orientation === "radial") query.set("orientation", "radial");
  if (options.category) query.set("category", options.category);
  if (options.approval !== "all") query.set("approval", options.approval);
  if (options.policyStatus !== "all") query.set("policyStatus", options.policyStatus);
  if (options.runLimit !== "50") query.set("runLimit", options.runLimit);
  if (options.runStatus !== "all") query.set("runStatus", options.runStatus);
  if (options.stage) query.set("stage", options.stage);
  if (options.capture) query.set("capture", "1");
  return `/workflow-graph?${query.toString()}`;
}

function renderNetworkOrientationActions(orientation: "horizontal" | "radial", horizontalHref: string, radialHref: string): string {
  return `<div class="network-toolbar"><div><strong>Network Orientation</strong><span>Horizontal is best for stage progression. Radial web is best for dependency shape.</span></div><div class="segmented-actions compact-segments" role="group" aria-label="Network orientation"><a class="segment ${orientation === "horizontal" ? "active" : ""}" href="${escapeHtml(horizontalHref)}"><strong>Horizontal</strong><span>Layered</span></a><a class="segment ${orientation === "radial" ? "active" : ""}" href="${escapeHtml(radialHref)}"><strong>Radial</strong><span>Web</span></a></div></div>`;
}

function renderFocusedStageRunsHtml(report: DashboardWorkflowGraphReport, project: string, clearStageHref: string): string {
  if (!report.focusedStageId) return "";
  const stage = report.stages.find((item) => item.id === report.focusedStageId);
  const health = report.stageHealth.find((item) => item.stageId === report.focusedStageId);
  const verificationRunIds = new Set(report.focusedStageVerificationRuns.map((run) => run.id));
  const baselineStageRuns = report.focusedStageRuns.filter((run) => !verificationRunIds.has(run.runId));
  const verificationStageRuns = report.focusedStageRuns.filter((run) => verificationRunIds.has(run.runId));
  const delta = summarizeFocusedStageDelta(baselineStageRuns, verificationStageRuns);
  const suggestFixForm = focusedStageSuggestFixForm({
    project,
    workflowId: report.workflow.id,
    stageId: report.focusedStageId,
    disabled: !stage
  });
  const rows = report.focusedStageRuns.map((run) => `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.runStatus)}">${escapeHtml(run.runStatus)}</span></td>
      <td><span class="status ${escapeHtml(run.taskStatus)}">${escapeHtml(run.taskStatus)}</span></td>
      <td>${formatNumber(run.attempts)}</td>
      <td>${escapeHtml(run.agentId)}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.taskStartedAt ?? run.runStartedAt)}</td>
    </tr>
  `).join("") || '<tr><td colspan="7">No task records found for this stage in the selected run history.</td></tr>';
  const healthText = health ? formatStageHealthTitle(health) : "No task-level stage history found for selected runs.";
  const fixRows = report.focusedStageFixRuns.map((run) => {
    const verifyForm = stageFixVerificationForm({
      project,
      workflowId: report.workflow.id,
      stageId: report.focusedStageId,
      fixRunId: run.id,
      disabled: run.status === "queued" || run.status === "running"
    });
    return `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${escapeHtml(run.workflowId)}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.startedAt)}</td>
      <td>${verifyForm}</td>
    </tr>
  `;
  }).join("") || '<tr><td colspan="6">No suggested fix runs have been queued from this stage yet.</td></tr>';
  const verificationRows = report.focusedStageVerificationRuns.map((run) => {
    const sourceFixRunId = stringValue(run.evaluationMetadata.sourceFixRunId);
    return `
    <tr>
      <td><a href="/run?id=${encodeURIComponent(run.id)}">${escapeHtml(run.id.slice(0, 8))}</a></td>
      <td><span class="status ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td>
      <td>${sourceFixRunId ? `<a href="/run?id=${encodeURIComponent(sourceFixRunId)}">${escapeHtml(sourceFixRunId.slice(0, 8))}</a>` : "unknown"}</td>
      <td>${escapeHtml(run.task)}</td>
      <td>${renderDashboardDateTime(run.startedAt)}</td>
    </tr>
  `;
  }).join("") || '<tr><td colspan="5">No source workflow verification reruns have been queued from suggested fixes yet.</td></tr>';
  const deltaHtml = renderFocusedStageDeltaHtml(delta);
  return `<section class="panel focused-stage-panel">
    <div class="section-heading">
      <div>
        <h2>Focused Stage: ${escapeHtml(report.focusedStageId)}</h2>
        <span class="muted">${escapeHtml(stage?.goal ?? "Stage details unavailable.")}</span>
      </div>
      <div class="actions">
        ${suggestFixForm}
        <a class="button secondary" href="${escapeHtml(clearStageHref)}">Clear Stage</a>
      </div>
    </div>
    <p class="muted">${escapeHtml(healthText)}</p>
    ${deltaHtml}
    <div class="table-wrap"><table><thead><tr><th>Run</th><th>Run Status</th><th>Stage Status</th><th>Attempts</th><th>Agent</th><th>Task</th><th>Started</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h3>Suggested Fix Runs</h3>
    <p class="muted">Debug runs queued from this focused stage, shown beside the source-stage health signal for quick before/after triage.</p>
    <div class="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th>Workflow</th><th>Task</th><th>Started</th><th>Verify</th></tr></thead><tbody>${fixRows}</tbody></table></div>
    <h3>Verification Reruns</h3>
    <p class="muted">Source workflow reruns queued after a suggested fix, tagged for stage-health comparison.</p>
    <div class="table-wrap"><table><thead><tr><th>Run</th><th>Status</th><th>Fix Run</th><th>Task</th><th>Started</th></tr></thead><tbody>${verificationRows}</tbody></table></div>
  </section>`;
}

type FocusedStageDeltaSummary = {
  baseline: FocusedStageOutcomeSummary;
  verification: FocusedStageOutcomeSummary;
  completedDelta: number | null;
  failedDelta: number | null;
  activeDelta: number | null;
  label: string;
};

type FocusedStageOutcomeSummary = {
  total: number;
  completed: number;
  failed: number;
  active: number;
  cancelled: number;
  completedRate: number | null;
  failedRate: number | null;
  activeRate: number | null;
};

function summarizeFocusedStageDelta(baselineRows: DashboardWorkflowStageRun[], verificationRows: DashboardWorkflowStageRun[]): FocusedStageDeltaSummary {
  const baseline = summarizeFocusedStageOutcomes(baselineRows);
  const verification = summarizeFocusedStageOutcomes(verificationRows);
  const completedDelta = rateDelta(verification.completedRate, baseline.completedRate);
  const failedDelta = rateDelta(verification.failedRate, baseline.failedRate);
  const activeDelta = rateDelta(verification.activeRate, baseline.activeRate);
  let label = "Need verification";
  if (verification.total > 0 && completedDelta !== null && failedDelta !== null) {
    if (failedDelta < 0 || completedDelta > 0) {
      label = "Improved";
    } else if (failedDelta > 0 || completedDelta < 0) {
      label = "Regressed";
    } else {
      label = "No change";
    }
  }
  return { baseline, verification, completedDelta, failedDelta, activeDelta, label };
}

function summarizeFocusedStageOutcomes(rows: DashboardWorkflowStageRun[]): FocusedStageOutcomeSummary {
  const total = rows.length;
  const completed = rows.filter((row) => row.taskStatus === "completed").length;
  const failed = rows.filter((row) => row.taskStatus === "failed").length;
  const active = rows.filter((row) => row.taskStatus === "queued" || row.taskStatus === "running").length;
  const cancelled = rows.filter((row) => row.taskStatus === "cancelled").length;
  return {
    total,
    completed,
    failed,
    active,
    cancelled,
    completedRate: percentRate(completed, total),
    failedRate: percentRate(failed, total),
    activeRate: percentRate(active, total)
  };
}

function percentRate(count: number, total: number): number | null {
  if (!total) return null;
  return Math.round((count / total) * 1000) / 10;
}

function rateDelta(after: number | null, before: number | null): number | null {
  if (after === null || before === null) return null;
  return Math.round((after - before) * 10) / 10;
}

function renderFocusedStageDeltaHtml(delta: FocusedStageDeltaSummary): string {
  const statusClass = delta.label === "Improved" ? "good" : delta.label === "Regressed" ? "bad" : "warn";
  return `<div class="stage-delta">
    <div class="stage-delta-card ${statusClass}">
      <strong>After Signal</strong>
      <span>${escapeHtml(delta.label)}</span>
      <small>${delta.verification.total ? "Verification reruns compared with source history." : "Run a source verification to calculate after health."}</small>
    </div>
    <div class="stage-delta-card">
      <strong>Completed</strong>
      <span>${formatNullableRate(delta.verification.completedRate)} <small>${formatSignedRate(delta.completedDelta)}</small></span>
      <small>Before ${formatNullableRate(delta.baseline.completedRate)} from ${formatNumber(delta.baseline.total)} stage tasks</small>
    </div>
    <div class="stage-delta-card">
      <strong>Failed</strong>
      <span>${formatNullableRate(delta.verification.failedRate)} <small>${formatSignedRate(delta.failedDelta)}</small></span>
      <small>Before ${formatNullableRate(delta.baseline.failedRate)} from ${formatNumber(delta.baseline.failed)} failures</small>
    </div>
    <div class="stage-delta-card">
      <strong>Active</strong>
      <span>${formatNullableRate(delta.verification.activeRate)} <small>${formatSignedRate(delta.activeDelta)}</small></span>
      <small>${formatNumber(delta.verification.active)} queued/running, ${formatNumber(delta.verification.cancelled)} cancelled</small>
    </div>
  </div>`;
}

function formatNullableRate(value: number | null): string {
  return value === null ? "n/a" : `${value}%`;
}

function formatSignedRate(value: number | null): string {
  if (value === null) return "";
  return `${value > 0 ? "+" : ""}${value}%`;
}

function renderWorkflowMindMapHtml(report: WorkflowGraphReport, stages: WorkflowGraphReport["stages"]): string {
  const branches = stages.map((stage) => {
    const subagents = stage.subagents.length
      ? stage.subagents.map((subagent) => `<span class="chip">${escapeHtml(subagent.displayName ?? subagent.id)}</span>`).join("")
      : '<span class="muted">No subagents</span>';
    const state = stage.policyAllowed ? stage.approvalRequired || stage.policyApprovalRequired ? "warn" : "good" : "bad";
    return `<article class="mind-node ${state}">
      <strong>${formatNumber(stage.order)}. ${escapeHtml(stage.id)}</strong>
      <span>${escapeHtml(stage.agentDisplayName ?? stage.agentId)}</span>
      <small>${escapeHtml(stage.goal)}</small>
      <div class="mind-node-meta">
        <span>${formatNumber(stage.contextMaxTokens)} tokens</span>
        <span>${stage.approvalRequired || stage.policyApprovalRequired ? "approval" : "no approval"}</span>
        <span>${stage.policyAllowed ? "allowed" : "blocked"}</span>
      </div>
      <div class="chip-row">${subagents}</div>
    </article>`;
  }).join("") || '<p class="muted">No stages match the selected filters.</p>';
  return `<div class="mind-map">
    <div class="mind-center">
      <strong>${escapeHtml(report.workflow.name)}</strong>
      <span>${escapeHtml(report.workflow.id)}</span>
      <small>${formatNumber(report.totals.stages)} stages &middot; ${formatNumber(report.totals.subagentLinks)} subagent links</small>
    </div>
    <div class="mind-branches">${branches}</div>
  </div>`;
}

function renderWorkflowNetworkHtml(report: DashboardWorkflowGraphReport, stages: WorkflowGraphReport["stages"], orientation: "horizontal" | "radial", stageHref: (stageId: string) => string, focusedStageId: string): string {
  if (!stages.length) return '<p class="muted">No stages match the selected filters.</p>';
  const isRadial = orientation === "radial";
  const width = 1120;
  const height = isRadial ? 760 : 680;
  const centerX = width / 2;
  const centerY = height / 2;
  const stageRadius = 148;
  const agentRadius = 252;
  const runRadius = 338;
  const layerTop = 118;
  const layerBottom = 560;
  const workflowX = 118;
  const stageX = 350;
  const agentX = 650;
  const runX = 982;
  const palette: Record<string, string> = {
    automatic: "#f59e0b",
    core: "#38bdf8",
    development: "#22d3ee",
    operations: "#a855f7",
    product: "#f43f5e",
    uncategorized: "#94a3b8"
  };
  const runPalette: Record<string, string> = {
    completed: "#22c55e",
    failed: "#ef4444",
    running: "#f59e0b",
    queued: "#f59e0b",
    cancelled: "#94a3b8"
  };
  type NetworkNode = { id: string; label: string; title: string; x: number; y: number; r: number; color: string; kind: string; href?: string; labelX?: number; labelY?: number; labelAnchor?: string; caption?: string; stageId?: string; stageHealth?: DashboardWorkflowStageHealth; focused?: boolean };
  const nodeById = new Map<string, NetworkNode>();
  const links: Array<{ from: string; to: string; width: number; dashed?: boolean; className?: string }> = [];
  const requestSizedRadius = (baseRadius: number, requestCount: number, maxExtra: number): number => baseRadius + Math.min(maxExtra, Math.sqrt(Math.max(0, requestCount)) * 3.2);
  const stageNodeLabel = (stageId: string): string => truncateMiddle(stageId, 10);
  const stageHealthById = new Map(report.stageHealth.map((health) => [health.stageId, health]));
  const radialPoint = (angle: number, radius: number): { x: number; y: number } => ({
    x: centerX + Math.cos(angle) * radius,
    y: centerY + Math.sin(angle) * radius
  });
  const ringAngle = (index: number, total: number, offset = -Math.PI / 2): number => offset + (Math.PI * 2 * index) / Math.max(total, 1);
  const applyRadialLabel = (node: NetworkNode, angle: number, offset: number): void => {
    node.labelX = node.x + Math.cos(angle) * (node.r + offset);
    node.labelY = node.y + Math.sin(angle) * (node.r + offset) + 4;
    const horizontal = Math.cos(angle);
    node.labelAnchor = Math.abs(horizontal) < 0.24 ? "middle" : horizontal > 0 ? "start" : "end";
  };
  nodeById.set("workflow", {
    id: "workflow",
    label: isRadial ? "core" : report.workflow.id,
    caption: report.workflow.id,
    title: `${report.workflow.name} workflow`,
    x: isRadial ? centerX : workflowX,
    y: isRadial ? centerY : height / 2,
    r: isRadial ? 38 : 34,
    color: "#38bdf8",
    kind: "workflow",
    labelX: isRadial ? centerX : workflowX,
    labelY: isRadial ? centerY + 62 : height / 2 + 58,
    labelAnchor: "middle"
  });

  const agentEntries = new Map<string, { id: string; label: string; category: string; stageIds: Set<string>; isPrimary: boolean }>();
  stages.forEach((stage, index) => {
    const angle = ringAngle(index, stages.length);
    const point = isRadial ? radialPoint(angle, stageRadius) : { x: stageX, y: distributeLayerY(index, stages.length, layerTop, layerBottom) };
    const stageNodeId = `stage:${stage.id}`;
    const stageNode: NetworkNode = {
      id: stageNodeId,
      label: stageNodeLabel(stage.id),
      title: `${stage.id}: ${stage.goal}`,
      x: point.x,
      y: point.y,
      r: 22,
      color: stage.policyAllowed ? (stage.approvalRequired || stage.policyApprovalRequired ? "#f59e0b" : "#2563eb") : "#dc2626",
      kind: "stage",
      href: stageHref(stage.id),
      stageId: stage.id,
      stageHealth: stageHealthById.get(stage.id),
      focused: focusedStageId === stage.id
    };
    if (stageNode.stageHealth) stageNode.title = `${stageNode.title} - ${formatStageHealthTitle(stageNode.stageHealth)}`;
    nodeById.set(stageNodeId, stageNode);
    links.push({ from: "workflow", to: stageNodeId, width: 1.2, className: "signal" });
    if (index > 0) links.push({ from: `stage:${stages[index - 1].id}`, to: stageNodeId, width: 2.8, dashed: true, className: "sequence" });
    const primary = agentEntries.get(stage.agentId) ?? {
      id: stage.agentId,
      label: stage.agentDisplayName ?? stage.agentId,
      category: stage.agentCategory ?? "uncategorized",
      stageIds: new Set<string>(),
      isPrimary: true
    };
    primary.stageIds.add(stageNodeId);
    primary.isPrimary = true;
    agentEntries.set(stage.agentId, primary);
    links.push({ from: stageNodeId, to: `agent:${stage.agentId}`, width: 2.2, className: "signal" });
    stage.subagents.forEach((subagent) => {
      const entry = agentEntries.get(subagent.id) ?? {
        id: subagent.id,
        label: subagent.displayName ?? subagent.id,
        category: subagent.category ?? "uncategorized",
        stageIds: new Set<string>(),
        isPrimary: false
      };
      entry.stageIds.add(stageNodeId);
      agentEntries.set(subagent.id, entry);
      links.push({ from: stageNodeId, to: `agent:${subagent.id}`, width: 1.7, dashed: true, className: "support" });
    });
  });

  const agents = [...agentEntries.values()].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.category.localeCompare(b.category) || a.id.localeCompare(b.id);
  });
  const categories = uniqueSorted(agents.map((agent) => agent.category || "uncategorized"));
  agents.forEach((agent, index) => {
    const angle = ringAngle(index, agents.length, -Math.PI / 2 + Math.PI / Math.max(agents.length, 8));
    const point = isRadial
      ? radialPoint(angle, agent.isPrimary ? agentRadius - 18 : agentRadius + 22)
      : { x: agentX + (agent.isPrimary ? -28 : 34), y: distributeLayerY(index, agents.length, layerTop, layerBottom) };
    const agentNode: NetworkNode = {
      id: `agent:${agent.id}`,
      label: agent.id,
      title: `${agent.label} (${agent.category})`,
      x: point.x,
      y: point.y,
      r: agent.isPrimary ? 18 : 11,
      color: palette[agent.category] ?? palette.uncategorized,
      kind: agent.isPrimary ? "primary agent" : "subagent"
    };
    if (agent.isPrimary) {
      if (isRadial) applyRadialLabel(agentNode, angle, 10);
      else {
        agentNode.labelX = agentNode.x + 30;
        agentNode.labelY = agentNode.y + 4;
        agentNode.labelAnchor = "start";
      }
    }
    nodeById.set(`agent:${agent.id}`, agentNode);
  });

  const runs = report.runs.slice(0, 36);
  runs.forEach((run, index) => {
    const angle = ringAngle(index, Math.max(runs.length, 1), -Math.PI / 2 + Math.PI / Math.max(runs.length, 10));
    const point = isRadial ? radialPoint(angle, runRadius) : { x: runX, y: distributeLayerY(index, Math.max(runs.length, 1), layerTop, layerBottom) };
    const active = run.status === "queued" || run.status === "running";
    const runNode: NetworkNode = {
      id: `run:${run.id}`,
      label: active ? run.status.slice(0, 1).toUpperCase() : "",
      title: `${run.status}: ${run.task} (${run.id})`,
      x: point.x,
      y: point.y,
      r: active ? 14 : run.status === "failed" ? 11 : 8,
      color: runPalette[run.status] ?? "#64748b",
      kind: "run",
      href: `/run?id=${encodeURIComponent(run.id)}`
    };
    if (active || run.status === "failed") {
      if (isRadial) applyRadialLabel(runNode, angle, 10);
      else {
        runNode.labelX = runNode.x + 22;
        runNode.labelY = runNode.y + 4;
        runNode.labelAnchor = "start";
      }
    }
    nodeById.set(`run:${run.id}`, runNode);
    const sourceAgents = agents.filter((agent) => agent.isPrimary).slice(0, 5);
    sourceAgents.forEach((agent) => {
      links.push({ from: `agent:${agent.id}`, to: `run:${run.id}`, width: run.status === "failed" ? 1.8 : active ? 1.1 : 1.25, dashed: !active, className: "outcome" });
    });
  });

  const inboundCounts = countBy(links.map((link) => link.to));
  nodeById.forEach((node) => {
    const requestCount = inboundCounts[node.id] ?? 0;
    if (!requestCount) return;
    const originalRadius = node.r;
    const maxExtra = node.kind === "run" ? 9 : node.kind === "subagent" ? 11 : node.kind === "primary agent" ? 12 : 7;
    node.r = requestSizedRadius(originalRadius, requestCount, maxExtra);
    node.title = `${node.title} - ${requestCount} incoming request${requestCount === 1 ? "" : "s"}`;
    if (isRadial && node.kind !== "stage" && node.kind !== "workflow" && node.labelX !== undefined && node.labelY !== undefined) {
      const angle = Math.atan2(node.y - centerY, node.x - centerX);
      applyRadialLabel(node, angle, node.kind === "stage" ? 14 : 10);
    }
    if (!isRadial && node.kind === "primary agent") node.labelX = node.x + node.r + 12;
    if (!isRadial && node.kind === "run" && node.labelX !== undefined) node.labelX = node.x + node.r + 10;
  });

  const linkSvg = links.map((link) => {
    const from = nodeById.get(link.from);
    const to = nodeById.get(link.to);
    if (!from || !to) return "";
    const dash = link.dashed ? ' stroke-dasharray="7 7"' : "";
    const classes = [link.className, link.dashed ? "dashed" : undefined].filter(Boolean).join(" ");
    const className = classes ? ` class="${escapeHtml(classes)}"` : "";
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const pull = link.from === "workflow" || link.to === "workflow" ? 0.42 : 0.22;
    const controlOneX = isRadial ? from.x + (centerX - from.x) * pull : midX;
    const controlOneY = isRadial ? from.y + (centerY - from.y) * pull : from.y;
    const controlTwoX = isRadial ? to.x + (centerX - to.x) * pull : midX;
    const controlTwoY = isRadial ? to.y + (centerY - to.y) * pull : midY;
    return `<path${className} d="M ${formatSvgNumber(from.x)} ${formatSvgNumber(from.y)} C ${formatSvgNumber(controlOneX)} ${formatSvgNumber(controlOneY)}, ${formatSvgNumber(controlTwoX)} ${formatSvgNumber(controlTwoY)}, ${formatSvgNumber(to.x)} ${formatSvgNumber(to.y)}" stroke-width="${link.width}"${dash}></path>`;
  }).join("");
  const nodeSvg = [...nodeById.values()].map((node) => {
    const nodeClasses = ["network-node", `network-${node.kind.replace(/\s+/g, "-")}`, node.focused ? "network-focused" : ""].filter(Boolean).join(" ");
    const body = `<g class="${escapeHtml(nodeClasses)}" style="color:${escapeHtml(node.color)}" transform="translate(${formatSvgNumber(node.x)} ${formatSvgNumber(node.y)})">
      <title>${escapeHtml(node.title)}</title>
      ${node.kind === "stage" && node.stageHealth ? renderStageHealthRing(node.r, node.stageHealth) : ""}
      <circle r="${node.r}"></circle>
      ${node.kind === "stage" || node.kind === "workflow" || (node.kind === "run" && node.label) ? `<text text-anchor="middle" dominant-baseline="central">${escapeHtml(node.label)}</text>` : ""}
    </g>`;
    return node.href ? `<a href="${escapeHtml(node.href)}" aria-label="${escapeHtml(node.title)}">${body}</a>` : body;
  }).join("");
  const labelSvg = [...nodeById.values()]
    .filter((node) => node.kind === "workflow" || node.kind === "primary agent" || node.labelX !== undefined)
    .map((node) => renderNetworkLabel(node))
    .join("");
  const layerLabels = [
    ...(isRadial
      ? [
          { x: 62, y: 54, label: "core", anchor: "start" },
          { x: 134, y: 54, label: "stage web", anchor: "start" },
          { x: 252, y: 54, label: "agent web", anchor: "start" },
          { x: 374, y: 54, label: "run orbit", anchor: "start" }
        ]
      : [
          { x: workflowX, y: 54, label: "workflow input", anchor: "middle" },
          { x: stageX, y: 54, label: "stage layer", anchor: "middle" },
          { x: agentX, y: 54, label: "agent layer", anchor: "middle" },
          { x: runX, y: 54, label: "run outputs", anchor: "middle" }
        ])
  ].map((layer) => `<text class="network-layer-label" x="${formatSvgNumber(layer.x)}" y="${formatSvgNumber(layer.y)}" text-anchor="${layer.anchor}">${escapeHtml(layer.label)}</text>`).join("");
  const runCounts = countBy(report.runs.map((run) => run.status));
  const runLegend = Object.entries(runCounts).map(([status, count]) => `<span><i style="background:${runPalette[status] ?? "#64748b"}"></i>${escapeHtml(status)} runs (${count})</span>`).join("");
  const legend = categories.map((category) => `<span><i style="background:${palette[category] ?? palette.uncategorized}"></i>${escapeHtml(category)}</span>`).join("");
  const totalStageHealthTasks = report.stageHealth.reduce((total, health) => total + health.totalTasks, 0);
  const stageHealthSummary = report.stageHealth.length
    ? `Stage health rings summarize ${formatNumber(totalStageHealthTasks)} task records across ${formatNumber(report.stageHealth.length)} stages.`
    : "Stage health rings appear when selected runs include task-level stage history.";
  const explainer = renderNetworkStateExplainer(isRadial);
  const networkDefs = `<defs>
        <radialGradient id="neuralCoreGlow" cx="50%" cy="50%" r="65%">
          <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.62"></stop>
          <stop offset="42%" stop-color="#0f172a" stop-opacity="0.92"></stop>
          <stop offset="100%" stop-color="#020617" stop-opacity="1"></stop>
        </radialGradient>
        <linearGradient id="neuralSignal" x1="0%" x2="100%" y1="0%" y2="0%">
          <stop offset="0%" stop-color="#38bdf8"></stop>
          <stop offset="54%" stop-color="#f59e0b"></stop>
          <stop offset="100%" stop-color="#f43f5e"></stop>
        </linearGradient>
        <pattern id="neuralGrid" width="34" height="34" patternUnits="userSpaceOnUse">
          <path d="M 34 0 L 0 0 0 34" fill="none" stroke="#38bdf8" stroke-opacity="0.06" stroke-width="1"></path>
        </pattern>
        <filter id="neuralGlow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="4" result="coloredBlur"></feGaussianBlur>
          <feMerge>
            <feMergeNode in="coloredBlur"></feMergeNode>
            <feMergeNode in="SourceGraphic"></feMergeNode>
          </feMerge>
        </filter>
      </defs>`;
  return `<div class="network-shell">
    <svg class="network-map" viewBox="0 0 ${width} ${height}" role="img" aria-label="Workflow network map for ${escapeHtml(report.workflow.name)}">
      ${networkDefs}
      <rect class="network-backdrop" width="${width}" height="${height}" rx="0"></rect>
      <rect class="network-grid" width="${width}" height="${height}" rx="0"></rect>
      ${isRadial ? `<g class="network-rings">
        <circle cx="${formatSvgNumber(centerX)}" cy="${formatSvgNumber(centerY)}" r="${stageRadius}"></circle>
        <circle cx="${formatSvgNumber(centerX)}" cy="${formatSvgNumber(centerY)}" r="${agentRadius}"></circle>
        <circle cx="${formatSvgNumber(centerX)}" cy="${formatSvgNumber(centerY)}" r="${runRadius}"></circle>
      </g>` : ""}
      <g>${layerLabels}</g>
      <g class="network-links">${linkSvg}</g>
      <g class="network-nodes">${nodeSvg}</g>
      <g>${labelSvg}</g>
    </svg>
    <div class="network-legend">${legend}<span><i class="legend-stage"></i>stage</span><span><i class="legend-workflow"></i>workflow</span><span><i class="legend-health-completed"></i>stage completed</span><span><i class="legend-health-failed"></i>stage failed</span><span><i class="legend-health-active"></i>stage queued/running</span><span class="legend-note">circle size = incoming requests</span>${runLegend}</div>
    <p class="network-health-summary">${escapeHtml(stageHealthSummary)}</p>
    ${explainer}
  </div>`;
}

function renderNetworkStateExplainer(isRadial: boolean): string {
  const layoutText = isRadial
    ? "Read outward from the workflow core through stage, agent, and run rings."
    : "Read left to right from workflow input through stages, agents, and run outputs.";
  const items = [
    ["Layout", layoutText],
    ["Solid Lines", "Primary stage-to-agent and agent-to-run paths."],
    ["Dashed Lines", "Sequence or supporting subagent connections."],
    ["Health Rings", "Stage task outcomes: completed, failed, queued/running, and cancelled."],
    ["Click Targets", "Stage nodes focus history; run nodes open run details."]
  ];
  return `<div class="network-explainer">${items.map(([label, text]) => `
    <div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(text)}</span></div>
  `).join("")}</div>`;
}

function formatStageHealthTitle(health: DashboardWorkflowStageHealth): string {
  const active = health.queuedTasks + health.runningTasks;
  return `${health.totalTasks} stage tasks: ${health.completedTasks} completed, ${health.failedTasks} failed, ${active} queued/running, ${health.cancelledTasks} cancelled`;
}

function renderStageHealthRing(radius: number, health: DashboardWorkflowStageHealth): string {
  if (health.totalTasks <= 0) return "";
  const ringRadius = radius + 7;
  const circumference = Math.PI * 2 * ringRadius;
  const segments = [
    { className: "completed", value: health.completedTasks },
    { className: "failed", value: health.failedTasks },
    { className: "active", value: health.queuedTasks + health.runningTasks },
    { className: "cancelled", value: health.cancelledTasks }
  ].filter((segment) => segment.value > 0);
  let offset = 0;
  const gap = segments.length > 1 ? 2.2 : 0;
  return segments.map((segment) => {
    const length = Math.max(0, (segment.value / health.totalTasks) * circumference - gap);
    const svg = `<circle class="network-health-ring ${segment.className}" r="${formatSvgNumber(ringRadius)}" fill="none" stroke-dasharray="${formatSvgNumber(length)} ${formatSvgNumber(circumference - length)}" stroke-dashoffset="${formatSvgNumber(-offset)}"></circle>`;
    offset += length + gap;
    return svg;
  }).join("");
}

function distributeLayerY(index: number, total: number, top: number, bottom: number): number {
  if (total <= 1) return (top + bottom) / 2;
  return top + ((bottom - top) * index) / (total - 1);
}

function renderNetworkLabel(node: { label: string; caption?: string; labelX?: number; labelY?: number; labelAnchor?: string }): string {
  if (node.labelX === undefined || node.labelY === undefined || !node.labelAnchor) return "";
  return `<text class="network-label" x="${formatSvgNumber(node.labelX)}" y="${formatSvgNumber(node.labelY)}" text-anchor="${node.labelAnchor}">${escapeHtml(truncateMiddle(node.caption ?? node.label, 24))}</text>`;
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function stageAnchorId(stageId: string): string {
  return `stage-${stageId.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

function formatSvgNumber(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(4, Math.floor((maxLength - 1) / 2));
  return `${value.slice(0, keep)}...${value.slice(-keep)}`;
}

function renderModelImprovementHtml(
  report: DashboardModelImprovementReport | null,
  projects: DashboardProjectSummary[],
  params: URLSearchParams
): string {
  const selectedProject = report?.projectDir ?? params.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "";
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}">${escapeHtml(project.name)} - ${escapeHtml(project.rootUri)}</option>`).join("");
  const jsonHref = report ? `/api/model-improvement?project=${encodeURIComponent(report.projectDir)}` : "";
  const body = report
    ? renderModelImprovementReportHtml(report)
    : `<section class="panel"><h2>No Project Selected</h2><p class="muted">Run onboarding or enter a project path to inspect local model-improvement evidence.</p></section>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Model Improvement</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("model-improvement")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Model Improvement</h1>
        <p class="muted">Read-only local evidence for quality, cost, feedback, eval coverage, routing, and promotion readiness.</p>
      </div>
      ${jsonHref ? `<a class="button secondary" href="${escapeHtml(jsonHref)}">JSON</a>` : ""}
    </div>
    <section class="panel">
      <form method="get" class="workflow-form">
        <label class="wide">Project path
          <input name="project" value="${escapeHtml(selectedProject)}" list="model-improvement-projects" placeholder="/path/to/project">
          <datalist id="model-improvement-projects">${projectOptions}</datalist>
        </label>
        <label>Run limit
          <input name="limit" value="${escapeHtml(params.get("limit") ?? "50")}" inputmode="numeric">
        </label>
        <div class="form-actions"><button type="submit">Inspect</button></div>
      </form>
    </section>
    ${body}
  </main>
</body>
</html>`;
}

function renderLearningDashboardHtml(report: LearningReport | null, learningQueue: LearningApprovalQueue | null, learningDaemon: DashboardLearningDaemonStatus | null, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const selectedProject = report?.projectDir ?? params.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "";
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}">${escapeHtml(project.name)} - ${escapeHtml(project.rootUri)}</option>`).join("");
  const jsonHref = report ? `/api/learning-report?project=${encodeURIComponent(report.projectDir)}&limit=${encodeURIComponent(String(report.limit))}` : "";
  const body = report
    ? renderLearningReportHtml(report, learningQueue, learningDaemon)
    : `<section class="panel"><h2>No Project Selected</h2><p class="muted">Register or select a project to inspect read-only local learning evidence.</p></section>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Learning</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("learning")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Learning</h1>
        <p class="muted">Read-only local learning from approved feedback, run history, failures, routing, and evaluation evidence.</p>
      </div>
      ${jsonHref ? `<a class="button secondary" href="${escapeHtml(jsonHref)}">JSON</a>` : ""}
    </div>
    <section class="panel">
      <form method="get" class="workflow-form">
        <label class="wide">Project path
          <input name="project" value="${escapeHtml(selectedProject)}" list="learning-projects" placeholder="/path/to/project">
          <datalist id="learning-projects">${projectOptions}</datalist>
        </label>
        <label>Run limit
          <input name="limit" value="${escapeHtml(params.get("limit") ?? "50")}" inputmode="numeric">
        </label>
        <div class="form-actions"><button type="submit">Inspect</button></div>
      </form>
    </section>
    ${body}
  </main>
</body>
</html>`;
}

function renderLearningReportHtml(report: LearningReport, learningQueue: LearningApprovalQueue | null, learningDaemon: DashboardLearningDaemonStatus | null): string {
  const failureRows = report.repeatedFailurePatterns.map((pattern) => `
    <tr><td>${escapeHtml(pattern.workflowId)}</td><td>${escapeHtml(pattern.stageId)}</td><td>${escapeHtml(pattern.agentId)}</td><td>${pattern.failedTasks}/${pattern.totalTasks}</td><td>${pattern.failureRate}</td></tr>
  `).join("");
  const costRows = report.costOpportunities.map((item) => `
    <tr><td>${escapeHtml(item.workflowId)}<br><span class="muted">${escapeHtml(item.stageId)}</span></td><td>${escapeHtml(item.agentId)}</td><td>${escapeHtml(item.providerId)} / ${escapeHtml(item.modelTier)}</td><td>${item.runs}</td><td>${item.fallbackRate}</td><td>${item.averageLatencyMs ?? "n/a"}</td><td>${escapeHtml(item.recommendation)}</td></tr>
  `).join("");
  const failedRunRows = report.failedRuns.map((run) => `
    <tr><td><a href="/run?id=${encodeURIComponent(run.runId)}">${escapeHtml(run.runId.slice(0, 8))}</a></td><td>${escapeHtml(run.workflowId)}</td><td>${escapeHtml(run.task)}</td><td>${renderDashboardDateTime(run.startedAt)}</td></tr>
  `).join("");
  const proposalRows = Object.entries(report.proposalPreview.byKind).map(([kind, count]) => `<tr><td>${escapeHtml(kind)}</td><td>${formatNumber(count)}</td></tr>`).join("");
  const learningRows = (learningQueue?.items ?? []).map((item) => `
    <tr><td>${escapeHtml(item.proposalId)}<br><span class="muted">${escapeHtml(item.id)}</span></td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(item.proposal.priority)} / ${escapeHtml(item.proposal.riskLevel)}</td><td>${escapeHtml(item.proposal.title)}<br><span class="muted">${escapeHtml(item.proposal.target)}</span></td><td>${escapeHtml(item.proposal.recommendation)}</td></tr>
  `).join("");
  const learningCounts = learningQueue ? countStrings(learningQueue.items.map((item) => item.status)) : {};
  const proposalCommand = `npm run agentflow -- learning-proposals --project ${shellQuote(report.projectDir)} --write`;
  const daemonCommand = `npm run agentflow -- learning-daemon --project ${shellQuote(report.projectDir)} --mode propose`;
  const list = (items: string[]) => `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  return `
    <section class="panel">
      <div class="metric-grid">
        ${metricCard("Mode", report.autonomyMode, "read-only Phase 1")}
        ${metricCard("Runs", report.runsAnalyzed, formatInlineCounts(report.runStatusCounts) || "none")}
        ${metricCard("Feedback", formatInlineCounts(report.feedbackCounts) || "none", "approved user signal")}
        ${metricCard("Eval Runs", report.evaluationRuns, report.latestEvaluationAt ? `latest ${new Date(report.latestEvaluationAt).toLocaleDateString()}` : "none found")}
        ${metricCard("Failures", report.failedRuns.length, "recent failed runs")}
        ${metricCard("Proposal Preview", report.proposalPreview.total, `${report.proposalPreview.highPriority} high priority`)}
      </div>
      <p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)} for ${escapeHtml(report.projectDir)}.</p>
    </section>
    <section class="panel">
      <div class="section-heading"><div><h2>Learning Daemon</h2><span class="muted">Local observe/propose loop over Agent Workflow-owned learning state.</span></div></div>
      ${learningDaemon ? renderLearningDaemonStatusHtml(learningDaemon) : `<p class="muted">No project selected.</p>`}
      <p class="muted">Start propose mode with <code>${escapeHtml(daemonCommand)}</code>. It may update Agent Workflow-created learning files, but it does not apply source, provider, tuning, command, network, or export changes.</p>
    </section>
    <section class="panel">
      <div class="section-heading"><div><h2>Autonomy Boundary</h2><span class="muted">The learning daemon should keep working automatically until an action becomes dangerous.</span></div></div>
      <div class="split-grid">
        <div><h3>Automatic</h3>${list(report.safeAutomaticActions)}</div>
        <div><h3>Requires Approval</h3>${list(report.approvalRequiredActions)}</div>
      </div>
    </section>
    <section class="panel"><h2>Evaluation Gaps</h2>${list(report.evalGaps)}</section>
    <section class="panel"><h2>Repeated Failure Patterns</h2><div class="table-wrap"><table><thead><tr><th>Workflow</th><th>Stage</th><th>Agent</th><th>Failures</th><th>Rate</th></tr></thead><tbody>${failureRows || "<tr><td colspan=\"5\">No repeated failure patterns found.</td></tr>"}</tbody></table></div></section>
    <section class="panel"><h2>Cost And Routing Opportunities</h2><div class="table-wrap"><table><thead><tr><th>Workflow</th><th>Agent</th><th>Provider/Tier</th><th>Runs</th><th>Fallback</th><th>Latency</th><th>Recommendation</th></tr></thead><tbody>${costRows || "<tr><td colspan=\"7\">No cost or routing opportunities found.</td></tr>"}</tbody></table></div></section>
    <section class="panel"><h2>Recent Failed Runs</h2><div class="table-wrap"><table><thead><tr><th>Run</th><th>Workflow</th><th>Task</th><th>Started</th></tr></thead><tbody>${failedRunRows || "<tr><td colspan=\"4\">No failed runs in the inspected window.</td></tr>"}</tbody></table></div></section>
    <section class="panel"><h2>Proposal Preview</h2><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Count</th></tr></thead><tbody>${proposalRows || "<tr><td colspan=\"2\">No proposal candidates yet.</td></tr>"}</tbody></table></div></section>
    <section class="panel">
      <div class="section-heading"><div><h2>Learning Proposal Inbox</h2><span class="muted">${learningQueue ? `pending=${learningCounts.pending ?? 0} approved=${learningCounts.approved ?? 0} rejected=${learningCounts.rejected ?? 0}` : "No local inbox written yet."}</span></div></div>
      <p class="muted">Generate the inbox with <code>${escapeHtml(proposalCommand)}</code>. Approval records do not apply changes; they only capture review intent for the future daemon.</p>
      <div class="table-wrap"><table><thead><tr><th>Proposal</th><th>Status</th><th>Priority/Risk</th><th>Target</th><th>Recommendation</th></tr></thead><tbody>${learningRows || "<tr><td colspan=\"5\">No learning proposal inbox found.</td></tr>"}</tbody></table></div>
    </section>
    <section class="panel"><h2>Privacy Boundaries</h2>${list(report.privacyBoundaries)}</section>
    <section class="panel"><h2>Next Commands</h2>${list(report.nextCommands)}</section>
  `;
}

function renderLearningDaemonStatusHtml(status: DashboardLearningDaemonStatus): string {
  const age = status.ageMs === null ? "n/a" : formatDuration(Math.max(0, status.ageMs));
  return `
    <div class="meta-grid">
      <div><strong>Status</strong><span class="status ${status.status === "running" ? "completed" : status.status === "missing" ? "queued" : "failed"}">${escapeHtml(status.status)}</span></div>
      <div><strong>Mode</strong>${escapeHtml(status.mode ?? "n/a")}</div>
      <div><strong>Daemon</strong>${escapeHtml(status.daemonId ?? "n/a")}</div>
      <div><strong>PID</strong>${status.pid ?? "none"}</div>
      <div><strong>Process</strong>${status.processAlive ? "alive" : "not running"}</div>
      <div><strong>Last Heartbeat</strong>${renderDashboardDateTime(status.lastHeartbeatAt, "none")}</div>
      <div><strong>Age</strong>${escapeHtml(age)}</div>
      <div><strong>Last Report</strong>${renderDashboardDateTime(status.lastReportAt, "none")}</div>
      <div><strong>Ticks</strong>${formatNumber(status.ticks)}</div>
      <div><strong>Proposals</strong>${formatNumber(status.proposals)}</div>
      <div><strong>Inbox Items</strong>${formatNumber(status.inboxItems)}</div>
      <div><strong>Heartbeat File</strong>${escapeHtml(status.heartbeatPath)}</div>
      <div><strong>Start Command</strong><code>${escapeHtml(status.command)}</code></div>
      ${status.lastError ? `<div><strong>Last Error</strong>${escapeHtml(status.lastError)}</div>` : ""}
    </div>
  `;
}

function renderModelImprovementReportHtml(report: DashboardModelImprovementReport): string {
  const proposalRows = Object.entries(report.proposalCounts).map(([kind, count]) => `
    <tr><td>${escapeHtml(kind)}</td><td>${formatNumber(count)}</td></tr>
  `).join("");
  const commandRows = report.nextCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  return `
    <section class="panel">
      <div class="metric-grid">
        ${metricCard("Runs Analyzed", report.scorecard.runsAnalyzed, "recent project runs")}
        ${metricCard("Feedback", formatInlineCounts(report.scorecard.feedbackCounts) || "none", "accepted / revised / rejected")}
        ${metricCard("Eval Runs", report.evaluationRuns, report.latestEvaluationAt ? `latest ${new Date(report.latestEvaluationAt).toLocaleDateString()}` : "none found")}
        ${metricCard("High Priority", report.highPriorityProposals, "tuning proposals")}
        ${metricCard("Routing Proposals", report.routingProposals, "provider or tier changes")}
        ${metricCard("Promotion Ready", report.promotionReady ? "yes" : "not yet", "baseline evidence gate")}
      </div>
      <p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)} for ${escapeHtml(report.projectDir)}.</p>
    </section>
    <section class="panel">
      <h2>Readiness</h2>
      <ul>${report.readiness.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
    <section class="panel">
      <h2>Proposal Mix</h2>
      <div class="table-wrap"><table><thead><tr><th>Kind</th><th>Count</th></tr></thead><tbody>${proposalRows || "<tr><td colspan=\"2\">No proposals yet.</td></tr>"}</tbody></table></div>
    </section>
    <section class="panel">
      <h2>Preference Scorecard</h2>
      ${renderPreferenceScorecardHtml(report.scorecard)}
    </section>
    <section class="panel">
      <h2>Tuning Proposals</h2>
      ${renderTuningProposalsHtml(report.proposals)}
    </section>
    <section class="panel">
      <h2>Next Commands</h2>
      <ul>${commandRows}</ul>
    </section>
  `;
}

function renderCandidateComparisonsHtml(
  report: DashboardCandidateComparisonReport | null,
  projects: DashboardProjectSummary[],
  params: URLSearchParams
): string {
  const selectedProject = report?.projectDir ?? params.get("project") ?? process.env.AGENTFLOW_DASHBOARD_PROJECT ?? "";
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}">${escapeHtml(project.name)} - ${escapeHtml(project.rootUri)}</option>`).join("");
  const jsonHref = report ? `/api/candidate-comparisons?project=${encodeURIComponent(report.projectDir)}` : "";
  const body = report
    ? renderCandidateComparisonReportHtml(report)
    : `<section class="panel"><h2>No Project Selected</h2><p class="muted">Run onboarding or enter a project path to inspect local candidate comparison evidence.</p></section>`;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Workflow Candidate Comparisons</title>
  <style>${dashboardCss()}</style>
</head>
<body>
  ${dashboardNav("candidate-comparisons")}
  <main>
    <div class="topbar">
      <div>
        <a href="/">Dashboard</a>
        <h1>Candidate Comparisons</h1>
        <p class="muted">Read-only local visibility for model-improvement comparison suites, baseline/candidate variants, and promotion gates.</p>
      </div>
      ${jsonHref ? `<a class="button secondary" href="${escapeHtml(jsonHref)}">JSON</a>` : ""}
    </div>
    <section class="panel">
      <form method="get" class="workflow-form">
        <label class="wide">Project path
          <input name="project" value="${escapeHtml(selectedProject)}" list="candidate-comparison-projects" placeholder="/path/to/project">
          <datalist id="candidate-comparison-projects">${projectOptions}</datalist>
        </label>
        <div class="form-actions"><button type="submit">Inspect</button></div>
      </form>
    </section>
    ${body}
  </main>
</body>
</html>`;
}

function renderCandidateComparisonReportHtml(report: DashboardCandidateComparisonReport): string {
  const comparison = report.comparisonPlan;
  const suiteRows = comparison?.suites.map((suite) => {
    const file = report.suiteFiles.find((item) => item.path === suite.suitePath);
    const outcome = report.outcomes.find((item) => item.suiteId === suite.id);
    return `
      <tr>
        <td>${escapeHtml(suite.id)}</td>
        <td>${escapeHtml(suite.workflowId)}</td>
        <td>${formatNumber(suite.caseCount)}</td>
        <td><code>${escapeHtml(suite.suitePath)}</code></td>
        <td><span class="status ${file?.exists ? "completed" : "queued"}">${file?.exists ? "present" : "missing"}</span></td>
        <td>${outcome?.runs ?? 0}</td>
        <td>${outcome?.gateReady ? '<span class="flag good">ready</span>' : '<span class="flag warn">not yet</span>'}</td>
      </tr>
    `;
  }).join("") ?? "";
  const outcomeRows = report.outcomes.map((outcome) => `
    <tr>
      <td>${escapeHtml(outcome.suiteId)}</td>
      <td>${escapeHtml(outcome.leader ?? "none")}</td>
      <td>${outcome.baselineRuns}</td>
      <td>${outcome.candidateRuns}</td>
      <td>${outcome.baselineQuality ?? "n/a"}</td>
      <td>${outcome.candidateQuality ?? "n/a"}</td>
      <td>${outcome.qualityDelta ?? "n/a"}</td>
      <td>${outcome.latencyDeltaMs === null ? "n/a" : formatDurationDelta(outcome.latencyDeltaMs)}</td>
      <td>${outcome.latestAt ? renderDashboardDateTime(outcome.latestAt) : "n/a"}</td>
    </tr>
  `).join("");
  const recommendationRows = report.promotionRecommendations.map((recommendation) => `
    <tr>
      <td>${escapeHtml(recommendation.suiteId)}</td>
      <td><span class="flag ${recommendation.severity === "ready" ? "good" : recommendation.severity === "warning" ? "warn" : "queued"}">${escapeHtml(recommendation.decision.replace(/_/g, " "))}</span></td>
      <td><ul>${recommendation.rationale.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></td>
      <td>${recommendation.nextAction.includes("npm run ") ? `<code>${escapeHtml(recommendation.nextAction)}</code>` : escapeHtml(recommendation.nextAction)}</td>
    </tr>
  `).join("");
  const promotionFileRows = report.promotionNoteFiles.map((file) => `
    <tr>
      <td><code>${escapeHtml(file.path)}</code></td>
      <td><span class="status ${file.exists && !file.error ? "completed" : file.error ? "failed" : "queued"}">${file.exists && !file.error ? "present" : file.error ? "error" : "missing"}</span></td>
      <td>${file.exists ? formatNumber(file.bytes) : "n/a"}</td>
      <td>${file.modifiedAt ? renderDashboardDateTime(file.modifiedAt) : "n/a"}</td>
      <td>${file.error ? escapeHtml(file.error) : file.preview ? "preview below" : "n/a"}</td>
    </tr>
  `).join("");
  const promotionMarkdownPreview = report.promotionNoteFiles.find((file) => file.path.endsWith(".md") && file.preview)?.preview ?? "";
  const commandRows = report.nextCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const gateRows = comparison?.gateCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("") ?? "";
  const gateReadyCount = report.outcomes.filter((outcome) => outcome.gateReady).length;
  const recommendationReadyCount = report.promotionRecommendations.filter((recommendation) => recommendation.decision === "propose_routing_note").length;
  return `
    <section class="panel">
      <div class="metric-grid">
        ${metricCard("Model Plan", report.modelPlanExists && !report.modelPlanError ? "ready" : "missing", report.modelPlanError ?? ".agent-workflow/model-improvement")}
        ${metricCard("Comparison Plan", report.comparisonPlanExists && !report.comparisonPlanError ? "ready" : "missing", report.comparisonPlanError ?? "candidate-comparison-plan.json")}
        ${metricCard("Eval Cases", report.modelPlan?.evalCases.length ?? 0, "from approved feedback")}
        ${metricCard("Suites", comparison?.suites.length ?? 0, "generated private eval files")}
        ${metricCard("Suite Files", `${report.suiteFiles.filter((suite) => suite.exists).length}/${report.suiteFiles.length}`, "present")}
        ${metricCard("Gate Ready", `${gateReadyCount}/${report.outcomes.length}`, "baseline and candidate runs")}
        ${metricCard("Promotable", `${recommendationReadyCount}/${report.promotionRecommendations.length}`, "reviewed routing note")}
        ${metricCard("Generated", formatDashboardDateTimeText(report.generatedAt), "local read")}
      </div>
      <p class="muted">Project ${escapeHtml(report.projectDir)}.</p>
    </section>
    <section class="panel">
      <h2>Readiness</h2>
      <ul>${report.readiness.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
    <section class="panel">
      <h2>Variants</h2>
      ${comparison ? `
        <div class="meta-grid compact">
          <div><strong>Baseline</strong>${escapeHtml(comparison.baseline.provider)} / ${escapeHtml(comparison.baseline.modelTier)}<br><span class="muted">${escapeHtml(comparison.baseline.promptSuffix)}</span></div>
          <div><strong>Candidate</strong>${escapeHtml(comparison.candidate.provider)} / ${escapeHtml(comparison.candidate.modelTier)}<br><span class="muted">${escapeHtml(comparison.candidate.promptSuffix)}</span></div>
        </div>
      ` : '<p class="muted">No candidate comparison plan found.</p>'}
    </section>
    <section class="panel">
      <h2>Suites</h2>
      <div class="table-wrap"><table><thead><tr><th>Suite</th><th>Workflow</th><th>Cases</th><th>Path</th><th>File</th><th>Runs</th><th>Gate</th></tr></thead><tbody>${suiteRows || "<tr><td colspan=\"7\">No suites generated.</td></tr>"}</tbody></table></div>
    </section>
    <section class="panel">
      <h2>Outcomes</h2>
      <div class="table-wrap"><table><thead><tr><th>Suite</th><th>Leader</th><th>Baseline Runs</th><th>Candidate Runs</th><th>Baseline Quality</th><th>Candidate Quality</th><th>Quality Delta</th><th>Latency Delta</th><th>Latest</th></tr></thead><tbody>${outcomeRows || "<tr><td colspan=\"9\">No evaluation outcomes yet.</td></tr>"}</tbody></table></div>
    </section>
    <section class="panel">
      <h2>Promotion Recommendation</h2>
      <div class="table-wrap"><table><thead><tr><th>Suite</th><th>Decision</th><th>Rationale</th><th>Next Action</th></tr></thead><tbody>${recommendationRows || "<tr><td colspan=\"4\">No comparison outcomes available yet.</td></tr>"}</tbody></table></div>
      ${promotionNotePlanForm(report)}
    </section>
    <section class="panel">
      <h2>Promotion Note Files</h2>
      <div class="table-wrap"><table><thead><tr><th>Path</th><th>Status</th><th>Bytes</th><th>Modified</th><th>Preview</th></tr></thead><tbody>${promotionFileRows}</tbody></table></div>
      ${promotionMarkdownPreview ? `<h3>Markdown Preview</h3><pre>${escapeHtml(promotionMarkdownPreview)}</pre>` : '<p class="muted">No written promotion note plan yet. Preview or write one from a promotable recommendation.</p>'}
    </section>
    <section class="panel">
      <h2>Promotion Gates</h2>
      <ul>${gateRows || "<li>Run baseline and candidate evaluations before promotion.</li>"}</ul>
    </section>
    <section class="panel">
      <h2>Next Commands</h2>
      <ul>${commandRows}</ul>
    </section>
  `;
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

function renderRolesHtml(report: DashboardRoleGovernanceReport, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${report.projectRootUri === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const roleOptions = uniqueSorted([
    ...report.projects.flatMap((project) => project.roles.map((role) => role.id)),
    "pending",
    "unrecorded"
  ]).map((role) => `<option value="${escapeHtml(role)}"${report.filters.role === role ? " selected" : ""}>${escapeHtml(role)}</option>`).join("");
  const statusOptions = uniqueSorted(["all", "pending", "approved", "rejected", "executed", "failed", ...Object.keys(report.statusCounts)])
    .map((status) => `<option value="${escapeHtml(status)}"${report.filters.status === status ? " selected" : ""}>${escapeHtml(status)}</option>`)
    .join("");
  const actionOptions = uniqueSorted([
    "local_command",
    "file_write",
    "artifact_archive",
    "artifact_restore",
    "artifact_prune",
    "deployment",
    "autonomy",
    ...Object.keys(report.actionCounts)
  ])
    .map((action) => `<option value="${escapeHtml(action)}"${report.filters.actionType === action ? " selected" : ""}>${escapeHtml(action)}</option>`)
    .join("");
  const roleRows = report.projects.flatMap((project) => project.roles.map((role) => `
    <tr>
      <td><strong>${escapeHtml(role.id)}</strong>${project.defaultActorRole === role.id ? ' <span class="flag good">default</span>' : ""}<br><span class="muted">${escapeHtml(role.description || "No description")}</span></td>
      <td>${escapeHtml(project.name)}<br><span class="muted">${escapeHtml(project.rootUri)}</span></td>
      <td><span class="flag ${project.enforcement === "enforce" ? "warn" : "good"}">${project.enforcement}</span><br><span class="muted">separation: ${project.separationOfDuties}<br>config: ${project.configStatus}</span></td>
      <td><div class="chip-row">${role.capabilities.map((capability) => `<span class="chip">${escapeHtml(capability)}</span>`).join("") || '<span class="muted">No capabilities configured.</span>'}</div></td>
    </tr>`)).join("");
  const decisionRows = report.decisionsByRole.map((role) => `
    <tr>
      <td><strong>${escapeHtml(role.role)}</strong></td>
      <td>${role.total}</td>
      <td>${role.pending}</td>
      <td>${role.approved}</td>
      <td>${role.rejected}</td>
      <td>${role.executed}</td>
      <td>${role.failed}</td>
    </tr>`).join("");
  const approvalRows = report.recentApprovals.map((approval) => `
    <tr>
      <td><span class="status ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span></td>
      <td><strong>${escapeHtml(approval.actionType)}</strong><br><span class="muted">${escapeHtml(approval.target)}</span></td>
      <td>${escapeHtml(approval.decidedRole ?? (approval.status === "pending" ? "pending" : "unrecorded"))}<br><span class="muted">${escapeHtml(approval.decidedBy ?? "not decided")}</span></td>
      <td>${escapeHtml(approval.executedRole ?? "not executed")}<br><span class="muted">${escapeHtml(approval.executedBy ?? "not executed")}</span></td>
      <td>${escapeHtml(approval.projectName)}<br><span class="muted">${escapeHtml(approval.workflowId)} / ${escapeHtml(approval.stageId)}</span></td>
      <td>${renderDashboardDateTime(approval.updatedAt)}</td>
    </tr>`).join("");
  const filters = `<form method="get" class="form-grid">
    <label>Project<select name="project"><option value="">all registered projects</option>${projectOptions}</select></label>
    <label>Role<select name="role"><option value="">all roles</option>${roleOptions}</select></label>
    <label>Status<select name="status">${statusOptions}</select></label>
    <label>Action<select name="action"><option value="">all actions</option>${actionOptions}</select></label>
    <label>Recent approvals<input name="limit" inputmode="numeric" value="${escapeHtml(String(report.limit))}"></label>
    <div class="form-actions"><button type="submit">Filter</button></div>
  </form>`;
  const exportForm = `<form method="post" action="/api/role-audit-export" class="inline-form">
    <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri ?? "")}">
    <input type="hidden" name="role" value="${escapeHtml(report.filters.role ?? "")}">
    <input type="hidden" name="status" value="${escapeHtml(report.filters.status)}">
    <input type="hidden" name="action" value="${escapeHtml(report.filters.actionType ?? "")}">
    <input type="hidden" name="limit" value="${escapeHtml(String(report.limit))}">
    <button type="submit">Export Snapshot</button>
  </form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Roles</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("roles")}
  <main><div class="topbar"><div><a href="/">Dashboard</a><h1>Roles & Decisions</h1><p class="muted">Read-only team role configuration and recent approval decisions by recorded actor role.</p></div><div class="actions"><a class="button secondary" href="/api/roles?${escapeHtml(params.toString())}">JSON</a>${exportForm}</div></div>
  <section class="panel">${filters}<div class="meta-grid"><div><strong>Projects</strong>${report.projects.length}</div><div><strong>Recent approvals</strong>${report.recentApprovals.length}</div><div><strong>Recorded roles</strong>${report.decisionsByRole.length}</div><div><strong>Pending approvals</strong>${report.statusCounts.pending ?? 0}</div></div></section>
  ${renderRecentRoleAuditExportsHtml(report.recentRoleAuditExports, report.projectRootUri)}
  <section class="panel"><div class="section-heading"><div><h2>Configured Roles</h2><span class="muted">Project-local roles from .agent-workflow/project.yaml, falling back to stored config when the path is unavailable.</span></div></div><div class="table-wrap"><table><thead><tr><th>Role</th><th>Project</th><th>Mode</th><th>Capabilities</th></tr></thead><tbody>${roleRows || '<tr><td colspan="4">No project roles found.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Recent Decisions By Role</h2><span class="muted">Pending and older unrecorded decisions are separated so migration gaps stay visible.</span></div></div><div class="table-wrap"><table><thead><tr><th>Role</th><th>Total</th><th>Pending</th><th>Approved</th><th>Rejected</th><th>Executed</th><th>Failed</th></tr></thead><tbody>${decisionRows || '<tr><td colspan="7">No recent approvals found.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Recent Approval Activity</h2><span class="muted">Latest approval rows used by the role summary.</span></div></div><div class="table-wrap"><table><thead><tr><th>Status</th><th>Action</th><th>Decision Role</th><th>Execution Role</th><th>Project</th><th>Updated</th></tr></thead><tbody>${approvalRows || '<tr><td colspan="6">No recent approval activity found.</td></tr>'}</tbody></table></div></section></main></body></html>`;
}

function renderRecentRoleAuditExportsHtml(exports: DashboardRoleAuditExportSummary[], projectRootUri: string | null): string {
  const rows = exports.map((item) => `
    <tr>
      <td>${renderDashboardDateTime(item.generatedAt)}</td>
      <td>${escapeHtml(item.projectPath ?? projectRootUri ?? "all registered projects")}</td>
      <td>${escapeHtml(item.role ?? "all")} / ${escapeHtml(item.status)} / ${escapeHtml(item.actionType ?? "all")}</td>
      <td>${formatNumber(item.approvalCount)}</td>
      <td>${formatNumber(item.projectCount)}</td>
      <td>${item.markdownPath ? `<a href="${escapeHtml(roleAuditViewerHref(item.projectPath ?? projectRootUri, item.fileName))}">View</a><br><code>${escapeHtml(item.markdownPath)}</code>` : "<code>missing</code>"}</td>
      <td><code>${escapeHtml(item.jsonPath)}</code></td>
    </tr>
  `).join("") || '<tr><td colspan="7">No role audit snapshots yet. Use Export Snapshot to save the current filters locally.</td></tr>';
  return `<section class="panel">
    <div class="section-heading">
      <div>
        <h2>Recent Role Audit Snapshots</h2>
        <span class="muted">Local Markdown and JSON snapshots created from the active role filters.</span>
      </div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Generated</th><th>Project</th><th>Filters</th><th>Approvals</th><th>Projects</th><th>Markdown</th><th>JSON</th></tr></thead><tbody>${rows}</tbody></table></div>
  </section>`;
}

function roleAuditViewerHref(project: string | null, fileName: string): string {
  const query = new URLSearchParams({ file: fileName });
  if (project) query.set("project", project);
  return `/role-audit?${query.toString()}`;
}

function renderDashboardRoleAuditView(result: DashboardRoleAuditViewResult): string {
  const backHref = result.projectDir ? `/roles?project=${encodeURIComponent(result.projectDir)}` : "/roles";
  const body = result.ok
    ? `<div class="topbar"><div><a href="${escapeHtml(backHref)}">Roles</a><h1>Role Audit Snapshot</h1><p class="muted">${escapeHtml(result.fileName)}</p></div></div>
      <section class="panel"><div class="meta-grid compact">
        <div><strong>Project</strong>${escapeHtml(result.summary?.projectPath ?? result.projectDir ?? "all registered projects")}</div>
        <div><strong>Markdown</strong>${escapeHtml(result.markdownPath)}</div>
        <div><strong>JSON</strong>${escapeHtml(result.jsonPath ?? "missing")}</div>
        <div><strong>Generated</strong>${result.summary ? renderDashboardDateTime(result.summary.generatedAt) : "unknown"}</div>
        <div><strong>Filters</strong>${escapeHtml(`${result.summary?.role ?? "all"} / ${result.summary?.status ?? "all"} / ${result.summary?.actionType ?? "all"}`)}</div>
        <div><strong>Approvals</strong>${formatNumber(result.summary?.approvalCount ?? 0)}</div>
      </div></section>
      <section class="panel"><h2>Snapshot Markdown</h2><pre class="markdown-view">${escapeHtml(result.markdown)}</pre></section>`
    : `<div class="topbar"><div><a href="${escapeHtml(backHref)}">Roles</a><h1>Role Audit Snapshot</h1><p class="muted">Unable to open the requested export.</p></div></div><section class="panel warn-panel"><pre>${escapeHtml(result.error)}</pre></section>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Role Audit Snapshot</title><style>${dashboardCss()}</style></head><body>${dashboardNav("roles")}<main>${body}</main></body></html>`;
}

function renderBackupRestoreHtml(report: BackupRestoreReport, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${report.projectRootUri === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const statusClass = report.restoreDrill.status === "ready" ? "completed" : "queued";
  const serviceRows = report.services.map((service) => `
    <tr><td>${escapeHtml(service.endpoint.name)}</td><td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "OK" : "MISSING"}</span></td><td>${escapeHtml(service.message)}</td></tr>
  `).join("");
  const checkRows = report.restoreDrill.checks.map((check) => `
    <tr><td>${escapeHtml(check.label)}</td><td><span class="status ${check.status === "pass" ? "completed" : "queued"}">${escapeHtml(check.status)}</span></td><td>${escapeHtml(check.detail)}</td></tr>
  `).join("");
  const kindRows = Object.entries(report.inventory.byKind)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, value]) => `<tr><td>${escapeHtml(kind)}</td><td>${formatNumber(value.count)}</td><td>${escapeHtml(formatBytes(value.bytes))}</td></tr>`)
    .join("");
  const commandRows = report.recommendedCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const noteRows = report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  const jsonParams = new URLSearchParams();
  if (report.projectRootUri) jsonParams.set("project", report.projectRootUri);
  jsonParams.set("limit", String(report.limit));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Backup Readiness</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("backup-report")}
  <main><div class="topbar"><div><a href="/">Dashboard</a><h1>Backup Readiness</h1><p class="muted">Read-only local enterprise storage inventory and restore-drill posture. This page does not create backups, restore data, or mutate storage.</p></div><a class="button secondary" href="/api/backup-report?${escapeHtml(jsonParams.toString())}">JSON</a></div>
  <section class="panel"><form method="get" class="workflow-form"><label>Project<select name="project"><option value="">all registered projects</option>${projectOptions}</select></label><label>Limit<input name="limit" value="${escapeHtml(params.get("limit") ?? String(report.limit))}" inputmode="numeric"></label><div class="form-actions"><button type="submit">Inspect</button></div></form></section>
  <section class="panel"><div class="metric-grid">
    ${metricCard("Status", report.restoreDrill.status, "restore-drill readiness")}
    ${metricCard("Projects", report.inventory.projects, "registered in local storage")}
    ${metricCard("Runs", report.inventory.runs, `${report.inventory.completedRuns} completed / ${report.inventory.failedRuns} failed`)}
    ${metricCard("Artifacts", report.inventory.artifacts, formatBytes(report.inventory.estimatedArtifactBytes))}
    ${metricCard("Archives", report.inventory.archivedArtifacts, "archived_artifact snapshots")}
    ${metricCard("Restores", report.inventory.restoredArtifacts, "restored_artifact snapshots")}
    ${metricCard("Lifecycle Approvals", report.restoreDrill.pendingLifecycleApprovals, "pending / approved / failed")}
    ${metricCard("Queue Items", report.restoreDrill.activeQueueItems, "queued / running / failed")}
  </div><p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)}. Current status: <span class="status ${statusClass}">${escapeHtml(report.restoreDrill.status)}</span>.</p></section>
  <section class="panel"><h2>Services</h2><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>${serviceRows || '<tr><td colspan="3">No service checks were recorded.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><h2>Restore Drill Checks</h2><div class="table-wrap"><table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${checkRows || '<tr><td colspan="3">No restore-drill checks were recorded.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><h2>Artifact Kinds</h2><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Count</th><th>Bytes</th></tr></thead><tbody>${kindRows || '<tr><td colspan="3">No artifacts found in the inspected window.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><h2>Recommended Commands</h2><ul>${commandRows}</ul></section>
  <section class="panel"><h2>Notes</h2><ul>${noteRows || '<li>No backup or restore drill concerns found in the inspected window.</li>'}</ul></section></main></body></html>`;
}

function renderServerReadinessHtml(report: ServerReadinessReport, registry: ServerProjectRegistryReport, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${report.projectRootUri === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const statusClass = report.status === "ready" || report.status === "local-only" ? "completed" : report.status === "blocked" ? "failed" : "queued";
  const checkRows = report.checks.map((check) => `
    <tr><td>${escapeHtml(check.label)}</td><td><span class="status ${check.status === "pass" ? "completed" : check.status === "fail" ? "failed" : "queued"}">${escapeHtml(check.status)}</span></td><td>${escapeHtml(check.detail)}</td></tr>
  `).join("");
  const endpointRows = report.endpointClasses.map((endpoint) => `
    <tr><td>${escapeHtml(endpoint.name)}<br><span class="muted">${escapeHtml(endpoint.exposure)}</span></td><td><span class="status ${endpoint.implemented ? "completed" : "queued"}">${endpoint.implemented ? "implemented" : "not implemented"}</span></td><td><span class="status ${endpoint.ready ? "completed" : "queued"}">${endpoint.ready ? "ready" : "not ready"}</span></td><td>${endpoint.requiredControls.map((control) => `<code>${escapeHtml(control)}</code>`).join(" ")}</td></tr>
  `).join("");
  const projectRows = report.projects.map((project) => `
    <tr><td>${escapeHtml(project.name)}<br><code>${escapeHtml(project.id)}</code></td><td><code>${escapeHtml(project.rootUri)}</code></td><td><span class="status ${project.configStatus === "valid" ? "completed" : project.configStatus === "invalid" ? "failed" : "queued"}">${escapeHtml(project.configStatus)}</span></td><td>${escapeHtml(project.roleEnforcement)}</td><td>${project.roles.map((role) => `<code>${escapeHtml(role)}</code>`).join(" ") || "none"}</td></tr>
  `).join("");
  const registryRows = registry.projects.map((project) => `
    <tr><td>${escapeHtml(project.name)}<br><code>${escapeHtml(project.projectId)}</code><br><a href="/api/server-project?projectId=${encodeURIComponent(project.projectId)}">Resolve JSON</a></td><td>${project.rootUri ? `<code>${escapeHtml(project.rootUri)}</code>` : `<span class="muted">hidden</span><br><code>${escapeHtml(project.rootHash.slice(0, 12))}</code>`}</td><td>${project.defaultWorkflows.map((workflow) => `<code>${escapeHtml(workflow)}</code>`).join(" ") || "none"}</td><td><code>${escapeHtml(JSON.stringify(project.requestExample))}</code></td></tr>
  `).join("");
  const serviceRows = report.services.map((service) => `
    <tr><td>${escapeHtml(service.endpoint.name)}</td><td><span class="status ${service.reachable ? "completed" : "failed"}">${service.reachable ? "OK" : "MISSING"}</span></td><td>${escapeHtml(service.message)}</td></tr>
  `).join("");
  const commandRows = report.recommendedCommands.map((command) => `<li><code>${escapeHtml(command)}</code></li>`).join("");
  const noteRows = report.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("");
  const jsonParams = new URLSearchParams();
  if (report.projectRootUri) jsonParams.set("project", report.projectRootUri);
  jsonParams.set("limit", String(report.limit));
  const registryParams = new URLSearchParams(jsonParams);
  if (registry.includeRoots) registryParams.set("includeRoots", "true");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Server Readiness</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("server-readiness")}
  <main><div class="topbar"><div><a href="/">Dashboard</a><h1>Server Readiness</h1><p class="muted">Read-only governed server-mode readiness. This page does not enable remote execution or change network binding.</p></div><a class="button secondary" href="/api/server-readiness?${escapeHtml(jsonParams.toString())}">JSON</a></div>
  <section class="panel"><form method="get" class="workflow-form"><label>Project<select name="project"><option value="">all registered projects</option>${projectOptions}</select></label><label>Limit<input name="limit" value="${escapeHtml(params.get("limit") ?? String(report.limit))}" inputmode="numeric"></label><label class="checkbox-row"><input type="checkbox" name="includeRoots" value="true"${registry.includeRoots ? " checked" : ""}> include local roots</label><div class="form-actions"><button type="submit">Inspect</button></div></form></section>
  <section class="panel"><div class="metric-grid">
    ${metricCard("Status", report.status, "server-mode readiness")}
    ${metricCard("Mode", report.mode.enabled ? "enabled" : "local-only", report.mode.networkExposed ? "network-exposed bind" : "loopback bind")}
    ${metricCard("Bind", `${report.mode.bind}:${report.mode.port}`, report.mode.networkExposed ? "shared network candidate" : "local developer default")}
    ${metricCard("Auth", report.mode.authMode, report.mode.tokenConfigured ? "token configured" : "no token configured")}
    ${metricCard("Projects", report.projects.length, "registered project ids inspected")}
    ${metricCard("Origins", report.mode.allowedOrigins.length, "allowed browser origins")}
  </div><p class="muted">Generated ${renderDashboardDateTime(report.generatedAt)}. Current status: <span class="status ${statusClass}">${escapeHtml(report.status)}</span>.</p></section>
  <section class="panel"><h2>Readiness Checks</h2><div class="table-wrap"><table><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${checkRows}</tbody></table></div></section>
  <section class="panel"><h2>Endpoint Classes</h2><div class="table-wrap"><table><thead><tr><th>Class</th><th>Implementation</th><th>Ready</th><th>Required Controls</th></tr></thead><tbody>${endpointRows}</tbody></table></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Server Project IDs</h2><span class="muted">Client-facing preview. Future server-mode requests should use projectId instead of raw filesystem paths.</span></div><a class="button secondary" href="/api/server-projects?${escapeHtml(registryParams.toString())}">JSON</a></div><div class="table-wrap"><table><thead><tr><th>Project</th><th>Root</th><th>Default Workflows</th><th>Request Example</th></tr></thead><tbody>${registryRows || '<tr><td colspan="4">No registered projects found.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><h2>Registered Projects</h2><div class="table-wrap"><table><thead><tr><th>Project</th><th>Root</th><th>Config</th><th>Roles</th><th>Role IDs</th></tr></thead><tbody>${projectRows || '<tr><td colspan="5">No registered projects found.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><h2>Services</h2><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th>Detail</th></tr></thead><tbody>${serviceRows || '<tr><td colspan="3">No service checks were recorded.</td></tr>'}</tbody></table></div></section>
  <section class="panel"><h2>Recommended Commands</h2><ul>${commandRows}</ul></section>
  <section class="panel"><h2>Notes</h2><ul>${noteRows || '<li>No server-mode notes found.</li>'}</ul></section></main></body></html>`;
}

function renderArtifactLifecycleHtml(report: ArtifactLifecycleReport, projects: DashboardProjectSummary[], params: URLSearchParams): string {
  const projectOptions = projects.map((project) => `<option value="${escapeHtml(project.rootUri)}"${report.projectRootUri === project.rootUri ? " selected" : ""}>${escapeHtml(project.name)}</option>`).join("");
  const kinds = [...new Set(report.recentArtifacts.map((artifact) => artifact.kind))].sort();
  const kindOptions = kinds.map((kind) => `<option value="${escapeHtml(kind)}"${report.artifactKind === kind ? " selected" : ""}>${escapeHtml(kind)}</option>`).join("");
  const hintRows = report.reviewHints.map((hint) => `<li>${escapeHtml(hint)}</li>`).join("");
  const activeLifecycleCriteria = report.prunePlan?.criteria ?? report.archivePlan?.criteria ?? report.restorePlan?.criteria ?? null;
  const renderLifecycleActionRows = (plan: ArtifactPrunePlan | ArtifactLifecycleActionPlan | null) => plan?.candidates.slice(0, 100).map((candidate) => `
    <tr>
      <td><code>${escapeHtml(candidate.artifactId)}</code><br><span class="muted">${escapeHtml(candidate.kind)}</span></td>
      <td>${escapeHtml(candidate.projectName)}<br><span class="muted">${escapeHtml(candidate.workflowId)} / ${escapeHtml(candidate.runStatus)}</span></td>
      <td><a href="/run?id=${encodeURIComponent(candidate.runId)}">${escapeHtml(candidate.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(candidate.taskId?.slice(0, 8) ?? "run-level")}</span></td>
      <td>${candidate.ageDays === null ? "unknown" : `${candidate.ageDays}d`}<br><span class="muted">${escapeHtml(formatBytes(candidate.contentBytes))}</span></td>
      <td>${escapeHtml(candidate.reason)}</td>
      <td><code>${escapeHtml(candidate.receiptPreview.actionType)}</code><br><span class="muted">${escapeHtml(candidate.receiptPreview.summary)}</span></td>
      <td><code>${escapeHtml(candidate.uri)}</code></td>
    </tr>`).join("") ?? "";
  const pruneRows = report.prunePlan?.candidates.slice(0, 100).map((candidate) => `
    <tr>
      <td><code>${escapeHtml(candidate.artifactId)}</code><br><span class="muted">${escapeHtml(candidate.kind)}</span></td>
      <td>${escapeHtml(candidate.projectName)}<br><span class="muted">${escapeHtml(candidate.workflowId)} / ${escapeHtml(candidate.runStatus)}</span></td>
      <td><a href="/run?id=${encodeURIComponent(candidate.runId)}">${escapeHtml(candidate.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(candidate.taskId?.slice(0, 8) ?? "run-level")}</span></td>
      <td>${candidate.ageDays === null ? "unknown" : `${candidate.ageDays}d`}<br><span class="muted">${escapeHtml(formatBytes(candidate.contentBytes))}</span></td>
      <td>${escapeHtml(candidate.reason)}</td>
      <td><code>${escapeHtml(candidate.receiptPreview.actionType)}</code><br><span class="muted">${escapeHtml(candidate.receiptPreview.summary)}</span></td>
      <td><code>${escapeHtml(candidate.uri)}</code></td>
    </tr>`).join("") ?? "";
  const pruneNotes = report.prunePlan?.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("") ?? "";
  const renderQueueApprovalForm = (action: ArtifactLifecycleAction) => report.projectRootUri ? `<form class="inline-form" method="post" action="/api/artifact-lifecycle-action">
    <input type="hidden" name="action" value="queue-${escapeHtml(action)}-approvals">
    <input type="hidden" name="project" value="${escapeHtml(report.projectRootUri)}">
    <input type="hidden" name="kind" value="${escapeHtml(report.artifactKind ?? "")}">
    <input type="hidden" name="limit" value="${escapeHtml(String(report.limit))}">
    <input type="hidden" name="minAgeDays" value="${escapeHtml(params.get("minAgeDays") ?? "")}">
    <input type="hidden" name="minBytes" value="${escapeHtml(params.get("minBytes") ?? "")}">
    <input type="hidden" name="includeAudit" value="${artifactLifecyclePlanForAction(report, action)?.criteria.includeAudit ? "true" : "false"}">
    <label>Requester role<input name="actorRole" value="operator"></label>
    <button type="submit">Queue ${escapeHtml(titleCase(action))} Approvals</button>
  </form>` : "";
  const queueApprovalForm = report.prunePlan ? renderQueueApprovalForm("prune") : "";
  const renderLifecyclePlanPanel = (plan: ArtifactLifecycleActionPlan | null) => plan ? `<section class="panel"><div class="section-heading"><div><h2>Dry-run ${escapeHtml(titleCase(plan.action))} Plan</h2><span class="muted">Preview only. No artifacts are moved, restored, archived, deleted, or modified.</span></div><div class="meta-grid"><div><strong>Candidates</strong>${plan.totalCandidates}</div><div><strong>Recoverable</strong>${escapeHtml(formatBytes(plan.estimatedBytesRecoverable))}</div><div><strong>Criteria</strong>${escapeHtml(plan.criteria.policySource)}</div><div><strong>Approval</strong>${plan.approvalRequired ? "required" : "not required by policy"}</div></div></div><ul>${plan.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>${renderQueueApprovalForm(plan.action) || '<p class="muted">Select a project to queue lifecycle approvals for this plan.</p>'}<div class="table-wrap"><table><thead><tr><th>Artifact</th><th>Project</th><th>Run</th><th>Age/Size</th><th>Reason</th><th>Receipt Preview</th><th>URI</th></tr></thead><tbody>${renderLifecycleActionRows(plan) || '<tr><td colspan="7">No artifacts matched the current lifecycle criteria.</td></tr>'}</tbody></table></div></section>` : "";
  const artifactRows = report.recentArtifacts.slice(0, 100).map((artifact) => `
    <tr>
      <td><strong>${escapeHtml(artifact.kind)}</strong><br><span class="muted">${escapeHtml(artifact.lifecycleHint)}</span></td>
      <td>${escapeHtml(artifact.projectName)}<br><span class="muted">${escapeHtml(artifact.workflowId)} / ${escapeHtml(artifact.runStatus)}</span></td>
      <td><a href="/run?id=${encodeURIComponent(artifact.runId)}">${escapeHtml(artifact.runId.slice(0, 8))}</a><br><span class="muted">${escapeHtml(artifact.taskId?.slice(0, 8) ?? "run-level")}</span></td>
      <td>${escapeHtml(artifact.ageBucket)}<br><span class="muted">${renderDashboardDateTime(artifact.createdAt)}</span></td>
      <td>${escapeHtml(formatBytes(artifact.contentBytes))}</td>
      <td><code>${escapeHtml(artifact.uri)}</code></td>
    </tr>`).join("");
  const filters = `<form method="get" class="form-grid">
    <label>Project<select name="project"><option value="">all registered projects</option>${projectOptions}</select></label>
    <label>Kind<select name="kind"><option value="">all artifact kinds</option>${kindOptions}</select></label>
    <label>Recent artifacts<input name="limit" inputmode="numeric" value="${escapeHtml(String(report.limit))}"></label>
    <label>Min age days<input name="minAgeDays" inputmode="numeric" placeholder="${escapeHtml(String(report.retentionPolicy.retentionDays))}" value="${escapeHtml(params.get("minAgeDays") ?? "")}"></label>
    <label>Min bytes<input name="minBytes" inputmode="numeric" placeholder="${escapeHtml(String(report.retentionPolicy.minPruneBytes))}" value="${escapeHtml(params.get("minBytes") ?? "")}"></label>
    <label class="check-row"><input type="checkbox" name="prunePlan" value="true"${report.prunePlan ? " checked" : ""}> Show dry-run prune plan</label>
    <label class="check-row"><input type="checkbox" name="archivePlan" value="true"${report.archivePlan ? " checked" : ""}> Show dry-run archive plan</label>
    <label class="check-row"><input type="checkbox" name="restorePlan" value="true"${report.restorePlan ? " checked" : ""}> Show dry-run restore plan</label>
    <label class="check-row"><input type="checkbox" name="includeAudit" value="true"${activeLifecycleCriteria?.includeAudit ? " checked" : ""}> Include audit artifacts</label>
    <div class="form-actions"><button type="submit">Filter</button></div>
  </form>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Artifact Lifecycle</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("artifact-lifecycle")}
  <main><div class="topbar"><div><a href="/">Dashboard</a><h1>Artifact Lifecycle</h1><p class="muted">Read-only storage inventory for run artifacts. This page does not prune, archive, or delete anything.</p></div><a class="button secondary" href="/api/artifact-lifecycle?${escapeHtml(params.toString())}">JSON</a></div>
  <section class="panel">${filters}<div class="meta-grid"><div><strong>Artifacts</strong>${report.totalArtifacts}</div><div><strong>Estimated JSON</strong>${escapeHtml(formatBytes(report.estimatedBytes))}</div><div><strong>Kinds</strong>${Object.keys(report.byKind).length}</div><div><strong>Projects</strong>${Object.keys(report.byProject).length}</div></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Retention Policy</h2><span class="muted">Project-local defaults from .agent-workflow/project.yaml. Empty filter fields use this policy; filled fields become preview-only overrides.</span></div></div><div class="meta-grid"><div><strong>Source</strong>${escapeHtml(report.retentionPolicy.source)}</div><div><strong>Retention</strong>${report.retentionPolicy.retentionDays} days</div><div><strong>Minimum size</strong>${escapeHtml(formatBytes(report.retentionPolicy.minPruneBytes))}</div><div><strong>Audit artifacts</strong>${report.retentionPolicy.retainAuditArtifacts ? "retained by default" : "eligible by policy"}</div><div><strong>Legal hold</strong>${report.retentionPolicy.legalHold ? "enabled" : "off"}</div><div><strong>Approval</strong>${report.retentionPolicy.requireApprovalForPrune ? "required" : "project policy allows approval-free preview"}</div><div><strong>Archive execution</strong>${report.retentionPolicy.allowArchiveExecution ? "enabled" : "disabled"}</div><div><strong>Restore execution</strong>${report.retentionPolicy.allowRestoreExecution ? "enabled" : "disabled"}</div><div><strong>Prune execution</strong>${report.retentionPolicy.allowPruneExecution ? "enabled" : "disabled"}</div></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Lifecycle Hints</h2><span class="muted">Hints are conservative and non-destructive. Future prune plans should cite exact ids and require approval.</span></div></div><ul>${hintRows || "<li>No lifecycle concerns found in the inspected artifact window.</li>"}</ul></section>
  ${report.prunePlan ? `<section class="panel"><div class="section-heading"><div><h2>Dry-run Prune Plan</h2><span class="muted">Preview only. No artifacts are deleted, archived, or modified.</span></div><div class="meta-grid"><div><strong>Candidates</strong>${report.prunePlan.totalCandidates}</div><div><strong>Recoverable</strong>${escapeHtml(formatBytes(report.prunePlan.estimatedBytesRecoverable))}</div><div><strong>Criteria</strong>${escapeHtml(report.prunePlan.criteria.policySource)}</div><div><strong>Approval</strong>${report.prunePlan.approvalRequired ? "required" : "not required by policy"}</div></div></div><ul>${pruneNotes}</ul>${queueApprovalForm || '<p class="muted">Select a project to queue lifecycle approvals for this prune plan.</p>'}<div class="table-wrap"><table><thead><tr><th>Artifact</th><th>Project</th><th>Run</th><th>Age/Size</th><th>Reason</th><th>Receipt Preview</th><th>URI</th></tr></thead><tbody>${pruneRows || '<tr><td colspan="7">No artifacts matched the current prune criteria.</td></tr>'}</tbody></table></div></section>` : ""}
  ${renderLifecyclePlanPanel(report.archivePlan)}
  ${renderLifecyclePlanPanel(report.restorePlan)}
  <section class="panel"><div class="meta-grid"><div><strong>By Kind</strong>${escapeHtml(formatInlineCounts(report.byKind) || "none")}</div><div><strong>By Age</strong>${escapeHtml(formatInlineCounts(report.byAgeBucket) || "none")}</div><div><strong>By Run Status</strong>${escapeHtml(formatInlineCounts(report.byRunStatus) || "none")}</div></div></section>
  <section class="panel"><div class="section-heading"><div><h2>Recent Artifacts</h2><span class="muted">Showing up to 100 newest rows from the inspected window.</span></div></div><div class="table-wrap"><table><thead><tr><th>Kind</th><th>Project</th><th>Run</th><th>Age</th><th>Size</th><th>URI</th></tr></thead><tbody>${artifactRows || '<tr><td colspan="6">No artifacts found.</td></tr>'}</tbody></table></div></section></main></body></html>`;
}

type DashboardBundleReadiness = {
  generatedAt: string;
  projectDir: string | null;
  verification: BundleVerification;
  compatibility: BundleCompatibilityReport;
  registry: BundleRegistryReport;
  pin: { path: string; value: ProjectBundlePin | null } | null;
  upgradePreview: BundleUpgradePreview;
  migrationPlan: DefinitionMigrationPlan;
  contractTests: ContractTestReport;
  errors: string[];
};

async function loadDashboardBundleRegistry(params: URLSearchParams): Promise<BundleRegistryReport> {
  const registryPath = path.resolve(process.cwd(), params.get("registry")?.trim() || defaultBundleRegistryPath);
  const registry = await loadBundleRegistry(registryPath);
  const manifest = await loadCommittedBundleManifest(rootDir);
  return buildBundleRegistryReport({
    registry,
    registryPath,
    installedManifest: manifest,
    installedChecksum: manifest?.checksum.value
  });
}

async function loadDashboardBundleReadiness(params: URLSearchParams): Promise<DashboardBundleReadiness> {
  const projectParam = params.get("project")?.trim();
  const projectDir = projectParam ? path.resolve(process.cwd(), projectParam) : undefined;
  const errors: string[] = [];
  if (projectDir) {
    try {
      await fs.access(projectDir);
    } catch {
      errors.push(`Project path is not reachable: ${projectDir}`);
    }
  }

  const policy = normalizePolicy(params.get("policy") ?? process.env.AGENTFLOW_BUNDLE_TRUST_POLICY);
  const manifest = await loadCommittedBundleManifest(rootDir);
  if (!manifest) throw new Error("Bundle manifest is missing.");
  const packageJson = await readJsonFile<{ version?: string }>(path.join(rootDir, "package.json"));
  const statePath = projectDir ? path.join(projectDir, ".agent-workflow", "bundle-state.json") : undefined;
  const pinPath = projectDir ? path.join(projectDir, ".agent-workflow", "bundle-pin.json") : undefined;
  const state = statePath ? await readJsonFile<ProjectBundleState>(statePath) : null;
  const pin = pinPath ? await readJsonFile<ProjectBundlePin>(pinPath) : null;
  const compatibility = buildBundleCompatibilityReport(manifest, {
    agentWorkflow: packageJson?.version ?? "0.0.0",
    node: process.version.slice(1),
    mcp: manifest.compatibility.mcp
  });
  const upgradePreview = buildBundleUpgradePreview(manifest, {
    state: state ?? undefined,
    statePath
  });
  const catalog = await loadDefinitionMigrationCatalog(rootDir);
  const migrationPlan = buildDefinitionMigrationPlan({
    manifest,
    catalog,
    state: state ?? undefined,
    statePath
  });
  const contractTests = await runDefinitionContractTests({
    definitionsDir: rootDir,
    projectDir,
    provider: providerFromEnv("mock"),
    liveProvider: false
  });
  const registry = await loadDashboardBundleRegistry(params);
  return {
    generatedAt: new Date().toISOString(),
    projectDir: projectDir ?? null,
    verification: await verifyBundle(rootDir, policy),
    compatibility,
    registry,
    pin: pinPath ? { path: pinPath, value: pin } : null,
    upgradePreview,
    migrationPlan,
    contractTests,
    errors
  };
}

function renderBundleTrustHtml(readiness: DashboardBundleReadiness, params: URLSearchParams): string {
  const verification = readiness.verification;
  const statusClass = verification.status === "trusted" ? "good" : verification.allowed ? "warn" : "bad";
  const query = params.toString();
  const jsonHref = `/api/bundles${query ? `?${query}` : ""}`;
  const projectValue = readiness.projectDir ?? "";
  const failedContracts = readiness.contractTests.results.filter((result) => result.status === "fail").length;
  const skippedContracts = readiness.contractTests.results.filter((result) => result.status === "skip").length;
  const migrationCount = readiness.migrationPlan.migrations.length;
  const registryRows = readiness.registry.entries.map((entry) => `
    <tr><td>${entry.selected ? "<strong>" : ""}${escapeHtml(entry.name)}${entry.selected ? "</strong>" : ""}<br><span class="muted">${escapeHtml(entry.id)}</span></td><td><span class="flag ${entry.status === "installed-current" ? "good" : entry.status === "upgrade-available" ? "warn" : "neutral"}">${escapeHtml(entry.status)}</span></td><td>${escapeHtml(entry.latestVersion)}</td><td>${escapeHtml(entry.packageName ?? "none")}</td><td>${entry.install.npm ? `<code>${escapeHtml(entry.install.npm)}</code>` : escapeHtml(entry.source)}</td></tr>
  `).join("");
  const pinHtml = readiness.pin
    ? readiness.pin.value
      ? `<h3>Project Pin</h3><div class="meta-grid compact"><div><strong>Bundle</strong>${escapeHtml(readiness.pin.value.bundle.id)} ${escapeHtml(readiness.pin.value.bundle.version)}</div><div><strong>Package</strong>${escapeHtml(readiness.pin.value.bundle.packageName ?? "none")}</div><div><strong>Pinned</strong>${renderDashboardDateTime(readiness.pin.value.bundle.pinnedAt)}</div><div><strong>By</strong>${escapeHtml(readiness.pin.value.bundle.pinnedBy)}</div></div><p class="muted">${escapeHtml(readiness.pin.path)}</p>`
      : `<h3>Project Pin</h3><p class="muted">No project-local bundle pin found at ${escapeHtml(readiness.pin.path)}.</p>`
    : "";
  const compatibilityRows = readiness.compatibility.checks.map((check) => `
    <tr><td>${escapeHtml(check.label)}</td><td><span class="flag ${check.compatible ? "good" : "bad"}">${check.compatible ? "pass" : "fail"}</span></td><td><code>${escapeHtml(check.actual)}</code></td><td><code>${escapeHtml(check.required)}</code></td><td>${escapeHtml(check.detail)}</td></tr>
  `).join("");
  const contractRows = readiness.contractTests.results.slice(0, 16).map((result) => `
    <tr><td><span class="flag ${result.status === "pass" ? "good" : result.status === "skip" ? "warn" : "bad"}">${escapeHtml(result.status)}</span></td><td>${escapeHtml(result.id)}</td><td>${escapeHtml(result.detail)}</td></tr>
  `).join("");
  const lifecycleForm = bundleLifecyclePlanForm(readiness, params);
  const migrationItems = readiness.migrationPlan.migrations.map((migration) => `
    <details class="artifact"><summary>${escapeHtml(migration.id)}: ${escapeHtml(migration.from)} to ${escapeHtml(migration.to)}</summary>
      <p>${escapeHtml(migration.summary)}</p>
      <h3>Validation</h3><ul>${migration.validation.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
      <h3>Rollback</h3><ul>${migration.rollbackSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </details>
  `).join("");
  const errorBlock = readiness.errors.length
    ? `<section class="panel warn-panel"><h2>Needs attention</h2><ul>${readiness.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></section>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Bundle Trust</title><style>${dashboardCss()}</style></head><body>
  ${dashboardNav("bundles")}
  <main><div class="topbar"><div><a href="/">Dashboard</a><h1>Workflow Bundle Readiness</h1><p class="muted">Read-only trust, compatibility, migration, and contract-test visibility. A signature never expands project execution permissions.</p></div><a class="button secondary" href="${escapeHtml(jsonHref)}">JSON</a></div>
  <section class="panel"><form method="get" class="workflow-form"><label class="wide">Project path<input name="project" value="${escapeHtml(projectValue)}" placeholder="/path/to/project"></label><label>Trust policy<select name="policy">${["allow", "warn", "require"].map((policy) => `<option value="${policy}"${verification.policy === policy ? " selected" : ""}>${policy}</option>`).join("")}</select></label><div class="form-actions"><button type="submit">Inspect</button></div></form><p class="muted">Leave project path blank to inspect shared bundle readiness without project adoption state.</p></section>
  ${errorBlock}
  <section class="panel"><div class="metric-grid">
    ${metricCard("Trust", verification.status, verification.allowed ? "Current policy allows this bundle" : "Current policy rejects this bundle")}
    ${metricCard("Compatibility", readiness.compatibility.compatible ? "pass" : "fail", `${readiness.compatibility.checks.length} runtime checks`)}
    ${metricCard("Upgrade", readiness.upgradePreview.status, readiness.upgradePreview.source.kind)}
    ${metricCard("Migrations", migrationCount, readiness.migrationPlan.status)}
    ${metricCard("Contract Tests", readiness.contractTests.passed ? "pass" : "fail", `${failedContracts} failed, ${skippedContracts} skipped`)}
  </div><p class="muted">Generated ${renderDashboardDateTime(readiness.generatedAt)}${readiness.projectDir ? ` for ${escapeHtml(readiness.projectDir)}` : ""}.</p></section>
  <section class="panel"><div class="section-heading"><div><h2>${escapeHtml(verification.bundleId)} ${escapeHtml(verification.bundleVersion)}</h2><span class="muted">Manifest ${escapeHtml(verification.manifestChecksum)}</span></div><span class="flag ${statusClass}">${escapeHtml(verification.status)}</span></div>
  <div class="meta-grid"><div><strong>Policy</strong>${escapeHtml(verification.policy)}</div><div><strong>Decision</strong>${verification.allowed ? "allowed" : "rejected"}</div><div><strong>Signer</strong>${escapeHtml(verification.signerId ?? "none")}</div><div><strong>Trusted</strong>${verification.trusted}</div></div>
  <p><strong>Fingerprint:</strong> <code>${escapeHtml(verification.keyFingerprint ?? "none")}</code></p><p><strong>Signed:</strong> ${renderDashboardDateTime(verification.signedAt, "not signed")}<br><strong>Expires:</strong> ${renderDashboardDateTime(verification.expiresAt, "none")}</p>
  <h3>Verification</h3><ul>${verification.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>
  <section class="panel"><div class="section-heading"><div><h2>Trusted Registry</h2><span class="muted">${escapeHtml(readiness.registry.registryPath)}</span></div><a class="button secondary" href="/api/bundle-registry">JSON</a></div><div class="table-wrap"><table><thead><tr><th>Bundle</th><th>Status</th><th>Latest</th><th>Package</th><th>Install</th></tr></thead><tbody>${registryRows || '<tr><td colspan="5">No registry entries found.</td></tr>'}</tbody></table></div>${pinHtml}<p class="muted">Registry entries are discovery and governance metadata. Installing or adopting a bundle still requires explicit package-manager and trust-verification steps.</p></section>
  <section class="panel"><h2>Lifecycle Plan</h2><p class="muted">Generate a reviewed upgrade or rollback command plan. The dashboard never installs packages or changes adoption state.</p>${lifecycleForm}</section>
  <section class="panel"><h2>Compatibility</h2><div class="table-wrap"><table><thead><tr><th>Check</th><th>Status</th><th>Actual</th><th>Required</th><th>Detail</th></tr></thead><tbody>${compatibilityRows}</tbody></table></div></section>
  <section class="panel"><h2>Project Adoption</h2><div class="meta-grid"><div><strong>Source</strong>${escapeHtml(readiness.upgradePreview.source.kind)}</div><div><strong>Status</strong>${escapeHtml(readiness.upgradePreview.status)}</div><div><strong>Source Version</strong>${escapeHtml(readiness.upgradePreview.source.version ?? "none")}</div><div><strong>Recorded</strong>${renderDashboardDateTime(readiness.upgradePreview.source.recordedAt, "none")}</div></div><h3>Recommended Actions</h3><ul>${readiness.upgradePreview.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
  <section class="panel"><h2>Definition Migrations</h2>${migrationItems || "<p>No applicable definition migrations.</p>"}<h3>Recommended Actions</h3><ul>${readiness.migrationPlan.recommendations.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>
  <section class="panel"><h2>Contract-Test Readiness</h2><div class="meta-grid compact"><div><strong>Definitions</strong>${escapeHtml(readiness.contractTests.definitionsDir)}</div><div><strong>Project</strong>${escapeHtml(readiness.contractTests.projectDir ?? "none")}</div><div><strong>Provider</strong>${escapeHtml(readiness.contractTests.providerId)}</div><div><strong>Live Provider</strong>${readiness.contractTests.liveProvider ? "yes" : "no"}</div></div><div class="table-wrap"><table><thead><tr><th>Status</th><th>Check</th><th>Detail</th></tr></thead><tbody>${contractRows}</tbody></table></div>${readiness.contractTests.results.length > 16 ? `<p class="muted">${formatNumber(readiness.contractTests.results.length - 16)} additional checks are available in JSON.</p>` : ""}</section>
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
  observabilityReport: ObservabilityReport | null;
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
      <a class="button secondary" href="/api/observability?id=${encodeURIComponent(input.run.id)}">OTEL JSON</a>
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
      <h2>Observability</h2>
      ${input.observabilityReport ? renderObservabilityHtml(input.observabilityReport) : "<p>No observability data available.</p>"}
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
  const lanes = await loadWorkerHeartbeatLanes(heartbeatPath);
  const activeLane = lanes.find((lane) => lane.status === "running") ?? lanes[0];
  if (activeLane) {
    return {
      ...activeLane,
      lanes
    };
  }
  return {
    heartbeatPath,
    configured: false,
    workerId: null,
    status: "missing",
    pid: null,
    startedAt: null,
    lastHeartbeatAt: null,
    ageMs: null,
    limit: null,
    projectRootUri: null,
    concurrency: null,
    intervalMs: null,
    ticks: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
    processAlive: false,
    command: "npm run worker:daemon",
    lanes: []
  };
}

async function loadWorkerHeartbeatLanes(primaryHeartbeatPath: string): Promise<DashboardWorkerLane[]> {
  const candidates = new Set<string>([primaryHeartbeatPath]);
  try {
    const entries = await fs.readdir(defaultWorkerHeartbeatDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        candidates.add(path.join(defaultWorkerHeartbeatDir, entry.name));
      }
    }
  } catch {
    // Older installs only have the single heartbeat file.
  }

  const loaded = await Promise.all([...candidates].map((candidate) => loadWorkerHeartbeatLane(candidate)));
  const byWorkerProcess = new Map<string, DashboardWorkerLane>();
  for (const lane of loaded.filter((item): item is DashboardWorkerLane => Boolean(item))) {
    const key = `${lane.workerId ?? "unknown"}:${lane.pid ?? lane.heartbeatPath}`;
    const existing = byWorkerProcess.get(key);
    if (!existing || (lane.lastHeartbeatAt ?? "") > (existing.lastHeartbeatAt ?? "")) {
      byWorkerProcess.set(key, lane);
    }
  }
  return [...byWorkerProcess.values()].sort((left, right) => {
    if (left.status === "running" && right.status !== "running") return -1;
    if (right.status === "running" && left.status !== "running") return 1;
    return (right.lastHeartbeatAt ?? "").localeCompare(left.lastHeartbeatAt ?? "");
  });
}

async function loadWorkerHeartbeatLane(heartbeatPath: string): Promise<DashboardWorkerLane | null> {
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
      workerId: typeof heartbeat.workerId === "string" ? heartbeat.workerId : null,
      status: running ? "running" : heartbeatStatus === "stopped" ? "stopped" : "stale",
      pid,
      startedAt: typeof heartbeat.startedAt === "string" ? heartbeat.startedAt : null,
      lastHeartbeatAt,
      ageMs,
      limit: typeof heartbeat.limit === "number" ? heartbeat.limit : null,
      projectRootUri: typeof heartbeat.projectRootUri === "string" ? heartbeat.projectRootUri : null,
      concurrency: typeof heartbeat.concurrency === "number" ? heartbeat.concurrency : null,
      intervalMs,
      ticks: typeof heartbeat.ticks === "number" ? heartbeat.ticks : 0,
      claimed: typeof heartbeat.claimed === "number" ? heartbeat.claimed : 0,
      completed: typeof heartbeat.completed === "number" ? heartbeat.completed : 0,
      failed: typeof heartbeat.failed === "number" ? heartbeat.failed : 0,
      processAlive,
      command: typeof heartbeat.command === "string" ? heartbeat.command : "npm run worker:daemon"
    };
  } catch {
    return null;
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

async function loadLearningDaemonStatus(projectDir: string): Promise<DashboardLearningDaemonStatus> {
  const heartbeatPath = path.join(projectDir, ".agent-workflow", "learning", "daemon-status.json");
  try {
    const heartbeat = JSON.parse(await fs.readFile(heartbeatPath, "utf8")) as Partial<LearningDaemonHeartbeat>;
    const lastHeartbeatAt = typeof heartbeat.lastHeartbeatAt === "string" ? heartbeat.lastHeartbeatAt : null;
    const ageMs = lastHeartbeatAt ? Date.now() - Date.parse(lastHeartbeatAt) : null;
    const intervalMs = typeof heartbeat.intervalMs === "number" ? heartbeat.intervalMs : null;
    const staleAfterMs = Math.max((intervalMs ?? 60000) * 3, 120_000);
    const pid = typeof heartbeat.pid === "number" ? heartbeat.pid : null;
    const processAlive = pid ? isProcessAlive(pid) : false;
    const heartbeatStatus = heartbeat.status ?? "stopped";
    const running = processAlive && ageMs !== null && ageMs <= staleAfterMs && heartbeatStatus !== "stopped" && heartbeatStatus !== "stopping" && heartbeatStatus !== "failed";
    return {
      heartbeatPath,
      configured: true,
      projectRootUri: typeof heartbeat.projectRootUri === "string" ? heartbeat.projectRootUri : projectDir,
      daemonId: typeof heartbeat.daemonId === "string" ? heartbeat.daemonId : null,
      mode: heartbeat.mode === "observe" || heartbeat.mode === "propose" ? heartbeat.mode : null,
      status: running ? "running" : heartbeatStatus === "failed" ? "failed" : heartbeatStatus === "stopped" ? "stopped" : "stale",
      pid,
      processAlive,
      startedAt: typeof heartbeat.startedAt === "string" ? heartbeat.startedAt : null,
      lastHeartbeatAt,
      lastReportAt: typeof heartbeat.lastReportAt === "string" ? heartbeat.lastReportAt : null,
      ageMs,
      intervalMs,
      limit: typeof heartbeat.limit === "number" ? heartbeat.limit : null,
      ticks: typeof heartbeat.ticks === "number" ? heartbeat.ticks : 0,
      proposals: typeof heartbeat.proposals === "number" ? heartbeat.proposals : 0,
      inboxItems: typeof heartbeat.inboxItems === "number" ? heartbeat.inboxItems : 0,
      lastError: typeof heartbeat.lastError === "string" ? heartbeat.lastError : "",
      command: typeof heartbeat.command === "string" ? heartbeat.command : `npm run agentflow -- learning-daemon --project ${shellQuote(projectDir)} --mode observe`
    };
  } catch {
    return {
      heartbeatPath,
      configured: false,
      projectRootUri: projectDir,
      daemonId: null,
      mode: null,
      status: "missing",
      pid: null,
      processAlive: false,
      startedAt: null,
      lastHeartbeatAt: null,
      lastReportAt: null,
      ageMs: null,
      intervalMs: null,
      limit: null,
      ticks: 0,
      proposals: 0,
      inboxItems: 0,
      lastError: "",
      command: `npm run agentflow -- learning-daemon --project ${shellQuote(projectDir)} --mode observe`
    };
  }
}

function formatLearningDaemonStatus(status: DashboardLearningDaemonStatus): string {
  return [
    `Learning daemon: ${status.status}`,
    `Project: ${status.projectRootUri}`,
    `Mode: ${status.mode ?? "n/a"}`,
    `Daemon: ${status.daemonId ?? "n/a"}`,
    `PID: ${status.pid ?? "none"} (${status.processAlive ? "alive" : "not running"})`,
    `Last heartbeat: ${status.lastHeartbeatAt ?? "none"}`,
    `Last report: ${status.lastReportAt ?? "none"}`,
    `Ticks: ${status.ticks}`,
    `Proposals: ${status.proposals}`,
    `Inbox items: ${status.inboxItems}`,
    status.lastError ? `Last error: ${status.lastError}` : "",
    `Heartbeat file: ${status.heartbeatPath}`,
    `Start command: ${status.command}`
  ].filter(Boolean).join("\n");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizeWorkerId(value?: string): string {
  const configured = value?.trim() || process.env.AGENTFLOW_WORKER_ID?.trim();
  if (configured) {
    return configured;
  }
  const host = os.hostname().replace(/[^a-zA-Z0-9_.-]/g, "-") || "local";
  return `${host}:${process.pid}`;
}

function parseLearningDaemonMode(value: string): LearningDaemonMode {
  if (value === "observe" || value === "propose") return value;
  throw new Error(`Learning daemon mode must be observe or propose. Received: ${value}`);
}

function safeWorkerHeartbeatFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/^-+|-+$/g, "") || "worker";
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
      `Provider: ${selectedProvider}`,
      "New workflow tasks will use this model. Restart any already-running workers if you need them to pick up the change immediately.",
      "Open: /providers"
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
      "New workflow tasks will use this routing. Already-running workers should be restarted if they need the updated environment.",
      "Open: /providers"
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
        formatIndexResult(result),
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
  workerConcurrency?: string;
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
    const workerConcurrency = parseBoundedPositiveInteger(input.workerConcurrency ?? "1", 1, 16);
    const timeoutMs = parsePositiveInteger(input.timeoutMs ?? "60000", 60000);
    const ticks: string[] = [];
    const watchResult = await watchWorkflowRun({
      runId: queued.run.runId,
      workerLimit,
      workerConcurrency,
      projectRootUri: queued.projectDir,
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
  workerConcurrency: string;
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
  const workerConcurrency = parseBoundedPositiveInteger(input.workerConcurrency || "1", 1, 16);
  const timeoutMs = parsePositiveInteger(input.timeoutMs || "60000", 60000);
  if (input.mode === "watch") {
    const ticks: string[] = [];
    const watchResult = await watchWorkflowRun({
      runId,
      workerLimit,
      workerConcurrency,
      projectRootUri: details.run.projectRootUri,
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

  const workerResult = await runWorkerOnce(workerLimit, { workerId: normalizeWorkerId("dashboard"), projectRootUri: details.run.projectRootUri, concurrency: workerConcurrency });
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
  workerConcurrency: string;
  project: string;
  reason: string;
  confirmed: boolean;
}): Promise<DashboardFollowUpResult> {
  const action = input.action.trim();
  const runId = input.runId.trim();

  if (action === "process") {
    const workerLimit = parsePositiveInteger(input.workerLimit || "6", 6);
    const workerConcurrency = parseBoundedPositiveInteger(input.workerConcurrency || "1", 1, 16);
    const projectRootUri = input.project.trim() ? path.resolve(process.cwd(), input.project.trim()) : undefined;
    const workerResult = await runWorkerOnce(workerLimit, { workerId: normalizeWorkerId("dashboard"), projectRootUri, concurrency: workerConcurrency });
    return {
      ok: true,
      title: "Worker batch processed",
      output: [
        `Worker claimed ${workerResult.claimed}, completed ${workerResult.completed}, failed ${workerResult.failed}.`,
        `Project scope: ${projectRootUri ?? "all projects"}`,
        `Concurrency: ${workerConcurrency}`,
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

  if (action === "recover-expired-leases") {
    const result = await requeueExpiredWorkflowTaskLeases({
      runId: runId || undefined,
      actor: "dashboard",
      reason: input.reason.trim() || "Expired worker lease recovery requested from dashboard."
    });
    return {
      ok: true,
      title: "Expired worker leases recovered",
      runId: runId || undefined,
      output: [
        runId ? `Run: ${runId}` : "Run filter: all active runs",
        `Requeued expired tasks: ${result.requeuedTasks}`,
        `Affected runs: ${result.affectedRuns}`,
        "History, artifacts, and receipts were preserved.",
        runId ? `Open: /run?id=${encodeURIComponent(runId)}` : "Open: /queue"
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

async function processDashboardApprovalAction(input: {
  approvalId: string;
  decision: string;
  actorRole: string;
  note: string;
}): Promise<DashboardFollowUpResult> {
  const approvalId = input.approvalId.trim();
  const decision = input.decision.trim();
  if (!approvalId) {
    return { ok: false, error: "Missing approval id." };
  }
  if (decision === "execute") {
    return executeApprovedAction({ approvalId, actor: "dashboard", actorRole: normalizeActorRole(input.actorRole, "operator") });
  }
  if (decision !== "approved" && decision !== "rejected") {
    return { ok: false, error: "Decision must be approved or rejected." };
  }
  const approvalForGate = await getActionApproval(approvalId);
  if (!approvalForGate) {
    return { ok: false, error: "Approval was not found or is no longer pending." };
  }
  const project = await loadProjectConfig(approvalForGate.projectRootUri);
  const actorRole = normalizeActorRole(input.actorRole, "approver");
  const gate = evaluateRoleGate(project, actorRole, decision === "approved" ? "can_approve_actions" : "can_reject_actions");
  if (!gate.allowed) {
    return { ok: false, error: gate.message };
  }
  const approval = await decideActionApproval({
    approvalId,
    decision,
    actor: "dashboard",
    actorRole,
    note: input.note.trim() || undefined
  });
  if (!approval) {
    return { ok: false, error: "Approval was not found or is no longer pending." };
  }
  return {
    ok: true,
    title: `Action ${decision}`,
    runId: approval.runId,
    output: [
      `Approval: ${approval.id}`,
      `Action: ${approval.actionType}`,
      `Target: ${approval.target}`,
      `Run: ${approval.runId}`,
      `Project: ${approval.projectRootUri}`,
      `Actor role: ${approval.decidedRole ?? normalizeActorRole(input.actorRole, "approver")}`,
      `Role preview: ${rolePreviewForApproval(approval)}`,
      "Decision receipt was recorded.",
      "Open: /approvals"
    ].join("\n")
  };
}

async function processDashboardArtifactLifecycleAction(input: {
  action: string;
  project: string;
  kind: string;
  limit: string;
  minAgeDays: string;
  minBytes: string;
  includeAudit: boolean;
  actorRole: string;
}): Promise<DashboardFollowUpResult> {
  if (input.action !== "queue-prune-approvals" && input.action !== "queue-archive-approvals" && input.action !== "queue-restore-approvals") {
    return { ok: false, error: `Unsupported artifact lifecycle action: ${input.action || "none"}` };
  }
  const action: ArtifactLifecycleAction = input.action === "queue-archive-approvals" ? "archive" : input.action === "queue-restore-approvals" ? "restore" : "prune";
  const project = input.project.trim();
  if (!project) {
    return { ok: false, error: "Select a project before queueing lifecycle approvals." };
  }
  const report = await loadArtifactLifecycleReport({
    projectRootUri: project,
    kind: input.kind.trim() || undefined,
    limit: parsePositiveInteger(input.limit || "500", 500),
    prunePlan: action === "prune",
    archivePlan: action === "archive",
    restorePlan: action === "restore",
    minAgeDays: input.minAgeDays.trim() ? parseNonNegativeInteger(input.minAgeDays, 30) : undefined,
    minBytes: input.minBytes.trim() ? parseNonNegativeInteger(input.minBytes, 20_000) : undefined,
    includeAudit: input.includeAudit ? true : undefined
  });
  const queue = await queueArtifactLifecycleApprovals({
    report,
    action,
    actor: "dashboard",
    actorRole: normalizeActorRole(input.actorRole, "operator")
  });
  const plan = artifactLifecyclePlanForAction(report, action);
  return {
    ok: true,
    title: `Lifecycle ${action} approvals queued`,
    output: [
      `Project: ${report.projectRootUri}`,
      `Policy source: ${report.retentionPolicy.source}`,
      `Criteria source: ${plan?.criteria.policySource ?? "none"}`,
      `Candidates: ${plan?.totalCandidates ?? 0}`,
      `Approval requests: ${queue.totalRequested}`,
      ...queue.skipped.map((item) => `Skipped: ${item}`),
      ...queue.approvals.slice(0, 10).map((approval) => `Approval ${approval.approvalId}: ${approval.status} ${approval.target}`),
      "No artifacts were deleted or modified. Archive and restore execution create copied snapshots only after approval and matching project capability flags.",
      "Open: /approvals"
    ].join("\n")
  };
}

async function requestRunLevelApproval(input: {
  projectPath: string;
  type: string;
  target: string;
  rationale: string;
  workflowId?: string;
  policyProfile?: string;
  actor: string;
  actorRole?: string;
}): Promise<DashboardFollowUpResult & { approvalId?: string }> {
  const approvalType = input.type.trim().toLowerCase();
  if (approvalType !== "deployment" && approvalType !== "autonomy") {
    return { ok: false, error: "--type must be deployment or autonomy" };
  }
  const target = input.target.trim();
  const rationale = input.rationale.trim();
  if (!target) {
    return { ok: false, error: "Approval target is required." };
  }
  if (!rationale) {
    return { ok: false, error: "Approval rationale is required." };
  }

  const projectDir = path.resolve(process.cwd(), input.projectPath);
  const configuredProject = await loadProjectConfig(projectDir);
  const requestRoleGate = evaluateRoleGate(configuredProject, input.actorRole ?? configuredProject.team.default_actor_role, "can_request_approvals");
  if (!requestRoleGate.allowed) {
    return { ok: false, error: requestRoleGate.message };
  }
  let resolvedPolicy: ReturnType<typeof resolveExecutionPolicy>;
  try {
    resolvedPolicy = resolveExecutionPolicy(configuredProject, input.policyProfile);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const workflows = await loadWorkflows(rootDir);
  const workflowId = input.workflowId ?? (approvalType === "deployment" ? "ship-release" : "wide-open-automation");
  const workflow = resolveWorkflow(workflows, workflowId);
  if (!workflow) {
    return { ok: false, error: `Unknown workflow: ${workflowId}` };
  }

  const agents = await loadAgentRecords(rootDir);
  const workflowRecords = await loadWorkflowRecords(rootDir);
  await seedRegistry(agents, workflowRecords);

  const actionType = approvalType === "deployment" ? "deployment" : "autonomy";
  const runTask = approvalType === "deployment"
    ? `Approval requested to deploy or release: ${target}`
    : `Approval requested for autonomy change: ${target}`;
  const payload = {
    requestType: approvalType,
    target,
    requestedBy: input.actor,
    requestedByRole: input.actorRole ?? null,
    policyProfile: resolvedPolicy.profile,
    projectAutonomy: String(resolvedPolicy.project.project.autonomy),
    workflowId: workflow.id,
    requestedAt: new Date().toISOString()
  };
  const idempotencyKey = stableHash({
    requestType: approvalType,
    projectDir,
    workflowId: workflow.id,
    target,
    rationale,
    policySnapshotHash: resolvedPolicy.snapshotHash
  });

  const run = await createWorkflowRun({
    projectName: resolvedPolicy.project.project.name,
    projectRootUri: projectDir,
    projectProfile: resolvedPolicy.project.project.autonomy === "wide-open" ? "enterprise" : "custom",
    projectConfig: configuredProject,
    workflow,
    task: runTask,
    autonomy: String(resolvedPolicy.project.project.autonomy),
    policyProfile: resolvedPolicy.profile,
    policySnapshot: resolvedPolicy.snapshot,
    policySnapshotHash: resolvedPolicy.snapshotHash,
    compiledBrief: [
      "# Approval Request",
      "",
      `Type: ${approvalType}`,
      `Target: ${target}`,
      `Project: ${resolvedPolicy.project.project.name}`,
      `Policy profile: ${resolvedPolicy.profile}`,
      `Policy snapshot: ${resolvedPolicy.snapshotHash}`,
      "",
      "## Rationale",
      rationale
    ].join("\n"),
    compiledBriefMetadata: {
      approvalRequest: payload
    }
  });

  const approval = await requestActionApproval({
    runId: run.runId,
    taskId: null,
    stageId: `${approvalType}-approval`,
    agentId: workflow.lead,
    actionType,
    target,
    rationale,
    policyDecision: {
      approvalRequired: true,
      requestType: approvalType,
      actorRole: input.actorRole ?? null,
      policyProfile: resolvedPolicy.profile,
      policySnapshotHash: resolvedPolicy.snapshotHash
    },
    payload,
    idempotencyKey
  });
  await completeApprovalRequestRun({
    runId: run.runId,
    agentId: workflow.lead,
    summary: `${approvalType} approval request queued for ${target}`,
    metadata: {
      ...payload,
      target,
      actorRole: input.actorRole ?? null,
      approvalId: approval.approvalId
    }
  });

  return {
    ok: true,
    title: "Approval request queued",
    runId: run.runId,
    approvalId: approval.approvalId,
    output: [
      `Approval: ${approval.approvalId}`,
      `Type: ${actionType}`,
      `Target: ${target}`,
      `Requester role: ${input.actorRole ?? "operator"}`,
      `Role gate: ${requestRoleGate.message}`,
      "Role preview: request expects operator; decision expects approver.",
      `Run: ${run.runId}`,
      `Workflow context: ${workflow.id}`,
      `Project: ${projectDir}`,
      "Open: /approvals"
    ].join("\n")
  };
}

async function executeApprovedAction(input: {
  approvalId: string;
  actor: string;
  actorRole?: string;
}): Promise<DashboardFollowUpResult> {
  const approval = await getActionApproval(input.approvalId);
  if (!approval) {
    return { ok: false, error: `Unknown approval: ${input.approvalId}` };
  }
  if (approval.status === "executed") {
    return {
      ok: true,
      title: "Action already executed",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        `Action: ${approval.actionType}`,
        `Target: ${approval.target}`,
        "Existing execution status was preserved."
      ].join("\n")
    };
  }
  if (approval.status !== "approved" && approval.status !== "failed") {
    return { ok: false, error: `Approval must be approved before execution. Current status: ${approval.status}` };
  }
  const project = await loadProjectConfig(approval.projectRootUri);
  const executionRoleGate = evaluateRoleGate(project, input.actorRole ?? project.team.default_actor_role, "can_execute_approved_actions");
  if (!executionRoleGate.allowed) {
    return { ok: false, error: executionRoleGate.message };
  }
  const separationGate = evaluateSeparationOfDuties(project, approval, input.actor);
  if (!separationGate.allowed) {
    return { ok: false, error: separationGate.message };
  }

  if (approval.actionType === "deployment" || approval.actionType === "autonomy") {
    return {
      ok: true,
      title: "Approval decision recorded",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        `Action: ${approval.actionType}`,
        `Target: ${approval.target}`,
        `Role gate: ${executionRoleGate.message}`,
        `Separation of duties: ${separationGate.message}`,
        "This approval records a human decision; it does not execute a local command.",
        "Run any deployment or autonomy-changing command separately under project policy."
      ].join("\n")
    };
  }

  if (approval.actionType === "artifact_prune" || approval.actionType === "artifact_archive" || approval.actionType === "artifact_restore") {
    return executeLifecycleApproval({
      approval,
      project,
      actor: input.actor,
      actorRole: input.actorRole,
      executionRoleGate: executionRoleGate.message,
      separationGate: separationGate.message
    });
  }

  const artifactKind = approval.actionType === "local_command" ? "command_output" : approval.actionType === "file_write" ? "file_write" : "";
  if (!artifactKind) {
    return { ok: false, error: `Unsupported approval action type: ${approval.actionType}` };
  }

  const previous = await findRunActionByIdempotencyKey({
    runId: approval.runId,
    artifactKind,
    idempotencyKey: approval.idempotencyKey
  });
  if (previous) {
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "executed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: `Approved action already had an execution artifact: ${previous.uri}`,
      artifactUri: previous.uri
    });
    return {
      ok: true,
      title: "Approved action reused",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        `Action: ${approval.actionType}`,
        `Target: ${approval.target}`,
        `Artifact: ${previous.uri}`
      ].join("\n")
    };
  }

  try {
    if (approval.actionType === "local_command") {
      const commandLine = stringFromRecord(approval.payload, "commandLine") ?? approval.target;
      const result = await executeAllowedCommand({
        commandLine,
        cwd: approval.projectRootUri,
        project
      });
      const summary = [
        `Command \`${result.commandLine}\` exited with ${result.exitCode}`,
        result.timedOut ? "after timing out" : `in ${result.durationMs}ms`
      ].join(" ");
      const artifactUri = await recordRunAction({
        runId: approval.runId,
        taskId: approval.taskId,
        agentId: approval.agentId,
        actionType: "local_command",
        target: result.commandLine,
        summary,
        artifactKind: "command_output",
        artifactContent: {
          ...result,
          executedFromApprovalId: approval.id,
          requestedByTaskId: approval.taskId,
          requestedByStageId: approval.stageId
        },
        idempotencyKey: approval.idempotencyKey
      });
      if (result.exitCode !== 0 || result.timedOut) {
        await markActionApprovalExecution({
          approvalId: approval.id,
          status: "failed",
          actor: input.actor,
          actorRole: input.actorRole,
          summary: `Approved command failed: ${summary}`,
          artifactUri
        });
        return { ok: false, error: `Approved command failed. ${summary}` };
      }
      await markActionApprovalExecution({
        approvalId: approval.id,
        status: "executed",
        actor: input.actor,
        actorRole: input.actorRole,
        summary: `Approved command executed. ${summary}`,
        artifactUri
      });
      return {
        ok: true,
        title: "Approved command executed",
        runId: approval.runId,
        output: [
          `Approval: ${approval.id}`,
          summary,
          `Artifact: ${artifactUri}`
        ].join("\n")
      };
    }

    const fileWrite = await loadApprovedFileWrite(approval);
    const result = await executeAllowedFileWrite({
      relativePath: fileWrite.path,
      content: fileWrite.content,
      cwd: approval.projectRootUri,
      project
    });
    const summary = [
      `Wrote ${result.bytesWritten} bytes to \`${result.relativePath}\`.`,
      result.existed ? "Updated existing file." : "Created new file."
    ].join(" ");
    const artifactUri = await recordRunAction({
      runId: approval.runId,
      taskId: approval.taskId,
      agentId: approval.agentId,
      actionType: "file_write",
      target: result.relativePath,
      summary,
      artifactKind: "file_write",
      artifactContent: {
        ...result,
        executedFromApprovalId: approval.id,
        requestedByTaskId: approval.taskId,
        requestedByStageId: approval.stageId
      },
      idempotencyKey: approval.idempotencyKey
    });
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "executed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: `Approved file write executed. ${summary}`,
      artifactUri
    });
    return {
      ok: true,
      title: "Approved file write executed",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        summary,
        `Artifact: ${artifactUri}`
      ].join("\n")
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markActionApprovalExecution({
      approvalId: approval.id,
      status: "failed",
      actor: input.actor,
      actorRole: input.actorRole,
      summary: `Approved action execution failed: ${message}`,
      error: message
    });
    return { ok: false, error: message };
  }
}

async function executeLifecycleApproval(input: {
  approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>;
  project: ProjectConfig;
  actor: string;
  actorRole?: string;
  executionRoleGate: string;
  separationGate: string;
}): Promise<DashboardFollowUpResult> {
  const lifecycleAction = input.approval.actionType.replace(/^artifact_/, "") as ArtifactLifecycleAction;
  const currentPolicy = lifecyclePolicyFromProject(input.project, "project");
  const capabilityEnabled = lifecycleExecutionCapabilityEnabled(currentPolicy, lifecycleAction);
  const targetArtifact = await loadLifecycleExecutionArtifact(input.approval, lifecycleAction);
  const restoreReady = lifecycleAction === "restore" && isRestorableArchivedArtifact(targetArtifact);
  const lifecycleExecutionAvailable = lifecycleAction === "archive" || lifecycleAction === "restore";
  const destructiveLifecycleAction = lifecycleAction === "prune";
  const destructiveApprovalRequired = destructiveLifecycleAction ? currentPolicy.requireApprovalForPrune : false;
  const policyRecheck = {
    checkedAt: new Date().toISOString(),
    projectRootUri: input.approval.projectRootUri,
    lifecycleAction,
    approvalId: input.approval.id,
    approvalStatus: input.approval.status,
    explicitApprovalPresent: input.approval.status === "approved" || input.approval.status === "failed",
    currentPolicy,
    requestedPolicyDecision: input.approval.policyDecision,
    targetArtifactFound: Boolean(targetArtifact),
    targetArtifactKind: targetArtifact?.kind ?? null,
    targetArtifactCreatedAt: targetArtifact?.createdAt ?? null,
    capabilityEnabled,
    lifecycleExecutionAvailable,
    destructiveLifecycleAction,
    destructiveApprovalRequired,
    destructiveExecutionAvailable: false
  };
  const skipReasons = [
    currentPolicy.legalHold ? "Project legal hold is enabled." : "",
    capabilityEnabled ? "" : `Project policy has allow_${lifecycleAction}_execution disabled.`,
    destructiveLifecycleAction && !currentPolicy.requireApprovalForPrune ? "Project policy must require explicit prune approval before destructive prune execution can be considered." : "",
    targetArtifact ? "" : lifecycleAction === "restore" ? "Archived source snapshot is no longer present in storage." : "Target artifact is no longer present in storage.",
    lifecycleExecutionAvailable ? "" : "Destructive prune/delete execution is not implemented in this version.",
    lifecycleAction === "restore" && targetArtifact && !restoreReady ? "Archived source snapshot is missing restorable content metadata." : ""
  ].filter(Boolean);
  const skipped = currentPolicy.legalHold || !capabilityEnabled || !targetArtifact || !lifecycleExecutionAvailable || (destructiveLifecycleAction && !currentPolicy.requireApprovalForPrune) || (lifecycleAction === "restore" && !restoreReady);
  const archived = !skipped && lifecycleAction === "archive" && targetArtifact;
  const restored = !skipped && lifecycleAction === "restore" && targetArtifact;
  const summary = skipped
    ? `Lifecycle ${lifecycleAction} skipped after policy recheck: ${skipReasons.join(" ")}`
    : archived
      ? `Lifecycle archive recorded for ${input.approval.target}; original artifact retained and archived snapshot created.`
      : restored
        ? `Lifecycle restore recorded for ${input.approval.target}; restored copy created from archived snapshot.`
    : `Lifecycle ${lifecycleAction} policy recheck passed; recorded no-op receipt because execution is not implemented.`;
  const artifactUri = await recordRunAction({
    runId: input.approval.runId,
    taskId: input.approval.taskId,
    agentId: input.approval.agentId,
    actionType: skipped ? `artifact_${lifecycleAction}_skipped` : archived ? "artifact_archive_executed" : restored ? "artifact_restore_executed" : `artifact_${lifecycleAction}_noop`,
    target: input.approval.target,
    summary,
    artifactKind: skipped ? "lifecycle_skipped" : archived ? "archived_artifact" : restored ? "restored_artifact" : "lifecycle_action",
    artifactContent: archived ? buildArchivedArtifactContent({
      approval: input.approval,
      targetArtifact,
      policyRecheck,
      actor: input.actor,
      actorRole: input.actorRole
    }) : restored ? buildRestoredArtifactContent({
      approval: input.approval,
      archivedArtifact: targetArtifact,
      policyRecheck,
      actor: input.actor,
      actorRole: input.actorRole
    }) : {
      approvalId: input.approval.id,
      originalActionType: input.approval.actionType,
      lifecycleAction,
      target: input.approval.target,
      policyDecision: input.approval.policyDecision,
      payload: input.approval.payload,
      policyRecheck,
      skipReasons,
      skipped,
      executedBy: input.actor,
      executedByRole: input.actorRole ?? null
    },
    idempotencyKey: input.approval.idempotencyKey
  });
  await markActionApprovalExecution({
    approvalId: input.approval.id,
    status: "executed",
    actor: input.actor,
    actorRole: input.actorRole,
    summary,
    artifactUri
  });
  return {
    ok: true,
    title: skipped ? "Lifecycle skip receipt recorded" : archived ? "Lifecycle archive snapshot recorded" : restored ? "Lifecycle restore snapshot recorded" : "Lifecycle no-op receipt recorded",
    runId: input.approval.runId,
    output: [
      `Approval: ${input.approval.id}`,
      `Action: ${input.approval.actionType}`,
      `Target: ${input.approval.target}`,
      `Artifact: ${artifactUri}`,
      `Role gate: ${input.executionRoleGate}`,
      `Separation of duties: ${input.separationGate}`,
      `Policy recheck: legalHold=${currentPolicy.legalHold} capabilityEnabled=${capabilityEnabled} targetFound=${Boolean(targetArtifact)} lifecycleExecutionAvailable=${lifecycleExecutionAvailable} destructiveExecutionAvailable=false`,
      skipped ? `Skipped: ${skipReasons.join(" ")}` : archived ? "Archived snapshot created; the original artifact remains present." : restored ? "Restored copy created as a new artifact; existing artifacts remain present." : "This execution recorded a no-op lifecycle receipt only.",
      archived
        ? "No artifact was deleted or modified. Restore metadata was recorded with the archived snapshot."
        : restored
          ? "No artifact was deleted or overwritten. Restore lineage was recorded with the restored snapshot."
        : destructiveLifecycleAction
          ? "Destructive prune/delete execution is not implemented yet, so no artifact was deleted, archived, restored, or modified."
        : `Artifact ${lifecycleAction} execution is not implemented yet, so no artifact was deleted, archived, restored, or modified.`
    ].join("\n")
  };
}

async function loadLifecycleExecutionArtifact(
  approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>,
  lifecycleAction: ArtifactLifecycleAction
): Promise<Awaited<ReturnType<typeof getArtifactByUri>>> {
  if (lifecycleAction !== "restore") {
    return getArtifactByUri(approval.target);
  }
  const artifactId = stringFromRecord(approval.payload, "artifactId");
  if (artifactId && isUuid(artifactId)) {
    const archivedArtifact = await getArtifactById(artifactId);
    if (archivedArtifact?.kind === "archived_artifact") return archivedArtifact;
  }
  const directTarget = await getArtifactByUri(approval.target);
  return directTarget?.kind === "archived_artifact" ? directTarget : null;
}

function isRestorableArchivedArtifact(artifact: Awaited<ReturnType<typeof getArtifactByUri>>): artifact is NonNullable<Awaited<ReturnType<typeof getArtifactByUri>>> {
  return Boolean(artifact && artifact.kind === "archived_artifact" && Object.prototype.hasOwnProperty.call(artifact.content, "archivedContent"));
}

function buildArchivedArtifactContent(input: {
  approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>;
  targetArtifact: NonNullable<Awaited<ReturnType<typeof getArtifactByUri>>>;
  policyRecheck: Record<string, unknown>;
  actor: string;
  actorRole?: string;
}): Record<string, unknown> {
  return {
    approvalId: input.approval.id,
    originalActionType: input.approval.actionType,
    lifecycleAction: "archive",
    target: input.approval.target,
    policyDecision: input.approval.policyDecision,
    payload: input.approval.payload,
    policyRecheck: input.policyRecheck,
    skipped: false,
    archivedAt: new Date().toISOString(),
    archivedBy: input.actor,
    archivedByRole: input.actorRole ?? null,
    restoreMetadata: {
      originalArtifactId: input.targetArtifact.id,
      originalRunId: input.targetArtifact.runId,
      originalTaskId: input.targetArtifact.taskId,
      originalKind: input.targetArtifact.kind,
      originalUri: input.targetArtifact.uri,
      originalCreatedAt: input.targetArtifact.createdAt
    },
    archivedContent: input.targetArtifact.content
  };
}

function buildRestoredArtifactContent(input: {
  approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>;
  archivedArtifact: NonNullable<Awaited<ReturnType<typeof getArtifactByUri>>>;
  policyRecheck: Record<string, unknown>;
  actor: string;
  actorRole?: string;
}): Record<string, unknown> {
  const restoreMetadata = objectFromRecord(input.archivedArtifact.content, "restoreMetadata");
  const originalUri = stringFromRecord(restoreMetadata, "originalUri") || stringFromRecord(input.archivedArtifact.content, "target") || input.approval.target;
  return {
    approvalId: input.approval.id,
    originalActionType: input.approval.actionType,
    lifecycleAction: "restore",
    target: input.approval.target,
    restoredTargetUri: originalUri,
    policyDecision: input.approval.policyDecision,
    payload: input.approval.payload,
    policyRecheck: input.policyRecheck,
    skipped: false,
    restoredAt: new Date().toISOString(),
    restoredBy: input.actor,
    restoredByRole: input.actorRole ?? null,
    restoreSource: {
      archivedArtifactId: input.archivedArtifact.id,
      archivedArtifactUri: input.archivedArtifact.uri,
      archivedArtifactRunId: input.archivedArtifact.runId,
      archivedArtifactTaskId: input.archivedArtifact.taskId,
      archivedArtifactCreatedAt: input.archivedArtifact.createdAt
    },
    restoreMetadata,
    restoredContent: input.archivedArtifact.content.archivedContent
  };
}

function lifecyclePolicyFromProject(project: ProjectConfig, source: ArtifactLifecyclePolicy["source"]): ArtifactLifecyclePolicy {
  return {
    source,
    retentionDays: project.storage.artifact_lifecycle.retention_days,
    minPruneBytes: project.storage.artifact_lifecycle.min_prune_bytes,
    retainAuditArtifacts: project.storage.artifact_lifecycle.retain_audit_artifacts,
    legalHold: project.storage.artifact_lifecycle.legal_hold,
    requireApprovalForPrune: project.storage.artifact_lifecycle.require_approval_for_prune,
    allowArchiveExecution: project.storage.artifact_lifecycle.allow_archive_execution,
    allowRestoreExecution: project.storage.artifact_lifecycle.allow_restore_execution,
    allowPruneExecution: project.storage.artifact_lifecycle.allow_prune_execution
  };
}

function lifecycleExecutionCapabilityEnabled(policy: ArtifactLifecyclePolicy, action: ArtifactLifecycleAction): boolean {
  if (action === "archive") return policy.allowArchiveExecution;
  if (action === "restore") return policy.allowRestoreExecution;
  return policy.allowPruneExecution;
}

async function loadApprovedFileWrite(approval: NonNullable<Awaited<ReturnType<typeof getActionApproval>>>): Promise<{ path: string; content: string }> {
  if (!approval.taskId) {
    throw new Error("Approved file write is missing the source task id.");
  }
  const expectedHash = stringFromRecord(approval.payload, "payloadHash");
  const artifacts = await listArtifacts({ runId: approval.runId, kind: "stage_output" });
  const source = artifacts.find((artifact) => artifact.taskId === approval.taskId);
  const writes = Array.isArray(source?.content.requestedFileWrites) ? source.content.requestedFileWrites : [];
  for (const item of writes) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const filePath = stringFromRecord(record, "path");
    const content = stringFromRecord(record, "content");
    if (!filePath || content === undefined) continue;
    if (filePath === approval.target && (!expectedHash || textHash(content) === expectedHash)) {
      return { path: filePath, content };
    }
  }
  throw new Error("Approved file write content was not found in the source stage artifact.");
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function objectFromRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
      <title>Agent Workflow Settings</title>
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
      <a class="button secondary" href="/api/settings">JSON</a>
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
  const providerStatuses = info.provider.providerStatuses ?? [];
  const providerStatusChecked = providerStatuses.length > 0;
  const readyProviders = providerStatuses.filter((provider) => provider.status === "ready");
  const configuredProviders = providerStatuses.filter((provider) => provider.configured);
  const missingProviders = providerStatuses.filter((provider) => provider.status === "missing");
  const awsStatus = providerStatuses.find((provider) => provider.providerId === "bedrock");
  const selectedStatus = providerStatuses.find((provider) => provider.providerId === info.provider.selected);
  const setupCards = [
    {
      title: "OpenAI",
      detail: "Best default for high-quality hosted development runs.",
      command: "OPENAI_API_KEY + OPENAI_MODEL"
    },
    {
      title: "BYO Gateway",
      detail: "Best cost-control path for Ollama, vLLM, LM Studio, or an internal OpenAI-compatible endpoint.",
      command: "BYO_MODEL_BASE_URL + BYO_MODEL_NAME"
    },
    {
      title: "AWS Bedrock",
      detail: "Best enterprise cloud option when AWS credentials are already available locally.",
      command: "AWS_PROFILE + AWS_REGION + BEDROCK_MODEL"
    },
    {
      title: "Auto",
      detail: "Routes by tier across ready providers, with fallback and quality threshold controls.",
      command: "DEFAULT_MODEL_PROVIDER=auto"
    }
  ].map((card) => `<div class="provider-setup-card"><strong>${escapeHtml(card.title)}</strong><span>${escapeHtml(card.detail)}</span><code>${escapeHtml(card.command)}</code></div>`).join("");

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
        <p class="muted">Choose how Agent Workflow spends tokens: hosted models, local/BYO gateways, AWS Bedrock, or automatic routing by task tier.</p>
      </div>
      <a class="button secondary" href="/api/settings">Settings JSON</a>
    </div>
    <section class="panel provider-hero">
      <div class="provider-current">
        <strong>${escapeHtml(info.provider.selected)}</strong>
        <span>${escapeHtml(info.provider.adapter)}${info.provider.model ? ` / ${escapeHtml(info.provider.model)}` : ""}</span>
        <small>${selectedStatus ? escapeHtml(selectedStatus.details.join(" ")) : "Selected provider is routed dynamically or not listed in the status table."}</small>
      </div>
      <div class="provider-readiness">
        <div><strong>${providerStatusChecked ? formatNumber(readyProviders.length) : "unchecked"}</strong><span>ready providers</span></div>
        <div><strong>${providerStatusChecked ? formatNumber(configuredProviders.length) : "unchecked"}</strong><span>configured</span></div>
        <div><strong>${providerStatusChecked ? formatNumber(missingProviders.length) : "unchecked"}</strong><span>need attention</span></div>
        <div><strong>${escapeHtml(awsStatus?.status ?? "unknown")}</strong><span>AWS Bedrock</span></div>
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Selected Provider</h2>
          <span class="muted">Secrets are never displayed. New tasks use saved provider values; already-running workers may need a restart.</span>
        </div>
        <a class="button secondary" href="/settings">Runtime Settings</a>
      </div>
      <div class="meta-grid">${providerRows}</div>
      ${modelSelector}
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Setup Paths</h2>
          <span class="muted">Pick one path, then use Routing Controls to make it active or include it in auto mode.</span>
        </div>
      </div>
      <div class="provider-setup-grid">${setupCards}</div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <h2>Routing Controls</h2>
          <span class="muted">Auto mode prioritizes the providers below, then uses tier-specific choices and fallback when quality drops.</span>
        </div>
      </div>
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
    ${providerStatusRows ? `<section class="panel"><div class="section-heading"><div><h2>Available Provider Status</h2><span class="muted">Use this table to see which model paths have keys, local endpoints, CLI login, or AWS credentials available.</span></div></div><table><thead><tr><th>Provider</th><th>Status</th><th>Configured</th><th>Model</th><th>Base URL</th><th>API Key / Auth</th><th>AWS</th><th>Details</th></tr></thead><tbody>${providerStatusRows}</tbody></table><p class="muted">Secrets are never displayed.</p></section>` : ""}
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

function renderObservabilityHtml(report: ObservabilityReport): string {
  const spanCount = report.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans)).length;
  const metricCount = report.resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics)).length;
  return `
    <div class="metric-grid">
      ${metricCard("Run Duration", report.summary.runDurationMs === null ? "n/a" : `${report.summary.runDurationMs}ms`, "workflow wall time")}
      ${metricCard("Queue Delay", report.summary.queueDelayMs === null ? "n/a" : `${report.summary.queueDelayMs}ms`, "created to first stage")}
      ${metricCard("Model Latency", `${report.summary.totalModelLatencyMs}ms`, `avg ${report.summary.averageModelLatencyMs ?? "n/a"}ms`)}
      ${metricCard("Spans", spanCount, `${metricCount} metrics`)}
    </div>
    <div class="meta-grid compact">
      <div><strong>Provider Calls</strong>${formatNumber(report.summary.providerCalls)}</div>
      <div><strong>Fallbacks</strong>${formatNumber(report.summary.fallbackCount)}</div>
      <div><strong>Compact Prompt</strong>${report.summary.estimatedCompactPromptTokens === null ? "n/a" : `${formatNumber(report.summary.estimatedCompactPromptTokens)} tokens`}</div>
      <div><strong>Payload Export</strong>disabled</div>
    </div>
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
  const extraLanes = worker.lanes.filter((lane) => lane.heartbeatPath !== worker.heartbeatPath);
  return `
    <div class="meta-grid">
      <div><strong>Status</strong><span class="status ${worker.status === "running" ? "completed" : worker.status === "missing" ? "queued" : "failed"}">${escapeHtml(worker.status)}</span></div>
      <div><strong>Worker ID</strong>${escapeHtml(worker.workerId ?? "none")}</div>
      <div><strong>PID</strong>${worker.pid ?? "none"}</div>
      <div><strong>Process</strong>${worker.processAlive ? "alive" : "not running"}</div>
      <div><strong>Last Heartbeat</strong>${renderDashboardDateTime(worker.lastHeartbeatAt, "none")}</div>
      <div><strong>Heartbeat Age</strong>${escapeHtml(age)}</div>
      <div><strong>Tick Count</strong>${formatNumber(worker.ticks)}</div>
      <div><strong>Worker Limit</strong>${worker.limit ?? "n/a"}</div>
      <div><strong>Project Scope</strong>${escapeHtml(worker.projectRootUri ?? "all projects")}</div>
      <div><strong>Concurrency</strong>${worker.concurrency ?? "n/a"}</div>
      <div><strong>Interval</strong>${worker.intervalMs ? formatDuration(worker.intervalMs) : "n/a"}</div>
    </div>
    <div class="meta-grid compact">
      <div><strong>Last Tick</strong>${worker.claimed} claimed / ${worker.completed} completed / ${worker.failed} failed</div>
      <div><strong>Heartbeat File</strong>${escapeHtml(worker.heartbeatPath)}</div>
      <div><strong>Start Command</strong><code>${escapeHtml(worker.command || "npm run worker:daemon")}</code></div>
    </div>
    ${worker.lanes.length > 1 ? `<h3>Worker Lanes</h3><div class="table-wrap"><table><thead><tr><th>Worker</th><th>Status</th><th>Project</th><th>Concurrency</th><th>Last heartbeat</th><th>Last tick</th></tr></thead><tbody>${worker.lanes.map((lane) => `<tr><td>${escapeHtml(lane.workerId ?? "unknown")}</td><td><span class="status ${lane.status === "running" ? "completed" : "failed"}">${escapeHtml(lane.status)}</span></td><td>${escapeHtml(lane.projectRootUri ?? "all projects")}</td><td>${lane.concurrency ?? "n/a"}</td><td>${renderDashboardDateTime(lane.lastHeartbeatAt, "none")}</td><td>${lane.claimed} / ${lane.completed} / ${lane.failed}</td></tr>`).join("")}</tbody></table></div>` : ""}
    ${extraLanes.length ? `<p class="muted">Showing ${formatNumber(worker.lanes.length)} discovered worker lane${worker.lanes.length === 1 ? "" : "s"} from the local heartbeat registry.</p>` : ""}
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
        href: "/settings"
      })}
      ${healthCard({
        label: "Worker",
        status: health.worker.status === "running" ? "good" : health.worker.status === "missing" ? "warn" : "bad",
        value: health.worker.status,
        detail: workerStatusDetail(health.worker),
        href: "/settings"
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
        href: "/settings"
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

function renderDashboardOperationsSnapshotHtml(health: DashboardHomeHealth): string {
  const queuedTasks = health.queue.reduce((sum, item) => sum + item.queuedTasks, 0);
  const runningTasks = health.queue.reduce((sum, item) => sum + item.runningTasks, 0);
  const failedRuns = health.queue.filter((item) => item.runStatus === "failed").length;
  const expiredLeases = health.queue.filter((item) => hasExpiredLease(item)).length;
  const activeRuns = health.queue.filter((item) => item.runStatus === "queued" || item.runStatus === "running").length;
  const workerReady = health.worker.status === "running";
  const statusClass = failedRuns || expiredLeases ? "bad" : queuedTasks + runningTasks > 0 ? "warn" : workerReady ? "good" : "warn";
  const statusText = failedRuns
    ? `${failedRuns} failed run${failedRuns === 1 ? "" : "s"}`
    : expiredLeases
      ? `${expiredLeases} expired lease${expiredLeases === 1 ? "" : "s"}`
      : queuedTasks + runningTasks > 0
        ? `${queuedTasks + runningTasks} active stage task${queuedTasks + runningTasks === 1 ? "" : "s"}`
        : workerReady
          ? "ready"
          : "worker attention";
  const nextAction = failedRuns
    ? `<a class="button secondary" href="/queue" title="Open the queue filtered by recent run state so failed runs can be inspected or dismissed.">Review Failed Runs</a>`
    : expiredLeases
      ? queueRecoverExpiredLeasesForm()
      : queuedTasks > 0 && workerReady
        ? queueProcessForm("")
      : queuedTasks > 0
          ? `<a class="button secondary" href="/settings" title="Open worker setup commands for starting the local Agent Workflow worker.">Start Worker</a>`
          : `<a class="button secondary" href="/queue" title="Open queue details, recovery actions, and worker controls.">Open Queue</a>`;
  return `<section class="panel operations-panel">
    <div class="section-heading">
      <div>
        <h2>Operations Snapshot</h2>
        <span class="muted">Current queue and worker state for local agent execution.</span>
      </div>
      <div class="actions">
        <a class="button secondary" href="/queue" title="Inspect queued, running, failed, and expired workflow stage tasks.">Open Queue</a>
        <a class="button secondary" href="/settings" title="View local dashboard, worker, MCP, and provider startup commands.">Worker Setup</a>
      </div>
    </div>
    <div class="ops-strip">
      <div class="ops-state ${statusClass}"><strong>${escapeHtml(statusText)}</strong><span>${escapeHtml(workerStatusDetail(health.worker))}</span><div class="ops-action">${nextAction}</div></div>
      <a href="/queue" aria-label="${formatNumber(activeRuns)} active workflow runs" title="Open active queued or running workflow runs."><strong>${formatNumber(activeRuns)}</strong><span>active runs</span></a>
      <a href="/queue" aria-label="${formatNumber(queuedTasks)} queued stage tasks" title="Open stage tasks waiting for a worker."><strong>${formatNumber(queuedTasks)}</strong><span>queued tasks</span></a>
      <a href="/queue" aria-label="${formatNumber(runningTasks)} running stage tasks" title="Open stage tasks currently leased by a worker."><strong>${formatNumber(runningTasks)}</strong><span>running tasks</span></a>
      <a href="/queue" aria-label="${formatNumber(failedRuns)} failed workflow runs" title="Open failed runs that may need review, retry, or dismissal."><strong>${formatNumber(failedRuns)}</strong><span>failed runs</span></a>
      <a href="/queue" aria-label="${formatNumber(expiredLeases)} expired worker leases" title="Open expired leases that can be requeued after worker interruption."><strong>${formatNumber(expiredLeases)}</strong><span>expired leases</span></a>
    </div>
  </section>`;
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
      href: "/settings",
      action: "Open Settings"
    }));
  }
  if (health.supervisor.status !== "running") {
    items.push(attentionItem({
      title: "Use one-command local dev",
      detail: supervisorStatusDetail(health.supervisor),
      href: "/settings",
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
      href: "/settings",
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
    return `Worker ${worker.workerId ?? "unknown"} is processing queued stages. Last heartbeat ${worker.ageMs === null ? "unknown" : `${formatDuration(Math.max(0, worker.ageMs))} ago`}.`;
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

function dashboardNav(active: "dashboard" | "queue" | "approvals" | "projects" | "runs" | "evaluations" | "workflow-graph" | "learning" | "model-improvement" | "candidate-comparisons" | "governance" | "roles" | "artifact-lifecycle" | "backup-report" | "server-readiness" | "bundles" | "providers" | "info"): string {
  const groups = [
    {
      label: "Operate",
      items: [
        ["dashboard", "/", "Dashboard"],
        ["queue", "/queue", "Queue"],
        ["approvals", "/approvals", "Approvals"],
        ["runs", "/runs", "Runs"]
      ]
    },
    {
      label: "Projects",
      items: [
        ["projects", "/projects", "Projects"],
        ["workflow-graph", "/workflow-graph", "Graph"],
        ["artifact-lifecycle", "/artifact-lifecycle", "Artifacts"]
      ]
    },
    {
      label: "Optimize",
      items: [
        ["evaluations", "/evaluations", "Evaluations"],
        ["learning", "/learning", "Learning"],
        ["model-improvement", "/model-improvement", "Model Improve"],
        ["candidate-comparisons", "/candidate-comparisons", "Comparisons"]
      ]
    },
    {
      label: "Govern",
      items: [
        ["governance", "/governance", "Governance"],
        ["roles", "/roles", "Roles"],
        ["backup-report", "/backup-report", "Backup"],
        ["server-readiness", "/server-readiness", "Server"],
        ["bundles", "/bundles", "Bundles"]
      ]
    },
    {
      label: "Setup",
      items: [
        ["providers", "/providers", "Providers"],
        ["info", "/settings", "Settings"]
      ]
    }
  ] as const;
  return `<nav class="side-nav" aria-label="Dashboard navigation">
    <strong>Agent Workflow</strong>
    ${groups.map((group) => {
      const activeGroup = group.items.some(([id]) => id === active);
      return `<div class="nav-section ${activeGroup ? "active-group" : ""}"><span>${escapeHtml(group.label)}</span>${group.items.map(([id, href, label]) => `<a class="${active === id ? "active" : ""}" href="${href}">${label}</a>`).join("")}</div>`;
    }).join("")}
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

function titleCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function isExecutableApprovalAction(actionType: string): boolean {
  return actionType === "local_command" || actionType === "file_write" || actionType === "artifact_prune" || actionType === "artifact_archive" || actionType === "artifact_restore";
}

function approvalDecisionForms(approvalId: string): string {
  return `<div class="actions">
    <form class="approval-form" method="post" action="/api/approval-action">
      <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
      <input type="hidden" name="decision" value="approved">
      <input type="hidden" name="actorRole" value="approver">
      <input name="note" aria-label="Approval note" placeholder="Optional note">
      <button type="submit">Approve</button>
    </form>
    <form class="approval-form" method="post" action="/api/approval-action">
      <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
      <input type="hidden" name="decision" value="rejected">
      <input type="hidden" name="actorRole" value="approver">
      <input name="note" aria-label="Rejection note" placeholder="Optional note">
      <button class="danger" type="submit">Reject</button>
    </form>
  </div>`;
}

function rolePreviewForApproval(approval: Awaited<ReturnType<typeof listActionApprovals>>[number]): string {
  if (approval.status === "pending") {
    return "Role preview: approval decision expects approver.";
  }
  if (approval.status === "approved" && isExecutableApprovalAction(approval.actionType)) {
    return "Role preview: execution expects operator.";
  }
  if (approval.actionType === "deployment" || approval.actionType === "autonomy") {
    return "Role preview: request expects operator; decision expects approver.";
  }
  return approval.decidedRole
    ? `Role preview: recorded as ${approval.decidedRole}.`
    : "Role preview: no decision role recorded yet.";
}

function approvalExecuteForm(approvalId: string): string {
  return `<form class="approval-form" method="post" action="/api/approval-action">
    <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
    <input type="hidden" name="decision" value="execute">
    <input type="hidden" name="actorRole" value="operator">
    <button type="submit">Execute</button>
  </form>`;
}

function formatApprovalPayload(payload: Record<string, unknown>): string {
  const hash = typeof payload.payloadHash === "string" ? payload.payloadHash.slice(0, 12) : "unknown";
  const bytes = typeof payload.bytes === "number" ? `, ${formatNumber(payload.bytes)} bytes` : "";
  return `payload hash ${hash}${bytes}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(value));
}

function safeFileSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "graph";
}

function renderDashboardDateTime(value: string | null | undefined, fallback = "n/a"): string {
  if (!value) {
    return escapeHtml(fallback);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return escapeHtml(value);
  }
  const label = formatDashboardDateTimeText(value);
  return `<time datetime="${escapeHtml(parsed.toISOString())}" title="${escapeHtml(value)}">${escapeHtml(label)}</time>`;
}

function formatDashboardDateTimeText(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  }).format(parsed);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value : Math.round(value * 10) / 10} ${units[unitIndex]}`;
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

function formatDurationDelta(ms: number): string {
  const prefix = ms > 0 ? "+" : ms < 0 ? "-" : "";
  return `${prefix}${formatDuration(Math.abs(ms))}`;
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
    .markdown-view { white-space: pre-wrap; word-break: break-word; }
    .lifecycle-help { margin-top: 14px; border: 1px solid #e2e7f0; background: #f8fafc; padding: 12px; }
    .lifecycle-help summary { cursor: pointer; font-weight: 700; color: #172033; }
    .lifecycle-help pre { margin-bottom: 0; }
    .side-nav { position: fixed; inset: 0 auto 0 0; width: 176px; background: #111827; color: #dbe4f0; padding: 20px 14px; display: grid; align-content: start; gap: 12px; z-index: 10; overflow-y: auto; }
    .side-nav strong { color: white; font-size: 14px; margin: 0 0 2px; }
    .nav-section { display: grid; gap: 4px; }
    .nav-section span { color: #94a3b8; font-size: 10px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; padding: 0 10px; }
    .nav-section.active-group { border-left: 2px solid #60a5fa; padding-left: 6px; margin-left: -8px; }
    .nav-section.active-group span { color: #bfdbfe; }
    .side-nav a { color: #cbd5e1; padding: 9px 10px; border: 1px solid transparent; }
    .side-nav a:hover, .side-nav a.active { color: white; background: #1f2937; border-color: #334155; }
    .capture-page main { max-width: 1440px; padding: 24px; }
    .capture-page .panel { break-inside: avoid; }
    .capture-page .capture-hide { display: none !important; }
    .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
    .panel { background: white; border: 1px solid #e2e7f0; padding: 16px; margin-bottom: 16px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .quick-actions { margin-top: 12px; }
    .button, button { appearance: none; border: 1px solid #1d4ed8; background: #1d4ed8; color: white; padding: 8px 11px; font-size: 14px; cursor: pointer; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, color .15s ease, transform .15s ease; }
    .button:hover, button:hover { background: #1e40af; border-color: #1e40af; box-shadow: 0 1px 3px rgba(29, 78, 216, .22); }
    .button:focus-visible, button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid #60a5fa; outline-offset: 2px; }
    input, select, textarea { border: 1px solid #cbd5e1; padding: 8px 10px; font-size: 14px; min-width: 180px; background: white; font: inherit; }
    .feedback-form { display: flex; gap: 6px; flex-wrap: wrap; }
    .worker-form { display: inline-flex; }
    .dismiss-form { display: inline-flex; gap: 6px; flex-wrap: wrap; }
    .dismiss-form input { min-width: 140px; max-width: 190px; }
    .approval-form { display: inline-flex; gap: 6px; flex-wrap: wrap; }
    .approval-form input { min-width: 120px; max-width: 180px; }
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
    .secondary:hover { background: #eff6ff; border-color: #93c5fd; color: #1e40af; }
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
    .operations-panel { border-color: #cbd5e1; }
    .ops-strip { display: grid; grid-template-columns: minmax(260px, 1.7fr) repeat(5, minmax(104px, 1fr)); gap: 10px; }
    .ops-strip > div, .ops-strip > a { border: 1px solid #e2e7f0; background: #f8fafc; padding: 12px; display: grid; gap: 5px; min-height: 72px; align-content: center; color: #172033; transition: background .15s ease, border-color .15s ease, box-shadow .15s ease, transform .15s ease; }
    .ops-strip > a:hover { border-color: #93c5fd; background: #eff6ff; box-shadow: 0 6px 18px rgba(37, 99, 235, .12); transform: translateY(-1px); }
    .ops-strip strong { color: #172033; font-size: 20px; line-height: 1.15; }
    .ops-strip span { color: #64748b; font-size: 12px; line-height: 1.35; }
    .ops-state.good { border-color: #86efac; background: #f0fdf4; }
    .ops-state.warn { border-color: #fde68a; background: #fffbeb; }
    .ops-state.bad { border-color: #fca5a5; background: #fef2f2; }
    .ops-state strong { font-size: 22px; }
    .ops-action { margin-top: 4px; }
    .ops-action .worker-form { display: flex; flex-wrap: wrap; gap: 6px; }
    .ops-action .worker-form input { min-width: 64px; max-width: 84px; padding: 7px 8px; }
    .ops-action .worker-form button { padding: 7px 9px; }
    .provider-hero { display: grid; grid-template-columns: minmax(240px, 1.15fr) minmax(0, 2fr); gap: 12px; align-items: stretch; }
    .provider-current { border: 1px solid #bfdbfe; background: #eff6ff; padding: 14px; display: grid; gap: 6px; align-content: center; }
    .provider-current strong { color: #1d4ed8; font-size: 28px; line-height: 1.1; }
    .provider-current span { color: #172033; font-weight: 700; }
    .provider-current small { color: #475569; line-height: 1.35; }
    .provider-readiness { display: grid; grid-template-columns: repeat(4, minmax(110px, 1fr)); gap: 10px; }
    .provider-readiness div { border: 1px solid #e2e7f0; background: #f8fafc; padding: 12px; display: grid; gap: 5px; align-content: center; }
    .provider-readiness strong { color: #172033; font-size: 20px; line-height: 1.15; }
    .provider-readiness span { color: #64748b; font-size: 12px; line-height: 1.3; }
    .provider-setup-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
    .provider-setup-card { border: 1px solid #dbe4f0; background: #f8fafc; padding: 12px; display: grid; gap: 7px; }
    .provider-setup-card strong { color: #172033; font-size: 14px; }
    .provider-setup-card span { color: #64748b; line-height: 1.35; font-size: 13px; }
    .provider-setup-card code { white-space: normal; word-break: break-word; background: #eef2ff; color: #3730a3; padding: 5px 6px; }
    .stage-delta { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 12px 0 16px; }
    .stage-delta-card { border: 1px solid #dbe4f0; background: #f8fafc; padding: 12px; display: grid; gap: 5px; }
    .stage-delta-card strong { color: #4b5870; font-size: 12px; text-transform: uppercase; }
    .stage-delta-card span { font-size: 22px; font-weight: 750; color: #172033; }
    .stage-delta-card small { color: #64748b; font-size: 12px; line-height: 1.35; }
    .stage-delta-card.good { border-color: #86efac; background: #f0fdf4; }
    .stage-delta-card.warn { border-color: #fde68a; background: #fffbeb; }
    .stage-delta-card.bad { border-color: #fca5a5; background: #fef2f2; }
    .attention-list { display: grid; gap: 8px; }
    .attention-item { border: 1px solid #e2e7f0; padding: 12px; display: flex; justify-content: space-between; gap: 12px; align-items: center; background: #fff; }
    .attention-item div { display: grid; gap: 4px; }
    .attention-item span { color: #64748b; font-size: 14px; line-height: 1.4; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .metric { border: 1px solid #e2e7f0; padding: 12px; display: grid; gap: 4px; }
    .metric span { font-size: 22px; font-weight: 700; }
    .metric small, .muted { color: #64748b; }
    .split-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
    .split-grid > div { border: 1px solid #e2e7f0; background: #f8fafc; padding: 12px; }
    .split-grid h3 { margin-top: 0; }
    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
    .meta-grid div { display: grid; gap: 5px; font-size: 14px; }
    .graph-flow { display: grid; gap: 12px; }
    .graph-stage { position: relative; display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 12px; border: 1px solid #e2e7f0; padding: 14px; background: #fff; }
    .graph-stage + .graph-stage::before { content: ""; position: absolute; left: 34px; top: -13px; width: 2px; height: 12px; background: #94a3b8; }
    .graph-stage h3 { margin: 0 0 6px; }
    .graph-stage p { margin: 0 0 10px; }
    .graph-stage.good { border-color: #bbf7d0; background: #f0fdf4; }
    .graph-stage.warn { border-color: #fde68a; background: #fffbeb; }
    .graph-stage.bad { border-color: #fecaca; background: #fef2f2; }
    .graph-step { width: 32px; height: 32px; display: grid; place-items: center; background: #111827; color: white; font-weight: 700; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .chip { display: inline-flex; align-items: center; border: 1px solid #cbd5e1; background: white; color: #334155; padding: 4px 7px; font-size: 12px; }
    .mind-map { display: grid; grid-template-columns: minmax(180px, 240px) minmax(0, 1fr); gap: 18px; align-items: center; }
    .mind-center { display: grid; gap: 6px; border: 2px solid #111827; background: #fff; padding: 18px; min-height: 120px; align-content: center; }
    .mind-center strong { font-size: 18px; line-height: 1.25; }
    .mind-center span, .mind-center small { color: #64748b; line-height: 1.35; }
    .mind-branches { position: relative; display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; }
    .mind-branches::before { content: ""; position: absolute; left: -18px; top: 50%; width: 18px; height: 2px; background: #94a3b8; }
    .mind-node { position: relative; display: grid; gap: 6px; border: 1px solid #e2e7f0; background: #fff; padding: 12px; min-height: 148px; }
    .mind-node::before { content: ""; position: absolute; left: -13px; top: 50%; width: 12px; height: 2px; background: #cbd5e1; }
    .mind-node strong { font-size: 14px; line-height: 1.25; }
    .mind-node span, .mind-node small { line-height: 1.35; }
    .mind-node small { color: #64748b; }
    .mind-node.good { border-color: #bbf7d0; background: #f0fdf4; }
    .mind-node.warn { border-color: #fde68a; background: #fffbeb; }
    .mind-node.bad { border-color: #fecaca; background: #fef2f2; }
    .mind-node-meta { display: flex; flex-wrap: wrap; gap: 6px; }
    .mind-node-meta span { border: 1px solid #cbd5e1; background: rgba(255,255,255,0.72); padding: 3px 6px; font-size: 12px; color: #334155; }
    .segmented-actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
    .segment { border: 1px solid #cbd5e1; background: #fff; color: #172033; padding: 10px 12px; display: grid; gap: 4px; min-height: 56px; align-content: center; }
    .segment strong { font-size: 14px; line-height: 1.2; }
    .segment span { color: #64748b; font-size: 12px; line-height: 1.25; }
    .segment.active { border-color: #1d4ed8; background: #eff6ff; box-shadow: inset 0 0 0 1px #1d4ed8; }
    .segment.active strong { color: #1d4ed8; }
    .network-shell { display: grid; gap: 12px; }
    .network-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; padding: 10px; border: 1px solid #dbe4f0; background: #f8fafc; }
    .network-toolbar > div:first-child { display: grid; gap: 3px; }
    .network-toolbar strong { color: #172033; font-size: 13px; }
    .network-toolbar span { color: #64748b; font-size: 12px; line-height: 1.3; }
    .compact-segments { grid-template-columns: repeat(2, minmax(112px, 1fr)); min-width: 250px; }
    .compact-segments .segment { min-height: 44px; padding: 8px 10px; }
    .network-map { display: block; width: 100%; min-height: 430px; border: 1px solid #1e3a5f; background: #020617; box-shadow: inset 0 0 0 1px rgba(56,189,248,0.14), 0 22px 44px rgba(15,23,42,0.16); }
    .network-map .network-backdrop { fill: url(#neuralCoreGlow); }
    .network-map .network-grid { fill: url(#neuralGrid); }
    .network-rings circle { fill: none; stroke: #38bdf8; stroke-opacity: 0.11; stroke-width: 1.2; }
    .network-links path { fill: none; stroke: url(#neuralSignal); stroke-linecap: round; stroke-opacity: 0.26; }
    .network-links .signal { stroke: url(#neuralSignal); stroke-opacity: 0.48; }
    .network-links .support { stroke: #22d3ee; stroke-opacity: 0.36; }
    .network-links .sequence { stroke: #f59e0b; stroke-opacity: 0.34; }
    .network-links .outcome { stroke: #94a3b8; stroke-opacity: 0.24; }
    .network-links .dashed { stroke-opacity: 0.42; }
    .network-links .support.dashed { stroke: #38bdf8; stroke-opacity: 0.50; }
    .network-links .sequence.dashed { stroke: #fbbf24; stroke-opacity: 0.48; }
    .network-links .outcome.dashed { stroke: #bfdbfe; stroke-opacity: 0.34; }
    .network-health-ring { transform: rotate(-90deg); transform-origin: center; stroke-width: 4; stroke-linecap: round; filter: url(#neuralGlow); }
    .network-health-ring.completed { stroke: #22c55e; }
    .network-health-ring.failed { stroke: #ef4444; }
    .network-health-ring.active { stroke: #f59e0b; }
    .network-health-ring.cancelled { stroke: #94a3b8; }
    .network-node circle { fill: rgba(2,6,23,0.32); stroke: currentColor; stroke-width: 4; filter: url(#neuralGlow); }
    .network-node text { fill: white; font-size: 11px; font-weight: 800; pointer-events: none; }
    .network-stage text { font-size: 9px; }
    .network-node { cursor: default; }
    .network-map a .network-node { cursor: pointer; }
    .network-node:hover circle, a:focus .network-node circle { fill: rgba(15,23,42,0.46); stroke-width: 5; }
    .network-focused circle { stroke-width: 6; }
    .network-map a { outline: none; }
    .network-workflow circle { stroke-width: 5; }
    .network-label { fill: #e2e8f0; font-size: 12px; font-weight: 700; }
    .network-layer-label { fill: #93c5fd; font-size: 11px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
    .network-legend { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; color: #dbeafe; background: #0f172a; border: 1px solid #1e3a5f; padding: 8px 10px; font-size: 12px; }
    .network-legend span { display: inline-flex; align-items: center; gap: 6px; }
    .network-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 999px; border: 2px solid #020617; box-shadow: 0 0 0 1px rgba(147,197,253,0.6), 0 0 12px rgba(56,189,248,0.42); }
    .network-legend .legend-note { color: #93c5fd; }
    .network-legend .legend-stage { background: #2563eb; }
    .network-legend .legend-workflow { background: #0f172a; }
    .network-legend .legend-health-completed { background: #22c55e; }
    .network-legend .legend-health-failed { background: #ef4444; }
    .network-legend .legend-health-active { background: #f59e0b; }
    .network-health-summary { margin: 0; color: #58708f; font-size: 12px; }
    .network-explainer { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; background: #f8fafc; border: 1px solid #dbe4f0; padding: 10px; }
    .network-explainer div { display: grid; gap: 3px; }
    .network-explainer strong { color: #334155; font-size: 12px; text-transform: uppercase; }
    .network-explainer span { color: #64748b; font-size: 12px; line-height: 1.35; }
    .focused-stage-panel { border-color: #93c5fd; box-shadow: inset 3px 0 0 #2563eb; }
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
    @media print {
      body { background: white; }
      main, .capture-page main { max-width: none; padding: 0; }
      .side-nav, .capture-hide, .print-hide { display: none !important; }
      .panel { border-color: #d0d7e2; box-shadow: none; }
      a { color: inherit; }
    }
    @media (max-width: 820px) {
      main { padding: 94px 12px 24px; }
      .side-nav { right: 0; bottom: auto; width: auto; grid-auto-flow: column; grid-auto-columns: max-content; overflow-x: auto; overflow-y: hidden; padding: 10px 12px; gap: 8px; }
      .side-nav strong { display: none; }
      .nav-section { grid-auto-flow: column; grid-auto-columns: max-content; align-items: center; }
      .nav-section span { display: none; }
      .nav-section.active-group { border-left: 0; padding-left: 0; margin-left: 0; }
      .topbar, .section-heading { display: grid; }
      .attention-item { display: grid; }
      .ops-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .ops-state { grid-column: 1 / -1; }
      .provider-hero { grid-template-columns: 1fr; }
      .provider-readiness { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .comparison-layout { grid-template-columns: 1fr; }
      .suite-list { position: static; }
      .mind-map { grid-template-columns: 1fr; }
      .mind-branches::before, .mind-node::before { display: none; }
      .network-toolbar { display: grid; }
      .compact-segments { min-width: 0; }
      .network-map { min-height: 360px; }
      table { display: block; overflow-x: auto; }
    }
  `;
}

function runActionForm(runId: string, action: string, label: string): string {
  return `<form method="post" action="/api/follow-up"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="action" value="${escapeHtml(action)}"><button type="submit">${escapeHtml(label)}</button></form>`;
}

function workerActionForm(runId: string, mode: "batch" | "watch", label: string): string {
  return `<form class="worker-form" method="post" action="/api/run-worker"><input type="hidden" name="runId" value="${escapeHtml(runId)}"><input type="hidden" name="mode" value="${escapeHtml(mode)}"><input type="hidden" name="workerLimit" value="6"><input type="hidden" name="workerConcurrency" value="1"><input type="hidden" name="timeoutMs" value="${mode === "watch" ? "60000" : "1000"}"><button type="submit">${escapeHtml(label)}</button></form>`;
}

function queueProcessForm(project: string): string {
  return `<form class="worker-form" method="post" action="/api/queue-action"><input type="hidden" name="action" value="process"><input type="hidden" name="project" value="${escapeHtml(project)}"><input name="workerLimit" inputmode="numeric" value="6" aria-label="Worker limit"><input name="workerConcurrency" inputmode="numeric" value="1" aria-label="Worker concurrency"><button type="submit">Process Worker Batch</button></form>`;
}

function queueRecoverExpiredLeasesForm(): string {
  return `<form class="worker-form" method="post" action="/api/queue-action"><input type="hidden" name="action" value="recover-expired-leases"><button type="submit">Recover Expired Leases</button></form>`;
}

function queueItemForms(item: DashboardQueueItem): string {
  const forms = [
    `<a class="button secondary" href="/run?id=${encodeURIComponent(item.runId)}">Open</a>`
  ];
  if (item.runningTasks > 0) {
    forms.push(queueRunActionForm(item.runId, "requeue-running", "Requeue Running"));
  }
  if (hasExpiredLease(item)) {
    forms.push(queueRunActionForm(item.runId, "recover-expired-leases", "Recover Expired Lease"));
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

function hasExpiredLease(item: DashboardQueueItem): boolean {
  return Boolean(item.runningLeaseExpiresAt && Date.parse(item.runningLeaseExpiresAt) < Date.now());
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

function promotionNotePlanForm(report: DashboardCandidateComparisonReport): string {
  const suiteIds = report.promotionRecommendations
    .filter((recommendation) => recommendation.decision === "propose_routing_note")
    .map((recommendation) => recommendation.suiteId);
  if (!suiteIds.length) {
    return '<p class="muted">Run baseline and candidate evaluations until a suite is promotable before generating a promotion note plan.</p>';
  }
  return `<form class="inline-form" method="post" action="/api/follow-up">
    <input type="hidden" name="project" value="${escapeHtml(report.projectDir)}">
    <input type="hidden" name="action" value="promotion-note-plan">
    <input type="hidden" name="ids" value="${escapeHtml(suiteIds.join(","))}">
    <button type="submit">Preview Promotion Note Plan</button>
  </form>`;
}

function bundleLifecyclePlanForm(readiness: DashboardBundleReadiness, params: URLSearchParams): string {
  if (!readiness.projectDir) {
    return '<p class="muted">Enter a project path and inspect readiness before generating a project-local lifecycle plan.</p>';
  }
  const selectedEntry = readiness.registry.entries.find((entry) => entry.selected) ?? readiness.registry.entries[0];
  const bundleId = params.get("bundleId")?.trim() || selectedEntry?.id || "agent-workflow-core";
  const targetVersion = params.get("targetVersion")?.trim() || selectedEntry?.latestVersion || "";
  const registry = params.get("registry")?.trim() || readiness.registry.registryPath;
  return `<form class="workflow-form" method="post" action="/api/bundle-lifecycle-plan">
    <input type="hidden" name="project" value="${escapeHtml(readiness.projectDir)}">
    <input type="hidden" name="registry" value="${escapeHtml(registry)}">
    <label>Bundle id<input name="bundleId" value="${escapeHtml(bundleId)}"></label>
    <label>Mode<select name="mode"><option value="upgrade">upgrade</option><option value="rollback">rollback</option></select></label>
    <label>Target version<input name="targetVersion" value="${escapeHtml(targetVersion)}" placeholder="latest for upgrade, required for rollback"></label>
    <label class="check-row"><input type="checkbox" name="write"> Write plan file</label>
    <div class="form-actions"><button type="submit">Generate Plan</button></div>
  </form>`;
}

function projectIndexForm(project: string): string {
  return `<form class="inline-form" method="post" action="/api/project-index"><input type="hidden" name="project" value="${escapeHtml(project)}"><input name="maxFiles" inputmode="numeric" value="120" aria-label="Max files"><label class="check-row"><input type="checkbox" name="refine"> Refine</label><button type="submit">Index Project</button></form>`;
}

function workflowGraphHandoffExportForm(input: {
  workflowId: string;
  project: string;
  policyProfile: string;
  view: string;
  orientation: "horizontal" | "radial";
  category: string;
  approval: string;
  policyStatus: string;
  runStatus: string;
  runLimit: string;
  stage: string;
}): string {
  const fields: Record<string, string> = {
    workflow: input.workflowId,
    project: input.project,
    policyProfile: input.policyProfile,
    view: input.view,
    orientation: input.orientation,
    category: input.category,
    approval: input.approval,
    policyStatus: input.policyStatus,
    runStatus: input.runStatus,
    runLimit: input.runLimit,
    stage: input.stage
  };
  const hiddenFields = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  return `<form class="inline-form compact-form" method="post" action="/api/graph-handoff-export">${hiddenFields}<button type="submit">Export Handoff</button></form>`;
}

function focusedStageSuggestFixForm(input: {
  project: string;
  workflowId: string;
  stageId: string;
  disabled: boolean;
}): string {
  return `<form class="inline-form" method="post" action="/api/follow-up">
    <input type="hidden" name="action" value="suggest-stage-fix">
    <input type="hidden" name="project" value="${escapeHtml(input.project)}">
    <input type="hidden" name="workflowId" value="${escapeHtml(input.workflowId)}">
    <input type="hidden" name="stageId" value="${escapeHtml(input.stageId)}">
    <button type="submit"${input.disabled ? " disabled" : ""}>Suggest Fix</button>
  </form>`;
}

function stageFixVerificationForm(input: {
  project: string;
  workflowId: string;
  stageId: string;
  fixRunId: string;
  disabled: boolean;
}): string {
  return `<form class="inline-form compact-form" method="post" action="/api/follow-up">
    <input type="hidden" name="action" value="verify-stage-fix">
    <input type="hidden" name="project" value="${escapeHtml(input.project)}">
    <input type="hidden" name="workflowId" value="${escapeHtml(input.workflowId)}">
    <input type="hidden" name="stageId" value="${escapeHtml(input.stageId)}">
    <input type="hidden" name="runId" value="${escapeHtml(input.fixRunId)}">
    <button type="submit"${input.disabled ? " disabled" : ""}>Rerun Source</button>
  </form>`;
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

async function readJsonBody(request: http.IncomingMessage, maxBytes = 64_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error(`JSON request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

async function processDashboardBundleLifecyclePlan(input: {
  project: string;
  bundleId: string;
  mode: string;
  targetVersion: string;
  registry: string;
  write: boolean;
}): Promise<DashboardFollowUpResult> {
  const projectDir = input.project.trim();
  if (!projectDir) {
    return { ok: false, error: "Missing project path." };
  }
  const mode = input.mode.trim() || "upgrade";
  if (mode !== "upgrade" && mode !== "rollback") {
    return { ok: false, error: "Mode must be upgrade or rollback." };
  }
  const registryPath = path.resolve(process.cwd(), input.registry.trim() || defaultBundleRegistryPath);
  const registry = await loadBundleRegistry(registryPath);
  const plan = buildBundleLifecyclePlan({
    registry,
    projectDir: path.resolve(process.cwd(), projectDir),
    bundleId: input.bundleId.trim() || "agent-workflow-core",
    mode,
    targetVersion: input.targetVersion.trim() || undefined,
    write: input.write
  });
  let writtenPath: string | null = null;
  if (input.write && plan.status === "ready") {
    writtenPath = await writeBundleLifecyclePlan(plan);
  }
  const writeCommand = [
    "npm run agentflow -- bundle-lifecycle-plan",
    "--project", shellQuote(plan.projectDir),
    "--bundle-id", shellQuote(input.bundleId.trim() || "agent-workflow-core"),
    "--mode", shellQuote(mode),
    ...(input.targetVersion.trim() ? ["--target-version", shellQuote(input.targetVersion.trim())] : []),
    "--write"
  ].join(" ");
  const output = [
    formatBundleLifecyclePlan(plan),
    writtenPath ? `\nWritten: ${writtenPath}` : `\nDry run only. To write the review file:\n${writeCommand}`,
    "Open: /bundles"
  ].join("\n");
  return plan.status === "ready"
    ? { ok: true, title: input.write ? "Bundle Lifecycle Plan Written" : "Bundle Lifecycle Plan Dry Run", output }
    : { ok: false, error: output };
}

async function processDashboardRoleAuditExport(input: {
  project: string;
  limit: string;
  role: string;
  status: string;
  actionType: string;
  out: string;
}): Promise<DashboardFollowUpResult> {
  try {
    const report = await loadRoleGovernanceReport({
      projectRootUri: input.project.trim() || undefined,
      limit: parsePositiveInteger(input.limit || "50", 50),
      role: input.role.trim() || undefined,
      status: input.status.trim() || "all",
      actionType: input.actionType.trim() || undefined
    });
    const exported = await writeRoleAuditSnapshot(report, input.out.trim() || undefined);
    return {
      ok: true,
      title: "Role Audit Snapshot Exported",
      output: [
        `Project: ${report.projectRootUri ?? "all registered projects"}`,
        `Filters: role=${report.filters.role ?? "all"} status=${report.filters.status} action=${report.filters.actionType ?? "all"}`,
        `Approvals: ${report.recentApprovals.length}`,
        "",
        `Markdown: ${exported.markdownPath}`,
        `JSON: ${exported.jsonPath}`,
        "",
        "Open: /roles"
      ].join("\n")
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function exportDashboardWorkflowGraphHandoff(form: URLSearchParams): Promise<DashboardFollowUpResult> {
  const params = new URLSearchParams();
  const copyFields = ["workflow", "project", "policyProfile", "view", "orientation", "category", "approval", "policyStatus", "runStatus", "runLimit", "stage"];
  for (const field of copyFields) {
    const value = form.get(field);
    if (value !== null) params.set(field, value);
  }

  const report = await loadDashboardWorkflowGraph(params);
  const projectDir = path.resolve(process.cwd(), params.get("project")?.trim() || process.env.AGENTFLOW_DASHBOARD_PROJECT || "templates/project");
  const view = params.get("view") || "graph";
  const orientation = params.get("orientation") === "radial" ? "radial" : "horizontal";
  const graphPath = workflowGraphDashboardHref(report.workflow.id, params.get("project")?.trim() || projectDir, params.get("policyProfile")?.trim() || report.project.policyProfile, {
    view,
    orientation,
    category: params.get("category")?.trim() || "",
    approval: params.get("approval")?.trim() || "all",
    policyStatus: params.get("policyStatus")?.trim() || "all",
    runLimit: String(parseDashboardRunLimit(params.get("runLimit") ?? "50", 50)),
    runStatus: report.runStatusFilter,
    capture: true,
    stage: report.focusedStageId
  });
  const generatedAt = new Date().toISOString();
  const exportDir = path.join(projectDir, ".agent-workflow", "exports", "graphs");
  const fileBase = [
    generatedAt.replace(/[:.]/g, "-"),
    safeFileSegment(report.workflow.id),
    report.focusedStageId ? safeFileSegment(report.focusedStageId) : "all-stages"
  ].join("-");
  const jsonPath = path.join(exportDir, `${fileBase}.json`);
  const markdownPath = path.join(exportDir, `${fileBase}.md`);
  const payload = buildGraphHandoffPayload({
    report,
    generatedAt,
    graphPath,
    filters: {
      view,
      orientation,
      category: params.get("category")?.trim() || "all",
      approval: params.get("approval")?.trim() || "all",
      policyStatus: params.get("policyStatus")?.trim() || "all",
      runStatus: report.runStatusFilter,
      runLimit: parseDashboardRunLimit(params.get("runLimit") ?? "50", 50),
      stage: report.focusedStageId || "all"
    }
  });
  await fs.mkdir(exportDir, { recursive: true });
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(markdownPath, formatGraphHandoffMarkdown(payload), "utf8");
  return {
    ok: true,
    title: "Graph Handoff Exported",
    output: [
      `Markdown: ${markdownPath}`,
      `JSON: ${jsonPath}`,
      `Graph URL: ${graphPath}`,
      `Workflow: ${report.workflow.id}`,
      `Runs included: ${report.runs.length}`,
      report.focusedStageId ? `Focused stage: ${report.focusedStageId}` : "Focused stage: all",
      `Open: ${graphPath}`
    ].join("\n")
  };
}

type GraphHandoffPayload = ReturnType<typeof buildGraphHandoffPayload>;

function buildGraphHandoffPayload(input: {
  report: DashboardWorkflowGraphReport;
  generatedAt: string;
  graphPath: string;
  filters: Record<string, string | number>;
}) {
  const stageHealth = input.report.stageHealth.map((health) => ({
    stageId: health.stageId,
    totalTasks: health.totalTasks,
    completedTasks: health.completedTasks,
    failedTasks: health.failedTasks,
    activeTasks: health.queuedTasks + health.runningTasks,
    cancelledTasks: health.cancelledTasks
  }));
  const focusedStage = input.report.focusedStageId
    ? {
      id: input.report.focusedStageId,
      historyRows: input.report.focusedStageRuns.length,
      suggestedFixRuns: input.report.focusedStageFixRuns.map((run) => ({
        id: run.id,
        status: run.status,
        startedAt: run.startedAt
      })),
      verificationRuns: input.report.focusedStageVerificationRuns.map((run) => ({
        id: run.id,
        status: run.status,
        sourceFixRunId: stringValue(run.evaluationMetadata.sourceFixRunId),
        startedAt: run.startedAt
      })),
      delta: summarizeFocusedStageDelta(
        input.report.focusedStageRuns.filter((run) => !input.report.focusedStageVerificationRuns.some((verification) => verification.id === run.runId)),
        input.report.focusedStageRuns.filter((run) => input.report.focusedStageVerificationRuns.some((verification) => verification.id === run.runId))
      )
    }
    : null;
  return {
    kind: "agentflow_graph_handoff",
    generatedAt: input.generatedAt,
    graphPath: input.graphPath,
    filters: input.filters,
    workflow: input.report.workflow,
    project: input.report.project,
    totals: input.report.totals,
    runs: input.report.runs.map((run) => ({
      id: run.id,
      workflowId: run.workflowId,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt
    })),
    stageHealth,
    focusedStage
  };
}

function formatGraphHandoffMarkdown(payload: GraphHandoffPayload): string {
  const stageRows = payload.stageHealth.map((stage) => (
    `| ${stage.stageId} | ${stage.totalTasks} | ${stage.completedTasks} | ${stage.failedTasks} | ${stage.activeTasks} | ${stage.cancelledTasks} |`
  )).join("\n") || "| none | 0 | 0 | 0 | 0 | 0 |";
  const runRows = payload.runs.slice(0, 20).map((run) => (
    `| ${run.id} | ${run.workflowId} | ${run.status} | ${run.startedAt} |`
  )).join("\n") || "| none | none | none | none |";
  const focused = payload.focusedStage
    ? [
      "## Focused Stage",
      "",
      `Stage: ${payload.focusedStage.id}`,
      `History rows: ${payload.focusedStage.historyRows}`,
      `Suggested fix runs: ${payload.focusedStage.suggestedFixRuns.length}`,
      `Verification reruns: ${payload.focusedStage.verificationRuns.length}`,
      `After signal: ${payload.focusedStage.delta.label}`,
      `Completed delta: ${formatSignedRate(payload.focusedStage.delta.completedDelta) || "n/a"}`,
      `Failed delta: ${formatSignedRate(payload.focusedStage.delta.failedDelta) || "n/a"}`,
      ""
    ].join("\n")
    : "";
  return [
    `# Agent Workflow Graph Handoff`,
    "",
    `Generated: ${payload.generatedAt}`,
    `Graph URL: ${payload.graphPath}`,
    `Workflow: ${payload.workflow.id} (${payload.workflow.name})`,
    `Project: ${payload.project.name}`,
    "",
    "## Filters",
    "",
    ...Object.entries(payload.filters).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Totals",
    "",
    `- stages: ${payload.totals.stages}`,
    `- subagent links: ${payload.totals.subagentLinks}`,
    `- approval stages: ${payload.totals.approvalStages}`,
    `- blocked stages: ${payload.totals.blockedStages}`,
    `- context budget tokens: ${payload.totals.contextBudgetTokens}`,
    `- runs: ${payload.runs.length}`,
    "",
    focused,
    "## Stage Health",
    "",
    "| Stage | Tasks | Completed | Failed | Active | Cancelled |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    stageRows,
    "",
    "## Runs",
    "",
    "| Run | Workflow | Status | Started |",
    "| --- | --- | --- | --- |",
    runRows,
    payload.runs.length > 20 ? `\n${payload.runs.length - 20} additional runs are available in the JSON export.` : "",
    ""
  ].filter((line) => line !== undefined).join("\n");
}

async function queueDashboardStageFix(input: {
  projectDir: string;
  workflowId: string;
  stageId: string;
}): Promise<DashboardFollowUpResult> {
  const projectDir = path.resolve(process.cwd(), input.projectDir.trim());
  const workflowId = input.workflowId.trim();
  const stageId = input.stageId.trim();
  if (!workflowId) {
    return { ok: false, error: "Missing workflow id." };
  }
  if (!stageId) {
    return { ok: false, error: "Missing stage id." };
  }

  const workflows = await loadWorkflows(rootDir);
  const workflow = resolveWorkflow(workflows, workflowId);
  if (!workflow) {
    return { ok: false, error: `Unknown workflow: ${workflowId}` };
  }
  const stage = workflow.stages.find((item) => item.id === stageId);
  if (!stage) {
    return { ok: false, error: `Unknown stage '${stageId}' for workflow '${workflow.id}'.` };
  }

  const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: 100 });
  const workflowRuns = projectRuns.filter((run) => run.workflowId === workflow.id).slice(0, 50);
  const stageRuns = await listWorkflowStageRunsForRuns({
    runIds: workflowRuns.map((run) => run.id),
    stageId
  });
  const failedStageRuns = stageRuns.filter((run) => run.taskStatus === "failed" || run.runStatus === "failed").slice(0, 8);
  const recentStageRuns = stageRuns.slice(0, 8);
  const runLines = (failedStageRuns.length ? failedStageRuns : recentStageRuns).map((run) => (
    `- ${run.runId}: run=${run.runStatus}, stage=${run.taskStatus}, attempts=${run.attempts}, agent=${run.agentId}, task="${run.task}"`
  ));
  const task = [
    `Suggest a focused fix for workflow '${workflow.id}' stage '${stage.id}'.`,
    "",
    `Stage goal: ${stage.goal}`,
    `Primary agent: ${stage.agent}`,
    stage.subagents.length ? `Subagents: ${stage.subagents.join(", ")}` : "Subagents: none",
    "",
    "Use recent run history to identify the likely cause, files or commands to inspect, and the smallest safe next fix.",
    "Do not make broad unrelated changes. Preserve project policy and write receipts for any requested action.",
    "",
    runLines.length ? "Recent relevant stage runs:" : "Recent relevant stage runs: none found for the selected project/workflow.",
    ...runLines
  ].join("\n");

  const queued = await queueWorkflow({
    workflowId: "debug-failure",
    projectPath: projectDir,
    task,
    sourceTokenBudget: "3000",
    sourceMaxFiles: "40",
    evaluationMetadata: {
      kind: "stage_fix_suggestion",
      sourceWorkflowId: workflow.id,
      sourceStageId: stage.id,
      sourceProjectRootUri: projectDir,
      sourceRunIds: (failedStageRuns.length ? failedStageRuns : recentStageRuns).map((run) => run.runId),
      createdFrom: "dashboard-workflow-graph"
    }
  });
  if (!queued.ok) {
    return { ok: false, error: queued.error };
  }
  return {
    ok: true,
    title: "Stage Fix Suggested",
    runId: queued.run.runId,
    output: [
      `Queued debug run: ${queued.run.runId}`,
      `Source workflow: ${workflow.id}`,
      `Focused stage: ${stage.id}`,
      `Recent stage records: ${stageRuns.length}`,
      failedStageRuns.length ? `Failed records included: ${failedStageRuns.length}` : "No failed stage records found; queued from recent stage history.",
      `Open: /run?id=${encodeURIComponent(queued.run.runId)}`,
      "",
      "Process queued stages with:",
      "npm run worker -- --limit 6"
    ].join("\n")
  };
}

async function queueDashboardStageVerification(input: {
  projectDir: string;
  workflowId: string;
  stageId: string;
  fixRunId: string;
}): Promise<DashboardFollowUpResult> {
  const projectDir = path.resolve(process.cwd(), input.projectDir.trim());
  const workflowId = input.workflowId.trim();
  const stageId = input.stageId.trim();
  const fixRunId = input.fixRunId.trim();
  if (!workflowId) {
    return { ok: false, error: "Missing workflow id." };
  }
  if (!stageId) {
    return { ok: false, error: "Missing stage id." };
  }
  if (!fixRunId) {
    return { ok: false, error: "Missing suggested fix run id." };
  }

  const fixRun = await getWorkflowRunDetails(fixRunId);
  if (!fixRun.run) {
    return { ok: false, error: `Unknown suggested fix run: ${fixRunId}` };
  }
  if (fixRun.run.status === "queued" || fixRun.run.status === "running") {
    return { ok: false, error: "Wait for the suggested fix run to finish before rerunning the source workflow." };
  }
  const metadata = fixRun.run.evaluationMetadata ?? {};
  if (metadata.kind !== "stage_fix_suggestion" || metadata.sourceWorkflowId !== workflowId || metadata.sourceStageId !== stageId) {
    return { ok: false, error: "Run is not a suggested fix for the selected workflow stage." };
  }

  const task = [
    `Rerun workflow '${workflowId}' after suggested fix run '${fixRunId}' to verify focused stage '${stageId}'.`,
    "",
    "Use this as the after run for focused-stage health comparison.",
    "Preserve project policy, keep changes scoped, and write receipts for requested actions.",
    "",
    `Suggested fix status: ${fixRun.run.status}`,
    `Suggested fix task: ${fixRun.run.task}`
  ].join("\n");

  const queued = await queueWorkflow({
    workflowId,
    projectPath: projectDir,
    task,
    sourceTokenBudget: "3000",
    sourceMaxFiles: "40",
    evaluationMetadata: {
      kind: "stage_fix_verification",
      sourceWorkflowId: workflowId,
      sourceStageId: stageId,
      sourceFixRunId: fixRunId,
      sourceProjectRootUri: projectDir,
      createdFrom: "dashboard-workflow-graph"
    }
  });
  if (!queued.ok) {
    return { ok: false, error: queued.error };
  }
  return {
    ok: true,
    title: "Source Workflow Rerun Queued",
    runId: queued.run.runId,
    output: [
      `Verification run: ${queued.run.runId}`,
      `Source workflow: ${workflowId}`,
      `Focused stage: ${stageId}`,
      `Suggested fix run: ${fixRunId}`,
      `Open: /run?id=${encodeURIComponent(queued.run.runId)}`,
      "",
      "Process queued stages with:",
      "npm run worker -- --limit 6"
    ].join("\n")
  };
}

async function runDashboardFollowUp(input: {
  action: string;
  runId?: string;
  project?: string;
  workflowId?: string;
  stageId?: string;
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

  if (action === "suggest-stage-fix") {
    return queueDashboardStageFix({
      projectDir: sourceProject,
      workflowId: input.workflowId ?? "",
      stageId: input.stageId ?? ""
    });
  }

  if (action === "verify-stage-fix") {
    return queueDashboardStageVerification({
      projectDir: sourceProject,
      workflowId: input.workflowId ?? "",
      stageId: input.stageId ?? "",
      fixRunId: input.runId ?? ""
    });
  }

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

  if (action === "promotion-note-plan") {
    const report = await loadDashboardCandidateComparisonReport({
      projectDir: sourceProject
    });
    const suiteIds = input.ids?.trim() || "all";
    const plan = buildPromotionRoutingNotePlan(report, parseProposalIds(suiteIds));
    return {
      ok: true,
      title: "Promotion Note Plan Dry Run",
      output: `${formatPromotionRoutingNotePlan(plan)}\n\nRun this command to write the review files:\nnpm run agentflow -- promotion-note-plan --project ${shellQuote(sourceProject)} --suite ${shellQuote(suiteIds)} --write`
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
  workerConcurrency?: number;
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
    workerConcurrency: input.workerConcurrency,
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
          workerConcurrency: options.workerConcurrency,
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
          workerConcurrency: options.workerConcurrency,
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
  workerConcurrency?: number;
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
    workerConcurrency: input.workerConcurrency,
    projectRootUri: queued.projectDir,
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
  selectionReason?: string;
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

type DashboardModelImprovementReport = {
  generatedAt: string;
  projectDir: string;
  scorecard: PreferenceScorecard;
  proposals: TuningProposalSet;
  evaluationRuns: number;
  latestEvaluationAt: string | null;
  proposalCounts: Record<string, number>;
  highPriorityProposals: number;
  feedbackNeeded: number;
  routingProposals: number;
  promotionReady: boolean;
  readiness: string[];
  nextCommands: string[];
};

type DashboardCandidateComparisonReport = {
  generatedAt: string;
  projectDir: string;
  modelPlanPath: string;
  comparisonPlanPath: string;
  modelPlanExists: boolean;
  comparisonPlanExists: boolean;
  modelPlanError: string | null;
  comparisonPlanError: string | null;
  modelPlan: Omit<ModelImprovementPlan, "files"> | null;
  comparisonPlan: Omit<CandidateComparisonPlan, "files"> | null;
  suiteFiles: Array<{
    path: string;
    exists: boolean;
  }>;
  outcomes: Array<{
    suiteId: string;
    runs: number;
    leader: string | null;
    latestAt: string | null;
    baselineRuns: number;
    candidateRuns: number;
    baselineQuality: number | null;
    candidateQuality: number | null;
    qualityDelta: number | null;
    baselineLatencyMs: number | null;
    candidateLatencyMs: number | null;
    latencyDeltaMs: number | null;
    gateReady: boolean;
  }>;
  promotionRecommendations: Array<{
    suiteId: string;
    decision: "keep_baseline" | "run_more_evals" | "propose_routing_note";
    severity: "info" | "warning" | "ready";
    rationale: string[];
    nextAction: string;
  }>;
  promotionNoteFiles: DashboardPromotionNoteFileSummary[];
  readiness: string[];
  nextCommands: string[];
};

type DashboardPromotionNoteFileSummary = {
  path: string;
  exists: boolean;
  bytes: number;
  modifiedAt: string | null;
  preview: string | null;
  error: string | null;
};

type DashboardPromotionRoutingNotePlan = {
  kind: "agentflow_promotion_routing_note_plan";
  projectRootUri: string;
  generatedAt: string;
  sourceComparisonPlanGeneratedAt: string | null;
  selectedSuiteIds: string[];
  skippedSuiteIds: string[];
  notes: Array<{
    suiteId: string;
    workflowId: string;
    baseline: CandidateVariantPlan | null;
    candidate: CandidateVariantPlan | null;
    qualityDelta: number | null;
    latencyDeltaMs: number | null;
    gateCommand: string | null;
    rationale: string[];
    draftNote: string;
  }>;
  files: Array<{
    relativePath: string;
    content: string;
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function textHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  fullIndex?: boolean;
}): Promise<{
  projectName: string;
  count: number;
  skipped: number;
  refined: number;
  reused: number;
  changed: number;
  deleted: number;
  incremental: boolean;
  fullIndexFallback: boolean;
  truncated: boolean;
  headCommit?: string;
}> {
  const project = await loadProjectConfig(input.projectDir);
  const projectId = await upsertProject({
    name: project.project.name,
    rootUri: input.projectDir,
    profile: project.project.autonomy === "wide-open" ? "enterprise" : "custom",
    config: project
  });

  return indexProjectWithStorage({
    projectId,
    projectDir: input.projectDir,
    project,
    maxFiles: input.maxFiles,
    refineProvider: input.refine ? providerFromEnv() : undefined,
    forceRefine: input.forceRefine,
    incremental: !input.fullIndex && !input.forceRefine
  });
}

async function indexProjectWithStorage(input: {
  projectId: string;
  projectDir: string;
  project: ProjectConfig;
  maxFiles: number;
  refineProvider?: ReturnType<typeof providerFromEnv>;
  forceRefine: boolean;
  incremental: boolean;
  sinceCommit?: string;
}): Promise<{
  projectName: string;
  count: number;
  skipped: number;
  refined: number;
  reused: number;
  changed: number;
  deleted: number;
  incremental: boolean;
  fullIndexFallback: boolean;
  truncated: boolean;
  headCommit?: string;
}> {
  const existingSummaries = await listProjectFileSummaries({
    projectRootUri: input.projectDir,
    limit: 100_000
  });
  const state = await getProjectIndexState({ projectId: input.projectId });
  const sinceCommit = input.sinceCommit ?? state?.headCommit ?? undefined;
  const shouldIncrement = input.incremental && Boolean(sinceCommit);
  const result = await indexProjectFiles({
    projectDir: input.projectDir,
    project: input.project,
    maxFiles: input.maxFiles,
    refineProvider: input.refineProvider,
    existingSummaries,
    forceRefine: input.forceRefine,
    deltaOnly: shouldIncrement,
    sinceCommit
  });

  const count = await upsertProjectFiles({ projectId: input.projectId, files: result.files });
  const deleted = await deleteProjectFiles({
    projectId: input.projectId,
    sourceUris: result.deletedSourceUris
  });
  const storedSourceUris = new Set(existingSummaries.map((summary) => summary.sourceUri));
  for (const sourceUri of result.deletedSourceUris) {
    storedSourceUris.delete(sourceUri);
  }
  for (const file of result.files) {
    storedSourceUris.add(file.sourceUri);
  }
  await upsertProjectIndexState({
    projectId: input.projectId,
    headCommit: result.headCommit,
    indexedFiles: storedSourceUris.size,
    deletedFiles: deleted,
    metadata: {
      mode: result.incremental ? "incremental" : "full",
      fullIndexFallback: result.fullIndexFallback,
      indexedFilesThisRun: count,
      indexedFilesTotal: storedSourceUris.size,
      changed: result.changed,
      reused: result.reused,
      truncated: result.truncated,
      sinceCommit: shouldIncrement ? sinceCommit : null
    }
  });
  return {
    projectName: input.project.project.name,
    count,
    skipped: result.files.filter((file) => file.metadata.skipped).length,
    refined: result.refined,
    reused: result.reused,
    changed: result.changed,
    deleted,
    incremental: result.incremental,
    fullIndexFallback: result.fullIndexFallback,
    truncated: result.truncated,
    headCommit: result.headCommit
  };
}

function formatIndexResult(result: {
  projectName: string;
  count: number;
  skipped: number;
  refined: number;
  reused: number;
  changed: number;
  deleted: number;
  incremental: boolean;
  fullIndexFallback: boolean;
  truncated: boolean;
  headCommit?: string;
}): string {
  return [
    `${result.incremental ? "Incrementally indexed" : "Indexed"} ${result.count} file${result.count === 1 ? "" : "s"} for ${result.projectName}.`,
    `Changed: ${result.changed}; reused: ${result.reused}; deleted: ${result.deleted}; refined: ${result.refined}; skipped large: ${result.skipped}.`,
    result.headCommit ? `Head commit: ${result.headCommit}` : "",
    result.fullIndexFallback ? "Git delta unavailable; fell back to a full index." : "",
    result.truncated ? "Index limit reached before all changed files were processed; rerun with a higher --max-files or --index-max-files value." : ""
  ].filter(Boolean).join("\n");
}

async function watchWorkflowRun(input: {
  runId: string;
  workerLimit: number;
  workerConcurrency?: number;
  projectRootUri?: string;
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
    const workerResult = await runWorkerOnce(input.workerLimit, {
      workerId: normalizeWorkerId("dashboard"),
      projectRootUri: input.projectRootUri,
      concurrency: input.workerConcurrency
    });
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

function parseNonNegativeInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseBoundedPositiveInteger(value: string, fallback: number, max: number): number {
  return Math.min(parsePositiveInteger(value, fallback), max);
}

function normalizeActorRole(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

type TeamRoleCapability =
  | "can_request_approvals"
  | "can_approve_actions"
  | "can_reject_actions"
  | "can_execute_approved_actions"
  | "can_author_workflows";

function evaluateRoleGate(project: ProjectConfig, actorRole: string, capability: TeamRoleCapability): { allowed: boolean; message: string } {
  const mode = project.team.enforcement ?? "preview";
  const role = project.team.roles[actorRole];
  const hasCapability = Boolean(role?.[capability]);
  const capabilityLabel = capability.replace(/^can_/, "").replaceAll("_", " ");
  if (mode === "enforce" && !hasCapability) {
    return {
      allowed: false,
      message: `Role gate blocked: ${actorRole} is not configured to ${capabilityLabel}. Set team.enforcement: preview or grant ${capability} in .agent-workflow/project.yaml.`
    };
  }
  return {
    allowed: true,
    message: `${mode === "enforce" ? "Role gate passed" : "Role gate preview"}: ${actorRole} ${hasCapability ? "can" : "is not configured to"} ${capabilityLabel}.`
  };
}

function evaluateSeparationOfDuties(project: ProjectConfig, approval: DashboardActionApproval, actor: string): { allowed: boolean; message: string } {
  const config = project.team.separation_of_duties;
  if (config.mode === "off" || !config.prevent_same_actor_approval_execution) {
    return { allowed: true, message: "off" };
  }
  if (!approval.decidedBy || approval.decidedBy !== actor) {
    return {
      allowed: true,
      message: `${config.mode}: approver and executor are distinct or the approver is unrecorded.`
    };
  }
  const message = `Separation of duties ${config.mode}: ${actor} approved this action and is now executing it.`;
  return {
    allowed: config.mode !== "enforce",
    message: config.mode === "enforce"
      ? `${message} Use a different executor or set team.separation_of_duties.mode to preview/off.`
      : message
  };
}

function cliOptionValue<T extends string | number | undefined>(value: T, flags: string[], fallback: T): T {
  const wasProvided = process.argv.some((arg) => flags.includes(arg) || flags.some((flag) => arg.startsWith(`${flag}=`)));
  return wasProvided ? value : fallback;
}

async function loadProjectWorkerPoolDefaults(projectDir: string): Promise<{
  workerId?: string;
  limit?: number;
  concurrency?: number;
  leaseSeconds?: number;
  intervalMs?: number;
  projectScoped?: boolean;
}> {
  try {
    const project = await loadProjectConfig(projectDir);
    const workerPool = project.execution.worker_pool;
    return {
      workerId: workerPool?.worker_id,
      limit: workerPool?.limit,
      concurrency: workerPool?.concurrency,
      leaseSeconds: workerPool?.lease_seconds,
      intervalMs: workerPool?.interval_ms,
      projectScoped: workerPool?.project_scoped
    };
  } catch {
    return {};
  }
}

function parseDashboardRunLimit(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 250);
}

function parseDashboardRunStatusFilter(value: string): string {
  return ["all", "active", "failed", "completed", "queued", "running", "cancelled"].includes(value) ? value : "all";
}

function dashboardRunMatchesStatus(status: string, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "active") return status === "queued" || status === "running";
  return status === filter;
}

function parseProposalIds(value: string | undefined): string[] | "all" {
  if (!value || value.trim().toLowerCase() === "all") {
    return "all";
  }
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseModelTierOption(value: string): CandidateVariantPlan["modelTier"] {
  const normalized = normalizeLookup(value);
  if (normalized === "fast" || normalized === "standard" || normalized === "reasoning") {
    return normalized;
  }
  throw new Error(`Model tier must be one of: fast, standard, reasoning. Received: ${value}`);
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

async function writeProjectBundleState(projectDir: string, force: boolean): Promise<{ relativePath: string; status: "written" | "skipped" }> {
  const manifest = await loadCommittedBundleManifest(rootDir);
  if (!manifest) throw new Error("Bundle manifest is missing.");
  const filePath = path.join(projectDir, ".agent-workflow", "bundle-state.json");
  const relativePath = path.relative(projectDir, filePath);
  if (!force && await exists(filePath)) {
    return { relativePath, status: "skipped" };
  }
  const state: ProjectBundleState = {
    schemaVersion: 1,
    bundle: {
      id: manifest.bundle.id,
      version: manifest.bundle.version,
      checksum: manifest.checksum.value,
      recordedAt: new Date().toISOString()
    }
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return { relativePath, status: "written" };
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
      semantic_index: profile === "enterprise",
      artifact_lifecycle: {
        retention_days: 30,
        min_prune_bytes: 20_000,
        retain_audit_artifacts: true,
        legal_hold: false,
        require_approval_for_prune: true,
        allow_archive_execution: false,
        allow_restore_execution: false,
        allow_prune_execution: false
      }
    },
    execution: {
      policy_profile: "local",
      policy_profiles: {},
      worker_pool: {
        worker_id: "local-dev",
        limit: 6,
        concurrency: 1,
        lease_seconds: 900,
        interval_ms: 2000,
        project_scoped: true,
        default_profile: "local",
        profiles: {
          local: {
            description: "Default single-lane local developer worker pool.",
            lanes: [{ id: "default" }]
          },
          "split-review": {
            description: "Separate implementation and review lanes for local development.",
            lanes: [
              { id: "implementation", worker_id: "implementation-lane", limit: 6, concurrency: 2 },
              { id: "review", worker_id: "review-lane", limit: 3, concurrency: 1 }
            ]
          }
        }
      }
    },
    policies: {
      allow_wide_open: false,
      require_approval_for_external_actions: true,
      require_receipts: true
    },
    team: {
      enforcement: "preview",
      default_actor_role: "operator",
      separation_of_duties: {
        mode: "off",
        prevent_same_actor_approval_execution: true
      },
      roles: {
        operator: {
          description: "Runs local workflows and executes approved local actions.",
          can_request_approvals: true,
          can_approve_actions: false,
          can_reject_actions: false,
          can_execute_approved_actions: true,
          can_author_workflows: false,
          read_only: false
        },
        approver: {
          description: "Reviews and decides pending action, deployment, and autonomy approvals.",
          can_request_approvals: false,
          can_approve_actions: true,
          can_reject_actions: true,
          can_execute_approved_actions: false,
          can_author_workflows: false,
          read_only: false
        },
        workflow_author: {
          description: "Reviews or edits reusable/project-local workflow definitions.",
          can_request_approvals: false,
          can_approve_actions: false,
          can_reject_actions: false,
          can_execute_approved_actions: false,
          can_author_workflows: true,
          read_only: false
        },
        auditor: {
          description: "Reviews run evidence, receipts, exports, and governance reports.",
          can_request_approvals: false,
          can_approve_actions: false,
          can_reject_actions: false,
          can_execute_approved_actions: false,
          can_author_workflows: false,
          read_only: true
        }
      }
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
      max_write_bytes: 250000,
      approval_rules: []
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
  const bundleState = await writeProjectBundleState(projectDir, force);
  if (bundleState.status === "written") {
    written.push(bundleState.relativePath);
  } else {
    skipped.push(bundleState.relativePath);
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

async function readDashboardJsonFile<T>(
  filePath: string,
  validate: (value: Record<string, unknown>) => boolean
): Promise<{ exists: boolean; value: T | null; error: string | null }> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const record = objectValue(parsed);
    if (!validate(record)) {
      return { exists: true, value: null, error: "unexpected file shape" };
    }
    return { exists: true, value: parsed as T, error: null };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { exists: false, value: null, error: null };
    }
    return { exists: true, value: null, error: error instanceof Error ? error.message : String(error) };
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
