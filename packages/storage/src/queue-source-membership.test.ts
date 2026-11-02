import assert from 'node:assert/strict';
import test from 'node:test';
import {withClient} from './client.js';
import {activeQueueSourceOnClient} from './queue-source-membership.js';

test('exact-source membership reuses queue visibility without reviving hidden history or mutating it',async()=>withClient(async c=>{
 await c.query('begin');try{
  await c.query(`create temporary table workflow_runs(id text primary key,project_id text,run_set_id text,status text,
   started_at timestamptz default clock_timestamp(),replacement_run_id text,task text default 'Synthetic outcome',evaluation_metadata jsonb default '{}') on commit drop;
   create temporary table action_receipts(run_id text,action_type text,created_at timestamptz,metadata jsonb,summary text,receipt_hash text) on commit drop;
   create temporary table action_approvals(id text,run_id text,status text) on commit drop;
   create temporary table workflow_tasks(run_id text,status text) on commit drop;
   create temporary table queue_coordinator_assignments(project_id text,source_run_id text,child_run_id text,state text) on commit drop;
   create temporary table side_effect_receipts(project_id text,status text,idempotency_key text) on commit drop;
   create temporary table artifacts(run_id text,kind text,content jsonb) on commit drop;`);
  await c.query("insert into workflow_runs(id,project_id,run_set_id,status) values('source','project','family','blocked')");
  assert.equal(await activeQueueSourceOnClient(c,'source'),true);
  for(const status of ['completed','cancelled']){await c.query('update workflow_runs set status=$1',[status]);assert.equal(await activeQueueSourceOnClient(c,'source'),false);}
  await c.query("update workflow_runs set status='blocked'");
  for(const hidden of ['failed_run_dismissed','failed_run_superseded']){
   await c.query('delete from action_receipts');
   await c.query("insert into action_receipts values('source',$1,clock_timestamp()-interval '1 second','{}','Synthetic historical disposition',null)",[hidden]);
   assert.equal(await activeQueueSourceOnClient(c,'source'),false,'A fresh reservation must recheck a disposition arriving after discovery');
   await c.query("insert into workflow_runs(id,project_id,run_set_id,status,evaluation_metadata) values('visible-child','project','family','blocked','{\"sourceRunId\":\"source\"}')");
   assert.equal(await activeQueueSourceOnClient(c,'visible-child'),true);
   assert.equal(await activeQueueSourceOnClient(c,'source'),false,'A visible replacement must not revive its superseded source');
   await c.query("insert into action_receipts values('source','failed_run_reinstated',clock_timestamp(),'{}','Explicit synthetic reinstatement',null)");
   assert.equal(await activeQueueSourceOnClient(c,'source'),true);
   await c.query("delete from workflow_runs where id='visible-child'");
  }
  const before=(await c.query('select * from workflow_runs order by id')).rows;
  assert.equal(await activeQueueSourceOnClient(c,'missing'),false);
  await activeQueueSourceOnClient(c,'source');
  assert.deepEqual((await c.query('select * from workflow_runs order by id')).rows,before);
  await c.query('delete from action_receipts');
  await c.query("update workflow_runs set evaluation_metadata='{\"codexThreadId\":\"synthetic-chat\"}' where id='source'");
  const withdrawn={authority:'direct-human',disposition:'withdrawn-unaccepted',viewOnly:true,originalAcceptanceChanged:false,executionAuthorityGranted:false,runId:'source',projectId:'project',originalTask:'Synthetic outcome',originatingThreadId:'synthetic-chat'};
  await c.query("insert into action_receipts values('source','workflow_run_withdrawn',clock_timestamp(),$1,'Synthetic direct human withdrawal','chain')",[withdrawn]);
  assert.equal(await activeQueueSourceOnClient(c,'source'),true,'Prose without its bound disposition artifact cannot hide work');
  await c.query("insert into artifacts values('source','operator_run_withdrawal',$1)",[withdrawn]);
  assert.equal(await activeQueueSourceOnClient(c,'source'),false,'Explicit withdrawal is not acceptance or successful replacement');
  await c.query("insert into workflow_tasks values('source','running')");
  assert.equal(await activeQueueSourceOnClient(c,'source'),true,'A newly active task cannot be concealed by historical withdrawal');
 }finally{await c.query('rollback');}
}));
