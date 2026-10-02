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

test("workflow graph polling coalesces server loads and rejects overlapping browser polls", () => {
  assert.match(source, /workflow-graph:\$\{requestUrl\.searchParams\.toString\(\)\}[\s\S]+loadDashboardWorkflowGraph\(requestUrl\.searchParams\)[\s\S]+2_000/u);
  assert.match(source, /let pollInFlight = false/u);
  assert.match(source, /if \(paused \|\| document\.hidden \|\| pollInFlight\) return;[\s\S]+pollInFlight = true/u);
  assert.match(source, /finally \{[\s\S]+pollInFlight = false/u);
});

test("dashboard home coalesces expensive run and queue reads", () => {
  assert.match(source, /loadCachedDashboardReport\("dashboard-home:runs:25", \(\) => listWorkflowRuns\(25\), 2_000\)/u);
  assert.match(source, /loadCachedDashboardReport\("dashboard-home:queue:100", \(\) => listWorkflowQueue\(100\), 2_000\)/u);
});

test("frequently polled queue, run, and fleet-health APIs coalesce identical reads", () => {
  assert.match(source, /"server-daemon-fleet-health"[\s\S]+loadServerDaemonFleetHealth\(\)[\s\S]+2_000/u);
  assert.match(source, /loadCachedDashboardReport\("api:runs:50", \(\) => listWorkflowRuns\(50\), 2_000\)/u);
  assert.match(source, /`api:queue:100:\$\{projectRootUri \?\? "all"\}`[\s\S]+listWorkflowQueue\(100, \{ projectRootUri \}\)[\s\S]+2_000/u);
  assert.match(source, /`dashboard:queue:100:\$\{projectRootUri \?\? "all"\}`[\s\S]+listWorkflowQueue\(100, \{ projectRootUri \}\)[\s\S]+2_000/u);
});
