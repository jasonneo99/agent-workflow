import assert from 'node:assert/strict';
import test from 'node:test';
import {repairRevisionManifestHash} from './repaired-revision.js';
import {checkpointWithReconciledPartnerEffects,reconcilePartnerEffectObservations,type PartnerEffectObservation} from './queue-partner-effect-evidence.js';

const h=(c:string)=>c.repeat(64),root='/synthetic/project',taskId='synthetic-task',stageId='synthetic-stage',file='tests/test_example.py';
function fixture(){
 const artifactUri='db://synthetic/write',key=h('d'),previousHash=h('a'),nextHash=h('b');
 const content={idempotencyKey:key,requestedByTaskId:taskId,requestedByStageId:stageId,relativePath:file,
  mode:'patch',existed:true,outcome:'applied',projectRoot:root,previousHash,expectedHash:previousHash,nextHash};
 const row:PartnerEffectObservation={action_type:'file_write',target:file,metadata:content,receipt_hash:h('e'),artifact_uri:artifactUri,
  artifact_kind:'file_write',artifact_task_id:taskId,artifact_content:content,side_effect_key:key,side_effect_target:file,
  side_effect_operation:'file_write',side_effect_status:'completed',side_effect_receipt:{artifactUri,path:file,nextHash}};
 return {root,taskId,stageId,paths:[file],originalSubjectHash:repairRevisionManifestHash([{path:file,mode:0o644,hash:previousHash}]),
  manifest:[{path:file,mode:0o644,hash:nextHash}],observations:[row],sideEffects:[{idempotency_key:key,status:'completed'}]};
}
test('finalized exact patches explain the whole current manifest without fabricating history',()=>{
 const input=fixture(),proof=reconcilePartnerEffectObservations(input);assert.ok(proof);
 assert.equal(proof.originalSubjectHash,input.originalSubjectHash);assert.equal(proof.currentSubjectHash,repairRevisionManifestHash(input.manifest));
 assert.equal(proof.actionResults[0]!.reconciledObservation,true);assert.equal(proof.actionResults[0]!.nextHash,h('b'));
});
test('known offline commands are observations, not invented fresh source-bound tests',()=>{
 const input=fixture(),command='python3 -m unittest discover -s tests -p test_example.py -v',key=h('f'),uri='db://synthetic/command';
 const content={idempotencyKey:key,requestedByTaskId:taskId,requestedByStageId:stageId,commandLine:command,cwd:root,exitCode:0,timedOut:false,signal:null};
 input.observations.push({action_type:'local_command',target:command,metadata:content,receipt_hash:h('c'),artifact_uri:uri,
  artifact_kind:'command_output',artifact_task_id:taskId,artifact_content:content,side_effect_key:key,side_effect_target:command,
  side_effect_operation:'local_command',side_effect_status:'completed',side_effect_receipt:{artifactUri:uri,exitCode:0,timedOut:false}});
 input.sideEffects.push({idempotency_key:key,status:'completed'});
 const proof=reconcilePartnerEffectObservations(input);assert.ok(proof);assert.equal(proof.actionResults[1]!.historicalExecution,true);
 assert.equal(proof.actionResults[1]!.sourceBefore,undefined);
 for(const bad of ['python3 arbitrary.py','python3 -m unittest discover -s tests -p test_unrelated.py -v','echo yes; dangerous']){
  const changed=structuredClone(input),r=changed.observations[1]!;r.target=bad;r.artifact_content.commandLine=bad;r.metadata=r.artifact_content;r.side_effect_target=bad;
  assert.equal(reconcilePartnerEffectObservations(changed),null);
 }
});
test('refuses ambiguous, unfinished, unbound, changed or foreign effects',()=>{
 const mutations:Array<(x:ReturnType<typeof fixture>)=>void>=[
  x=>{x.manifest[0]!.hash=h('c');},x=>{x.manifest[0]!.mode=0o755;},x=>{x.originalSubjectHash=h('c');},
  x=>{x.observations[0]!.artifact_content.expectedHash=h('c');},x=>{x.observations[0]!.artifact_content.previousHash=null;},
  x=>{x.observations[0]!.artifact_content.existed=false;},x=>{x.observations[0]!.artifact_content.mode='replace';},
  x=>{x.observations[0]!.artifact_task_id='other-task';},x=>{x.observations[0]!.artifact_content.requestedByStageId='other-stage';},
  x=>{x.observations[0]!.side_effect_status='uncertain';},x=>{x.sideEffects[0]!.status='pending';},
  x=>{x.observations[0]!.side_effect_receipt.nextHash=h('c');},x=>{x.observations[0]!.side_effect_receipt.artifactUri='db://foreign';},
  x=>{x.observations[0]!.metadata={};},x=>{x.observations[0]!.target='foreign.py';},
  x=>{x.sideEffects.push({idempotency_key:h('a'),status:'completed'});},
  x=>{x.observations.push(x.observations[0]!);},x=>{x.paths=['../foreign.py'];}
 ];
 for(const mutate of mutations){const changed=structuredClone(fixture());mutate(changed);assert.equal(reconcilePartnerEffectObservations(changed),null);}
});
test('checkpoint projection preserves rounds and pending context while invalidating stale read caches',()=>{
 const proof=reconcilePartnerEffectObservations(fixture());assert.ok(proof);
 const checkpoint={round:2,verifyRetryRound:1,actionResults:[{type:'file_read',path:file}],fileReads:[{path:file,content:'old'}],stateDeltas:[{old:true}],pendingOutput:{summary:'unfinished'}};
 const before=structuredClone(checkpoint),updated=checkpointWithReconciledPartnerEffects(checkpoint,proof);assert.ok(updated);
 assert.deepEqual(checkpoint,before);assert.equal(updated.round,2);assert.equal(updated.verifyRetryRound,1);
 assert.deepEqual(updated.pendingOutput,checkpoint.pendingOutput);assert.deepEqual(updated.fileReads,[]);assert.deepEqual(updated.stateDeltas,[]);
 assert.equal((updated.actionResults as any[]).length,2);
 assert.equal((checkpointWithReconciledPartnerEffects(updated,proof)!.actionResults as any[]).length,2);
 for(const round of [0,4,-1,NaN])assert.equal(checkpointWithReconciledPartnerEffects({...checkpoint,round},proof),null);
});
