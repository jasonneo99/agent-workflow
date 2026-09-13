import { createHash } from "node:crypto";

export type OptimizerEventKind = "run.completed" | "feedback.created" | "evaluation.failed" | "approval.stale" | "provider.degraded" | "reconcile";
export type Risk = "low" | "medium" | "high";

export interface OptimizerEvent { id: string; kind: OptimizerEventKind; projectId: string; occurredAt: string; }
export interface ProjectBudget { projectId: string; maxActions: number; consumedActions: number; quietHours?: { start: number; end: number }; queueDepth: number; }
export interface Recommendation { id: string; projectId: string; kind: "stage" | "handoff" | "context" | "routing" | "evaluation"; evidence: number; impact: number; reversibility: number; risk: Risk; confidence: number; duplicateKey?: string; }
export interface RankedRecommendation extends Recommendation { score: number; deferredReason?: string; }

export function shouldWake(event: OptimizerEvent, seenIds: ReadonlySet<string>): boolean {
  return !seenIds.has(event.id) && event.kind !== "reconcile";
}

export function canSchedule(budget: ProjectBudget, hour: number): { allowed: boolean; reason?: string } {
  if (budget.consumedActions >= budget.maxActions) return { allowed: false, reason: "project budget exhausted" };
  if (budget.queueDepth >= Math.max(2, budget.maxActions)) return { allowed: false, reason: "backpressure" };
  const quiet = budget.quietHours;
  if (quiet && (quiet.start <= quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end)) return { allowed: false, reason: "quiet hours" };
  return { allowed: true };
}

const riskPenalty = { low: 0, medium: 0.15, high: 0.45 } as const;
export function rankRecommendations(items: Recommendation[], knownDuplicates: ReadonlySet<string> = new Set()): RankedRecommendation[] {
  return items.map((item) => {
    const deferredReason = item.duplicateKey && knownDuplicates.has(item.duplicateKey) ? "duplicate work suppressed" : item.risk === "high" ? "high-risk review required" : undefined;
    const score = item.evidence * 0.3 + item.impact * 0.3 + item.reversibility * 0.15 + item.confidence * 0.25 - riskPenalty[item.risk];
    return { ...item, score: Math.max(0, Math.min(1, score)), deferredReason };
  }).sort((a, b) => Number(Boolean(a.deferredReason)) - Number(Boolean(b.deferredReason)) || b.score - a.score);
}

export function simulateRecommendation(item: Recommendation, historicalOutcomes: number[]) {
  const mean = historicalOutcomes.length ? historicalOutcomes.reduce((a, b) => a + b, 0) / historicalOutcomes.length : 0;
  return { recommendationId: item.id, mode: "shadow" as const, samples: historicalOutcomes.length, projectedImpact: mean * item.confidence, promotable: historicalOutcomes.length >= 3 && mean > 0 && item.risk !== "high" };
}

export function optimizationReceipt(input: { recommendationId: string; action: "promote" | "rollback" | "regression"; beforeHash: string; afterHash: string; actor?: string }) {
  const payload = { ...input, actor: input.actor ?? "learning-daemon" };
  return { ...payload, receiptId: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), requiresApproval: input.action === "promote" && input.beforeHash === "" };
}

export function fleetHealth(budgets: ProjectBudget[], ranked: RankedRecommendation[], staleEvidence: number) {
  return { projects: budgets.length, queueDepth: budgets.reduce((n, x) => n + x.queueDepth, 0), budgetConsumed: budgets.reduce((n, x) => n + x.consumedActions, 0), budgetLimit: budgets.reduce((n, x) => n + x.maxActions, 0), deferred: ranked.filter(x => x.deferredReason).length, staleEvidence, status: staleEvidence || ranked.some(x => x.risk === "high" && !x.deferredReason) ? "watch" : "healthy" };
}

export interface JarvisIntentEnvelope { version: 1; requestId: string; conversationId: string; projectId?: string; goal: string; requestedAutonomy: "observe" | "propose" | "apply-approved"; executable: false; createdAt: string; }
export function createJarvisIntent(input: Omit<JarvisIntentEnvelope, "version" | "executable">): JarvisIntentEnvelope {
  if (!input.requestId || !input.conversationId || !input.goal.trim()) throw new Error("Jarvis intent identity and goal are required");
  return { version: 1, executable: false, ...input };
}

export function sharedBrainSummary(input: { activeGoals: string[]; recentDecisions: string[]; openApprovalCount: number; learnedPreferenceCount: number; degradedServices: string[] }) {
  return { ...input, activeGoals: input.activeGoals.slice(0, 10), recentDecisions: input.recentDecisions.slice(0, 10), degradedServices: input.degradedServices.slice(0, 10), rawMemoryIncluded: false };
}
