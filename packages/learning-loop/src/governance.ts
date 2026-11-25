export type LearningProposalPriority = "high" | "medium" | "low";
export type LearningProposalKind = "repeated_failure" | "cost_routing" | "route_feedback" | "eval_gap" | "feedback_gap" | "proposal_followup";
export type LearningRiskLevel = "low" | "medium" | "high";
export type LearningApprovalStatus = "pending" | "approved" | "rejected";
export type LearningProposal = { id: string; priority: LearningProposalPriority; kind: LearningProposalKind; riskLevel: LearningRiskLevel; title: string; target: string; rationale: string; evidence: string[]; recommendation: string; approvalRequired: boolean };
export type LearningProposalSet = { kind: "agentflow_learning_proposals"; projectRootUri: string; generatedAt: string; sourceReportGeneratedAt: string; sourceRunsAnalyzed: number; proposals: LearningProposal[]; summary: string[] };
export type LearningApprovalItem = { id: string; proposalId: string; status: LearningApprovalStatus; createdAt: string; decidedAt?: string; reviewer?: string; note?: string; proposal: LearningProposal };
export type LearningApprovalQueue = { kind: "agentflow_learning_approval_queue"; projectRootUri: string; generatedAt: string; sourceGeneratedAt: string; sourceRunsAnalyzed: number; skippedIds: string[]; items: LearningApprovalItem[] };
export type LearningApprovalDecisionResult = { queue: LearningApprovalQueue; selectedIds: string[]; skippedIds: string[] };
export type LearningApplicationAction = { id: string; proposalId: string; title: string; actionType: "collect_feedback" | "create_eval" | "debug_failure" | "review_tuning" | "apply_tuning_overlay" | "refresh_routing_recommendations" | "manual_review"; dangerGate: "none" | "approval_required"; rationale: string; command: string | null; writesOwnedLearningStateOnly: boolean; blockedUntil: string[] };
export type LearningApplicationPlan = { kind: "agentflow_learning_application_plan"; projectRootUri: string; generatedAt: string; sourceGeneratedAt: string; selectedIds: string[]; skippedIds: string[]; actions: LearningApplicationAction[]; summary: string[] };

const riskRank = (value: LearningRiskLevel) => ({ low: 0, medium: 1, high: 2 })[value];
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

export function buildLearningApprovalQueue(proposalSet: LearningProposalSet, selectedIds: string[] | "all" = "all", existingQueue?: LearningApprovalQueue, autonomousApplyMaxRisk: LearningRiskLevel = "medium"): LearningApprovalQueue {
  const requestedIds = selectedIds === "all" ? proposalSet.proposals.map((proposal) => proposal.id) : selectedIds;
  const requestedIdSet = new Set(requestedIds);
  const selected = proposalSet.proposals.filter((proposal) => requestedIdSet.has(proposal.id));
  const selectedIdSet = new Set(selected.map((proposal) => proposal.id));
  const existingByProposal = new Map((existingQueue?.items ?? []).map((item) => [item.proposalId, item]));
  const generatedAt = new Date().toISOString();
  return { kind: "agentflow_learning_approval_queue", projectRootUri: proposalSet.projectRootUri, generatedAt, sourceGeneratedAt: proposalSet.generatedAt, sourceRunsAnalyzed: proposalSet.sourceRunsAnalyzed, skippedIds: requestedIds.filter((id) => !selectedIdSet.has(id)), items: selected.map((proposal) => {
    const existing = existingByProposal.get(proposal.id);
    const autoApproved = !proposal.approvalRequired && riskRank(proposal.riskLevel) <= riskRank(autonomousApplyMaxRisk);
    const status = existing?.status === "pending" && autoApproved ? "approved" : existing?.status ?? (autoApproved ? "approved" : "pending");
    return { id: existing?.id ?? `learn-approval-${proposal.id.replace(/^learn-/, "")}`, proposalId: proposal.id, status, createdAt: existing?.createdAt ?? generatedAt, decidedAt: existing?.decidedAt ?? (status === "approved" && autoApproved ? generatedAt : undefined), reviewer: existing?.reviewer ?? (status === "approved" && autoApproved ? "learning-daemon" : undefined), note: existing?.note ?? (status === "approved" && autoApproved ? `Autonomous local approval: risk=${proposal.riskLevel}, threshold=${autonomousApplyMaxRisk}.` : undefined), proposal };
  }) };
}

