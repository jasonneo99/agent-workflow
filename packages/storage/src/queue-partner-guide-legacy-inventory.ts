import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { withClient } from './client.js';
import { parseGuidePolicyTransitionHistory } from './queue-partner-guide-policy.js';
import { validateQueuePartnerExperimentExposure } from './queue-partner-experiments.js';

export interface LegacyGuideEvidenceRow {
  receiptId?: string;
  projectId: string;
  runId: string;
  actionType: 'guide_policy_transition' | 'queue_partner_experiment_exposure';
  taskClass: string | null;
  metadata: unknown;
  receiptHash: string | null;
  receiptAuthentic: boolean;
  createdAt: string;
}

type GuideEvidencePosition={createdAt:string;receiptId:string};
type GuideEvidenceCursorPayload={schemaVersion:1;projectId:string;snapshot:GuideEvidencePosition;after:GuideEvidencePosition;pageStartAfter:GuideEvidencePosition|null;pageDigest:string;checkpointHash:string;pageIndex:number};
type GuideMode='canary'|'promoted'|'rolled-back';
type BloomHex=string;
export interface GuideEvidenceTaskReduction {transitionCount:number;compatibleTransitions:number;quarantinedTransitions:number;lastTransitionDigest:string|null;evidenceModes:Record<GuideMode,BloomHex>;exposureCount:number;compatibleExposures:number;quarantinedExposures:number;reasons:string[]}
export interface GuideEvidenceReductionState {schemaVersion:1;projectId:string;snapshot:GuideEvidencePosition|null;pageIndex:number;checkpointHash:string|null;end:GuideEvidencePosition|null;scanned:number;compatible:number;quarantined:number;taskClasses:Record<string,GuideEvidenceTaskReduction>;complete:boolean;authority:'reduction-observation-only';executionAcceptance:'unverified'}
export interface GuideEvidenceCoverageManifest {schemaVersion:1;projectId:string;snapshot:GuideEvidencePosition|null;pages:number;receipts:number;checkpointHash:string;taskClasses:Array<{taskClass:string;transitions:{total:number;compatible:number;quarantined:number};exposures:{total:number;compatible:number;quarantined:number};reasons:string[]}>;compatible:number;quarantined:number;conclusion:'compatible'|'quarantined'|'no-evidence';complete:true;authority:'integrity-conclusion-only';executionAcceptance:'unverified';grants:{repair:false;replay:false;approval:false;acceptance:false};manifestSignature:{scheme:'sha256-checkpoint-binding-v1';value:string}}
export interface GuideEvidenceReductionCheckpoint {schemaVersion:1;projectId:string;issuedAt:string;expiresAt:string;cursor:string;state:GuideEvidenceReductionState;authority:'resume-only';executionAcceptance:'unverified';grants:{repair:false;replay:false;approval:false;promotion:false;acceptance:false}}
export type GuideEvidenceReductionCompleteResult = {complete:true;state:GuideEvidenceReductionState;manifest:GuideEvidenceCoverageManifest;checkpoint:null};
export type GuideEvidenceReductionResult = GuideEvidenceReductionCompleteResult|{complete:false;state:GuideEvidenceReductionState;manifest:null;checkpoint:string;expiresAt:string;progress:{pages:number;receipts:number;compatible:number;quarantined:number;checkpointHash:string};authority:'resume-only';executionAcceptance:'unverified';grants:{repair:false;replay:false;approval:false;promotion:false;acceptance:false}};
export type GuideEvidenceReductionOptions={checkpoint?:string;signingKey?:string|Buffer;maxPages?:number;checkpointTtlMs?:number;now?:Date};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const cursorChecksum=(payload:GuideEvidenceCursorPayload)=>hash(JSON.stringify(payload));
export function encodeLegacyGuideEvidenceCursor(payload:GuideEvidenceCursorPayload):string{
 const envelope={payload,checksum:cursorChecksum(payload)};
 return Buffer.from(JSON.stringify(envelope),'utf8').toString('base64url');
}
export function decodeLegacyGuideEvidenceCursor(value:string,projectId:string):GuideEvidenceCursorPayload{
 let parsed:unknown;try{parsed=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw Error('Guide evidence cursor is malformed');}
 const envelope=parsed as {payload?:GuideEvidenceCursorPayload;checksum?:string},payload=envelope.payload;
 if(!payload||payload.schemaVersion!==1||payload.projectId!==projectId||!payload.snapshot?.createdAt||!payload.snapshot?.receiptId||!payload.after?.createdAt||!payload.after?.receiptId||typeof payload.pageDigest!=='string'||typeof payload.checkpointHash!=='string'||!Number.isInteger(payload.pageIndex)||envelope.checksum!==cursorChecksum(payload))throw Error('Guide evidence cursor failed immutable checkpoint validation');
 return payload;
}
const noReductionGrants={repair:false as const,replay:false as const,approval:false as const,promotion:false as const,acceptance:false as const};
const validHex=(value:unknown,length:number)=>typeof value==='string'&&new RegExp(`^[a-f0-9]{${length}}$`,'u').test(value);
const validPosition=(value:unknown):value is GuideEvidencePosition=>Boolean(value&&typeof value==='object'&&typeof (value as GuideEvidencePosition).createdAt==='string'&&typeof (value as GuideEvidencePosition).receiptId==='string');
const validNonNegativeInteger=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
function validateReductionState(value:unknown,projectId:string):GuideEvidenceReductionState{
 const state=value as GuideEvidenceReductionState;
 if(!state||state.schemaVersion!==1||state.projectId!==projectId||state.complete||state.authority!=='reduction-observation-only'||state.executionAcceptance!=='unverified'||!validNonNegativeInteger(state.pageIndex)||!validNonNegativeInteger(state.scanned)||!validNonNegativeInteger(state.compatible)||!validNonNegativeInteger(state.quarantined)||state.compatible+state.quarantined!==state.scanned||!validHex(state.checkpointHash,64)||!validPosition(state.snapshot)||!validPosition(state.end)||!state.taskClasses||typeof state.taskClasses!=='object'||Array.isArray(state.taskClasses))throw Error('Guide evidence reduction checkpoint state is invalid');
 const entries=Object.entries(state.taskClasses);if(entries.length>512)throw Error('Guide evidence reduction checkpoint exceeds the bounded task-class limit');
 for(const [taskClass,task] of entries){
  if(!taskClass||taskClass.length>240||!task||!validNonNegativeInteger(task.transitionCount)||!validNonNegativeInteger(task.compatibleTransitions)||!validNonNegativeInteger(task.quarantinedTransitions)||task.compatibleTransitions+task.quarantinedTransitions!==task.transitionCount||!validNonNegativeInteger(task.exposureCount)||!validNonNegativeInteger(task.compatibleExposures)||!validNonNegativeInteger(task.quarantinedExposures)||task.compatibleExposures+task.quarantinedExposures!==task.exposureCount||!(task.lastTransitionDigest===null||validHex(task.lastTransitionDigest,64))||!Array.isArray(task.reasons)||task.reasons.length>8||task.reasons.some(reason=>typeof reason!=='string'||reason.length>160)||!task.evidenceModes||!(['canary','promoted','rolled-back'] as const).every(mode=>validHex(task.evidenceModes[mode],bloomBytes*2)))throw Error('Guide evidence reduction checkpoint task state is invalid');
 }
 return state;
}
const checkpointSecret=(secret:string|Buffer)=>{const bytes=Buffer.isBuffer(secret)?secret:Buffer.from(secret,'utf8');if(bytes.length<32)throw Error('Guide evidence reduction checkpoint signing key must be at least 32 bytes');return bytes;};
export function encodeGuideEvidenceReductionCheckpoint(payload:GuideEvidenceReductionCheckpoint,secret:string|Buffer):string{
 validateReductionState(payload.state,payload.projectId);const cursor=decodeLegacyGuideEvidenceCursor(payload.cursor,payload.projectId),issued=Date.parse(payload.issuedAt),expires=Date.parse(payload.expiresAt);
 if(payload.schemaVersion!==1||payload.authority!=='resume-only'||payload.executionAcceptance!=='unverified'||JSON.stringify(payload.grants)!==JSON.stringify(noReductionGrants)||!Number.isFinite(issued)||!Number.isFinite(expires)||expires<=issued||expires-issued>3_600_000||cursor.pageIndex!==payload.state.pageIndex||cursor.checkpointHash!==payload.state.checkpointHash||!samePosition(cursor.snapshot,payload.state.snapshot)||!samePosition(cursor.after,payload.state.end))throw Error('Guide evidence reduction checkpoint binding is invalid');
 const compressed=deflateRawSync(Buffer.from(JSON.stringify(payload),'utf8'),{level:9}).toString('base64url'),signature=createHmac('sha256',checkpointSecret(secret)).update(compressed).digest('hex');return `${compressed}.${signature}`;
}
export function decodeGuideEvidenceReductionCheckpoint(value:string,projectId:string,secret:string|Buffer,now=new Date()):GuideEvidenceReductionCheckpoint{
 const [compressed,signature,...extra]=value.split('.');if(!compressed||!signature||extra.length||!validHex(signature,64))throw Error('Guide evidence reduction checkpoint is malformed');
 const expected=createHmac('sha256',checkpointSecret(secret)).update(compressed).digest('hex'),provided=Buffer.from(signature,'hex'),expectedBytes=Buffer.from(expected,'hex');if(provided.length!==expectedBytes.length||!timingSafeEqual(provided,expectedBytes))throw Error('Guide evidence reduction checkpoint authentication failed');
 let payload:GuideEvidenceReductionCheckpoint;try{payload=JSON.parse(inflateRawSync(Buffer.from(compressed,'base64url'),{maxOutputLength:2_000_000}).toString('utf8')) as GuideEvidenceReductionCheckpoint;}catch{throw Error('Guide evidence reduction checkpoint payload is invalid');}
 const state=validateReductionState(payload.state,projectId),cursor=decodeLegacyGuideEvidenceCursor(payload.cursor,projectId),issued=Date.parse(payload.issuedAt),expires=Date.parse(payload.expiresAt),current=now.getTime();
 if(payload.schemaVersion!==1||payload.projectId!==projectId||payload.authority!=='resume-only'||payload.executionAcceptance!=='unverified'||JSON.stringify(payload.grants)!==JSON.stringify(noReductionGrants)||!Number.isFinite(issued)||!Number.isFinite(expires)||expires<=issued||expires-issued>3_600_000||issued>current+300_000||expires<=current||cursor.pageIndex!==state.pageIndex||cursor.checkpointHash!==state.checkpointHash||!samePosition(cursor.snapshot,state.snapshot)||!samePosition(cursor.after,state.end))throw Error(expires<=current?'Guide evidence reduction checkpoint expired':'Guide evidence reduction checkpoint binding is invalid');
 return payload;
}
const pageDigest=(rows:readonly LegacyGuideEvidenceRow[])=>hash(JSON.stringify(rows.map(row=>[row.receiptId,row.projectId,row.runId,row.actionType,row.createdAt,row.receiptHash])));

