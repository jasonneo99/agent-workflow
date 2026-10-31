import assert from 'node:assert/strict';
import test from 'node:test';
import {projectConfigSchema} from '../../../../packages/agent-registry/src/schemas.js';
import {executeLifecycleApproval} from './builders-shared.js';

type Input=Parameters<typeof executeLifecycleApproval>[0];
type Effects=NonNullable<Parameters<typeof executeLifecycleApproval>[1]>;
const artifact={id:'synthetic-artifact',runId:'synthetic-run',taskId:null,kind:'stage_output',uri:'db://synthetic/source',content:{summary:'Synthetic evidence'},createdAt:'2026-01-01T00:00:00Z'};
function input(action='archive',policy:Record<string,boolean>={}):Input{
 return {approval:{id:'synthetic-approval',runId:'synthetic-run',taskId:null,stageId:'review',agentId:'security-reviewer',actionType:`artifact_${action}`,target:artifact.uri,status:'approved',payload:{},policyDecision:{},idempotencyKey:'synthetic-approval',projectRootUri:'/synthetic/project'} as Input['approval'],project:projectConfigSchema.parse({project:{name:'synthetic'},storage:{artifact_lifecycle:{allow_archive_execution:true,allow_restore_execution:true,allow_prune_execution:true,...policy}}}),actor:'synthetic-operator',executionRoleGate:'Allowed',separationGate:'Allowed',executionClaimToken:'synthetic-fence'};
}
function effects(target:typeof artifact|null=artifact){
 const recorded:Array<Parameters<Effects['record']>[0]>=[],finished:Array<Parameters<Effects['finish']>[0]>=[];
 const io:Effects={loadArtifact:async()=>target,record:async value=>{recorded.push(value);return 'db://synthetic/effect';},finish:async value=>{finished.push(value);return null;}};
 return {io,recorded,finished};
}
test('policy denial, missing source and unsupported prune record failed/skipped, never successful execution',async()=>{
 for(const [request,target] of [[input('archive',{legal_hold:true}),artifact],[input('archive',{allow_archive_execution:false}),artifact],[input('archive'),null],[input('prune'),artifact],[input('restore'),artifact]] as const){
  const f=effects(target),result=await executeLifecycleApproval(request,f.io);
  assert.equal(result.ok,false);assert.match(!result.ok?result.error:'',/No lifecycle effect was applied/);
  assert.equal(f.finished[0].status,'failed');assert.equal(f.finished[0].executionClaimToken,'synthetic-fence');
  assert.equal(f.recorded[0].artifactKind,'lifecycle_skipped');assert.equal(f.recorded[0].artifactContent.skipped,true);
 }
});
test('a real archive snapshot retains the original and records an executed effect',async()=>{
 const f=effects(),result=await executeLifecycleApproval(input(),f.io);
 assert.equal(result.ok,true);assert.equal(f.finished[0].status,'executed');assert.equal(f.recorded[0].artifactKind,'archived_artifact');
 assert.deepEqual(f.recorded[0].artifactContent.archivedContent,artifact.content);assert.equal(f.recorded[0].artifactContent.skipped,false);
});
