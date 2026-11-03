import { createHash } from "node:crypto";
import { recordRunAction, type ClaimedWorkflowTask } from "../../storage/src/postgres.js";
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

export async function recordBoundedReactLoopReceipt(input: {
  task: Pick<ClaimedWorkflowTask, "runId" | "taskId" | "workflowId" | "workflowTask" | "stageId" | "stageGoal" | "agentId">;
  stagePattern: StagePattern;
  iteration: number;
  totalRequestedActions: number;
  actionType: "local_command" | "file_write" | "file_read";
  target: string;
  payloadHash: string;
  policyDecision: Record<string, unknown>;
  resultReceipt: Record<string, unknown>;
}): Promise<void> {
  if (input.stagePattern.type !== "react") return;

  const receipt = buildBoundedReactLoopReceiptContent(input);

  await recordRunAction({
    runId: input.task.runId,
    taskId: input.task.taskId,
    agentId: input.task.agentId,
    actionType: "react_loop_step",
    target: `${receipt.workflowId}/${receipt.stageId}#${receipt.iteration}`,
    summary: `ReAct step ${receipt.iteration}/${receipt.maxIterations}: ${input.actionType} ${input.target} -> ${String(input.resultReceipt.status ?? "recorded")}; stop=${receipt.stopReason}.`,
    artifactKind: "react_loop_receipt",
    artifactContent: receipt
  });
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeActionText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
