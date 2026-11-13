import {createHash} from 'node:crypto';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';

export type QueuePartnerGuideHoldRow={runId:string;action:string;createdAt:string;metadata:Record<string,unknown>};
export type QueuePartnerGuideRegistryHold={projectId:string;expectedFingerprint:string;state:'open'|'resolved';affectedRunIds:string[];openedAt:string;resolvedAt:string|null;resolutionRunId:string|null;authority:'evidence-only'};
export type QueuePartnerGuideHoldMetric={projectId:string;expectedFingerprint:string;generation:number;state:'open'|'resolved';affectedRunCount:number;observedSkipReceipts:number;duplicateSuppressedCount:number;openedAt:string;resolvedAt:string|null;resolutionLatencyMs:number|null;openAgeMs:number|null;adoptionLagAlert:boolean;alertReason:string|null;authority:'observation-only';executionAuthorityGranted:false;primaryOutcomeAccepted:false};
export type QueuePartnerGuideLagCalibration={source:'measured'|'fallback'|'explicit';sampleCount:number;minimumSamples:number;p50ResolutionLatencyMs:number|null;p95ResolutionLatencyMs:number|null;fallbackMs:number;floorMs:number;ceilingMs:number;candidateThresholdMs:number;priorThresholdMs:number;selectedThresholdMs:number;alertThresholdMs:number;confidenceBandLowerMs:number|null;confidenceBandUpperMs:number|null;stableGenerationRequirement:number;stableGenerationsObserved:number;stability:'sparse'|'unstable'|'stable'|'explicit';maximumChangeFraction:number;changeLimited:boolean;alertProtection:'non-increasing';authority:'observation-only'};
const fingerprint=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value)?value:'unavailable';
const digest=(ids:readonly string[])=>createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex');

/** Coalesced operator projection only. Original per-run skip receipts remain authoritative. */
export function summarizeQueuePartnerGuideRegistryHolds(rows:readonly QueuePartnerGuideHoldRow[],projectId:string):QueuePartnerGuideRegistryHold[]{
 const groups=new Map<string,QueuePartnerGuideRegistryHold>();
 for(const row of [...rows].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.runId.localeCompare(b.runId))){
  const expected=fingerprint(row.metadata?.expectedFingerprint);
  if(row.action==='guide_registry_not_ready'){
   const prior=groups.get(expected);
   if(!prior||prior.state==='resolved')groups.set(expected,{projectId,expectedFingerprint:expected,state:'open',affectedRunIds:[row.runId],openedAt:row.createdAt,resolvedAt:null,resolutionRunId:null,authority:'evidence-only'});
   else if(!prior.affectedRunIds.includes(row.runId))prior.affectedRunIds.push(row.runId);
  }else if(row.action==='guide_registry_ready'){
   const prior=groups.get(expected);if(!prior||prior.state!=='open')continue;
   const claimed=Array.isArray(row.metadata?.affectedRunIds)?row.metadata.affectedRunIds.filter((id):id is string=>typeof id==='string').sort():[];
   if(digest(prior.affectedRunIds)!==row.metadata?.affectedRunDigest||digest(claimed)!==row.metadata?.affectedRunDigest)continue;
   prior.state='resolved';prior.resolvedAt=row.createdAt;prior.resolutionRunId=row.runId;
  }
 }
 return [...groups.values()].map(item=>({...item,affectedRunIds:[...item.affectedRunIds].sort()})).sort((a,b)=>b.openedAt.localeCompare(a.openedAt));
}

