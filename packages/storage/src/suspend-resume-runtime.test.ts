import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { InMemoryReceiptSink, SuspendResumeRuntime } from "../../suspend-resume-runtime/src/index.js";
import { databaseUrl } from "./client.js";
import { PostgresInputQueue, PostgresSliceStore, suspendResumeRuntimeSchemaSql } from "./suspend-resume-runtime.js";

async function isolatedRuntime<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
  const originalConnect = pg.Pool.prototype.connect;
  try {
    await client.connect();
    await client.query("set search_path to pg_temp,public");
    await client.query("create temporary table workflow_runs(id uuid primary key)");
    await client.query("create temporary table agents(id text primary key)");
    await client.query(`create temporary table action_approvals(id uuid primary key,status text,payload jsonb,decision_note text)`);
    await client.query(suspendResumeRuntimeSchemaSql);
    const isolated = Object.assign(client, { release() {} });
    pg.Pool.prototype.connect = (async () => isolated) as unknown as typeof originalConnect;
    return await run(client);
  } finally {
    pg.Pool.prototype.connect = originalConnect;
    await client.end();
  }
}

test("postgres queue resumes after reconstructed runtime and fences competing leases", async (context) => {
  try { await isolatedRuntime(async () => {
    let completions = 0;
    let store = new PostgresSliceStore();
    let queue = new PostgresInputQueue();
    await store.createThread("thread-a");
    await queue.enqueue({ id: "input-1",threadId:"thread-a",kind:"user_text",payload:"start",createdAt:new Date().toISOString() });
    const competitor = new PostgresInputQueue();
    const lease = await queue.lease("thread-a");
    assert.ok(lease);
    assert.equal(await competitor.lease("thread-a"), null);
    await lease.nack();
    const runtime = new SuspendResumeRuntime({ queue:competitor,store,model:{async complete(){completions+=1;return {message:"saved"};}},dispatchTool:async()=>undefined,receipts:new InMemoryReceiptSink() });
    await runtime.processNext("thread-a");

    store = new PostgresSliceStore();
    queue = new PostgresInputQueue();
    assert.deepEqual(await new SuspendResumeRuntime({ queue,store,model:{async complete(){completions+=1;return{};}},dispatchTool:async()=>undefined,receipts:new InMemoryReceiptSink() }).processNext("thread-a"),{outcome:"idle",threadId:"thread-a"});
    assert.equal(completions,1);
  }); } catch (error) {
    if (error instanceof Error && /Connection terminated/u.test(error.message)) { context.skip("local PostgreSQL host transport unavailable"); return; }
    throw error;
  }
});

test("approval status trigger enqueues one stable resume event", async (context) => {
  try { await isolatedRuntime(async (client) => {
    await new PostgresSliceStore().createThread("thread-approval");
    const approvalId = "00000000-0000-4000-8000-000000000001";
    await client.query(`insert into action_approvals values($1,'pending',$2::jsonb,null)`,[approvalId,JSON.stringify({runtimeThreadId:"thread-approval",runtimeToolCallId:"tool-1"})]);
    await client.query(`update action_approvals set status='approved',decision_note='approved in test' where id=$1`,[approvalId]);
    await client.query(`update action_approvals set status='approved' where id=$1`,[approvalId]);
    const queue = new PostgresInputQueue();
    assert.equal(await queue.depth("thread-approval"),1);
    const lease = await queue.lease("thread-approval");
    assert.equal(lease?.message.id,`approval:${approvalId}:approved`);
    assert.equal(lease?.message.kind,"tool_event");
  }); } catch (error) {
    if (error instanceof Error && /Connection terminated/u.test(error.message)) { context.skip("local PostgreSQL host transport unavailable"); return; }
    throw error;
  }
});
