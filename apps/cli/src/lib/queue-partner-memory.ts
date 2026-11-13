import {acceptanceDigest} from '../../../../packages/storage/src/acceptance.js';
import {withClient} from '../../../../packages/storage/src/client.js';
import {verifyRepairedRevisionAttestationOnClient} from '../../../../packages/storage/src/repaired-revision.js';
import type {CoordinatorClaim} from '../../../../packages/storage/src/queue-coordinator.js';

export interface QueuePartnerMemoryFact {runId:string;kind:string;target:string;summary:string;exitCode?:number;timedOut?:boolean;nextHash?:string}
export type QueuePartnerRecoveryPhase='planning'|'intent'|'reservation'|'lease-wait'|'provider'|'tool'|'verification'|'worker-other'|'finalization';
export interface QueuePartnerDeliveryEvidence {durationMs?:number;timeToFirstActionMs?:number;modelLatencyMs?:number;costUsd?:number;providerCalls:number;costCoverageCalls:number;
 phaseMs?:Partial<Record<QueuePartnerRecoveryPhase,number>>;bottleneck?:QueuePartnerRecoveryPhase}
export interface QueuePartnerMemoryRecord {
 projectId:string;familyId:string;sourceRunId:string;childRunId:string;task:string;blocker:string;writePaths:string[];
 outcome:'verified'|'completed-unverified'|'blocked'|'failed'|'cancelled'|'uncertain';facts:QueuePartnerMemoryFact[];delivery?:QueuePartnerDeliveryEvidence;
 applicability?:QueuePartnerMemoryApplicability;recordedAt?:string;expiresAt?:string;
}
export interface QueuePartnerMemoryApplicability {sourceHash:string|null;policyHash:string;acceptanceHash:string}
export interface QueuePartnerComparison extends QueuePartnerMemoryRecord {
 score:number;evidenceDigest:string;authority:'evidence-only';recurrence:true;regression:boolean;
 rankingSignals:{relevance:number;reliability:number;verification:number;speed:number;cost:number};
 relationship:'same-family'|'same-source'|'overlapping-paths'|'similar-symptom';
 interpretation:'regression-after-verified-remedy'|'recurrence-after-unverified-attempt'|'related-prior-failure';
}
export interface QueuePartnerMemoryPromotion {
 promotesNodeId:string;sourceRunId:string;repairRunId:string;verificationRunId:string;
 candidateId:string;repairedHash:string;baseEvidenceDigest:string;recordedAt:string;expiresAt:string;
}
export interface QueuePartnerMemoryControl {targetNodeId:string;action:'revoke'|'supersede';reason:string;recordedAt:string;replacementNodeId?:string}
export interface QueuePartnerEffectivenessReport {attempts:number;retainedAttempts:number;verifiedRemedies:number;repeatFailures:number;repeatFailureRate:number;
 averageTimeToVerifiedMs:number|null;duplicateWorkAvoided:number|null;duplicateAvoidanceCoverage:'unavailable-until-influence-recorded'}
export interface QueuePartnerMemoryInfluence {runId:string;memoryRunId:string;effect:'changed-plan'|'confirmed-plan'|'rejected'|'not-demonstrated';reason:string;recordedAt:string}
export interface QueuePartnerRepairPlaybook {sourceRunId:string;repairRunId:string;authority:'evidence-only';proof:'independently-verified';
 exactPaths:string[];successfulActions:Array<{kind:'file_write'|'local_command';target:string;nextHash?:string}>;verificationActions:string[];
 evidenceDigest:string;applicability:QueuePartnerMemoryApplicability;revalidated:true}
export interface QueuePartnerRejectedPlaybook {sourceRunId:string;repairRunId:string;evidenceDigest:string;
 reason:'missing-applicability-proof'|'source-changed'|'policy-changed'|'acceptance-changed'}
export interface QueuePartnerPlaybookRevalidation {eligible:QueuePartnerRepairPlaybook[];rejected:QueuePartnerRejectedPlaybook[]}
export interface QueuePartnerHistorySummary {attempts:number;verified:number;items:Array<{runId:string;outcome:QueuePartnerMemoryRecord['outcome'];recordedAt:string;
 proof:'independently-verified'|'unverified-attempt'|'unsuccessful-attempt';durationMs?:number;costUsd?:number;bottleneck?:QueuePartnerRecoveryPhase;bottleneckMs?:number;
 influence?:Pick<QueuePartnerMemoryInfluence,'effect'|'reason'>}>}
export interface QueuePartnerMemoryQuarantineIssue {nodeId:string;kind:string;reason:'malformed-body'|'broken-edge'|'contradictory-record'|'contradictory-promotion'|'unbound-promotion'}
export interface QueuePartnerMemoryEvidenceSet {records:QueuePartnerMemoryRecord[];promotions:QueuePartnerMemoryPromotion[];controls:QueuePartnerMemoryControl[];quarantined:QueuePartnerMemoryQuarantineIssue[]}

