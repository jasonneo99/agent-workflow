import assert from 'node:assert/strict';
import test from 'node:test';
import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';
import {holdDriftedPartnerChildOnClient,type PartnerDriftDisposition} from './queue-partner-drift.js';
import {chainReceipt} from '../../workflow-engine/src/receipt-chain.js';

function fixture(){
 const paths=['src/example.ts'],task='Preserve every original requirement';
 const input:PartnerDriftDisposition={assignmentId:'assignment',childRunId:'child',fence:'7',
  owner:'fresh-owner',intentFence:'2',authorizationId:'human-decision',currentSubjectHash:'b'.repeat(64)};
 const q:any={role:'repair',state:'running',claim_fence:'7',child_status:'running',live_run_lease:false,
  source_status:'blocked',family_id:'project:set',project_key:'project',source_set:'set',source_id:'original',
  owner:'expired-owner',intent_fence:'1',root_uri:'/synthetic/root',original_task:task,file_scopes:paths,
  child_metadata:{source:'queue-partner-recovery',sourceRunId:'original',queueCoordinatorClaimId:'assignment',
   queueCoordinatorFence:'7',recoveryTaskHash:acceptanceDigest(task),recoveryWritePaths:paths,recoverySubjectHash:'a'.repeat(64),
   workIntent:{owner:'expired-owner',fencingToken:'1'}}};
 const proofMetadata={id:'assignment',fence:'7',sourceRunId:'original',projectId:'project',familyId:'project:set',
  taskHash:acceptanceDigest(task),purpose:'autonomous-recovery',sourceHash:'a'.repeat(64),writePaths:paths,owner:'expired-owner',intentFence:'1'};
 const proofInput={runId:'original',agentId:'workflow-orchestrator',actionType:'queue_partner_reasoning_reserved',
  target:'assignment',summary:'Synthetic reservation',metadata:JSON.stringify(proofMetadata),metadataSerializationVersion:2 as const,createdAt:'2026-01-01T00:00:00.000Z'};
 const hashed=chainReceipt('0'.repeat(64),proofInput);
 const proof={run_id:'original',agent_id:proofInput.agentId,action_type:proofInput.actionType,target:proofInput.target,
  summary:proofInput.summary,metadata:proofMetadata,metadata_serialization_version:2,created_at:proofInput.createdAt,
  prev_hash:hashed.prevHash,receipt_hash:hashed.receiptHash};
 const auth:any={approvalSource:'direct-human',approvalDecision:'approved',offlineOnly:true,sourceRunId:'original',
  projectId:'project',familyId:'project:set',taskHash:acceptanceDigest(task),sourcePaths:paths};
 const childTask:any={id:'task',status:'queued',worker_id:null,live_lease:false,lease_generation:'3'};
 const control={oldIntent:false,approvals:false,effects:false,chain:true,canonical:true,registered:true,
  hash:input.currentSubjectHash,intent:paths as string[],changes:[] as string[],receipts:[] as any[],transitions:[] as any[]};
 const c={query:async(sql:string,_values?:unknown[])=>{
  if(sql.includes('select q.*'))return {rows:[q]};
  if(sql.includes('select id::text,status,worker_id'))return {rows:[childTask]};
  if(sql.includes('select file_scopes from work_intents'))return {rows:[{file_scopes:control.intent}]};
  if(sql.includes('select 1 from work_intents'))return {rowCount:control.oldIntent?1:0,rows:[]};
  if(sql.includes('select 1 from action_approvals'))return {rowCount:control.approvals?1:0,rows:[]};
  if(sql.includes('select 1 from side_effect_receipts'))return {rowCount:control.effects?1:0,rows:[]};
  if(sql.includes('select 1 from project_identity_locations'))return {rowCount:control.registered?1:0,rows:[]};
  if(sql.includes('select metadata,receipt_hash'))return {rows:[{metadata:auth,receipt_hash:'c'.repeat(64)}]};
  if(sql.includes("action_type='queue_partner_reasoning_reserved'"))return {rows:[proof]};
  if(sql.includes('select uri,content'))return {rows:[{uri:'checkpoint',content:{round:2,actionResults:['kept']}}]};
  if(sql.startsWith('update ')||sql.startsWith('insert ')){control.changes.push(sql);return {rowCount:1,rows:[{id:'task'}]};}
  if(sql.includes('pg_advisory_xact_lock'))return {rows:[]};
  throw Error('Unexpected query '+sql);
 }} as unknown as Client;
 const hooks={hash:async()=>control.hash,canonical:async()=>control.canonical,chain:async()=>control.chain,
  transition:async(_c:Client,value:any)=>{control.transitions.push(value);return {changed:true,status:'blocked' as const,stateVersion:'3',leaseEpoch:'1'};},
  receipt:async(_c:Client,value:any)=>{control.receipts.push(value);}};
 return {input,q,auth,proof,childTask,control,c,hooks};
}

