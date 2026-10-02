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

test("server orchestration accepts one goal and queues one dynamic lifecycle", () => {
  assert.match(source, /request\.method === "POST" && requestUrl\.pathname === "\/api\/server-orchestrations"/u);
  assert.match(source, /constructDynamicWorkflow\(\{ goal, project/u);
  assert.match(source, /seedRegistry\(\[\], \[\{ path: `runtime\/\$\{workflow\.id\}\.yaml`, value: workflow \}\]\)/u);
  assert.match(source, /registeredProjectRootUri: summary\.rootUri/u);
  assert.match(source, /projectRootUri: input\.registeredProjectRootUri \?\? projectDir/u);
  assert.match(source, /actionType: "server_orchestration_requested"/u);
  assert.match(source, /source: "server-orchestration"/u);
  assert.match(source, /executionProfile: "adaptive"/u);
});

test("legacy server queue requests default to adaptive execution", () => {
  assert.match(source, /const requestedExecutionProfile = stringValue\(payload\.executionProfile\) === "full" \? "full" : "adaptive"/u);
  assert.match(source, /workflowOverride: adaptiveWorkflow \?\? undefined/u);
  assert.match(source, /requestedWorkflowId: routePreview\.route\.workflowId/u);
});

test("orchestration status propagates blocked runs to the aggregate", () => {
  assert.match(source, /statuses\.includes\("blocked"\) \? "blocked"/u);
  assert.match(source, /\/api\/server-orchestration-status/u);
  assert.match(source, /progress: ServerOrchestrationStatusReport\["progress"\]/u);
  assert.match(source, /pendingApprovals/u);
  assert.match(source, /approvals: openApprovals\.slice\(0, 20\)/u);
  assert.match(source, /allowedDecisions: \["approve", "approve-and-execute", "reject"\]/u);
  assert.match(source, /actionEndpoint: "\/api\/server-approval-action"/u);
  assert.match(source, /approvals: openApprovals\.slice\(0, 20\)/u);
  assert.match(source, /allowedDecisions: \["approve", "approve-and-execute", "reject"\]/u);
  assert.match(source, /actionEndpoint: "\/api\/server-approval-action"/u);
  assert.match(source, /result = serverOrchestrationStatusIsTerminal\(status\)/u);
  assert.match(source, /eta: AggregateRunEta/u);
  assert.match(source, /aggregateRunEtas\(runs\.map/u);
});

test("orchestration exposes bounded authenticated progress events", () => {
  assert.match(source, /requestUrl\.pathname === "\/api\/server-orchestration-events"/u);
  assert.match(source, /"content-type": "text\/event-stream; charset=utf-8"/u);
  assert.match(source, /Date\.now\(\) - startedAt >= 60_000/u);
  assert.match(source, /currentStages: tasks[\s\S]+\.slice\(0, 8\)/u);
  assert.match(source, /links: \{[\s\S]+events: `\/api\/server-orchestration-events/u);
});
