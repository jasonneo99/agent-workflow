export interface OutcomeAccuracyRun {
  status: string;
  totalStages: number;
  routedStages: number;
  fallbackCount: number;
  averageQuality: number | null;
  feedback: { latest: { rating: "accepted" | "revised" | "rejected" } | null };
}

export interface OutcomeAccuracyReport {
  runs: number;
  completed: number;
  completionRate: number;
  rated: number;
  feedbackCoverage: number;
  accepted: number;
  revised: number;
  rejected: number;
  expectedResultRate: number | null;
  firstPassAccepted: number;
  firstPassRate: number | null;
  missingOutcomeEvidence: number;
  qualityMismatch: number;
  fallbackRuns: number;
}

export interface OutcomeAccuracyGroupMetrics {
  outcomeAccuracy?: number | null;
  calibratedQuality?: number | null;
  feedbackCoverage?: number;
  latencyBudgetMs?: number;
  latencyBudgetPassed?: boolean | null;
  feedbackRequested?: boolean;
}

export function buildOutcomeAccuracyReport(runs: OutcomeAccuracyRun[]): OutcomeAccuracyReport {
  const completed = runs.filter((run) => run.status === "completed");
  const rated = runs.filter((run) => run.feedback.latest !== null);
  const accepted = rated.filter((run) => run.feedback.latest?.rating === "accepted");
  const revised = rated.filter((run) => run.feedback.latest?.rating === "revised");
  const rejected = rated.filter((run) => run.feedback.latest?.rating === "rejected");
  const firstPassAccepted = accepted.filter((run) => run.fallbackCount === 0).length;
  return {
    runs: runs.length,
    completed: completed.length,
    completionRate: ratio(completed.length, runs.length),
    rated: rated.length,
    feedbackCoverage: ratio(rated.length, runs.length),
    accepted: accepted.length,
    revised: revised.length,
    rejected: rejected.length,
    expectedResultRate: rated.length ? ratio(accepted.length, rated.length) : null,
    firstPassAccepted,
    firstPassRate: accepted.length ? ratio(firstPassAccepted, accepted.length) : null,
    missingOutcomeEvidence: completed.filter((run) => run.feedback.latest === null).length,
    qualityMismatch: [...revised, ...rejected].filter((run) => (run.averageQuality ?? 0) >= 0.75).length,
    fallbackRuns: runs.filter((run) => run.fallbackCount > 0).length
  };
}

export function calibratedOutcomeScore(input: { accepted: number; revised: number; rejected: number; averageQuality: number | null }): number | null {
  const rated = input.accepted + input.revised + input.rejected;
  if (!rated) return input.averageQuality;
  const outcomeScore = (input.accepted + input.revised * 0.5) / rated;
  return round(input.averageQuality === null ? outcomeScore : outcomeScore * 0.8 + input.averageQuality * 0.2);
}

export function latencyBudgetMs(input: { workflowId: string; stageId: string; agentId: string; modelTier: string }): number {
  if (input.workflowId === "provider-smoke" || input.agentId === "task-triager") return 8_000;
  if (input.agentId === "pr-preparer" || /final|package|release/u.test(input.stageId)) return 20_000;
  if (input.agentId === "implementation-agent") return 180_000;
  if (input.modelTier === "reasoning") return 45_000;
  if (input.modelTier === "fast") return 15_000;
  return 30_000;
}

export function buildOutcomeAccuracyGroupMetrics(input: {
  workflowId: string; stageId: string; agentId: string; modelTier: string;
  runs: number; accepted: number; revised: number; rejected: number;
  fallbackRate: number; averageQuality: number | null; averageLatencyMs: number | null;
}): Required<OutcomeAccuracyGroupMetrics> {
  const rated = input.accepted + input.revised + input.rejected;
  const budget = latencyBudgetMs(input);
  return {
    outcomeAccuracy: rated ? round(input.accepted / rated) : null,
    calibratedQuality: calibratedOutcomeScore({ accepted: input.accepted, revised: input.revised, rejected: input.rejected, averageQuality: input.averageQuality }),
    feedbackCoverage: round(rated / Math.max(1, input.runs)),
    latencyBudgetMs: budget,
    latencyBudgetPassed: input.averageLatencyMs === null ? null : input.averageLatencyMs <= budget,
    feedbackRequested: rated === 0 || input.fallbackRate > 0 || (input.averageLatencyMs ?? 0) > budget || (input.averageQuality ?? 1) < 0.75
  };
}

function ratio(numerator: number, denominator: number): number { return denominator ? round(numerator / denominator) : 0; }
function round(value: number): number { return Math.round(value * 1000) / 1000; }
