import assert from 'node:assert/strict';
import test from 'node:test';
import {buildQueuePartnerActivity,type QueuePartnerActivitySnapshot} from './queue-partner-activity.js';
import {buildQueuePartnerGuideCircuitEvent} from '../../../../packages/storage/src/queue-partner-guide-circuit.js';
const projectId='11111111-1111-4111-8111-111111111111',runId='22222222-2222-4222-8222-222222222222',childId='33333333-3333-4333-8333-333333333333',root='/synthetic/project';
function snapshot():QueuePartnerActivitySnapshot{return {runs:[{id:runId,projectId,rootUri:root,familyId:`${projectId}:family`,title:'Synthetic routing',status:'blocked'},{id:childId,projectId,rootUri:root,familyId:`${projectId}:family`,title:'Synthetic verification',status:'running'}],assignments:[{id:'claim',projectId,sourceRunId:runId,childRunId:childId,familyId:`${projectId}:family`,role:'verifier',state:'running',owner:'owner',fence:'2'}],receipts:[],artifacts:[],tasks:[],approvals:[]};}
test('slot narrative distinguishes reservations, worker proof and selected project from global activity',async()=>{
 const data=snapshot();
 data.assignments.push({...data.assignments[0],id:'other',role:'repair',state:'held'});
 const report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
 assert.match(report.watching!.join(' '),/0\/5 repair slots and 1\/1 verifier slots/);
 assert.match(report.watching!.join(' '),/0 worker-bound stage/);
 assert.match(report.watching!.join(' '),/not proof of running work/);
 assert.match(report.watching!.join(' '),/1 assigned family hold/);
 assert.match(report.watching!.join(' '),/not a global scheduler heartbeat/);
 data.truncated=true;
 const partial=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
 assert.match(partial.watching!.join(' '),/counts are partial/);
});
test('durable Guide circuit diagnostics surface exact cooldown and reconciliation without reset authority',async()=>{
 const data=snapshot(),opened=buildQueuePartnerGuideCircuitEvent({projectId,sourceRunId:childId,taskClass:'repair',kind:'opened',failures:3,reason:'provider timeout',openedAt:'2098-01-01T00:00:00Z',retryAt:'2099-01-01T00:00:00Z'});
 data.guideCircuits=[{metadata:opened,receiptAuthentic:true,runId:childId,workerId:'owner:2'}];
 const report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data}),entry=report.entries.find(item=>item.state==='guide-cooldown');
 assert.ok(entry);assert.match(entry!.what,/generation 1/);assert.match(entry!.why,/provider timeout/);assert.match(entry!.how,/diagnostic only/);assert.match(entry!.how,/owner:2/);assert.match(entry!.next,/must not retry early/);assert.equal(entry!.requiresPermission,false);assert.doesNotMatch(JSON.stringify(entry),/reset the circuit|execute now/iu);
});
test('Guide registry adoption skips coalesce without replay or acceptance claims',async()=>{
 const data=snapshot();data.guideRegistryHolds=[{projectId,expectedFingerprint:'a'.repeat(64),state:'open',affectedRunIds:[runId,childId],openedAt:'2026-10-29T00:00:00Z',resolvedAt:null,resolutionRunId:null,authority:'evidence-only'}];
 const report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data}),entry=report.entries.find(item=>item.state==='guide-registry-open');
 assert.ok(entry);assert.match(entry!.what,/2 affected run/);assert.match(entry!.how,/no skipped run was replayed/);assert.match(entry!.how,/no primary workflow outcome was accepted/);assert.equal(entry!.requiresPermission,false);
});
test('activity separates current work, actual durable decisions and unverified observations',async()=>{
 const data=snapshot();data.tasks=[{id:'task',runId:childId,status:'running',stage:'verification',workerId:'owner:2',leaseExpiresAt:'2099-01-01T00:00:00Z'}];
 data.receipts=[{id:'r',runId,action:'queue_coordinator_dispatched',summary:'Bound verifier dispatched after candidate proof.',metadata:{id:'claim'}}];
 const result=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
 assert.ok(result.entries.some(e=>e.state==='working'&&e.kind==='observation'));
 assert.ok(result.entries.some(e=>e.kind==='observation'&&e.why.includes('Bound verifier dispatched')));
 assert.equal(result.authority,'evidence-only');assert.deepEqual(result.capacity,{repair:5,verifier:1});
 data.tasks[0].workerId='unrelated-worker';const mismatch=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
 assert.ok(mismatch.entries.some(e=>e.state==='worker-binding-unverified'));assert.ok(!mismatch.entries.some(e=>e.state==='working'));
});
test('approval is distinct from a technical issue and lifecycle completion never means acceptance',async()=>{
 const data=snapshot();data.runs[0].status='completed';data.runs[1].status='blocked';data.approvals=[{id:'a',runId,status:'pending',action:'file_write'}];data.receipts=[{id:'r',runId:childId,action:'stage_blocked',summary:'Regression test failed.'}];data.artifacts=[{id:'a',runId,kind:'repaired_revision_attestation',content:{}}];
 const result=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
 assert.equal(result.entries[0].requiresPermission,true);assert.ok(result.entries.some(e=>e.state==='verification-gap'&&!e.requiresPermission));assert.ok(!result.entries.some(e=>e.state==='checks-failed'));
 assert.ok(result.entries.some(e=>e.state==='attestation-recorded'&&e.next.includes('Revalidate')));
 assert.ok(result.entries.some(e=>e.state==='lifecycle-completed'&&e.why.includes('does not establish')));
});
test('scope isolation, redaction and stable semantic ids survive refreshed timestamps',async()=>{
 const data=snapshot();data.runs.push({...data.runs[0],id:'44444444-4444-4444-8444-444444444444',projectId:'foreign',title:'FOREIGN_PRIVATE'});
 data.receipts=[{id:'r',runId,action:'stage_blocked',summary:'test failed token=private-value /Users/example/private https://private.invalid/secret\nsudo cat /etc/private'}];
 const adapter={snapshot:async()=>data},first=await buildQueuePartnerActivity(projectId,root,runId,adapter),second=await buildQueuePartnerActivity(projectId,root,runId,adapter);
 assert.deepEqual(first.entries,second.entries);assert.doesNotMatch(JSON.stringify(first),/FOREIGN_PRIVATE|private-value|\/Users\/example|private\.invalid|sudo cat/);
 assert.ok(first.entries.every(e=>e.evidence.every(link=>link.url.startsWith('/runs?relatedTo='))));
 const absent=await buildQueuePartnerActivity(projectId,root,'55555555-5555-4555-8555-555555555555',adapter);assert.equal(absent.entries.length,0);
});
test('unavailable evidence remains unknown and malformed/bounded payloads do not create decisions',async()=>{
 const data=snapshot();data.assignments[0].state='held';data.assignments[0].reason='Need exact enrolled evidence';
 data.artifacts=[{id:'malformed',runId,kind:'repaired_revision_attestation',content:null as any}];
 const result=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
 assert.ok(result.entries.every(e=>e.kind==='observation'));assert.ok(result.entries.some(e=>e.state==='held'&&e.why.includes('no selection rationale')));
 assert.ok(!result.entries.some(e=>e.state==='attestation-recorded'));
 data.assignments=Array.from({length:100},(_,i)=>({...data.assignments[0],id:`claim-${i}`}));
 data.runs=Array.from({length:100},(_,i)=>({...data.runs[0],id:`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`,status:'completed'}));
 const bounded=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});assert.ok(bounded.entries.length<=30);assert.equal(bounded.truncated,true);
});
test('journal decisions require exact matching versioned receipt and same scope; help is not completion',async()=>{
 const data=snapshot(),payload={version:1,authority:'evidence-only',projectId,runId,familyId:data.runs[0].familyId,decisionId:'decision',decision:'held',what:'Held pending source proof',why:'Exact source enrollment is missing.',how:'The planner retained the family.',next:'Recover original evidence.',requiresPermission:false};
 data.artifacts=[{id:'a',runId,kind:'queue_partner_decision',content:payload}];
 data.helpRequests=[{id:'h',runId,status:'delivered'}];
 let report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});assert.ok(!report.entries.some(e=>e.kind==='decision'));assert.ok(report.entries.some(e=>e.state==='historical-help-request'&&e.how.includes('not evidence')));
 data.receipts=[{id:'r',runId,action:'queue_partner_decision',summary:'Held',target:payload.familyId,metadataSerializationVersion:2,metadata:payload}];
 report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});assert.ok(!report.entries.some(e=>e.kind==='decision'));assert.ok(report.entries.some(e=>e.state==='unverified-decision-record'));
 data.verifiedChainRunIds=[runId];
 report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});assert.ok(report.entries.some(e=>e.kind==='decision'&&e.why.includes('enrollment')));
 data.receipts[0].metadata={...payload,projectId:'foreign'};report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});assert.ok(!report.entries.some(e=>e.kind==='decision'));
});
test('latest assigned child diagnosis outranks original blocker and old help; reviewed cause is grounded',async()=>{
 const data=snapshot();data.assignments[0].state='held';data.runs[1].status='blocked';
 data.receipts=[{id:'old',runId,action:'stage_blocked',summary:'Old intent lookup missing'},{id:'new',runId:childId,action:'stage_blocked',summary:'Current checkout identity mismatch'}];
 data.helpRequests=[{id:'old-help',runId,status:'delivered'}];data.artifacts=[{id:'check',runId:childId,kind:'command_output',content:{exitCode:0,timedOut:false}}];
 let report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});assert.equal(report.entries[0].runId,childId);assert.match(report.entries[0].why,/Current checkout/);
 assert.ok(report.entries.some(e=>e.runId===runId&&e.state==='historical-stage-report'));
 const p={version:1,authority:'evidence-only',actor:'operator',projectId,runId:childId,familyId:data.runs[0].familyId,what:'Wrong worker inspected a stale checkout',why:'Task receipt worker differs from exact assigned worker.',how:'Compared actual worker and candidate source.',next:'Fence mismatched claims before another review.',requiresPermission:false};
 data.artifacts.unshift({id:'review',runId:childId,kind:'operator_evidence_review',content:p});
 report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});assert.ok(!report.entries.some(e=>e.state==='operator-reviewed'));
 data.receipts.unshift({id:'review-proof',runId:childId,action:'operator_evidence_review',target:childId,metadataSerializationVersion:2,summary:'Reviewed',metadata:p});
 report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});assert.ok(!report.entries.some(e=>e.state==='operator-reviewed'));assert.ok(report.entries.some(e=>e.state==='unverified-review-record'));
 data.verifiedChainRunIds=[childId];
 report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});assert.equal(report.entries[0].state,'operator-reviewed');assert.equal(report.entries[0].requiresPermission,false);
 assert.ok(report.entries.some(e=>e.state==='recorded-check-success'));
});
test('completed attempt with old failure receipt and successful checks is not a current blocker',async()=>{
 const data=snapshot();data.runs[1].status='completed';data.assignments[0].state='held';
 data.receipts=[{id:'old',runId:childId,action:'stage_failed',summary:'An old test run failed'}];
 data.artifacts=[{id:'green',runId:childId,kind:'command_output',content:{exitCode:0,timedOut:false}}];
 const report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
 assert.ok(report.entries.some(e=>e.runId===childId&&e.state==='historical-stage-report'));
 assert.ok(!report.entries.some(e=>e.runId===childId&&['verification-gap','technical-blocker'].includes(e.state)));
 assert.ok(report.entries.some(e=>e.state==='recorded-check-success'));
});
test('only pending approvals need permission; executing and failed actions are separate technical states',async()=>{
 for(const status of ['pending','executing','failed']){const data=snapshot();data.approvals=[{id:'approval',runId:childId,status,action:'local_command'}];
  const report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
  assert.equal(report.entries.some(e=>e.requiresPermission),status==='pending');
  assert.ok(report.entries.some(e=>e.state===(status==='pending'?'permission-needed':status==='executing'?'authorized-action-executing':'authorized-action-failed')));
 }
});
test('optional run projection excludes unrelated same-project families',async()=>{
 const data=snapshot();data.runs.push({...data.runs[0],id:'44444444-4444-4444-8444-444444444444',familyId:'unrelated',title:'UNRELATED',status:'completed'});
 const report=await buildQueuePartnerActivity(projectId,root,runId,{snapshot:async()=>data});assert.doesNotMatch(JSON.stringify(report),/UNRELATED/);
});
test('failed checks require actual outputs and expired lease never authorizes takeover',async()=>{
 const data=snapshot();data.artifacts=[{id:'failed',runId,kind:'command_output',content:{exitCode:1,timedOut:false}}];
 data.tasks=[{id:'expired',runId:childId,status:'running',stage:'verification',workerId:'owner:2',leaseExpiresAt:'2000-01-01T00:00:00Z'}];
 const report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
 assert.ok(report.entries.some(e=>e.state==='recorded-check-failure'&&e.why.includes('newer checks')));
 assert.ok(report.entries.some(e=>e.state==='lease-expired'&&e.why.includes('does not prove')));
});
test('archived blockers do not drown current assigned work or fabricate native permission needs',async()=>{
 const data=snapshot();data.runs[0].archived=true;data.runs[1].familyId=`${projectId}:child-set`;
 data.receipts=[{id:'old',runId,action:'stage_blocked',summary:'Native implementation is excluded; test evidence missing.'}];
 data.tasks=[{id:'active',runId:childId,status:'running',stage:'verification',workerId:'owner:2',leaseExpiresAt:'2099-01-01T00:00:00Z'}];
 for(let i=0;i<40;i++){const id=`${String(i).padStart(8,'0')}-1111-4111-8111-111111111111`;data.runs.push({...data.runs[0],id,familyId:`old-${i}`,archived:false});data.receipts.push({id:`r-${i}`,runId:id,action:'stage_blocked',summary:'Historical test issue'});}
 const report=await buildQueuePartnerActivity(projectId,root,undefined,{snapshot:async()=>data});
 assert.equal(report.entries[0].state,'working');assert.equal(report.entries[0].familyId,data.assignments[0].familyId);
 assert.ok(!report.entries.some(e=>e.runId===runId&&e.state==='verification-gap'));
 assert.ok(!report.entries.some(e=>e.state==='external-proof-needed'||e.requiresPermission));
});
