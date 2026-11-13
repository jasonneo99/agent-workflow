import {randomUUID} from 'node:crypto';
import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';

export interface ProvenanceCohortDecision {
 sourceRunId:string;projectId:string;familyId:string;taskHash:string;sourcePaths:string[];decision:'approved'|'rejected';
}
export interface ProvenanceCohortDecisionBatch {cohortKey:string;decisions:ProvenanceCohortDecision[]}
const validPath=(value:string)=>typeof value==='string'&&value.length>0&&value.length<=1000&&!value.startsWith('/')&&!value.includes('\\')
 &&!value.split('/').some(part=>!part||part==='.'||part==='..')&&!/[?*\[\]{}]/u.test(value)&&!/(^|\/)(?:\.env(?:\..*)?|credentials?|secrets?|id_rsa|id_ed25519)(\/|$)/iu.test(value);
export function validateProvenanceCohortDecisionBatch(input:ProvenanceCohortDecisionBatch){
 if(!input||!/^provenance-gap:[^:]+:[a-f0-9]{16}$/u.test(input.cohortKey)||!Array.isArray(input.decisions)||!input.decisions.length||input.decisions.length>100)throw Error('One bounded provenance cohort decision batch required');
 const ids=new Set<string>();
 for(const item of input.decisions){
  const familyParts=item.familyId.split(':');
  if(!/^[0-9a-f-]{36}$/iu.test(item.sourceRunId)||!/^[0-9a-f-]{36}$/iu.test(item.projectId)||familyParts.length!==2||familyParts[0]!==item.projectId||!/^[0-9a-f-]{36}$/iu.test(familyParts[1]??'')
   ||!/^[a-f0-9]{64}$/u.test(item.taskHash)||!['approved','rejected'].includes(item.decision)||!Array.isArray(item.sourcePaths)||!item.sourcePaths.length||item.sourcePaths.length>1000
   ||new Set(item.sourcePaths).size!==item.sourcePaths.length||item.sourcePaths.some(path=>!validPath(path))||ids.has(item.sourceRunId))throw Error('Every cohort decision must bind one unique exact family, task and safe source scope');
  ids.add(item.sourceRunId);
 }
 return input;
}

export async function recordProvenanceCohortDecisionsOnClient(c:Client,input:ProvenanceCohortDecisionBatch){
 validateProvenanceCohortDecisionBatch(input);
 await c.query('begin');try{
  const results=[];
  for(const item of input.decisions){
   const row=(await c.query(`select r.id::text id,r.project_id::text project_id,r.run_set_id::text run_set_id,r.task,r.evaluation_metadata,
    exists(select 1 from project_identity_locations l where l.project_id=r.project_id and l.identity_id=r.project_id and l.kind='canonical') canonical
    from workflow_runs r where r.id=$1 for update`,[item.sourceRunId])).rows[0];
   if(!row||row.project_id!==item.projectId||`${row.project_id}:${row.run_set_id}`!==item.familyId||acceptanceDigest(row.task)!==item.taskHash||!row.canonical
    ||['sourceRunId','replayOfRunId','repairOriginRunId','parentRunId'].some(key=>Object.hasOwn(row.evaluation_metadata??{},key)))throw Error('Cohort decision no longer matches a canonical original family');
   const existing=(await c.query(`select metadata from action_receipts where run_id=$1 and action_type in ('operator_legacy_recovery_authorized','operator_legacy_recovery_rejected')
    and metadata->>'cohortKey'=$2 order by created_at limit 2`,[item.sourceRunId,input.cohortKey])).rows;
   if(existing.length){const prior=existing[0].metadata;if(existing.length!==1||prior.approvalDecision!==item.decision||acceptanceDigest(prior.sourcePaths)!==acceptanceDigest([...item.sourcePaths].sort()))throw Error('A different immutable cohort decision already exists');results.push({sourceRunId:item.sourceRunId,state:'existing'});continue;}
   const authorizationId=randomUUID(),metadata={version:1,cohortKey:input.cohortKey,authorizationId,sourceRunId:item.sourceRunId,projectId:item.projectId,familyId:item.familyId,taskHash:item.taskHash,
    sourcePaths:[...item.sourcePaths].sort(),provider:'codex-cli',modelTier:'standard',offlineOnly:true,approvalSource:'direct-human',approvalDecision:item.decision};
   await appendActionReceipt(c,{runId:item.sourceRunId,agentId:'workflow-orchestrator',actionType:item.decision==='approved'?'operator_legacy_recovery_authorized':'operator_legacy_recovery_rejected',target:authorizationId,
    summary:item.decision==='approved'?'Exact current-baseline enrollment authorized from reviewed provenance cohort':'Exact current-baseline enrollment rejected from reviewed provenance cohort',metadata:JSON.stringify(metadata)});
   results.push({sourceRunId:item.sourceRunId,state:item.decision,authorizationId});
  }
  await c.query('commit');return {cohortKey:input.cohortKey,results};
 }catch(error){await c.query('rollback');throw error;}
}
export const recordProvenanceCohortDecisions=(input:ProvenanceCohortDecisionBatch)=>withClient(c=>recordProvenanceCohortDecisionsOnClient(c,input));
