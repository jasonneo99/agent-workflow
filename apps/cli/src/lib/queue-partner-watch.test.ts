import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate} from 'node:timers/promises';
import {watchPartnerQueue,partnerPreparationStep,assertPartnerPlanningOpen,PartnerPlanningStopped} from './queue-partner-watch.js';
import {planQueueCoordinator,type QueueCoordinatorFamily} from '../../../../packages/workflow-engine/src/queue-coordinator-plan.js';
import {executeQueueCoordinatorPlan} from '../../../../packages/workflow-engine/src/queue-coordinator-controller.js';
const family=(id:string):QueueCoordinatorFamily=>({familyId:id,sourceRunId:id,projectId:'synthetic',projectRootUri:'/synthetic',canonical:true,activeRunIds:[],pendingApprovalIds:[],fileScopes:[id+'.ts'],failureFingerprint:id,priorFingerprint:null,repairDepth:0,verificationReady:false,originalAcceptancePresent:true,sourceEvidenceReady:true,blocker:'source test defect'});
test('one completed slot backfills before the other original jobs finish, never exceeding five',async t=>{
 const shutdown=new AbortController(),active=new Set<string>(),done=new Set<string>(),gates=new Map<string,()=>void>(),lanes=new Map<string,number>(),reports:unknown[]=[];
 let peak=0,passes=0;const starts:string[]=[];
 const watching=watchPartnerQueue({signal:shutdown.signal,intervalMs:60000,report:r=>reports.push(r),pass:async wake=>{
  passes++;const plan=planQueueCoordinator(['a','b','c','d','e','f'].filter(id=>!done.has(id)).map(id=>({...family(id),activeRunIds:active.has(id)?['live']:[]})),{occupiedRepairLanes:[...lanes.values()]});
  return executeQueueCoordinatorPlan(plan,{
   reserve:async({family:f,lane})=>{assert.equal(active.has(f.familyId),false);assert.ok(active.size<5);assert.ok(![...lanes.values()].includes(lane));active.add(f.familyId);lanes.set(f.familyId,lane);return {id:f.familyId,fence:'1'};},
   run:async({family:f})=>{starts.push(f.familyId);peak=Math.max(peak,active.size);await new Promise<void>(resolve=>gates.set(f.familyId,resolve));return {state:'held',reason:'Fresh attempt settled'};},
   finish:async({claim})=>{active.delete(claim.id);lanes.delete(claim.id);done.add(claim.id);}
  },{onSettled:wake});
 }});
 t.after(async()=>{shutdown.abort();for(const release of gates.values())release();await watching;});
 await setImmediate();assert.equal(active.size,5);assert.equal(passes,1);
 gates.get('a')!();await setImmediate();await setImmediate();assert.ok(starts.includes('f'),'Refill must not wait for the original batch');assert.equal(active.size,5);assert.equal(peak,5);assert.equal(done.size,1);
 shutdown.abort();let stopped=false;void watching.then(()=>{stopped=true;});await setImmediate();assert.equal(stopped,false,'Graceful stop drains work instead of cancelling it');
 for(const release of gates.values())release();await watching;assert.equal(new Set(starts).size,6);assert.equal(starts.length,6);assert.equal(active.size,0);assert.ok(reports.length>=2);
});
test('unchanged held passes do not create a busy loop or a new consumer',async()=>{
 const shutdown=new AbortController();let passes=0;
 const watching=watchPartnerQueue({signal:shutdown.signal,intervalMs:60000,pass:async()=>{passes++;return 'held';},report:()=>{}});
 for(let i=0;i<4;i++)await setImmediate();assert.equal(passes,1);shutdown.abort();await watching;
});
test('planning failure stops new dispatch while existing owned work drains',async()=>{
 const shutdown=new AbortController();let wake!:()=>void,finish!:()=>void,calls=0,drained=false;
 const watching=watchPartnerQueue({signal:shutdown.signal,intervalMs:60000,report:()=>{},pass:async notify=>{calls++;if(calls>1)throw Error('Storage unavailable');wake=notify;await new Promise<void>(resolve=>{finish=resolve;});drained=true;return 'finished';}});
 const outcome=watching.then(()=>null,error=>error);await setImmediate();wake();await setImmediate();assert.equal(calls,2);assert.equal(drained,false);finish();assert.match(String(await outcome),/Storage unavailable/);assert.equal(drained,true);
});
test('shutdown during asynchronous discovery cannot reach planning or reservation',async()=>{
 const shutdown=new AbortController();let discovered!:()=>void,reservations=0;
 const watching=watchPartnerQueue({signal:shutdown.signal,intervalMs:60000,report:()=>{},pass:async()=>{
  try{await partnerPreparationStep(()=>new Promise<void>(resolve=>{discovered=resolve;}),()=>shutdown.signal.aborted);reservations++;return 'reserved';}
  catch(error){assert.ok(error instanceof PartnerPlanningStopped);return 'draining';}
 }});
 await setImmediate();shutdown.abort();discovered();await watching;assert.equal(reservations,0);
});
test('stop during intent acquisition releases the new intent without consuming a reservation',async()=>{
 const shutdown=new AbortController();let acquired!:()=>void,released=0,reservations=0;
 const reserve=async()=>{assertPartnerPlanningOpen(()=>shutdown.signal.aborted);await new Promise<void>(resolve=>{acquired=resolve;});try{assertPartnerPlanningOpen(()=>shutdown.signal.aborted);reservations++;}finally{released++;}};
 const result=reserve().then(()=>null,error=>error);await setImmediate();shutdown.abort();acquired();assert.ok(await result instanceof PartnerPlanningStopped);assert.equal(released,1);assert.equal(reservations,0);
});
test('production preparation gate rejects a stop during lazy reservation-module loading',async()=>{
 for(const role of ['assessment','verifier']){
  const shutdown=new AbortController();let loaded!:(module:{reserve:()=>void})=>void,reservations=0;
  const result=partnerPreparationStep(()=>new Promise<{reserve:()=>void}>(resolve=>{loaded=resolve;}),()=>shutdown.signal.aborted)
   .then(module=>module.reserve(),error=>error);
  shutdown.abort();loaded({reserve:()=>{reservations++;}});
  assert.ok(await result instanceof PartnerPlanningStopped,role);assert.equal(reservations,0,role);
 }
});
