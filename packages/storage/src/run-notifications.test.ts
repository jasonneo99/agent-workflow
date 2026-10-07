import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { databaseUrl } from "./client.js";
import { replayRunLifecycleEvents } from "./lifecycle-event.js";
import { acknowledgeClientRunNotification, acknowledgeRunNotification, claimRunNotifications, enqueueRunNotification, runNotificationOutboxSchemaSql, settleRunNotification } from "./run-notifications.js";

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
  } finally {
    pg.Pool.prototype.connect = originalConnect;
    await client.end();
  }
});