const words=(value:string)=>new Set((value.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/gu)??[]).filter(word=>!['that','this','with','from','have','were','into','then'].includes(word)));
const overlap=(left:Iterable<string>,right:Iterable<string>)=>{const r=new Set(right);let count=0;for(const value of left)if(r.has(value))count++;return count;};
const bounded=(value:string,length:number)=>value.slice(0,length);
const finiteNonNegative=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
function memoryRecord(value:unknown):QueuePartnerMemoryRecord|null{
 const record=value as Partial<QueuePartnerMemoryRecord>;
 return record&&typeof record.projectId==='string'&&typeof record.familyId==='string'&&typeof record.sourceRunId==='string'
  &&typeof record.childRunId==='string'&&typeof record.task==='string'&&typeof record.blocker==='string'&&Array.isArray(record.writePaths)
  &&record.writePaths.every(path=>typeof path==='string')&&Array.isArray(record.facts)&&record.facts.every(fact=>fact&&typeof fact.kind==='string'&&typeof fact.target==='string'&&typeof fact.summary==='string')
  &&(!record.delivery||(Number.isInteger(record.delivery.providerCalls)&&Number.isInteger(record.delivery.costCoverageCalls)
   &&record.delivery.providerCalls!>=0&&record.delivery.costCoverageCalls!>=0&&record.delivery.costCoverageCalls!<=record.delivery.providerCalls!
   &&(record.delivery.durationMs===undefined||finiteNonNegative(record.delivery.durationMs))
   &&(record.delivery.timeToFirstActionMs===undefined||finiteNonNegative(record.delivery.timeToFirstActionMs))
   &&(record.delivery.modelLatencyMs===undefined||finiteNonNegative(record.delivery.modelLatencyMs))
   &&(record.delivery.costUsd===undefined||finiteNonNegative(record.delivery.costUsd))
   &&(record.delivery.phaseMs===undefined||Object.entries(record.delivery.phaseMs).every(([key,value])=>['planning','intent','reservation','lease-wait','provider','tool','verification','worker-other','finalization'].includes(key)&&finiteNonNegative(value)))
   &&(record.delivery.bottleneck===undefined||['planning','intent','reservation','lease-wait','provider','tool','verification','worker-other','finalization'].includes(record.delivery.bottleneck))))
  &&(record.applicability===undefined||(record.applicability&&typeof record.applicability.policyHash==='string'&&typeof record.applicability.acceptanceHash==='string'
   &&(record.applicability.sourceHash===null||typeof record.applicability.sourceHash==='string')))
  &&(record.expiresAt===undefined||Number.isFinite(Date.parse(record.expiresAt)))
  &&['verified','completed-unverified','blocked','failed','cancelled','uncertain'].includes(String(record.outcome))?record as QueuePartnerMemoryRecord:null;
}
export function queuePartnerMemoryDigest(record:Pick<QueuePartnerMemoryRecord,'facts'>):string{
 return acceptanceDigest([...new Set(record.facts.map(f=>JSON.stringify({kind:f.kind,target:f.target,exitCode:f.exitCode,timedOut:f.timedOut,nextHash:f.nextHash})))].sort());
}
/** Project-local, receipt-backed repair structure. Narrative text and chat
 * authority are deliberately excluded; the current policy and acceptance
 * contract must still authorize and prove every reused action. */
