import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';
import {acceptanceDigest} from './acceptance.js';
import {repairRevisionManifestHash} from './repaired-revision.js';
import {legacyRecoverySchemaSql,enrollLegacyRecoveryOnClient,getLegacyRecoveryEnrollmentOnClient,
 getEffectiveLegacyRecoveryEnrollmentOnClient,observeLegacyRecoveryCurrentSourceOnClient} from './legacy-recovery.js';

async function fixture(body:(f:any)=>Promise<void>,authorityOverrides:Record<string,unknown>={}){
 await withClient(async c=>{await c.query('begin');try{
  const schema=`current_observation_${randomUUID().replaceAll('-','')}`;
  await c.query(`create schema ${schema};set local search_path to ${schema},public;
   create table projects(id uuid primary key,root_uri text);
   create table workflow_runs(id uuid primary key,project_id uuid,task text,status text,evaluation_metadata jsonb,policy_snapshot jsonb,run_set_id uuid);
   create table project_identity_locations(project_id uuid,identity_id uuid,kind text);
   create table action_approvals(id uuid primary key,run_id uuid,status text);
   create table action_receipts(id uuid primary key default gen_random_uuid(),run_id uuid,agent_id text,action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,metadata_serialization_version int,created_at timestamptz default clock_timestamp());
   create table artifacts(id uuid primary key default gen_random_uuid(),run_id uuid,kind text,uri text,content jsonb);
   create table work_intents(project_id text,owner text,fencing_token bigint,file_scopes jsonb,expires_at timestamptz);
   create table queue_coordinator_assignments(project_id uuid,state text,file_scopes jsonb);`);
  await c.query(legacyRecoverySchemaSql);
  const projectId=randomUUID(),sourceRunId=randomUUID(),set=randomUUID(),task='All original requirements, including native acceptance, remain pending.';
  await c.query('insert into projects values($1,$2)',[projectId,'/synthetic/root']);
  await c.query("insert into project_identity_locations values($1,$1,'canonical')",[projectId]);
  await c.query("insert into workflow_runs values($1,$2,$3,'blocked','{}','{}',$4)",[sourceRunId,projectId,task,set]);
  const input={sourceRunId,projectId,familyId:`${projectId}:${set}`,taskHash:acceptanceDigest(task),sourcePaths:['src.ts'],owner:'synthetic-owner',intentFence:'1',authorizationId:randomUUID()};
  await c.query("insert into work_intents values($1,$2,1,$3,clock_timestamp()+interval '10 minutes')",[projectId,input.owner,JSON.stringify(input.sourcePaths)]);
  const authorize=async(id:string,extra:Record<string,unknown>={})=>appendActionReceipt(c,{runId:sourceRunId,agentId:'workflow-orchestrator',actionType:'operator_legacy_recovery_authorized',target:id,
   summary:'Synthetic direct human current-source authorization',metadata:JSON.stringify({...input,authorizationId:id,provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalSource:'direct-human',approvalDecision:'approved',...extra})});
  await authorize(input.authorizationId);
  let hash='a'.repeat(64);
  const hooks={canonicalRoot:async()=>true,manifest:async()=>[{path:'src.ts',mode:420,hash}]};
  const enrollment=await enrollLegacyRecoveryOnClient(c,input,hooks);
  hash='b'.repeat(64);
  await new Promise(resolve=>setTimeout(resolve,5));
  const currentAuthorization=randomUUID();await authorize(currentAuthorization,authorityOverrides);
  const observation={...input,authorizationId:currentAuthorization,previousDigest:acceptanceDigest(enrollment),
   subjectHash:repairRevisionManifestHash(await hooks.manifest()),acknowledgeUnprovenContinuity:true as const};
  await body({c,input,enrollment,hooks,observation,projectId,sourceRunId,set,setHash:(value:string)=>{hash=value;}});
 }finally{await c.query('rollback');}});
}

test('new human-authorized observation preserves immutable enrollment, full gates and unverified historical continuity',async()=>{
 await fixture(async f=>{
  const before=JSON.stringify(await getLegacyRecoveryEnrollmentOnClient(f.c,f.sourceRunId,f.hooks));
  const observation=await observeLegacyRecoveryCurrentSourceOnClient(f.c,f.observation,f.hooks);
  assert.equal(observation.observationMode,'independent-current-source');assert.equal(observation.historicalContinuity,'unverified');
  assert.equal(observation.acceptance,'unverified');assert.deepEqual(observation.transitionReceiptHashes,[]);
  assert.equal(JSON.stringify(await getLegacyRecoveryEnrollmentOnClient(f.c,f.sourceRunId,f.hooks)),before);
  const effective=await getEffectiveLegacyRecoveryEnrollmentOnClient(f.c,f.sourceRunId,f.hooks);
  assert.equal(effective?.subjectHash,f.observation.subjectHash);assert.equal(effective?.originalSubjectHash,f.enrollment.subjectHash);
  assert.deepEqual(effective?.contract.deliverables,f.enrollment.contract.deliverables);
  assert.equal(effective?.originalContractDigest,acceptanceDigest(f.enrollment.contract));
  assert.equal((await f.c.query('select status from workflow_runs where id=$1',[f.sourceRunId])).rows[0].status,'blocked');
  await assert.rejects(observeLegacyRecoveryCurrentSourceOnClient(f.c,f.observation,f.hooks),/current baseline/);
  await f.c.query('savepoint immutable');
  await assert.rejects(f.c.query("update legacy_recovery_baseline_revisions set digest='forged'"),/immutable/);
  await f.c.query('rollback to savepoint immutable');
 });
});

test('callback authority and widened scopes cannot replace an original baseline',async()=>{
 for(const override of [{approvalSource:'callback'},{sourcePaths:['other.ts']},{offlineOnly:false},{modelTier:'reasoning'}]){
  await fixture(async f=>{
   await assert.rejects(observeLegacyRecoveryCurrentSourceOnClient(f.c,f.observation,f.hooks));
   assert.equal((await f.c.query('select count(*)::int count from legacy_recovery_baseline_revisions')).rows[0].count,0);
  },override);
 }
});

test('active family, overlapping assignment, expired fence, stale observation and absent acknowledgment fail closed',async()=>{
 const mutations=[
  async(f:any)=>{await f.c.query("update workflow_runs set status='running' where id=$1",[f.sourceRunId]);},
  async(f:any)=>{await f.c.query("insert into queue_coordinator_assignments values($1,'running',$2)",[f.projectId,JSON.stringify(['src.ts'])]);},
  async(f:any)=>{await f.c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second'");},
  async(f:any)=>{f.setHash('d'.repeat(64));},
  async(f:any)=>{f.observation.acknowledgeUnprovenContinuity=false;},
  async(f:any)=>{f.observation.authorizationId=f.input.authorizationId;}
 ];
 for(const mutate of mutations){await fixture(async f=>{
  await mutate(f);await assert.rejects(observeLegacyRecoveryCurrentSourceOnClient(f.c,f.observation,f.hooks));
  assert.equal((await f.c.query('select count(*)::int count from legacy_recovery_baseline_revisions')).rows[0].count,0);
 });}
});