/** Bounded observational metrics derived from immutable hold receipts. No alert grants recovery authority. */
export function summarizeQueuePartnerGuideHoldMetrics(rows:readonly QueuePartnerGuideHoldRow[],projectId:string,now=new Date(),staleAfterMs=15*60_000):QueuePartnerGuideHoldMetric[]{
 const generations:Array<{hold:QueuePartnerGuideRegistryHold;generation:number;observed:number;ids:Set<string>}>=[],current=new Map<string,typeof generations[number]>(),generationCounts=new Map<string,number>();
 for(const row of [...rows].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.runId.localeCompare(b.runId))){
  const expected=fingerprint(row.metadata?.expectedFingerprint);
  if(row.action==='guide_registry_not_ready'){
   let item=current.get(expected);
   if(!item||item.hold.state==='resolved'){
    const generation=(generationCounts.get(expected)??0)+1;generationCounts.set(expected,generation);
    item={generation,observed:0,ids:new Set(),hold:{projectId,expectedFingerprint:expected,state:'open',affectedRunIds:[],openedAt:row.createdAt,resolvedAt:null,resolutionRunId:null,authority:'evidence-only'}};
    current.set(expected,item);generations.push(item);
   }
   item.observed+=1;item.ids.add(row.runId);item.hold.affectedRunIds=[...item.ids].sort();
   continue;
  }
  if(row.action!=='guide_registry_ready')continue;
  const item=current.get(expected);if(!item||item.hold.state!=='open')continue;
  const claimed=Array.isArray(row.metadata?.affectedRunIds)?row.metadata.affectedRunIds.filter((id):id is string=>typeof id==='string').sort():[];
  if(digest(item.hold.affectedRunIds)!==row.metadata?.affectedRunDigest||digest(claimed)!==row.metadata?.affectedRunDigest)continue;
  item.hold.state='resolved';item.hold.resolvedAt=row.createdAt;item.hold.resolutionRunId=row.runId;
 }
 const nowMs=now.getTime();
 return generations.map(({hold,generation,observed})=>{
  const openedMs=Date.parse(hold.openedAt),resolvedMs=hold.resolvedAt?Date.parse(hold.resolvedAt):null;
  const resolutionLatencyMs=resolvedMs===null||!Number.isFinite(openedMs)||!Number.isFinite(resolvedMs)?null:Math.max(0,resolvedMs-openedMs);
  const openAgeMs=hold.state==='open'&&Number.isFinite(openedMs)&&Number.isFinite(nowMs)?Math.max(0,nowMs-openedMs):null;
  const adoptionLagAlert=hold.state==='open'&&hold.expectedFingerprint!=='unavailable'&&openAgeMs!==null&&openAgeMs>=staleAfterMs;
  return {projectId,expectedFingerprint:hold.expectedFingerprint,generation,state:hold.state,affectedRunCount:hold.affectedRunIds.length,observedSkipReceipts:observed,duplicateSuppressedCount:Math.max(0,observed-hold.affectedRunIds.length),openedAt:hold.openedAt,resolvedAt:hold.resolvedAt,resolutionLatencyMs,openAgeMs,adoptionLagAlert,alertReason:adoptionLagAlert?`Expected Guide registry generation has remained unobserved for at least ${staleAfterMs}ms`:null,authority:'observation-only' as const,executionAuthorityGranted:false as const,primaryOutcomeAccepted:false as const};
 }).sort((a,b)=>b.openedAt.localeCompare(a.openedAt)||b.generation-a.generation);
}

