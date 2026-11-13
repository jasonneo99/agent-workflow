import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { databaseUrl } from "./client.js";
import { acceptanceDigest } from "./acceptance.js";
import { authorizedRepairRun, claimAuthorizedCallback, loadRepairGrant, repairGrantMatches, type RepairGrant } from "./callback-continuation.js";

test("operator-signed grants and canonical callback claims fail closed across restart, tampering and replay", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "repair-grant-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const runId = "00000000-0000-4000-8000-000000000001";
  const notificationId = "00000000-0000-4000-8000-000000000002";
  const grant: RepairGrant = { version: 1, enabled: true, projectRootUri: "/synthetic/project-a", originTaskId: "synthetic-task",
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    runs: [{ runId, taskHash: acceptanceDigest("Authorized synthetic work") }] };
  const environment: NodeJS.ProcessEnv = { AGENTFLOW_REPAIR_GRANT_FILE: path.join(dir, "grant.json"), AGENTFLOW_REPAIR_AUTHORITY_KEY_FILE: path.join(dir, "authority.pem") };
  const persist = async (value: RepairGrant, key = privateKey) => {
    const payload = JSON.stringify(value);
    const raw = JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), key).toString("base64") });
    await writeFile(environment.AGENTFLOW_REPAIR_GRANT_FILE!, raw);
    environment.AGENTFLOW_REPAIR_GRANT_SHA256 = createHash("sha256").update(raw).digest("hex");
  };
  const client = new pg.Client({ connectionString: databaseUrl(), connectionTimeoutMillis: 5000 });
  const originalConnect = pg.Pool.prototype.connect;
  try {
    await writeFile(environment.AGENTFLOW_REPAIR_AUTHORITY_KEY_FILE!, publicKey.export({ type: "spki", format: "pem" }));
    assert.equal(await loadRepairGrant(environment), null);
    await persist(grant);
    assert.deepEqual(await loadRepairGrant({ ...environment }), grant); // Fresh loader, durable bytes only.
    const originalUserInfo = os.userInfo;
    const oldSettings = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
    try {
      os.userInfo = (() => ({ ...originalUserInfo(), homedir: dir })) as typeof os.userInfo;
      syncBuiltinESMExports();
      Object.assign(process.env, environment);
      assert.equal(await loadRepairGrant(), null, "Project environment cannot issue operator authority");
      const operatorDir = path.join(dir, ".config", "agent-workflow");
      await mkdir(operatorDir, { recursive: true });
      const config = path.join(operatorDir, "repair-authority.json");
      await writeFile(config, JSON.stringify(environment));
      assert.deepEqual(await loadRepairGrant(), grant, "Separate operator config enables the exact signed grant");
      await writeFile(config, "{}");
      assert.equal(await loadRepairGrant(), null, "Operator revocation survives a fresh production read");
    } finally {
      os.userInfo = originalUserInfo;
      syncBuiltinESMExports();
      for (const [key, value] of Object.entries(oldSettings)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    const canonical = { id: runId, task: "Authorized synthetic work", projectRootUri: grant.projectRootUri, metadata: { codexThreadId: grant.originTaskId } };
    assert.equal(repairGrantMatches(await loadRepairGrant(environment), canonical), true);
    for (const changed of [{ ...canonical, projectRootUri: "/synthetic/foreign" }, { ...canonical, task: "Different work" },
      { ...canonical, id: notificationId }, { ...canonical, metadata: { codexThreadId: "forged" } },
      { ...canonical, metadata: { ...canonical.metadata, source: "workflow-root-repair" } }]) assert.equal(repairGrantMatches(grant, changed), false);
    for (const changed of [{ ...grant, enabled: false }, { ...grant, expiresAt: new Date(0).toISOString() }]) {
      await persist(changed); assert.equal(await loadRepairGrant({ ...environment }), null);
    }
    await persist(grant, generateKeyPairSync("ed25519").privateKey);
    assert.equal(await loadRepairGrant(environment), null);
    await persist(grant);
    assert.equal(await loadRepairGrant({ ...environment, AGENTFLOW_REPAIR_GRANT_SHA256: "0".repeat(64) }), null);
    await client.connect();
    await client.query("set search_path to pg_temp");
    await client.query("create temporary table projects(id uuid,root_uri text)");
    await client.query("create temporary table workflow_runs(id uuid primary key,project_id uuid,task text,status text,evaluation_metadata jsonb)");
    await client.query("create temporary table run_notifications(id uuid,run_id uuid,origin_task_id text,kind text,channel text,created_at timestamptz default now())");
    await client.query("create temporary table action_approvals(run_id uuid,status text,executed_at timestamptz)");
    await client.query("create temporary table artifacts(id uuid default gen_random_uuid(),run_id uuid,kind text,uri text unique,content jsonb)");
    await client.query("create temporary table action_receipts(run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,created_at timestamptz,metadata_serialization_version integer)");
    await client.query("insert into projects values($1,$2)", [runId, grant.projectRootUri]);
    await client.query("insert into workflow_runs values($1,$1,$2,'blocked',$3)", [runId, canonical.task, canonical.metadata]);
    await client.query("insert into run_notifications(id,run_id,origin_task_id,kind,channel) values($1,$2,$3,'blocked','codex')", [notificationId, runId, grant.originTaskId]);
    pg.Pool.prototype.connect = (async () => Object.assign(client, { release() {} })) as unknown as typeof originalConnect;
    assert.equal(await authorizedRepairRun(runId, environment), true);
    const claim = { notificationId, runId, authenticatedTaskId: grant.originTaskId };
    assert.equal(await claimAuthorizedCallback({ ...claim, authenticatedTaskId: "forged" }, environment), false);
    assert.equal(await claimAuthorizedCallback({ ...claim, notificationId: runId }, environment), false);
    await client.query("insert into action_approvals values($1,'pending',null)", [runId]);
    assert.equal(await claimAuthorizedCallback(claim, environment), false);
    await client.query("delete from action_approvals");
    await client.query("update run_notifications set kind='approval_needed'");
    assert.equal(await claimAuthorizedCallback(claim, environment), false);
    await client.query("update run_notifications set kind='blocked'");
    await client.query("insert into run_notifications(id,run_id,origin_task_id,kind,channel,created_at) values($1,$1,$2,'progress','codex',now()+interval '1 second')", [runId, grant.originTaskId]);
    assert.equal(await claimAuthorizedCallback(claim, environment), false);
    await client.query("delete from run_notifications where id=$1", [runId]);
    // Replace the signed authority while the production canonical read is waiting.
    // A valid signature alone must not preserve the superseded grant's scope.
    const originalQuery = client.query;
    for (const replacement of [{ ...grant, runs: [{ runId: notificationId, taskHash: acceptanceDigest(canonical.task) }] },
      { ...grant, originTaskId: "different-authenticated-receiver" }]) {
      client.query = (async (...args: unknown[]) => {
        const result = await (originalQuery as Function).apply(client, args);
        if (String(args[0]).includes("for update of w")) await persist(replacement);
        return result;
      }) as typeof client.query;
      try {
        assert.equal(await claimAuthorizedCallback(claim, environment), false, "Replacement grant must cover the locked run and receiver");
      } finally { client.query = originalQuery; }
      assert.equal((await client.query("select count(*)::int as n from artifacts")).rows[0].n, 0);
      assert.equal((await client.query("select count(*)::int as n from action_receipts")).rows[0].n, 0);
      await persist(grant);
    }
    assert.equal(await claimAuthorizedCallback(claim, environment), true);
    assert.equal(await claimAuthorizedCallback(claim, environment), false);
    await persist({ ...grant, enabled: false });
    assert.equal(await authorizedRepairRun(runId, { ...environment }), false);
    assert.equal(await claimAuthorizedCallback(claim, { ...environment }), false);
    assert.equal((await client.query("select count(*)::int as n from action_receipts")).rows[0].n, 1);
  } finally {
    pg.Pool.prototype.connect = originalConnect;
    await client.end().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
