import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { advanceCanaryStage, evaluateCanaryOutcome, evaluatePromotionEvidence, promotionEvidenceSchema } from "../../guarded-autonomy/src/index.js";
import {
  aggregatePeerAssessments,
  buildLearningProposal,
  createPeerExchangeReceipt,
  learningQuestionSchema,
  learningResponseSchema,
  peerAssessmentSchema,
  type LearningQuestion,
  type LearningResponse,
  type PeerAssessment,
  type PeerAssessmentAggregate,
  type ReviewerCalibration
} from "./index.js";

export type LearningExperiment = {
  id: string;
  questionId: string;
  target: "agent_prompt" | "workflow_shape" | "context_budget" | "routing_preference";
  baselineHash: string;
  candidateHash: string;
  status: "shadow" | "approval-required" | "canary" | "promoted" | "rolled-back" | "quarantined";
  sampleCount: number;
  canaryPercent?: number;
  createdAt: string;
};

export type LearningLoopSchedulerReceipt = {
  id: string;
  questionId: string | null;
  status: "completed" | "deferred" | "failed";
  reason: string;
  providerId?: string;
  usage?: { calls: number; inputTokens: number; cachedInputTokens: number; reasoningTokens: number; outputTokens: number; totalTokens: number; costUsd?: number; costCoverageCalls: number };
  startedAt: string;
  completedAt: string;
};

export type LearningExchangeExecutor = {
  providerId: string;
  usage?(): NonNullable<LearningLoopSchedulerReceipt["usage"]>;
  answer(question: LearningQuestion): Promise<LearningResponse>;
  review(input: { question: LearningQuestion; response: LearningResponse; reviewerAgentId: string }): Promise<PeerAssessment>;
};

export type LearningLoopState = {
  version: 1;
  questions: LearningQuestion[];
  responses: LearningResponse[];
  assessments: PeerAssessment[];
  calibrations: ReviewerCalibration[];
  aggregates: Array<{ questionId: string; aggregate: PeerAssessmentAggregate; recordedAt: string }>;
  experiments: LearningExperiment[];
  receipts: Array<ReturnType<typeof createPeerExchangeReceipt>>;
  schedulerReceipts: LearningLoopSchedulerReceipt[];
  updatedAt: string;
};

export type LearningLoopBudget = {
  maxExchangesPerDay: number;
  completedToday: number;
  queueDepth: number;
  maxQueueDepth: number;
  estimatedCostUsd: number;
  maxDailyCostUsd: number;
  quietHours?: { start: number; end: number };
};

const emptyState = (): LearningLoopState => ({ version: 1, questions: [], responses: [], assessments: [], calibrations: [], aggregates: [], experiments: [], receipts: [], schedulerReceipts: [], updatedAt: new Date(0).toISOString() });

function statePath(projectDir: string): string {
  return path.join(projectDir, ".agent-workflow", "learning", "learning-loop.json");
}

export async function evaluateLearningExperiment(input: {
  projectDir: string;
  experimentId: string;
  evidence: Parameters<typeof evaluatePromotionEvidence>[0];
}): Promise<{ decision: ReturnType<typeof evaluatePromotionEvidence>["decision"]; experiment: LearningExperiment }> {
  const state = await readLearningLoopState(input.projectDir);
  const experiment = state.experiments.find((item) => item.id === input.experimentId);
  if (!experiment) throw new Error(`Unknown learning experiment: ${input.experimentId}`);
  const evidence = promotionEvidenceSchema.parse(input.evidence);
  const decision = evaluatePromotionEvidence(evidence);
  const status: LearningExperiment["status"] = decision.decision === "blocked" ? "quarantined" : decision.decision === "canary_eligible" ? "approval-required" : "shadow";
  const updated = { ...experiment, status, sampleCount: evidence.representative_cases };
  await writeLearningLoopState(input.projectDir, { ...state, experiments: state.experiments.map((item) => item.id === updated.id ? updated : item), updatedAt: new Date().toISOString() });
  return { decision: decision.decision, experiment: updated };
}

