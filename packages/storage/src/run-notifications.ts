import type pg from "pg";
import { withClient } from "./client.js";
import type { NotificationKind } from "./run-notification-rendering.js";

/** Additive outbox fields preserve legacy rows and delivery timestamps. */
export const runNotificationOutboxSchemaSql = `
  ALTER TABLE run_notifications
    ADD COLUMN IF NOT EXISTS event_key text,
    ADD COLUMN IF NOT EXISTS origin_task_id text,
    ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS claim_owner text,
    ADD COLUMN IF NOT EXISTS claim_token uuid,
    ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz,
    ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
  ALTER TABLE run_notifications DROP CONSTRAINT IF EXISTS run_notifications_kind_check;
  ALTER TABLE run_notifications ADD CONSTRAINT run_notifications_kind_check
    CHECK (kind IN ('started','progress','approval_needed','action_needed','blocked','failed','recovered','completed','message'));
  CREATE UNIQUE INDEX IF NOT EXISTS run_notifications_event_key_idx
    ON run_notifications(run_id, channel, event_key) WHERE event_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS run_notifications_retry_idx
    ON run_notifications(available_at, created_at) WHERE status IN ('pending','failed');
`;

export interface NotificationIntent {
  runId: string;
  kind: NotificationKind;
  eventKey: string;
  title: string;
  body?: string;
  channel?: string;
}

/** Caller supplies a stable domain event identity, never a rendered title. */
export async function enqueueRunNotification(client: pg.Client, input: NotificationIntent): Promise<string> {
  if (!input.eventKey.trim()) throw new Error("Notification event identity is required.");
  const result = await client.query<{ id: string }>(`
    INSERT INTO run_notifications(run_id, channel, kind, title, body, event_key, origin_task_id)
    SELECT wr.id, coalesce($6::text, CASE WHEN wr.evaluation_metadata ? 'codexThreadId'
      THEN 'codex' ELSE wr.requester_channel END, 'dashboard'), $2, $3, $4, $5,
      wr.evaluation_metadata->>'codexThreadId'
    FROM workflow_runs wr WHERE wr.id=$1::uuid
    ON CONFLICT (run_id, channel, event_key) WHERE event_key IS NOT NULL
    DO UPDATE SET event_key=excluded.event_key
    RETURNING id::text`,
    [input.runId, input.kind, input.title, input.body ?? "", input.eventKey, input.channel ?? null]);
  if (!result.rows[0]) throw new Error("Notification run was not found.");
  return result.rows[0].id;
}

export interface ClaimedRunNotification {
  id: string; runId: string; channel: string; kind: string;
  title: string; body: string; originTaskId: string | null;
  claimToken: string; createdAt: string; attemptCount: number;
}

/** One short atomic statement; transport runs only after the claim commits. */
export async function claimRunNotifications(input: {
  projectRootUri: string; owner: string; limit?: number; leaseSeconds?: number;
}): Promise<ClaimedRunNotification[]> {
  if (!input.projectRootUri.trim() || !input.owner.trim()) throw new Error("Project and claim owner are required.");
  const limit = input.limit ?? 1;
  const lease = input.leaseSeconds ?? 120;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Notification claim limit must be an integer between 1 and 50.");
  }
  if (!Number.isInteger(lease) || lease < 120 || lease > 3600) {
    throw new Error("Notification claim lease must be an integer between 120 and 3600 seconds.");
  }
  return withClient(async (client) => (await client.query<ClaimedRunNotification>(`
    WITH candidates AS (
      SELECT n.id FROM run_notifications n
      JOIN workflow_runs wr ON wr.id=n.run_id JOIN projects p ON p.id=wr.project_id
      WHERE p.root_uri=$1 AND n.status IN ('pending','failed')
        AND n.available_at<=now()
        AND (n.claim_expires_at IS NULL OR n.claim_expires_at<=now())
      ORDER BY n.available_at,n.created_at,n.id LIMIT $3
      FOR UPDATE OF n SKIP LOCKED
    )
    UPDATE run_notifications n SET claim_owner=$2,claim_token=gen_random_uuid(),
      claim_expires_at=now()+($4::int*interval '1 second'),attempt_count=attempt_count+1
    FROM candidates WHERE n.id=candidates.id
    RETURNING n.id::text,n.run_id::text AS "runId",n.channel,n.kind,n.title,n.body,
      n.origin_task_id AS "originTaskId",n.claim_token::text AS "claimToken",
      n.created_at::text AS "createdAt",n.attempt_count AS "attemptCount"`,
    [input.projectRootUri, input.owner, limit, lease])).rows);
}

export async function settleRunNotification(input: {
  projectRootUri: string; owner: string; notificationId: string; claimToken: string;
  transportDelivered: boolean;
}): Promise<boolean> {
  return withClient(async (client) => (await client.query(`
    UPDATE run_notifications n SET status=CASE WHEN $5 THEN 'delivered' ELSE 'failed' END,
      delivered_at=CASE WHEN $5 THEN coalesce(n.delivered_at,now()) ELSE n.delivered_at END,
      available_at=CASE WHEN $5 THEN n.available_at ELSE now()+
        (least(3600,5*power(2,least(n.attempt_count-1,10))) * interval '1 second') END,
      claim_owner=NULL,claim_token=NULL,claim_expires_at=NULL
    FROM workflow_runs wr,projects p
    WHERE n.id=$3::uuid AND wr.id=n.run_id AND p.id=wr.project_id AND p.root_uri=$1
      AND n.claim_owner=$2 AND n.claim_token=$4::uuid AND n.claim_expires_at>now()
      AND n.status IN ('pending','failed')`,
    [input.projectRootUri,input.owner,input.notificationId,input.claimToken,input.transportDelivered])).rowCount === 1);
}

/** The caller must authenticate the task identity independently of message data.
 * This records arrival only; it grants no approval, repair or retry authority.
 */
export async function acknowledgeRunNotification(input: {
  projectRootUri: string; notificationId: string; runId: string; authenticatedTaskId: string;
}): Promise<boolean> {
  if (!input.authenticatedTaskId.trim()) return false;
  return withClient(async (client) => (await client.query(`
    UPDATE run_notifications n SET acknowledged_at=coalesce(n.acknowledged_at,now())
    FROM workflow_runs wr,projects p
    WHERE n.id=$2::uuid AND n.run_id=$3::uuid AND wr.id=n.run_id
      AND p.id=wr.project_id AND p.root_uri=$1 AND n.channel='codex'
      AND lower(n.origin_task_id)=lower($4) AND n.status='delivered' AND n.delivered_at IS NOT NULL`,
    [input.projectRootUri,input.notificationId,input.runId,input.authenticatedTaskId])).rowCount === 1);
}
