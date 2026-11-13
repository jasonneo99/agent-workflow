import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {acceptanceDigest} from '../../../../packages/storage/src/acceptance.js';
import {recoverEnrollmentInput,recoverPartnerEnrollments,reviewedCanonicalRoot,currentRepairEvidenceValid,currentRepairReceiptSegmentValid,recoveryDiscoveryCohortKey,type RecoveryEvidence} from './queue-partner-recovery.js';
import {PartnerPlanningStopped} from './queue-partner-watch.js';
import {computeReceiptHash} from '../../../../packages/workflow-engine/src/receipt-chain.js';
function fixture():RecoveryEvidence{
  const r:RecoveryEvidence={id:'original',projectId:'child-project',runSetId:'family',root:'/synthetic/parent/child',task:'Preserve every requirement',status:'blocked',canonical:true,metadata:{},authorization:null};
  r.authorization={sourceRunId:r.id,projectId:r.projectId,familyId:`${r.projectId}:${r.runSetId}`,taskHash:acceptanceDigest(r.task),sourcePaths:['src/main.ts'],provider:'codex-cli',modelTier:'standard',offlineOnly:true,authorizationId:'explicit',approvalSource:'direct-human',approvalDecision:'approved'};
  return r;
}
test('stopped recovery cannot begin discovery or acquire a new enrollment intent',async()=>{
 await assert.rejects(()=>recoverPartnerEnrollments([],new Set(),true,()=>true),PartnerPlanningStopped);
});
test('authentic exact enrollment evidence is recovered without altering original history',()=>{
  const r=fixture(),before=JSON.stringify(r),result=recoverEnrollmentInput(r);
  assert.ok(!('hold' in result));assert.equal(result.projectId,'child-project');assert.deepEqual(result.sourcePaths,['src/main.ts']);assert.equal(JSON.stringify(r),before);
});
test('path ownership never transfers a parent grant, route or scope',()=>{
  for(const change of [{projectId:'parent'},{sourceRunId:'other'},{familyId:'parent:family'},{taskHash:'wrong'},{approvalSource:'callback'},{modelTier:'fast'},{offlineOnly:false},{sourcePaths:['../escape']},{sourcePaths:['vendor/product/main.ts']},{sourcePaths:['id_ed25519']},{sourcePaths:['src/main.ts','src/main.ts']}]){
    const r=fixture();r.authorization={...r.authorization,...change};assert.ok('hold' in recoverEnrollmentInput(r));
  }
});
test('cancelled, evaluation, derived and immutable-contract jobs are never enrolled as legacy work',()=>{
  for(const metadata of [{evaluationId:'evaluation'},{source:'training'},{replayOfRunId:'ancestor'},{acceptanceContract:{version:1}}]){const r=fixture();r.metadata=metadata;assert.ok('hold' in recoverEnrollmentInput(r));}
  const r=fixture();r.status='cancelled';assert.match((recoverEnrollmentInput(r) as {hold:string}).hold,/Cancelled/);
  r.status='blocked';r.authorization=null;assert.match((recoverEnrollmentInput(r) as {hold:string}).hold,/authorization/);
});
test('missing-provenance cohorts are project-scoped and never absorb authorized rows',()=>{
 const a=fixture();a.authorization=null;const hold=(recoverEnrollmentInput(a) as {hold:string}).hold;
 const key=recoveryDiscoveryCohortKey(a,hold);assert.ok(key);assert.doesNotMatch(key,/authorization|baseline/);
 const same={...a,id:'other',runSetId:'other-family'};assert.equal(recoveryDiscoveryCohortKey(same,hold),key);
 assert.notEqual(recoveryDiscoveryCohortKey({...same,projectId:'other-project'},hold),key);
 assert.equal(recoveryDiscoveryCohortKey(fixture(),hold),undefined);
});
test('registered real child paths are related; sibling prefix, vendor and symlink escapes are not',async()=>{
  const tmp=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'partner-root-'));
  try{
    const parent=path.join(tmp,'root'),child=path.join(parent,'child'),sibling=path.join(tmp,'root-other'),vendor=path.join(parent,'vendor','child');
    await fs.mkdir(child,{recursive:true});await fs.mkdir(sibling);await fs.mkdir(vendor,{recursive:true});await fs.symlink(sibling,path.join(parent,'alias'));
    assert.equal(await reviewedCanonicalRoot(child,[parent]),true);
    assert.equal(await reviewedCanonicalRoot(parent,[parent]),true);
    assert.equal(await reviewedCanonicalRoot(sibling,[parent]),false);
    assert.equal(await reviewedCanonicalRoot(vendor,[parent]),false);
    assert.equal(await reviewedCanonicalRoot(path.join(parent,'alias'),[parent]),false);
    assert.equal(await reviewedCanonicalRoot(path.join(parent,'missing'),[parent]),false);
    assert.equal(await reviewedCanonicalRoot('/unavailable/unrelated/project',[parent]),false);
  }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('current source repair evidence prevents duplicate source work but never claims original acceptance',()=>{
  const r=fixture(),auth={authorizationId:'exact',projectId:r.projectId,approvalSource:'direct-human',approvalDecision:'approved',originalTaskHash:acceptanceDigest(r.task),offlineOnly:true,replayAllowed:false,approvalTransfer:false,authorizedCommands:['synthetic-offline-test'],sourcePaths:['src/main.ts']};
  const proof={authorizationId:'exact',sourceRunId:r.id,projectId:r.projectId,command:'synthetic-offline-test',exitCode:0,sourceRepair:'verified',independentOfflineReview:true,acceptance:'unverified',nativeAcceptance:false,replay:false,approvalTransfer:false,sourcePaths:auth.sourcePaths,postimages:[{path:'src/main.ts',hash:'a'.repeat(64)}]};
  assert.equal(currentRepairEvidenceValid(r,proof,auth),true);
  for(const patch of [{sourceRunId:'foreign'},{projectId:'parent'},{exitCode:1},{acceptance:'accepted'},{nativeAcceptance:true},{replay:true},{postimages:[{path:'../escape',hash:'a'.repeat(64)}]}])assert.equal(currentRepairEvidenceValid(r,{...proof,...patch},auth),false);
  assert.equal(currentRepairEvidenceValid(r,proof,{...auth,originalTaskHash:'changed'}),false);
});
test('new source proof requires exact run/actor and linked untampered receipt segment, not historical-chain acceptance',()=>{
  const row=fixture(),authorization={authorizationId:'exact'},content={sourceRunId:row.id};
  const make=(action:string,target:string,metadata:any,prev:string)=>{
    const r={run_id:row.id,agent_id:'workflow-orchestrator',action_type:action,target,summary:'Synthetic offline source evidence',metadata,prev_hash:prev,created_at:'2030-01-01T00:00:00.000Z',metadata_serialization_version:2,receipt_hash:''};
    r.receipt_hash=computeReceiptHash(prev,{runId:r.run_id,agentId:r.agent_id,actionType:action,target,summary:r.summary,metadata:JSON.stringify(metadata),createdAt:r.created_at,metadataSerializationVersion:2});return r;
  };
  const a=make('operator_current_source_repair_authorized','exact',authorization,'a'.repeat(64)),p=make('operator_current_source_repair_verified','artifact',content,a.receipt_hash);
  const record={uri:'artifact',content,authorization,authorityReceipt:a,proofReceipt:p};
  assert.equal(currentRepairReceiptSegmentValid(row,record),true);
  for(const patch of [{run_id:'foreign'},{agent_id:'model'},{metadata:{forged:true}},{prev_hash:'b'.repeat(64)},{target:'foreign-artifact'}])assert.equal(currentRepairReceiptSegmentValid(row,{...record,proofReceipt:{...p,...patch}}),false);
  assert.equal(currentRepairReceiptSegmentValid(row,{...record,authorityReceipt:{...a,summary:'tampered'}}),false);
});

test('recovery keeps enrollment and discovery budgets independent and includes only exact hidden receipt-write observations',async()=>{
 const source=await fs.readFile(new URL('./queue-partner-recovery.ts',import.meta.url),'utf8');
 assert.match(source,/orderPartnerRecoveryRows\(rows,discoveryCursor,Math.floor\(Date.now\(\)\/60000\),enrollmentCursor\)/);
 assert.match(source,/if\(attempted>=3\)/);assert.match(source,/discoveries<3/);
 assert.match(source,/enrollmentCursor=nextPartnerEnrollmentId\(rows,row.id\)/);
 assert.match(source,/discoveryCursor=nextPartnerProposalId\(rows,row.id\)/);
 assert.ok(source.includes("action_type='file_write' and target ~ '^[.]agent-workflow/receipts/[^/]+[.]md$'"));
 assert.match(source,/order by created_at limit 1001/);
 assert.match(source,/Hidden receipt observation is unsafe/);
 assert.doesNotMatch(source,/source_repair_authorized.*authorization\s*=|update workflow_runs/);
});
