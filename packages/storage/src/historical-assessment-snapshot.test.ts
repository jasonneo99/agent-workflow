import test from 'node:test';
import assert from 'node:assert/strict';
import type {Client} from 'pg';
import {chainReceipt} from '../../workflow-engine/src/receipt-chain.js';
import {captureHistoricalAssessmentSnapshot,verifyHistoricalAssessmentSnapshot,verifyHistoricalHashedSubset} from './historical-assessment-snapshot.js';
function row(runId:string,id:string,previous='GENESIS'){
 const x=chainReceipt(previous,{runId,agentId:'operator',actionType:'stage_completed',target:'stage',summary:'Synthetic observation',metadata:'{}',createdAt:'2026-01-01T00:00:00.000Z',metadataSerializationVersion:2});
 return {id,run_id:runId,agent_id:x.agentId,action_type:x.actionType,target:x.target,summary:x.summary,metadata:{},metadata_text:x.metadata,created_at:x.createdAt,prev_hash:x.prevHash,receipt_hash:x.receiptHash,metadata_serialization_version:2};
}
function fixture(){
 const hashed=row('prior','hashed'),unhashed={...row('prior','unhashed'),action_type:'stage_blocked',receipt_hash:null,prev_hash:null};
 const rows:any[]=[hashed,unhashed],artifactRows:any[]=[{id:'artifact',run_id:'prior',kind:'stage_output',content:{failed:true}}];
 let authorization:any=null;const source=row('source','sourcehash');
 const run:any={prior_id:'prior',source_id:'source',project_id:'project',source_project:'project',status:'blocked',evaluation_metadata:{sourceRunId:'source'}};
 const client={query:async(sql:string)=>{
  if(sql.includes('from workflow_runs p join'))return {rows:[run]};
  if(sql.includes('to_jsonb(a) row,a.metadata'))return {rows:rows.map(r=>({row:r,metadata_text:r.metadata_text}))};
  if(sql.includes('to_jsonb(a) row from artifacts'))return {rows:artifactRows.map(row=>({row}))};
  if(sql.includes("kind='operator_history_assessment_snapshot'"))return {rows:authorization?[{content:authorization,uri:'snapshot-uri'}]:[]};
  if(sql.includes("action_type='operator_history_assessment_snapshot'"))return {rows:authorization?[{metadata:authorization}]:[]};
  if(sql.includes('metadata::text as metadata'))return {rows:[{...source,metadata:'{}',created_at:new Date(source.created_at)}]};
  throw new Error(sql);
 }} as unknown as Client;
 return {client,rows,artifactRows,run,set authorization(a:any){authorization=a;},get authorization(){return authorization;}};
}
test('hash-bearing subset rejects corruption, forks and disconnected history without claiming coverage',()=>{
 const a=row('prior','a'),b=row('prior','b',a.receipt_hash);
 assert.equal(verifyHistoricalHashedSubset('prior',[b,a]),true);
 assert.equal(verifyHistoricalHashedSubset('prior',[a,{...b,summary:'tampered'}]),false);
 assert.equal(verifyHistoricalHashedSubset('prior',[a,b,{...b,id:'fork'}]),false);
 assert.equal(verifyHistoricalHashedSubset('prior',[b]),false);
});
test('exact authorized snapshot permits assessment only; historical receipt/artifact changes invalidate',async()=>{
 const f=fixture(),snapshot=await captureHistoricalAssessmentSnapshot(f.client,'prior','source');assert.ok(snapshot);
 assert.equal(snapshot.accepted,false);assert.equal(snapshot.hashedSubsetValid,true);assert.equal(snapshot.historicalReceiptsRemainUnverified,true);
 f.authorization={authorizationId:'human-decision',authority:'direct-human',actor:'operator',approvalDecision:'approved',offlineOnly:true,sourceRunId:'source',priorRunId:'prior',snapshot};
 assert.equal(await verifyHistoricalAssessmentSnapshot(f.client,'prior','source'),true);
 f.artifactRows[0].content.failed=false;assert.equal(await verifyHistoricalAssessmentSnapshot(f.client,'prior','source'),false);
 f.artifactRows[0].content.failed=true;f.rows[1].summary='changed';assert.equal(await verifyHistoricalAssessmentSnapshot(f.client,'prior','source'),false);
});
test('unsafe unhashed effects, excessive coverage gaps, wrong authority/project and writes fail closed',async()=>{
 for(const kind of ['file_write','local_command','action_approval_executed','command_executed']){const f=fixture();f.rows[1].action_type=kind;assert.equal(await captureHistoricalAssessmentSnapshot(f.client,'prior','source'),null);}
 const f=fixture();f.rows.push(...Array.from({length:16},(_,i)=>({...f.rows[1],id:`unhashed-${i}`})));assert.equal(await captureHistoricalAssessmentSnapshot(f.client,'prior','source'),null);
 const g=fixture();g.run.source_project='other';assert.equal(await captureHistoricalAssessmentSnapshot(g.client,'prior','source'),null);
 const h=fixture();h.artifactRows.push({kind:'file_write'});assert.equal(await captureHistoricalAssessmentSnapshot(h.client,'prior','source'),null);
 const j=fixture(),snapshot=await captureHistoricalAssessmentSnapshot(j.client,'prior','source');j.authorization={authority:'callback',actor:'operator',approvalDecision:'approved',offlineOnly:true,sourceRunId:'source',priorRunId:'prior',snapshot};assert.equal(await verifyHistoricalAssessmentSnapshot(j.client,'prior','source'),false);
});