export async function advanceLearningCanary(input: { projectDir: string; experimentId: string; successfulRuns: number; hoursElapsed: number; humanApproved?: boolean }): Promise<LearningExperiment> {
  const state = await readLearningLoopState(input.projectDir);
  const experiment = state.experiments.find((item) => item.id === input.experimentId);
  if (!experiment) throw new Error(`Unknown learning experiment: ${input.experimentId}`);
  if (experiment.status === "approval-required" && !input.humanApproved) throw new Error("Starting a learning canary requires human approval.");
  const stage = advanceCanaryStage({ currentPercent: experiment.canaryPercent ?? 0, successfulRuns: input.successfulRuns, hoursElapsed: input.hoursElapsed, humanApprovedFullPromotion: input.humanApproved });
  const updated: LearningExperiment = { ...experiment, status: stage.nextPercent === 100 ? "promoted" : "canary", canaryPercent: stage.nextPercent, sampleCount: experiment.sampleCount + input.successfulRuns };
  await writeLearningLoopState(input.projectDir, { ...state, experiments: state.experiments.map((item) => item.id === updated.id ? updated : item), updatedAt: new Date().toISOString() });
  return updated;
}

export async function recordLearningCanaryOutcome(input: { projectDir: string; experimentId: string; outcome: Parameters<typeof evaluateCanaryOutcome>[0] }): Promise<{ action: ReturnType<typeof evaluateCanaryOutcome>["action"]; experiment: LearningExperiment }> {
  const state = await readLearningLoopState(input.projectDir);
  const experiment = state.experiments.find((item) => item.id === input.experimentId);
  if (!experiment) throw new Error(`Unknown learning experiment: ${input.experimentId}`);
  const decision = evaluateCanaryOutcome(input.outcome);
  const status: LearningExperiment["status"] = decision.action === "rollback_quarantine" ? "rolled-back" : decision.action === "promote" ? "canary" : experiment.status;
  const updated = { ...experiment, status };
  await writeLearningLoopState(input.projectDir, { ...state, experiments: state.experiments.map((item) => item.id === updated.id ? updated : item), updatedAt: new Date().toISOString() });
  return { action: decision.action, experiment: updated };
}

export async function readLearningLoopState(projectDir: string): Promise<LearningLoopState> {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath(projectDir), "utf8")) as Partial<LearningLoopState>;
    return {
      ...emptyState(),
      ...parsed,
      version: 1,
      questions: (parsed.questions ?? []).map((item) => learningQuestionSchema.parse(item)),
      responses: (parsed.responses ?? []).map((item) => learningResponseSchema.parse(item)),
      assessments: (parsed.assessments ?? []).map((item) => peerAssessmentSchema.parse(item))
    };
  } catch {
    return emptyState();
  }
}

export async function writeLearningLoopState(projectDir: string, state: LearningLoopState): Promise<void> {
  const file = statePath(projectDir);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}

export async function recordPeerExchange(input: {
  projectDir: string;
  question: LearningQuestion;
  response: LearningResponse;
  assessments: PeerAssessment[];
  deterministicChecksPassed: boolean;
  humanFeedbackConfirmed: boolean;
}): Promise<{ aggregate: PeerAssessmentAggregate; receipt: ReturnType<typeof createPeerExchangeReceipt> }> {
  const state = await readLearningLoopState(input.projectDir);
  const aggregate = aggregatePeerAssessments({ assessments: input.assessments, calibrations: state.calibrations, deterministicChecksPassed: input.deterministicChecksPassed, humanFeedbackConfirmed: input.humanFeedbackConfirmed, priorPairs: state.assessments.map((item) => ({ reviewerAgentId: item.reviewerAgentId, respondentAgentId: item.respondentAgentId })) });
  const receipt = createPeerExchangeReceipt(input);
  const now = new Date().toISOString();
  await writeLearningLoopState(input.projectDir, {
    ...state,
    questions: upsertById(state.questions, input.question),
    responses: upsertById(state.responses, input.response),
    assessments: [...state.assessments.filter((old) => !input.assessments.some((item) => item.id === old.id)), ...input.assessments],
    aggregates: [...state.aggregates.filter((old) => old.questionId !== input.question.id), { questionId: input.question.id, aggregate, recordedAt: now }],
    receipts: [...state.receipts.filter((old) => old.id !== receipt.id), receipt],
    updatedAt: now
  });
  return { aggregate, receipt };
}

