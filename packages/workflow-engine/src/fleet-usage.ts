import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { estimateModelCost, importFleetUsageReceipts, modelPricingFromEnv, type FleetUsageReceipt } from "../../fleet-model-gateway/src/index.js";
import type { ProviderFallbackAttempt } from "../../model-providers/src/fallback.js";
import type { StageExecutionInput, StageExecutionOutput } from "../../model-providers/src/types.js";

type DirectUsageInput = {
  stage: StageExecutionInput;
  attempts: ProviderFallbackAttempt[];
  output?: StageExecutionOutput;
  latencyMs: number;
};

export async function recordDirectProviderUsage(input: DirectUsageInput): Promise<number> {
  if (process.env.AGENTFLOW_FLEET_USAGE_DIRECT === "false") return 0;
  const ledgerPath = process.env.AGENTFLOW_FLEET_USAGE_LEDGER ?? path.resolve(".agent-workflow/runtime/fleet-model-usage.jsonl");
  let completedIndex = -1;
  for (let index = input.attempts.length - 1; index >= 0; index -= 1) {
    if (input.attempts[index]?.outcome === "completed") { completedIndex = index; break; }
  }
  const usage = normalizeUsage(input.output?.usage);
  const pricing = modelPricingFromEnv();
  const receipts = input.attempts.filter((attempt) => attempt.outcome !== "skipped").map((attempt, index): FleetUsageReceipt => {
    const measured = index === completedIndex && Boolean(input.output?.usage);
    const measuredUsage = measured ? usage : emptyUsage();
    const model = attempt.model ?? (measured && typeof input.output?.artifact?.model === "string" ? input.output.artifact.model : undefined);
    const estimatedCostUsd = measured ? input.output?.usage?.costUsd ?? estimateModelCost(measuredUsage, model, pricing) : undefined;
    return {
      version: 1,
      id: `direct:${attempt.attemptId}`,
      observedAt: new Date().toISOString(),
      clientId: process.env.AGENTFLOW_FLEET_CLIENT_ID?.trim() || os.hostname(),
      projectId: createHash("sha256").update(input.stage.projectConfig.project.name).digest("hex").slice(0, 16),
      workflowId: input.stage.workflowId,
      runId: input.stage.runId,
      stageId: input.stage.stageId,
      provider: attempt.provider,
      ...(model ? { model } : {}),
      ...measuredUsage,
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      latencyMs: index === completedIndex || index === input.attempts.length - 1 ? input.latencyMs : 0,
      status: attempt.outcome === "completed" ? "completed" : "failed",
      requestHash: createHash("sha256").update(attempt.attemptId).update(input.stage.runId).update(input.stage.taskId).digest("hex")
    };
  });
  return importFleetUsageReceipts(ledgerPath, receipts);
}

function normalizeUsage(usage: StageExecutionOutput["usage"]): Pick<FleetUsageReceipt, "inputTokens" | "cachedInputTokens" | "reasoningTokens" | "outputTokens" | "totalTokens"> {
  const inputTokens = finiteToken(usage?.inputTokens);
  const outputTokens = finiteToken(usage?.outputTokens);
  return { inputTokens, cachedInputTokens: 0, reasoningTokens: 0, outputTokens, totalTokens: finiteToken(usage?.totalTokens) || inputTokens + outputTokens };
}

function emptyUsage(): ReturnType<typeof normalizeUsage> { return { inputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, outputTokens: 0, totalTokens: 0 }; }
function finiteToken(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
