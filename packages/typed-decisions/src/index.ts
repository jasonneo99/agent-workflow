import { createHash } from "node:crypto";

export type DecisionKind = "boolean" | "choice" | "ordinal";
export type CandidateBoundary = "local" | "hosted";

export type DecisionCandidate = {
  id: string;
  publisher: string;
  boundary: CandidateBoundary;
  license: string;
  runtime: string;
  available: boolean;
  provenanceUrl: string;
  updatedAt: string;
};

export type DecisionCase = {
  id: string;
  taskClass: string;
  kind: DecisionKind;
  expected: string | number | boolean;
  options?: string[];
  risk: "low" | "medium" | "high";
};

export type DecisionObservation = {
  caseId: string;
  candidateId: string;
  answer?: string | number | boolean;
  confidence?: number;
  abstained: boolean;
  latencyMs: number;
  estimatedCostUsd: number;
};

export type CandidateScore = {
  candidateId: string;
  taskClass: string;
  samples: number;
  answered: number;
  accuracy: number;
  brierScore: number | null;
  falseApprovalRate: number;
  abstentionRate: number;
  p95LatencyMs: number;
  estimatedCostUsd: number;
};

function boundedNumber(value: number, field: string, maximum = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`${field} is outside its allowed range`);
  return value;
}

export function validateCandidate(candidate: DecisionCandidate): DecisionCandidate {
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/u.test(candidate.id)) throw new Error("Candidate id is invalid");
  if (!candidate.publisher.trim() || !candidate.license.trim() || !candidate.runtime.trim()) throw new Error("Candidate provenance fields are required");
  const url = new URL(candidate.provenanceUrl);
  if (url.protocol !== "https:") throw new Error("Candidate provenance must use HTTPS");
  if (Number.isNaN(Date.parse(candidate.updatedAt))) throw new Error("Candidate updatedAt must be an ISO timestamp");
  return { ...candidate, publisher: candidate.publisher.trim(), license: candidate.license.trim(), runtime: candidate.runtime.trim() };
}

function answersMatch(expected: DecisionCase["expected"], actual: DecisionObservation["answer"]): boolean {
  return typeof expected === "string" && typeof actual === "string"
    ? expected.trim().toLowerCase() === actual.trim().toLowerCase()
    : expected === actual;
}

function percentile(values: number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

export function scoreCandidate(input: { candidate: DecisionCandidate; cases: DecisionCase[]; observations: DecisionObservation[]; taskClass: string }): CandidateScore {
  validateCandidate(input.candidate);
  const cases = input.cases.filter((item) => item.taskClass === input.taskClass);
  const byId = new Map(input.observations.filter((item) => item.candidateId === input.candidate.id).map((item) => [item.caseId, item]));
  if (!cases.length) throw new Error(`No holdout cases exist for ${input.taskClass}`);
  let correct = 0;
  let falseApprovals = 0;
  let brierTotal = 0;
  let brierSamples = 0;
  const answered: DecisionObservation[] = [];
  let cost = 0;
  for (const item of cases) {
    const observation = byId.get(item.id);
    if (!observation) continue;
    boundedNumber(observation.latencyMs, "latencyMs");
    cost += boundedNumber(observation.estimatedCostUsd, "estimatedCostUsd");
    if (observation.abstained || observation.answer === undefined) continue;
    answered.push(observation);
    const matched = answersMatch(item.expected, observation.answer);
    if (matched) correct += 1;
    if (item.kind === "boolean" && item.expected === false && observation.answer === true) falseApprovals += 1;
    if (observation.confidence !== undefined) {
      const confidence = boundedNumber(observation.confidence, "confidence", 1);
      brierTotal += (confidence - (matched ? 1 : 0)) ** 2;
      brierSamples += 1;
    }
  }
  return {
    candidateId: input.candidate.id,
    taskClass: input.taskClass,
    samples: cases.length,
    answered: answered.length,
    accuracy: correct / cases.length,
    brierScore: brierSamples ? brierTotal / brierSamples : null,
    falseApprovalRate: falseApprovals / cases.length,
    abstentionRate: (cases.length - answered.length) / cases.length,
    p95LatencyMs: percentile(answered.map((item) => item.latencyMs), 0.95),
    estimatedCostUsd: cost
  };
}

export type PromotionThresholds = {
  minimumSamples: number;
  minimumAccuracy: number;
  maximumBrierScore: number;
  maximumFalseApprovalRate: number;
  maximumAbstentionRate: number;
  maximumP95LatencyMs: number;
};

export function selectTaskCandidate(input: { scores: CandidateScore[]; candidates: DecisionCandidate[]; thresholds: PromotionThresholds }): { selected: CandidateScore | null; eligible: CandidateScore[]; reasons: string[] } {
  const available = new Set(input.candidates.filter((item) => validateCandidate(item).available).map((item) => item.id));
  const eligible = input.scores.filter((score) => available.has(score.candidateId)
    && score.samples >= input.thresholds.minimumSamples
    && score.accuracy >= input.thresholds.minimumAccuracy
    && score.falseApprovalRate <= input.thresholds.maximumFalseApprovalRate
    && score.abstentionRate <= input.thresholds.maximumAbstentionRate
    && score.p95LatencyMs <= input.thresholds.maximumP95LatencyMs
    && score.brierScore !== null
    && score.brierScore <= input.thresholds.maximumBrierScore)
    .sort((left, right) => left.estimatedCostUsd - right.estimatedCostUsd || left.p95LatencyMs - right.p95LatencyMs || right.accuracy - left.accuracy);
  return {
    selected: eligible[0] ?? null,
    eligible,
    reasons: eligible.length ? ["Selected the least-cost eligible candidate, then latency and accuracy."] : ["No available candidate cleared every holdout and safety threshold; retain deterministic rules."]
  };
}

export function typedDecisionReceipt(input: { taskClass: string; candidateId: string | null; policyVersion: string; scores: CandidateScore[] }) {
  const evidence = {
    kind: "agentflow_typed_decision_evaluation",
    version: 1,
    taskClass: input.taskClass,
    candidateId: input.candidateId,
    policyVersion: input.policyVersion,
    scores: input.scores
  };
  return { ...evidence, evidenceHash: createHash("sha256").update(JSON.stringify(evidence)).digest("hex") };
}
