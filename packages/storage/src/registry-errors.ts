/** Map a missing registry row to an actionable setup message instead of a raw FK error. */
export function unregisteredDefinitionError(error: unknown): Error | undefined {
  const candidate = error as { code?: string; constraint?: string } | null;
  if (candidate?.code !== "23503") return undefined;
  if (candidate.constraint === "workflow_runs_workflow_id_fkey") {
    return new Error("This workflow is not registered in storage yet. Run `npm run bootstrap-storage` once to seed agent and workflow definitions, then retry.", { cause: error });
  }
  if (candidate.constraint?.endsWith("_agent_id_fkey")) {
    return new Error("An agent used by this workflow is not registered in storage yet. Run `npm run bootstrap-storage` to seed agent and workflow definitions, then retry.", { cause: error });
  }
  return undefined;
}
