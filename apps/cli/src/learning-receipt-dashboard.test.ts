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

test("learning receipt compaction reports both mutation and clean no-op outcomes", () => {
  assert.match(source, /const result = await compactLearningActionReceiptFiles\(projectDir\)/u);
  assert.match(source, /Compacted \$\{result\.removedReceipts\} duplicate daemon-owned receipt/u);
  assert.match(source, /Receipt health is already clean; no duplicate daemon-owned receipts were removed\./u);
});

test("clean receipt health is rendered as a non-actionable state", () => {
  assert.match(source, /Receipt health is already clean; there are no duplicate daemon-owned receipts to compact\./u);
  assert.match(source, /clean \? "Receipts already compact" : "Compact daemon-owned receipts"/u);
});
