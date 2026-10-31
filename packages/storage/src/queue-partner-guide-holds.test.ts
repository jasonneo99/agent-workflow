import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import {applyGuideLagThreshold,calibrateQueuePartnerGuideLagThreshold,queuePartnerGuideRegistryHolds,reconcileQueuePartnerGuideRegistryHold,summarizeQueuePartnerGuideHoldMetrics,summarizeQueuePartnerGuideRegistryHolds} from './queue-partner-guide-holds.js';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';
const fp='a'.repeat(64),project='11111111-1111-4111-8111-111111111111',a='22222222-2222-4222-8222-222222222222',b='33333333-3333-4333-8333-333333333333',r='44444444-4444-4444-8444-444444444444';
const d=(ids:string[])=>createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex');
test('coalesces per-run registry skips and accepts one exact resolution',()=>{
 const ids=[a,b],rows:any[]=[
  {runId:a,action:'guide_registry_not_ready',createdAt:'2026-10-29T00:00:00Z',metadata:{expectedFingerprint:fp}},
  {runId:b,action:'guide_registry_not_ready',createdAt:'2026-10-29T00:01:00Z',metadata:{expectedFingerprint:fp}},
  {runId:r,action:'guide_registry_ready',createdAt:'2026-10-29T00:02:00Z',metadata:{expectedFingerprint:fp,affectedRunIds:ids,affectedRunDigest:d(ids)}}];
 assert.deepEqual(summarizeQueuePartnerGuideRegistryHolds(rows,project),[{projectId:project,expectedFingerprint:fp,state:'resolved',affectedRunIds:ids,openedAt:'2026-10-29T00:00:00Z',resolvedAt:'2026-10-29T00:02:00Z',resolutionRunId:r,authority:'evidence-only'}]);
});
test('tampered resolutions fail closed and a later regression creates a new generation',()=>{
 const rows:any[]=[{runId:a,action:'guide_registry_not_ready',createdAt:'2026-10-29T00:00:00Z',metadata:{expectedFingerprint:fp}},
  {runId:r,action:'guide_registry_ready',createdAt:'2026-10-29T00:01:00Z',metadata:{expectedFingerprint:fp,affectedRunIds:[a],affectedRunDigest:'0'.repeat(64)}},
  {runId:b,action:'guide_registry_not_ready',createdAt:'2026-10-29T00:02:00Z',metadata:{expectedFingerprint:fp}}];
 const hold=summarizeQueuePartnerGuideRegistryHolds(rows,project)[0];assert.equal(hold.state,'open');assert.deepEqual(hold.affectedRunIds,[a,b]);
});
test('measures resolved latency, duplicate suppression, and later open generations without granting authority',()=>{
 const rows:any[]=[
  {runId:a,action:'guide_registry_not_ready',createdAt:'2026-10-29T00:00:00Z',metadata:{expectedFingerprint:fp}},
  {runId:a,action:'guide_registry_not_ready',createdAt:'2026-10-29T00:00:30Z',metadata:{expectedFingerprint:fp}},
  {runId:b,action:'guide_registry_not_ready',createdAt:'2026-10-29T00:01:00Z',metadata:{expectedFingerprint:fp}},
  {runId:r,action:'guide_registry_ready',createdAt:'2026-10-29T00:02:00Z',metadata:{expectedFingerprint:fp,affectedRunIds:[a,b],affectedRunDigest:d([a,b])}},
  {runId:r,action:'guide_registry_not_ready',createdAt:'2026-10-29T00:10:00Z',metadata:{expectedFingerprint:fp}}
 ];
 const metrics=summarizeQueuePartnerGuideHoldMetrics(rows,project,new Date('2026-10-29T00:30:00Z'),15*60_000);
 assert.equal(metrics.length,2);
 assert.deepEqual(metrics[1],{projectId:project,expectedFingerprint:fp,generation:1,state:'resolved',affectedRunCount:2,observedSkipReceipts:3,duplicateSuppressedCount:1,openedAt:'2026-10-29T00:00:00Z',resolvedAt:'2026-10-29T00:02:00Z',resolutionLatencyMs:120_000,openAgeMs:null,adoptionLagAlert:false,alertReason:null,authority:'observation-only',executionAuthorityGranted:false,primaryOutcomeAccepted:false});
 assert.equal(metrics[0].generation,2);assert.equal(metrics[0].openAgeMs,20*60_000);assert.equal(metrics[0].adoptionLagAlert,true);assert.equal(metrics[0].executionAuthorityGranted,false);
});
test('does not alert on unavailable fingerprints or tampered resolution claims',()=>{
 const rows:any[]=[
  {runId:a,action:'guide_registry_not_ready',createdAt:'2026-10-29T00:00:00Z',metadata:{}},
  {runId:r,action:'guide_registry_ready',createdAt:'2026-10-29T00:01:00Z',metadata:{affectedRunIds:[a],affectedRunDigest:'0'.repeat(64)}}
 ];
 const metric=summarizeQueuePartnerGuideHoldMetrics(rows,project,new Date('2026-10-29T01:00:00Z'),1)[0];
 assert.equal(metric.state,'open');assert.equal(metric.expectedFingerprint,'unavailable');assert.equal(metric.adoptionLagAlert,false);assert.equal(metric.primaryOutcomeAccepted,false);
});
test('calibrates only after a stable generation window and rate-limits baseline changes',()=>{
 let generation=0;const metric=(latency:number)=>({resolutionLatencyMs:latency,resolvedAt:`2026-10-29T00:${String(generation++).padStart(2,'0')}:00Z`,openedAt:'2026-10-29T00:00:00Z',generation} as any);
 const fallback=calibrateQueuePartnerGuideLagThreshold([metric(60_000),metric(120_000)]);
 assert.equal(fallback.source,'fallback');assert.equal(fallback.selectedThresholdMs,15*60_000);assert.equal(fallback.sampleCount,2);assert.equal(fallback.stability,'sparse');
 const sparse=calibrateQueuePartnerGuideLagThreshold([1,2,3,4,10].map(minutes=>metric(minutes*60_000)));
 assert.equal(sparse.source,'fallback');assert.equal(sparse.p50ResolutionLatencyMs,3*60_000);assert.equal(sparse.p95ResolutionLatencyMs,10*60_000);assert.equal(sparse.candidateThresholdMs,15*60_000);assert.equal(sparse.selectedThresholdMs,15*60_000);assert.equal(sparse.stability,'sparse');
 const stable=calibrateQueuePartnerGuideLagThreshold([5,5,5,5,5,5,5].map(minutes=>metric(minutes*60_000)));
 assert.equal(stable.source,'measured');assert.equal(stable.stability,'stable');assert.equal(stable.stableGenerationsObserved,3);assert.equal(stable.candidateThresholdMs,7.5*60_000);assert.equal(stable.priorThresholdMs,15*60_000);assert.equal(stable.selectedThresholdMs,11.25*60_000);assert.equal(stable.alertThresholdMs,11.25*60_000);assert.equal(stable.changeLimited,true);assert.deepEqual([stable.confidenceBandLowerMs,stable.confidenceBandUpperMs],[7.5*60_000,7.5*60_000]);
 const unstable=calibrateQueuePartnerGuideLagThreshold([1,1,1,1,1,1,1000].map(minutes=>metric(minutes*60_000)));
 assert.equal(unstable.source,'fallback');assert.equal(unstable.stability,'unstable');assert.equal(unstable.selectedThresholdMs,15*60_000);assert.equal(unstable.candidateThresholdMs,60*60_000);assert.deepEqual([unstable.confidenceBandLowerMs,unstable.confidenceBandUpperMs],[5*60_000,60*60_000]);
 const bounded=calibrateQueuePartnerGuideLagThreshold([1000,1000,1000,1000,1000,1000,1000].map(minutes=>metric(minutes*60_000)));
 assert.equal(bounded.selectedThresholdMs,18.75*60_000);assert.equal(bounded.alertThresholdMs,15*60_000);assert.equal(bounded.changeLimited,true);
 const stillOpen=applyGuideLagThreshold([{state:'open',expectedFingerprint:fp,openAgeMs:16*60_000,adoptionLagAlert:true,alertReason:'prior alert'} as any],bounded.alertThresholdMs)[0];assert.equal(stillOpen.adoptionLagAlert,true);
 const explicit=calibrateQueuePartnerGuideLagThreshold([],{explicitMs:1});assert.equal(explicit.source,'explicit');assert.equal(explicit.stability,'explicit');assert.equal(explicit.selectedThresholdMs,5*60_000);assert.equal(explicit.alertThresholdMs,5*60_000);
});
test('concurrent current-registry observations write one resolution and retain exact affected runs',{skip:!/agentflow_suite_test_[a-f0-9]{32}/u.test(process.env.AGENTFLOW_TEST_DATABASE_URL??process.env.DATABASE_URL??'')},async()=>{
 const projectId=randomUUID(),runs=[randomUUID(),randomUUID(),randomUUID()];
 await withClient(async c=>{await c.query('begin');try{await c.query("insert into agents(id,display_name,category,source_path,definition) values('implementation-agent','Synthetic implementation agent','development','synthetic/implementation-agent.yaml','{}') on conflict(id) do nothing");await c.query("insert into projects(id,name,root_uri,profile,config) values($1,'Synthetic Guide holds',$2,'test','{}')",[projectId,`/synthetic/guide-holds-${projectId}`]);
  for(const runId of runs)await c.query("insert into workflow_runs(id,project_id,status,task,autonomy) values($1,$2,'running','Synthetic Guide hold','2')",[runId,projectId]);
  for(const runId of runs.slice(0,2))await appendActionReceipt(c,{runId,agentId:'implementation-agent',actionType:'guide_registry_not_ready',target:'workflow-guide',summary:'Synthetic skip',metadata:JSON.stringify({expectedFingerprint:fp})});
  await c.query('commit');}catch(error){await c.query('rollback');throw error;}});
 const results=await Promise.all(runs.map(runId=>reconcileQueuePartnerGuideRegistryHold({runId,actorAgentId:'implementation-agent',expectedFingerprint:fp})));
 assert.equal(results.filter(result=>result.recorded).length,1);
 const holds=await queuePartnerGuideRegistryHolds(projectId);assert.equal(holds[0].state,'resolved');assert.deepEqual(holds[0].affectedRunIds,runs.slice(0,2).sort());
 const count=await withClient(async c=>Number((await c.query("select count(*) n from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id=$1 and a.action_type='guide_registry_ready'",[projectId])).rows[0].n));assert.equal(count,1);
});