export function queuePartnerRepairPlaybooks(comparisons:readonly QueuePartnerComparison[],current:QueuePartnerMemoryApplicability):QueuePartnerPlaybookRevalidation{
 const eligible:QueuePartnerRepairPlaybook[]=[],rejected:QueuePartnerRejectedPlaybook[]=[];
 for(const record of comparisons.filter(record=>record.outcome==='verified').slice(0,5)){
  const reason:QueuePartnerRejectedPlaybook['reason']|null=!record.applicability?'missing-applicability-proof'
   :record.applicability.sourceHash!==current.sourceHash?'source-changed'
   :record.applicability.policyHash!==current.policyHash?'policy-changed'
   :record.applicability.acceptanceHash!==current.acceptanceHash?'acceptance-changed':null;
  if(reason){rejected.push({sourceRunId:record.sourceRunId,repairRunId:record.childRunId,evidenceDigest:record.evidenceDigest,reason});continue;}
  const successfulActions=record.facts.filter(fact=>(fact.kind==='file_write'&&Boolean(fact.nextHash))
   ||(fact.kind==='local_command'&&fact.exitCode===0&&fact.timedOut!==true)).slice(-12).map(fact=>({kind:fact.kind as 'file_write'|'local_command',target:fact.target,...(fact.nextHash?{nextHash:fact.nextHash}:{})}));
  if(!successfulActions.length)continue;
  eligible.push({sourceRunId:record.sourceRunId,repairRunId:record.childRunId,authority:'evidence-only' as const,proof:'independently-verified' as const,
   exactPaths:[...new Set(record.writePaths)].sort().slice(0,40),successfulActions,
   verificationActions:successfulActions.filter(action=>action.kind==='local_command'&&/(?:test|check|verify|compile|lint)/iu.test(action.target)).map(action=>action.target),
   evidenceDigest:record.evidenceDigest,applicability:record.applicability!,revalidated:true as const});
 }
 return {eligible,rejected};
}
export function queuePartnerDeliveryEvidence(startedAt:unknown,finishedAt:unknown,routes:unknown[],availableAt?:unknown,firstActionAt?:unknown,
 observations:{planningMs?:number;intentMs?:number;reservationMs?:number;executionMs?:number;finalizationMs?:number;tools?:unknown[]}={}):QueuePartnerDeliveryEvidence{
 const started=Date.parse(String(startedAt??'')),finished=Date.parse(String(finishedAt??''));
 const available=Date.parse(String(availableAt??'')),firstAction=Date.parse(String(firstActionAt??''));
 let providerCalls=0,costCoverageCalls=0,modelLatencyMs=0,costUsd=0,latencyCoverage=0;
 for(const route of routes){const attempts=Array.isArray((route as any)?.attempts)?(route as any).attempts:[];
  for(const attempt of attempts){providerCalls++;
   if(finiteNonNegative(attempt?.latencyMs)){modelLatencyMs+=attempt.latencyMs;latencyCoverage++;}
   if(finiteNonNegative(attempt?.costUsd)){costUsd+=attempt.costUsd;costCoverageCalls++;}
  }}
 const phaseMs:Partial<Record<QueuePartnerRecoveryPhase,number>>={};
 for(const [phase,value] of [['planning',observations.planningMs],['intent',observations.intentMs],['reservation',observations.reservationMs],['finalization',observations.finalizationMs]] as const)if(finiteNonNegative(value))phaseMs[phase]=value;
 if(Number.isFinite(available)&&Number.isFinite(firstAction)&&firstAction>=available)phaseMs['lease-wait']=firstAction-available;
 if(latencyCoverage)phaseMs.provider=modelLatencyMs;
 let toolMs=0,verificationMs=0;
 for(const receipt of observations.tools??[]){const duration=(receipt as any)?.metadata?.durationMs??(receipt as any)?.durationMs,target=String((receipt as any)?.target??'');if(!finiteNonNegative(duration))continue;toolMs+=duration;if(/(?:test|check|verify|compile|lint)/iu.test(target))verificationMs+=duration;}
 if(toolMs)phaseMs.tool=toolMs;if(verificationMs)phaseMs.verification=verificationMs;
 if(finiteNonNegative(observations.executionMs)){const observed=(phaseMs['lease-wait']??0)+(phaseMs.provider??0)+(phaseMs.tool??0);phaseMs['worker-other']=Math.max(0,observations.executionMs-observed);}
 const bottleneck=(Object.entries(phaseMs) as Array<[QueuePartnerRecoveryPhase,number]>).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0];
 return {...(Number.isFinite(started)&&Number.isFinite(finished)&&finished>=started?{durationMs:finished-started}:{}),
  ...(Number.isFinite(available)&&Number.isFinite(firstAction)&&firstAction>=available?{timeToFirstActionMs:firstAction-available}:{}),
  ...(latencyCoverage?{modelLatencyMs}:{}),...(costCoverageCalls?{costUsd}:{}),providerCalls,costCoverageCalls,
  ...(Object.keys(phaseMs).length?{phaseMs,bottleneck}: {})};
}
function memoryPromotion(value:unknown):QueuePartnerMemoryPromotion|null{
 const promotion=value as Partial<QueuePartnerMemoryPromotion>;
 return promotion&&typeof promotion.promotesNodeId==='string'&&typeof promotion.sourceRunId==='string'
  &&typeof promotion.repairRunId==='string'&&typeof promotion.verificationRunId==='string'
  &&typeof promotion.candidateId==='string'&&typeof promotion.repairedHash==='string'
  &&typeof promotion.baseEvidenceDigest==='string'&&typeof promotion.recordedAt==='string'&&Number.isFinite(Date.parse(String(promotion.expiresAt)))?promotion as QueuePartnerMemoryPromotion:null;
}
function memoryControl(value:unknown):QueuePartnerMemoryControl|null{const control=value as Partial<QueuePartnerMemoryControl>;
 return control&&typeof control.targetNodeId==='string'&&['revoke','supersede'].includes(String(control.action))&&typeof control.reason==='string'
  &&Number.isFinite(Date.parse(String(control.recordedAt)))&&(control.replacementNodeId===undefined||typeof control.replacementNodeId==='string')?control as QueuePartnerMemoryControl:null;}
/** Invalid or contradictory evidence stays in the append-only graph but is
 * excluded from retrieval. This is a deterministic quarantine projection, not
 * a mutation of historical records. */