test('exact authorized quiescent drift becomes held, never accepted or replayed',async()=>{
 const f=fixture(),before=JSON.stringify(f.q.child_metadata);
 const evidence=await holdDriftedPartnerChildOnClient(f.c,f.input,f.hooks);
 assert.equal(evidence.acceptance,'unverified');assert.equal(evidence.replayed,false);assert.equal(evidence.cancelled,false);
 assert.equal(evidence.snapshotsChanged,false);assert.equal(evidence.budgetRefunded,false);
 assert.equal(JSON.stringify(f.q.child_metadata),before);assert.equal(f.control.transitions[0].to,'blocked');
 assert.equal(f.control.receipts.length,2);assert.deepEqual(f.control.receipts.map(r=>r.runId),['original','child']);
 assert.ok(f.control.changes.some(s=>s.includes("state='held'")));
 assert.ok(!f.control.changes.some(s=>/delete|cancelled|evaluation_metadata|policy_snapshot|stage_continuation.*update|set owner=/u.test(s)));
});

test('live workers, owners, approvals, effects, identity and source mismatches refuse before mutation',async()=>{
 const mutations:Array<(f:ReturnType<typeof fixture>)=>void>=[
  f=>{f.q.live_run_lease=true;},f=>{f.childTask.live_lease=true;},f=>{f.childTask.worker_id='live-worker';},
  f=>{f.childTask.status='running';},f=>{f.control.oldIntent=true;},f=>{f.control.approvals=true;},
  f=>{f.control.effects=true;},f=>{f.control.chain=false;},f=>{f.auth.approvalSource='callback';},
  f=>{f.auth.taskHash='wrong';},f=>{f.auth.sourcePaths=['other.ts'];},f=>{f.q.claim_fence='8';},
  f=>{f.control.hash='a'.repeat(64);},f=>{f.control.hash='d'.repeat(64);},
  f=>{f.control.intent=['other.ts'];},f=>{f.control.canonical=false;},f=>{f.control.registered=false;},
  f=>{f.q.child_metadata.sourceRunId='foreign';},f=>{f.q.state='held';},
  f=>{f.proof.receipt_hash='0'.repeat(64);},f=>{f.q.child_metadata.workIntent.owner='forged';}
 ];
 for(const mutate of mutations){const f=fixture();mutate(f);
  await assert.rejects(holdDriftedPartnerChildOnClient(f.c,f.input,f.hooks),/refused/);
  assert.equal(f.control.changes.length,0);assert.equal(f.control.transitions.length,0);assert.equal(f.control.receipts.length,0);
 }
});

test('source changes during observation refuse without altering task or checkpoint',async()=>{
 const f=fixture();let calls=0;
 f.hooks.hash=async()=>++calls===1?f.input.currentSubjectHash:'d'.repeat(64);
 await assert.rejects(holdDriftedPartnerChildOnClient(f.c,f.input,f.hooks),/source changed/);
 assert.equal(f.control.changes.length,0);
});
