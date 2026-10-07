/** Opt-in live acceptance: node --import tsx scripts/test-continuation-postgres.ts
 * Creates and drops one uniquely named synthetic database; never inserts into
 * the configured database. Requires CREATEDB and the production extensions.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { databaseUrl } from "../packages/storage/src/client.js";
import { checkpointWorkflowTaskContinuation, getArtifactByUri, migrateStorage, renewWorkflowTaskLease, completeWorkflowTask } from "../packages/storage/src/postgres.js";
import { createWorkerIdentity } from "../packages/workflow-engine/src/worker-identity.js";
import { verifyAcceptanceStorage } from "./acceptance-storage-fixture.js";

const mode = process.argv[2];
const fixture = { runId: "00000000-0000-4000-8000-000000000001", taskId: "00000000-0000-4000-8000-000000000002", agentId: "continuation-fixture", workerId: "fixture-worker", fencingToken: "7" };
const continuation = { version: 1, round: 1, actionResults: [{ commandLine: "node --version", exitCode: 0, artifactUri: "db://synthetic/command" }], priorReceipts: [{ agentId: fixture.agentId, actionType: "local_command", summary: "final synthetic result" }], fileReads: [{ path: "fixture.ts", content: "synthetic", truncated: false }], stateDeltas: [], pendingOutput: { summary: "unfinished", requestedCommands: ["node --version"] } };
const safeName = /^agentflow_continuation_test_[a-f0-9]{32}$/;
if (mode) {
  assert.ok(safeName.test(new URL(databaseUrl()).pathname.slice(1)), "Child only operates on synthetic disposable databases");
  if (mode === "checkpoint") {
    await checkpointWorkflowTaskContinuation({ ...fixture, continuation, delaySeconds: 2 });
  } else if (mode === "restore") {
    const restored = await getArtifactByUri(`db://workflow_tasks/${fixture.taskId}/continuation`);
    assert.deepEqual(restored?.content, continuation);
    assert.equal(restored?.runId, fixture.runId);
    assert.equal(restored?.taskId, fixture.taskId);
  } else throw new Error("Unknown harness mode");
  console.log(JSON.stringify({ mode, passed: true }));
} else {
  const configuredUrl = databaseUrl();
  const name = `agentflow_continuation_test_${randomUUID().replaceAll("-", "")}`;
  assert.ok(safeName.test(name));
  const disposableUrl = new URL(configuredUrl);
  disposableUrl.pathname = `/${name}`;
  const admin = new pg.Client({ connectionString: configuredUrl });
  let created = false;
  let client: pg.Client | undefined;
  const checks: string[] = [];
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    process.env.DATABASE_URL = disposableUrl.href;
    client = new pg.Client({ connectionString: disposableUrl.href });
    await client.connect();
    await client.query(await readFile(new URL("../infra/init.sql", import.meta.url), "utf8"));
    await migrateStorage();
    await client.query("insert into agents(id,display_name,category,source_path,definition) values ($1,'Synthetic','test','synthetic','{}')", [fixture.agentId]);
    await client.query("insert into workflow_runs(id,status,task,autonomy,lease_epoch,lease_owner,lease_expires_at) values ($1,'running','Synthetic continuation acceptance','guarded',7,$2,now()+interval '5 minutes')", [fixture.runId, fixture.workerId]);
    await client.query("insert into workflow_tasks(id,run_id,stage_id,agent_id,status,idempotency_key,worker_id,lease_generation,lease_expires_at) values ($1,$2,'fixture',$3,'running','synthetic-continuation',$4,7,now()+interval '5 minutes')", [fixture.taskId, fixture.runId, fixture.agentId, fixture.workerId]);
    const request = { ...fixture, continuation, delaySeconds: 2 };
    const oldIncarnation = createWorkerIdentity("fixture-worker");
    const currentIncarnation = createWorkerIdentity("fixture-worker");
    await client.query("update workflow_tasks set worker_id=$2 where id=$1", [fixture.taskId, currentIncarnation.workerId]);
    const oldOwner = { ...fixture, workerId: oldIncarnation.workerId };
    assert.equal(await renewWorkflowTaskLease(oldOwner), false);
    await assert.rejects(completeWorkflowTask({ ...oldOwner, summary: "Must not complete", artifact: {} }), /Stale workflow/);
    await assert.rejects(checkpointWorkflowTaskContinuation({ ...request, workerId: oldIncarnation.workerId }), /Stale workflow/);
    await client.query("update workflow_tasks set worker_id=$2 where id=$1", [fixture.taskId, fixture.workerId]);
    checks.push("retired-incarnation-cannot-renew-complete-or-checkpoint");
    await assert.rejects(checkpointWorkflowTaskContinuation({ ...request, fencingToken: "6" }), /Stale workflow/);
    await assert.rejects(checkpointWorkflowTaskContinuation({ ...request, workerId: "stale-worker" }), /Stale workflow/);
    await assert.rejects(checkpointWorkflowTaskContinuation({ ...request, agentId: "wrong-agent" }), /identity mismatch/);
    assert.equal((await client.query("select count(*)::int as n from artifacts")).rows[0].n, 0);
    checks.push("stale-generation-and-owner-rejected", "identity-mismatch-rolled-back");
    await client.query("update workflow_tasks set lease_expires_at=now()-interval '1 second' where id=$1", [fixture.taskId]);
    await assert.rejects(checkpointWorkflowTaskContinuation(request), /expired task lease/);
    await client.query("update workflow_tasks set lease_expires_at=now()+interval '5 minutes' where id=$1", [fixture.taskId]);
    checks.push("expired-lease-rejected");
    const child = (operation: string) => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), operation], { env, encoding: "utf8", timeout: 30_000 });
      assert.equal(result.status, 0, `Child ${operation} failed: ${result.stderr}`);
      assert.match(result.stdout, /"passed":true/);
    };
    child("checkpoint");
    child("restore");
    checks.push("checkpoint-committed-in-separate-process", "full-payload-restored-in-fresh-process");
    const task = (await client.query("select status,worker_id,lease_expires_at,output_uri,finished_at,available_at>now()-interval '2 seconds' as delayed from workflow_tasks where id=$1", [fixture.taskId])).rows[0];
    assert.deepEqual(task, { status: "queued", worker_id: null, lease_expires_at: null, output_uri: null, finished_at: null, delayed: true });
    const run = (await client.query("select status,lease_owner,lease_expires_at from workflow_runs where id=$1", [fixture.runId])).rows[0];
    assert.deepEqual(run, { status: "running", lease_owner: null, lease_expires_at: null });
    assert.equal((await client.query("select count(*)::int as n from artifacts where kind='stage_output'")).rows[0].n, 0);
    assert.equal((await client.query("select count(*)::int as n from action_receipts where action_type='stage_continuation_scheduled'")).rows[0].n, 1);
    await assert.rejects(checkpointWorkflowTaskContinuation(request), /Stale workflow/);
    checks.push("queued-with-delay-without-completion", "lease-released", "receipt-persisted", "old-worker-cannot-recheckpoint");
    const workerEnv = { ...process.env };
    delete workerEnv.NODE_TEST_CONTEXT;
    const workers = spawnSync(process.execPath, [
      "--experimental-test-module-mocks", "--import", "tsx", "--test",
      fileURLToPath(new URL("./continuation-worker-fixture.ts", import.meta.url))
    ], { env: workerEnv, encoding: "utf8", timeout: 90_000 });
    assert.equal(workers.status, 0, workers.stdout + workers.stderr);
    assert.match(workers.stdout, /CONTINUATION_LIVE_ACCEPTANCE_PASSED/);
    console.log(workers.stdout);
    checks.push("real-workers-live-storage-cross-process-acceptance");
    await verifyAcceptanceStorage(client);
    checks.push("structured-acceptance-production-completion-and-four-gate-preflight");
  } finally {
    await client?.end();
    if (created) {
      // Exact generated identifier only. No production schema or rows are removed.
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      assert.equal((await admin.query("select 1 from pg_database where datname=$1", [name])).rowCount, 0);
    }
    await admin.end();
    process.env.DATABASE_URL = configuredUrl;
    console.log(JSON.stringify({ database: name, removed: created, checks }, null, 2));
  }
}