export function quarantineQueuePartnerMemoryEvidence(input:Omit<QueuePartnerMemoryEvidenceSet,'quarantined'>):QueuePartnerMemoryEvidenceSet{
 const quarantined:QueuePartnerMemoryQuarantineIssue[]=[],recordGroups=new Map<string,QueuePartnerMemoryRecord[]>();
 for(const record of input.records){const id=`queue-partner-recovery:${record.childRunId}`,group=recordGroups.get(id)??[];group.push(record);recordGroups.set(id,group);}
 const records=input.records.filter(record=>{const id=`queue-partner-recovery:${record.childRunId}`,group=recordGroups.get(id)!;
  const contradictory=new Set(group.map(item=>acceptanceDigest({projectId:item.projectId,familyId:item.familyId,sourceRunId:item.sourceRunId,evidenceDigest:queuePartnerMemoryDigest(item),applicability:item.applicability??null}))).size>1;
  if(contradictory&&!quarantined.some(issue=>issue.nodeId===id))quarantined.push({nodeId:id,kind:'queue-partner-recovery',reason:'contradictory-record'});
  return !contradictory;});
 const recordsByNode=new Map(records.map(record=>[`queue-partner-recovery:${record.childRunId}`,record])),promotionGroups=new Map<string,QueuePartnerMemoryPromotion[]>();
 for(const promotion of input.promotions){const group=promotionGroups.get(promotion.promotesNodeId)??[];group.push(promotion);promotionGroups.set(promotion.promotesNodeId,group);}
 const promotions=input.promotions.filter(promotion=>{const nodeId=`queue-partner-remedy-verification:${promotion.verificationRunId}`,base=recordsByNode.get(promotion.promotesNodeId),group=promotionGroups.get(promotion.promotesNodeId)!;
  const contradictory=new Set(group.map(item=>acceptanceDigest({sourceRunId:item.sourceRunId,repairRunId:item.repairRunId,candidateId:item.candidateId,repairedHash:item.repairedHash,baseEvidenceDigest:item.baseEvidenceDigest}))).size>1;
  const bound=Boolean(base&&promotion.sourceRunId===base.sourceRunId&&promotion.repairRunId===base.childRunId&&promotion.baseEvidenceDigest===queuePartnerMemoryDigest(base));
  if(contradictory)quarantined.push({nodeId,kind:'queue-partner-remedy-verification',reason:'contradictory-promotion'});
  else if(!bound)quarantined.push({nodeId,kind:'queue-partner-remedy-verification',reason:'unbound-promotion'});
  return !contradictory&&bound;});
 return {records,promotions,controls:input.controls,quarantined};
}
export function parseQueuePartnerMemoryRows(rows:readonly {node_id?:unknown;body:unknown;kind:unknown;edge_valid?:unknown}[]):QueuePartnerMemoryEvidenceSet{
 const records:QueuePartnerMemoryRecord[]=[],promotions:QueuePartnerMemoryPromotion[]=[],controls:QueuePartnerMemoryControl[]=[],quarantined:QueuePartnerMemoryQuarantineIssue[]=[];
 for(const row of rows){const kind=String(row.kind??'');if(row.edge_valid===false){quarantined.push({nodeId:String(row.node_id??'unknown'),kind,reason:'broken-edge'});continue;}
  let body:unknown;try{body=typeof row.body==='string'?JSON.parse(row.body):row.body;}catch{body=null;}
  const parsed=kind==='queue-partner-recovery'?memoryRecord(body):kind==='queue-partner-remedy-verification'?memoryPromotion(body):kind==='queue-partner-memory-control'?memoryControl(body):null;
  if(!parsed){quarantined.push({nodeId:String(row.node_id??'unknown'),kind,reason:'malformed-body'});continue;}
  if(kind==='queue-partner-recovery')records.push(parsed as QueuePartnerMemoryRecord);
  else if(kind==='queue-partner-remedy-verification')promotions.push(parsed as QueuePartnerMemoryPromotion);else controls.push(parsed as QueuePartnerMemoryControl);
 }
 const checked=quarantineQueuePartnerMemoryEvidence({records,promotions,controls});return {...checked,quarantined:[...quarantined,...checked.quarantined]};
}
export function applyQueuePartnerMemoryPromotions(records:QueuePartnerMemoryRecord[],promotions:QueuePartnerMemoryPromotion[]):QueuePartnerMemoryRecord[]{
 const byNode=new Map(promotions.map(p=>[p.promotesNodeId,p]));
 return records.map(record=>{
  const nodeId=`queue-partner-recovery:${record.childRunId}`,promotion=byNode.get(nodeId);
  return promotion&&promotion.sourceRunId===record.sourceRunId&&promotion.repairRunId===record.childRunId
   &&promotion.baseEvidenceDigest===queuePartnerMemoryDigest(record)?{...record,outcome:'verified',recordedAt:promotion.recordedAt,expiresAt:promotion.expiresAt}:record;
 });
}
export function applyQueuePartnerMemoryControls(records:QueuePartnerMemoryRecord[],controls:QueuePartnerMemoryControl[],now=new Date()):QueuePartnerMemoryRecord[]{
 const available=new Set(records.map(r=>`queue-partner-recovery:${r.childRunId}`)),latest=new Map<string,QueuePartnerMemoryControl>();
 for(const control of controls){const prior=latest.get(control.targetNodeId);if(!prior||control.recordedAt>prior.recordedAt)latest.set(control.targetNodeId,control);}
 return records.filter(record=>{if(record.expiresAt&&Date.parse(record.expiresAt)<=now.getTime())return false;
  const control=latest.get(`queue-partner-recovery:${record.childRunId}`),replacement=control?.replacementNodeId;
  return !control||(control.action==='supersede'&&Boolean(replacement)&&!available.has(replacement!));});
}
export function queuePartnerEffectiveness(records:QueuePartnerMemoryRecord[],promotions:QueuePartnerMemoryPromotion[],controls:QueuePartnerMemoryControl[],now=new Date()):QueuePartnerEffectivenessReport{
 const retained=applyQueuePartnerMemoryControls(applyQueuePartnerMemoryPromotions(records,promotions),controls,now),groups=new Map<string,number>();
 for(const record of records){const key=acceptanceDigest({terms:[...words(`${record.task} ${record.blocker}`)].sort(),paths:[...new Set(record.writePaths)].sort()});groups.set(key,(groups.get(key)??0)+1);}
 const repeatFailures=[...groups.values()].reduce((sum,count)=>sum+Math.max(0,count-1),0),verificationTimes=promotions.flatMap(p=>{
  const base=records.find(r=>`queue-partner-recovery:${r.childRunId}`===p.promotesNodeId),start=Date.parse(String(base?.recordedAt??'')),end=Date.parse(p.recordedAt);
  return Number.isFinite(start)&&Number.isFinite(end)&&end>=start?[end-start]:[];});
 return {attempts:records.length,retainedAttempts:retained.length,verifiedRemedies:retained.filter(r=>r.outcome==='verified').length,repeatFailures,
  repeatFailureRate:records.length?repeatFailures/records.length:0,averageTimeToVerifiedMs:verificationTimes.length?Math.round(verificationTimes.reduce((a,b)=>a+b,0)/verificationTimes.length):null,
  duplicateWorkAvoided:null,duplicateAvoidanceCoverage:'unavailable-until-influence-recorded'};
}
export function normalizeQueuePartnerInfluence(runId:string,presented:Array<{childRunId:string;reuseEligible?:boolean}>,declaration:unknown,recordedAt=new Date().toISOString()):QueuePartnerMemoryInfluence[]{
 const allowed=new Map(presented.map(item=>[item.childRunId,item.reuseEligible!==false])),used=Array.isArray((declaration as any)?.used)?(declaration as any).used:[];
 const valid=used.filter((item:any)=>item&&allowed.has(item.childRunId)&&['changed-plan','confirmed-plan','rejected'].includes(item.effect)
  &&(allowed.get(item.childRunId)||item.effect==='rejected')&&typeof item.reason==='string'&&item.reason.trim())
  .slice(0,5).map((item:any)=>({runId,memoryRunId:item.childRunId,effect:item.effect,reason:bounded(item.reason.trim(),500),recordedAt} as QueuePartnerMemoryInfluence));
 if(valid.length)return valid;
 return presented.slice(0,5).map(item=>({runId,memoryRunId:item.childRunId,effect:'not-demonstrated',reason:'The recovery output did not demonstrate that this presented memory changed its plan.',recordedAt}));
}
export async function recordQueuePartnerMemoryInfluence(projectId:string,records:QueuePartnerMemoryInfluence[]):Promise<number>{
 return withClient(async client=>{let inserted=0;for(const record of records){const nodeId=`queue-partner-memory-influence:${record.runId}:${record.memoryRunId}`;
  const result=await client.query(`insert into memory_nodes(project_id,node_id,node_type,title,body,token_estimate,created_at,metadata)
   values($1,$2,'decision','Queue Partner memory influence',$3,$4,$5,$6::jsonb) on conflict(project_id,node_id) do nothing returning node_id`,[projectId,nodeId,JSON.stringify(record),Math.max(1,Math.ceil(JSON.stringify(record).length/4)),record.recordedAt,
   JSON.stringify({schemaVersion:1,memoryKind:'queue-partner-memory-influence',authority:'evidence-only',runId:record.runId,memoryRunId:record.memoryRunId,effect:record.effect})]);inserted+=result.rowCount??0;
  await client.query(`insert into memory_edges(project_id,from_node,to_node,edge_type,cost,created_at) values($1,$2,$3,'relates',0,$4) on conflict(project_id,from_node,to_node,edge_type) do nothing`,[projectId,nodeId,`queue-partner-recovery:${record.memoryRunId}`,record.recordedAt]);}return inserted;});
}
export function rankQueuePartnerMemories(records:QueuePartnerMemoryRecord[],current:{familyId:string;sourceRunId:string;task:string;blocker:string;writePaths:string[]},limit=5):QueuePartnerComparison[]{
 const currentTerms=words(`${current.task} ${current.blocker}`),currentPaths=new Set(current.writePaths);
 const candidates=records.map(record=>{
  const pathOverlap=overlap(record.writePaths,currentPaths);
  let relevance=record.familyId===current.familyId?100:record.sourceRunId===current.sourceRunId?80:0;
  relevance+=pathOverlap*12;
  relevance+=Math.min(30,overlap(words(`${record.task} ${record.blocker} ${record.facts.map(f=>`${f.target} ${f.summary}`).join(' ')}`),currentTerms)*3);
  return {record,pathOverlap,relevance};
 }).filter(candidate=>candidate.relevance>0);
 const durations=candidates.flatMap(({record})=>finiteNonNegative(record.delivery?.durationMs)?[record.delivery.durationMs]:[]),costs=candidates.flatMap(({record})=>
  finiteNonNegative(record.delivery?.costUsd)&&record.delivery!.costCoverageCalls===record.delivery!.providerCalls&&record.delivery!.providerCalls>0?[record.delivery!.costUsd!]:[]);
 const maxDuration=Math.max(1,...durations),maxCost=Math.max(0.000001,...costs);
 return candidates.map(({record,pathOverlap,relevance})=>{
  const reliability=record.outcome==='verified'?24:record.outcome==='completed-unverified'?4:record.outcome==='blocked'?-8:record.outcome==='failed'?-14:record.outcome==='cancelled'?-10:-6;
  const verification=record.outcome==='verified'?18:0;
  const speed=finiteNonNegative(record.delivery?.durationMs)?Math.round(12*(1-record.delivery.durationMs/maxDuration)):0;
  const completeCost=finiteNonNegative(record.delivery?.costUsd)&&record.delivery!.providerCalls>0&&record.delivery!.costCoverageCalls===record.delivery!.providerCalls;
  const cost=completeCost?Math.round(8*(1-record.delivery!.costUsd!/maxCost)):0;
  const score=relevance+reliability+verification+speed+cost;
  const relationship:QueuePartnerComparison['relationship']=record.familyId===current.familyId?'same-family':record.sourceRunId===current.sourceRunId?'same-source':pathOverlap?'overlapping-paths':'similar-symptom';
  const regression=record.outcome==='verified';
  const interpretation:QueuePartnerComparison['interpretation']=regression?'regression-after-verified-remedy':record.outcome==='completed-unverified'?'recurrence-after-unverified-attempt':'related-prior-failure';
  return {...record,score,rankingSignals:{relevance,reliability,verification,speed,cost},evidenceDigest:queuePartnerMemoryDigest(record),authority:'evidence-only' as const,recurrence:true as const,regression,relationship,interpretation};
 }).sort((a,b)=>b.score-a.score||String(b.recordedAt).localeCompare(String(a.recordedAt))).slice(0,Math.max(0,Math.min(limit,10)));
}

