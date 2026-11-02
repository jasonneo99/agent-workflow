export type QueueLifecycleInput = {
  runStatus: string;
  queuedTasks: number;
  runningTasks: number;
  failedTasks?: number;
  approvalWait?: unknown;
};

/** Display task execution truth without rewriting the durable run lifecycle. */
export function queueLifecyclePresentation(item: QueueLifecycleInput): { key: string; label: string; active: boolean; explanation: string } {
  if (item.runStatus === "blocked") return { key: "blocked", label: "blocked", active: false, explanation: "The durable run is blocked." };
  if (item.runStatus === "failed" || (item.failedTasks ?? 0) > 0) return { key: "failed", label: "failed", active: false, explanation: "The run or a task failed." };
  if (item.runningTasks > 0) return { key: "running", label: "running", active: true, explanation: "At least one task has a current execution lease." };
  if (item.approvalWait) return { key: "awaiting-approval", label: "Awaiting approval", active: true, explanation: "Progress is saved; the unfinished stage is held for an exact approval." };
  if (item.queuedTasks > 0) return { key: "waiting", label: "waiting", active: true, explanation: "Work remains queued but no task currently has a worker lease." };
  if (item.runStatus === "queued" || item.runStatus === "leased" || item.runStatus === "running") {
    return { key: "stale", label: "needs reconciliation", active: false, explanation: "The run claims an active lifecycle but has no queued or worker-leased task." };
  }
  return { key: item.runStatus, label: item.runStatus, active: false, explanation: "The durable run lifecycle is terminal or awaiting review." };
}
