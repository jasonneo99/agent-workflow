import type { WorkflowHandoffStatus } from "./postgres.js";

const handoffTransitions: Record<WorkflowHandoffStatus, readonly WorkflowHandoffStatus[]> = {
  proposed: ["accepted", "rejected"],
  accepted: ["retrying", "completed", "failed"],
  rejected: ["retrying"],
  retrying: ["accepted", "rejected", "completed", "failed"],
  completed: [],
  failed: ["retrying"]
};

export function assertWorkflowHandoffTransition(from: WorkflowHandoffStatus, to: WorkflowHandoffStatus): void {
  if (!handoffTransitions[from]?.includes(to)) {
    throw new Error(`Invalid workflow handoff transition: ${from} -> ${to}`);
  }
}
