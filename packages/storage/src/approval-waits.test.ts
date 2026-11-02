import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { withClient } from "./client.js";
import { applyExecutedPolicyAdditions, holdWorkflowTaskForApprovalsOnClient, pendingActionApprovalIds, resolveWorkflowApprovalWaitOnClient } from "./approval-waits.js";
import { projectConfigSchema } from "../../agent-registry/src/schemas.js";

async function fixture(run: (state: { client: import("pg").Client; runId: string; taskId: string; nextId: string; ids: string[]; hold: () => Promise<string> }) => Promise<void>) {
  await withClient(async client => {
    await client.query("begin");
    try {
      const schema = `approval_wait_${randomUUID().replaceAll("-", "")}`;
      await client.query(`create schema ${schema}; set local search_path to ${schema},public;
        create table workflow_runs(id uuid primary key,status text,lease_owner text,lease_epoch bigint default 1,lease_expires_at timestamptz,
          finished_at timestamptz,state_version bigint default 1,evaluation_metadata jsonb default '{}',requester_channel text);
        create table workflow_tasks(id uuid primary key,run_id uuid,agent_id text,status text,available_at timestamptz default now(),
          started_at timestamptz,finished_at timestamptz,worker_id text,lease_expires_at timestamptz);
        create table action_approvals(id uuid primary key,run_id uuid,task_id uuid,status text,action_type text,target text,executed_at timestamptz);
        create table artifacts(run_id uuid,task_id uuid,kind text,uri text unique,content jsonb);
        create table action_receipts(run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,created_at timestamptz,metadata_serialization_version int);
        create table workflow_run_transitions(run_id uuid,from_status text,to_status text,state_version bigint,lease_epoch bigint,actor text,reason text,idempotency_key text,metadata jsonb,created_at timestamptz default now());
        create table run_notifications(id uuid default gen_random_uuid(),run_id uuid,channel text,kind text,title text,body text,event_key text,origin_task_id text,created_at timestamptz);
        create unique index notice_identity on run_notifications(run_id,channel,event_key) where event_key is not null;`);
      const runId = randomUUID(), taskId = randomUUID(), nextId = randomUUID(), ids = [randomUUID(),randomUUID()];
      await client.query("insert into workflow_runs(id,status,lease_owner,lease_expires_at) values($1,'running','worker',now()+interval '1 minute')", [runId]);
      await client.query("insert into workflow_tasks(id,run_id,agent_id,status,started_at,worker_id,lease_expires_at) values($1,$2,'implementation-agent','running',now(),'worker',now()+interval '1 minute'),($3,$2,'test-engineer','queued',null,null,null)", [taskId,runId,nextId]);
      for (const id of ids) await client.query("insert into action_approvals values($1,$2,$3,'pending','local_command','synthetic-test',null)", [id,runId,taskId]);
      const hold = () => holdWorkflowTaskForApprovalsOnClient(client,{runId,taskId,agentId:"implementation-agent",workerId:"worker",fencingToken:"1",approvalIds:ids,
        continuation:{version:1,round:2,verifyRetryRound:1,actionResults:[{type:"file_write",path:"source.ts",nextHash:"postimage"},...ids.map(approvalId=>({type:"local_command_approval_pending",approvalId}))],pendingOutput:{summary:"Unfinished"}}});
      await run({client,runId,taskId,nextId,ids,hold});
    } finally { await client.query("rollback"); }
  });
}

test("approval wait saves progress without failing or cancelling later stages; final execution wakes the same task once", async()=>fixture(async({client,runId,taskId,nextId,ids,hold})=>{
  assert.equal(await hold(),"waiting");
  const tasks=(await client.query("select id::text,status,worker_id,finished_at,available_at<=now() eligible from workflow_tasks order by id")).rows;
  assert.equal(tasks.find(t=>t.id===taskId).status,"queued");
  assert.equal(tasks.find(t=>t.id===taskId).eligible,false);
  assert.equal(tasks.find(t=>t.id===taskId).worker_id,null);
  assert.equal(tasks.find(t=>t.id===nextId).status,"queued");
  assert.equal((await client.query("select status,finished_at from workflow_runs where id=$1",[runId])).rows[0].status,"running");
  await client.query("update action_approvals set status='approved'");
  assert.equal(await resolveWorkflowApprovalWaitOnClient(client,ids[0]),0,"Approve-only is not action execution");
  await client.query("update action_approvals set status='executed',executed_at=now() where id=$1",[ids[0]]);
  assert.equal(await resolveWorkflowApprovalWaitOnClient(client,ids[0]),0,"Every required approval must execute");
  assert.equal(await resolveWorkflowApprovalWaitOnClient(client,randomUUID()),0,"Unrelated approvals cannot wake a stage");
  await client.query("update action_approvals set status='executed',executed_at=now() where id=$1",[ids[1]]);
  assert.equal(await resolveWorkflowApprovalWaitOnClient(client,ids[1]),1);
  assert.equal(await resolveWorkflowApprovalWaitOnClient(client,ids[1]),0,"No duplicate continuation");
  const checkpoint=(await client.query("select content from artifacts where kind='stage_continuation'")).rows[0].content;
  assert.equal(checkpoint.round,2);assert.equal(checkpoint.verifyRetryRound,1);
  assert.deepEqual(checkpoint.actionResults[0],{type:"file_write",path:"source.ts",nextHash:"postimage"});
  assert.equal(checkpoint.actionResults[1].type,"action_approval_resolved");
  assert.equal((await client.query("select available_at<=now() eligible from workflow_tasks where id=$1",[taskId])).rows[0].eligible,true);
  assert.equal((await client.query("select count(*)::int n from action_receipts where action_type in('stage_failed','stage_blocked','stage_cancelled')")).rows[0].n,0);
}));