export function validateLearningEvidence(input: {
  allowedHashes: string[];
  observedHashes: string[];
  expiresAt: string;
  content?: string;
}, now = new Date()): { valid: boolean; risks: string[] } {
  const risks: string[] = [];
  if (Date.parse(input.expiresAt) <= now.getTime()) risks.push("stale-evidence");
  const allowed = new Set(input.allowedHashes);
  if (input.observedHashes.some((hash) => !allowed.has(hash))) risks.push("unpermitted-evidence");
  if (new Set(input.observedHashes).size !== input.observedHashes.length) risks.push("duplicate-evidence");
  if (input.content && /(?:ignore|override|disregard)\s+(?:all\s+)?(?:previous|prior|system)\s+instructions|reveal\s+(?:secrets?|credentials?)/iu.test(input.content)) risks.push("instruction-like-evidence");
  return { valid: risks.length === 0, risks };
}

export async function executeProviderBackedPeerExchange(input: {
  projectDir: string;
  question: LearningQuestion;
  reviewerAgentIds: string[];
  executor: LearningExchangeExecutor;
  deterministicChecksPassed: boolean;
  humanFeedbackConfirmed: boolean;
  evidenceContent?: string;
  now?: Date;
}): Promise<{ aggregate: PeerAssessmentAggregate; receipt: ReturnType<typeof createPeerExchangeReceipt>; schedulerReceipt: LearningLoopSchedulerReceipt }> {
  const now = input.now ?? new Date();
  const startedAt = now.toISOString();
  const evidence = validateLearningEvidence({ allowedHashes: input.question.allowedEvidenceHashes, observedHashes: input.question.allowedEvidenceHashes, expiresAt: input.question.expiresAt, content: input.evidenceContent }, now);
  if (!evidence.valid) throw new Error(`Learning exchange evidence rejected: ${evidence.risks.join(", ")}`);
  if (new Set(input.reviewerAgentIds).size < 2) throw new Error("At least two independent reviewers are required.");
  try {
    const response = learningResponseSchema.parse(await input.executor.answer(input.question));
    if (response.questionId !== input.question.id || response.respondentAgentId !== input.question.respondentAgentId) throw new Error("Provider response identity does not match the learning question.");
    if (response.evidenceHashes.some((hash) => !input.question.allowedEvidenceHashes.includes(hash))) throw new Error("Provider response cited evidence outside the question allowlist.");
    const assessments = await Promise.all([...new Set(input.reviewerAgentIds)].map(async (reviewerAgentId) => {
      const assessment = peerAssessmentSchema.parse(await input.executor.review({ question: input.question, response, reviewerAgentId }));
      if (assessment.questionId !== input.question.id || assessment.responseId !== response.id || assessment.reviewerAgentId !== reviewerAgentId) throw new Error("Provider assessment identity does not match the scheduled review.");
      return assessment;
    }));
    const recorded = await recordPeerExchange({ projectDir: input.projectDir, question: input.question, response, assessments, deterministicChecksPassed: input.deterministicChecksPassed, humanFeedbackConfirmed: input.humanFeedbackConfirmed });
    const schedulerReceipt: LearningLoopSchedulerReceipt = { id: `learning-schedule-${randomUUID()}`, questionId: input.question.id, status: "completed", reason: "Provider-backed response and independent reviews were recorded.", providerId: input.executor.providerId, usage: input.executor.usage?.(), startedAt, completedAt: new Date().toISOString() };
    await appendSchedulerReceipt(input.projectDir, schedulerReceipt);
    return { ...recorded, schedulerReceipt };
  } catch (error) {
    const schedulerReceipt: LearningLoopSchedulerReceipt = { id: `learning-schedule-${randomUUID()}`, questionId: input.question.id, status: "failed", reason: error instanceof Error ? error.message : String(error), providerId: input.executor.providerId, usage: input.executor.usage?.(), startedAt, completedAt: new Date().toISOString() };
    await appendSchedulerReceipt(input.projectDir, schedulerReceipt);
    throw error;
  }
}

