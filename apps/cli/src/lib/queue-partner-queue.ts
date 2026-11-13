import {withClient} from '../../../../packages/storage/src/client.js';
import {randomUUID} from 'node:crypto';
import {acquireWorkIntent,releaseWorkIntent,claimSideEffect,finalizeSideEffect} from '../../../../packages/storage/src/postgres.js';
import {buildQueueStatusReport} from './queue-status.js';
import {buildQueueCardTitle} from '../../../../packages/storage/src/run-presentation.js';
import {listWorkflowQueue} from '../../../../packages/storage/src/postgres.js';
import {partnerHash,rankPartnerItems,type PartnerChatAdapter,type PartnerItem,type PartnerMessage,type PartnerReply} from './queue-partner-chat.js';
import {queueHistorySignals,recordAndLoadQueueHistory} from './queue-history.js';

export type PartnerOwnerKind='run'|'approval'|'proposal';
export interface QueuePartnerDirectory{
 items():Promise<PartnerItem[]>;
 owner(kind:PartnerOwnerKind,id:string):Promise<string|null>;
 adapter(projectId:string):Promise<PartnerChatAdapter|null>;
 converse(message:PartnerMessage):Promise<string>;
 onceMessage(message:PartnerMessage,action:()=>Promise<PartnerReply>):Promise<PartnerReply>;
}
/** A queue-wide router, not a global execution identity. Every effect uses its actual owner. */
export function createQueuePartnerAdapter(directory:QueuePartnerDirectory):PartnerChatAdapter{
 const owned=async(kind:PartnerOwnerKind,id:string,expected?:string)=>{
  const projectId=await directory.owner(kind,id);
  if(!projectId||(expected&&expected!==projectId))throw Error('The queue item owner changed or does not match the recorded scope.');
  const adapter=await directory.adapter(projectId);
  if(!adapter)throw Error('The owning project is not available for this operation.');
  return {projectId,adapter};
 };
 const effect=async(kind:PartnerOwnerKind,id:string,expected?:string)=>{
  const scope=await owned(kind,id,expected);
  if(scope.adapter.canAct&&!await scope.adapter.canAct(scope.projectId))throw Error('The owning project role cannot perform this operation.');
  return scope.adapter;
 };
 return {
  onceMessage:(message,action)=>directory.onceMessage(message,action),
  canAct:async projectId=>{if(!projectId)return true;try{const a=await directory.adapter(projectId);return Boolean(a&&(!a.canAct||await a.canAct(projectId)));}catch{return false;}},
  items:()=>directory.items(),
  item:async id=>{try{return await (await owned('run',id)).adapter.item(id);}catch{return null;}},
  approvals:async id=>(await owned('run',id)).adapter.approvals(id),
  approval:async id=>{try{return await (await owned('approval',id)).adapter.approval(id);}catch{return null;}},
  proposal:async id=>{try{return await (await owned('proposal',id)).adapter.proposal(id);}catch{return null;}},
  async saveProposal(proposal){
   const adapter=await effect('run',proposal.runId,proposal.projectId);
   if(await directory.owner('approval',proposal.approvalId)!==proposal.projectId)throw Error('Approval ownership does not match the proposed item.');
   const approval=await adapter.approval(proposal.approvalId);
   if(!approval||approval.runId!==proposal.runId||approval.projectId!==proposal.projectId)throw Error('Approval is not owned by the proposed run.');
   await adapter.saveProposal(proposal);
  },
  async once(key,hash,runId,action){
   const {projectId}=await owned('run',runId),adapter=await effect('run',runId,projectId);
   return adapter.once(key,hash,runId,async()=>{
    // A receipt/claim in one project may never authorize an effect in another.
    await effect('run',runId,projectId);return action();
   });
  },
  repair:async(item,message)=>(await effect('run',item.runId,item.projectId)).repair(item,message),
  stop:async(item,message)=>{
   const adapter=await effect('run',item.runId,item.projectId);
   return adapter.stop?adapter.stop(item,message):{status:'blocked',text:'The owning project does not expose a stop control.'};
  },
  approve:async approval=>{
   const adapter=await effect('approval',approval.id,approval.projectId);
   if(await directory.owner('run',approval.runId)!==approval.projectId)throw Error('Approval run owner changed.');
   return adapter.approve(approval);
  },
  converse:message=>directory.converse(message),
 };
}

export interface PartnerRequestStore{
 intent(controlProjectId:string,key:string,action:()=>Promise<PartnerReply>):Promise<PartnerReply>;
 claim:typeof claimSideEffect;
 finalize:typeof finalizeSideEffect;
}
const requestStore:PartnerRequestStore={claim:claimSideEffect,finalize:finalizeSideEffect,intent:async(projectId,key,action)=>{
 const owner=`queue-partner-request:${randomUUID()}`;
 const intent=await acquireWorkIntent({projectId,owner,objective:'Deduplicate one queue-wide operator request before item selection',fileScopes:[`runtime/queue-partner/request-routing/${key}`],ttlSeconds:900});
 try{return await action();}finally{await releaseWorkIntent({projectId,owner,fencingToken:intent.fencingToken});}
}};
/** A coordination-only namespace shared by every dashboard using this queue DB.
 * It is NOT an execution project/grant. Its writes hold the actual host project's
 * narrow intent; every selected effect still claims its owning project separately.
 */
