import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkflowShapeOptimizationReport } from "./index.js";

test("workflow shape optimizer recommends splitting and gating risky stages", () => {
  const report = buildWorkflowShapeOptimizationReport({
    projectRootUri: "/tmp/project",
    workflowId: "build-feature",
    workflowName: "Build Feature",
    generatedAt: "2026-09-02T00:00:00.000Z",
    runsAnalyzed: 4,
    evaluationRuns: 0,
    feedbackCounts: { rejected: 1 },
    projectContext: {
      indexedFiles: 120,
      indexedTokenEstimate: 42_000,
      sourceKinds: { ts: 90, md: 30 }
    },
    stages: [
      {
        id: "plan",
        agentId: "technical-architect",
        order: 0,
        contextMaxTokens: 6000,
        contextLoads: ["architecture_docs"],
        approvalRequired: false,
        subagentCount: 2
      },
      {
        id: "implement",
        agentId: "implementation-agent",
        order: 1,
        contextMaxTokens: 8000,
        contextLoads: ["touched_files"],
        approvalRequired: false,
        subagentCount: 2
      }
    ],
    stageHealth: [
      { stageId: "implement", totalTasks: 4, completedTasks: 2, failedTasks: 2, queuedTasks: 0, runningTasks: 0, cancelledTasks: 0 }
    ],
    scoreGroups: [
      {
        key: "build-feature|implement|implementation-agent|openai|standard",
        workflowId: "build-feature",
        stageId: "implement",
        agentId: "implementation-agent",
        providerId: "openai",
        modelTier: "standard",
        runs: 4,
        accepted: 0,
        revised: 0,
        rejected: 1,
        feedbackScore: -1,
        averageQuality: 0.6,
        fallbackRate: 0.5,
        averageLatencyMs: 50_000,
        recommendation: "Route this stage to a stronger provider."
      }
    ]
  });

  assert.equal(report.kind, "agentflow_workflow_shape_optimization");
  assert.equal(report.ownedLearningFiles.includes(".agent-workflow/learning/workflow-shape-proposals.json"), true);
  assert.equal(report.recommendations.some((item) => item.kind === "split_stage" && item.stageIds.includes("implement")), true);
  assert.equal(report.recommendations.some((item) => item.kind === "gate_stage" && item.stageIds.includes("implement")), true);
  assert.equal(report.recommendations.every((item) => item.preferredScope === "project_overlay" || item.preferredScope === "shared_workflow_review"), true);
  assert.equal(report.recommendations.every((item) => item.approvalRequired), true);
});

test("workflow shape optimizer can suggest new local agent types for missing feedback", () => {
  const report = buildWorkflowShapeOptimizationReport({
    projectRootUri: "/tmp/project",
    workflowId: "review-pr",
    workflowName: "Review PR",
    generatedAt: "2026-09-02T00:00:00.000Z",
    runsAnalyzed: 5,
    evaluationRuns: 0,
    feedbackCounts: {},
    projectContext: {
      indexedFiles: 20,
      indexedTokenEstimate: 8000,
      sourceKinds: { ts: 20 }
    },
    stages: [
      {
        id: "review",
        agentId: "technical-architect",
        order: 0,
        contextMaxTokens: 3000,
        contextLoads: ["diff_summary"],
        approvalRequired: false,
        subagentCount: 0
      },
      {
        id: "final",
        agentId: "pr-preparer",
        order: 1,
        contextMaxTokens: 2500,
        contextLoads: ["review_findings"],
        approvalRequired: false,
        subagentCount: 0
      }
    ],
    stageHealth: [],
    scoreGroups: [
      {
        key: "review-pr|review|technical-architect|openai|standard",
        workflowId: "review-pr",
        stageId: "review",
        agentId: "technical-architect",
        providerId: "openai",
        modelTier: "standard",
        runs: 3,
        accepted: 0,
        revised: 0,
        rejected: 0,
        feedbackScore: 0,
        averageQuality: null,
        fallbackRate: 0,
        averageLatencyMs: null,
        recommendation: "Collect feedback."
      },
      {
        key: "review-pr|final|pr-preparer|openai|fast",
        workflowId: "review-pr",
        stageId: "final",
        agentId: "pr-preparer",
        providerId: "openai",
        modelTier: "fast",
        runs: 3,
        accepted: 0,
        revised: 0,
        rejected: 0,
        feedbackScore: 0,
        averageQuality: null,
        fallbackRate: 0,
        averageLatencyMs: null,
        recommendation: "Collect feedback."
      }
    ]
  });

  const agentType = report.recommendations.find((item) => item.kind === "add_agent_type");
  assert.equal(agentType?.agentTypeId, "feedback-harvester");
  assert.match(agentType?.overlayHint ?? "", /\.agent-workflow\/agents\/feedback-harvester\.yaml/);
});

