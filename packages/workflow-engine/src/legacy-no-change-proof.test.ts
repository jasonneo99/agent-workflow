import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import type {Client} from 'pg';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {databaseUrl} from '../../storage/src/client.js';
import {acceptanceDigest} from '../../storage/src/acceptance.js';
import {repairRevisionManifestHash} from '../../storage/src/repaired-revision.js';
import {verifyLegacyNoChangeRecoveryOnClient,legacyNoChangeSourceBindingOnClient,type LegacyNoChangeInput} from './legacy-no-change-proof.js';
const input:LegacyNoChangeInput={runId:'repair',taskId:'task',workerId:'owner:2',fencingToken:'3',projectRootUri:'/synthetic/project'};
function fixture(){
 const manifest=[{path:'source.ts',mode:420,hash:'a'.repeat(64)}],subjectHash=repairRevisionManifestHash(manifest),contract={subjectHash,sourcePaths:['source.ts'],deliverables:[{id:'all',description:'FULL original task',requiredGates:['implementation','verification','packaging','supervision']}]};
 const enrollment:any={mode:'legacy-current-baseline',enrollmentId:'enrollment',projectId:'project',projectRootUri:input.projectRootUri,provider:'codex-cli',modelTier:'standard',sourcePaths:['source.ts'],subjectHash,contract};
 const row:any={run_id:'repair',project_id:'project',claim_id:'claim',source_id:'source',enrollment_id:'enrollment',owner:'owner',intent_fence:'1',file_scopes:['source.ts'],intent_scopes:['source.ts'],root_uri:input.projectRootUri,provider_override:'codex-cli',model_tier_override:'standard',policy_snapshot:{actions:{allowed_write_paths:['source.ts']}},metadata:{source:'queue-coordinator-repair',sourceRunId:'source',legacyEnrollmentId:'enrollment',enrollmentMode:'legacy-current-baseline',originalAcceptanceDigest:acceptanceDigest(contract),workIntent:{owner:'owner',fencingToken:'1'}}};
 let baseline:any={payload:{legacyEnrollmentId:'enrollment',sourceRunId:'source',originalContractDigest:acceptanceDigest(contract),sourceHash:subjectHash,repairClaimId:'claim',projectId:'project',repairOwner:'owner',sourcePaths:['source.ts'],manifest},created_at:'2026-01-01T00:00:00Z'};baseline.digest=acceptanceDigest(baseline.payload);
 const commands:any[]=[{matched:true,content:{commandLine:'python3 -m unittest discover -s tests',exitCode:0,timedOut:false,cwd:input.projectRootUri,sourcePaths:['source.ts'],subjectHash,sourceBefore:subjectHash,sourceAfter:subjectHash}}];
 let boundary=false,chain=true,current=subjectHash;
 const client={query:async(sql:string)=>{
  if(sql.startsWith('select to_regclass'))return {rows:[{legacy:true,coordinator:true,revisions:true}],rowCount:1};
  if(sql.includes('from workflow_runs r join workflow_tasks'))return {rows:[row],rowCount:1};
  if(sql.startsWith('select payload,digest'))return {rows:[baseline],rowCount:1};
  if(sql.startsWith('select 1 from artifacts'))return {rows:boundary?[{}]:[],rowCount:boundary?1:0};
  if(sql.startsWith('select a.content'))return {rows:commands,rowCount:commands.length};
  throw Error('Unexpected query');
 }} as unknown as Client;
 return {client,row,enrollment,baseline,commands,hooks:{enrollment:async()=>enrollment,chain:async()=>chain,source:async()=>current},set boundary(v:boolean){boundary=v;},set chain(v:boolean){chain=v;},set current(v:string){current=v;}};
}
test('no-change proof requires real source-bound command evidence, not prose',async()=>{
 const f=fixture();assert.ok(await legacyNoChangeSourceBindingOnClient(f.client,input,f.hooks));
 assert.equal(await verifyLegacyNoChangeRecoveryOnClient(f.client,input,f.hooks),true);
 f.commands.length=0;assert.equal(await verifyLegacyNoChangeRecoveryOnClient(f.client,input,f.hooks),false);
 const whitespace=fixture();whitespace.commands[0].content.commandLine='git diff --check';assert.equal(await verifyLegacyNoChangeRecoveryOnClient(whitespace.client,input,whitespace.hooks),false);
 whitespace.commands[0].content.commandLine='pwd';assert.equal(await verifyLegacyNoChangeRecoveryOnClient(whitespace.client,input,whitespace.hooks),false);
});
test('changed baseline, source mode/scope, route, owner, intent or chain fail closed',async()=>{
 const changes:Array<(f:ReturnType<typeof fixture>)=>void>=[f=>{f.row.metadata.workIntent.owner='foreign';},f=>{f.row.intent_scopes=['other.ts'];},f=>{f.row.provider_override='other';},f=>{f.row.model_tier_override='reasoning';},f=>{f.boundary=true;},f=>{f.chain=false;},f=>{f.current='changed';},f=>{f.baseline.payload.repairClaimId='other';f.baseline.digest=acceptanceDigest(f.baseline.payload);},f=>{f.baseline.payload.repairOwner='other';f.baseline.digest=acceptanceDigest(f.baseline.payload);},f=>{f.baseline.payload.sourcePaths=['other.ts'];f.baseline.digest=acceptanceDigest(f.baseline.payload);},f=>{f.baseline.payload.manifest[0].mode=0;f.baseline.digest=acceptanceDigest(f.baseline.payload);}];
 for(const change of changes){const f=fixture();change(f);assert.equal(await verifyLegacyNoChangeRecoveryOnClient(f.client,input,f.hooks),false);}
});
test('failed, unreceipted or unbound historical commands cannot enable no-change completion',async()=>{
 for(const change of [(f:ReturnType<typeof fixture>)=>{f.commands[0].matched=false;},(f:ReturnType<typeof fixture>)=>{f.commands[0].content.exitCode=1;},(f:ReturnType<typeof fixture>)=>{f.commands[0].content.timedOut=true;},(f:ReturnType<typeof fixture>)=>{delete f.commands[0].content.subjectHash;},(f:ReturnType<typeof fixture>)=>{f.commands[0].content.sourceBefore='other';}]){const f=fixture();change(f);assert.equal(await verifyLegacyNoChangeRecoveryOnClient(f.client,input,f.hooks),false);}
 for(const timedOut of [undefined,'false',0,null]){const f=fixture();f.commands[0].content.timedOut=timedOut;assert.equal(await verifyLegacyNoChangeRecoveryOnClient(f.client,input,f.hooks),false);}
});
test('real SQL fences the exact worker/task, baseline chronology and matching governed receipts',async()=>{
 const source=await fs.readFile(new URL('./legacy-no-change-proof.ts',import.meta.url),'utf8');
 for(const guard of ["$3=q.owner||':'||q.fence::text","t.lease_generation::text=$4","q.state='running'","q.role='repair'","expires_at>clock_timestamp()","receipt.metadata=a.content","a.created_at>$3","getLegacyRecoveryEnrollmentOnClient"])assert.ok(source.includes(guard),guard);
});
test('PostgreSQL joins enforce live exact authority and reject wrong-worker, expired and failing evidence',async()=>{
 const c=new pg.Client({connectionString:databaseUrl()});await c.connect();
 const schema=`nochange_${randomUUID().replaceAll('-','')}`;
 try{await c.query('begin');await c.query(`create schema ${schema};set local search_path to ${schema},public`);
  await c.query(`create table projects(id uuid,root_uri text);
   create table workflow_runs(id uuid,project_id uuid,evaluation_metadata jsonb,provider_override text,model_tier_override text,policy_snapshot jsonb,status text,lease_owner text,lease_expires_at timestamptz);
   create table workflow_tasks(id uuid,run_id uuid,worker_id text,lease_generation bigint,status text,lease_expires_at timestamptz);
   create table queue_coordinator_assignments(id uuid,child_run_id uuid,project_id uuid,source_run_id uuid,legacy_enrollment_id uuid,owner text,intent_fence text,file_scopes jsonb,state text,role text,fence bigint);
   create table work_intents(project_id text,owner text,fencing_token bigint,expires_at timestamptz,file_scopes jsonb);
   create table legacy_recovery_enrollments(id uuid);
   create table repaired_revision_records(claim_id uuid,kind text,payload jsonb,digest text,created_at timestamptz);
   create table artifacts(run_id uuid,kind text,content jsonb,created_at timestamptz);
   create table action_receipts(run_id uuid,action_type text,target text,metadata jsonb,metadata_serialization_version int);
   create table action_approvals(run_id uuid,status text);`);
  const f=fixture(),project=randomUUID(),source=randomUUID(),repair=randomUUID(),task=randomUUID(),claim=randomUUID(),enrollmentId=randomUUID();
  const real={...input,runId:repair,taskId:task};
  const enrollment={...f.enrollment,projectId:project,enrollmentId};
  const metadata={...f.row.metadata,sourceRunId:source,legacyEnrollmentId:enrollmentId,queueCoordinatorClaimId:claim,queueCoordinatorFence:'2'};
  const baseline={...f.baseline.payload,sourceRunId:source,projectId:project,repairClaimId:claim,legacyEnrollmentId:enrollmentId};
  const command={...f.commands[0].content,requestedByTaskId:task};
  await c.query('insert into projects values($1,$2)',[project,input.projectRootUri]);
  await c.query("insert into workflow_runs values($1,$2,$3::jsonb,'codex-cli','standard',$4::jsonb,'running',$5,clock_timestamp()+interval '1 hour')",[repair,project,JSON.stringify(metadata),JSON.stringify(f.row.policy_snapshot),input.workerId]);
  await c.query("insert into workflow_tasks values($1,$2,$3,3,'running',clock_timestamp()+interval '1 hour')",[task,repair,input.workerId]);
  await c.query("insert into queue_coordinator_assignments values($1,$2,$3,$4,$5,'owner','1',$6::jsonb,'running','repair',2)",[claim,repair,project,source,enrollmentId,JSON.stringify(['source.ts'])]);
  await c.query("insert into work_intents values($1,'owner',1,clock_timestamp()+interval '1 hour',$2::jsonb)",[project,JSON.stringify(['source.ts'])]);
  await c.query("insert into repaired_revision_records values($1,'baseline',$2::jsonb,$3,clock_timestamp()-interval '1 minute')",[claim,JSON.stringify(baseline),acceptanceDigest(baseline)]);
  await c.query("insert into artifacts values($1,'command_output',$2::jsonb,clock_timestamp())",[repair,JSON.stringify(command)]);
  await c.query("insert into action_receipts values($1,'local_command',$2,$3::jsonb,2)",[repair,command.commandLine,JSON.stringify(command)]);
  const hooks={...f.hooks,enrollment:async()=>enrollment};
  assert.equal(await verifyLegacyNoChangeRecoveryOnClient(c,real,hooks),true);
  assert.equal(await verifyLegacyNoChangeRecoveryOnClient(c,{...real,workerId:'worker-a'},hooks),false);
  assert.equal(await verifyLegacyNoChangeRecoveryOnClient(c,{...real,fencingToken:'2'},hooks),false);
  await c.query("update work_intents set expires_at=clock_timestamp()-interval '1 minute'");assert.equal(await verifyLegacyNoChangeRecoveryOnClient(c,real,hooks),false);
  await c.query("update work_intents set expires_at=clock_timestamp()+interval '1 hour'");
  await c.query('update work_intents set file_scopes=$1::jsonb',[JSON.stringify(['other.ts'])]);assert.equal(await verifyLegacyNoChangeRecoveryOnClient(c,real,hooks),false);
  await c.query('update work_intents set file_scopes=$1::jsonb',[JSON.stringify(['source.ts'])]);
  await c.query('update artifacts set content=$1::jsonb',[JSON.stringify({...command,exitCode:1})]);assert.equal(await verifyLegacyNoChangeRecoveryOnClient(c,real,hooks),false,'Unmatched failing output is not filtered away');
  await c.query('update action_receipts set metadata=$1::jsonb',[JSON.stringify({...command,exitCode:1})]);assert.equal(await verifyLegacyNoChangeRecoveryOnClient(c,real,hooks),false,'Even matched failing evidence refuses the exception');
 }finally{await c.query('rollback');await c.end();}
});