const percentile=(values:readonly number[],fraction:number)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*fraction)-1)]!:null;
export function calibrateQueuePartnerGuideLagThreshold(metrics:readonly QueuePartnerGuideHoldMetric[],options:{explicitMs?:number;minimumSamples?:number;fallbackMs?:number;floorMs?:number;ceilingMs?:number;stableGenerationRequirement?:number;maximumChangeFraction?:number}={}):QueuePartnerGuideLagCalibration{
 const minimumSamples=Math.max(1,Math.trunc(options.minimumSamples??5)),stableGenerationRequirement=Math.max(1,Math.trunc(options.stableGenerationRequirement??3)),maximumChangeFraction=Math.min(.5,Math.max(.05,options.maximumChangeFraction??.25)),fallbackMs=options.fallbackMs??15*60_000,floorMs=options.floorMs??5*60_000,ceilingMs=options.ceilingMs??60*60_000,clamp=(value:number)=>Math.min(Math.max(Math.round(value),floorMs),ceilingMs);
 const samples=metrics.filter(item=>item.resolutionLatencyMs!==null&&Number.isFinite(item.resolutionLatencyMs)&&item.resolutionLatencyMs>=0).sort((a,b)=>(a.resolvedAt??a.openedAt??'').localeCompare(b.resolvedAt??b.openedAt??'')||(a.generation??0)-(b.generation??0)).map(item=>item.resolutionLatencyMs as number),p50=percentile(samples,.5),p95=percentile(samples,.95),candidates:number[]=[];
 for(let size=minimumSamples;size<=samples.length;size++){const prefixP95=percentile(samples.slice(0,size),.95);if(prefixP95!==null)candidates.push(clamp(Math.ceil(prefixP95*1.5)));}
 const boundedFallback=clamp(fallbackMs);let selected=boundedFallback,prior=boundedFallback,protectedAlertThreshold=boundedFallback,promotions=0,changeLimited=false,lastStable=false,confidenceBandLowerMs:number|null=null,confidenceBandUpperMs:number|null=null;
 for(let index=stableGenerationRequirement-1;index<candidates.length;index++){
  const window=candidates.slice(index-stableGenerationRequirement+1,index+1),lower=Math.min(...window),upper=Math.max(...window),center=percentile(window,.5)??upper,tolerance=Math.max(1,center*maximumChangeFraction),stable=upper-lower<=tolerance;
  if(index===candidates.length-1){confidenceBandLowerMs=lower;confidenceBandUpperMs=upper;lastStable=stable;}
  if(!stable)continue;
  prior=selected;const target=candidates[index]!,lowerChange=selected*(1-maximumChangeFraction),upperChange=selected*(1+maximumChangeFraction),next=clamp(Math.min(Math.max(target,lowerChange),upperChange));changeLimited=next!==target;selected=next;protectedAlertThreshold=Math.min(protectedAlertThreshold,selected);promotions+=1;
 }
 if(candidates.length&&confidenceBandLowerMs===null){confidenceBandLowerMs=Math.min(...candidates);confidenceBandUpperMs=Math.max(...candidates);}
 const latestCandidate=candidates.at(-1)??boundedFallback;let stableGenerationsObserved=0;for(let index=candidates.length-1;index>=0&&stableGenerationsObserved<stableGenerationRequirement;index--){if(Math.abs(candidates[index]!-latestCandidate)>Math.max(1,latestCandidate*maximumChangeFraction))break;stableGenerationsObserved+=1;}
 const explicit=options.explicitMs!==undefined,selectedThresholdMs=explicit?clamp(options.explicitMs!):selected,alertThresholdMs=Math.min(protectedAlertThreshold,selectedThresholdMs),source=explicit?'explicit':promotions>0?'measured':'fallback',stability=explicit?'explicit':candidates.length<stableGenerationRequirement?'sparse':lastStable?'stable':'unstable';
 return {source,sampleCount:samples.length,minimumSamples,p50ResolutionLatencyMs:p50,p95ResolutionLatencyMs:p95,fallbackMs,floorMs,ceilingMs,candidateThresholdMs:explicit?clamp(options.explicitMs!):latestCandidate,priorThresholdMs:prior,selectedThresholdMs,alertThresholdMs,confidenceBandLowerMs,confidenceBandUpperMs,stableGenerationRequirement,stableGenerationsObserved,stability,maximumChangeFraction,changeLimited,alertProtection:'non-increasing',authority:'observation-only'};
}

export function applyGuideLagThreshold(metrics:readonly QueuePartnerGuideHoldMetric[],thresholdMs:number):QueuePartnerGuideHoldMetric[]{
 return metrics.map(item=>{const adoptionLagAlert=item.state==='open'&&item.expectedFingerprint!=='unavailable'&&item.openAgeMs!==null&&item.openAgeMs>=thresholdMs;return {...item,adoptionLagAlert,alertReason:adoptionLagAlert?`Expected Guide registry generation has remained unobserved for at least ${thresholdMs}ms`:null};});
}

