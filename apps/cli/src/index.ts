#!/usr/bin/env node
import fsSync from "node:fs";
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
  getArtifactByUri,
  getLatestMemory,
  getProjectIndexState,
  getWorkflowRunDetails,
  findRunActionByIdempotencyKey,
  listActionApprovals,
  listArtifacts,
  listProjectFileSummaries,
  listProjectStorageSummaries,
  listWorkflowQueue,
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
const defaultSupervisorHeartbeatPath = path.join(rootDir, ".agent-workflow", "runtime", "supervisor-heartbeat.json");
const defaultBundleRegistryPath = path.join(rootDir, "registries", "bundles.json");

program.hook("preAction", async (_command, actionCommand) => {
  if (["validate", "schemas", "contract-test", "bundle-manifest", "bundle-compat", "bundle-registry", "bundle-pin", "bundle-lifecycle-plan", "bundle-upgrade-preview", "definition-migrations", "bundle-verify", "bundle-sign", "bundle-trust"].includes(actionCommand.name())) return;
  const policy = normalizePolicy(process.env.AGENTFLOW_BUNDLE_TRUST_POLICY);
  const verification = await verifyBundle(rootDir, policy);
  if (!verification.allowed) throw new Error(`Bundle trust policy ${policy} rejected ${verification.status}: ${verification.reasons.join(" ")}`);
  if (policy === "warn" && verification.status !== "trusted") console.error(`WARNING: bundle ${verification.status}: ${verification.reasons.join(" ")}`);
});

