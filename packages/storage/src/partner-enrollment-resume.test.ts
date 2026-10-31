import assert from 'node:assert/strict';
import test from 'node:test';
import {acceptanceDigest} from './acceptance.js';
import {enrollmentResumeOpen,type PartnerEnrollmentResume} from './partner-enrollment-resume.js';
import {advanceCrossProjectEnrollment,type CrossProjectEnrollment} from './cross-project-enrollment.js';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(){
  const originalRequirements='Synthetic requirements';
  const p:CrossProjectEnrollment={version:1,id:id(1),sourceRunId:id(2),originalFamilyId:`${id(3)}:${id(4)}`,originalRequirements,originalTaskHash:acceptanceDigest(originalRequirements),authorizationId:'original-human',approvalTransfer:false,startBefore:'2030-01-01T00:00:00Z',pauseAt:'2030-01-01T00:05:00Z',scopes:[0,1].map(n=>({id:`scope-${n}`,projectId:id(5+n),projectRootUri:`/synthetic/${n}`,task:originalRequirements,sourcePaths:['src/main.ts'],policyHash:'a'.repeat(64),provider:'codex-cli',modelTier:'standard',offlineOnly:true,externalProofRequired:true,requiredGates:['implementation','verification','packaging','supervision']}))};
  const r:PartnerEnrollmentResume={version:1,resumeId:id(9),planId:p.id,sourceRunId:p.sourceRunId,planDigest:acceptanceDigest(p),approvalSource:'direct-human',approvalDecision:'approved',authorizedAt:'2030-01-02T00:00:00Z',expiresAt:'2030-01-02T01:00:00Z',replayAllowed:false,approvalTransfer:false};
  return {p,r,now:Date.parse('2030-01-02T00:30:00Z')};
}
test('explicit bounded resume opens original immutable plan; never morning auto-resume',()=>{
  const {p,r,now}=fixture(),before=JSON.stringify(p);
  assert.equal(enrollmentResumeOpen(p,undefined,now),false);
  assert.equal(enrollmentResumeOpen(p,r,now),true);
  assert.equal(enrollmentResumeOpen(p,r,Date.parse(r.authorizedAt)-1),false);
  assert.equal(enrollmentResumeOpen(p,r,Date.parse(r.expiresAt)),false);
  assert.equal(JSON.stringify(p),before);
});
test('foreign, edited, broadened, expired or non-human resume fails closed',()=>{
  const {p,r,now}=fixture();
  for(const change of [{planId:id(8)},{sourceRunId:id(8)},{planDigest:'0'.repeat(64)},{approvalSource:'callback'},{approvalDecision:'rejected'},{replayAllowed:true},{approvalTransfer:true},{expiresAt:'2030-01-04T00:00:00Z'},{authorizedAt:'2029-01-01T00:00:00Z'}])assert.equal(enrollmentResumeOpen(p,{...r,...change},now),false);
  assert.equal(enrollmentResumeOpen({...p,scopes:p.scopes.map(s=>({...s,policyHash:'b'.repeat(64)}))},r,now),false);
});
test('resumed blocked attempt hands back same identity; external gates still prevent Fleet',async()=>{
  const {p,r,now}=fixture();let creates=0;
  for(const status of ['blocked','failed','cancelled','completed','running']){
    const result=await advanceCrossProjectEnrollment(p,{now:()=>now,operationalOpen:()=>enrollmentResumeOpen(p,r,now),authorized:async()=>true,find:async()=>({runId:id(10),status,blocker:'Transport lookup exhausted'}),accepted:async()=>true,attempted:async()=>true,preflight:async()=>({ok:true,reason:'ready'}),enroll:async()=>{creates++;return id(11);}});
    assert.equal(result.runId,id(10));
    assert.equal(result.state,status==='running'?'waiting':status==='completed'?'held':'handoff');
  }
  assert.equal(creates,0);
});
