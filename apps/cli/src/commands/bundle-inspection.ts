import path from "node:path";
import type { Command } from "commander";
import { loadCommittedBundleManifest, buildBundleManifest, formatBundleManifest, writeBundleManifest } from "../../../../packages/agent-registry/src/manifest.js";
import { runDefinitionContractTests, formatContractTestReport } from "../../../../packages/contract-tests/src/index.js";
import { providerFromEnv } from "../../../../packages/model-providers/src/index.js";
import { normalizeProviderRef } from "../reference-resolution.js";
import {
  buildBundleCompatibilityReport,
  buildBundleLifecyclePlan,
  buildBundlePinPlan,
  buildBundleRegistryReport,
  buildBundleUpgradePreview,
  formatBundleCompatibilityReport,
  formatBundleLifecyclePlan,
  formatBundlePinPlan,
  formatBundleRegistryReport,
  formatBundleUpgradePreview,
  loadBundleRegistry,
  verifyBundle,
  writeBundleLifecyclePlan,
  writeBundlePin,
  type BundleTrustPolicy,
  type ProjectBundleState
} from "../../../../packages/bundle-trust/src/index.js";
import { buildDefinitionMigrationPlan, formatDefinitionMigrationPlan, loadDefinitionMigrationCatalog } from "../../../../packages/definition-migrations/src/index.js";

export function registerBundleInspectionCommands(
  program: Command,
  rootDir: string,
  defaultBundleRegistryPath: string,
  readJsonFile: <T>(filePath: string) => Promise<T | null>
): void {
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
  
  
}