export async function runScheduledLearningExchange(input: {
  projectDir: string;
  budget: LearningLoopBudget;
  eligibleReviewerAgentIds: string[];
  executor?: LearningExchangeExecutor;
  deterministicChecksPassed?: boolean;
  humanFeedbackConfirmed?: boolean;
  now?: Date;
}): Promise<LearningLoopSchedulerReceipt> {
  const now = input.now ?? new Date();
  const state = await readLearningLoopState(input.projectDir);
  const decision = canScheduleLearningExchange(input.budget, now);
  const question = state.questions.find((item) => Date.parse(item.expiresAt) > now.getTime() && !state.responses.some((response) => response.questionId === item.id));
  if (!decision.allowed || !question || !input.executor) {
    const reason = !decision.allowed ? decision.reason : !question ? "no eligible unanswered learning question" : "provider-backed executor disabled";
    const receipt: LearningLoopSchedulerReceipt = { id: `learning-schedule-${randomUUID()}`, questionId: question?.id ?? null, status: "deferred", reason, providerId: input.executor?.providerId, startedAt: now.toISOString(), completedAt: now.toISOString() };
    await appendSchedulerReceipt(input.projectDir, receipt);
    return receipt;
  }
  const plan = planPeerExchange({ requesterAgentId: question.requesterAgentId, respondentAgentId: question.respondentAgentId, eligibleReviewerAgentIds: input.eligibleReviewerAgentIds, priorAssessments: state.assessments });
  const result = await executeProviderBackedPeerExchange({ projectDir: input.projectDir, question, reviewerAgentIds: plan.reviewerAgentIds, executor: input.executor, deterministicChecksPassed: input.deterministicChecksPassed ?? false, humanFeedbackConfirmed: input.humanFeedbackConfirmed ?? false, now });
  return result.schedulerReceipt;
}

export async function recordReviewerCalibration(projectDir: string, calibration: ReviewerCalibration): Promise<void> {
  const state = await readLearningLoopState(projectDir);
  await writeLearningLoopState(projectDir, { ...state, calibrations: [...state.calibrations.filter((item) => item.reviewerAgentId !== calibration.reviewerAgentId), calibration], updatedAt: new Date().toISOString() });
}

export function canScheduleLearningExchange(budget: LearningLoopBudget, now = new Date()): { allowed: boolean; reason: string } {
  if (budget.completedToday >= budget.maxExchangesPerDay) return { allowed: false, reason: "daily exchange budget exhausted" };
  if (budget.queueDepth >= budget.maxQueueDepth) return { allowed: false, reason: "learning queue backpressure" };
  if (budget.estimatedCostUsd >= budget.maxDailyCostUsd) return { allowed: false, reason: "daily learning cost budget exhausted" };
  const quiet = budget.quietHours;
  const hour = now.getHours();
  if (quiet && (quiet.start <= quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end)) return { allowed: false, reason: "quiet hours" };
  return { allowed: true, reason: "within learning frequency, queue, cost, and quiet-hour budgets" };
}

export function planPeerExchange(input: {
  requesterAgentId: string;
  respondentAgentId: string;
  eligibleReviewerAgentIds: string[];
  priorAssessments: PeerAssessment[];
  reviewerCount?: number;
}): { respondentAgentId: string; reviewerAgentIds: string[]; mutationAllowed: false; reason: string } {
  const requested = Math.max(2, Math.min(input.reviewerCount ?? 2, 4));
  const pairFrequency = new Map<string, number>();
  for (const item of input.priorAssessments) pairFrequency.set(`${item.reviewerAgentId}->${item.respondentAgentId}`, (pairFrequency.get(`${item.reviewerAgentId}->${item.respondentAgentId}`) ?? 0) + 1);
  const reviewerAgentIds = [...new Set(input.eligibleReviewerAgentIds)]
    .filter((id) => id !== input.requesterAgentId && id !== input.respondentAgentId)
    .sort((a, b) => (pairFrequency.get(`${a}->${input.respondentAgentId}`) ?? 0) - (pairFrequency.get(`${b}->${input.respondentAgentId}`) ?? 0) || a.localeCompare(b))
    .slice(0, requested);
  if (reviewerAgentIds.length < 2) throw new Error("At least two independent eligible reviewers are required.");
  return { respondentAgentId: input.respondentAgentId, reviewerAgentIds, mutationAllowed: false, reason: "Reviewers rotate toward the least-used independent pairs; the exchange is read-only." };
}

