import assert from 'node:assert/strict';
import test from 'node:test';
import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';
import {enrollLegacyRecoveryOnClient,getLegacyRecoveryEnrollmentOnClient,legacyRecoverySchemaSql,type LegacyRecoveryInput} from './legacy-recovery.js';
const input:LegacyRecoveryInput={sourceRunId:'source',projectId:'project',familyId:'project:family',taskHash:acceptanceDigest('FULL original task\nEvery requirement remains.'),sourcePaths:['source.ts'],owner:'owner',intentFence:'1',authorizationId:'human-decision'};
function fixture(){
 const source:any={source_id:'source',project_key:'project',run_set_id:'family',root_uri:'/synthetic/project',canonical:true,task:'FULL original task\nEvery requirement remains.',evaluation_metadata:{},policy_snapshot:{actions:{allowed_write_paths:['source.ts']}}};
 const metadata:any={...input,provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalDecision:'approved',approvalSource:'direct-human'};
 let stored:any=null,pending=false,intent:any={file_scopes:['source.ts']},chain=true,writes:string[]=[];
 const client={query:async(sql:string,args:any[]=[])=>{
  if(sql.includes('from workflow_runs r join projects'))return {rows:[source],rowCount:1};
  if(sql.includes('select 1 from workflow_runs member'))return {rows:pending?[{}]:[],rowCount:pending?1:0};
  if(sql.includes('from work_intents'))return {rows:intent?[intent]:[],rowCount:intent?1:0};
  if(sql.includes('from action_receipts'))return {rows:[{receipt_hash:'a'.repeat(64),metadata}],rowCount:1};
  if(sql.startsWith('select payload,digest'))return {rows:stored?[stored]:[],rowCount:stored?1:0};
  if(sql.startsWith('insert into legacy_recovery')){stored={payload:JSON.parse(args[2]),digest:args[3]};writes.push(sql);return {rows:[],rowCount:1};}
  throw new Error(`Unexpected query ${sql}`);
 }} as unknown as Client;
 const hooks={manifest:async()=>[{path:'source.ts',mode:420,hash:'b'.repeat(64)}],canonicalRoot:async()=>true,chain:async()=>chain,audit:async()=>{}};
 return {client,hooks,source,metadata,writes,get stored(){return stored;},set pending(v:boolean){pending=v;},set intent(v:any){intent=v;},set chain(v:boolean){chain=v;}};
}
test('fresh legacy baseline preserves full original requirements, separate mode, all gates and route',async()=>{
 const f=fixture(),before=JSON.stringify(f.source);const result=await enrollLegacyRecoveryOnClient(f.client,input,f.hooks);
 assert.equal(result.mode,'legacy-current-baseline');assert.equal(result.contract.deliverables[0].description,f.source.task);
 assert.deepEqual(result.contract.deliverables[0].requiredGates,['implementation','verification','packaging','supervision']);
 assert.equal(result.contract.originRunId,'source');assert.match(result.contract.contractId,/^legacy-current-baseline:/);
 assert.equal(result.provider,'codex-cli');assert.equal(result.modelTier,'standard');assert.equal(result.offlineOnly,true);
 assert.equal(JSON.stringify(f.source),before);assert.equal(f.writes.length,1);
 assert.deepEqual(await getLegacyRecoveryEnrollmentOnClient(f.client,'source',f.hooks),result);
 // JSONB canonicalizes object keys; source hashing retains its explicit
 // path/mode/hash algorithm, not the driver's returned property insertion order.
 f.stored.payload.manifest=f.stored.payload.manifest.map((e:any)=>({hash:e.hash,mode:e.mode,path:e.path}));
 assert.deepEqual(await getLegacyRecoveryEnrollmentOnClient(f.client,'source',f.hooks),result);
 assert.deepEqual(await enrollLegacyRecoveryOnClient(f.client,input,f.hooks),result);assert.equal(f.writes.length,1);
});
test('missing scope authority, stale fence, active work, invalid chain and evaluations fail closed',async()=>{
 const changes:Array<(f:ReturnType<typeof fixture>)=>void>=[f=>{f.metadata.approvalSource='model';},f=>{f.metadata.modelTier='reasoning';},f=>{f.intent=null;},f=>{f.intent={file_scopes:['other.ts']};},f=>{f.pending=true;},f=>{f.chain=false;},f=>{f.source.evaluation_metadata={suiteId:'evaluation'};},f=>{f.source.evaluation_metadata={acceptanceContract:{version:1}};},f=>{f.source.canonical=false;},f=>{f.source.root_uri='/synthetic/vendor/project';}];
 for(const change of changes){
  const f=fixture();change(f);await assert.rejects(enrollLegacyRecoveryOnClient(f.client,input,f.hooks));assert.equal(f.writes.length,0);
 }
 const f=fixture();await assert.rejects(enrollLegacyRecoveryOnClient(f.client,{...input,sourcePaths:['../escape']},f.hooks));
});
test('resolver refuses changed task, policy, authorization, digest or weakened requirement gates',async()=>{
 const changes:Array<(f:ReturnType<typeof fixture>)=>void>=[f=>{f.source.task='weakened';},f=>{f.source.evaluation_metadata={acceptanceContract:{version:1}};},f=>{f.source.policy_snapshot={different:true};},f=>{f.metadata.offlineOnly=false;},f=>{f.stored.digest='c'.repeat(64);},f=>{f.stored.payload.contract.deliverables[0].requiredGates=['verification'];f.stored.digest=acceptanceDigest(f.stored.payload);}];
 for(const change of changes){
  const f=fixture();await enrollLegacyRecoveryOnClient(f.client,input,f.hooks);change(f);await assert.rejects(getLegacyRecoveryEnrollmentOnClient(f.client,'source',f.hooks));
 }
});
test('family changes during actual manifest capture prevent enrollment, and chain receives same client',async()=>{
 const f=fixture();let sameClient=false;
 await assert.rejects(enrollLegacyRecoveryOnClient(f.client,input,{...f.hooks,chain:async(_id,c)=>{sameClient=c===f.client;return true;},manifest:async()=>{f.pending=true;return f.hooks.manifest();}}),/pending/);
 assert.equal(sameClient,true);assert.equal(f.writes.length,0);
});
test('schema preserves append-only evidence and never rewrites historical workflow rows',()=>{
 assert.match(legacyRecoverySchemaSql,/before update or delete/);assert.match(legacyRecoverySchemaSql,/before truncate/);
 assert.doesNotMatch(legacyRecoverySchemaSql,/update workflow_runs|delete from workflow_runs|alter table workflow_runs/);
});
