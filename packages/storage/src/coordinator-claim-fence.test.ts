import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {coordinatorClaimFenceSql} from './coordinator-claim-fence.js';

test('actual database fence rejects stale workers only on coordinator-owned claims; preserves ordinary work and history',async()=>withClient(async c=>{
 const schema='claim_fence_'+randomUUID().replaceAll('-','');await c.query('begin');
 try{
  await c.query(`create schema ${schema};set local search_path to ${schema};
   create table workflow_runs(id uuid primary key,project_id uuid,evaluation_metadata jsonb,status text,lease_owner text,lease_epoch bigint default 0,lease_expires_at timestamptz);
   create table workflow_tasks(id uuid primary key,run_id uuid,status text,worker_id text,lease_generation bigint default 0,lease_expires_at timestamptz);
   create table work_intents(project_id text,owner text,fencing_token bigint,expires_at timestamptz);
   create table queue_coordinator_assignments(id uuid,project_id uuid,child_run_id uuid,fence bigint,intent_fence text,owner text,state text);`);
  const project=randomUUID(),run=randomUUID(),task=randomUUID(),assignment=randomUUID(),ordinary=randomUUID();
  await c.query("insert into workflow_runs(id,project_id,evaluation_metadata,status)values($1,$2,$3,'queued'),($4,$2,'{}','queued')",[run,project,{queueCoordinatorClaimId:assignment,queueCoordinatorFence:'7'},ordinary]);
  await c.query("insert into workflow_tasks(id,run_id,status)values($1,$2,'queued')",[task,run]);
  await c.query("insert into queue_coordinator_assignments values($1,$2,$3,7,'3','authorized','running')",[assignment,project,run]);
  await c.query("insert into work_intents values($1,'authorized',3,now()+interval '1 hour')",[project]);
  await c.query(coordinatorClaimFenceSql);
  const rejects=async(sql:string,args:unknown[])=>{await c.query('savepoint denied');await assert.rejects(c.query(sql,args),{code:'55P03'});await c.query('rollback to savepoint denied');};
  await rejects("update workflow_runs set lease_owner='stale-worker',lease_epoch=1,lease_expires_at=now()+interval '1 minute' where id=$1",[run]);
  await rejects("update workflow_tasks set status='leased',worker_id='stale-worker',lease_generation=1 where id=$1",[task]);
  await c.query("update workflow_runs set lease_owner='authorized:7',lease_epoch=1,lease_expires_at=now()+interval '1 minute' where id=$1",[run]);
  await c.query("update workflow_tasks set status='leased',worker_id='authorized:7',lease_generation=1 where id=$1",[task]);
  await c.query("update work_intents set expires_at=now()-interval '1 second'");
  await rejects("update workflow_tasks set status='running' where id=$1",[task]);
  await c.query("update workflow_runs set lease_owner='ordinary-worker',lease_epoch=1 where id=$1",[ordinary]);
  await c.query("update workflow_tasks set status='blocked',worker_id=null where id=$1",[task]);
  await c.query("update workflow_runs set lease_owner=null,lease_expires_at=null where id=$1",[run]);
  assert.equal((await c.query('select count(*)::int n from workflow_runs')).rows[0].n,2);
  await c.query(coordinatorClaimFenceSql); // Idempotent installation preserves rows.
  assert.equal((await c.query('select status from workflow_tasks where id=$1',[task])).rows[0].status,'blocked');
 }finally{await c.query('rollback');}
}));
