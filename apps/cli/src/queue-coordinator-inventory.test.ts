import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withClient} from '../../../packages/storage/src/client.js';
import {activeQueueSourceOnClient} from '../../../packages/storage/src/queue-source-membership.js';
import {readFileSync} from 'node:fs';

test('PostgreSQL coordinator source admission honors bound policy retirement and keeps resumed, queued, changed or unresolved members',async()=>{
 await withClient(async c=>{await c.query('begin');try{
 const schema='coordinator_inventory_'+randomUUID().replaceAll('-','');
 await c.query(`create schema ${schema};set local search_path to ${schema},public;set local jit=off;
 create table projects(id uuid primary key,root_uri text,config jsonb,profile text);
 create table workflow_runs(id uuid primary key,project_id uuid,run_set_id uuid,task text,evaluation_metadata jsonb default '{}',started_at timestamptz default clock_timestamp(),finished_at timestamptz,policy_profile text default 'local',status text,provider_override text,model_tier_override text);
 create table project_identity_locations(project_id uuid,identity_id uuid,kind text);
 create table workflow_tasks(run_id uuid,status text);
 create table action_receipts(run_id uuid,action_type text,metadata jsonb,summary text,created_at timestamptz default clock_timestamp(),receipt_hash text);
 create table action_approvals(id uuid,run_id uuid,status text);
 create table artifacts(run_id uuid,kind text,content jsonb,created_at timestamptz default clock_timestamp());
 create table queue_coordinator_assignments(project_id uuid,source_run_id uuid,child_run_id uuid,state text);
 create table side_effect_receipts(project_id text,idempotency_key text,status text);`);
 const project=randomUUID(),root=randomUUID(),child=randomUUID(),other=randomUUID();
 await c.query("insert into projects values($1,'/synthetic/coordinator','{}','enterprise')",[project]);
 const add=async(id:string,task:string,metadata={})=>c.query("insert into workflow_runs(id,project_id,run_set_id,task,evaluation_metadata,status) values($1,$2,$3,$4,$5,'blocked')",[id,project,randomUUID(),task,JSON.stringify(metadata)]);
 await add(root,'Historical policy denied example writes.');await add(child,'Historical policy continuation.',{sourceRunId:root});await add(other,'Unrelated work remains queued.');
 const baseline=(await c.query('select * from workflow_runs order by id')).rows;
 const ids=async()=>{const all=(await c.query('select id::text from workflow_runs')).rows;const active:string[]=[];for(const row of all)if(await activeQueueSourceOnClient(c,row.id))active.push(row.id);return active.sort();};
 assert.deepEqual(await ids(),[root,child,other].sort());
 for(const id of [root,child]){
 const row=(await c.query('select task from workflow_runs where id=$1',[id])).rows[0];
 const content={version:1,authority:'direct-human',disposition:'obsolete-policy-unaccepted',viewOnly:true,originalAcceptanceChanged:false,runId:id,projectId:project,originalTask:row.task,reconciledEffectKeys:[]};
 await c.query("insert into action_receipts(run_id,action_type,metadata,receipt_hash) values($1,'obsolete_policy_contract_retired',$2,'synthetic-bound-hash')",[id,JSON.stringify(content)]);
 assert.ok((await ids()).includes(id),'A bare retirement label never filters coordinator work');
 await c.query("insert into artifacts(run_id,kind,content) values($1,'obsolete_policy_disposition',$2)",[id,JSON.stringify(content)]);
 }
 assert.deepEqual(await ids(),[other],'Retired original and terminal child must not enroll repair lanes');
 const cases=[
 ["update workflow_runs set status='queued' where id=$1",[child]],
 ["insert into workflow_tasks values($1,'queued')",[child]],
 ["insert into action_approvals values($1,$2,'pending')",[randomUUID(),child]],
 ["insert into side_effect_receipts values($1,'new-unbound-effect','pending')",[child]],
 ["insert into queue_coordinator_assignments values($1,$2,$2,'uncertain')",[project,child]],
 ["update workflow_runs set task='Changed historical subject' where id=$1",[child]],
 ["delete from artifacts where run_id=$1",[child]],
 ["update artifacts set content=jsonb_set(content,'{projectId}',to_jsonb($2::text)) where run_id=$1",[child,randomUUID()]]
 ] as const;
 for(const [sql,args]of cases){await c.query('savepoint changed_member');await c.query(sql,[...args]);assert.ok((await ids()).includes(child),sql);await c.query('rollback to savepoint changed_member');}
 assert.deepEqual((await c.query('select * from workflow_runs order by id')).rows,baseline,'Inventory reads never alter historical statuses or original tasks');
 const production=readFileSync(new URL('./commands/queue-coordinator.ts',import.meta.url),'utf8');
 assert.match(production,/activeQueueMember:await withClient\(c=>activeQueueSourceOnClient\(c,source\.id\)\)/u);
 const planning=production.slice(production.indexOf('const plan=planQueueCoordinator('),production.indexOf('plan.holds.push(...membershipHolds)'));
 assert.match(planning,/data\.sources\.get\(f\.sourceRunId\)\?\.activeQueueMember/u,'Actual coordinator planning must consume exact-source membership');
 }finally{await c.query('rollback');}});
});
