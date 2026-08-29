import assert from "node:assert/strict";
import test from "node:test";
import { appendTuningApprovalHistory, buildModelImprovementPlan, formatTuningApprovalHistory, type TuningApprovalQueue } from "./index.js";

test("tuning history preserves every proposal lifecycle transition", () => {
  const queued = appendTuningApprovalHistory(undefined, {
    projectRootUri: "/project",
    proposalIds: ["tune-001"],
    status: "queued",
    occurredAt: "2026-08-17T10:00:00.000Z"
  });
  const approved = appendTuningApprovalHistory(queued, {
    projectRootUri: "/project",
    proposalIds: ["tune-001"],
    status: "approved",
    actor: "reviewer",
    occurredAt: "2026-08-17T10:01:00.000Z"
  });
  const reverted = appendTuningApprovalHistory(approved, {
    projectRootUri: "/project",
    proposalIds: ["tune-001"],
    status: "reverted",
    note: "quality regression",
    occurredAt: "2026-08-17T10:02:00.000Z"
  });

  assert.deepEqual(reverted.events.map((event) => event.status), ["queued", "approved", "reverted"]);
  assert.match(formatTuningApprovalHistory(reverted), /reverted=1/);
  assert.match(formatTuningApprovalHistory(reverted), /quality regression/);
});

test("tuning history records a superseding proposal relation", () => {
  const history = appendTuningApprovalHistory(undefined, {
    projectRootUri: "/project",
    proposalIds: ["tune-001"],
    status: "superseded",
    relatedProposalId: "tune-004",
    occurredAt: "2026-08-17T10:03:00.000Z"
  });
  assert.equal(history.events[0]?.relatedProposalId, "tune-004");
});

test("model improvement plan uses approved tuning proposals only", () => {
  const queue: TuningApprovalQueue = {
    kind: "agentflow_tuning_approval_queue",
    projectRootUri: "/project",
    generatedAt: "2026-08-17T10:00:00.000Z",
    sourceGeneratedAt: "2026-08-17T09:00:00.000Z",
    sourceRunsAnalyzed: 4,
    skippedIds: [],
    items: [
      {
        id: "approval-001",
        proposalId: "tune-001",
        status: "approved",
        createdAt: "2026-08-17T10:00:00.000Z",
        proposal: {
          id: "tune-001",
          priority: "high",
          kind: "routing_preference",
          workflowId: "review-pr",
          stageId: "specialist-review",
          agentId: "security-reviewer",
          providerId: "openai",
          modelTier: "standard",
          reason: "Fallback rate is 0.5.",
          recommendation: "Route this stage to a stronger provider or higher tier by default.",
          patchHint: "Promote specialist-review after evaluation evidence."
        }
      },
      {
        id: "approval-002",
        proposalId: "tune-002",
        status: "pending",
        createdAt: "2026-08-17T10:00:00.000Z",
        proposal: {
          id: "tune-002",
          priority: "low",
          kind: "feedback_needed",
          workflowId: "review-pr",
          stageId: "final-review",
          agentId: "pr-preparer",
          providerId: "openai",
          modelTier: "fast",
          reason: "No feedback.",
          recommendation: "Collect feedback first.",
          patchHint: "Record accepted, revised, or rejected feedback."
        }
      }
    ]
  };

  const plan = buildModelImprovementPlan(queue);
  assert.deepEqual(plan.selectedIds, ["tune-001"]);
  assert.equal(plan.evalCases.length, 1);
  assert.equal(plan.datasetPlans[0]?.approvalRequired, true);
  assert.deepEqual(plan.files.map((file) => file.relativePath), [
    ".agent-workflow/model-improvement/eval-case-proposals.md",
    ".agent-workflow/model-improvement/provider-dataset-plan.md",
    ".agent-workflow/model-improvement/model-improvement-plan.json"
  ]);
  assert.match(plan.files[0]?.content ?? "", /scrubbed, project-local proposal shapes/);
  assert.match(plan.files[1]?.content ?? "", /No automatic uploads/);
});
