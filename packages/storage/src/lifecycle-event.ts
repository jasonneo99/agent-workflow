import type { WorkflowRunState } from "./run-state-machine.js";
import { withClient } from "./client.js";
import { createHash } from "node:crypto";

export interface LifecycleResult {
  runId: string;
  acceptance: "unverified";
  artifacts?: Array<{ uri: string; kind: string; contentSha256: string }>;
  truncated?: boolean;
  obligations?: string[];
  deliverables?: Array<{ artifactUri: string; summary: string; status: "reported" }>;
  verification?: Array<{ artifactUri: string; kind: string; status: "unverified" }>;
}

/** Bounded result projection. Artifact assertions remain reported, not accepted. */
export function lifecycleResultSnapshot(runId: string, artifacts: Array<{ uri: string; kind: string; content: unknown }>): LifecycleResult {
  const selected = artifacts.slice(0, 50);
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const reportedObligations = selected.flatMap(artifact => {
    const obligations = object(artifact.content).openObligations;
    return Array.isArray(obligations) ? obligations.filter((value): value is string => typeof value === "string" && !!value.trim()).slice(0, 20) : [];
  }).slice(0, 20).map(value => `Artifact-reported: ${value.slice(0, 512)}`);
  return {
    runId, acceptance: "unverified",
    artifacts: selected.map(artifact => ({ uri: artifact.uri, kind: artifact.kind,
      contentSha256: createHash("sha256").update(JSON.stringify(artifact.content)).digest("hex") })),
    deliverables: selected.filter(artifact => artifact.kind === "stage_output").map(artifact => ({
      artifactUri: artifact.uri, status: "reported", summary: typeof object(artifact.content).summary === "string"
        ? (object(artifact.content).summary as string).slice(0, 512) : "Recorded stage output; inspect the referenced artifact."
    })),
    verification: selected.filter(artifact => artifact.kind !== "stage_output").map(artifact => ({ artifactUri: artifact.uri, kind: artifact.kind, status: "unverified" })),
    truncated: artifacts.length > 50,
    obligations: ["Independently verify acceptance gates, receipt chain and referenced artifact contents.",
      ...reportedObligations, ...(artifacts.length > 50 ? ["Retrieve additional authorized artifacts; this reference list is bounded."] : [])]
  };
}

/** Transport-independent identity. Receiving an event never authorizes an action. */
export interface RunLifecycleEvent {
  version: 1;
  id: string;
  type: "run.state_changed";
  runId: string;
  sequence: string;
  occurredAt: string;
  previousState: WorkflowRunState;
  state: WorkflowRunState;
  summary: string;
  result: LifecycleResult | null;
}

export function runLifecycleEvent(input: {
  runId: string; stateVersion: string; from: WorkflowRunState; to: WorkflowRunState;
  occurredAt: string; reason: string; result?: LifecycleResult | null;
}): RunLifecycleEvent {
  if (!/^[1-9]\d*$/u.test(input.stateVersion)) throw new Error("Invalid lifecycle sequence.");
  if (!Number.isFinite(Date.parse(input.occurredAt))) throw new Error("Invalid lifecycle timestamp.");
  return {
    version: 1, id: `${input.runId}:transition:${input.stateVersion}`,
    type: "run.state_changed", runId: input.runId, sequence: input.stateVersion,
    occurredAt: input.occurredAt, previousState: input.from, state: input.to,
    summary: input.reason,
    // Completion is a retrieval signal, not a claim that delivery gates passed.
    result: input.to === "completed" ? input.result ?? { runId: input.runId, acceptance: "unverified" } : null
  };
}

/** Trusted adapters must authorize project access before calling this API.
 * Per-run versions are serialized by the run lock, unlike a global sequence
 * allocated before commit. Replay is independent of delivery/acknowledgment.
 */
export async function replayRunLifecycleEvents(input: {
  projectRootUri: string; runId: string; afterSequence?: string; limit?: number;
}): Promise<RunLifecycleEvent[]> {
  const after = input.afterSequence ?? "0";
  const limit = input.limit ?? 100;
  if (!input.projectRootUri.trim() || !/^(0|[1-9]\d*)$/u.test(after)
    || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid lifecycle replay scope or bounds.");
  return withClient(async client => {
    const rows = await client.query<{
      runId: string; stateVersion: string; from: WorkflowRunState; to: WorkflowRunState;
      occurredAt: string; reason: string; notificationBody: string | null;
    }>(`select t.run_id::text as "runId", t.state_version::text as "stateVersion",
      t.from_status as "from", t.to_status as "to", t.created_at::text as "occurredAt", t.reason,
      (select n.body from run_notifications n
       where n.run_id=t.run_id and n.event_key='transition:' || t.state_version::text
       order by n.created_at,n.id limit 1) as "notificationBody"
      from workflow_run_transitions t join workflow_runs r on r.id=t.run_id
      join projects p on p.id=r.project_id
      where p.root_uri=$1 and t.run_id=$2::uuid and t.state_version>$3::bigint
      order by t.state_version limit $4`, [input.projectRootUri, input.runId, after, limit]);
    return rows.rows.map(row => {
      let result: LifecycleResult | null = null;
      // Legacy notifications can be plain text. Never make historical replay
      // depend on those renderings being valid JSON.
      try {
        const event = JSON.parse(row.notificationBody ?? "null");
        if (event?.type === "run.state_changed" && event.runId === row.runId
          && event.sequence === row.stateVersion && event.result?.runId === row.runId
          && event.result.acceptance === "unverified") result = event.result;
      } catch { /* Legacy rendering has no frozen result. */ }
      return runLifecycleEvent({ ...row, result });
    });
  });
}
