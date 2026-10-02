import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
    "../blocked-run-supersession.ts",
    "../codex-callback.ts",
    "../commands/accepted-outcomes.ts",
    "../commands/approvals.ts",
    "../commands/bundle-inspection.ts",
    "../commands/bundle.ts",
    "../commands/context-extra.ts",
    "../commands/context-thresholds.ts",
    "../commands/context.ts",
    "../commands/daemon.ts",
    "../commands/learning.ts",
    "../commands/local-llm.ts",
    "../commands/project.ts",
    "../commands/repository-maintenance.ts",
    "../commands/runs.ts",
    "../commands/server.ts",
    "../commands/storage.ts",
    "../commands/system.ts",
    "../commands/validate.ts",
    "../concurrency.ts",
    "../dashboard/anthropic-provider.ts",
    "../dashboard/codex-provider.ts",
    "../dashboard/daemon-control.ts",
    "../dashboard/daemon-settings.ts",
    "../dashboard/home-metrics.ts",
    "../dashboard/human-intervention.ts",
    "../dashboard/icons.ts",
    "../dashboard/learning-loop.ts",
    "../dashboard/outcome-accuracy.ts",
    "../dashboard/project-identity.ts",
    "../dashboard/question-chat.ts",
    "../dashboard/run-eta.ts",
    "../dashboard/security.ts",
    "../dashboard/studio.ts",
    "../dashboard/styles.ts",
    "../dashboard/training-projects.ts",
    "../index.ts",
    "../learning/learning-loop-command.ts",
    "../learning/learning-loop-daemon.ts",
    "../learning/model-routing-optimizer.ts",
    "../learning/peer-exchange-provider.ts",
    "../lib/builders-approvals.ts",
    "../lib/builders-bundle.ts",
    "../lib/builders-context.ts",
    "../lib/builders-learning.ts",
    "../lib/builders-local-llm.ts",
    "../lib/builders-project.ts",
    "../lib/builders-runs.ts",
    "../lib/builders-server.ts",
    "../lib/builders-shared.ts",
    "../lib/builders-storage.ts",
    "../lib/builders-system.ts",
    "../lib/cli-types.ts",
    "../lib/context.ts",
    "../numeric-options.ts",
    "../object-artifact-parsing.ts",
    "../onboarding-detection.ts",
    "../onboarding-recommendations.ts",
    "../orchestration-plan.ts",
    "../reference-resolution.ts",
    "../reliability-command.ts",
    "../run-outcome.ts",
    "../run-recommendation.ts",
    "../setup.ts",
    "../training-holdout-runner.ts",
    "../worker-provider-capabilities.ts",
    "../workflow-supervision.ts",
  ].map((p) => {
    try {
      return readFileSync(new URL(p, import.meta.url), "utf8");
    } catch {
      return "";
    }
  }).join("\n");

test("training proposal actions launch linked evaluations and advance only from generated evidence", () => {
  const actions = source.slice(source.indexOf("function renderTrainingProposalActions"));
  assert.match(actions, /item\.status === "pending"[\s\S]+Approve evaluation/u);
  assert.match(actions, /item\.status === "approved"[\s\S]+Run evaluation/u);
  assert.match(actions, /evaluation\.status === "completed"[\s\S]+Accept evaluation result/u);
  assert.match(actions, /Evaluation in progress/u);
  assert.match(actions, /Retry evaluation/u);
  assert.match(actions, /A completed recovery does not replace a missing evaluation verdict/u);
  assert.match(actions, /successful recovery follow-up only proves the recovery workflow completed/u);
  assert.match(actions, /item\.status === "evaluated"[\s\S]+not promotion eligible[\s\S]+Record promotion decision/u);
  assert.match(actions, /item\.status === "promoted"[\s\S]+No further inbox action is required/u);
  assert.doesNotMatch(actions.slice(actions.indexOf('item.status === "approved"'), actions.indexOf('item.status === "evaluated"')), /Approve evaluation/u);
});

test("repeated training proposal decisions report a no-op instead of pretending to change state", () => {
  assert.match(source, /current\?\.status === status[\s\S]+No state change was needed/u);
});

test("evaluated status requires a completed linked run and derives its note from artifacts", () => {
  assert.match(source, /status === "evaluated"[\s\S]+linked approved evaluation run is required/u);
  assert.match(source, /details\.run\?\.status !== "completed"/u);
  assert.match(source, /Accepted completed evaluation run/u);
});

test("promotion requires a PASS verdict and non-pass evidence stays reviewable", () => {
  assert.match(source, /trainingEvaluationVerdict\(summary\) !== "PASS"/u);
  assert.match(source, /Only a PASS evaluation is eligible for promotion/u);
  assert.match(source, /View evaluation run/u);
  assert.match(source, /Measured evidence JSON/u);
  assert.match(source, /\/api\/training-holdout-evidence/u);
});

test("training evaluation queueing seeds the exact workflow snapshot before creating the run", () => {
  assert.match(source, /resolveWorkflow\(await loadWorkflows\(ctx\.rootDir\), "training-evaluation"\)/u);
  assert.match(source, /workflowOverride: trainingWorkflow/u);
});
