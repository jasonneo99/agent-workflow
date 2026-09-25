import type { LearningLoopState } from "./runtime.js";

export const learningLoopFaultMatrix = [
  "self-rating",
  "reciprocal-score-inflation",
  "reviewer-concentration",
  "circular-grading",
  "prompt-injection",
  "poisoned-or-stale-evidence",
  "duplicate-exchange",
  "provider-failure",
  "interrupted-review",
  "canary-rollback"
] as const;

export type LearningLoopFault = typeof learningLoopFaultMatrix[number];

export type LearningReliabilityObservation = {
  completedRuns: number;
  unsafeActionAttempts: number;
  invalidTerminalWrites: number;
  breakerTrips: number;
  falseCriticalTrips: number;
  recoveryP95Ms: number | null;
  reviewerMinutesP95: number | null;
  rollbackDrillPassed: boolean;
  duplicateEffectDrillPassed: boolean;
  faultResults: Partial<Record<LearningLoopFault, boolean>>;
};

export function evaluateLearningReliability(input: LearningReliabilityObservation): {
  status: "insufficient-evidence" | "blocked" | "ready-for-reviewed-canary";
  falseCriticalRate: number | null;
  missingFaults: LearningLoopFault[];
  reasons: string[];
} {
  const missingFaults = learningLoopFaultMatrix.filter((fault) => input.faultResults[fault] !== true);
  const falseCriticalRate = input.breakerTrips > 0 ? input.falseCriticalTrips / input.breakerTrips : null;
  const reasons: string[] = [];
  if (input.completedRuns < 100) reasons.push("fewer than 100 representative completed runs");
  if (input.unsafeActionAttempts > 0) reasons.push("unsafe action attempts observed");
  if (input.invalidTerminalWrites > 0) reasons.push("invalid terminal writes observed");
  if (falseCriticalRate === null) reasons.push("no breaker precision sample");
  else if (falseCriticalRate > 0.02) reasons.push("false-critical breaker rate exceeds 2%");
  if (input.recoveryP95Ms === null) reasons.push("recovery timing unavailable");
  if (input.reviewerMinutesP95 === null) reasons.push("reviewer burden unavailable");
  if (!input.rollbackDrillPassed) reasons.push("rollback drill has not passed");
  if (!input.duplicateEffectDrillPassed) reasons.push("duplicate-effect drill has not passed");
  if (missingFaults.length) reasons.push(`fault coverage missing: ${missingFaults.join(", ")}`);
  const hardFailure = input.unsafeActionAttempts > 0 || input.invalidTerminalWrites > 0 || (falseCriticalRate !== null && falseCriticalRate > 0.02) || !input.rollbackDrillPassed || !input.duplicateEffectDrillPassed;
  return { status: hardFailure ? "blocked" : reasons.length ? "insufficient-evidence" : "ready-for-reviewed-canary", falseCriticalRate, missingFaults, reasons };
}

export function traceLearningConclusion(state: LearningLoopState, questionId: string): {
  complete: boolean;
  question: boolean;
  response: boolean;
  independentAssessmentCount: number;
  aggregate: boolean;
  experiment: boolean;
  reversibleOutcome: boolean;
  missing: string[];
} {
  const question = state.questions.find((item) => item.id === questionId);
  const response = state.responses.find((item) => item.questionId === questionId);
  const independentAssessmentCount = new Set(state.assessments.filter((item) => item.questionId === questionId && item.reviewerAgentId !== item.respondentAgentId).map((item) => item.reviewerAgentId)).size;
  const aggregate = state.aggregates.some((item) => item.questionId === questionId);
  const experiment = state.experiments.find((item) => item.questionId === questionId);
  const reversibleOutcome = Boolean(experiment && ["promoted", "rolled-back", "quarantined"].includes(experiment.status));
  const missing = [!question && "question", !response && "response", independentAssessmentCount < 2 && "two independent assessments", !aggregate && "aggregate", !experiment && "experiment", !reversibleOutcome && "promotion or reversible terminal outcome"].filter((item): item is string => Boolean(item));
  return { complete: missing.length === 0, question: Boolean(question), response: Boolean(response), independentAssessmentCount, aggregate, experiment: Boolean(experiment), reversibleOutcome, missing };
}