type WorkerHeartbeat = {
  pid: number;
  workerId: string;
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
  .command("approvals")
  .description("List, approve, or reject pending agent-requested actions")
  .option("--status <status>", "pending, approved, executed, failed, rejected, or all", "pending")
  .option("-r, --run <id>", "filter by workflow run id")
  .option("-p, --project <dir>", "filter by project directory")
  .option("--approve <id>", "approval id to approve")
  .option("--reject <id>", "approval id to reject")
  .option("--execute <id>", "execute an approved action")
  .option("--actor <name>", "person or tool making the decision", "cli")
  .option("--note <text>", "decision note")
  .option("-l, --limit <number>", "number of approvals to show", "25")
  .option("--json", "print JSON")
  .action(async (options: { status: string; run?: string; project?: string; approve?: string; reject?: string; execute?: string; actor: string; note?: string; limit: string; json?: boolean }) => {
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
        actor: options.actor
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
      const approval = await decideActionApproval({
        approvalId: options.approve ?? options.reject ?? "",
        decision: options.approve ? "approved" : "rejected",
        actor: options.actor,
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
      if (approval.decidedBy) {
        console.log(`  Decided: ${approval.decidedBy} at ${approval.decidedAt ?? "unknown"}${approval.decisionNote ? ` - ${approval.decisionNote}` : ""}`);
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
  .option("--json", "print JSON")
  .action(async (options: { project: string; type: string; target: string; rationale: string; workflow?: string; policyProfile?: string; actor: string; json?: boolean }) => {
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
      actor: options.actor
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
  .option("--heartbeat-file <path>", "worker heartbeat file path", defaultWorkerHeartbeatPath)
  .action(async (options: { limit: string; watch?: boolean; intervalMs: string; workerId?: string; leaseSeconds: string; heartbeatFile: string }) => {
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
    const workerId = normalizeWorkerId(options.workerId);
    const leaseSeconds = Number.parseInt(options.leaseSeconds, 10);
    if (!Number.isFinite(leaseSeconds) || leaseSeconds < 30) {
      console.error("--lease-seconds must be an integer >= 30");
      process.exitCode = 1;
      return;
    }

    if (!options.watch) {
      const result = await runWorkerOnce(limit, { workerId, leaseSeconds });
      console.log(`Worker ${workerId} claimed ${result.claimed}, completed ${result.completed}, failed ${result.failed}.`);
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
        workerId,
        startedAt,
        lastHeartbeatAt: new Date().toISOString(),
        limit,
        intervalMs,
        ticks,
        claimed: tick?.claimed ?? 0,
        completed: tick?.completed ?? 0,
        failed: tick?.failed ?? 0,
        status,
        command: `agentflow worker --watch --limit ${limit} --interval-ms ${intervalMs} --worker-id ${workerId} --lease-seconds ${leaseSeconds}`
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
    console.log(`Worker watching. id=${workerId} limit=${limit} intervalMs=${intervalMs} leaseSeconds=${leaseSeconds} heartbeat=${heartbeatFile}`);
    await runWorkerWatch({
      limitPerTick: limit,
      intervalMs,
      workerId,
      leaseSeconds,
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

  if (request.method === "POST" && requestUrl.pathname === "/api/approval-action") {
    const form = await readFormBody(request);
    const result = await processDashboardApprovalAction({
      approvalId: form.get("approvalId") ?? "",
      decision: form.get("decision") ?? "",
      note: form.get("note") ?? ""
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
    const queue = await listWorkflowQueue(100);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderQueueHtml(queue));
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
    const info = await loadDashboardInfoFast(dashboardUrlFromRequest(request));
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
        ${queueProcessForm()}
        ${expiredLeaseRows.length ? queueRecoverExpiredLeasesForm() : ""}
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
      <td>${escapeHtml(approval.rationale)}${approval.decidedBy ? `<br><span class="muted">Decided by ${escapeHtml(approval.decidedBy)} at ${renderDashboardDateTime(approval.decidedAt)}</span>` : ""}</td>
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
  task: string;
  startedAt: string;
  finishedAt: string | null;
  providerOverride: string | null;
  modelTierOverride: string | null;
};

type DashboardWorkflowGraphReport = WorkflowGraphReport & {
  runs: DashboardWorkflowGraphRun[];
  runStatusFilter: string;
  runWarnings: string[];
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
  const safeRunLimit = Math.min(Math.max(runLimit, 0), 250);
  const runWarnings: string[] = [];
  let runs: DashboardWorkflowGraphRun[] = [];
  if (safeRunLimit > 0) {
    try {
      const projectRuns = await listWorkflowRunsForProject({ projectRootUri: projectDir, limit: safeRunLimit });
      runs = projectRuns
        .filter((run) => run.workflowId === workflow.id)
        .filter((run) => dashboardRunMatchesStatus(run.status, runStatusFilter))
        .map((run) => ({
          id: run.id,
          status: run.status,
          task: run.task,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          providerOverride: run.providerOverride,
          modelTierOverride: run.modelTierOverride
        }));
    } catch (error) {
      runWarnings.push(`Run history unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ...report, runs, runStatusFilter, runWarnings };
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
  const categoryFilter = params.get("category")?.trim() || "";
  const approvalFilter = params.get("approval")?.trim() || "all";
  const policyFilter = params.get("policyStatus")?.trim() || "all";
  const runLimit = String(parseDashboardRunLimit(params.get("runLimit") ?? "50", 50));
  const runStatusFilter = report.runStatusFilter;
  const capture = params.get("capture") === "1";
  const graphHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { view: "graph", category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter, runLimit, runStatus: runStatusFilter, capture });
  const mindMapHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { view: "mind-map", category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter, runLimit, runStatus: runStatusFilter, capture });
  const networkHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { view: "network", category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter, runLimit, runStatus: runStatusFilter, capture });
  const captureHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { view, category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter, runLimit, runStatus: runStatusFilter, capture: true });
  const exitCaptureHref = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { view, category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter, runLimit, runStatus: runStatusFilter, capture: false });
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
      ? `<section class="panel"><h2>Network Map</h2>${renderWorkflowNetworkHtml(report, filteredStages)}</section>`
      : `<section class="panel"><h2>Connection Graph</h2><div class="graph-flow">${stageCards}</div></section>`;
  const categoryOptions = [`<option value="">all</option>`, ...categories.map((category) => `<option value="${escapeHtml(category)}"${categoryFilter === category ? " selected" : ""}>${escapeHtml(category)}</option>`)].join("");
  const approvalOptions = ["all", "required", "not-required"].map((value) => `<option value="${value}"${approvalFilter === value ? " selected" : ""}>${value}</option>`).join("");
  const policyOptions = ["all", "allowed", "blocked"].map((value) => `<option value="${value}"${policyFilter === value ? " selected" : ""}>${value}</option>`).join("");
  const runStatusOptions = ["all", "active", "failed", "completed", "queued", "running", "cancelled"].map((value) => `<option value="${value}"${runStatusFilter === value ? " selected" : ""}>${value}</option>`).join("");
  const captureActions = capture
    ? `<a class="button secondary" href="${escapeHtml(exitCaptureHref)}">Exit Capture</a><button type="button" onclick="window.print()">Print</button>`
    : `<a class="button secondary" href="${escapeHtml(captureHref)}">Capture View</a>`;
  const quickRunLinks = [
    { label: "All Runs", runStatus: "all", runLimit: "50" },
    { label: "Active Runs", runStatus: "active", runLimit: "50" },
    { label: "Failed Runs", runStatus: "failed", runLimit: "50" },
    { label: "Definition Only", runStatus: "all", runLimit: "0" }
  ].map((item) => {
    const active = runStatusFilter === item.runStatus && runLimit === item.runLimit;
    const href = workflowGraphDashboardHref(report.workflow.id, projectValue, policyValue, { view, category: categoryFilter, approval: approvalFilter, policyStatus: policyFilter, runLimit: item.runLimit, runStatus: item.runStatus, capture });
    return `<a class="button ${active ? "" : "secondary"}" href="${escapeHtml(href)}">${escapeHtml(item.label)}</a>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent Workflow Graph</title><style>${dashboardCss()}</style></head><body${capture ? ' class="capture-page"' : ""}>
  ${capture ? "" : dashboardNav("workflow-graph")}
  <main>
    <div class="topbar"><div>${capture ? "" : '<a href="/">Dashboard</a>'}<h1>Agent Graph</h1><p class="muted">Read-only view of workflow stages, primary agents, subagents, context budgets, approvals, and policy fit.</p></div><div class="actions print-hide"><a class="button secondary capture-hide" href="${escapeHtml(jsonHref)}">JSON</a>${captureActions}</div></div>
    <section class="panel capture-hide"><form method="get" class="workflow-form"><input type="hidden" name="view" value="${escapeHtml(view)}"><label>Workflow<select name="workflow">${workflowOptions}</select></label><label class="wide">Project path<input name="project" value="${escapeHtml(projectValue)}"></label><label>Policy profile<input name="policyProfile" value="${escapeHtml(policyValue)}"></label><label>Agent category<select name="category">${categoryOptions}</select></label><label>Approval<select name="approval">${approvalOptions}</select></label><label>Policy status<select name="policyStatus">${policyOptions}</select></label><label>Run status<select name="runStatus">${runStatusOptions}</select></label><label>Runs shown<input name="runLimit" inputmode="numeric" value="${escapeHtml(runLimit)}"></label><div class="form-actions"><button type="submit">Render Graph</button></div></form><div class="actions quick-actions">${quickRunLinks}</div></section>
    ${warningHtml}
    <section class="panel"><div class="metric-grid">
      ${metricCard("Workflow", report.workflow.id, report.workflow.name)}
      ${metricCard("Stages", report.totals.stages, `${report.totals.subagentLinks} subagent links`)}
      ${metricCard("Visible", filteredStages.length, "stages after filters")}
      ${metricCard("Runs", report.runs.length, `${escapeHtml(runStatusFilter)} ${escapeHtml(report.workflow.id)} runs`)}
      ${metricCard("Context Budget", formatNumber(report.totals.contextBudgetTokens), "compiled source-token ceiling")}
      ${metricCard("Approvals", report.totals.approvalStages, `${report.totals.blockedStages} blocked stages`)}
    </div></section>
    <section class="panel capture-hide"><div class="actions"><a class="button ${view === "graph" ? "" : "secondary"}" href="${escapeHtml(graphHref)}">Connection Graph</a><a class="button ${view === "mind-map" ? "" : "secondary"}" href="${escapeHtml(mindMapHref)}">Mind Map</a><a class="button ${view === "network" ? "" : "secondary"}" href="${escapeHtml(networkHref)}">Network Map</a></div></section>
    ${visual}
    <section class="panel"><h2>Stage Matrix</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Stage</th><th>Agent</th><th>Subagents</th><th>Tokens</th><th>Approval</th><th>Policy</th></tr></thead><tbody>${stageRows}</tbody></table></div></section>
    <section class="panel"><h2>Mermaid</h2><pre>${escapeHtml(report.mermaid)}</pre></section>
  </main></body></html>`;
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
  options: { view: string; category: string; approval: string; policyStatus: string; runLimit: string; runStatus: string; capture: boolean }
): string {
  const query = new URLSearchParams({
    workflow: workflowId,
    project,
    policyProfile,
    view: options.view
  });
  if (options.category) query.set("category", options.category);
  if (options.approval !== "all") query.set("approval", options.approval);
  if (options.policyStatus !== "all") query.set("policyStatus", options.policyStatus);
  if (options.runLimit !== "50") query.set("runLimit", options.runLimit);
  if (options.runStatus !== "all") query.set("runStatus", options.runStatus);
  if (options.capture) query.set("capture", "1");
  return `/workflow-graph?${query.toString()}`;
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

function renderWorkflowNetworkHtml(report: DashboardWorkflowGraphReport, stages: WorkflowGraphReport["stages"]): string {
  if (!stages.length) return '<p class="muted">No stages match the selected filters.</p>';
  const width = 1120;
  const height = 760;
  const centerX = width / 2;
  const centerY = height / 2;
  const stageRadius = 148;
  const agentRadius = 252;
  const runRadius = 338;
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
  type NetworkNode = { id: string; label: string; title: string; x: number; y: number; r: number; color: string; kind: string; href?: string; labelX?: number; labelY?: number; labelAnchor?: string; caption?: string };
  const nodeById = new Map<string, NetworkNode>();
  const links: Array<{ from: string; to: string; width: number; dashed?: boolean; className?: string }> = [];
  const requestSizedRadius = (baseRadius: number, requestCount: number, maxExtra: number): number => baseRadius + Math.min(maxExtra, Math.sqrt(Math.max(0, requestCount)) * 3.2);
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
    label: "core",
    caption: report.workflow.id,
    title: `${report.workflow.name} workflow`,
    x: centerX,
    y: centerY,
    r: 38,
    color: "#38bdf8",
    kind: "workflow",
    labelX: centerX,
    labelY: centerY + 62,
    labelAnchor: "middle"
  });

  const agentEntries = new Map<string, { id: string; label: string; category: string; stageIds: Set<string>; isPrimary: boolean }>();
  stages.forEach((stage, index) => {
    const angle = ringAngle(index, stages.length);
    const point = radialPoint(angle, stageRadius);
    const stageNodeId = `stage:${stage.id}`;
    const stageNode: NetworkNode = {
      id: stageNodeId,
      label: String(stage.order),
      title: `${stage.id}: ${stage.goal}`,
      x: point.x,
      y: point.y,
      r: 22,
      color: stage.policyAllowed ? (stage.approvalRequired || stage.policyApprovalRequired ? "#f59e0b" : "#2563eb") : "#dc2626",
      kind: "stage",
      href: `#${stageAnchorId(stage.id)}`
    };
    applyRadialLabel(stageNode, angle, 14);
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
    const point = radialPoint(angle, agent.isPrimary ? agentRadius - 18 : agentRadius + 22);
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
    if (agent.isPrimary) applyRadialLabel(agentNode, angle, 10);
    nodeById.set(`agent:${agent.id}`, agentNode);
  });

  const runs = report.runs.slice(0, 36);
  runs.forEach((run, index) => {
    const angle = ringAngle(index, Math.max(runs.length, 1), -Math.PI / 2 + Math.PI / Math.max(runs.length, 10));
    const point = radialPoint(angle, runRadius);
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
    if (active || run.status === "failed") applyRadialLabel(runNode, angle, 10);
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
    if (node.kind !== "workflow" && node.labelX !== undefined && node.labelY !== undefined) {
      const angle = Math.atan2(node.y - centerY, node.x - centerX);
      applyRadialLabel(node, angle, node.kind === "stage" ? 14 : 10);
    }
  });

  const linkSvg = links.map((link) => {
    const from = nodeById.get(link.from);
    const to = nodeById.get(link.to);
    if (!from || !to) return "";
    const dash = link.dashed ? ' stroke-dasharray="7 7"' : "";
    const classes = [link.className, link.dashed ? "dashed" : undefined].filter(Boolean).join(" ");
    const className = classes ? ` class="${escapeHtml(classes)}"` : "";
    const pull = link.from === "workflow" || link.to === "workflow" ? 0.42 : 0.22;
    const controlOneX = from.x + (centerX - from.x) * pull;
    const controlOneY = from.y + (centerY - from.y) * pull;
    const controlTwoX = to.x + (centerX - to.x) * pull;
    const controlTwoY = to.y + (centerY - to.y) * pull;
    return `<path${className} d="M ${formatSvgNumber(from.x)} ${formatSvgNumber(from.y)} C ${formatSvgNumber(controlOneX)} ${formatSvgNumber(controlOneY)}, ${formatSvgNumber(controlTwoX)} ${formatSvgNumber(controlTwoY)}, ${formatSvgNumber(to.x)} ${formatSvgNumber(to.y)}" stroke-width="${link.width}"${dash}></path>`;
  }).join("");
  const nodeSvg = [...nodeById.values()].map((node) => {
    const body = `<g class="network-node network-${escapeHtml(node.kind.replace(/\s+/g, "-"))}" style="color:${escapeHtml(node.color)}" transform="translate(${formatSvgNumber(node.x)} ${formatSvgNumber(node.y)})">
      <title>${escapeHtml(node.title)}</title>
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
    { x: 62, y: 54, label: "core" },
    { x: 134, y: 54, label: "stage web" },
    { x: 252, y: 54, label: "agent web" },
    { x: 374, y: 54, label: "run orbit" }
  ].map((layer) => `<text class="network-layer-label" x="${formatSvgNumber(layer.x)}" y="${formatSvgNumber(layer.y)}" text-anchor="start">${escapeHtml(layer.label)}</text>`).join("");
  const runCounts = countBy(report.runs.map((run) => run.status));
  const runLegend = Object.entries(runCounts).map(([status, count]) => `<span><i style="background:${runPalette[status] ?? "#64748b"}"></i>${escapeHtml(status)} runs (${count})</span>`).join("");
  const legend = categories.map((category) => `<span><i style="background:${palette[category] ?? palette.uncategorized}"></i>${escapeHtml(category)}</span>`).join("");
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
      <g class="network-rings">
        <circle cx="${formatSvgNumber(centerX)}" cy="${formatSvgNumber(centerY)}" r="${stageRadius}"></circle>
        <circle cx="${formatSvgNumber(centerX)}" cy="${formatSvgNumber(centerY)}" r="${agentRadius}"></circle>
        <circle cx="${formatSvgNumber(centerX)}" cy="${formatSvgNumber(centerY)}" r="${runRadius}"></circle>
      </g>
      <g>${layerLabels}</g>
      <g class="network-links">${linkSvg}</g>
      <g class="network-nodes">${nodeSvg}</g>
      <g>${labelSvg}</g>
    </svg>
    <div class="network-legend">${legend}<span><i class="legend-stage"></i>stage</span><span><i class="legend-workflow"></i>workflow</span><span class="legend-note">circle size = incoming requests</span>${runLegend}</div>
  </div>`;
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
      workerId: null,
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

function normalizeWorkerId(value?: string): string {
  const configured = value?.trim() || process.env.AGENTFLOW_WORKER_ID?.trim();
  if (configured) {
    return configured;
  }
  const host = os.hostname().replace(/[^a-zA-Z0-9_.-]/g, "-") || "local";
  return `${host}:${process.pid}`;
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

  const workerResult = await runWorkerOnce(workerLimit, { workerId: normalizeWorkerId("dashboard") });
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
    const workerResult = await runWorkerOnce(workerLimit, { workerId: normalizeWorkerId("dashboard") });
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
  note: string;
}): Promise<DashboardFollowUpResult> {
  const approvalId = input.approvalId.trim();
  const decision = input.decision.trim();
  if (!approvalId) {
    return { ok: false, error: "Missing approval id." };
  }
  if (decision === "execute") {
    return executeApprovedAction({ approvalId, actor: "dashboard" });
  }
  if (decision !== "approved" && decision !== "rejected") {
    return { ok: false, error: "Decision must be approved or rejected." };
  }
  const approval = await decideActionApproval({
    approvalId,
    decision,
    actor: "dashboard",
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
      "Decision receipt was recorded.",
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

  if (approval.actionType === "deployment" || approval.actionType === "autonomy") {
    return {
      ok: true,
      title: "Approval decision recorded",
      runId: approval.runId,
      output: [
        `Approval: ${approval.id}`,
        `Action: ${approval.actionType}`,
        `Target: ${approval.target}`,
        "This approval records a human decision; it does not execute a local command.",
        "Run any deployment or autonomy-changing command separately under project policy."
      ].join("\n")
    };
  }

  const project = await loadProjectConfig(approval.projectRootUri);
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
          summary: `Approved command failed: ${summary}`,
          artifactUri
        });
        return { ok: false, error: `Approved command failed. ${summary}` };
      }
      await markActionApprovalExecution({
        approvalId: approval.id,
        status: "executed",
        actor: input.actor,
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
      summary: `Approved action execution failed: ${message}`,
      error: message
    });
    return { ok: false, error: message };
  }
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
      <a class="button secondary" href="/api/settings">Settings JSON</a>
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

function dashboardNav(active: "dashboard" | "queue" | "approvals" | "projects" | "runs" | "evaluations" | "workflow-graph" | "model-improvement" | "candidate-comparisons" | "governance" | "bundles" | "providers" | "info"): string {
  const items = [
    ["dashboard", "/", "Dashboard"],
    ["queue", "/queue", "Queue"],
    ["approvals", "/approvals", "Approvals"],
    ["projects", "/projects", "Projects"],
    ["runs", "/runs", "Runs"],
    ["evaluations", "/evaluations", "Evaluations"],
    ["workflow-graph", "/workflow-graph", "Graph"],
    ["model-improvement", "/model-improvement", "Model Improve"],
    ["candidate-comparisons", "/candidate-comparisons", "Comparisons"],
    ["governance", "/governance", "Governance"],
    ["bundles", "/bundles", "Bundles"],
    ["providers", "/providers", "Providers"],
    ["info", "/settings", "Settings"]
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

function isExecutableApprovalAction(actionType: string): boolean {
  return actionType === "local_command" || actionType === "file_write";
}

function approvalDecisionForms(approvalId: string): string {
  return `<div class="actions">
    <form class="approval-form" method="post" action="/api/approval-action">
      <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
      <input type="hidden" name="decision" value="approved">
      <input name="note" aria-label="Approval note" placeholder="Optional note">
      <button type="submit">Approve</button>
    </form>
    <form class="approval-form" method="post" action="/api/approval-action">
      <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
      <input type="hidden" name="decision" value="rejected">
      <input name="note" aria-label="Rejection note" placeholder="Optional note">
      <button class="danger" type="submit">Reject</button>
    </form>
  </div>`;
}

function approvalExecuteForm(approvalId: string): string {
  return `<form class="approval-form" method="post" action="/api/approval-action">
    <input type="hidden" name="approvalId" value="${escapeHtml(approvalId)}">
    <input type="hidden" name="decision" value="execute">
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
    .side-nav { position: fixed; inset: 0 auto 0 0; width: 176px; background: #111827; color: #dbe4f0; padding: 20px 14px; display: grid; align-content: start; gap: 6px; z-index: 10; }
    .side-nav strong { color: white; font-size: 14px; margin: 0 0 12px; }
    .side-nav a { color: #cbd5e1; padding: 9px 10px; border: 1px solid transparent; }
    .side-nav a:hover, .side-nav a.active { color: white; background: #1f2937; border-color: #334155; }
    .capture-page main { max-width: 1440px; padding: 24px; }
    .capture-page .panel { break-inside: avoid; }
    .capture-page .capture-hide { display: none !important; }
    .topbar { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
    .panel { background: white; border: 1px solid #e2e7f0; padding: 16px; margin-bottom: 16px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .quick-actions { margin-top: 12px; }
    .button, button { appearance: none; border: 1px solid #1d4ed8; background: #1d4ed8; color: white; padding: 8px 11px; font-size: 14px; cursor: pointer; }
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
    .network-shell { display: grid; gap: 12px; }
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
    .network-node circle { fill: rgba(2,6,23,0.32); stroke: currentColor; stroke-width: 4; filter: url(#neuralGlow); }
    .network-node text { fill: white; font-size: 13px; font-weight: 800; pointer-events: none; }
    .network-node { cursor: default; }
    .network-map a .network-node { cursor: pointer; }
    .network-node:hover circle, a:focus .network-node circle { fill: rgba(15,23,42,0.46); stroke-width: 5; }
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
      .side-nav { right: 0; bottom: auto; width: auto; grid-auto-flow: column; grid-auto-columns: max-content; overflow-x: auto; padding: 10px 12px; }
      .side-nav strong { display: none; }
      .topbar, .section-heading { display: grid; }
      .attention-item { display: grid; }
      .comparison-layout { grid-template-columns: 1fr; }
      .suite-list { position: static; }
      .mind-map { grid-template-columns: 1fr; }
      .mind-branches::before, .mind-node::before { display: none; }
      .network-map { min-height: 360px; }
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
    const workerResult = await runWorkerOnce(input.workerLimit, { workerId: normalizeWorkerId("dashboard") });
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
