import type { Client } from 'pg';
import { withClient } from './client.js';
import { appendActionReceipt } from './receipt-writer.js';

export interface PartnerRepairManagement {
 projectId:string;sourceRunId:string;familyId:string;owner:string;intentFence:string;
}
/** Explicit operator-selected ownership. This restricts competing repair
 * producers; it grants no source, provider, approval or acceptance authority. */
export async function enablePartnerRepairManagementOnClient(c:Client,input:PartnerRepairManagement,writeReceipt=appendActionReceipt):Promise<boolean>{
 const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
 if(!uuid.test(input.projectId)||!uuid.test(input.sourceRunId)
  ||!input.familyId.startsWith(input.projectId+':')||!input.owner||!/^\d+$/u.test(input.intentFence))throw Error('Exact repair-management identity required');
 await c.query("select pg_advisory_xact_lock(hashtext('agentflow:queue-coordinator'))");
 const source=(await c.query(`select r.project_id::text project_id,r.run_set_id::text run_set_id,p.root_uri
  from workflow_runs r join projects p on p.id=r.project_id where r.id=$1 for update of r`,[input.sourceRunId])).rows[0];
 if(!source||source.project_id!==input.projectId||input.familyId!==`${source.project_id}:${source.run_set_id}`
  ||/(^|\/)(vendor|node_modules)(\/|$)/iu.test(source.root_uri))throw Error('Repair management outside owning project');
 const intent=await c.query(`select 1 from work_intents where project_id::text=$1 and owner=$2
  and fencing_token::text=$3 and expires_at>clock_timestamp() and file_scopes=$4::jsonb for update`,
  [input.projectId,input.owner,input.intentFence,JSON.stringify(['runtime/queue-partner/repair-management'])]);
 if(!intent.rowCount)throw Error('Repair management intent lost');
 const uri=`db://workflow_runs/${input.sourceRunId}/queue_partner_repair_management/enabled`;
 if((await c.query('select 1 from artifacts where uri=$1',[uri])).rowCount)return false;
 const content={version:1,manager:'queue-partner',enabled:true,projectId:input.projectId,sourceRunId:input.sourceRunId,familyId:input.familyId,
  authority:'ownership-only; existing policy, grants, scopes and acceptance unchanged'};
 await writeReceipt(c,{runId:input.sourceRunId,agentId:'workflow-orchestrator',actionType:'queue_partner_repair_management_enabled',target:input.familyId,
  summary:'Partner owns shared self-repair scheduling for this reviewed family; competing legacy repair dispatch is inhibited. No new execution permission.',metadata:JSON.stringify(content)});
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'queue_partner_repair_management',$2,$3::jsonb)",[input.sourceRunId,uri,JSON.stringify(content)]);
 return true;
}
export const enablePartnerRepairManagement=(input:PartnerRepairManagement)=>withClient(async c=>{
 await c.query('begin');try{const result=await enablePartnerRepairManagementOnClient(c,input);await c.query('commit');return result;}
 catch(e){await c.query('rollback');throw e;}
});

/** A record can only inhibit legacy dispatch, never authorize coordinator work. */
export async function partnerManagesRepairOnClient(c:Pick<Client,'query'>,projectId:string,familyId:string):Promise<boolean>{
 return Boolean((await c.query(`select 1 from artifacts a join workflow_runs r on r.id=a.run_id
  where r.project_id::text=$1 and r.project_id::text||':'||r.run_set_id::text=$2
  and a.kind='queue_partner_repair_management' and a.content->>'manager'='queue-partner'
  and a.content->>'enabled'='true' and a.content->>'projectId'=$1 and a.content->>'familyId'=$2 limit 1`,[projectId,familyId])).rowCount);
}
