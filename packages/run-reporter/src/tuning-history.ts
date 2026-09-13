export type TuningHistoryStatus = "queued" | "approved" | "rejected" | "applied" | "reverted" | "superseded";
export interface TuningApprovalHistory { kind: "agentflow_tuning_approval_history"; projectRootUri: string; updatedAt: string; events: TuningApprovalHistoryEvent[] }
export interface TuningApprovalHistoryEvent { id: string; proposalId: string; status: TuningHistoryStatus; occurredAt: string; actor?: string; note?: string; relatedProposalId?: string }

export function appendTuningApprovalHistory(history: TuningApprovalHistory | undefined, input: { projectRootUri: string; proposalIds: string[]; status: TuningHistoryStatus; actor?: string; note?: string; relatedProposalId?: string; occurredAt?: string }): TuningApprovalHistory {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const events = input.proposalIds.map((proposalId, index) => ({ id: `tuning-event-${occurredAt.replace(/[^0-9]/g, "")}-${index + 1}`, proposalId, status: input.status, occurredAt, actor: input.actor, note: input.note, relatedProposalId: input.relatedProposalId }));
  return { kind: "agentflow_tuning_approval_history", projectRootUri: input.projectRootUri, updatedAt: occurredAt, events: [...(history?.events ?? []), ...events] };
}

export function formatTuningApprovalHistory(history: TuningApprovalHistory): string {
  const counts = history.events.reduce<Record<string, number>>((result, event) => { result[event.status] = (result[event.status] ?? 0) + 1; return result; }, {});
  return [`Tuning Approval History: ${history.projectRootUri}`, `Updated: ${history.updatedAt}`, `Events: ${history.events.length}`, `Counts: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(" ") || "none"}`, "", ...history.events.slice().reverse().map((event) => [`- ${event.occurredAt} ${event.proposalId}: ${event.status}`, event.actor ? `  - Actor: ${event.actor}` : "", event.relatedProposalId ? `  - Related proposal: ${event.relatedProposalId}` : "", event.note ? `  - Note: ${event.note}` : ""].filter(Boolean).join("\n"))].join("\n");
}

export function formatTuningApprovalHistoryMarkdown(history: TuningApprovalHistory): string { return `# Agent Workflow Tuning Approval History\n\n${formatTuningApprovalHistory(history)}\n`; }
