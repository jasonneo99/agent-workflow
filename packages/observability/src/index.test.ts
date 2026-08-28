import assert from "node:assert/strict";
import test from "node:test";
import { buildObservabilityReport } from "./index.js";
import type { ArtifactStatus, WorkflowRunStatus, WorkflowTaskStatus } from "../../storage/src/postgres.js";

const run: WorkflowRunStatus = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "completed",
  workflowId: "review-pr",
  task: "Review the diff",
  autonomy: "2",
  policyProfile: "local",
  policySnapshotHash: "policy-hash",
  modelTierOverride: null,
  providerOverride: null,
  evaluationMetadata: {},
  projectName: "Example",
  projectRootUri: "/repo",
  startedAt: "2026-08-28T10:00:00.000Z",
  finishedAt: "2026-08-28T10:00:05.000Z"
};

const tasks: WorkflowTaskStatus[] = [{
  id: "22222222-2222-4222-8222-222222222222",
  stageId: "inspect",
  agentId: "technical-architect",
  status: "completed",
  attempts: 1,
  startedAt: "2026-08-28T10:00:01.000Z",
  finishedAt: "2026-08-28T10:00:04.000Z"
}];

const artifacts: ArtifactStatus[] = [
  {
    id: "artifact-compiled",
    runId: run.id,
    taskId: null,
    kind: "compiled_brief",
    uri: "db://compiled",
    content: { text: "compiled context" },
    createdAt: "2026-08-28T10:00:00.500Z"
  },
  {
    id: "artifact-route",
    runId: run.id,
    taskId: tasks[0].id,
    kind: "model_route",
    uri: "db://model-route",
    content: {
      route: {
        providerId: "openai",
        modelTier: "standard",
        requestedModelTier: "standard",
        estimatedCostTier: "medium"
      },
      quality: { score: 0.82, passed: true },
      fallbackUsed: false,
      latencyMs: 1200,
      stageId: "inspect",
      agentId: "technical-architect"
    },
    createdAt: "2026-08-28T10:00:03.000Z"
  }
];

test("observability report exports OpenTelemetry compatible spans and metrics", () => {
  const report = buildObservabilityReport({
    run,
    tasks,
    receipts: [{
      id: "receipt-1",
      agentId: "technical-architect",
      actionType: "stage_completed",
      target: tasks[0].id,
      summary: "Finished inspect stage",
      createdAt: "2026-08-28T10:00:04.000Z"
    }],
    artifacts,
    version: "0.2.1"
  });

  const spans = report.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
  const metrics = report.resourceMetrics.flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
  assert.equal(report.summary.payloadsExported, false);
  assert.equal(report.summary.queueDelayMs, 1000);
  assert.equal(report.summary.averageQuality, 0.82);
  assert.ok(spans.some((span) => span.name === "agentflow.run review-pr"));
  assert.ok(spans.some((span) => span.name === "agentflow.stage inspect"));
  assert.ok(spans.some((span) => span.name === "agentflow.model.route"));
  assert.ok(metrics.some((metric) => metric.name === "agentflow.model.latency.total"));
});

test("observability attributes redact common secret shapes", () => {
  const report = buildObservabilityReport({
    run,
    tasks,
    receipts: [{
      id: "receipt-secret",
      agentId: "technical-architect",
      actionType: "local_command",
      target: "curl -H 'Authorization: Bearer sk-proj-secretsecretsecret' https://example.test?token=abc123",
      summary: "Ran command with api_key=abc123",
      createdAt: "2026-08-28T10:00:04.000Z"
    }],
    artifacts: [
      ...artifacts,
      {
        id: "artifact-command",
        runId: run.id,
        taskId: tasks[0].id,
        kind: "command_output",
        uri: "db://command",
        content: {
          commandLine: "AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF curl -H 'Authorization: Bearer sk-proj-secretsecretsecret' https://example.test?token=abc123",
          exitCode: 0,
          durationMs: 10
        },
        createdAt: "2026-08-28T10:00:04.000Z"
      }
    ],
    version: "0.2.1"
  });

  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes("sk-proj-secretsecretsecret"), false);
  assert.equal(encoded.includes("AKIA1234567890ABCDEF"), false);
  assert.equal(encoded.includes("token=abc123"), false);
  assert.match(encoded, /\[redacted-token\]/);
  assert.match(encoded, /\[redacted-aws-key\]/);
});
