export type SupersessionRun = {
  id: string;
  workflowId: string;
  task: string;
  status: string;
  startedAt: string;
};

export function findLaterCompletedEquivalentRun<T extends SupersessionRun>(runs: readonly T[], source: SupersessionRun): T | null {
  const sourceStartedAt = Date.parse(source.startedAt);
  return runs.find((candidate) =>
    candidate.id !== source.id
    && candidate.status === "completed"
    && candidate.workflowId === source.workflowId
    && candidate.task.trim() === source.task.trim()
    && Date.parse(candidate.startedAt) > sourceStartedAt
  ) ?? null;
}