test("approval execution racing before checkpoint publication queues observation without replaying effects",async()=>fixture(async({client,hold})=>{
  await client.query("update action_approvals set status='executed',executed_at=now()");
  assert.equal(await hold(),"resolved");
  const checkpoint=(await client.query("select content from artifacts")).rows[0].content;
  assert.equal(checkpoint.approvalWait.state,"resolved");
  assert.equal(checkpoint.actionResults.filter((a:any)=>a.type==='file_write').length,1);
}));

test("rejection is a real blocked decision, while merely waiting is not a failure",async()=>fixture(async({client,runId,taskId,nextId,ids,hold})=>{
  await hold();await client.query("update action_approvals set status='rejected' where id=$1",[ids[0]]);
  assert.equal(await resolveWorkflowApprovalWaitOnClient(client,ids[0]),0);
  assert.equal((await client.query("select status from workflow_tasks where id=$1",[taskId])).rows[0].status,"blocked");
  assert.equal((await client.query("select status from workflow_tasks where id=$1",[nextId])).rows[0].status,"cancelled");
  assert.equal((await client.query("select status from workflow_runs where id=$1",[runId])).rows[0].status,"blocked");
}));

test("foreign task approvals and completed history cannot grant continuation",async()=>fixture(async({client,taskId,ids,hold})=>{
  await client.query("update action_approvals set task_id=$1 where id=$2",[randomUUID(),ids[0]]);
  await assert.rejects(hold(),/same-run, same-task/);
  assert.equal((await client.query("select status from workflow_tasks where id=$1",[taskId])).rows[0].status,"running");
  await client.query("update action_approvals set task_id=$1",[taskId]);await hold();
  await client.query("update workflow_runs set status='completed';update action_approvals set status='executed',executed_at=now()");
  assert.equal(await resolveWorkflowApprovalWaitOnClient(client,ids[0]),0);
}));

test("only real pending approval objects are collected; duplicate IDs coalesce",()=>{
  const id=randomUUID();assert.deepEqual(pendingActionApprovalIds([{type:"local_command_approval_pending",approvalId:id},{type:"file_write_approval_pending",approvalId:id},{type:"local_command_rejected",approvalId:randomUUID()},{type:"local_command_approval_pending",approvalId:"prose"}]),[id]);
});

test("only an executed exact rule retained in current policy supplements the snapshot",()=>{
  const snapshot=projectConfigSchema.parse({project:{name:'Synthetic',root:'.'},actions:{allowed_commands:['git diff --check'],allowed_write_paths:['src/**']}});
  const current=projectConfigSchema.parse({...snapshot,actions:{...snapshot.actions,allowed_commands:['git diff --check','python3 -m unittest -v','npm test']}});
  const approved=applyExecutedPolicyAdditions(snapshot,current,[{field:'allowed_commands',rule:'python3 -m unittest -v'},{field:'allowed_write_paths',rule:'private/**'}]);
  assert.deepEqual(approved.actions.allowed_commands,['git diff --check','python3 -m unittest -v']);
  assert.deepEqual(approved.actions.allowed_write_paths,['src/**']);
  assert.deepEqual(snapshot.actions.allowed_commands,['git diff --check'],'Frozen snapshot remains immutable');
  assert.equal(applyExecutedPolicyAdditions(snapshot,snapshot,[{field:'allowed_commands',rule:'python3 -m unittest -v'}]).actions.allowed_commands.includes('python3 -m unittest -v'),false,'Revoked current rule remains revoked');
});

test("queue activity excludes future and infinite scheduling; newest actual work sorts first",async()=>withClient(async client=>{
  const source=readFileSync(new URL('./postgres.ts',import.meta.url),'utf8');
  const start=source.indexOf('select max(greatest('),end=source.indexOf('from workflow_tasks task_activity',start);
  assert.ok(start>0&&end>start);const aggregate=source.slice(start,end).trim().replace(/^select /u,'');
  const rows=(await client.query(`select run_id,greatest(min(updated_at),${aggregate}) activity from (values
    ('prepared','infinity'::timestamptz,null::timestamptz,null::timestamptz,'2026-01-01'::timestamptz),
    ('future','2099-01-01'::timestamptz,null::timestamptz,null::timestamptz,'2026-01-02'::timestamptz),
    ('new','2026-01-03'::timestamptz,'2026-01-03'::timestamptz,'2026-01-04'::timestamptz,'2026-01-03'::timestamptz)
    ) task_activity(run_id,available_at,started_at,finished_at,updated_at) group by run_id order by activity desc`)).rows;
  assert.deepEqual(rows.map(row=>row.run_id),['new','future','prepared']);
  assert.ok(rows.every(row=>Number.isFinite(row.activity.getTime())));
}));
