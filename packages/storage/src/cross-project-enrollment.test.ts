import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptanceDigest} from './acceptance.js';
import {advanceCrossProjectEnrollment,validateCrossProjectEnrollment,type CrossProjectEnrollment,type DependencyEnrollmentAdapter} from './cross-project-enrollment.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
  const requirements='Preserve every original requirement, including real-host proof.';
  const p:CrossProjectEnrollment={version:1,id:id(1),sourceRunId:id(2),originalFamilyId:`${id(3)}:${id(4)}`,originalTaskHash:acceptanceDigest(requirements),originalRequirements:requirements,authorizationId:'exact-human-plan',approvalTransfer:false,startBefore:'2030-01-01T00:55:00Z',pauseAt:'2030-01-01T01:00:00Z',scopes:[0,1].map(n=>({id:`step-${n}`,projectId:id(5+n),projectRootUri:`/synthetic/project-${n}`,task:`Scope ${n}: ${requirements}`,sourcePaths:['src/main.ts','tests/main.test.ts'],policyHash:'a'.repeat(64),provider:'codex-cli',modelTier:'standard',offlineOnly:true,externalProofRequired:false,requiredGates:['implementation','verification','packaging','supervision']}))};
  let now=Date.parse('2030-01-01T00:00:00Z'),allowed=true,accepted=false,attempted=false,preflight=true;
  const runs=new Map<string,{runId:string;status:string}>(),created:string[]=[],checked:string[]=[];
  const a:DependencyEnrollmentAdapter={now:()=>now,authorized:async()=>allowed,find:async(_p,s)=>runs.get(s.id)??null,accepted:async(_p,s)=>{checked.push(s.id);return accepted;},attempted:async()=>attempted,preflight:async()=>({ok:preflight,reason:'exact technical policy evidence missing'}),enroll:async(_p,s)=>{created.push(s.id);return id(9);}};
  return {p,a,runs,created,checked,set now(v:number){now=v;},set allowed(v:boolean){allowed=v;},set accepted(v:boolean){accepted=v;},set attempted(v:boolean){attempted=v;},set preflight(v:boolean){preflight=v;}};
}
test('one display parent, separate project contracts; only first dependency enrolls',async()=>{
  const f=fixture(),before=JSON.stringify(f.p);const result=await advanceCrossProjectEnrollment(f.p,f.a);
  assert.equal(result.state,'enrolled');assert.deepEqual(f.created,['step-0']);assert.equal(JSON.stringify(f.p),before);
});
test('completed lifecycle alone never releases downstream scope',async()=>{
  const f=fixture();f.runs.set('step-0',{runId:id(10),status:'completed'});
  assert.equal((await advanceCrossProjectEnrollment(f.p,f.a)).state,'held');assert.deepEqual(f.created,[]);
  f.accepted=true;assert.equal((await advanceCrossProjectEnrollment(f.p,f.a)).state,'enrolled');assert.deepEqual(f.created,['step-1']);
});
test('active dependency waits, terminal attempts hand back without clones',async()=>{
  for(const status of ['queued','leased','running','failed','blocked','cancelled']){
    const f=fixture();f.runs.set('step-0',{runId:id(10),status});
    assert.equal((await advanceCrossProjectEnrollment(f.p,f.a)).state,['queued','leased','running'].includes(status)?'waiting':'handoff');assert.deepEqual(f.created,[]);
  }
});
test('uncertain creation, missing authority and failed preflight route to Codex, no retry',async()=>{
  for(const change of [(f:ReturnType<typeof fixture>)=>{f.attempted=true;},(f:ReturnType<typeof fixture>)=>{f.allowed=false;},(f:ReturnType<typeof fixture>)=>{f.preflight=false;}]){
    const f=fixture();change(f);assert.equal((await advanceCrossProjectEnrollment(f.p,f.a)).state,'handoff');assert.deepEqual(f.created,[]);
  }
});
test('checkpoint and pause are persistent, no authority or enrollment work after boundary',async()=>{
  for(const time of ['2030-01-01T00:55:00Z','2030-01-01T01:00:00Z','2030-01-02T00:00:00Z']){
    const f=fixture();f.now=Date.parse(time);f.a.authorized=async()=>{throw Error('Must not check authority after cutoff');};
    assert.equal((await advanceCrossProjectEnrollment(f.p,f.a)).state,'held');assert.deepEqual(f.created,[]);
  }
  const f=fixture();f.a.preflight=async()=>{f.now=Date.parse(f.p.startBefore);return {ok:true,reason:'ready'};};
  assert.equal((await advanceCrossProjectEnrollment(f.p,f.a)).state,'held');assert.deepEqual(f.created,[]);
});
test('scope, routes, full requirements and original acceptance cannot be widened or weakened',()=>{
  const changes=[(p:CrossProjectEnrollment)=>{p.scopes[1].projectId=p.scopes[0].projectId;},(p:CrossProjectEnrollment)=>{p.scopes[1].projectRootUri=p.scopes[0].projectRootUri;},(p:CrossProjectEnrollment)=>{p.scopes[1].sourcePaths=['../foreign'];},(p:CrossProjectEnrollment)=>{p.scopes[0].sourcePaths=['.env'];},(p:CrossProjectEnrollment)=>{p.scopes[0].requiredGates=['verification'];},(p:CrossProjectEnrollment)=>{p.scopes[0].task='weakened';},(p:CrossProjectEnrollment)=>{(p as any).approvalTransfer=true;},(p:CrossProjectEnrollment)=>{(p.scopes[0] as any).provider='other';},(p:CrossProjectEnrollment)=>{p.scopes[0].projectRootUri='/synthetic/vendor/project';}];
  for(const change of changes){const f=fixture();change(f.p);assert.throws(()=>validateCrossProjectEnrollment(f.p));}
});
test('acceptance of all scopes reports evidence only and does not mutate parent',async()=>{
  const f=fixture();f.accepted=true;for(const s of f.p.scopes)f.runs.set(s.id,{runId:id(10),status:'completed'});
  assert.equal((await advanceCrossProjectEnrollment(f.p,f.a)).state,'accepted');assert.deepEqual(f.checked,['step-0','step-1']);assert.deepEqual(f.created,[]);
});
test('offline pass and lifecycle cannot substitute for explicitly required external proof',async()=>{
  const f=fixture();f.p.scopes[0].externalProofRequired=true;f.accepted=true;f.runs.set('step-0',{runId:id(10),status:'completed'});
  const result=await advanceCrossProjectEnrollment(f.p,f.a);
  assert.equal(result.state,'held');assert.match(result.reason,/external\/native proof/);assert.deepEqual(f.created,[]);assert.deepEqual(f.checked,[]);
});
test('an independently accepted repaired revision may advance without rewriting failed source history',async()=>{
  const f=fixture();f.accepted=true;f.runs.set('step-0',{runId:id(10),status:'blocked'});
  assert.equal((await advanceCrossProjectEnrollment(f.p,f.a)).state,'enrolled');assert.deepEqual(f.created,['step-1']);
  assert.equal(f.runs.get('step-0')?.status,'blocked');
});
test('external acceptance does not hide a recoverable technical failure from Codex',async()=>{
  const f=fixture();f.p.scopes[0].externalProofRequired=true;f.runs.set('step-0',{runId:id(10),status:'failed'});
  assert.equal((await advanceCrossProjectEnrollment(f.p,f.a)).state,'handoff');assert.deepEqual(f.created,[]);
});
