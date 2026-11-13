import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { databaseUrl } from "./client.js";
import { replayRunLifecycleEvents } from "./lifecycle-event.js";
import { acknowledgeClientRunNotification, acknowledgeRunNotification, claimRunNotifications, enqueueRunNotification, runNotificationOutboxSchemaSql, settleRunNotification, coalesceRunNotificationProgress, beginRunNotificationQueue, recordRunNotificationQueued } from "./run-notifications.js";

test("invalid claim bounds reject before database acquisition", async () => {
  const scope = { projectRootUri: "/synthetic/project-a", owner: "synthetic-owner" };
  const originalConnect = pg.Pool.prototype.connect;
  pg.Pool.prototype.connect = (async () => { throw new Error("Unexpected database acquisition"); }) as unknown as typeof originalConnect;
  try {
    for (const limit of [0, 51, -1, 1.5, NaN, Infinity]) {
      await assert.rejects(claimRunNotifications({ ...scope, limit }), /claim limit must be an integer/u);
    }
    await assert.rejects(claimRunNotifications({ ...scope, notificationId: "" }), /notification identity/u);
    for (const leaseSeconds of [0, 119, 3601, 120.5, NaN, Infinity]) {
      await assert.rejects(claimRunNotifications({ ...scope, leaseSeconds }), /claim lease must be an integer/u);
    }
  } finally { pg.Pool.prototype.connect = originalConnect; }
});
test("isolated outbox preserves event, project, claim, retry and acknowledgment boundaries", async () => {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
  const originalConnect = pg.Pool.prototype.connect;
  const runA = "00000000-0000-4000-8000-000000000001";
  const runB = "00000000-0000-4000-8000-000000000002";
  const taskId = "123e4567-e89b-42d3-a456-426614174000";
  const scope = { projectRootUri: "/synthetic/project-a", owner: "synthetic-owner" };
  try {
    await client.connect();
    await client.query("set search_path to pg_temp");
    await client.query("create temporary table projects (id uuid primary key, root_uri text)");
    await client.query("create temporary table workflow_runs (id uuid primary key, project_id uuid, requester_channel text, evaluation_metadata jsonb)");
    await client.query("create temporary table workflow_run_transitions (run_id uuid, state_version bigint, from_status text, to_status text, created_at timestamptz default now(), reason text)");
    await client.query("create temporary table run_notifications (id uuid primary key default gen_random_uuid(), run_id uuid, channel text, kind text, title text, body text, status text default 'pending', created_at timestamptz default now(), delivered_at timestamptz)");
    await client.query("create temporary table action_receipts (run_id uuid, receipt_hash text, action_type text, metadata_serialization_version integer)");
    await client.query(runNotificationOutboxSchemaSql);
    await client.query("insert into projects values ($1,$2),($3,$4)", [runA, scope.projectRootUri, runB, "/synthetic/project-b"]);
    await client.query("insert into workflow_runs values ($1,$1,'dashboard',$3::jsonb),($2,$2,'dashboard',$3::jsonb)", [runA, runB, JSON.stringify({ codexThreadId: taskId })]);
    const isolated = Object.assign(client, { release() {} });
    pg.Pool.prototype.connect = (async () => isolated) as unknown as typeof originalConnect;
    const intent = { runId: runA, kind: "blocked" as const, eventKey: "transition:1", title: "Synthetic blocked" };
    const id = await enqueueRunNotification(client, intent);
    assert.equal(await enqueueRunNotification(client, { ...intent, title: "Changed rendering" }), id);
    const otherId = await enqueueRunNotification(client, { ...intent, runId: runB });
    assert.deepEqual(await claimRunNotifications({ ...scope, notificationId: otherId }), []);
    assert.deepEqual(await claimRunNotifications({ ...scope, notificationId: runB }), []);
    await client.query("insert into workflow_run_transitions(run_id,state_version,from_status,to_status,reason) values ($1,1,'queued','leased','claimed'),($1,2,'leased','running','started'),($1,3,'running','completed','result ready'),($2,1,'queued','cancelled','cancelled')", [runA, runB]);
    const events = await replayRunLifecycleEvents({ projectRootUri: scope.projectRootUri, runId: runA });
    assert.deepEqual(events.map(event => event.sequence), ["1", "2", "3"]);
    assert.equal(events[2].result?.acceptance, "unverified");
    assert.deepEqual(await replayRunLifecycleEvents({ projectRootUri: scope.projectRootUri, runId: runB }), []);
    assert.deepEqual(await replayRunLifecycleEvents({ projectRootUri: scope.projectRootUri, runId: runA, afterSequence: "2" }), [events[2]]);
    assert.deepEqual(await replayRunLifecycleEvents({ projectRootUri: scope.projectRootUri, runId: runA, afterSequence: "3" }), []);
    assert.notEqual(id, otherId);
    assert.equal((await client.query("select count(*)::int as count from run_notifications")).rows[0].count, 2);
    const [first] = await claimRunNotifications({ ...scope, limit: 1, notificationId: id });
    assert.equal(first.id, id);
    assert.equal(first.originTaskId, taskId);
    assert.equal(first.attemptCount, 1);
    assert.deepEqual(await claimRunNotifications({ ...scope, owner: "competing-owner" }), []);
    const settlement = { ...scope, notificationId: id, claimToken: first.claimToken, transportDelivered: false };
    assert.equal(await settleRunNotification({ ...settlement, projectRootUri: "/synthetic/project-b" }), false);
    assert.equal(await settleRunNotification({ ...settlement, owner: "wrong-owner" }), false);
    assert.equal(await settleRunNotification({ ...settlement, claimToken: runB }), false);
    const acknowledgment = { projectRootUri: scope.projectRootUri, notificationId: id, runId: runA, authenticatedTaskId: taskId };
    assert.equal(await acknowledgeRunNotification(acknowledgment), false);
    assert.equal(await settleRunNotification(settlement), true);
    const failed = (await client.query("select status, delivered_at, acknowledged_at, available_at > now() as backed_off from run_notifications where id=$1", [id])).rows[0];
    assert.deepEqual(failed, { status: "failed", delivered_at: null, acknowledged_at: null, backed_off: true });
    assert.deepEqual(await claimRunNotifications(scope), []);
    await client.query("update run_notifications set available_at=now()-interval '1 second' where id=$1", [id]);
    const [second] = await claimRunNotifications(scope);
    assert.equal(second.attemptCount, 2);
    assert.notEqual(second.claimToken, first.claimToken);
    assert.equal(await settleRunNotification({ ...settlement, transportDelivered: true }), false);
    await client.query("update run_notifications set claim_expires_at=now()-interval '1 second' where id=$1", [id]);
    const [recovered] = await claimRunNotifications({ ...scope, owner: "synthetic-restarted-owner" });
    assert.equal(recovered.id, id);
    assert.equal(recovered.attemptCount, 3);
    assert.notEqual(recovered.claimToken, second.claimToken);
    assert.equal(await settleRunNotification({ ...settlement, claimToken: second.claimToken, transportDelivered: true }), false);
    const recoveredSettlement = { ...settlement, owner: "synthetic-restarted-owner", claimToken: recovered.claimToken, transportDelivered: true };
    assert.equal(await settleRunNotification(recoveredSettlement), true);
    const delivered = (await client.query("select delivered_at, acknowledged_at from run_notifications where id=$1", [id])).rows[0];
    assert.ok(delivered.delivered_at instanceof Date);
    assert.equal(delivered.acknowledged_at, null);
    assert.equal(await acknowledgeRunNotification({ ...acknowledgment, projectRootUri: "/synthetic/project-b" }), false);
    assert.equal(await acknowledgeRunNotification({ ...acknowledgment, runId: runB }), false);
    assert.equal(await acknowledgeRunNotification({ ...acknowledgment, authenticatedTaskId: runB }), false);
    assert.equal(await acknowledgeRunNotification({ ...acknowledgment, authenticatedTaskId: " " }), false);
    assert.equal(await acknowledgeRunNotification(acknowledgment), true);
    const acknowledged = (await client.query("select delivered_at, acknowledged_at from run_notifications where id=$1", [id])).rows[0];
    assert.ok(acknowledged.acknowledged_at instanceof Date);
    assert.equal(await acknowledgeRunNotification(acknowledgment), true);
    assert.equal(await settleRunNotification({ ...recoveredSettlement, transportDelivered: false }), false);
    assert.equal(await enqueueRunNotification(client, intent), id);
    assert.deepEqual((await client.query("select delivered_at, acknowledged_at from run_notifications where id=$1", [id])).rows[0], acknowledged);
    assert.deepEqual(await claimRunNotifications(scope), []);
    const [other] = await claimRunNotifications({ projectRootUri: "/synthetic/project-b", owner: "synthetic-other-owner" });
    assert.equal(other.id, otherId);
    assert.equal(other.attemptCount, 1);
    // A non-Codex receiver uses an independently authenticated, case-sensitive binding.
    const portableId = "00000000-0000-4000-8000-000000000003";
    await client.query("insert into run_notifications(id,run_id,channel,kind,title,body,origin_task_id) values($1,$2,'synthetic-client','message','Synthetic','Arrival test','Task-A')", [portableId, runA]);
    const portableAck = { notificationId: portableId, runId: runA,
      authenticatedBinding: { projectRootUri: scope.projectRootUri, channel: "synthetic-client", taskId: "Task-A" } };
    assert.equal(await acknowledgeClientRunNotification(portableAck), false, "pending delivery cannot be acknowledged");
    const [portableClaim] = await claimRunNotifications({ ...scope, notificationId: portableId });
    assert.equal(await settleRunNotification({ ...scope, notificationId: portableId, claimToken: portableClaim.claimToken, transportDelivered: true }), true);
    for (const binding of [
      { ...portableAck.authenticatedBinding, projectRootUri: "/synthetic/project-b" },
      { ...portableAck.authenticatedBinding, channel: "codex" },
      { ...portableAck.authenticatedBinding, taskId: "task-a" },
      { ...portableAck.authenticatedBinding, taskId: " " },
      { ...portableAck.authenticatedBinding, channel: " " },
      { ...portableAck.authenticatedBinding, projectRootUri: " " }
    ]) assert.equal(await acknowledgeClientRunNotification({ ...portableAck, authenticatedBinding: binding }), false);
    assert.equal(await acknowledgeClientRunNotification({ ...portableAck, runId: runB }), false);
    assert.equal(await acknowledgeRunNotification({ ...acknowledgment, notificationId: portableId, authenticatedTaskId: "Task-A" }), false);
    assert.equal(await acknowledgeClientRunNotification(portableAck), true);
    const arrival = (await client.query("select acknowledged_at from run_notifications where id=$1", [portableId])).rows[0].acknowledged_at;
    assert.ok(arrival instanceof Date);
    assert.equal(await acknowledgeClientRunNotification(portableAck), true);
    assert.deepEqual((await client.query("select acknowledged_at from run_notifications where id=$1", [portableId])).rows[0].acknowledged_at, arrival);
    await assert.rejects(enqueueRunNotification(client, { ...intent, eventKey: " " }), /identity/u);
    await client.query("begin");
    const orderedIds = [];
    for (let i=0;i<4;i++) orderedIds.push(await enqueueRunNotification(client,{...intent,eventKey:`ordered:${i}`}));
    const ordered = (await client.query("select id,created_at from run_notifications where id=any($1::uuid[]) order by created_at,id",[orderedIds])).rows;
    assert.deepEqual(ordered.map(row=>row.id),orderedIds);
    for(let i=1;i<ordered.length;i++) assert.ok(ordered[i].created_at.getTime()>ordered[i-1].created_at.getTime());
    await enqueueRunNotification(client,{...intent,eventKey:"ordered:0"});
    assert.equal((await client.query("select created_at from run_notifications where id=$1",[orderedIds[0]])).rows[0].created_at.getTime(),ordered[0].created_at.getTime());
    await client.query("rollback");
    // Flood regression: retain every event, protect actionable notices and active claims.
    const progress: string[] = [];
    for (let i=0;i<3;i++) progress.push(await enqueueRunNotification(client,{...intent,
      kind:"progress",eventKey:`flood:${i}`,title:"stage started",body:`original-${i}`}));
    const held = (await claimRunNotifications({...scope,notificationId:progress[2]}))[0];
    const protectedIds: string[]=[];
    for (const kind of ["blocked","approval_needed","action_needed","completed","failed"] as const)
      protectedIds.push(await enqueueRunNotification(client,{...intent,kind,eventKey:`protected:${kind}`}));
    const semanticBlock=await enqueueRunNotification(client,{...intent,kind:"progress",title:"stage blocked",eventKey:"semantic-block"});
    const foreignProgress=await enqueueRunNotification(client,{...intent,runId:runB,kind:"progress",eventKey:"foreign-progress"});
    await enqueueRunNotification(client,{...intent,runId:runB,kind:"completed",eventKey:"foreign-terminal"});
    const beforeCount=(await client.query("select count(*)::int as n from run_notifications")).rows[0].n;
    const preview=await coalesceRunNotificationProgress({...scope,dryRun:true});
    assert.ok(preview.some(r=>r.id===progress[0]));
    assert.ok(!preview.some(r=>[progress[2],semanticBlock,...protectedIds,foreignProgress].includes(r.id)));
    assert.equal((await client.query("select status from run_notifications where id=$1",[progress[0]])).rows[0].status,"pending");
    await coalesceRunNotificationProgress(scope);
    assert.deepEqual((await client.query("select status,body,coalesced_reason,acknowledged_at from run_notifications where id=$1",[progress[0]])).rows[0],
      {status:"coalesced",body:"original-0",coalesced_reason:"superseded-progress",acknowledged_at:null});
    assert.equal((await client.query("select count(*)::int as n from run_notifications")).rows[0].n,beforeCount);
    assert.deepEqual(await claimRunNotifications({...scope,notificationId:progress[0]}),[]);
    assert.equal(await settleRunNotification({...scope,notificationId:held.id,claimToken:held.claimToken,transportDelivered:false}),true);

    // Queue acceptance survives dispatcher death before settlement and never implies ACK.
    const queued=await enqueueRunNotification(client,{...intent,eventKey:"queue-receipt"});
    const q=(await claimRunNotifications({...scope,notificationId:queued}))[0];
    const fence={...scope,notificationId:q.id,claimToken:q.claimToken};
    assert.equal(await beginRunNotificationQueue({...fence,owner:"foreign"}),false);
    assert.equal(await beginRunNotificationQueue(fence),true);
    assert.equal(await beginRunNotificationQueue(fence),false,"cannot start a second queue attempt");
    const acceptance={...fence,messageId:"00000000-0000-4000-8000-000000000099",taskId};
    assert.equal(await recordRunNotificationQueued({...acceptance,taskId:runB}),false);
    assert.equal(await recordRunNotificationQueued(acceptance),true);
    assert.equal(await settleRunNotification({...fence,transportDelivered:false}),false,"failure cannot undo known acceptance");
    await client.query("update run_notifications set claim_expires_at=now()-interval '1 second' where id=$1",[queued]);
    assert.deepEqual(await claimRunNotifications({...scope,owner:"restarted",notificationId:queued}),[]);
    const persisted=(await client.query("select status,transport_message_id,acknowledged_at from run_notifications where id=$1",[queued])).rows[0];
    assert.deepEqual(persisted,{status:"delivered",transport_message_id:acceptance.messageId,acknowledged_at:null});

    const ambiguous=await enqueueRunNotification(client,{...intent,eventKey:"uncertain-queue"});
    const u=(await claimRunNotifications({...scope,notificationId:ambiguous}))[0];
    const uncertainFence={...scope,notificationId:u.id,claimToken:u.claimToken};
    assert.equal(await beginRunNotificationQueue(uncertainFence),true);
    assert.equal(await settleRunNotification({...uncertainFence,transportDelivered:false,transportUncertain:true}),true);
    await client.query("update run_notifications set available_at=now()-interval '1 hour',claim_expires_at=now()-interval '1 second' where id=$1",[ambiguous]);
    assert.deepEqual(await claimRunNotifications({...scope,notificationId:ambiguous}),[],"ambiguous queue requires reconciliation, not duplicate retry");
    assert.equal(await acknowledgeRunNotification({...acknowledgment,notificationId:ambiguous}),false);
    // Receipt-backed dismissals group across runs, with independent destination and action groups.
    const runC = "00000000-0000-4000-8000-000000000004";
    await client.query("insert into workflow_runs values ($1,$2,'dashboard',$3::jsonb)", [runC,runA,JSON.stringify({codexThreadId:taskId})]);
    let receiptIndex = 0;
    const dismissal = async (runId: string, action = "failed_run_dismissed", channel = "codex") => {
      const hash = (++receiptIndex).toString(16).padStart(64,"0");
      await client.query("insert into action_receipts values ($1,$2,$3,2)",[runId,hash,action]);
      return enqueueRunNotification(client,{runId,kind:"progress",eventKey:`receipt:${hash}`,title:"Historical notice",body:"unchanged audit",channel});
    };
    const stale = await dismissal(runA);
    const approvalDismissal = await dismissal(runA,"action_approval_dismissed");
    const foreignDestination = await dismissal(runA);
    await client.query("update run_notifications set origin_task_id=$2 where id=$1",[foreignDestination,runB]);
    const foreignProject = await dismissal(runB);
    const foreignChannel = await dismissal(runA,"failed_run_dismissed","dashboard");
    const actionableReceipt = await dismissal(runA,"stage_blocked");
    const startedDismissal = await dismissal(runA);
    const acceptedDismissal = await dismissal(runA);
    await client.query("update run_notifications set transport_started_at=now() where id=$1",[startedDismissal]);
    await client.query("update run_notifications set transport_accepted_at=now(),status='failed' where id=$1",[acceptedDismissal]);
    const latest = await dismissal(runC);
    await client.query("update run_notifications set created_at=now()+interval '1 day' where id=$1",[latest]);
    const auditBefore = (await client.query("select * from action_receipts order by receipt_hash")).rows;
    const protectedDismissals = [approvalDismissal,foreignDestination,foreignProject,foreignChannel,actionableReceipt,startedDismissal,acceptedDismissal,latest];
    const previewDismissals = await coalesceRunNotificationProgress({...scope,dryRun:true});
    assert.ok(previewDismissals.some(row=>row.id===stale && row.into===latest));
    assert.ok(!previewDismissals.some(row=>protectedDismissals.includes(row.id)));
    await coalesceRunNotificationProgress(scope);
    assert.deepEqual((await client.query("select status,body,acknowledged_at,coalesced_into from run_notifications where id=$1",[stale])).rows[0],{status:"coalesced",body:"unchanged audit",acknowledged_at:null,coalesced_into:latest});
    assert.deepEqual((await client.query("select * from action_receipts order by receipt_hash")).rows,auditBefore);
    assert.ok(!(await coalesceRunNotificationProgress(scope)).some(row=>row.id===stale));
    for (const notificationId of [stale,startedDismissal,acceptedDismissal]) {
      assert.deepEqual(await claimRunNotifications({...scope,owner:"restarted-dismissal-dispatcher",notificationId}),[]);
      assert.deepEqual(await claimRunNotifications({...scope,owner:"repeated-dismissal-dispatcher",notificationId}),[]);
    }
    // Canonical routine receipt events coalesce, never actionable/unknown ones.
    const created = await dismissal(runC, "workflow_created");
    const leased = await dismissal(runC, "stage_leased");
    const started = await dismissal(runC, "stage_started");
    const checkpoint = await dismissal(runC, "stage_continuation_scheduled");
    const blocker = await dismissal(runC, "stage_blocked");
    const approval = await dismissal(runC, "action_approval_created");
    const completion = await dismissal(runC, "stage_completed");
    const unknown = await dismissal(runC, "unknown_event");
    const latestProgress = await dismissal(runC, "stage_started");
    const lifecycleAudit = (await client.query("select * from action_receipts order by receipt_hash")).rows;
    const lifecyclePreview = await coalesceRunNotificationProgress({...scope,dryRun:true});
    for (const id of [created,leased,started,checkpoint]) {
      assert.ok(lifecyclePreview.some(row=>row.id===id && row.into===latestProgress));
    }
    for (const id of [blocker,approval,completion,unknown,latestProgress]) {
      assert.ok(!lifecyclePreview.some(row=>row.id===id));
    }
    await coalesceRunNotificationProgress(scope);
    assert.deepEqual((await client.query("select * from action_receipts order by receipt_hash")).rows,lifecycleAudit);
    assert.deepEqual(await claimRunNotifications({...scope,notificationId:created}),[]);
  } finally {
    pg.Pool.prototype.connect = originalConnect;
    await client.end();
  }
});
