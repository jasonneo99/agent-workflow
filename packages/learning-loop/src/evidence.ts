export type LearningFailedRun = { runId: string; workflowId: string; task: string; startedAt: string };
export type LearningFailurePattern = { workflowId: string; stageId: string; agentId: string; failedTasks: number; totalTasks: number; failureRate: number };
export type LearningCostOpportunity = { workflowId: string; stageId: string; agentId: string; providerId: string; modelTier: string; runs: number; fallbackRate: number; averageLatencyMs: number | null; recommendation: string };
export type LearningRouteFeedbackGroup = { target: string; route: string; routeClass: string; total: number; helpful: number; costly: number; neutral: number; latestAt: string | null };
export type LearningRouteFeedbackSummary = { total: number; counts: Record<string, number>; latestAt: string | null; costlyGroups: LearningRouteFeedbackGroup[]; helpfulGroups: LearningRouteFeedbackGroup[] };

const counts = (values: string[]) => values.reduce<Record<string, number>>((result, value) => { result[value] = (result[value] ?? 0) + 1; return result; }, {});

export function selectFailedRuns(runs: Array<{ id: string; workflowId: string; task: string; startedAt: string; status: string; evaluationMetadata?: Record<string, unknown>; dismissed?: boolean }>, limit = 10): LearningFailedRun[] {
  return runs
    .filter((run) => run.status === "failed" && !run.dismissed && typeof run.evaluationMetadata?.suiteId !== "string")
    .slice(0, limit)
    .map((run) => ({ runId: run.id, workflowId: run.workflowId, task: run.task, startedAt: run.startedAt }));
}
export function buildFailurePatterns(stages: Array<{ stageId: string; failedTasks: number; totalTasks: number }>, identify: (stageId: string) => { workflowId: string; agentId: string }, limit = 10): LearningFailurePattern[] {
  return stages.filter((stage) => stage.failedTasks > 0).map((stage) => ({ ...identify(stage.stageId), stageId: stage.stageId, failedTasks: stage.failedTasks, totalTasks: stage.totalTasks, failureRate: stage.totalTasks > 0 ? Number((stage.failedTasks / stage.totalTasks).toFixed(3)) : 0 })).sort((left, right) => right.failedTasks - left.failedTasks || right.failureRate - left.failureRate).slice(0, limit);
}
export function buildCostOpportunities(groups: Array<LearningCostOpportunity & { feedbackScore: number }>, limit = 10): LearningCostOpportunity[] {
  return groups.filter((group) => group.recommendation !== "Keep current routing." || group.fallbackRate > 0 || (group.averageLatencyMs ?? 0) > 30_000).sort((left, right) => right.feedbackScore - left.feedbackScore || right.fallbackRate - left.fallbackRate).slice(0, limit).map(({ feedbackScore: _feedbackScore, ...group }) => group);
}
export function summarizeRouteFeedback(events: Array<{ workflowId: string; stageId: string; agentId: string; providerId: string; modelTier: string; routeClass: string; rating: "helpful" | "costly" | "neutral"; createdAt: string }>): LearningRouteFeedbackSummary {
  const groups = new Map<string, LearningRouteFeedbackGroup>();
  for (const event of events) { const target = `${event.workflowId}/${event.stageId}/${event.agentId}`; const route = `${event.providerId}/${event.modelTier}`; const key = `${target}:${route}:${event.routeClass}`; const group = groups.get(key) ?? { target, route, routeClass: event.routeClass, total: 0, helpful: 0, costly: 0, neutral: 0, latestAt: null }; group.total += 1; group[event.rating] += 1; group.latestAt = !group.latestAt || event.createdAt > group.latestAt ? event.createdAt : group.latestAt; groups.set(key, group); }
  const sorted = [...groups.values()].sort((left, right) => right.total - left.total || (right.latestAt ?? "").localeCompare(left.latestAt ?? "") || left.target.localeCompare(right.target));
  return { total: events.length, counts: counts(events.map((event) => event.rating)), latestAt: events.map((event) => event.createdAt).sort().at(-1) ?? null, costlyGroups: sorted.filter((group) => group.costly > 0).sort((left, right) => right.costly - left.costly || right.total - left.total).slice(0, 8), helpfulGroups: sorted.filter((group) => group.helpful > 0).sort((left, right) => right.helpful - left.helpful || right.total - left.total).slice(0, 8) };
}
export function buildEvaluationGaps(input: { runs: number; feedbackCount: number; evaluationRuns: number; failedRuns: number; failurePatterns: number; feedbackNeeded: boolean }): string[] {
  const gaps: string[] = []; if (!input.runs) gaps.push("Run at least one workflow before learning can identify patterns."); if (!input.feedbackCount) gaps.push("Record accepted, revised, or rejected feedback so learning can personalize recommendations."); if (!input.evaluationRuns) gaps.push("Run or create an evaluation suite before promoting routing, prompt, or context-budget changes."); if (input.failedRuns > 0 && !input.failurePatterns) gaps.push("Failed runs exist, but stage-level health did not isolate a repeated failing stage yet."); if (input.feedbackNeeded) gaps.push("Some routes need human feedback before the daemon can rank them confidently."); if (!gaps.length) gaps.push("Learning evidence is ready for autonomous low/medium local optimization and high-risk approval review."); return gaps;
}
export function buildProposalPreview(proposals: Array<{ kind: string; priority: string }>) { return { total: proposals.length, highPriority: proposals.filter((proposal) => proposal.priority === "high").length, byKind: counts(proposals.map((proposal) => proposal.kind)) }; }
