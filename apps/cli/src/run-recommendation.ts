export function recommendRunNextAction(input: {
  status: string;
  workflowId: string;
  failedTasks: number;
  failures: string[];
  blockedReason?: string | null;
  pendingApprovals?: number;
  replacementRunId?: string | null;
}): string {
  if (input.replacementRunId) {
    return `Open continuation run ${input.replacementRunId.slice(0, 8)}; this run is immutable history.`;
  }
  if ((input.pendingApprovals ?? 0) > 0) {
    return `Review the ${input.pendingApprovals} pending approval${input.pendingApprovals === 1 ? "" : "s"}; approved actions resume through the governed executor.`;
  }
  if (input.status === "blocked") {
    const reason = input.blockedReason?.trim();
    return reason
      ? `Resolve this blocker, then continue from the saved checkpoint: ${reason}`
      : "Continue from the saved checkpoint; if it blocks again, open the stage evidence for the missing prerequisite.";
  }
  if (input.status === "failed" || input.failedTasks > 0 || input.failures.length) {
    const firstFailure = input.failures[0]?.trim();
    return firstFailure
      ? `Retry the failing stage after addressing: ${firstFailure}`
      : "Retry the failing stage from its saved checkpoint.";
  }
  if (input.workflowId.startsWith("agent-task-ux-reviewer")) {
    return "Ask `frontend-engineer` to implement the highest-impact UX findings, then rerun `ux-reviewer`.";
  }
  if (input.workflowId === "review-pr") {
    return "Address the highest-risk review findings, then rerun `review-pr` before shipping.";
  }
  if (input.workflowId === "build-feature" || input.workflowId.startsWith("dynamic-feature-delivery-")) {
    return "Review the delivered changes and verification evidence, then accept them or request a specific revision.";
  }
  return "Review the recorded outcome and evidence, then accept it or request a focused follow-up.";
}
