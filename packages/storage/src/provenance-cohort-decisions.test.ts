import assert from 'node:assert/strict';
import test from 'node:test';
import type {Client} from 'pg';
import {acceptanceDigest} from './acceptance.js';
import {recordProvenanceCohortDecisionsOnClient,validateProvenanceCohortDecisionBatch,type ProvenanceCohortDecisionBatch} from './provenance-cohort-decisions.js';
const id='11111111-1111-4111-8111-111111111111',project='22222222-2222-4222-8222-222222222222',set='33333333-3333-4333-8333-333333333333';
const valid=()=>({cohortKey:`provenance-gap:${project}:1234567890abcdef`,decisions:[{sourceRunId:id,projectId:project,familyId:`${project}:${set}`,taskHash:'a'.repeat(64),sourcePaths:['src/main.ts'],decision:'approved' as const}]});
test('batch decisions retain separate exact family grants',()=>{assert.deepEqual(validateProvenanceCohortDecisionBatch(valid()),valid());});
test('batch decisions reject broad, duplicate and malformed authority',()=>{
 for(const input of [{...valid(),cohortKey:'gap'}, {...valid(),decisions:[]}, {...valid(),decisions:[...valid().decisions,...valid().decisions]}, {...valid(),decisions:[{...valid().decisions[0],sourcePaths:['../escape']}]}, {...valid(),decisions:[{...valid().decisions[0],familyId:`${project}:other`}]}, {...valid(),decisions:[{...valid().decisions[0],decision:'maybe'}]}])assert.throws(()=>validateProvenanceCohortDecisionBatch(input as never));
});

test('approved and rejected human decisions use a registered runtime writer and retain human authority',async()=>{
 for(const decision of ['approved','rejected'] as const){
  const input:ProvenanceCohortDecisionBatch=valid();input.decisions[0]!.decision=decision;
  const task='Synthetic exact original task';input.decisions[0].taskHash=acceptanceDigest(task);
  const receipts:unknown[][]=[];const statements:string[]=[];
  const c={query:async(sql:string,values:unknown[]=[])=>{
   statements.push(sql);
   if(sql.includes('select r.id::text'))return {rows:[{id,project_id:project,run_set_id:set,task,canonical:true,evaluation_metadata:{}}]};
   if(sql.includes('select id from workflow_runs'))return {rows:[{id}]};
   if(sql.includes('insert into action_receipts')){
    // Model the real registry FK: human role names are not executable agents.
    assert.equal(values[1],'workflow-orchestrator','receipt writer must exist in the runtime agent registry');
    receipts.push(values);return {rows:[]};
   }
   if(sql.startsWith('select ')||sql==='begin'||sql==='commit'||sql==='rollback'||sql.startsWith('savepoint ')||sql.startsWith('release savepoint '))return {rows:[]};
   throw Error('Unexpected query: '+sql);
  }} as unknown as Client;
  const result=await recordProvenanceCohortDecisionsOnClient(c,input);
  assert.equal(result.results[0]?.state,decision);assert.equal(receipts.length,1);
  assert.equal(receipts[0]?.[2],decision==='approved'?'operator_legacy_recovery_authorized':'operator_legacy_recovery_rejected');
  const metadata=JSON.parse(String(receipts[0]?.[5]));
  assert.equal(metadata.approvalSource,'direct-human');assert.equal(metadata.approvalDecision,decision);
  assert.equal(metadata.taskHash,input.decisions[0].taskHash);assert.deepEqual(metadata.sourcePaths,['src/main.ts']);
  assert.ok(statements.includes('commit'));assert.ok(!statements.includes('rollback'));
 }
});
