import type { ArtifactStatus } from "../../storage/src/postgres.js";

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
    const costUsd = finiteNumber(usage.costUsd);
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

export function buildAcceptedWorkflowOutcomeReport(outcomes: AcceptedWorkflowOutcome[]): AcceptedWorkflowOutcomeReport {
  const accepted = outcomes.filter((item) => item.accepted);
  const measured = accepted.filter((item) => item.tokenCoverageStages > 0);
  const costMeasured = accepted.filter((item) => item.measuredCostUsd !== null);
  const totalFrontierInputTokens = measured.reduce((sum, item) => sum + item.measuredFrontierInputTokens, 0);
  const totalMeasuredCostUsd = costMeasured.length ? round(costMeasured.reduce((sum, item) => sum + (item.measuredCostUsd ?? 0), 0)) : null;
  return {
    acceptedWorkflows: accepted.length,
    measuredAcceptedWorkflows: measured.length,
    totalFrontierInputTokens,
    averageFrontierInputTokensPerAcceptedWorkflow: measured.length ? Math.round(totalFrontierInputTokens / measured.length) : null,
    totalMeasuredCostUsd,
    averageMeasuredCostPerAcceptedWorkflowUsd: costMeasured.length && totalMeasuredCostUsd !== null ? round(totalMeasuredCostUsd / costMeasured.length) : null
  };
}

function isFrontierRoute(route: Record<string, unknown>): boolean { return route.modelTier === "reasoning" || route.estimatedCostTier === "high"; }
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function finiteNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
function round(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
