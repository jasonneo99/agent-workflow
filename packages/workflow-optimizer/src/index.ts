import { createHash, verify } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

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

export interface OptimizerState { version: 1; seenEventIds: string[]; budgets: ProjectBudget[]; shadowResults: ReturnType<typeof simulateRecommendation>[]; receipts: ReturnType<typeof optimizationReceipt>[]; approvals: OptimizerApproval[]; updatedAt: string; }
export interface OptimizerApproval { id: string; recommendationId: string; projectId: string; risk: Risk; status: "pending" | "auto-approved" | "approved" | "rejected"; rationale: string; createdAt: string; }
export async function readOptimizerState(projectDir: string): Promise<OptimizerState> {
  const file = path.join(projectDir, ".agent-workflow", "learning", "optimizer-state.json");
  try { const state = JSON.parse(await fs.readFile(file, "utf8")) as OptimizerState; return { ...state, approvals: state.approvals ?? [] }; } catch { return { version: 1, seenEventIds: [], budgets: [], shadowResults: [], receipts: [], approvals: [], updatedAt: new Date(0).toISOString() }; }
}
export async function writeOptimizerState(projectDir: string, state: OptimizerState): Promise<void> {
  const dir = path.join(projectDir, ".agent-workflow", "learning");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "optimizer-state.json");
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(temp, file);
}
export async function appendOptimizerEvents(projectDir: string, events: OptimizerEvent[]): Promise<void> {
  if (!events.length) return;
  const dir = path.join(projectDir, ".agent-workflow", "learning");
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(path.join(dir, "optimizer-events.jsonl"), `${events.map(event => JSON.stringify(event)).join("\n")}\n`, "utf8");
}
export async function readOptimizerEvents(projectDir: string, limit = 500): Promise<OptimizerEvent[]> {
  try {
    const text = await fs.readFile(path.join(projectDir, ".agent-workflow", "learning", "optimizer-events.jsonl"), "utf8");
    return text.trim().split("\n").filter(Boolean).slice(-limit).map(line => JSON.parse(line) as OptimizerEvent);
  } catch { return []; }
}
export function buildOptimizerApprovals(items: RankedRecommendation[], now = new Date()): OptimizerApproval[] {
  return items.filter(item => !item.deferredReason || item.risk === "high").map(item => ({ id: `optimizer:${item.id}`, recommendationId: item.id, projectId: item.projectId, risk: item.risk, status: item.risk === "low" ? "auto-approved" : "pending", rationale: item.risk === "high" ? "high-risk behavior change requires explicit approval" : "review before promotion", createdAt: now.toISOString() }));
}
export function fairProjectOrder(budgets: ProjectBudget[], lastScheduled: Readonly<Record<string, string>> = {}): ProjectBudget[] {
  return budgets.filter(budget => canSchedule(budget, new Date().getHours()).allowed).sort((a, b) => (lastScheduled[a.projectId] ?? "").localeCompare(lastScheduled[b.projectId] ?? "") || a.consumedActions / Math.max(1, a.maxActions) - b.consumedActions / Math.max(1, b.maxActions));
}
export function optimizerDashboardReport(state: OptimizerState, approvals: OptimizerApproval[], events: OptimizerEvent[]) {
  return { kind: "agentflow_optimizer_dashboard", generatedAt: new Date().toISOString(), health: fleetHealth(state.budgets, [], 0), budgets: state.budgets, recentEvents: events.slice(-25), shadowResults: state.shadowResults.slice(-25), receipts: state.receipts.slice(-25), approvals: approvals.slice(-25), eventCursorCount: state.seenEventIds.length };
}
export async function runOptimizerCycle(input: { projectDir: string; events: OptimizerEvent[]; recommendations: Recommendation[]; historicalOutcomes?: Record<string, number[]>; budget?: ProjectBudget; now?: Date }) {
  const state = await readOptimizerState(input.projectDir);
  const seen = new Set(state.seenEventIds);
  const wakeEvents = input.events.filter(event => shouldWake(event, seen));
  await appendOptimizerEvents(input.projectDir, wakeEvents);
  const budget = input.budget ?? state.budgets.find(x => x.projectId === input.projectDir) ?? { projectId: input.projectDir, maxActions: 10, consumedActions: 0, queueDepth: 0 };
  const scheduling = canSchedule(budget, (input.now ?? new Date()).getHours());
  const ranked = rankRecommendations(input.recommendations, new Set(state.receipts.map(x => x.recommendationId)));
  const shadowResults = ranked.map(item => simulateRecommendation(item, input.historicalOutcomes?.[item.id] ?? []));
  const approvals = buildOptimizerApprovals(ranked);
  const next: OptimizerState = { version: 1, seenEventIds: [...new Set([...state.seenEventIds, ...wakeEvents.map(x => x.id)])].slice(-1000), budgets: [...state.budgets.filter(x => x.projectId !== budget.projectId), budget], shadowResults: [...state.shadowResults, ...shadowResults].slice(-500), receipts: state.receipts.slice(-500), approvals: [...state.approvals.filter(old => !approvals.some(item => item.id === old.id)), ...approvals].slice(-500), updatedAt: new Date().toISOString() };
  await writeOptimizerState(input.projectDir, next);
  return { woke: wakeEvents.length > 0, wakeEvents, scheduling, ranked, shadowResults, health: fleetHealth(next.budgets, ranked, 0), state: next };
}

export function authenticateSharedBrainRequest(authorization: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken || !authorization?.startsWith("Bearer ")) return false;
  const actual = authorization.slice(7).trim();
  if (actual.length !== expectedToken.length) return false;
  let different = 0; for (let i = 0; i < actual.length; i += 1) different |= actual.charCodeAt(i) ^ expectedToken.charCodeAt(i);
  return different === 0;
}

export interface FleetControlAction { actionId: string; operation: string; target: string; issuedAt: string; expiresAt: string; signature: string; }
export function verifyFleetControlAction(action: FleetControlAction, publicKey: string, allowlist: ReadonlySet<string>, now = new Date()): boolean {
  if (!allowlist.has(action.operation) || Date.parse(action.expiresAt) <= now.getTime()) return false;
  const payload = JSON.stringify({ actionId: action.actionId, operation: action.operation, target: action.target, issuedAt: action.issuedAt, expiresAt: action.expiresAt });
  return verify(null, Buffer.from(payload), publicKey, Buffer.from(action.signature, "base64"));
}

export function previewJarvisPlan(intent: JarvisIntentEnvelope, recommendations: RankedRecommendation[]) {
  return { requestId: intent.requestId, goal: intent.goal, executable: false, approvalRequired: recommendations.some(x => x.risk === "high" || x.deferredReason), steps: recommendations.slice(0, 10).map(x => ({ kind: x.kind, score: x.score, explanation: x.deferredReason ?? "ranked by evidence, impact, reversibility, and confidence" })) };
}

export function runSharedBrainCanary(input: { intent: JarvisIntentEnvelope; planPreviewed: boolean; executed: boolean; observed: boolean; approved: boolean; recovered: boolean; summarized: boolean }) {
  const paths = { ask: Boolean(input.intent.goal), plan: input.planPreviewed, execute: input.executed, observe: input.observed, approve: input.approved, recover: input.recovered, summarize: input.summarized };
  return { paths, passed: Object.values(paths).every(Boolean), rawMemoryIncluded: false };
}