export async function recordQueuePartnerMemory(record:QueuePartnerMemoryRecord):Promise<boolean>{
 if(!record.facts.length)return false;
 const recordedAt=record.recordedAt??new Date().toISOString(),retentionDays=record.outcome==='verified'?365:['completed-unverified','uncertain'].includes(record.outcome)?180:90;
 const safe:QueuePartnerMemoryRecord={...record,task:bounded(record.task,1600),blocker:bounded(record.blocker,1600),writePaths:[...new Set(record.writePaths)].slice(0,40),
  facts:record.facts.slice(-20).map(f=>({...f,target:bounded(f.target,300),summary:bounded(f.summary,600)})),recordedAt:record.recordedAt??new Date().toISOString()};
 safe.recordedAt=recordedAt;safe.expiresAt=record.expiresAt??new Date(Date.parse(recordedAt)+retentionDays*86_400_000).toISOString();
 const nodeId=`queue-partner-recovery:${safe.childRunId}`;
 return withClient(async client=>(await client.query(`insert into memory_nodes(project_id,node_id,node_type,title,body,token_estimate,created_at,metadata)
  values($1,$2,'result',$3,$4,$5,$6,$7::jsonb) on conflict(project_id,node_id) do nothing returning node_id`,[
   safe.projectId,nodeId,`Queue Partner recovery: ${safe.outcome}`,JSON.stringify(safe),Math.max(1,Math.ceil(JSON.stringify(safe).length/4)),safe.recordedAt,
   JSON.stringify({schemaVersion:1,memoryKind:'queue-partner-recovery',authority:'evidence-only',familyId:safe.familyId,sourceRunId:safe.sourceRunId,childRunId:safe.childRunId,outcome:safe.outcome,evidenceDigest:queuePartnerMemoryDigest(safe)})
  ])).rowCount===1);
}

