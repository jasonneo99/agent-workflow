import test from 'node:test';
import assert from 'node:assert/strict';
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';
import {acceptanceDigest} from './acceptance.js';
import {repairRevisionManifestHash} from './repaired-revision.js';
import {enrollLegacyRecoveryOnClient,getLegacyRecoveryEnrollmentOnClient,getEffectiveLegacyRecoveryEnrollmentOnClient,reconcileLegacyRecoveryBaselineOnClient,legacyRecoverySchemaSql,type LegacyRecoveryInput} from './legacy-recovery.js';

function fixture(){
 const task='All original behavior, offline only, every acceptance gate.';
 const input:LegacyRecoveryInput={sourceRunId:'source',projectId:'project',familyId:'project:family',taskHash:acceptanceDigest(task),sourcePaths:['src.ts'],owner:'owner',intentFence:'1',authorizationId:'initial'};
 const source={source_id:'source',project_key:'project',run_set_id:'family',root_uri:'/synthetic/project',canonical:true,task,evaluation_metadata:{},policy_snapshot:{}};
 let enrollment:any=null,currentHash='a'.repeat(64),pending=false,intent=true,chain=true,transitionProject=true;const revisions:any[]=[];
 const authority:any={...input,provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalSource:'direct-human',approvalDecision:'approved'};
 const reconciliationAuthority:any={};const write:any={relativePath:'src.ts',previousHash:'a'.repeat(64),nextHash:'b'.repeat(64)};
 const client={query:async(sql:string,args:any[]=[])=>{
  if(sql.includes("to_regclass('legacy_recovery_baseline_revisions')"))return {rows:[{present:true}]};
  if(sql.includes('from workflow_runs r join projects'))return {rows:[source],rowCount:1};
  if(sql.includes('select 1 from workflow_runs member'))return {rows:[],rowCount:pending?1:0};
  if(sql.includes('from work_intents'))return {rows:intent?[{file_scopes:input.sourcePaths}]:[]};
  if(sql.includes('from queue_coordinator_assignments'))return {rows:[],rowCount:0};
  if(sql.includes('operator_legacy_baseline_reconciliation_authorized'))return {rows:[{receipt_hash:'d'.repeat(64),metadata:reconciliationAuthority}]};
  if(sql.includes('operator_legacy_recovery_authorized'))return {rows:[{receipt_hash:'c'.repeat(64),metadata:authority}]};
  if(sql.startsWith('select created_at from legacy_recovery_enrollments'))return {rows:[{created_at:'2026-01-01'}]};
  if(sql.includes('from legacy_recovery_baseline_revisions'))return {rows:revisions};
  if(sql.includes('from legacy_recovery_enrollments'))return {rows:enrollment?[enrollment]:[]};
  if(sql.includes('join workflow_runs r on r.id=a.run_id'))return {rows:transitionProject?[{run_id:'writer',target:'src.ts',metadata:write,created_at:'2026-01-02'}]:[]};
  if(sql.startsWith('select 1 from artifacts'))return {rows:[{}],rowCount:1};
  if(sql.startsWith('insert into legacy_recovery_baseline_revisions')){revisions.push({payload:JSON.parse(args[4]),digest:args[5]});return {rows:[]};}
  if(sql.startsWith('insert into legacy_recovery_enrollments')){enrollment={payload:JSON.parse(args[2]),digest:args[3]};return {rows:[]};}
  // appendActionReceipt runs its own chain serialization and insert; synthetic
  // hook below intercepts only that audit boundary, not reconciliation proof.
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
  if(sql.startsWith('savepoint ')||sql.startsWith('release savepoint '))return {rows:[]};
  if(sql.startsWith('select id from workflow_runs'))return {rows:[{id:'source'}]};
  if(sql.includes('from action_receipts'))return {rows:[]};
  if(sql.includes('insert into action_receipts'))return {rows:[{receipt_hash:'f'.repeat(64)}]};
  throw new Error(sql);
 }} as unknown as Client;
 const hooks={manifest:async()=>[{path:'src.ts',mode:420,hash:currentHash}],chain:async()=>chain,canonicalRoot:async()=>true,audit:async()=>{}};
 async function prepare(){const e=await enrollLegacyRecoveryOnClient(client,input,hooks);currentHash='b'.repeat(64);const subjectHash=repairRevisionManifestHash(await hooks.manifest());const revisionInput={...input,authorizationId:'revision-human',previousDigest:acceptanceDigest(e),subjectHash,transitionReceiptHashes:['e'.repeat(64)]};Object.assign(reconciliationAuthority,{...revisionInput,enrollmentId:e.id,originalContractDigest:acceptanceDigest(e.contract),provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalSource:'direct-human',approvalDecision:'approved'});return {e,revisionInput};}
 return {client,hooks,prepare,revisions,source,write,reconciliationAuthority,get enrollment(){return enrollment;},set pending(v:boolean){pending=v;},set intent(v:boolean){intent=v;},set chain(v:boolean){chain=v;},set transitionProject(v:boolean){transitionProject=v;},set currentHash(v:string){currentHash=v;}};
}
test('append-only baseline reconciliation preserves original enrollment, requirements and gates',async()=>{
 const f=fixture(),{e,revisionInput}=await f.prepare(),original=JSON.stringify(f.enrollment);
 const revision=await reconcileLegacyRecoveryBaselineOnClient(f.client,revisionInput,f.hooks);
 assert.equal(JSON.stringify(f.enrollment),original);assert.deepEqual(await getLegacyRecoveryEnrollmentOnClient(f.client,'source',f.hooks),e);
 const effective=await getEffectiveLegacyRecoveryEnrollmentOnClient(f.client,'source',f.hooks);
 assert.equal(effective?.baselineRevisionId,revision.id);assert.equal(effective?.originalSubjectHash,e.subjectHash);assert.equal(effective?.subjectHash,revisionInput.subjectHash);
 assert.deepEqual(effective?.contract.deliverables,e.contract.deliverables);assert.equal(effective?.contract.contractId,e.contract.contractId);assert.equal(effective?.originalContractDigest,acceptanceDigest(e.contract));
});
test('wrong authority, stale intent, pending activity, cross-project transitions and manifest drift fail closed',async()=>{
 const mutations=[(f:ReturnType<typeof fixture>)=>{f.reconciliationAuthority.approvalSource='callback';},(f:ReturnType<typeof fixture>)=>{f.reconciliationAuthority.modelTier='other';},(f:ReturnType<typeof fixture>)=>{f.intent=false;},(f:ReturnType<typeof fixture>)=>{f.pending=true;},(f:ReturnType<typeof fixture>)=>{f.chain=false;},(f:ReturnType<typeof fixture>)=>{f.transitionProject=false;},(f:ReturnType<typeof fixture>)=>{f.write.previousHash='0'.repeat(64);},(f:ReturnType<typeof fixture>)=>{f.currentHash='9'.repeat(64);}];
 for(const mutate of mutations){const f=fixture(),{revisionInput}=await f.prepare();mutate(f);await assert.rejects(reconcileLegacyRecoveryBaselineOnClient(f.client,revisionInput,f.hooks));assert.equal(f.revisions.length,0);}
});
test('revision mutation and history rewriting are prohibited by schema',()=>{assert.match(legacyRecoverySchemaSql,/legacy_baseline_revision_immutable before update or delete/);assert.match(legacyRecoverySchemaSql,/legacy_baseline_revision_no_truncate before truncate/);assert.doesNotMatch(legacyRecoverySchemaSql,/update workflow_runs|delete from workflow_runs/);});
test('actual PostgreSQL revision is append-only and validates chained source transitions',async()=>{
 await withClient(async c=>{await c.query('begin');try{
  const schema=`baseline_revision_${randomUUID().replaceAll('-','')}`;
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
  const projectId=randomUUID(),sourceRunId=randomUUID(),set=randomUUID(),writer=randomUUID(),task='Every original requirement remains intact';
  await c.query('insert into projects values($1,$2)',[projectId,'/synthetic/project']);await c.query("insert into project_identity_locations values($1,$1,'canonical')",[projectId]);
  await c.query("insert into workflow_runs values($1,$2,$3,'blocked','{}','{}',$4)",[sourceRunId,projectId,task,set]);
  await c.query("insert into workflow_runs values($1,$2,'separate source work','completed','{}','{}',$3)",[writer,projectId,randomUUID()]);
  const input={sourceRunId,projectId,familyId:`${projectId}:${set}`,taskHash:acceptanceDigest(task),sourcePaths:['src.ts'],owner:'baseline-owner',intentFence:'1',authorizationId:randomUUID()};
  await c.query("insert into work_intents values($1,$2,1,$3,now()+interval '10 minutes')",[projectId,input.owner,JSON.stringify(input.sourcePaths)]);
  await appendActionReceipt(c,{runId:sourceRunId,agentId:'operator',actionType:'operator_legacy_recovery_authorized',target:input.authorizationId,summary:'Synthetic human initial baseline decision',metadata:JSON.stringify({...input,provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalSource:'direct-human',approvalDecision:'approved'})});
  let hash='a'.repeat(64);const hooks={canonicalRoot:async()=>true,manifest:async()=>[{path:'src.ts',mode:420,hash}]};
  const enrollment=await enrollLegacyRecoveryOnClient(c,input,hooks),original=JSON.stringify(enrollment);
  const write={relativePath:'src.ts',previousHash:hash,nextHash:'b'.repeat(64)};hash=write.nextHash;
  await c.query("insert into artifacts(run_id,kind,content) values($1,'file_write',$2)",[writer,JSON.stringify(write)]);
  await appendActionReceipt(c,{runId:writer,agentId:'implementation-agent',actionType:'file_write',target:'src.ts',summary:'Synthetic governed source update',metadata:JSON.stringify(write)});
  const receipt=(await c.query("select receipt_hash from action_receipts where run_id=$1",[writer])).rows[0].receipt_hash;
  const next={...input,authorizationId:randomUUID(),previousDigest:acceptanceDigest(enrollment),subjectHash:repairRevisionManifestHash(await hooks.manifest()),transitionReceiptHashes:[receipt]};
  await appendActionReceipt(c,{runId:sourceRunId,agentId:'operator',actionType:'operator_legacy_baseline_reconciliation_authorized',target:next.authorizationId,summary:'Synthetic exact reconciliation decision',metadata:JSON.stringify({...next,enrollmentId:enrollment.id,originalContractDigest:acceptanceDigest(enrollment.contract),provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalSource:'direct-human',approvalDecision:'approved'})});
  const revision=await reconcileLegacyRecoveryBaselineOnClient(c,next,hooks);
  assert.equal((await getEffectiveLegacyRecoveryEnrollmentOnClient(c,sourceRunId,hooks))?.baselineRevisionId,revision.id);
  assert.deepEqual(await getLegacyRecoveryEnrollmentOnClient(c,sourceRunId,hooks),JSON.parse(original));
  assert.equal((await c.query('select status from workflow_runs where id=$1',[sourceRunId])).rows[0].status,'blocked');
  await c.query('savepoint immutable');await assert.rejects(c.query("update legacy_recovery_baseline_revisions set digest='forged'"),/immutable/);await c.query('rollback to savepoint immutable');
  await assert.rejects(reconcileLegacyRecoveryBaselineOnClient(c,next,hooks),/current enrollment baseline/);
 }finally{await c.query('rollback');}});
});
