import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {withClient} from './client.js';
import {acceptanceDigest} from './acceptance.js';
import {appendActionReceipt} from './receipt-writer.js';

export interface QueuePartnerDecision {
 projectId:string;runId:string;familyId:string;
 decision:'repair-selected'|'verifier-selected'|'held'|'active'|'verified'|'outcome';state:string;
 what:string;why:string;how:string;next:string;requiresPermission:boolean;
 evidence:Array<{label:string;url:string}>;
 provenance:{priority:number;sourcePathsCount:number;activeCount:number;pendingApprovalCount:number;sharedBlockerKey?:string};
}
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu;
export function validateQueuePartnerDecision(input:QueuePartnerDecision):void {
 if(!uuid.test(input.projectId)||!uuid.test(input.runId)||!input.familyId.startsWith(input.projectId+':')
   ||!['repair-selected','verifier-selected','held','active','verified','outcome'].includes(input.decision)
   ||typeof input.requiresPermission!=='boolean'||typeof input.state!=='string'||!input.state||input.state.length>80)throw Error('Invalid decision identity');
 for(const value of [input.what,input.why,input.how,input.next])if(typeof value!=='string'||!value.trim()||value.length>1600)throw Error('Invalid decision narrative');
 if(!Array.isArray(input.evidence)||input.evidence.length>8||input.evidence.some(e=>typeof e.label!=='string'||e.label.length>120
   ||!/^\/(?:run\?id=|runs\?relatedTo=)[a-f0-9-]{36}$/iu.test(e.url)))throw Error('Invalid decision evidence');
 if(!input.provenance||![input.provenance.priority,input.provenance.sourcePathsCount,input.provenance.activeCount,input.provenance.pendingApprovalCount].every(Number.isFinite)
   ||[input.provenance.sourcePathsCount,input.provenance.activeCount,input.provenance.pendingApprovalCount].some(n=>!Number.isInteger(n)||n<0)
   ||(input.provenance.sharedBlockerKey!==undefined&&(typeof input.provenance.sharedBlockerKey!=='string'||input.provenance.sharedBlockerKey.length>160)))throw Error('Invalid decision basis');
}

/** Append-only explanation of a real coordinator pass; never approval or dispatch authority.
 * Caller owns its transaction and a dedicated project observation intent.
 */
export async function recordQueuePartnerDecisionOnClient(c:Client,input:QueuePartnerDecision,intent:{owner:string;fencingToken:string}) {
 validateQueuePartnerDecision(input);
 await c.query('select pg_advisory_xact_lock(hashtext($1))',['queue-partner-activity:'+input.projectId]);
 const owner=(await c.query(`select 1 from work_intents where project_id::text=$1 and owner=$2 and fencing_token::text=$3
   and expires_at>clock_timestamp() and file_scopes=$4::jsonb for update`,[input.projectId,intent.owner,intent.fencingToken,JSON.stringify(['runtime/queue-partner/activity'])])).rowCount;
 if(!owner)throw Error('Queue Partner activity intent lost');
 const source=(await c.query('select project_id::text project_id,run_set_id::text run_set_id from workflow_runs where id=$1 for update',[input.runId])).rows[0];
 if(!source||source.project_id!==input.projectId||input.familyId!==`${input.projectId}:${source.run_set_id}`)throw Error('Decision outside exact execution family');
 const semanticDigest=acceptanceDigest(input);
 // Enrollment outcomes and scheduler holds are independent observation streams.
 // Comparing only the last family event makes these alternate forever even
 // when neither changed. Real transitions within a stream still append.
 const last=(await c.query("select uri,content from artifacts where run_id=$1 and kind='queue_partner_decision' and content->>'familyId'=$2 and (content->>'decision'='outcome')=$3::boolean order by created_at desc,uri desc limit 1",[input.runId,input.familyId,input.decision==='outcome'])).rows[0];
 if(last?.content?.semanticDigest===semanticDigest)return {recorded:false,uri:last.uri,decisionId:last.content.decisionId};
 const decisionId=randomUUID(),uri=`db://workflow_runs/${input.runId}/queue_partner_decision/${decisionId}`;
 const content={version:1,authority:'evidence-only',...input,semanticDigest,decisionId,recordedAt:new Date().toISOString()};
 await appendActionReceipt(c,{runId:input.runId,agentId:'workflow-orchestrator',actionType:'queue_partner_decision',target:input.familyId,
   summary:`Queue Partner ${input.decision}: ${input.what}`.slice(0,1800),metadata:JSON.stringify(content)});
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_partner_decision',$2,$3::jsonb)",[input.runId,uri,JSON.stringify(content)]);
 return {recorded:true,uri,decisionId};
}
export const recordQueuePartnerDecision=(input:QueuePartnerDecision,intent:{owner:string;fencingToken:string})=>withClient(async c=>{
 await c.query('begin');try{const result=await recordQueuePartnerDecisionOnClient(c,input,intent);await c.query('commit');return result;}
 catch(error){await c.query('rollback');throw error;}
});