/** Promote only from the coordinator's independently attested original-contract proof. */
export async function promoteVerifiedQueuePartnerRemedy(claim:CoordinatorClaim):Promise<boolean>{
 if(claim.role!=='verifier')return false;
 return withClient(async client=>{
  await client.query('begin');
  try{
   const assignment=(await client.query(`select child_run_id::text,state from queue_coordinator_assignments
    where id=$1 and fence=$2::bigint and project_id=$3 and source_run_id=$4 and family_id=$5 and role='verifier' for share`,
    [claim.id,claim.fence,claim.projectId,claim.sourceRunId,claim.familyId])).rows[0];
   if(!assignment||assignment.state!=='verified'||!assignment.child_run_id){await client.query('rollback');return false;}
   const attestationRow=(await client.query(`select id::text,payload,digest from repaired_revision_records
    where source_run_id=$1 and kind='attestation' and payload->>'verificationRunId'=$2 order by created_at desc limit 1`,
    [claim.sourceRunId,assignment.child_run_id])).rows[0];
   if(!attestationRow||acceptanceDigest(attestationRow.payload)!==attestationRow.digest){await client.query('rollback');return false;}
   const candidateRow=(await client.query(`select payload,digest from repaired_revision_records where id=$1 and kind='candidate'`,
    [attestationRow.payload.candidateId])).rows[0];
   if(!candidateRow||acceptanceDigest(candidateRow.payload)!==candidateRow.digest
    ||candidateRow.payload.sourceRunId!==claim.sourceRunId||candidateRow.payload.projectId!==claim.projectId
    ||attestationRow.payload.repairedHash!==candidateRow.payload.repairedHash
    ||!await verifyRepairedRevisionAttestationOnClient(client,claim.sourceRunId,candidateRow.payload.repairedHash)){
    await client.query('rollback');return false;
   }
   const repairRunId=String(candidateRow.payload.repairRunId),promotesNodeId=`queue-partner-recovery:${repairRunId}`;
   const baseRow=(await client.query(`select body from memory_nodes where project_id=$1 and node_id=$2
    and metadata->>'memoryKind'='queue-partner-recovery' for share`,[claim.projectId,promotesNodeId])).rows[0];
   let base:QueuePartnerMemoryRecord|null=null;try{base=memoryRecord(JSON.parse(baseRow?.body));}catch{}
   if(!base||base.projectId!==claim.projectId||base.familyId!==claim.familyId||base.sourceRunId!==claim.sourceRunId
    ||base.childRunId!==repairRunId){await client.query('rollback');return false;}
   const recordedAt=new Date().toISOString(),promotion:QueuePartnerMemoryPromotion={promotesNodeId,sourceRunId:claim.sourceRunId,
    repairRunId,verificationRunId:assignment.child_run_id,candidateId:String(candidateRow.payload.id),
    repairedHash:candidateRow.payload.repairedHash,baseEvidenceDigest:queuePartnerMemoryDigest(base),recordedAt,
    expiresAt:new Date(Date.parse(recordedAt)+365*86_400_000).toISOString()};
   const nodeId=`queue-partner-remedy-verification:${assignment.child_run_id}`;
   const inserted=await client.query(`insert into memory_nodes(project_id,node_id,node_type,title,body,token_estimate,created_at,metadata)
    values($1,$2,'evidence','Queue Partner remedy independently verified',$3,$4,$5,$6::jsonb)
    on conflict(project_id,node_id) do nothing returning node_id`,[claim.projectId,nodeId,JSON.stringify(promotion),
    Math.max(1,Math.ceil(JSON.stringify(promotion).length/4)),recordedAt,JSON.stringify({schemaVersion:1,memoryKind:'queue-partner-remedy-verification',
     authority:'evidence-only',promotesNodeId,sourceRunId:claim.sourceRunId,repairRunId,verificationRunId:assignment.child_run_id,
     candidateId:promotion.candidateId,repairedHash:promotion.repairedHash,baseEvidenceDigest:promotion.baseEvidenceDigest})]);
   await client.query(`insert into memory_edges(project_id,from_node,to_node,edge_type,cost,created_at)
    values($1,$2,$3,'supersedes',0,$4) on conflict(project_id,from_node,to_node,edge_type) do nothing`,
    [claim.projectId,nodeId,promotesNodeId,recordedAt]);
   await client.query('commit');return inserted.rowCount===1;
  }catch(error){await client.query('rollback');throw error;}
 });
}

