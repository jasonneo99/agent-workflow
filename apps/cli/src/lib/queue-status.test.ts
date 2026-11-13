import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {buildQueueStatusReport,groupQueueStatusIdentities,mirrorQueueStatusReport,parseQueueStatusProject,projectQueueStatus,type QueueStatusSnapshot,type QueueStatusQueueSnapshot} from './queue-status.js';
import type {WorkflowQueueItem} from '../../../../packages/storage/src/workflow-run-types.js';
const p='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',run='33333333-3333-4333-8333-333333333333',child='44444444-4444-4444-8444-444444444444';
const row=(patch:Partial<QueueStatusSnapshot['managed'][0]>={})=>({runId:run,projectId:p,projectName:'Project Alpha',familyId:p+':family-one',name:'Synthetic source check',runStatus:'blocked',queuedTasks:0,runningTasks:0,approvalCount:0,issue:'Focused test failed',...patch});
const snapshot=(patch:Partial<QueueStatusSnapshot>={}):QueueStatusSnapshot=>({projects:[{id:p,name:'Project Alpha'},{id:other,name:'Project Beta'}],managed:[row({decision:{decision:'held',state:'held',why:'Current scope evidence is missing',next:'Recover the authentic baseline and rerun the check.'},recordedAt:'2026-01-01T00:00:00Z'})],queue:[],...patch});
test('queue-wide default includes held families with exact columns and a proposed next action, not a successful effect',()=>{
 const data=snapshot(),before=structuredClone(data),report=projectQueueStatus(data,undefined,new Date('2026-01-02T00:00:00Z'));
 assert.equal(report.scope,'all');assert.equal(report.authority,'evidence-only');assert.equal(report.rows[0].status,'Held');assert.equal(report.rows[0].issue,'Current scope evidence is missing');assert.match(report.rows[0].fix,/Recover/);assert.equal(report.rows[0].recordedAt,'2026-01-01T00:00:00.000Z');assert.deepEqual(data,before);
});
test('coordinator-only is an optional view; default queue folds children only into their own project family',()=>{
 const queue=[row({runId:child,familyId:p+':child',parentRunId:run}),row({runId:child,projectId:other,projectName:'Project Beta',familyId:other+':child',parentRunId:run})];
 assert.equal(projectQueueStatus(snapshot({queue}),undefined,new Date(),false).rows.length,1);
 const report=projectQueueStatus(snapshot({queue}));assert.equal(report.scope,'all');assert.equal(report.rows.length,2);assert.equal(report.rows.filter(r=>r.projectId===other).length,1);
 assert.equal(projectQueueStatus(snapshot({queue}),p,new Date(),true).rows.length,1);
});
test('actual pending approvals and active tasks override recorded holds; historical permission prose does not',()=>{
 assert.equal(projectQueueStatus(snapshot({managed:[row({decision:{decision:'held',why:'Old permission report'}})]})).rows[0].status,'Held');
 assert.equal(projectQueueStatus(snapshot({managed:[row({approvalCount:1})]})).rows[0].status,'Awaiting approval');
 assert.equal(projectQueueStatus(snapshot({managed:[row({runningTasks:1,approvalCount:1})]})).rows[0].status,'Running');
});
test('a running lifecycle without a leased task is waiting or needs reconciliation, never presented as running',()=>{
 assert.equal(projectQueueStatus(snapshot({managed:[row({runStatus:'running',queuedTasks:1,runningTasks:0,decision:null})]})).rows[0].status,'Waiting');
 assert.equal(projectQueueStatus(snapshot({managed:[row({runStatus:'running',queuedTasks:0,runningTasks:0,decision:null})]})).rows[0].status,'Needs reconciliation');
 const stale=projectQueueStatus(snapshot({managed:[row({decision:{decision:'active'},runningTasks:0,queuedTasks:0})]})).rows[0];assert.equal(stale.status,'Needs reconciliation');assert.equal(stale.attention,'revisit');
});
test('completed, verified and unknown observations never become accepted product outcomes',()=>{
 assert.equal(projectQueueStatus(snapshot({managed:[],queue:[row({runStatus:'completed'})]}),undefined,new Date(),true).rows[0].status,'Needs verification');
 assert.equal(projectQueueStatus(snapshot({managed:[row({decision:{decision:'verified'}})]})).rows[0].status,'Review recorded');
 assert.equal(projectQueueStatus(snapshot({managed:[row({runStatus:'unrecognized'})]})).rows[0].status,'Unknown');
});
test('reject foreign/invalid identities, deduplicate exact family rows and bound output',()=>{
 const managed=[row(),row(),row({runId:'<script>'}),row({projectId:other,familyId:p+':foreign'})];
 assert.equal(projectQueueStatus(snapshot({managed})).rows.length,1);
 const many=Array.from({length:501},(_,i)=>row({runId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,familyId:p+':'+i}));
 const report=projectQueueStatus(snapshot({managed:many}));assert.equal(report.rows.length,500);assert.equal(report.truncated,true);
});
test('scrub private values and preserve recorded-time versus refreshed-time separation',()=>{
 const report=projectQueueStatus(snapshot({managed:[row({name:'password=private-value',decision:{why:'token=private-token',next:'Recover evidence from /home/example/private/file'},recordedAt:'not-a-date'})]}));
 assert.doesNotMatch(JSON.stringify(report),/private-value|private-token|\/home\/example/);assert.equal(report.rows[0].recordedAt,null);
});
test('project references are exact UUIDs, never paths or SQL; adapter gets the exact requested scope',async()=>{
 for(const value of [null,'','all'])assert.equal(parseQueueStatusProject(value),undefined);assert.equal(parseQueueStatusProject(p),p);
 for(const value of ['/synthetic/project',"' or true",'x'.repeat(10000)])assert.throws(()=>parseQueueStatusProject(value));
 let received:unknown;await buildQueueStatusReport(p,{snapshot:async(id,includeOther)=>{received={id,includeOther};return snapshot();}},true,{items:[],capturedAt:Date.now(),ageMs:0,refreshing:false});assert.deepEqual(received,{id:p,includeOther:true});
 const code=readFileSync(new URL('./queue-status.ts',import.meta.url),'utf8');assert.doesNotMatch(code,/insert into|update workflow|delete from|create table|claimSideEffect|recordRunAction/i);
 assert.match(code,/rc\.metadata_serialization_version=2 and rc\.metadata=a\.content/);assert.match(code,/x\.project_id=original\.project_id/);
});
test('transitive explicit children collapse into the original family with attempt history',()=>{
 const grandchild='55555555-5555-4555-8555-555555555555';
 const report=projectQueueStatus(snapshot({managed:[row()],queue:[row({runId:child,familyId:p+':child',name:'Repair attempt',parentRunId:run,runStatus:'completed'}),row({runId:grandchild,familyId:p+':grandchild',name:'Review attempt',parentRunId:child,runStatus:'blocked'})]}));
 assert.equal(report.rows.length,1);const family=report.rows[0];assert.equal(family.runId,run);assert.equal(family.name,'Synthetic source check');assert.equal(family.originalStatus,'blocked');assert.equal(family.attention,'revisit');assert.equal(family.attemptCount,3);assert.equal(family.completedAttemptCount,1);assert.equal(family.attempts.length,3);assert.notEqual(family.status,'Completed');
});
test('only genuinely executing children make a family working; queued work stays waiting',()=>{
 const report=(runningTasks:number,queuedTasks:number)=>projectQueueStatus(snapshot({managed:[row()],queue:[row({runId:child,familyId:p+':child',parentRunId:run,runStatus:'running',runningTasks,queuedTasks})]})).rows[0];
 assert.equal(report(1,0).attention,'working');assert.equal(report(1,0).status,'Running');assert.equal(report(0,1).attention,'waiting');assert.equal(report(0,1).status,'Waiting');assert.equal(report(0,0).attention,'revisit');
});
test('similar titles never merge unrelated work; cycles terminate and foreign parents stay separate',()=>{
 const independent=row({runId:child,familyId:p+':unrelated',name:'Synthetic source check'});
 assert.equal(projectQueueStatus(snapshot({managed:[row(),independent]})).rows.length,2);
 const cycle=[row({parentRunId:child}),row({runId:child,familyId:p+':child',parentRunId:run})];
 assert.equal(projectQueueStatus(snapshot({managed:cycle})).rows.length,1);
 assert.equal(projectQueueStatus(snapshot({managed:[row(),row({runId:child,projectId:other,familyId:other+':foreign',parentRunId:run})]})).rows.length,2);
});
test('bounded histories disclose total attempts and preserve original lifecycle separately',()=>{
 const attempts=Array.from({length:45},(_,i)=>({runId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,name:'Review attempt',status:'completed',issue:'',recordedAt:'2026-01-02T00:00:00Z',dismissed:false}));
 const family=projectQueueStatus(snapshot({managed:[row({runStatus:'completed',currentStatus:'blocked',attempts,attemptCount:65,completedAttemptCount:60,openAttemptCount:2,decision:null})]})).rows[0];
 assert.equal(family.originalStatus,'completed');assert.equal(family.status,'Blocked');assert.equal(family.attemptCount,65);assert.equal(family.completedAttemptCount,60);assert.equal(family.openAttemptCount,2);assert.equal(family.attempts.length,40);assert.equal(family.attemptsTruncated,true);assert.notEqual(family.status,'Accepted');
});
test('family query reuses explicit lineage, requires current task leases and never infers acceptance',()=>{
 const code=readFileSync(new URL('./queue-status.ts',import.meta.url),'utf8');
 assert.match(code,/groupQueueStatusIdentities/);assert.match(code,/t\.lease_expires_at>now\(\)/);assert.match(code,/x\.id=any\(qf\.open_members\)/);assert.match(code,/limit 40/);assert.doesNotMatch(code,/listWorkflowQueue\(/);
});

const queueCard=(patch:Partial<WorkflowQueueItem>={}):WorkflowQueueItem=>({runId:child,runSetId:run,versionSetId:run,runSetSize:1,relatedRunCount:2,relatedOpenRunCount:0,workflowId:'build-feature',runStatus:'blocked',task:'Deliver the synthetic source correction',projectName:'Project Alpha',projectRootUri:'/synthetic/project-a',projectIdentityId:p,startedAt:'2026-01-01T00:00:00Z',finishedAt:null,latestActivityAt:'2026-01-02T00:00:00Z',blockedReason:'Fresh canonical blocker',totalTasks:3,queuedTasks:0,runningTasks:0,completedTasks:2,failedTasks:1,cancelledTasks:0,nextStageId:null,nextAgentId:null,runningStageId:null,runningAgentId:null,runningWorkerId:null,runningLeaseExpiresAt:null,oldestQueuedAt:null,oldestRunningAt:null,recoveryRunId:null,recoveryRunStatus:null,recoveryStartedAt:null,recoveryRelation:null,familyAttempts:[{id:child,status:'blocked',blocker:'Fresh canonical blocker',approvals:[]},{id:run,status:'completed',blocker:null,approvals:[]}],...patch});
const canonical=(items:WorkflowQueueItem[]=[queueCard()]):QueueStatusQueueSnapshot=>({items,capturedAt:Date.parse('2026-01-02T00:00:00Z'),ageMs:5000,refreshing:true,limit:100});
test('mirror membership, family IDs, representative run IDs and order come only from the canonical queue',()=>{
 const extra='55555555-5555-4555-8555-555555555555',advisory=projectQueueStatus(snapshot({managed:[row(),row({runId:extra,familyId:p+':history',runStatus:'cancelled',decision:{decision:'held'},openAttemptCount:0})]}));
 const input=canonical(),before=structuredClone(input),report=mirrorQueueStatusReport(advisory,input,snapshot().projects,undefined,new Date('2026-01-02T00:00:05Z'));
 assert.equal(report.rows.length,1);assert.equal(report.rows[0].familyId,run);assert.equal(report.rows[0].runId,child);assert.equal(report.rows[0].id,p+':'+run);assert.equal(report.rows[0].issue,'Fresh canonical blocker');assert.equal(report.historyRows?.length,1);assert.equal(report.acceptanceReviewRows?.length,0);assert.equal(report.rows[0].openAttemptCount,1);assert.equal(report.rows[0].completedAttemptCount,1);assert.equal(report.queueSnapshot?.capturedAt,'2026-01-02T00:00:00.000Z');assert.equal(report.queueSnapshot?.ageMs,5000);assert.equal(report.queueSnapshot?.refreshing,true);assert.deepEqual(input,before);
 const second=queueCard({runId:extra,runSetId:extra,versionSetId:extra,familyAttempts:[{id:extra,status:'blocked',blocker:'Other issue',approvals:[]}],relatedRunCount:1});assert.deepEqual(mirrorQueueStatusReport(advisory,canonical([second,queueCard()]),snapshot().projects).rows.map(r=>r.familyId),[extra,run]);
});
test('closed tracked entries and acceptance review never become queue members; empty queue is not product acceptance',()=>{
 const extra='55555555-5555-4555-8555-555555555555',advisory=projectQueueStatus(snapshot({managed:[row({runStatus:'completed',openAttemptCount:0,decision:null}),row({runId:extra,familyId:p+':old-cancelled',runStatus:'cancelled',openAttemptCount:0,decision:null})]}));
 const report=mirrorQueueStatusReport(advisory,canonical([]),snapshot().projects);assert.equal(report.rows.length,0);assert.equal(report.historyRows?.length,1);assert.equal(report.acceptanceReviewRows?.length,1);assert.equal(report.authority,'evidence-only');assert.equal(report.acceptanceReviewRows?.[0].status,'Needs verification');
});
test('explicit zero-open count is not overridden by excluded historical failed/blocked attempts',()=>{
 const result=projectQueueStatus(snapshot({managed:[row({openAttemptCount:0,attempts:[{runId:run,name:'Excluded comparison',status:'blocked',issue:'Old comparison failure',dismissed:false,recordedAt:null}]})]}));assert.equal(result.rows[0].openAttemptCount,0);
});
test('queue-reconciled project locations are one display family and retain their actual execution owner',()=>{
 const alias='66666666-6666-4666-8666-666666666666',advisory=projectQueueStatus(snapshot({projects:[...snapshot().projects,{id:alias,name:'Project Alpha checkout'}],managed:[row(),row({runId:child,projectId:alias,familyId:alias+':alias-history',projectName:'Project Alpha checkout'})]}));
 const report=mirrorQueueStatusReport(advisory,canonical([queueCard({projectRootUri:'/synthetic/checkout',projectIdentityId:p})]),[...snapshot().projects,{id:alias,name:'Project Alpha checkout',rootUri:'/synthetic/checkout'}]);assert.equal(report.rows.length,1);assert.equal(report.rows[0].familyId,run);assert.equal(report.rows[0].projectId,alias);assert.equal(report.historyRows?.length,0);assert.equal(report.acceptanceReviewRows?.length,0);
});
test('canonical snapshot is required; unknown owners or duplicate family records fail closed',()=>{
 const advisory=projectQueueStatus(snapshot());assert.throws(()=>mirrorQueueStatusReport(advisory,{...canonical(),capturedAt:NaN},snapshot().projects));assert.throws(()=>mirrorQueueStatusReport(advisory,canonical([queueCard({projectIdentityId:'77777777-7777-4777-8777-777777777777'})]),snapshot().projects));assert.throws(()=>mirrorQueueStatusReport(advisory,canonical([queueCard(),queueCard()]),snapshot().projects));
 assert.throws(()=>mirrorQueueStatusReport(advisory,canonical([queueCard({projectRootUri:'/unregistered/root'})]),[{id:p,name:'Project Alpha',rootUri:'/synthetic/project-a'}]));
});
test('reconciled project filters are display-only and never substitute the execution project',()=>{
 const alias='66666666-6666-4666-8666-666666666666',projects=[{id:p,name:'Project Alpha',rootUri:'/synthetic/project-a',identityId:p},{id:alias,name:'Project Alpha checkout',rootUri:'/synthetic/checkout',identityId:p}],advisory=projectQueueStatus(snapshot());
 const report=mirrorQueueStatusReport(advisory,canonical(),projects,alias);assert.equal(report.rows.length,1);assert.equal(report.rows[0].projectId,p);assert.equal(report.rows[0].familyId,run);
});
test('existing Partner reasoning callers retain their advisory evidence unless given an explicit queue snapshot',async()=>{
 const adapter={snapshot:async()=>snapshot()};const existing=await buildQueueStatusReport(undefined,adapter,true);assert.equal(existing.rows.length,1);assert.equal(existing.rows[0].runId,run);assert.equal(existing.rows[0].status,'Held');assert.equal(existing.queueSnapshot,undefined);
 const dashboard=await buildQueueStatusReport(undefined,adapter,true,canonical([]));assert.equal(dashboard.rows.length,0);assert.equal(dashboard.historyRows?.length,1);assert.equal(dashboard.queueSnapshot?.familyCount,0);
});
test('identity grouping mirrors explicit queue edges without cross-project or multi-source fusion',()=>{
 const identity=(runId:string,patch:Partial<Parameters<typeof groupQueueStatusIdentities>[0][number]>={})=>({runId,projectId:p,runSetId:runId,startedAt:'2026-01-01T00:00:00Z',replacementRunId:null,parentRunIds:[],idempotencyKey:null,source:null,actor:null,legacySources:null,runStatus:'blocked',visible:true,...patch});
 const next='55555555-5555-4555-8555-555555555555';
 const group=groupQueueStatusIdentities([identity(run),identity(child,{parentRunIds:[run],runStatus:'completed'}),identity(next,{parentRunIds:[child],runStatus:'running',startedAt:'2026-01-02T00:00:00Z'})]);
 assert.equal(group.length,1);assert.equal(group[0].original_id,run);assert.equal(group[0].related_count,3);assert.equal(group[0].open_count,2);assert.equal(group[0].latest_id,next);
 assert.equal(groupQueueStatusIdentities([identity(run),identity(child,{projectId:other,parentRunIds:[run]})]).length,2);
 assert.equal(groupQueueStatusIdentities([identity(run),identity(child,{legacySources:run+' '+next}),identity(next)]).length,3);
 assert.equal(groupQueueStatusIdentities([identity(run),identity(child,{legacySources:run})]).length,1);
 assert.equal(groupQueueStatusIdentities([identity(run,{parentRunIds:[child]}),identity(child,{parentRunIds:[run],visible:false})])[0].open_count,1);
 for(const patch of [{runSetId:run},{replacementRunId:run}])assert.equal(groupQueueStatusIdentities([identity(run),identity(child,patch)]).length,1);
 assert.equal(groupQueueStatusIdentities([identity(run,{idempotencyKey:'request-one',source:'operator',actor:'test'}),identity(child,{idempotencyKey:'request-one',source:'operator',actor:'test'})]).length,1);
 assert.equal(groupQueueStatusIdentities([identity(run,{idempotencyKey:'request-one',source:null,actor:'test'}),identity(child,{idempotencyKey:'request-one',source:null,actor:'test'})]).length,2);
});