export async function queuePartnerGuideRegistryHoldMetrics(projectId:string,options:{now?:Date;staleAfterMs?:number;minimumCalibrationSamples?:number}={}):Promise<{schemaVersion:1;boundedReceiptLimit:1000;truncated:boolean;metrics:QueuePartnerGuideHoldMetric[];calibration:QueuePartnerGuideLagCalibration;authority:'observation-only';executionAuthorityGranted:false}>{
 return withClient(async c=>{const rows=(await c.query(`select a.run_id::text "runId",a.action_type action,a.created_at::text "createdAt",a.metadata
  from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid
  and a.action_type in ('guide_registry_not_ready','guide_registry_ready') order by a.created_at,a.id limit 1001`,[projectId])).rows as QueuePartnerGuideHoldRow[];
  const raw=summarizeQueuePartnerGuideHoldMetrics(rows.slice(0,1000),projectId,options.now,Number.POSITIVE_INFINITY),calibration=calibrateQueuePartnerGuideLagThreshold(raw,{explicitMs:options.staleAfterMs,minimumSamples:options.minimumCalibrationSamples});
  return {schemaVersion:1,boundedReceiptLimit:1000,truncated:rows.length>1000,metrics:applyGuideLagThreshold(raw,calibration.alertThresholdMs),calibration,authority:'observation-only',executionAuthorityGranted:false};
 });
}

export async function queuePartnerGuideRegistryHolds(projectId:string):Promise<QueuePartnerGuideRegistryHold[]>{
 return withClient(async c=>{const rows=(await c.query(`select a.run_id::text "runId",a.action_type action,a.created_at::text "createdAt",a.metadata
  from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid
  and a.action_type in ('guide_registry_not_ready','guide_registry_ready') order by a.created_at,a.id limit 1001`,[projectId])).rows;
  return summarizeQueuePartnerGuideRegistryHolds(rows.slice(0,1000),projectId);
 });
}

/** Serializes one resolution per project/fingerprint generation. It grants no replay or acceptance authority. */
export async function reconcileQueuePartnerGuideRegistryHold(input:{runId:string;actorAgentId:string;expectedFingerprint:string}){
 return withClient(async c=>{await c.query('begin');try{
  const run=(await c.query('select project_id::text "projectId" from workflow_runs where id=$1::uuid for update',[input.runId])).rows[0];
  if(!run)throw Error('Guide registry reconciliation requires an existing run');
  await c.query('select pg_advisory_xact_lock(hashtext($1))',[`${run.projectId}:guide-registry:${input.expectedFingerprint}`]);
  const rows=(await c.query(`select a.run_id::text "runId",a.action_type action,a.created_at::text "createdAt",a.metadata
   from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid
   and a.action_type in ('guide_registry_not_ready','guide_registry_ready') order by a.created_at,a.id limit 1001`,[run.projectId])).rows;
  const open=summarizeQueuePartnerGuideRegistryHolds(rows.slice(0,1000),run.projectId).find(h=>h.state==='open'&&h.expectedFingerprint===input.expectedFingerprint);
  if(!open){await c.query('commit');return {recorded:false,affectedRunIds:[] as string[]};}
  const affectedRunIds=open.affectedRunIds.slice(0,500),affectedRunDigest=digest(affectedRunIds);
  await appendActionReceipt(c,{runId:input.runId,agentId:input.actorAgentId,actionType:'guide_registry_ready',target:'workflow-guide',summary:`Guide registry is current; coalesced adoption hold resolved for ${affectedRunIds.length} affected run(s). Skipped Guide work was not replayed and primary outcomes were not accepted.`,metadata:JSON.stringify({schemaVersion:1,authority:'none',expectedFingerprint:input.expectedFingerprint,affectedRunIds,affectedRunDigest,skippedRunsReplayed:false,primaryOutcomesAccepted:false})});
  await c.query('commit');return {recorded:true,affectedRunIds};
 }catch(error){await c.query('rollback');throw error;}});
}