export async function recordQueuePartnerMemoryControl(input:{projectId:string;targetNodeId:string;action:'revoke'|'supersede';reason:string;replacementNodeId?:string},authority:{owner:string;fencingToken:string}):Promise<boolean>{
 if(!input.reason.trim()||(input.action==='supersede'&&!input.replacementNodeId))return false;
 return withClient(async client=>{await client.query('begin');try{
  const intent=(await client.query(`select 1 from work_intents where project_id::text=$1 and owner=$2 and fencing_token::text=$3
   and expires_at>clock_timestamp() and file_scopes @> $4::jsonb`,[input.projectId,authority.owner,authority.fencingToken,JSON.stringify(['runtime/queue-partner/memory'])])).rowCount===1;
  if(!intent){await client.query('rollback');return false;}
  const targets=[input.targetNodeId,...(input.replacementNodeId?[input.replacementNodeId]:[])];
  if((await client.query(`select count(*)::int n from memory_nodes where project_id=$1 and node_id=any($2::text[])`,[input.projectId,targets])).rows[0].n!==targets.length){await client.query('rollback');return false;}
  const recordedAt=new Date().toISOString(),control:QueuePartnerMemoryControl={targetNodeId:input.targetNodeId,action:input.action,
   reason:bounded(input.reason.trim(),600),recordedAt,...(input.replacementNodeId?{replacementNodeId:input.replacementNodeId}:{})};
  const nodeId=`queue-partner-memory-${input.action}:${acceptanceDigest(control)}`;
  const inserted=await client.query(`insert into memory_nodes(project_id,node_id,node_type,title,body,token_estimate,created_at,metadata)
   values($1,$2,'decision',$3,$4,$5,$6,$7::jsonb) on conflict(project_id,node_id) do nothing returning node_id`,[input.projectId,nodeId,
   `Queue Partner memory ${input.action}`,JSON.stringify(control),Math.max(1,Math.ceil(JSON.stringify(control).length/4)),recordedAt,
   JSON.stringify({schemaVersion:1,memoryKind:'queue-partner-memory-control',authority:'governed-maintenance',targetNodeId:input.targetNodeId,action:input.action})]);
  await client.query(`insert into memory_edges(project_id,from_node,to_node,edge_type,cost,created_at) values($1,$2,$3,$4,0,$5)
   on conflict(project_id,from_node,to_node,edge_type) do nothing`,[input.projectId,nodeId,input.targetNodeId,input.action==='supersede'?'supersedes':'relates',recordedAt]);
  await client.query('commit');return inserted.rowCount===1;
 }catch(error){await client.query('rollback');throw error;}});
}

export async function loadQueuePartnerComparisons(projectId:string,current:{familyId:string;sourceRunId:string;task:string;blocker:string;writePaths:string[]},limit=5):Promise<QueuePartnerComparison[]>{
 const {records,promotions,controls}=await withClient(async client=>{
  const rows=(await client.query(`select n.node_id,n.body,n.metadata->>'memoryKind' kind,
   case when n.metadata->>'memoryKind'='queue-partner-remedy-verification' then exists(select 1 from memory_edges e where e.project_id=n.project_id and e.from_node=n.node_id and e.to_node=n.metadata->>'promotesNodeId' and e.edge_type='supersedes')
    when n.metadata->>'memoryKind'='queue-partner-memory-control' then exists(select 1 from memory_edges e where e.project_id=n.project_id and e.from_node=n.node_id and e.to_node=n.metadata->>'targetNodeId' and e.edge_type=case when n.metadata->>'action'='supersede' then 'supersedes' else 'relates' end)
    else true end edge_valid from memory_nodes n where n.project_id=$1
   and (n.metadata->>'memoryKind'='queue-partner-recovery' or n.metadata->>'memoryKind'='queue-partner-memory-control' or (n.metadata->>'memoryKind'='queue-partner-remedy-verification'
    and exists(select 1 from memory_edges e where e.project_id=n.project_id and e.from_node=n.node_id
     and e.to_node=n.metadata->>'promotesNodeId' and e.edge_type='supersedes')))
   order by n.created_at desc limit 400`,[projectId])).rows;
  return parseQueuePartnerMemoryRows(rows);
 });
 return rankQueuePartnerMemories(applyQueuePartnerMemoryControls(applyQueuePartnerMemoryPromotions(records,promotions),controls),current,limit);
}

