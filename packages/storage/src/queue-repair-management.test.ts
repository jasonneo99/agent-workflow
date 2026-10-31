import test from 'node:test';
import assert from 'node:assert/strict';
import type {Client} from 'pg';
import {enablePartnerRepairManagementOnClient,partnerManagesRepairOnClient} from './queue-repair-management.js';
const projectId='11111111-1111-4111-8111-111111111111',sourceRunId='22222222-2222-4222-8222-222222222222',set='33333333-3333-4333-8333-333333333333';
const input={projectId,sourceRunId,familyId:`${projectId}:${set}`,owner:'synthetic-owner',intentFence:'4'};
function harness(){
 const state={intent:true,exists:false,projectId,root:'/synthetic/project',writes:0,receipts:0};
 const c={query:async(sql:string,values?:unknown[])=>{
  if(sql.includes('pg_advisory'))return {rows:[]};
  if(sql.includes('from workflow_runs'))return {rows:[{project_id:state.projectId,run_set_id:set,root_uri:state.root}]};
  if(sql.includes('from work_intents')){assert.match(sql,/clock_timestamp/);assert.deepEqual(values,[projectId,input.owner,'4',JSON.stringify(['runtime/queue-partner/repair-management'])]);return {rowCount:state.intent?1:0,rows:[]};}
  if(sql.includes('select 1 from artifacts where uri'))return {rowCount:state.exists?1:0,rows:[]};
  if(sql.includes('insert into artifacts')){state.writes++;state.exists=true;assert.match(String(values?.[2]),/ownership-only/);return {rows:[]};}
  throw Error(sql);
 }} as unknown as Client;
 return {c,state,receipt:async()=>{state.receipts++;}};
}
test('Partner management is append-only, idempotent and grants ownership only',async()=>{
 const h=harness();assert.equal(await enablePartnerRepairManagementOnClient(h.c,input,h.receipt),true);
 assert.equal(await enablePartnerRepairManagementOnClient(h.c,input,h.receipt),false);
 assert.equal(h.state.writes,1);assert.equal(h.state.receipts,1);
});
test('expired/fenced intent, foreign identity and vendor scopes cannot enable management',async()=>{
 for(const scenario of ['intent','project','vendor']){
  const h=harness();if(scenario==='intent')h.state.intent=false;else if(scenario==='project')h.state.projectId='foreign';else h.state.root='/synthetic/vendor/product';
  await assert.rejects(enablePartnerRepairManagementOnClient(h.c,input,h.receipt));assert.equal(h.state.writes,0);assert.equal(h.state.receipts,0);
 }
});
test('management lookup is exact project/family and only inhibits legacy dispatch',async()=>{
 let present=false;const c={query:async(sql:string,values:unknown[])=>{
  assert.match(sql,/r.project_id::text=\$1/);assert.match(sql,/a.content->>'familyId'=\$2/);assert.match(sql,/queue_partner_repair_management/);
  assert.deepEqual(values,[projectId,input.familyId]);assert.doesNotMatch(sql,/insert|update|delete/i);return {rowCount:present?1:0};
 }} as unknown as Client;
 assert.equal(await partnerManagesRepairOnClient(c,projectId,input.familyId),false);present=true;
 assert.equal(await partnerManagesRepairOnClient(c,projectId,input.familyId),true);
});
