#!/usr/bin/env node
import { Command } from "commander";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePolicy, verifyBundle } from "../../../packages/bundle-trust/src/index.js";
import { createCliContext } from "./lib/context.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerBundleInspectionCommands } from "./commands/bundle-inspection.js";
import { registerRepositoryMaintenanceCommand } from "./commands/repository-maintenance.js";
import { registerContextThresholdCommands } from "./commands/context-thresholds.js";
import { registerAcceptedOutcomeCommands } from "./commands/accepted-outcomes.js";
import { registerContextCommands } from "./commands/context.js";
import { registerSystemCommands } from "./commands/system.js";
import { registerBundleCommands } from "./commands/bundle.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerStorageCommands } from "./commands/storage.js";
import { registerRunsCommands } from "./commands/runs.js";
import { registerApprovalsCommands } from "./commands/approvals.js";
import { registerLearningCommands } from "./commands/learning.js";
import { registerLocalLlmCommands } from "./commands/local-llm.js";
import { registerServerCommands } from "./commands/server.js";
import { registerContextExtraCommands } from "./commands/context-extra.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerEvaluationDaemonCommands } from "./commands/evaluation-daemon.js";

const program = new Command();
const ctx = createCliContext(import.meta.url);

registerRepositoryMaintenanceCommand(program);
registerContextThresholdCommands(program);
registerAcceptedOutcomeCommands(program);
registerContextCommands(program);

program
  .name("agentflow")
  .description("Portable, model-agnostic agent workflow runner")
  .version(ctx.packageVersion);

program.hook("preAction", async (_command, actionCommand) => {
  if (["validate", "schemas", "contract-test", "bundle-manifest", "bundle-compat", "bundle-registry", "bundle-pin", "bundle-lifecycle-plan", "bundle-upgrade-preview", "definition-migrations", "bundle-verify", "bundle-sign", "bundle-trust", "object-artifact-proof", "offline-fallback", "offline-sync", "project-alias-merge-plan", "roadmap-audit", "runtime-monitor", "server-readiness", "server-mutation-controls", "server-projects", "server-resolve-project", "server-request-log", "server-request-preview", "server-route-preview", "server-approval-preview", "server-approval-action", "server-approval-action-plan", "server-approval-action-test-adapter", "storage-migrate", "storage-merge-evidence", "storage-merge-manifest", "storage-merge-import", "storage-project-conflicts", "storage-project-decision", "storage-verify"].includes(actionCommand.name())) return;
  const policy = normalizePolicy(process.env.AGENTFLOW_BUNDLE_TRUST_POLICY);
  const verification = await verifyBundle(ctx.rootDir, policy);
  if (!verification.allowed) throw new Error(`Bundle trust policy ${policy} rejected ${verification.status}: ${verification.reasons.join(" ")}`);
  if (policy === "warn" && verification.status !== "trusted") console.error(`WARNING: bundle ${verification.status}: ${verification.reasons.join(" ")}`);
});

registerValidateCommand(program, ctx.rootDir);
registerBundleInspectionCommands(program, ctx.rootDir, ctx.defaultBundleRegistryPath, ctx.readJsonFile);
registerSystemCommands(program, ctx);
registerBundleCommands(program, ctx);
registerProjectCommands(program, ctx);
registerStorageCommands(program, ctx);
registerRunsCommands(program, ctx);
registerApprovalsCommands(program, ctx);
registerLearningCommands(program, ctx);
registerLocalLlmCommands(program, ctx);
registerServerCommands(program, ctx);
registerContextExtraCommands(program, ctx);
registerDaemonCommands(program, ctx);
registerEvaluationDaemonCommands(program, ctx);

// Import guard: unit tests import pure helpers from this module, which must
// not launch the CLI as a side effect. Only parse argv when this file is the
// process entry point (both `tsx apps/cli/src/index.ts` and the compiled
// dist bin resolve through symlinks, so realpath the entry before comparing).
function isAgentflowMainModule(): boolean {
  if ((import.meta as ImportMeta & { main?: boolean }).main === true) {
    return true;
  }
  try {
    const entry = process.argv[1];
    if (!entry) {
      return false;
    }
    return fsSync.realpathSync(path.resolve(entry)) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isAgentflowMainModule()) {
  program.parseAsync(process.argv).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
