/** Run states shown in dashboard rollups. Blocked is its own state: a blocked
 * run waits for a person and must not be counted as active work. */
export type RunRollupState = "completed" | "failed" | "blocked" | "active" | "other";

export function runRollupState(status: string): RunRollupState {
  if (status === "completed" || status === "failed" || status === "blocked") return status;
  if (status === "queued" || status === "leased" || status === "running") return "active";
  return "other";
}

export function runStateCounts(runs: ReadonlyArray<{ status: string }>): Record<RunRollupState, number> {
  const counts: Record<RunRollupState, number> = { completed: 0, failed: 0, blocked: 0, active: 0, other: 0 };
  for (const run of runs) counts[runRollupState(run.status)] += 1;
  return counts;
}
