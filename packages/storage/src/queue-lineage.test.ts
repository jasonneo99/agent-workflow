import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { withClient } from "./client.js";
import { activeQueueRunPredicateSql, queuePresentationCteSql, queuePresentationSql, relatedQueueCountsSql, relatedRunIdsSql } from "./queue-lineage.js";

test("exact-source admission and presentation share one unchanged membership predicate", () => {
  for (const alias of ["latest", "pending_run"]) {
    assert.ok(queuePresentationCteSql.includes(activeQueueRunPredicateSql(alias)));
  }
  const sql = activeQueueRunPredicateSql("source");
  assert.match(sql, /source\.status in \('queued','leased','running','blocked','failed'\)/u);
  assert.match(sql, /failed_run_dismissed','failed_run_superseded/u);
  assert.match(sql, /failed_run_reinstated/u);
  assert.doesNotMatch(sql, /\b(update|delete|insert)\b/iu);
});

test("queue grouping is display-only and explicitly project-scoped", () => {
  const sql = queuePresentationCteSql;
  assert.match(sql, /candidate.family_project_id = member.family_project_id/u);
  assert.match(sql, /sourceRunId/u);
  assert.match(sql, /replayOfRunId/u);
  assert.match(sql, /replacement_run_id/u);
  assert.match(sql, /latest\.status in \('queued','leased','running','blocked','failed'\)/u);
  assert.match(sql, /latest.started_at desc,latest.id desc/u);
  assert.doesNotMatch(sql, /\b(update|delete|insert)\b/iu);
  assert.doesNotMatch(sql, /candidate.task|candidate.workflow_id/u);
  const server = readFileSync(new URL("../../../apps/cli/src/commands/daemon.ts", import.meta.url), "utf8");
  assert.match(server, /relatedRunId: requestUrl.searchParams.get\("relatedTo"\)/u);
  assert.match(server, /Earlier attempts need review/u);
  assert.match(server, /Grouping is not acceptance or dismissal/u);
});