export function decideLearningApprovals(input: { queue: LearningApprovalQueue; ids: string[] | "all"; status: Exclude<LearningApprovalStatus, "pending">; reviewer?: string; note?: string }): LearningApprovalDecisionResult {
  const idSet = input.ids === "all" ? null : new Set(input.ids); const decidedAt = new Date().toISOString(); const selectedIds: string[] = []; const matchedIds = new Set<string>();
  const items = input.queue.items.map((item) => { const selected = idSet === null || idSet.has(item.id) || idSet.has(item.proposalId); if (!selected) return item; selectedIds.push(item.proposalId); matchedIds.add(item.id); matchedIds.add(item.proposalId); return { ...item, status: input.status, decidedAt, reviewer: input.reviewer, note: input.note }; });
  return { queue: { ...input.queue, generatedAt: decidedAt, items }, selectedIds, skippedIds: input.ids === "all" ? [] : input.ids.filter((id) => !matchedIds.has(id)) };
}

export function buildLearningApplicationPlan(queue: LearningApprovalQueue, selectedIds: string[] | "all" = "all"): LearningApplicationPlan {
  const requestedIds = selectedIds === "all" ? queue.items.filter((item) => item.status === "approved").map((item) => item.proposalId) : selectedIds;
  const requestedSet = new Set(requestedIds); const selected = queue.items.filter((item) => item.status === "approved" && (requestedSet.has(item.id) || requestedSet.has(item.proposalId))); const matched = new Set(selected.flatMap((item) => [item.id, item.proposalId]));
  const actions = selected.map((item, index) => buildAction(queue.projectRootUri, item, index + 1)); const approvedCount = queue.items.filter((item) => item.status === "approved").length;
  const summary = actions.length ? [`${actions.length} action plan(s) prepared from approved learning proposals.`, `${actions.filter((action) => action.dangerGate === "approval_required").length} high-risk action(s) still require approval.`, `${actions.filter((action) => action.dangerGate === "none").length} low/medium-risk local action(s) are prepared.`, `${actions.filter((action) => action.dangerGate === "none" && ["apply_tuning_overlay", "refresh_routing_recommendations"].includes(action.actionType)).length} owned local optimization action(s) can run in the current autonomous apply lane.`, "This plan does not apply source, provider, reusable bundle, command, network, or export changes."] : [`No approved learning proposals selected. ${approvedCount} approved item(s) exist in the inbox.`];
  return { kind: "agentflow_learning_application_plan", projectRootUri: queue.projectRootUri, generatedAt: new Date().toISOString(), sourceGeneratedAt: queue.generatedAt, selectedIds: selected.map((item) => item.proposalId), skippedIds: requestedIds.filter((id) => !matched.has(id)), actions, summary };
}

function buildAction(project: string, item: LearningApprovalItem, index: number): LearningApplicationAction {
  const base = { id: `learn-action-${String(index).padStart(3, "0")}`, proposalId: item.proposalId, rationale: item.proposal.rationale };
  if (item.proposal.kind === "feedback_gap") return { ...base, title: "Collect feedback before changing behavior", actionType: "collect_feedback", dangerGate: "none", command: "npm run agentflow -- status --limit 10", writesOwnedLearningStateOnly: true, blockedUntil: ["A developer records accepted, revised, or rejected feedback for recent runs."] };
  if (item.proposal.kind === "eval_gap") return { ...base, title: "Create a small local evaluation suite", actionType: "create_eval", dangerGate: "approval_required", command: `npm run agentflow -- candidate-comparison-plan --project ${quote(project)}`, writesOwnedLearningStateOnly: false, blockedUntil: ["A developer approves evaluation file generation and any follow-up model runs."] };
  if (item.proposal.kind === "repeated_failure") return { ...base, title: "Queue a focused debug workflow", actionType: "debug_failure", dangerGate: "approval_required", command: `npm run agentflow -- run-and-watch debug-failure --project ${quote(project)} --task ${quote(`Investigate learning proposal ${item.proposalId}: ${item.proposal.title}. Target: ${item.proposal.target}`)}`, writesOwnedLearningStateOnly: false, blockedUntil: ["A developer approves running workflow commands for this project."] };
  if (item.proposal.kind === "cost_routing" || item.proposal.kind === "proposal_followup") return { ...base, title: "Apply project-local tuning overlay", actionType: "apply_tuning_overlay", dangerGate: "none", command: `npm run agentflow -- apply-tuning-proposals --project ${quote(project)} --ids all --write`, writesOwnedLearningStateOnly: true, blockedUntil: [] };
  if (item.proposal.kind === "route_feedback") return { ...base, title: "Refresh savings-aware routing recommendations", actionType: "refresh_routing_recommendations", dangerGate: "none", command: `npm run agentflow -- local-llm-routing-recommendations --project ${quote(project)} --write`, writesOwnedLearningStateOnly: true, blockedUntil: [] };
  return { ...base, title: "Manual learning review", actionType: "manual_review", dangerGate: "approval_required", command: null, writesOwnedLearningStateOnly: false, blockedUntil: ["A developer decides the correct next action."] };
}