export function createQueuePartnerRequestLedger(controlProjectId:string,store:PartnerRequestStore=requestStore){
 return async(input:PartnerMessage,action:()=>Promise<PartnerReply>):Promise<PartnerReply>=>{
  const key=partnerHash({conversationId:input.conversationId,idempotencyKey:input.idempotencyKey}),requestHash=partnerHash(input);
  const projectId='queue-partner:request-routing',idempotencyKey=`queue-partner-request:${key}`;
  const review=(text:string):PartnerReply=>({kind:'queue_partner_chat_report',status:'review',text,items:[]});
  try{return await store.intent(controlProjectId,key,async()=>{
   const claim=await store.claim({projectId,idempotencyKey,operation:'queue-partner-request',target:input.conversationId,claimSeconds:900});
   if(claim.status==='completed'){
    const prior=claim.receipt.reply as PartnerReply|undefined;
    return claim.receipt.requestHash===requestHash&&prior?.kind==='queue_partner_chat_report'?{...prior,replayed:true}:review('This request key belongs to a different instruction or an incomplete recorded reply. Nothing new was started.');
   }
   if(claim.status!=='claimed'||!claim.claimToken)return review('This queue-wide instruction is already in progress or uncertain. Its target was not selected again; reconcile the recorded outcome before retrying.');
   try{
    const reply=await action();
    const settled=await store.finalize({projectId,idempotencyKey,claimToken:claim.claimToken,receipt:{version:1,controlProjectId,requestHash,reply}});
    return settled?reply:review('The instruction returned but its request claim changed. Reconcile its original selected item before retrying; no new item was selected.');
   }catch{return review('The queue-wide request outcome is uncertain. Its claim is preserved; no automatic retry or selection of another item was performed.');}
  });}catch{return review('The request routing intent or ledger is unavailable or owned by another request. No selection or automatic retry was attempted.');}
 };
}

/** Registry identities, not client-supplied project labels, select the effect owner. */
export async function queuePartnerOwner(kind:PartnerOwnerKind,id:string):Promise<string|null>{
 return withClient(async c=>{
  const result=kind==='run'?await c.query('select project_id::text as id from workflow_runs where id=$1::uuid',[id])
   :kind==='approval'?await c.query('select r.project_id::text as id from action_approvals a join workflow_runs r on r.id=a.run_id where a.id=$1::uuid',[id])
   :await c.query(`select r.project_id::text as id from artifacts a join workflow_runs r on r.id=a.run_id where a.kind='queue_partner_approval_proposal' and a.content->>'id'=$1 limit 2`,[id]);
  return result.rows.length===1?result.rows[0].id:null;
 });
}
export async function queuePartnerItems():Promise<PartnerItem[]>{
 const [report,cards]=await Promise.all([buildQueueStatusReport(undefined,undefined,true),listWorkflowQueue(500,{latestRelated:true})]),visible=report.rows.slice(0,500);
 if(!visible.length)return [];
 const trend=queueHistorySignals(await recordAndLoadQueueHistory({queue:cards.map(card=>({runStatus:card.runStatus,queuedTasks:card.queuedTasks,runningTasks:card.runningTasks})),rangeMinutes:60}).catch(()=>[]));
 const rows=await withClient(async c=>(await c.query(`select r.id::text,r.project_id::text as "projectId",r.status,
 (select count(*)::int from action_approvals a where a.run_id=r.id and a.status in ('pending','approved','executing','failed')) as "approvalCount"
 from workflow_runs r where r.id=any($1::uuid[])`,[visible.map(r=>r.runId)])).rows);
 return rankPartnerItems(visible.flatMap(row=>{
  const current=rows.find(r=>r.id===row.runId&&r.projectId===row.projectId);
  const card=cards.find(item=>item.runId===row.runId);
  const currentAction=card?.runningStageId?`Running ${card.runningStageId}${card.runningAgentId?` with ${card.runningAgentId}`:''}`:card?.nextStageId?`Next: ${card.nextStageId}${card.nextAgentId?` with ${card.nextAgentId}`:''}`:row.fix;
  const signal=trend.find(item=>item.status===(current.status==='queued'?'waiting':current.status));
  return current?[{runId:row.runId,projectId:row.projectId,projectName:row.projectName,familyId:card?`${row.projectId}:${card.versionSetId??card.runSetId}`:row.id,title:card?buildQueueCardTitle(card):row.name,originalDeliverable:card?buildQueueCardTitle(card):row.name,currentAction,status:current.status,blocker:row.issue,proposedFix:row.fix,approvalCount:current.approvalCount,completedStages:card?.completedTasks,totalStages:card?.totalTasks,remainingStages:card?Math.max(0,card.totalTasks-card.completedTasks):undefined,runningTasks:card?.runningTasks,latestActivityAt:card?.latestActivityAt,...(signal?{queueTrendDelta:signal.delta,queueTrendTone:signal.tone,queueTrendAction:signal.partnerAction}:{})}]:[];
 }));
}