export async function queueLearningExperiment(input: {
  projectDir: string;
  question: LearningQuestion;
  aggregate: PeerAssessmentAggregate;
  target: LearningExperiment["target"];
  baseline: unknown;
  candidate: unknown;
}): Promise<LearningExperiment | null> {
  const proposal = buildLearningProposal({ question: input.question, aggregate: input.aggregate, target: input.target });
  if (proposal.status !== "proposed") return null;
  const experiment: LearningExperiment = {
    id: `learning-experiment-${randomUUID()}`,
    questionId: input.question.id,
    target: input.target,
    baselineHash: stableHash(input.baseline),
    candidateHash: stableHash(input.candidate),
    status: "shadow",
    sampleCount: 0,
    createdAt: new Date().toISOString()
  };
  const state = await readLearningLoopState(input.projectDir);
  await writeLearningLoopState(input.projectDir, { ...state, experiments: [...state.experiments, experiment], updatedAt: new Date().toISOString() });
  return experiment;
}

export function buildLearningLoopDashboard(state: LearningLoopState) {
  const openQuestions = state.questions.filter((question) => !state.responses.some((response) => response.questionId === question.id));
  const disagreements = state.aggregates.filter((item) => (item.aggregate.disagreement ?? 0) > 0.75 || item.aggregate.risks.length > 0);
  const completedQuestionIds = new Set(state.schedulerReceipts.filter((item) => item.status === "completed" && item.questionId).map((item) => item.questionId));
  const historicalSchedulerFailures = state.schedulerReceipts.filter((item) => item.status === "failed").length;
  const unresolvedSchedulerFailures = state.schedulerReceipts.filter((item) => item.status === "failed" && (!item.questionId || !completedQuestionIds.has(item.questionId))).length;
  const usage = state.schedulerReceipts.reduce((total, item) => ({ calls: total.calls + (item.usage?.calls ?? 0), inputTokens: total.inputTokens + (item.usage?.inputTokens ?? 0), outputTokens: total.outputTokens + (item.usage?.outputTokens ?? 0), totalTokens: total.totalTokens + (item.usage?.totalTokens ?? 0), costUsd: total.costUsd + (item.usage?.costUsd ?? 0), costCoverageCalls: total.costCoverageCalls + (item.usage?.costCoverageCalls ?? 0) }), { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, costCoverageCalls: 0 });
  return {
    kind: "agentflow_learning_loop_dashboard" as const,
    generatedAt: new Date().toISOString(),
    summary: {
      questions: state.questions.length,
      openQuestions: openQuestions.length,
      responses: state.responses.length,
      assessments: state.assessments.length,
      completedCycles: completedQuestionIds.size,
      calibratedReviewers: state.calibrations.filter((item) => item.sampleCount >= 3).length,
      disagreements: disagreements.length,
      shadowExperiments: state.experiments.filter((item) => item.status === "shadow").length,
      schedulerFailures: unresolvedSchedulerFailures,
      historicalSchedulerFailures
    },
    usage: { ...usage, costUsd: usage.costCoverageCalls ? usage.costUsd : null },
    openQuestions: openQuestions.slice(-25),
    recentAggregates: state.aggregates.slice(-25),
    experiments: state.experiments.slice(-25),
    schedulerReceipts: state.schedulerReceipts.slice(-25),
    rawPrivateContentIncluded: false
  };
}

export type LearningLoopDashboard = ReturnType<typeof buildLearningLoopDashboard>;

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
  return [...items.filter((old) => old.id !== item.id), item];
}

async function appendSchedulerReceipt(projectDir: string, receipt: LearningLoopSchedulerReceipt): Promise<void> {
  const state = await readLearningLoopState(projectDir);
  await writeLearningLoopState(projectDir, { ...state, schedulerReceipts: [...state.schedulerReceipts, receipt].slice(-500), updatedAt: new Date().toISOString() });
}
