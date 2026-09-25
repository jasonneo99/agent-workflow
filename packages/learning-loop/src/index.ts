import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const scoreSchema = z.number().int().min(1).max(5);

export const learningQuestionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  taskClass: z.string().min(1),
  requesterAgentId: z.string().min(1),
  respondentAgentId: z.string().min(1),
  question: z.string().min(1).max(8_000),
  rubricVersion: z.string().min(1),
  allowedEvidenceHashes: z.array(z.string().min(1)).max(100),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).superRefine((value, context) => {
  if (value.requesterAgentId === value.respondentAgentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["respondentAgentId"], message: "An agent cannot answer its own learning question." });
  }
});

export const learningResponseSchema = z.object({
  id: z.string().min(1),
  questionId: z.string().min(1),
  respondentAgentId: z.string().min(1),
  answer: z.string().min(1).max(32_000),
  evidenceHashes: z.array(z.string().min(1)).max(100),
  confidence: z.number().min(0).max(1),
  createdAt: z.string().datetime()
});

export const peerAssessmentSchema = z.object({
  id: z.string().min(1),
  questionId: z.string().min(1),
  responseId: z.string().min(1),
  reviewerAgentId: z.string().min(1),
  respondentAgentId: z.string().min(1),
  scores: z.object({
    correctness: scoreSchema,
    completeness: scoreSchema,
    evidenceQuality: scoreSchema,
    policyCompliance: scoreSchema,
    usefulness: scoreSchema,
    clarity: scoreSchema,
    verificationStrength: scoreSchema,
    uncertaintyHandling: scoreSchema
  }),
  rationale: z.string().min(1).max(8_000),
  evidenceHashes: z.array(z.string().min(1)).min(1).max(100),
  confidence: z.number().min(0).max(1),
  createdAt: z.string().datetime()
}).superRefine((value, context) => {
  if (value.reviewerAgentId === value.respondentAgentId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reviewerAgentId"], message: "Self-rating is forbidden." });
  }
});

export type LearningQuestion = z.infer<typeof learningQuestionSchema>;
export type LearningResponse = z.infer<typeof learningResponseSchema>;
export type PeerAssessment = z.infer<typeof peerAssessmentSchema>;

export type ReviewerCalibration = {
  reviewerAgentId: string;
  sampleCount: number;
  verifiedAgreement: number;
  humanAgreement: number;
};

export type PeerAssessmentAggregate = {
  status: "insufficient-evidence" | "advisory" | "promotion-eligible";
  reviewerCount: number;
  calibratedScore: number | null;
  disagreement: number | null;
  risks: string[];
  evidenceHashes: string[];
};

export function createLearningQuestion(input: Omit<LearningQuestion, "id" | "createdAt"> & { now?: Date }): LearningQuestion {
  const now = input.now ?? new Date();
  return learningQuestionSchema.parse({
    ...input,
    id: `learning-question-${randomUUID()}`,
    createdAt: now.toISOString()
  });
}

export function createPeerExchangeReceipt(input: {
  question: LearningQuestion;
  response: LearningResponse;
  assessments: PeerAssessment[];
}): { kind: "agentflow_peer_learning_exchange"; id: string; bodyHash: string; participants: string[]; evidenceHashes: string[] } {
  const payload = JSON.stringify({ question: input.question, response: input.response, assessments: input.assessments });
  return {
    kind: "agentflow_peer_learning_exchange",
    id: `peer-exchange-${input.question.id}`,
    bodyHash: createHash("sha256").update(payload).digest("hex"),
    participants: [...new Set([input.question.requesterAgentId, input.question.respondentAgentId, ...input.assessments.map((item) => item.reviewerAgentId)])],
    evidenceHashes: [...new Set([...input.question.allowedEvidenceHashes, ...input.response.evidenceHashes, ...input.assessments.flatMap((item) => item.evidenceHashes)])]
  };
}

