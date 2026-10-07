import { createHash, randomBytes } from "node:crypto";
import { withClient } from "./client.js";

/** Additive and opt-in: registration alone never sends or starts a consumer. */
export const notificationSubscriberSchemaSql = `
 create table if not exists notification_subscribers (
   id uuid primary key default gen_random_uuid(), project_root_uri text not null,
   channel text not null, task_id text not null, token_hash text not null unique,
   active boolean not null default true, created_at timestamptz not null default now()
 );
 create table if not exists notification_deliveries (
   subscriber_id uuid not null references notification_subscribers(id),
   notification_id uuid not null references run_notifications(id),
   status text not null default 'pending' check(status in ('pending','failed','delivered')),
   attempt_count integer not null default 0, available_at timestamptz not null default now(),
   claim_owner text, claim_token uuid, claim_expires_at timestamptz,
   delivered_at timestamptz, acknowledged_at timestamptz,
   primary key(subscriber_id,notification_id)
 );`;

const hash = (token: string): string => createHash("sha256").update(token).digest("hex");
/** Administrative API: caller must authorize the project and receiver first.
 * Returned bearer secret is shown once; only its digest is persisted.
 */
export async function registerNotificationSubscriber(input: { projectRootUri: string; channel: string; taskId: string }) {
  if (![input.projectRootUri, input.channel, input.taskId].every(value => value.trim())) throw new Error("Explicit subscriber binding required.");
  const token = randomBytes(32).toString("hex");
  return withClient(async client => {
    const result = await client.query<{ id: string }>(`insert into notification_subscribers(project_root_uri,channel,task_id,token_hash)
      select $1,$2,$3,$4 where exists(select 1 from projects where root_uri=$1) returning id::text`,
    [input.projectRootUri,input.channel,input.taskId,hash(token)]);
    if (!result.rows[0]) throw new Error("Registered project required.");
    return { subscriberId: result.rows[0].id, token };
  });
}

/** Exact selection materializes one independent delivery, never a global drain. */
export async function claimSubscriberNotification(input: { subscriberId: string; notificationId: string; owner: string; projectRootUri: string }) {
  if (!input.owner.trim() || !input.projectRootUri.trim()) throw new Error("Explicit subscriber claim scope required.");
  return withClient(async client => {
    await client.query("begin");
    try {
      await client.query(`insert into notification_deliveries(subscriber_id,notification_id)
        select s.id,n.id from notification_subscribers s join projects p on p.root_uri=s.project_root_uri
        join workflow_runs r on r.project_id=p.id join run_notifications n on n.run_id=r.id
        where s.id=$1::uuid and n.id=$2::uuid and s.project_root_uri=$3 and s.active
        on conflict do nothing`, [input.subscriberId,input.notificationId,input.projectRootUri]);
      const result = await client.query<{ id: string; runId: string; channel: string; kind: string; title: string; body: string; originTaskId: string; claimToken: string }>(`
        update notification_deliveries d set claim_owner=$4,claim_token=gen_random_uuid(),
          claim_expires_at=now()+interval '120 seconds',attempt_count=attempt_count+1
        from notification_subscribers s,run_notifications n,workflow_runs r,projects p
        where d.subscriber_id=$1::uuid and d.notification_id=$2::uuid and s.id=d.subscriber_id
          and s.project_root_uri=$3 and s.active and n.id=d.notification_id
          and r.id=n.run_id and p.id=r.project_id and p.root_uri=s.project_root_uri
          and d.status in ('pending','failed') and d.available_at<=now()
          and (d.claim_expires_at is null or d.claim_expires_at<=now())
        returning n.id::text,n.run_id::text as "runId",s.channel,n.kind,n.title,n.body,
          s.task_id as "originTaskId",d.claim_token::text as "claimToken"`,
      [input.subscriberId,input.notificationId,input.projectRootUri,input.owner]);
      await client.query("commit");
      return result.rows;
    } catch (error) { await client.query("rollback"); throw error; }
  });
}

/** Administrative revocation; in-flight network sends cannot be recalled. */
export async function revokeNotificationSubscriber(input: { subscriberId: string; projectRootUri: string }): Promise<boolean> {
  return withClient(async client => (await client.query(`update notification_subscribers set active=false
    where id=$1::uuid and project_root_uri=$2 and active`, [input.subscriberId,input.projectRootUri])).rowCount === 1);
}

export async function settleSubscriberNotification(input: { subscriberId: string; notificationId: string; projectRootUri: string; owner: string; claimToken: string; transportDelivered: boolean }) {
  return withClient(async client => (await client.query(`update notification_deliveries d
    set status=case when $6 then 'delivered' else 'failed' end,
      delivered_at=case when $6 then coalesce(d.delivered_at,now()) else d.delivered_at end,
      available_at=case when $6 then d.available_at else now()+least(3600,5*power(2,least(d.attempt_count-1,10)))*interval '1 second' end,
      claim_owner=null,claim_token=null,claim_expires_at=null
    from notification_subscribers s where s.id=d.subscriber_id and s.active and s.project_root_uri=$3
      and d.subscriber_id=$1::uuid and d.notification_id=$2::uuid and d.claim_owner=$4 and d.claim_token=$5::uuid
      and d.claim_expires_at>now() and d.status in ('pending','failed')`,
  [input.subscriberId,input.notificationId,input.projectRootUri,input.owner,input.claimToken,input.transportDelivered])).rowCount === 1);
}

/** Bearer credential identifies the receiver binding; body cannot choose it. */
export async function acknowledgeSubscriberNotification(input: { token: string; notificationId: string; runId: string }): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/u.test(input.token)) return false;
  return withClient(async client => (await client.query(`update notification_deliveries d
    set acknowledged_at=coalesce(d.acknowledged_at,now())
    from notification_subscribers s,run_notifications n,workflow_runs r,projects p
    where s.id=d.subscriber_id and s.active and s.token_hash=$1
      and n.id=d.notification_id and n.id=$2::uuid and n.run_id=$3::uuid
      and r.id=n.run_id and p.id=r.project_id and p.root_uri=s.project_root_uri
      and d.status='delivered' and d.delivered_at is not null`,
  [hash(input.token),input.notificationId,input.runId])).rowCount === 1);
}
