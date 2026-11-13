import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';
import {verifyReceiptChain,type ChainedReceipt} from '../../workflow-engine/src/receipt-chain.js';

const observationTypes=new Set(['workflow_run_lease_acquired','model_route','stage_blocked','workflow_run_transition']);
export interface HistoricalAssessmentSnapshot {
 version:1;sourceRunId:string;priorRunId:string;projectId:string;
 receiptsDigest:string;artifactsDigest:string;receiptCount:number;artifactCount:number;
 unhashedReceiptIds:string[];hashedReceiptCount:number;
 historicalReceiptsRemainUnverified:true;acceptanceEvidence:false;executionAuthority:false;
 hashedSubsetValid:true;unchainedObservationsRemainUnverified:true;accepted:false;
}
/** Verify the hash-bearing segment, without calling missing coverage valid. */
export function verifyHistoricalHashedSubset(runId:string,rows:any[]):boolean {
 const receipts:ChainedReceipt[]=rows.filter(r=>r.receipt_hash).map(r=>({runId,agentId:r.agent_id,actionType:r.action_type,target:r.target,summary:r.summary,metadata:r.metadata_text,metadataSerializationVersion:r.metadata_serialization_version??undefined,createdAt:new Date(r.created_at).toISOString(),prevHash:r.prev_hash,receiptHash:r.receipt_hash}));
 if(!receipts.length||receipts.some(r=>typeof r.prevHash!=='string'))return false;
 const next=new Map<string,ChainedReceipt[]>();for(const r of receipts)next.set(r.prevHash,[...(next.get(r.prevHash)??[]),r]);
 const ordered:ChainedReceipt[]=[],seen=new Set<string>();let tip='GENESIS';
 while(next.has(tip)){const successors=next.get(tip)!;if(successors.length!==1||seen.has(successors[0].receiptHash))return false;ordered.push(successors[0]);seen.add(successors[0].receiptHash);tip=successors[0].receiptHash;}
 return ordered.length===receipts.length&&verifyReceiptChain(ordered).valid;
}
/** Read-only exact snapshot. It never hashes or repairs historical rows. */
export async function captureHistoricalAssessmentSnapshot(c:Client,priorId:string,sourceId:string):Promise<HistoricalAssessmentSnapshot|null>{
 const run=(await c.query(`select p.id::text prior_id,p.project_id::text project_id,p.status,p.evaluation_metadata,s.id::text source_id,s.project_id::text source_project from workflow_runs p join workflow_runs s on s.id=$2 where p.id=$1`,[priorId,sourceId])).rows[0];
 if(!run||run.status!=='blocked'||run.project_id!==run.source_project||run.evaluation_metadata?.sourceRunId!==sourceId)return null;
 const receipts=(await c.query('select to_jsonb(a) row,a.metadata::text metadata_text from action_receipts a where run_id=$1 order by id limit 1001',[priorId])).rows.map(r=>({...r.row,metadata_text:r.metadata_text}));
 const artifacts=(await c.query('select to_jsonb(a) row from artifacts a where run_id=$1 order by id limit 1001',[priorId])).rows.map(r=>r.row);
 if(receipts.length>1000||artifacts.length>1000||JSON.stringify({receipts,artifacts}).length>2_000_000)return null;
 const unhashed=receipts.filter(r=>!r.receipt_hash);
 if(!unhashed.length||unhashed.length>16||unhashed.some(r=>r.prev_hash!==null||!observationTypes.has(r.action_type))||!verifyHistoricalHashedSubset(priorId,receipts))return null;
 if(receipts.some(r=>r.action_type==='file_write')||artifacts.some(a=>a.kind==='file_write'))return null;
 return {version:1,sourceRunId:sourceId,priorRunId:priorId,projectId:run.project_id,receiptsDigest:acceptanceDigest(receipts),artifactsDigest:acceptanceDigest(artifacts),receiptCount:receipts.length,artifactCount:artifacts.length,unhashedReceiptIds:unhashed.map(r=>r.id),hashedReceiptCount:receipts.length-unhashed.length,historicalReceiptsRemainUnverified:true,acceptanceEvidence:false,executionAuthority:false,hashedSubsetValid:true,unchainedObservationsRemainUnverified:true,accepted:false};
}
/** Explicit human authorization anchors the exact observed failed predecessor.
 * It permits only a new fresh assessment, never predecessor acceptance. */
export async function verifyHistoricalAssessmentSnapshot(c:Client,priorId:string,sourceId:string):Promise<boolean>{
 try{
  const snapshot=await captureHistoricalAssessmentSnapshot(c,priorId,sourceId);if(!snapshot)return false;
  const artifacts=(await c.query("select content,created_at,uri from artifacts where run_id=$1 and kind='operator_history_assessment_snapshot' order by created_at limit 2",[sourceId])).rows;
  if(artifacts.length!==1)return false;const a=artifacts[0].content;
  if(a?.authority!=='direct-human'||a.actor!=='operator'||a.approvalDecision!=='approved'||typeof a.authorizationId!=='string'||!a.authorizationId||a.offlineOnly!==true||a.sourceRunId!==sourceId||a.priorRunId!==priorId||acceptanceDigest(a.snapshot)!==acceptanceDigest(snapshot))return false;
  const receipts=(await c.query("select metadata from action_receipts where run_id=$1 and action_type='operator_history_assessment_snapshot' and target=$2 and agent_id in ('operator','workflow-orchestrator') and receipt_hash is not null",[sourceId,artifacts[0].uri])).rows;
  if(receipts.length!==1||acceptanceDigest(receipts[0].metadata)!==acceptanceDigest(a))return false;
  const {verifyRunReceiptChainOnClient}=await import('./postgres.js');
  return (await verifyRunReceiptChainOnClient(c,sourceId)).valid;
 }catch{return false;}
}
