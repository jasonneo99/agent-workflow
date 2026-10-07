import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
    "./blocked-run-supersession.ts",
    "./codex-callback.ts",
    "./commands/accepted-outcomes.ts",
    "./commands/approvals.ts",
    "./commands/bundle-inspection.ts",
    "./commands/bundle.ts",
    "./commands/context-extra.ts",
    "./commands/context-thresholds.ts",
    "./commands/context.ts",
    "./commands/daemon.ts",
    "./commands/learning.ts",
    "./commands/local-llm.ts",
    "./commands/project.ts",
    "./commands/repository-maintenance.ts",
    "./commands/runs.ts",
    "./commands/server.ts",
    "./commands/storage.ts",
    "./commands/system.ts",
    "./commands/validate.ts",
    "./concurrency.ts",
    "./dashboard/anthropic-provider.ts",
    "./dashboard/codex-provider.ts",
    "./dashboard/daemon-control.ts",
    "./dashboard/daemon-settings.ts",
    "./dashboard/home-metrics.ts",
    "./dashboard/human-intervention.ts",
    "./dashboard/icons.ts",
    "./dashboard/learning-loop.ts",
    "./dashboard/outcome-accuracy.ts",
    "./dashboard/project-identity.ts",
    "./dashboard/question-chat.ts",
    "./dashboard/run-eta.ts",
    "./dashboard/security.ts",
    "./dashboard/studio.ts",
    "./dashboard/styles.ts",
    "./dashboard/training-projects.ts",
    "./index.ts",
    "./learning/learning-loop-command.ts",
    "./learning/learning-loop-daemon.ts",
    "./learning/model-routing-optimizer.ts",
    "./learning/peer-exchange-provider.ts",
    "./lib/builders-approvals.ts",
    "./lib/builders-bundle.ts",
    "./lib/builders-context.ts",
    "./lib/builders-learning.ts",
    "./lib/builders-local-llm.ts",
    "./lib/builders-project.ts",
    "./lib/builders-runs.ts",
    "./lib/builders-server.ts",
    "./lib/builders-shared.ts",
    "./lib/builders-storage.ts",
    "./lib/builders-system.ts",
    "./lib/cli-types.ts",
    "./lib/context.ts",
    "./numeric-options.ts",
    "./object-artifact-parsing.ts",
    "./onboarding-detection.ts",
    "./onboarding-recommendations.ts",
    "./orchestration-plan.ts",
    "./reference-resolution.ts",
    "./reliability-command.ts",
    "./run-outcome.ts",
    "./run-recommendation.ts",
    "./setup.ts",
    "./training-holdout-runner.ts",
    "./worker-provider-capabilities.ts",
    "./workflow-supervision.ts",
  ].map((p) => {
    try {
      return readFileSync(new URL(p, import.meta.url), "utf8");
    } catch {
      return "";
    }
  }).join("\n");

test("blocked queue items expose a governed repair action", () => {
  assert.match(source, /queueRunActionForm\(item\.runId, "resolve-blocker", "Resolve blocker"\)/u);
  assert.match(source, /queueRunActionForm\(item\.runId, "repair-blocked", "Diagnose as New Run"\)/u);
  assert.match(source, /if \(action === "resolve-blocker"\)/u);
  assert.match(source, /Blocker resolved and workflow resumed/u);
  assert.match(source, /if \(action === "repair-blocked"\)/u);
  assert.match(source, /indexProjectForRun\(ctx, \{ projectDir, maxFiles: 180/u);
  assert.match(source, /workflowId: "debug-failure"/u);
  assert.match(source, /actionType: "blocked_run_repair_queued"/u);
});

test("blocked repair preserves governance and truthful terminal semantics", () => {
  assert.match(source, /preserve the original task boundaries/u);
  assert.match(source, /report blocked rather than completed if a real approval/u);
  assert.match(source, /registeredProjectRootUri: details\.run\.projectRootUri/u);
  assert.match(source, /includeExactSourceExcerpts: true/u);
});

test("learning daemon supervises recent delivery failures without expanding policy", () => {
  assert.match(source, /autoRepairOneWorkflowRun\(target\.projectDir, target\.mode\)/u);
  assert.match(source, /requeueExpiredWorkflowTaskLeases\(\{/u);
  assert.match(source, /mode !== "apply-approved"/u);
  assert.match(source, /isWithinAutomaticWorkflowRepairWindow\(repairReferenceTime\)/u);
  assert.match(source, /approvals\.some\(isOpenApproval\)/u);
  assert.match(source, /missingExistingEvidence/u);
  assert.match(source, /workflowDeliveryRepairReason\(run, outputs\)/u);
  assert.match(source, /findSupersedingDeliveryReceipt\(run\.task, deliveryReceipts\)/u);
  assert.match(source, /!item\.dismissed/u);
  assert.match(source, /workflow_supervisor_repair_suppressed/u);
  // The daemon must use the claimed outbox, not the legacy direct-send path.
  assert.match(source, /deliverRunNotifications\(targetProjectDir\)/u);
  assert.doesNotMatch(source, /await notifyOriginatingCodexTask\(/u);
  assert.match(source, /CODEX_CALLBACK_RECEIPT/u);
  assert.match(source, /source: "workflow-supervisor-repair"/u);
  assert.match(source, /do not edit policy to grant yourself authority/u);
  assert.match(source, /preferImplementationSources: true/u);
});

test("learning diagnostics exposes direct blocker resolution", () => {
  assert.match(source, /failedRunRows[\s\S]{0,800}resolve-blocker[\s\S]{0,200}Resolve Blocker/u);
  assert.match(source, /<h2>Recent Failed Runs<\/h2>/u);
  assert.match(source, /resume the same durable run without creating a repair chain/u);
});
