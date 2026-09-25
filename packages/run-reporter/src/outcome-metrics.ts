import type { ArtifactStatus } from "../../storage/src/postgres.js";
import { estimateModelCost, modelPricingFromEnv } from "../../fleet-model-gateway/src/index.js";

export interface AcceptedWorkflowOutcome {
  accepted: boolean;
  measuredInputTokens: number;
  measuredFrontierInputTokens: number;
  measuredCostUsd: number | null;
  tokenCoverageStages: number;
  costCoverageStages: number;
  routedStages: number;
  measurementStatus: "measured" | "partial" | "unavailable";
}

export interface AcceptedWorkflowOutcomeReport {
  acceptedWorkflows: number;
  measuredAcceptedWorkflows: number;
  totalFrontierInputTokens: number;
  averageFrontierInputTokensPerAcceptedWorkflow: number | null;
  totalMeasuredCostUsd: number | null;
  averageMeasuredCostPerAcceptedWorkflowUsd: number | null;
  routedStages: number;
  tokenCoverageStages: number;
  costCoverageStages: number;
  tokenCoveragePercent: number | null;
  costCoveragePercent: number | null;
}

export function buildAcceptedWorkflowOutcome(input: { accepted: boolean; routeArtifacts: ArtifactStatus[] }): AcceptedWorkflowOutcome {
  let measuredInputTokens = 0;
  let measuredFrontierInputTokens = 0;
  let measuredCostUsd = 0;
  let tokenCoverageStages = 0;
  let costCoverageStages = 0;
  for (const artifact of input.routeArtifacts) {
    const route = objectValue(artifact.content.route);
    const usage = objectValue(artifact.content.usage);
    const inputTokens = finiteNumber(usage.inputTokens);
    const costUsd = finiteNumber(usage.costUsd) ?? estimateArtifactCost(artifact, route, usage);
    if (inputTokens !== null) {
      measuredInputTokens += inputTokens;
      tokenCoverageStages += 1;
      if (isFrontierRoute(route)) measuredFrontierInputTokens += inputTokens;
    }
    if (costUsd !== null) { measuredCostUsd += costUsd; costCoverageStages += 1; }
  }
  const routedStages = input.routeArtifacts.length;
  const measurementStatus = tokenCoverageStages === 0 ? "unavailable" : tokenCoverageStages === routedStages ? "measured" : "partial";
  return { accepted: input.accepted, measuredInputTokens, measuredFrontierInputTokens, measuredCostUsd: costCoverageStages ? round(measuredCostUsd) : null, tokenCoverageStages, costCoverageStages, routedStages, measurementStatus };
}

function estimateArtifactCost(artifact: ArtifactStatus, route: Record<string, unknown>, usage: Record<string, unknown>): number | null {
  const inputTokens = finiteNumber(usage.inputTokens);
  const outputTokens = finiteNumber(usage.outputTokens);
  if (inputTokens === null && outputTokens === null) return null;
  const model = stringValue(artifact.content.actualModel) ?? stringValue(route.model) ?? stringValue(route.modelId);
  if (!model) return null;
  return estimateModelCost({
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: finiteNumber(usage.cachedInputTokens) ?? 0,
    reasoningTokens: finiteNumber(usage.reasoningTokens) ?? 0,
    outputTokens: outputTokens ?? 0,
    totalTokens: finiteNumber(usage.totalTokens) ?? ((inputTokens ?? 0) + (outputTokens ?? 0))
  }, model, modelPricingFromEnv()) ?? null;
}

export function buildAcceptedWorkflowOutcomeReport(outcomes: AcceptedWorkflowOutcome[]): AcceptedWorkflowOutcomeReport {
  const accepted = outcomes.filter((item) => item.accepted);
  const measured = accepted.filter((item) => item.tokenCoverageStages > 0);
  const costMeasured = accepted.filter((item) => item.measuredCostUsd !== null);
  const totalFrontierInputTokens = measured.reduce((sum, item) => sum + item.measuredFrontierInputTokens, 0);
  const totalMeasuredCostUsd = costMeasured.length ? round(costMeasured.reduce((sum, item) => sum + (item.measuredCostUsd ?? 0), 0)) : null;
  const routedStages = accepted.reduce((sum, item) => sum + item.routedStages, 0);
  const tokenCoverageStages = accepted.reduce((sum, item) => sum + item.tokenCoverageStages, 0);
  const costCoverageStages = accepted.reduce((sum, item) => sum + item.costCoverageStages, 0);
  return {
    acceptedWorkflows: accepted.length,
    measuredAcceptedWorkflows: measured.length,
    totalFrontierInputTokens,
    averageFrontierInputTokensPerAcceptedWorkflow: measured.length ? Math.round(totalFrontierInputTokens / measured.length) : null,
    totalMeasuredCostUsd,
    averageMeasuredCostPerAcceptedWorkflowUsd: costMeasured.length && totalMeasuredCostUsd !== null ? round(totalMeasuredCostUsd / costMeasured.length) : null,
    routedStages,
    tokenCoverageStages,
    costCoverageStages,
    tokenCoveragePercent: routedStages ? round(tokenCoverageStages / routedStages * 100) : null,
    costCoveragePercent: routedStages ? round(costCoverageStages / routedStages * 100) : null
  };
}

function isFrontierRoute(route: Record<string, unknown>): boolean { return route.modelTier === "reasoning" || route.estimatedCostTier === "high"; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
