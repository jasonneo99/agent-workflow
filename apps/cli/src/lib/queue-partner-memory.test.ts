import assert from 'node:assert/strict';
import test from 'node:test';
import {applyQueuePartnerMemoryControls,applyQueuePartnerMemoryPromotions,normalizeQueuePartnerInfluence,parseQueuePartnerMemoryRows,quarantineQueuePartnerMemoryEvidence,queuePartnerDeliveryEvidence,queuePartnerEffectiveness,queuePartnerMemoryDigest,queuePartnerRepairPlaybooks,rankQueuePartnerMemories,type QueuePartnerMemoryRecord} from './queue-partner-memory.js';

const record=(patch:Partial<QueuePartnerMemoryRecord>={}):QueuePartnerMemoryRecord=>({projectId:'project',familyId:'old-family',sourceRunId:'old-source',childRunId:'child',
 task:'Repair callback delivery acknowledgement',blocker:'Callback acknowledgement timeout',writePaths:['src/callback.ts'],outcome:'completed-unverified',
 facts:[{runId:'child',kind:'local_command',target:'node --test callback.test.ts',summary:'passed',exitCode:0}],recordedAt:'2026-10-26T00:00:00.000Z',...patch});

test('similar verified repair history ranks ahead of unrelated history without becoming authority',()=>{
 const matches=rankQueuePartnerMemories([record(),record({childRunId:'foreign',task:'Update dashboard colors',blocker:'CSS contrast',writePaths:['src/styles.ts']})],
  {familyId:'new-family',sourceRunId:'new-source',task:'Fix callback delivery',blocker:'Acknowledgement timeout again',writePaths:['src/callback.ts']});
 assert.equal(matches[0]?.childRunId,'child');assert.equal(matches[0]?.authority,'evidence-only');assert.ok((matches[0]?.score??0)>2);
 assert.equal(matches[0]?.recurrence,true);assert.equal(matches[0]?.regression,false);assert.equal(matches[0]?.interpretation,'recurrence-after-unverified-attempt');
});
test('only independently verified prior remedies make a recurrence a regression',()=>{
 const current={familyId:'new',sourceRunId:'new',task:'Repair callback delivery',blocker:'Callback acknowledgement timeout',writePaths:['src/callback.ts']};
 const [verified]=rankQueuePartnerMemories([record({outcome:'verified'})],current),[attempted]=rankQueuePartnerMemories([record()],current);
 assert.equal(verified?.regression,true);assert.equal(verified?.interpretation,'regression-after-verified-remedy');
 assert.equal(attempted?.regression,false);assert.equal(attempted?.interpretation,'recurrence-after-unverified-attempt');
});
test('repair playbooks expose only independently verified receipt-backed structure, never narrative authority',()=>{
 const current={familyId:'new',sourceRunId:'new',task:'Repair callback delivery',blocker:'Callback acknowledgement timeout',writePaths:['src/callback.ts']};
 const verified=rankQueuePartnerMemories([record({outcome:'verified',facts:[
  {runId:'child',kind:'file_write',target:'src/callback.ts',summary:'private model narrative',nextHash:'a'.repeat(64)},
  {runId:'child',kind:'local_command',target:'node --test callback.test.ts',summary:'passed',exitCode:0},
  {runId:'child',kind:'local_command',target:'node --test failing.test.ts',summary:'failed',exitCode:1}
 ]})],current);
 const attempted=rankQueuePartnerMemories([record()],current);
 const binding={sourceHash:'source',policyHash:'policy',acceptanceHash:'acceptance'};
 const rebound=verified.map(item=>({...item,applicability:binding})),playbooks=queuePartnerRepairPlaybooks([...rebound,...attempted],binding);
 assert.equal(playbooks.eligible.length,1);assert.equal(playbooks.eligible[0]?.authority,'evidence-only');assert.equal(playbooks.eligible[0]?.proof,'independently-verified');
 assert.deepEqual(playbooks.eligible[0]?.exactPaths,['src/callback.ts']);assert.deepEqual(playbooks.eligible[0]?.verificationActions,['node --test callback.test.ts']);
 assert.equal(playbooks.eligible[0]?.revalidated,true);assert.deepEqual(playbooks.eligible[0]?.applicability,binding);
 assert.doesNotMatch(JSON.stringify(playbooks),/private model narrative|failing\.test/);
});
test('repair playbooks reject stale or unbound applicability without deleting comparison history',()=>{
 const current={sourceHash:'source',policyHash:'policy',acceptanceHash:'acceptance'},base=rankQueuePartnerMemories([record({outcome:'verified',facts:[
  {runId:'child',kind:'local_command',target:'node --test callback.test.ts',summary:'passed',exitCode:0}
 ]})],{familyId:'new',sourceRunId:'new',task:'Repair callback delivery',blocker:'Callback acknowledgement timeout',writePaths:['src/callback.ts']})[0]!;
 const cases=[
  {record:base,reason:'missing-applicability-proof'},
  {record:{...base,applicability:{...current,sourceHash:'old'}},reason:'source-changed'},
  {record:{...base,applicability:{...current,policyHash:'old'}},reason:'policy-changed'},
  {record:{...base,applicability:{...current,acceptanceHash:'old'}},reason:'acceptance-changed'}
 ] as const;
 for(const item of cases){const result=queuePartnerRepairPlaybooks([item.record],current);assert.equal(result.eligible.length,0);assert.equal(result.rejected[0]?.reason,item.reason);}
 assert.equal(base.outcome,'verified');assert.equal(base.facts.length,1,'historical comparison remains intact');
});
test('exact family and source matches outrank lexical similarity and records stay evidence-sensitive',()=>{
 const exact=record({familyId:'current',childRunId:'exact'}),similar=record({childRunId:'similar'});
 const matches=rankQueuePartnerMemories([similar,exact],{familyId:'current',sourceRunId:'new',task:'callback delivery',blocker:'timeout',writePaths:[]});
 assert.equal(matches[0]?.childRunId,'exact');
 assert.notEqual(queuePartnerMemoryDigest(exact),queuePartnerMemoryDigest(record({facts:[{...record().facts[0]!,exitCode:1}]})));
});
test('unrelated records are omitted and comparisons are bounded',()=>{
 const records=Array.from({length:20},(_,index)=>record({childRunId:String(index),task:'unrelated',blocker:'unrelated',writePaths:['other.ts']}));
 assert.deepEqual(rankQueuePartnerMemories(records,{familyId:'new',sourceRunId:'new',task:'callback',blocker:'timeout',writePaths:['callback.ts']}),[]);
 assert.equal(rankQueuePartnerMemories(records.map(r=>({...r,task:'callback'})),{familyId:'new',sourceRunId:'new',task:'callback',blocker:'timeout',writePaths:[]},3).length,3);
});
test('only an exactly bound independent promotion upgrades a remembered attempt',()=>{
 const base=record(),promotesNodeId=`queue-partner-recovery:${base.childRunId}`;
 const promotion={promotesNodeId,sourceRunId:base.sourceRunId,repairRunId:base.childRunId,verificationRunId:'verifier',candidateId:'candidate',
  repairedHash:'hash',baseEvidenceDigest:queuePartnerMemoryDigest(base),recordedAt:'2026-10-26T01:00:00.000Z',expiresAt:'2027-10-26T01:00:00.000Z'};
 assert.equal(applyQueuePartnerMemoryPromotions([base],[promotion])[0]?.outcome,'verified');
 assert.equal(applyQueuePartnerMemoryPromotions([base],[{...promotion,baseEvidenceDigest:'tampered'}])[0]?.outcome,'completed-unverified');
 assert.equal(applyQueuePartnerMemoryPromotions([base],[{...promotion,sourceRunId:'foreign'}])[0]?.outcome,'completed-unverified');
});
test('ranking prefers verified, faster, fully priced successful remedies',()=>{
 const current={familyId:'new',sourceRunId:'new',task:'Repair callback delivery',blocker:'Callback acknowledgement timeout',writePaths:['src/callback.ts']};
 const slow=record({childRunId:'slow',outcome:'completed-unverified',delivery:{durationMs:120000,modelLatencyMs:90000,costUsd:1,providerCalls:1,costCoverageCalls:1}});
 const fast=record({childRunId:'fast',outcome:'verified',delivery:{durationMs:20000,modelLatencyMs:10000,costUsd:.1,providerCalls:1,costCoverageCalls:1}});
 const [winner]=rankQueuePartnerMemories([slow,fast],current);
 assert.equal(winner?.childRunId,'fast');assert.ok((winner?.rankingSignals.verification??0)>0);assert.ok((winner?.rankingSignals.speed??0)>0);assert.ok((winner?.rankingSignals.cost??0)>0);
});
test('delivery evidence reports only measured duration, latency and covered cost',()=>{
 assert.deepEqual(queuePartnerDeliveryEvidence('2026-10-26T00:00:00Z','2026-10-26T00:01:00Z',[{attempts:[{latencyMs:1000,costUsd:.02},{latencyMs:500}]}],'2026-10-25T23:59:58Z','2026-10-26T00:00:01Z'),
  {durationMs:60000,timeToFirstActionMs:3000,modelLatencyMs:1500,costUsd:.02,providerCalls:2,costCoverageCalls:1,phaseMs:{'lease-wait':3000,provider:1500},bottleneck:'lease-wait'});
});
test('delivery evidence identifies the measured slow phase without inventing missing phases',()=>{
 const report=queuePartnerDeliveryEvidence('2026-10-26T00:00:00Z','2026-10-26T00:01:00Z',[{attempts:[{latencyMs:12000}]}],
  '2026-10-26T00:00:00Z','2026-10-26T00:00:02Z',{planningMs:1000,intentMs:50,reservationMs:100,executionMs:20000,finalizationMs:80,
   tools:[{target:'node --test focused.test.ts',metadata:{durationMs:5000}},{target:'git status',metadata:{durationMs:200}}]});
 assert.deepEqual(report.phaseMs,{planning:1000,intent:50,reservation:100,finalization:80,'lease-wait':2000,provider:12000,tool:5200,verification:5000,'worker-other':800});
 assert.equal(report.bottleneck,'provider');
});
test('retention, revocation and supersession hide stale conclusions without deleting history',()=>{
 const old=record({childRunId:'old',expiresAt:'2026-01-01T00:00:00.000Z'}),current=record({childRunId:'current'});
 assert.deepEqual(applyQueuePartnerMemoryControls([old,current],[],new Date('2026-10-26T00:00:00Z')).map(r=>r.childRunId),['current']);
 assert.deepEqual(applyQueuePartnerMemoryControls([current],[{targetNodeId:'queue-partner-recovery:current',action:'revoke',reason:'proof revoked',recordedAt:'2026-10-26T00:00:00Z'}]).map(r=>r.childRunId),[]);
 assert.deepEqual(applyQueuePartnerMemoryControls([old,current],[{targetNodeId:'queue-partner-recovery:old',replacementNodeId:'queue-partner-recovery:current',action:'supersede',reason:'new evidence',recordedAt:'2026-10-26T00:00:00Z'}],new Date('2025-10-26T00:00:00Z')).map(r=>r.childRunId),['current']);
});
test('effectiveness reports measured recurrence and verification time without inventing avoided work',()=>{
 const first=record({childRunId:'one',recordedAt:'2026-10-26T00:00:00Z'}),second=record({childRunId:'two',recordedAt:'2026-10-26T00:01:00Z'});
 const report=queuePartnerEffectiveness([first,second],[{promotesNodeId:'queue-partner-recovery:two',sourceRunId:second.sourceRunId,repairRunId:'two',verificationRunId:'verify',candidateId:'candidate',repairedHash:'hash',baseEvidenceDigest:queuePartnerMemoryDigest(second),recordedAt:'2026-10-26T00:03:00Z',expiresAt:'2027-10-26T00:03:00Z'}],[]);
 assert.equal(report.repeatFailures,1);assert.equal(report.repeatFailureRate,.5);assert.equal(report.verifiedRemedies,1);assert.equal(report.averageTimeToVerifiedMs,120000);
 assert.equal(report.duplicateWorkAvoided,null);assert.equal(report.duplicateAvoidanceCoverage,'unavailable-until-influence-recorded');
});
test('memory influence accepts only presented evidence and records missing proof honestly',()=>{
 const presented=[{childRunId:'known'}],declared={used:[{childRunId:'foreign',effect:'changed-plan',reason:'no'},{childRunId:'known',effect:'confirmed-plan',reason:'Matched the same verified failure mode'}]};
 assert.deepEqual(normalizeQueuePartnerInfluence('run',presented,declared,'now'),[{runId:'run',memoryRunId:'known',effect:'confirmed-plan',reason:'Matched the same verified failure mode',recordedAt:'now'}]);
 assert.equal(normalizeQueuePartnerInfluence('run',presented,{used:[]},'now')[0]?.effect,'not-demonstrated');
});
test('ineligible remembered remedies can be rejected but cannot claim they changed or confirmed a plan',()=>{
 const presented=[{childRunId:'stale',reuseEligible:false},{childRunId:'current',reuseEligible:true}],declared={used:[
  {childRunId:'stale',effect:'changed-plan',reason:'unsafe reuse'},
  {childRunId:'stale',effect:'rejected',reason:'source changed'},
  {childRunId:'current',effect:'confirmed-plan',reason:'exact binding'}
 ]};
 assert.deepEqual(normalizeQueuePartnerInfluence('run',presented,declared,'now').map(item=>[item.memoryRunId,item.effect]),[['stale','rejected'],['current','confirmed-plan']]);
});
test('malformed, contradictory and unbound memory evidence is quarantined without deleting valid history',()=>{
 const base=record(),conflict={...base,sourceRunId:'different-source'},digest=queuePartnerMemoryDigest(base);
 const promotion={promotesNodeId:`queue-partner-recovery:${base.childRunId}`,sourceRunId:base.sourceRunId,repairRunId:base.childRunId,verificationRunId:'verify-a',candidateId:'candidate-a',repairedHash:'hash-a',baseEvidenceDigest:digest,recordedAt:'2026-10-26T01:00:00Z',expiresAt:'2027-10-26T01:00:00Z'};
 const checked=quarantineQueuePartnerMemoryEvidence({records:[base,conflict,record({childRunId:'safe'})],promotions:[promotion,{...promotion,verificationRunId:'verify-b',candidateId:'candidate-b',repairedHash:'hash-b'}],controls:[]});
 assert.deepEqual(checked.records.map(item=>item.childRunId),['safe']);assert.equal(checked.promotions.length,0);
 assert.ok(checked.quarantined.some(item=>item.reason==='contradictory-record'));assert.ok(checked.quarantined.some(item=>item.reason==='contradictory-promotion'));
 const parsed=parseQueuePartnerMemoryRows([{node_id:'bad',kind:'queue-partner-recovery',body:'{'},{node_id:'broken',kind:'queue-partner-memory-control',body:'{}',edge_valid:false},{node_id:'good',kind:'queue-partner-recovery',body:JSON.stringify(record({childRunId:'good'}))}]);
 assert.deepEqual(parsed.records.map(item=>item.childRunId),['good']);assert.deepEqual(parsed.quarantined.map(item=>item.reason),['malformed-body','broken-edge']);
 const unbound=quarantineQueuePartnerMemoryEvidence({records:[base],promotions:[{...promotion,baseEvidenceDigest:'tampered'}],controls:[]});
 assert.equal(unbound.promotions.length,0);assert.equal(unbound.quarantined[0]?.reason,'unbound-promotion');assert.equal(unbound.records[0]?.childRunId,'child');
});