test("dynamic workflow evidence recommends parallel branches, handoff cleanup, and stronger contracts", () => {
  const report = buildWorkflowShapeOptimizationReport({
    projectRootUri: "/tmp/project",
    workflowId: "dynamic-web-app",
    workflowName: "Dynamic Web App",
    generatedAt: "2026-09-11T00:00:00.000Z",
    runsAnalyzed: 4,
    evaluationRuns: 4,
    feedbackCounts: { accepted: 4 },
    projectContext: { indexedFiles: 30, indexedTokenEstimate: 9000, sourceKinds: { ts: 30 } },
    stages: [
      { id: "frontend", agentId: "frontend-engineer", order: 0, contextMaxTokens: 3000, contextLoads: [], approvalRequired: false, subagentCount: 0, dependsOn: [], acceptanceCriteria: [] },
      { id: "backend", agentId: "backend-engineer", order: 1, contextMaxTokens: 3000, contextLoads: [], approvalRequired: false, subagentCount: 0, dependsOn: [], acceptanceCriteria: ["API contract passes"] },
      { id: "assemble", agentId: "implementation-agent", order: 2, contextMaxTokens: 3000, contextLoads: [], approvalRequired: false, subagentCount: 0, dependsOn: ["frontend", "backend"], acceptanceCriteria: ["build passes"] }
    ],
    stageHealth: [
      { stageId: "frontend", totalTasks: 4, failedTasks: 0 },
      { stageId: "backend", totalTasks: 4, failedTasks: 0 },
      { stageId: "assemble", totalTasks: 4, failedTasks: 0 }
    ],
    scoreGroups: [],
    handoffs: [{ sourceStageId: "frontend", destinationStageId: "assemble", count: 4, retryCount: 0, rejectedCount: 0, averageDurationMs: 1200, artifactCount: 0, contextSummaryPresentRate: 1 }]
  });

  assert.equal(report.recommendations.some((item) => item.kind === "parallelize_stages" && item.stageIds.includes("frontend") && item.stageIds.includes("backend")), true);
  assert.equal(report.recommendations.some((item) => item.kind === "remove_handoff"), true);
  assert.equal(report.recommendations.some((item) => item.kind === "strengthen_acceptance_criteria" && item.stageIds[0] === "frontend"), true);
  assert.equal(report.recommendations.filter((item) => !["tune_routing", "tune_context"].includes(item.kind)).every((item) => item.application === "review_required" && item.approvalRequired), true);
});

test("only explicitly enabled low-risk tuning can be automatically applicable", () => {
  const base = {
    projectRootUri: "/tmp/project",
    workflowId: "dynamic",
    workflowName: "Dynamic",
    generatedAt: "2026-09-11T00:00:00.000Z",
    runsAnalyzed: 3,
    evaluationRuns: 3,
    feedbackCounts: {},
    projectContext: { indexedFiles: 1, indexedTokenEstimate: 100, sourceKinds: { ts: 1 } },
    stages: [{ id: "route", agentId: "implementation-agent", order: 0, contextMaxTokens: 2000, contextLoads: [], approvalRequired: false, subagentCount: 0, acceptanceCriteria: ["done"] }],
    stageHealth: [{ stageId: "route", totalTasks: 3, failedTasks: 0 }],
    scoreGroups: [{ key: "dynamic|route|implementation-agent|a|standard", workflowId: "dynamic", stageId: "route", agentId: "implementation-agent", providerId: "a", modelTier: "standard", runs: 3, accepted: 3, revised: 0, rejected: 0, feedbackScore: 1, averageQuality: 0.9, fallbackRate: 0.75, averageLatencyMs: 1000, recommendation: "route" }]
  };
  const automatic = buildWorkflowShapeOptimizationReport({ ...base, policy: { allowAutomaticLowRiskTuning: true } });
  const reviewed = buildWorkflowShapeOptimizationReport(base);
  assert.equal(automatic.recommendations.find((item) => item.kind === "tune_routing")?.application, "automatic");
  assert.equal(automatic.recommendations.find((item) => item.kind === "tune_routing")?.approvalRequired, false);
  assert.equal(reviewed.recommendations.find((item) => item.kind === "tune_routing")?.application, "review_required");
});
