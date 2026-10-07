import { withClient } from "./client.js";

export const recordedLifecycleActions = ["workflow_created", "failed_run_dismissed", "failed_run_superseded", "failed_run_reinstated", "checkpoint_resume_requested", "workflow_run_transition", "workflow_replayed", "stage_leased", "stage_started", "stage_completed", "stage_blocked", "stage_failed", "stage_cancelled", "stage_requeued", "stage_continuation_scheduled", "action_approval_requested", "action_approval_approved", "action_approval_rejected", "action_approval_executing", "action_approval_expired", "action_approval_executed", "action_approval_failed", "action_approval_dismissed", "action_approval_execution_recovered"] as const;

export function recordedLifecycleEvent(input: {
  runId: string; actionType: string; target: string; summary: string;
  receiptHash: string; createdAt: string; approvalId?: string | null;
}) {
  if (!(recordedLifecycleActions as readonly string[]).includes(input.actionType)) return null;
  return { version: 1 as const, type: input.actionType.startsWith("stage_") ? "stage.changed"
    : input.actionType.startsWith("action_approval_") ? "approval.changed" : "run.changed",
  id: input.receiptHash, runId: input.runId, action: input.actionType,
  subject: input.approvalId ?? input.target, summary: input.summary, occurredAt: input.createdAt,
  cursor: input.createdAt, authority: "evidence-only" as const };
}

/** Authenticated adapters must authorize the project first. Receipt timestamps
 * are strictly increasing per run under the parent-row lock. No raw metadata.
 */
export async function replayRecordedLifecycleEvents(input: {
  projectRootUri: string; runId: string; after?: string; limit?: number;
}) {
  const after = input.after ?? "1970-01-01T00:00:00.000Z";
  const limit = input.limit ?? 100;
  if (!input.projectRootUri.trim() || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(input.runId)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(after)
    || !Number.isFinite(Date.parse(after)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid recorded lifecycle scope or cursor.");
  return withClient(async client => {
    const rows = await client.query<{ runId: string; actionType: string; target: string; summary: string; receiptHash: string; createdAt: Date; approvalId: string | null }>(
      `select a.run_id::text as "runId", a.action_type as "actionType", a.target, a.summary,
        a.receipt_hash as "receiptHash", a.created_at as "createdAt", a.metadata->>'approvalId' as "approvalId"
       from action_receipts a join workflow_runs r on r.id=a.run_id join projects p on p.id=r.project_id
       where p.root_uri=$1 and a.run_id=$2::uuid and a.created_at>$3::timestamptz
         and a.action_type=any($4::text[]) and a.metadata_serialization_version=2
       order by a.created_at limit $5`, [input.projectRootUri, input.runId, after, recordedLifecycleActions, limit]);
    return rows.rows.map(row => recordedLifecycleEvent({ ...row, createdAt: row.createdAt.toISOString() }))
      .filter((event): event is NonNullable<typeof event> => event !== null);
  });
}
