import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';

export interface AssessmentSupplementalEvidence {uri:string;digest:string;summary:string;authority:'evidence-only';nativeAcceptance:false}
const bounded=(value:string,budget:number)=>{
 if(value.length<=budget)return value;
 const marker='\n[truncated evidence]\n',remaining=Math.max(0,budget-marker.length),head=Math.ceil(remaining/2),tail=remaining-head;
 return value.slice(0,head)+marker+(tail?value.slice(-tail):'');
};
/** Exact operator-captured offline observations, never authority, command grants
 * or an acceptance fallback. Caller independently verifies the prior run chain. */
export async function loadAssessmentSupplementalEvidence(c:Pick<Client,'query'>,input:{priorRunId:string;sourceRunId:string;projectId:string;subjectHash:string;uris:unknown}):Promise<AssessmentSupplementalEvidence[]|null>{
 if(input.uris===undefined)return [];
 if(!Array.isArray(input.uris)||input.uris.length>3||new Set(input.uris).size!==input.uris.length)return null;
 const result:AssessmentSupplementalEvidence[]=[];
 for(const uri of input.uris){
  if(typeof uri!=='string'||!uri.startsWith(`db://workflow_runs/${input.priorRunId}/`)||uri.length>1000)return null;
  const rows=(await c.query("select content from artifacts where run_id=$1 and uri=$2 and kind='operator_current_assessment_evidence'",[input.priorRunId,uri])).rows;
  const e=rows[0]?.content;
  if(rows.length!==1||e?.version!==1||e.sourceRunId!==input.sourceRunId||e.projectId!==input.projectId||e.priorRunId!==input.priorRunId
   ||e.subjectHash!==input.subjectHash||e.sourceBefore!==input.subjectHash||e.sourceAfter!==input.subjectHash||e.exitCode!==0||e.nativeAcceptance!==false||e.replay!==false
   ||!Array.isArray(e.commands)||!e.commands.length||e.commands.length>10)return null;
  const receipts=(await c.query("select metadata from action_receipts where run_id=$1 and action_type='operator_current_assessment_evidence' and target=$2 and agent_id in ('operator','workflow-orchestrator')",[input.priorRunId,uri])).rows;
  if(!receipts.some(r=>acceptanceDigest(r.metadata)===acceptanceDigest(e)))return null;
  const streamBudget=Math.max(100,Math.floor(2800/(2*e.commands.length)));
  const summaries:string[]=[];
  for(const command of e.commands){
   if(typeof command.command!=='string'||command.command.length>1000||command.exitCode!==0
    ||typeof command.stdout!=='string'||typeof command.stderr!=='string'||typeof command.approvalReference!=='string'||!command.approvalReference
    ||command.stdout.length>100000||command.stderr.length>100000)return null;
   summaries.push(JSON.stringify({command:command.command,exitCode:0,approvalReference:command.approvalReference,stdout:bounded(command.stdout,streamBudget),stderr:bounded(command.stderr,streamBudget)}));
  }
  result.push({uri,digest:acceptanceDigest(e),summary:bounded(summaries.join('\n'),4000),authority:'evidence-only',nativeAcceptance:false});
 }
 return result;
}