export function aggregatePeerAssessments(input: {
  assessments: PeerAssessment[];
  calibrations: ReviewerCalibration[];
  deterministicChecksPassed: boolean;
  humanFeedbackConfirmed: boolean;
  priorPairs?: Array<{ reviewerAgentId: string; respondentAgentId: string }>;
}): PeerAssessmentAggregate {
  const risks = detectPeerRatingRisks(input.assessments, input.priorPairs ?? []);
  const independent = input.assessments.filter((item) => item.reviewerAgentId !== item.respondentAgentId);
  const reviewerIds = new Set(independent.map((item) => item.reviewerAgentId));
  const calibrated = independent.map((assessment) => {
    const calibration = input.calibrations.find((item) => item.reviewerAgentId === assessment.reviewerAgentId);
    const weight = calibration && calibration.sampleCount >= 3
      ? Math.max(0.1, Math.min(1, (calibration.verifiedAgreement + calibration.humanAgreement) / 2))
      : 0.25;
    const values = Object.values(assessment.scores);
    return { score: values.reduce((sum, value) => sum + value, 0) / values.length, weight: weight * assessment.confidence };
  });
  const totalWeight = calibrated.reduce((sum, item) => sum + item.weight, 0);
  const score = totalWeight ? calibrated.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight : null;
  const disagreement = score === null || !calibrated.length
    ? null
    : Math.sqrt(calibrated.reduce((sum, item) => sum + (item.score - score) ** 2, 0) / calibrated.length);
  const enoughEvidence = reviewerIds.size >= 2 && input.deterministicChecksPassed;
  const promotionEligible = enoughEvidence && input.humanFeedbackConfirmed && risks.length === 0 && score !== null && score >= 4 && (disagreement ?? Infinity) <= 0.75;
  return {
    status: promotionEligible ? "promotion-eligible" : enoughEvidence ? "advisory" : "insufficient-evidence",
    reviewerCount: reviewerIds.size,
    calibratedScore: score === null ? null : Number(score.toFixed(3)),
    disagreement: disagreement === null ? null : Number(disagreement.toFixed(3)),
    risks,
    evidenceHashes: [...new Set(independent.flatMap((item) => item.evidenceHashes))]
  };
}

export function detectPeerRatingRisks(
  assessments: PeerAssessment[],
  priorPairs: Array<{ reviewerAgentId: string; respondentAgentId: string }>
): string[] {
  const risks: string[] = [];
  if (assessments.some((item) => item.reviewerAgentId === item.respondentAgentId)) risks.push("self-rating");
  const pairCounts = new Map<string, number>();
  for (const pair of [...priorPairs, ...assessments]) {
    const key = `${pair.reviewerAgentId}->${pair.respondentAgentId}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  for (const [pair, count] of pairCounts) {
    const [reviewer, respondent] = pair.split("->");
    if (count >= 3 && (pairCounts.get(`${respondent}->${reviewer}`) ?? 0) >= 3) {
      risks.push("reciprocal-rating-concentration");
      break;
    }
  }
  const reviewerCounts = new Map<string, number>();
  for (const item of [...priorPairs, ...assessments]) reviewerCounts.set(item.reviewerAgentId, (reviewerCounts.get(item.reviewerAgentId) ?? 0) + 1);
  const totalReviews = [...reviewerCounts.values()].reduce((sum, count) => sum + count, 0);
  if (totalReviews >= 6 && [...reviewerCounts.values()].some((count) => count / totalReviews > 0.75)) risks.push("reviewer-concentration");
  const edges = new Map<string, Set<string>>();
  for (const item of [...priorPairs, ...assessments]) edges.set(item.reviewerAgentId, new Set([...(edges.get(item.reviewerAgentId) ?? []), item.respondentAgentId]));
  const visits = new Set<string>();
  const stack = new Set<string>();
  const cyclic = (node: string): boolean => {
    if (stack.has(node)) return true;
    if (visits.has(node)) return false;
    visits.add(node); stack.add(node);
    for (const next of edges.get(node) ?? []) if (cyclic(next)) return true;
    stack.delete(node);
    return false;
  };
  if ([...edges.keys()].some(cyclic)) risks.push("circular-grading");
  if (assessments.length >= 2 && assessments.every((item) => Object.values(item.scores).every((score) => score === 5))) {
    risks.push("uniform-maximum-scores");
  }
  return risks;
}

export function buildLearningProposal(input: {
  question: LearningQuestion;
  aggregate: PeerAssessmentAggregate;
  target: "agent_prompt" | "workflow_shape" | "context_budget" | "routing_preference";
}): { status: "blocked" | "proposed"; reason: string; target: string; evidenceHashes: string[] } {
  if (input.aggregate.status !== "promotion-eligible") {
    return { status: "blocked", reason: "Peer evidence remains advisory until deterministic checks, calibrated independent review, and human confirmation pass.", target: input.target, evidenceHashes: input.aggregate.evidenceHashes };
  }
  return { status: "proposed", reason: "Evidence may enter the existing shadow evaluation and approval pipeline; it grants no direct write authority.", target: input.target, evidenceHashes: input.aggregate.evidenceHashes };
}

export * from "./runtime.js";
export * from "./reliability.js";
