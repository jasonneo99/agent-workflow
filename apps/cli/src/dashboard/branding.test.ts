import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
const styles = readFileSync(new URL("./styles.ts", import.meta.url), "utf8");

test("dashboard serves and renders the Agent Workflow brand assets", () => {
  assert.match(source, /\/assets\/agent-workflow-logo\.png/);
  assert.match(source, /\/assets\/agent-workflow-mark\.png/);
  assert.match(source, /\/assets\/agent-workflow-favicon\.png/);
  assert.match(source, /class="nav-brand-link"/);
  assert.match(source, /aria-label="Agent Workflow home"/);
  assert.match(styles, /\.nav-brand-link img/);
});

test("committed brand assets are available to packaged documentation", () => {
  const brandingDir = new URL("../../../../docs/assets/branding/", import.meta.url);
  for (const name of ["agent-workflow-logo-v1.png", "agent-workflow-mark-v1.png", "agent-workflow-favicon-v1.png"]) {
    assert.equal(existsSync(new URL(name, brandingDir)), true, `${name} should exist`);
  }
});
