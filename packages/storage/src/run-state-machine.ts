export const workflowRunStatuses = [
  "queued",
  "leased",
  "running",
  "completed",
  "blocked",
  "failed",
  "cancelled"
] as const;

export type WorkflowRunState = (typeof workflowRunStatuses)[number];
export type TerminalWorkflowRunState = Extract<WorkflowRunState, "completed" | "blocked" | "failed" | "cancelled">;

const terminalStates = new Set<WorkflowRunState>(["completed", "blocked", "failed", "cancelled"]);
const allowedTransitions: Readonly<Record<WorkflowRunState, ReadonlySet<WorkflowRunState>>> = {
  queued: new Set(["leased", "cancelled"]),
  leased: new Set(["running", "blocked", "failed", "cancelled"]),
  running: new Set(["completed", "blocked", "failed", "cancelled"]),
  completed: new Set(),
  blocked: new Set(),
  failed: new Set(),
  cancelled: new Set()
};

export function isWorkflowRunState(value: string): value is WorkflowRunState {
  return (workflowRunStatuses as readonly string[]).includes(value);
}

export function isTerminalWorkflowRunState(value: WorkflowRunState): value is TerminalWorkflowRunState {
  return terminalStates.has(value);
}

export function assertWorkflowRunTransition(from: WorkflowRunState, to: WorkflowRunState): "transition" | "idempotent" {
  if (from === to) return "idempotent";
  if (isTerminalWorkflowRunState(from)) {
    throw new Error(`Workflow run terminal state is immutable: ${from} -> ${to}.`);
  }
  if (!allowedTransitions[from].has(to)) {
    throw new Error(`Invalid workflow run transition: ${from} -> ${to}.`);
  }
  return "transition";
}

export function assertWorkflowRunFence(
  current: { leaseEpoch: string; leaseOwner: string | null },
  expected: { leaseEpoch: string; leaseOwner: string }
): void {
  if (current.leaseEpoch !== expected.leaseEpoch || current.leaseOwner !== expected.leaseOwner) {
    throw new Error("Stale workflow run fencing token.");
  }
}
