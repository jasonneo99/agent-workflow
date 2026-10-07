import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { databaseUrl } from "../../../packages/storage/src/client.js";
import { runNotificationOutboxSchemaSql } from "../../../packages/storage/src/run-notifications.js";
import { verifyNotificationSignature } from "./notification-webhook.js";

test("isolated process restart recovers a durable claim through offline and signed HTTP busy retries", { timeout: 60_000 }, async () => {
  const schema = `notification_test_${randomUUID().replaceAll("-", "")}`;
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
  const secret = randomBytes(32).toString("hex");
  const runId = randomUUID();
  const notificationId = randomUUID();
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (!verifyNotificationSignature({ body, secret, timestamp: String(request.headers["x-agentflow-timestamp"]), signature: String(request.headers["x-agentflow-signature"]) })) {
      response.writeHead(401).end(); return;
    }
    received.push(JSON.parse(body).notificationId);
    response.writeHead(received.length === 1 ? 503 : 204).end();
  });
  const children: ReturnType<typeof spawn>[] = [];
  let created = false;
  try {
    await client.connect();
    await client.query(`create schema ${schema}`);
    created = true;
    await client.query(`set search_path to ${schema}`);
    await client.query("create table projects(id uuid primary key,root_uri text)");
    await client.query("create table workflow_runs(id uuid primary key,project_id uuid)");
    await client.query("create table run_notifications(id uuid primary key,run_id uuid,channel text,kind text,title text,body text,status text default 'pending',created_at timestamptz default now(),delivered_at timestamptz)");
    await client.query(runNotificationOutboxSchemaSql);
    await client.query("insert into projects values($1,'/synthetic')", [runId]);
    await client.query("insert into workflow_runs values($1,$1)", [runId]);
    await client.query("insert into run_notifications(id,run_id,channel,kind,title,body,origin_task_id) values($1,$2,'test','message','Synthetic','Synthetic recovery evidence','client-a')", [notificationId, runId]);
    const connection = new URL(databaseUrl());
    connection.searchParams.set("options", `-c search_path=${schema}`);
    const storageUrl = new URL("../../../packages/storage/src/run-notifications.ts", import.meta.url).href;
    const transportUrl = new URL("./notification-webhook.ts", import.meta.url).href;
    const start = (code: string) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
        env: { ...process.env, DATABASE_URL: connection.href, TEST_NOTIFICATION_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"]
      });
      children.push(child);
      return child;
    };
    const first = start(`const s=await import(${JSON.stringify(storageUrl)}); const rows=await s.claimRunNotifications({projectRootUri:"/synthetic",owner:"crashed",notificationId:${JSON.stringify(notificationId)}}); console.log(JSON.stringify(rows)); setInterval(()=>{},1000);`);
    const output = await once(first.stdout!, "data");
    const claim = JSON.parse(String(output[0]))[0];
    assert.equal(claim.id, notificationId);
    const crashed = once(first, "exit");
    first.kill("SIGKILL");
    await crashed;
    // Accelerated lease expiry in this isolated schema only; no production clock manipulation.
    await client.query("update run_notifications set claim_expires_at=now()-interval '1 second' where id=$1", [notificationId]);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await new Promise<void>(resolve => server.close(() => resolve()));
    const code = `const s=await import(${JSON.stringify(storageUrl)});const t=await import(${JSON.stringify(transportUrl)}); const host=t.createWebhookHost({projectRootUri:"/synthetic",channel:"test",taskId:"client-a",endpoint:"http://127.0.0.1:${address.port}",secret:process.env.TEST_NOTIFICATION_SECRET,allowLoopbackHttp:true});const result=await t.consumeHostNotification({projectRootUri:"/synthetic",owner:"restarted",notificationId:${JSON.stringify(notificationId)},maxChecks:100,intervalMs:500,signal:new AbortController().signal},host,{claim:s.claimRunNotifications,settle:s.settleRunNotification});console.log(JSON.stringify(result));process.exitCode=result.transportDelivered?0:1;`;
    const restarted = start(code);
    let stdout = "";
    let stderr = "";
    restarted.stdout!.on("data", chunk => { stdout += chunk; });
    restarted.stderr!.on("data", chunk => { stderr += chunk; });
    const exited = once(restarted, "exit");
    let offlineRecorded = false;
    for (let check = 0; check < 100; check++) {
      const offline = (await client.query("select status,attempt_count from run_notifications where id=$1", [notificationId])).rows[0];
      if (offline.status === "failed" && offline.attempt_count === 2) { offlineRecorded = true; break; }
      await delay(50);
    }
    assert.equal(offlineRecorded, true, "connection-refused attempt must persist before receiver restart");
    assert.equal(received.length, 0);
    await new Promise<void>(resolve => server.listen(address.port, "127.0.0.1", resolve));
    const [exitCode] = await exited;
    assert.equal(exitCode, 0, stderr);
    assert.equal(JSON.parse(stdout).transportDelivered, true);
    assert.equal(JSON.parse(stdout).acknowledged, false);
    assert.deepEqual(received, [notificationId, notificationId]);
    const row = (await client.query("select status,attempt_count,delivered_at,acknowledged_at,claim_token from run_notifications where id=$1", [notificationId])).rows[0];
    assert.equal(row.status, "delivered");
    assert.equal(row.attempt_count, 4);
    assert.ok(row.delivered_at);
    assert.equal(row.acknowledged_at, null);
    assert.equal(row.claim_token, null);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    // Only this test's uniquely named schema is removed; no shared runtime rows.
    if (created) await client.query(`drop schema ${schema} cascade`);
    await client.end();
  }
});