test("project-scoped queue lineage filters before recursive graph expansion", () => {
  const direct = queuePresentationSql(false, "$2");
  assert.match(direct, /family_runs as \(select r\.id,[\s\S]+r\.project_id as family_project_id from workflow_runs r join projects scope_project/u);
  assert.match(direct, /scope_project\.root_uri=\$2/u);
  const canonical = queuePresentationSql(true, "$2");
  assert.match(canonical, /coalesce\(l\.identity_id,r\.project_id\)=\(/u);
  assert.match(canonical, /target_project\.root_uri=\$2/u);
  assert.ok(canonical.indexOf("target_project.root_uri=$2") < canonical.indexOf("lineage(origin,id)"));
});

test("PostgreSQL: one latest card across repair sets, cycles, ties, and project boundaries", {
  skip: process.env.AGENTFLOW_QUEUE_LINEAGE_PG_TEST !== "1"
}, async () => {
  await withClient(async (client) => {
    await client.query("begin");
    await client.query("set local jit=off");
    try {
      // Session-local shadows only; no persistent workflow or receipt changes.
      await client.query(`create temporary table workflow_runs (
        id text primary key, project_id text, run_set_id text, status text,
        started_at timestamptz, replacement_run_id text, task text default '', evaluation_metadata jsonb default '{}'
      ) on commit drop;
      create temporary table workflow_tasks (run_id text, status text) on commit drop;
      create temporary table action_receipts (run_id text, action_type text, created_at timestamptz,metadata jsonb,summary text,receipt_hash text) on commit drop;
      create temporary table action_approvals (id text,run_id text,status text) on commit drop;
      create temporary table artifacts(run_id text,kind text,content jsonb) on commit drop;
      create temporary table queue_coordinator_assignments(project_id text,source_run_id text,child_run_id text,state text) on commit drop;
      create temporary table side_effect_receipts(project_id text,idempotency_key text,status text) on commit drop;
      create temporary table project_identity_locations (project_id text,identity_id text) on commit drop`);
      const add = async (id: string, project: string, set: string, status: string, time: number, metadata = {}) => {
        await client.query(`insert into workflow_runs (id,project_id,run_set_id,status,started_at,evaluation_metadata)
          values ($1,$2,$3,$4,to_timestamp($5),$6)`, [id, project, set, status, time, metadata]);
      };
      const cards = async () => (await client.query(`${queuePresentationCteSql} select wr.id, ${relatedQueueCountsSql}
        from workflow_runs wr join queue_families qf on qf.latest_id=wr.id and qf.open_count>0 order by wr.id`)).rows;
      await add("old-policy", "p", "old-policy-set", "blocked", 0);
      const retirement={version:1,authority:'direct-human',disposition:'obsolete-policy-unaccepted',viewOnly:true,originalAcceptanceChanged:false,runId:'old-policy',projectId:'p',originalTask:''};
      await client.query("insert into action_receipts(run_id,action_type,created_at,metadata,receipt_hash) values('old-policy','obsolete_policy_contract_retired',now(),$1,'synthetic-audited-hash')",[JSON.stringify(retirement)]);
      assert.ok((await cards()).some(r=>r.id==='old-policy'),'Bare retirement metadata must not hide work');
      await client.query("insert into artifacts values('old-policy','obsolete_policy_disposition',$1)",[JSON.stringify(retirement)]);
      assert.ok(!(await cards()).some(r=>r.id==='old-policy'),'Bound retirement evidence hides only its exact unchanged historical task');
      await client.query('savepoint bound_policy_children');
      await add('old-policy-child','p','old-policy-child-set','blocked',1,{sourceRunId:'old-policy'});
      assert.ok((await cards()).some(r=>r.id==='old-policy-child'),'Retiring only the root cannot hide an unbound blocked child');
      const childRetirement={...retirement,runId:'old-policy-child',sourcePolicyRunId:'old-policy'};
      await client.query("insert into action_receipts(run_id,action_type,created_at,metadata,receipt_hash) values('old-policy-child','obsolete_policy_contract_retired',now(),$1,'synthetic-child-hash')",[JSON.stringify(childRetirement)]);
      await client.query("insert into artifacts values('old-policy-child','obsolete_policy_disposition',$1)",[JSON.stringify(childRetirement)]);
      assert.ok(!(await cards()).some(r=>['old-policy','old-policy-child'].includes(r.id)),'Every exactly bound terminal member leaves the actionable view');
      await client.query("update workflow_runs set status='running' where id='old-policy-child'");
      assert.ok((await cards()).some(r=>r.id==='old-policy-child'),'A resumed retired child reappears');
      await client.query("update workflow_runs set status='blocked' where id='old-policy-child'");
      await client.query("insert into workflow_tasks values('old-policy-child','queued')");
      assert.ok((await cards()).some(r=>r.id==='old-policy-child'),'Queued child tasks must remain actionable');
      await client.query('rollback to savepoint bound_policy_children');
      await client.query("update workflow_runs set task='changed contract' where id='old-policy'");
      assert.ok((await cards()).some(r=>r.id==='old-policy'),'Task drift invalidates view projection');
      await client.query("update workflow_runs set task='',status='running' where id='old-policy'");
      assert.ok((await cards()).some(r=>r.id==='old-policy'),'Historical retirement cannot hide newly active work');
      await client.query("update workflow_runs set status='blocked' where id='old-policy'");
      await client.query('savepoint resumed_policy_child');
      await add('resumed-policy-child','p','policy-child-set','running',1,{sourceRunId:'old-policy'});
      assert.ok((await cards()).some(r=>r.id==='resumed-policy-child'),'A retired historical parent cannot hide a resumed child');
      await client.query('rollback to savepoint resumed_policy_child');
      await add("original", "p", "set", "running", 1);
      await add("replay", "p", "set", "blocked", 2, { replayOfRunId: "original" });
      await add("repair", "p", "new-set", "blocked", 3, { sourceRunId: "replay" });
      await add("unrelated", "p", "other", "failed", 1);
      await add("foreign", "other-project", "set", "failed", 4, { sourceRunId: "repair" });
      assert.deepEqual((await cards()).map(r => r.id), ["foreign", "repair", "unrelated"]);
      await client.query("update workflow_runs set status='completed' where id='repair'");
      const unfinished = (await cards()).find(r => r.id === "replay");
      assert.equal(unfinished?.relatedOpenRunCount, 1);
      assert.equal(unfinished?.relatedRunCount, 3);
      assert.ok(!(await cards()).some(r => r.id === "repair"), "Completed attempts stay in history, not queue cards");
      // A cycle terminates, and timestamp ties have a stable ID tiebreaker.
      await client.query("update workflow_runs set replacement_run_id='repair' where id='original'");
      await client.query("update workflow_runs set replacement_run_id='original' where id='repair'");
      await add("repair-z", "p", "newer-set", "queued", 3, { sourceRunId: "repair" });
      assert.deepEqual((await cards()).map(r => r.id), ["foreign", "repair-z", "unrelated"]);
      const history = await client.query(`select id from workflow_runs where id in (${relatedRunIdsSql("'original'")}) order by id`);
      assert.deepEqual(history.rows.map(r => r.id), ["original", "repair", "repair-z", "replay"]);
      await client.query("insert into action_receipts(run_id,action_type,created_at) values ('repair-z','failed_run_dismissed',now())");
      assert.ok((await cards()).some(r => r.id === "replay"));
      await client.query("update workflow_runs set status='completed' where project_id='p'");
      assert.deepEqual((await cards()).map(r => r.id), ["foreign"]);
      // Explicitly reconciled checkouts may share display lineage only. Foreign
      // scopes still cannot join merely by name, run set or copied parent ID.
      await client.query("insert into project_identity_locations values ('p','logical-p'),('checkout','logical-p')");
      await add("spin-off", "checkout", "spin-set", "blocked", 8, {repairOriginRunId:"original"});
      await client.query("insert into action_approvals values ('approval-old','original','pending')");
      await client.query("insert into action_receipts(run_id,action_type,created_at,metadata,summary) values ('original','stage_blocked',now(),'{}','Original blocker retained')");
      const snapshot=(await client.query("select * from workflow_runs order by id")).rows;
      const identityCards=(await client.query(`${queuePresentationSql(true)} select wr.id,qf.attempts,qf.version_set_id
        from workflow_runs wr join queue_families qf on qf.latest_id=wr.id and qf.open_count>0 order by wr.id`)).rows;
      assert.deepEqual(identityCards.map(r=>r.id),["foreign","spin-off"]);
      const family=identityCards.find(r=>r.id==="spin-off")!;
      const original=family.attempts.find((r:any)=>r.id==="original");
      assert.equal(original.blocker,"Original blocker retained");
      assert.deepEqual(original.approvals,[{id:"approval-old",status:"pending"}]);
      assert.equal(family.version_set_id,"set");
      const related=(await client.query(`select id from workflow_runs where id in (${relatedRunIdsSql("'spin-off'",true)}) order by id`)).rows;
      assert.ok(related.some(r=>r.id==="original"));
      assert.ok(!related.some(r=>r.id==="foreign"));
      assert.deepEqual((await client.query("select * from workflow_runs order by id")).rows,snapshot);
      await client.query("update workflow_runs set status='completed' where id='spin-off'");
      const pendingCard=(await client.query(`${queuePresentationSql(true)} select latest_id,open_count from queue_families where 'spin-off'=any(members)`)).rows[0];
      assert.equal(pendingCard.latest_id,null,"A completed run stays out of the queue even when an old approval record remains");
      assert.equal(pendingCard.open_count,0);
      await add("operation-a","p","op-a","blocked",10,{idempotencyKey:"same-request-key",source:"operator-api",actor:"operator"});
      await add("operation-b","checkout","op-b","blocked",11,{idempotencyKey:"same-request-key",source:"operator-api",actor:"operator"});
      const opFamily=(await client.query(`select id from workflow_runs where id in (${relatedRunIdsSql("'operation-b'",true)}) order by id`)).rows;
      assert.deepEqual(opFamily.map(r=>r.id),["operation-a","operation-b"]);
      const legacySource="11111111-1111-4111-8111-111111111111";
      await add(legacySource,"p","legacy-source","blocked",12);
      await add("legacy-child","checkout","legacy-child-set","blocked",13,{source:"server-orchestration",actorRole:"operator"});
      await client.query("update workflow_runs set task=$1 where id='legacy-child'",[`Resolve queue. Source items: workflow ${legacySource} (blocked). Diagnose root causes.`]);
      const legacyFamily=(await client.query(`select id from workflow_runs where id in (${relatedRunIdsSql("'legacy-child'",true)}) order by id`)).rows;
      assert.deepEqual(legacyFamily.map(r=>r.id),[legacySource,"legacy-child"]);
      await client.query("update workflow_runs set task=task || $1 where id='legacy-child'",[" 22222222-2222-4222-8222-222222222222"]);
      const sweep=(await client.query(`select id from workflow_runs where id in (${relatedRunIdsSql("'legacy-child'",true)}) order by id`)).rows;
      assert.deepEqual(sweep.map(r=>r.id),["legacy-child"],"Multi-item sweeps must not fuse independent version families");
    } finally {
      await client.query("rollback");
    }
  });
});
