import { createHash } from "node:crypto";
import type { StageExecutionInput } from "../../model-providers/src/types.js";

type StagePattern = NonNullable<StageExecutionInput["stagePattern"]>;

export function actionIdempotencyKey(input: { taskId: string; stageId: string; agentId: string; actionType: string; target: string; payload: string; normalizePayload?: boolean }): string {
  const payload = input.normalizePayload ? normalize(input.payload) : input.payload;
  return createHash("sha256").update(JSON.stringify({ taskId: input.taskId, stageId: input.stageId, agentId: input.agentId, actionType: input.actionType, target: normalize(input.target), payloadHash: createHash("sha256").update(payload).digest("hex") })).digest("hex");
}

export function buildBoundedReactLoopReceiptContent(input: {
  task: { runId: string; taskId: string; workflowId: string; workflowTask: string; stageId: string; stageGoal: string; agentId: string };
  stagePattern: StagePattern; iteration: number; totalRequestedActions: number; actionType: "local_command" | "file_write" | "file_read"; target: string; payloadHash: string;
  policyDecision: Record<string, unknown>; resultReceipt: Record<string, unknown>;
}): Record<string, unknown> {
  const maxIterations = input.stagePattern.maxIterations ?? Math.max(input.totalRequestedActions, 1);
  const overBudget = input.iteration > maxIterations;
  const stopReason = overBudget ? "max_iterations_exceeded" : input.iteration >= input.totalRequestedActions ? "provider_returned_no_more_actions" : "next_action_requested";
  return {
    kind: "agentflow_bounded_react_loop_receipt", workflowId: input.task.workflowId, stageId: input.task.stageId, taskId: input.task.taskId,
    agentId: input.task.agentId, goal: input.task.stageGoal || input.task.workflowTask, observationSource: "compiled_brief_and_prior_stage_receipts",
    iteration: input.iteration, maxIterations, overBudget,
    actionRequested: { type: input.actionType, target: input.target, payloadHash: input.payloadHash }, policyDecision: input.policyDecision,
    resultReceipt: input.resultReceipt, stopReason, configuredStopConditions: input.stagePattern.stopConditions,
    promotionGate: input.stagePattern.promotionGate, verifierRequired: input.stagePattern.requiresVerifier
  };
}

function normalize(value: string): string { return value.trim().replace(/\s+/g, " "); }