const bloomBytes=256;
const emptyBloom=()=>Buffer.alloc(bloomBytes).toString('hex');
const bloomPositions=(value:string)=>{const bytes=createHash('sha256').update(value).digest();return [0,2,4,6].map(offset=>bytes.readUInt16BE(offset)%(bloomBytes*8));};
const bloomHas=(hex:BloomHex,value:string)=>{const bytes=Buffer.from(hex,'hex');return bloomPositions(value).every(position=>(bytes[Math.floor(position/8)]!&(1<<(position%8)))!==0);};
const bloomAdd=(hex:BloomHex,value:string)=>{const bytes=Buffer.from(hex,'hex');for(const position of bloomPositions(value)){const index=Math.floor(position/8);bytes[index]=(bytes[index]??0)|(1<<(position%8));}return bytes.toString('hex');};
const taskReduction=():GuideEvidenceTaskReduction=>({transitionCount:0,compatibleTransitions:0,quarantinedTransitions:0,lastTransitionDigest:null,evidenceModes:{canary:emptyBloom(),promoted:emptyBloom(),'rolled-back':emptyBloom()},exposureCount:0,compatibleExposures:0,quarantinedExposures:0,reasons:[]});
const addReason=(state:GuideEvidenceTaskReduction,reason:string)=>{if(!state.reasons.includes(reason)&&state.reasons.length<8)state.reasons.push(reason);};
const parseMetadata=(value:unknown):Record<string,any>|null=>{if(typeof value==='string'){try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'?parsed:null;}catch{return null;}}return value&&typeof value==='object'?value as Record<string,any>:null;};
const transitionCoreForReduction=(value:Record<string,any>)=>({schemaVersion:value.schemaVersion,projectId:value.projectId,sourceRunId:value.sourceRunId,taskClass:value.taskClass,priorMode:value.priorMode,nextMode:value.nextMode,evidenceDigest:value.evidenceDigest,previousTransitionDigest:value.previousTransitionDigest,sampleWindow:{guided:value.sampleWindow?.guided,unguided:value.sampleWindow?.unguided},confidence:{guided:{lower:value.confidence?.guided?.lower,upper:value.confidence?.guided?.upper},unguided:{lower:value.confidence?.unguided?.lower,upper:value.confidence?.unguided?.upper}},durationMs:{guided:value.durationMs?.guided,unguided:value.durationMs?.unguided},recordedAt:value.recordedAt,authority:value.authority});
const samePosition=(left:GuideEvidencePosition|null,right:GuideEvidencePosition|null)=>left?.createdAt===right?.createdAt&&left?.receiptId===right?.receiptId;

export function createGuideEvidenceReduction(projectId:string):GuideEvidenceReductionState{return {schemaVersion:1,projectId,snapshot:null,pageIndex:0,checkpointHash:null,end:null,scanned:0,compatible:0,quarantined:0,taskClasses:{},complete:false,authority:'reduction-observation-only',executionAcceptance:'unverified'};}

/** Reduces one independently verified page. Partial state is deliberately non-authoritative. */
export function reduceLegacyGuideEvidencePage(state:GuideEvidenceReductionState,page:{projectId:string;pageIndex:number;items:LegacyGuideEvidenceRow[];coverage:{startAfter:GuideEvidencePosition|null;end:GuideEvidencePosition|null;snapshot:GuideEvidencePosition|null;pageDigest:string;checkpointHash:string};complete:boolean}){
 if(state.complete)throw Error('Guide evidence reduction is already complete');
 const emptySnapshot=page.pageIndex===0&&page.complete&&page.items.length===0&&page.coverage.snapshot===null;
 if(page.projectId!==state.projectId||(!emptySnapshot&&page.pageIndex!==state.pageIndex+1))throw Error('Guide evidence reduction page is unbound or out of sequence');
 if(state.snapshot&&!samePosition(state.snapshot,page.coverage.snapshot))throw Error('Guide evidence reduction snapshot changed');
 if(!samePosition(state.end,page.coverage.startAfter))throw Error('Guide evidence reduction coverage is not contiguous');
 const digestValue=pageDigest(page.items),expectedCheckpoint=emptySnapshot?hash('GENESIS:[]'):hash(`${state.checkpointHash??'GENESIS'}:${digestValue}`);
 if(digestValue!==page.coverage.pageDigest||expectedCheckpoint!==page.coverage.checkpointHash)throw Error('Guide evidence reduction checkpoint failed verification');
 const next:GuideEvidenceReductionState=structuredClone(state);next.snapshot=page.coverage.snapshot;next.pageIndex=page.pageIndex;next.checkpointHash=page.coverage.checkpointHash;next.end=page.coverage.end;next.complete=page.complete;
 for(const row of page.items){next.scanned+=1;const metadata=parseMetadata(row.metadata),taskClass=String(row.taskClass??metadata?.taskClass??metadata?.design??'unknown'),task=next.taskClasses[taskClass]??=taskReduction(),exposure=row.actionType==='queue_partner_experiment_exposure';let valid=false,reason='';
  if(exposure)task.exposureCount+=1;else task.transitionCount+=1;
  if(row.projectId!==state.projectId)reason='unbound-project';else if(!row.receiptAuthentic)reason='inauthentic-receipt';else if(exposure){valid=Boolean(validateQueuePartnerExperimentExposure(row.metadata,row.runId,row.projectId));if(!valid)reason='invalid-exposure-contract';}
  else{const mode=metadata?.nextMode as GuideMode,evidenceDigest=metadata?.evidenceDigest,transitionDigest=metadata?.transitionDigest;
   if(!metadata||metadata.schemaVersion!==1)reason='malformed-transition';else if(metadata.projectId!==state.projectId||metadata.taskClass!==taskClass)reason='unbound-transition';else if(metadata.previousTransitionDigest!==task.lastTransitionDigest)reason='stale-transition-chain';else if(!['canary','promoted','rolled-back'].includes(mode)||typeof evidenceDigest!=='string'||!/^[a-f0-9]{64}$/u.test(transitionDigest??'')||hash(JSON.stringify(transitionCoreForReduction(metadata)))!==transitionDigest)reason='invalid-transition-digest';else if((Object.keys(task.evidenceModes) as GuideMode[]).some(other=>other!==mode&&bloomHas(task.evidenceModes[other],evidenceDigest)))reason='contradictory-evidence-decision';else{valid=true;task.lastTransitionDigest=transitionDigest;task.evidenceModes[mode]=bloomAdd(task.evidenceModes[mode],evidenceDigest);task.compatibleTransitions+=1;}
  }
  if(exposure){if(valid)task.compatibleExposures+=1;else task.quarantinedExposures+=1;}else if(!valid)task.quarantinedTransitions+=1;
  if(valid)next.compatible+=1;else{next.quarantined+=1;addReason(task,reason||'invalid-evidence');}
 }
 return next;
}

export function finalizeGuideEvidenceReduction(state:GuideEvidenceReductionState):GuideEvidenceCoverageManifest{
 if(!state.complete||!state.checkpointHash)throw Error('Guide evidence reduction cannot conclude before full snapshot coverage');
 const core=({schemaVersion:1 as const,projectId:state.projectId,snapshot:state.snapshot,pages:state.pageIndex,receipts:state.scanned,checkpointHash:state.checkpointHash,taskClasses:Object.entries(state.taskClasses).sort(([left],[right])=>left.localeCompare(right)).map(([taskClass,value])=>({taskClass,transitions:{total:value.transitionCount,compatible:value.compatibleTransitions,quarantined:value.quarantinedTransitions},exposures:{total:value.exposureCount,compatible:value.compatibleExposures,quarantined:value.quarantinedExposures},reasons:[...value.reasons]})),compatible:state.compatible,quarantined:state.quarantined,conclusion:(state.scanned===0?'no-evidence':state.quarantined?'quarantined':'compatible') as GuideEvidenceCoverageManifest['conclusion'],complete:true as const,authority:'integrity-conclusion-only' as const,executionAcceptance:'unverified' as const,grants:{repair:false as const,replay:false as const,approval:false as const,acceptance:false as const}});
 return {...core,manifestSignature:{scheme:'sha256-checkpoint-binding-v1',value:hash(JSON.stringify(core))}};
}

export function summarizeLegacyGuideEvidence(rows: readonly LegacyGuideEvidenceRow[], truncated = false) {
  const findings: Array<{ projectId: string; runId: string | null; taskClass: string; kind: 'policy-transition' | 'experiment-exposure'; status: 'legacy-compatible' | 'quarantined'; reason: string; reconciliation: string }> = [];
  const policyGroups = new Map<string, LegacyGuideEvidenceRow[]>();
  for (const row of rows) {
    if (row.actionType === 'guide_policy_transition') {
      const key = `${row.projectId}\u0000${row.taskClass ?? 'unknown'}`;
      policyGroups.set(key, [...(policyGroups.get(key) ?? []), row]);
      continue;
    }
    const valid = row.receiptAuthentic && Boolean(validateQueuePartnerExperimentExposure(row.metadata, row.runId, row.projectId));
    findings.push({
      projectId: row.projectId, runId: row.runId, taskClass: row.taskClass ?? 'factorial', kind: 'experiment-exposure',
      status: valid ? 'legacy-compatible' : 'quarantined',
      reason: valid ? 'schema-v1 digest and receipt binding match the known original contract' : row.receiptAuthentic ? 'invalid exposure digest or semantic contract' : 'inauthentic receipt chain binding',
      reconciliation: valid ? 'No replacement is required; retain the original immutable receipt.' : 'Require explicit audit-only reconciliation linked to this receipt; do not rewrite or infer acceptance.',
    });
  }
  for (const [key, group] of policyGroups) {
    const [projectId, taskClass] = key.split('\u0000');
    const metadata = group.at(-1)?.metadata as { evidenceDigest?: unknown } | undefined;
    const currentEvidenceDigest = typeof metadata?.evidenceDigest === 'string' ? metadata.evidenceDigest : '';
    const parsed = parseGuidePolicyTransitionHistory(group.map(row => ({ metadata: row.metadata, createdAt: row.createdAt, receiptAuthentic: row.receiptAuthentic })), projectId!, taskClass!, currentEvidenceDigest);
    const invalid = parsed.history.filter(item => item.status === 'quarantined');
    findings.push({
      projectId: projectId!, runId: null, taskClass: taskClass!, kind: 'policy-transition',
      status: invalid.length ? 'quarantined' : 'legacy-compatible',
      reason: invalid.length ? `${invalid.length} transition(s) failed: ${[...new Set(invalid.map(item => item.reason ?? 'unknown'))].join(', ')}` : `${group.length} schema-v1 transition(s) match the known original ordered digest chain`,
      reconciliation: invalid.length ? 'Require explicit audit-only reconciliation linked to the first invalid transition; do not rewrite policy history.' : 'No replacement is required; retain the original immutable transition chain.',
    });
  }
  findings.sort((left, right) => Number(right.status === 'quarantined') - Number(left.status === 'quarantined') || left.projectId.localeCompare(right.projectId) || left.taskClass.localeCompare(right.taskClass));
  return {
    schemaVersion: 1,
    readOnly: true,
    authority: 'inventory-only' as const,
    scanned: rows.length,
    truncated,
    legacyCompatible: findings.filter(item => item.status === 'legacy-compatible').length,
    quarantined: findings.filter(item => item.status === 'quarantined').length,
    affectedProjects: [...new Set(findings.map(item => item.projectId))].length,
    findings,
    executionAcceptance: 'unverified' as const,
  };
}

export async function legacyGuideEvidenceInventory(projectId?: string) {
  return withClient(async client => {
    const rows = (await client.query(`select r.project_id::text "projectId",a.run_id::text "runId",a.action_type "actionType",
      nullif(coalesce(a.metadata->>'taskClass',a.metadata->>'design'),'') "taskClass",a.metadata,a.receipt_hash "receiptHash",a.created_at::text "createdAt",
      a.receipt_hash is not null and a.receipt_hash ~ '^[a-f0-9]{64}$' and (a.prev_hash='GENESIS' or exists(select 1 from action_receipts p where p.run_id=a.run_id and p.receipt_hash=a.prev_hash)) "receiptAuthentic"
      from action_receipts a join workflow_runs r on r.id=a.run_id
      where a.action_type=any($1::text[]) and ($2::uuid is null or r.project_id=$2::uuid)
      order by r.project_id,a.action_type,coalesce(a.metadata->>'taskClass',a.metadata->>'design'),a.created_at,a.id limit 501`, [['guide_policy_transition', 'queue_partner_experiment_exposure'], projectId ?? null])).rows as LegacyGuideEvidenceRow[];
    return summarizeLegacyGuideEvidence(rows.slice(0, 500), rows.length > 500);
  });
}

/** Pages immutable source receipts. Integrity conclusions remain deferred until all pages are assembled. */
export async function legacyGuideEvidenceInventoryPage(projectId:string,options:{cursor?:string;pageSize?:number}={}){
 const pageSize=Math.min(Math.max(Math.trunc(options.pageSize??100),1),200);
 return withClient(async client=>{
  const cursor=options.cursor?decodeLegacyGuideEvidenceCursor(options.cursor,projectId):null;
  const latest=cursor?.snapshot??(await client.query(`select a.created_at::text "createdAt",a.id::text "receiptId" from action_receipts a join workflow_runs r on r.id=a.run_id
   where r.project_id=$1::uuid and a.action_type=any($2::text[]) order by a.created_at desc,a.id desc limit 1`,[projectId,['guide_policy_transition','queue_partner_experiment_exposure']])).rows[0] as GuideEvidencePosition|undefined;
  if(!latest)return {schemaVersion:1,readOnly:true,authority:'inventory-only' as const,projectId,pageSize,pageIndex:0,items:[] as LegacyGuideEvidenceRow[],coverage:{startAfter:null,end:null,snapshot:null,pageDigest:hash('[]'),checkpointHash:hash('GENESIS:[]')},nextCursor:null,complete:true,integrityConclusion:'no-evidence' as const,executionAcceptance:'unverified' as const};
  if(cursor){
   const prior=(await client.query(`select a.id::text "receiptId",r.project_id::text "projectId",a.run_id::text "runId",a.action_type "actionType",nullif(coalesce(a.metadata->>'taskClass',a.metadata->>'design'),'') "taskClass",a.metadata,a.receipt_hash "receiptHash",a.created_at::text "createdAt",
    a.receipt_hash is not null and a.receipt_hash ~ '^[a-f0-9]{64}$' and (a.prev_hash='GENESIS' or exists(select 1 from action_receipts p where p.run_id=a.run_id and p.receipt_hash=a.prev_hash)) "receiptAuthentic"
    from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid and a.action_type=any($2::text[])
    and ($3::timestamptz is null or (a.created_at,a.id)>($3::timestamptz,$4::uuid)) and (a.created_at,a.id)<=($5::timestamptz,$6::uuid) order by a.created_at,a.id`,[projectId,['guide_policy_transition','queue_partner_experiment_exposure'],cursor.pageStartAfter?.createdAt??null,cursor.pageStartAfter?.receiptId??null,cursor.after.createdAt,cursor.after.receiptId])).rows as LegacyGuideEvidenceRow[];
   if(pageDigest(prior)!==cursor.pageDigest)throw Error('Guide evidence changed after the previous page; discard the cursor and restart the read-only scan');
  }
  const startAfter=cursor?.after??null;
  const rows=(await client.query(`select a.id::text "receiptId",r.project_id::text "projectId",a.run_id::text "runId",a.action_type "actionType",nullif(coalesce(a.metadata->>'taskClass',a.metadata->>'design'),'') "taskClass",a.metadata,a.receipt_hash "receiptHash",a.created_at::text "createdAt",
   a.receipt_hash is not null and a.receipt_hash ~ '^[a-f0-9]{64}$' and (a.prev_hash='GENESIS' or exists(select 1 from action_receipts p where p.run_id=a.run_id and p.receipt_hash=a.prev_hash)) "receiptAuthentic"
   from action_receipts a join workflow_runs r on r.id=a.run_id where r.project_id=$1::uuid and a.action_type=any($2::text[])
   and ($3::timestamptz is null or (a.created_at,a.id)>($3::timestamptz,$4::uuid)) and (a.created_at,a.id)<=($5::timestamptz,$6::uuid)
   order by a.created_at,a.id limit $7`,[projectId,['guide_policy_transition','queue_partner_experiment_exposure'],startAfter?.createdAt??null,startAfter?.receiptId??null,latest.createdAt,latest.receiptId,pageSize+1])).rows as LegacyGuideEvidenceRow[];
  const items=rows.slice(0,pageSize),hasMore=rows.length>pageSize,end=items.length?{createdAt:items.at(-1)!.createdAt,receiptId:items.at(-1)!.receiptId!}:startAfter;
  const digestValue=pageDigest(items),checkpointHash=hash(`${cursor?.checkpointHash??'GENESIS'}:${digestValue}`),pageIndex=(cursor?.pageIndex??0)+1;
  const nextCursor=hasMore&&end?encodeLegacyGuideEvidenceCursor({schemaVersion:1,projectId,snapshot:latest,after:end,pageStartAfter:startAfter,pageDigest:digestValue,checkpointHash,pageIndex}):null;
  return {schemaVersion:1,readOnly:true,authority:'inventory-only' as const,projectId,pageSize,pageIndex,items,coverage:{startAfter,end,snapshot:latest,pageDigest:digestValue,checkpointHash},nextCursor,complete:!hasMore,integrityConclusion:hasMore?'deferred-until-all-pages':'page-sequence-complete' as const,executionAcceptance:'unverified' as const};
 });
}

/** Covers a frozen snapshot page by page while retaining only bounded reduction state. */
export function reduceLegacyGuideEvidenceSnapshot(projectId:string,pageSize?:number):Promise<GuideEvidenceReductionCompleteResult>;
export function reduceLegacyGuideEvidenceSnapshot(projectId:string,pageSize:number,options:GuideEvidenceReductionOptions):Promise<GuideEvidenceReductionResult>;
export async function reduceLegacyGuideEvidenceSnapshot(projectId:string,pageSize=100,options:GuideEvidenceReductionOptions={}):Promise<GuideEvidenceReductionResult>{
 const maxPages=Math.min(Math.max(Math.trunc(options.maxPages??10_000),1),10_000),ttlMs=Math.min(Math.max(Math.trunc(options.checkpointTtlMs??900_000),60_000),3_600_000),now=options.now??new Date();
 let state=createGuideEvidenceReduction(projectId),cursor:string|undefined;
 if(options.checkpoint){if(!options.signingKey)throw Error('Guide evidence reduction checkpoint signing key is required');const resumed=decodeGuideEvidenceReductionCheckpoint(options.checkpoint,projectId,options.signingKey,now);state=structuredClone(resumed.state);cursor=resumed.cursor;}
 for(let pageCount=0;pageCount<maxPages;pageCount+=1){
  const page=await legacyGuideEvidenceInventoryPage(projectId,{cursor,pageSize});state=reduceLegacyGuideEvidencePage(state,page);
  if(page.complete)return {complete:true,state,manifest:finalizeGuideEvidenceReduction(state),checkpoint:null};
  if(!page.nextCursor)throw Error('Guide evidence reduction stopped before complete coverage');cursor=page.nextCursor;
 }
 if(!options.signingKey||!cursor)throw Error('Guide evidence reduction needs a signing key to emit a resumable partial checkpoint');
 const issuedAt=now.toISOString(),expiresAt=new Date(now.getTime()+ttlMs).toISOString(),checkpoint=encodeGuideEvidenceReductionCheckpoint({schemaVersion:1,projectId,issuedAt,expiresAt,cursor,state,authority:'resume-only',executionAcceptance:'unverified',grants:noReductionGrants},options.signingKey);
 return {complete:false,state,manifest:null,checkpoint,expiresAt,progress:{pages:state.pageIndex,receipts:state.scanned,compatible:state.compatible,quarantined:state.quarantined,checkpointHash:state.checkpointHash!},authority:'resume-only',executionAcceptance:'unverified',grants:noReductionGrants};
}