export async function loadQueuePartnerEffectiveness(projectId:string):Promise<QueuePartnerEffectivenessReport>{
 const rows=await withClient(async client=>(await client.query(`select n.node_id,n.body,n.metadata->>'memoryKind' kind,
  case when n.metadata->>'memoryKind'='queue-partner-remedy-verification' then exists(select 1 from memory_edges e where e.project_id=n.project_id and e.from_node=n.node_id and e.to_node=n.metadata->>'promotesNodeId' and e.edge_type='supersedes')
   when n.metadata->>'memoryKind'='queue-partner-memory-control' then exists(select 1 from memory_edges e where e.project_id=n.project_id and e.from_node=n.node_id and e.to_node=n.metadata->>'targetNodeId' and e.edge_type=case when n.metadata->>'action'='supersede' then 'supersedes' else 'relates' end)
   else true end edge_valid from memory_nodes n where n.project_id=$1
  and n.metadata->>'memoryKind' in ('queue-partner-recovery','queue-partner-remedy-verification','queue-partner-memory-control') order by n.created_at desc limit 1000`,[projectId])).rows);
 const {records,promotions,controls}=parseQueuePartnerMemoryRows(rows);
 return queuePartnerEffectiveness(records,promotions,controls);
}

/** Bounded display projection. Memory remains evidence only and never grants execution authority. */
export async function loadQueuePartnerHistoryForRuns(runIds:string[]):Promise<Record<string,QueuePartnerHistorySummary>>{
 const ids=[...new Set(runIds.filter(id=>/^[a-f0-9-]{36}$/iu.test(id)))].slice(0,100);if(!ids.length)return {};
 return withClient(async client=>{
  const runs=(await client.query(`select id::text,project_id::text,run_set_id::text from workflow_runs where id=any($1::uuid[])`,[ids])).rows;
  const projects=[...new Set(runs.map(r=>r.project_id))];if(!projects.length)return {};
  const rows=(await client.query(`select n.node_id,n.body,n.project_id,n.metadata->>'memoryKind' kind,
   case when n.metadata->>'memoryKind'='queue-partner-remedy-verification' then exists(select 1 from memory_edges e where e.project_id=n.project_id and e.from_node=n.node_id and e.to_node=n.metadata->>'promotesNodeId' and e.edge_type='supersedes')
    when n.metadata->>'memoryKind'='queue-partner-memory-control' then exists(select 1 from memory_edges e where e.project_id=n.project_id and e.from_node=n.node_id and e.to_node=n.metadata->>'targetNodeId' and e.edge_type=case when n.metadata->>'action'='supersede' then 'supersedes' else 'relates' end)
    else true end edge_valid from memory_nodes n where n.project_id=any($1::text[])
   and metadata->>'memoryKind' in ('queue-partner-recovery','queue-partner-remedy-verification','queue-partner-memory-control','queue-partner-memory-influence') order by created_at desc limit 2000`,[projects])).rows;
  const {records:allRecords,promotions,controls}=parseQueuePartnerMemoryRows(rows.filter(r=>r.kind!=='queue-partner-memory-influence'));
  const influences=rows.filter(r=>r.kind==='queue-partner-memory-influence').flatMap(row=>{try{const value=JSON.parse(row.body) as QueuePartnerMemoryInfluence;return value&&typeof value.runId==='string'&&typeof value.memoryRunId==='string'?[value]:[];}catch{return [];}});
  return Object.fromEntries(runs.map(run=>{const familyId=`${run.project_id}:${run.run_set_id}`,records=allRecords.filter(record=>record.projectId===run.project_id&&(record.sourceRunId===run.id||record.familyId===familyId));
   const retained=applyQueuePartnerMemoryControls(applyQueuePartnerMemoryPromotions(records,promotions),controls).sort((a,b)=>String(b.recordedAt).localeCompare(String(a.recordedAt))).slice(0,3);
   return [run.id,{attempts:records.length,verified:retained.filter(record=>record.outcome==='verified').length,items:retained.map(record=>({runId:record.childRunId,outcome:record.outcome,
    recordedAt:String(record.recordedAt??''),proof:record.outcome==='verified'?'independently-verified':record.outcome==='completed-unverified'?'unverified-attempt':'unsuccessful-attempt',
    ...(finiteNonNegative(record.delivery?.durationMs)?{durationMs:record.delivery.durationMs}:{}),
    ...(finiteNonNegative(record.delivery?.costUsd)&&record.delivery!.providerCalls===record.delivery!.costCoverageCalls?{costUsd:record.delivery.costUsd}:{}),
    ...(record.delivery?.bottleneck&&finiteNonNegative(record.delivery.phaseMs?.[record.delivery.bottleneck])
      ?{bottleneck:record.delivery.bottleneck,bottleneckMs:record.delivery.phaseMs![record.delivery.bottleneck]}:{}),
    ...(()=>{const influence=influences.find(value=>value.runId===run.id&&value.memoryRunId===record.childRunId);return influence?{influence:{effect:influence.effect,reason:influence.reason}}:{}})()}))} satisfies QueuePartnerHistorySummary];}));
 });
}
