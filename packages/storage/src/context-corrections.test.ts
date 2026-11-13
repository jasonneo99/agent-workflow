import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';import test from 'node:test';import pg from 'pg';
import {loadAgentRecords,loadWorkflowRecords} from '../../agent-registry/src/loaders.js';
import {createWorkflowRun,migrateStorage,seedRegistry,verifyRunReceiptChain} from './postgres.js';
import {readProjectEvidenceGraph} from './project-evidence.js';
import {readContextCorrections,requestContextCorrection,executeContextCorrection} from './context-corrections.js';
import {claimActionApprovalExecution,decideActionApproval,markActionApprovalExecution} from './action-approvals.js';
import {appendActionReceipt} from './receipt-writer.js';
test('corrections reuse approval fencing and chained receipts, reject stale proposals, isolate projects and bound history',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const name=`correction_test_${randomUUID().replaceAll('-','')}`,admin=new pg.Client({connectionString:process.env.TEST_DATABASE_URL});await admin.connect();const previous=process.env.DATABASE_URL;
 try{await admin.query(`create database ${name}`);const url=new URL(process.env.TEST_DATABASE_URL!);url.pathname='/'+name;process.env.DATABASE_URL=url.href;const c=new pg.Client({connectionString:url.href});await c.connect();try{
 await c.query(await fs.readFile(new URL('../../../infra/init.sql',import.meta.url),'utf8'));await migrateStorage();const agents=await loadAgentRecords(process.cwd()),workflows=await loadWorkflowRecords(process.cwd());await seedRegistry(agents,workflows);
 const project='/synthetic/corrections';const run=await createWorkflowRun({projectName:'Synthetic',projectRootUri:project,projectProfile:'custom',projectConfig:{},workflow:workflows.find(v=>v.value.id==='build-feature')!.value,task:'Synthetic correction evidence',autonomy:'1',policyProfile:'local',policySnapshot:{},policySnapshotHash:'hash'});
 const sourceHash='a'.repeat(64);await c.query(`insert into project_files(project_id,source_uri,content_hash,summary,metadata) values($1,'requirements.md',$2,'Synthetic',$3::jsonb)`,[run.projectId,sourceHash,JSON.stringify({evidenceEntries:[{kind:'requirement',title:'Original fact',line:2}]})]);
 const graph=await readProjectEvidenceGraph(project),node=graph.nodes.find(n=>n.kind==='requirement')!,source=graph.nodes.find(n=>n.kind==='source')!;
 const input={runId:run.runId,nodeId:node.id,after:'Corrected fact',reason:'Synthetic supporting evidence',proposedBy:'Synthetic proposer',supportIds:[source.id],previousReceiptId:null,sourceHash};
 const request=await requestContextCorrection(project,input);assert.equal((await requestContextCorrection(project,input)).approvalId,request.approvalId);assert.equal((await readContextCorrections(project,node.id)).entries.length,0);
 assert.equal(await claimActionApprovalExecution({approvalId:request.approvalId,actor:'Synthetic executor'}),null);
 await assert.rejects(executeContextCorrection({approvalId:request.approvalId,claimToken:randomUUID(),actor:'Synthetic executor'}),/claim/);
 const competing=await requestContextCorrection(project,{...input,after:'Competing fact'});
 async function claim(id:string){await decideActionApproval({approvalId:id,decision:'approved',actor:'Synthetic reviewer'});return (await claimActionApprovalExecution({approvalId:id,actor:'Synthetic executor'}))!;}
 const claimB=await claim(competing.approvalId);
 const claimA=await claim(request.approvalId);const clock=Date.now;let uri:string;try{Date.now=()=>clock()+60000;uri=await executeContextCorrection({approvalId:request.approvalId,claimToken:claimA.claimToken,actor:'Synthetic executor'});}finally{Date.now=clock;}assert.equal(await executeContextCorrection({approvalId:request.approvalId,claimToken:claimA.claimToken,actor:'Synthetic executor'}),uri);
 await markActionApprovalExecution({approvalId:request.approvalId,status:'executed',actor:'Synthetic executor',summary:'Synthetic correction',artifactUri:uri,executionClaimToken:claimA.claimToken});
 await assert.rejects(executeContextCorrection({approvalId:competing.approvalId,claimToken:claimB.claimToken,actor:'Synthetic executor'}),/history changed/);
 let history=await readContextCorrections(project,node.id);assert.equal(history.entries.length,1);assert.equal(history.entries[0].metadata.before,'Original fact');assert.equal(history.entries[0].metadata.proposedBy,'Synthetic proposer');assert.equal(history.entries[0].metadata.executedBy,'Synthetic executor');assert.equal(history.entries[0].metadata.evidence[0].hash,sourceHash);assert.equal((await readContextCorrections('/synthetic/foreign',node.id)).entries.length,0);
 await assert.rejects(requestContextCorrection('/synthetic/foreign',input),/Select/);await assert.rejects(requestContextCorrection(project,{...input,sourceHash:'b'.repeat(64)}),/source changed/);
 const next=await requestContextCorrection(project,{...input,previousReceiptId:history.entries[0].id,after:'Later fact'});const claimNext=await claim(next.approvalId);await c.query(`update project_files set content_hash=$1 where project_id=$2`,['c'.repeat(64),run.projectId]);await assert.rejects(executeContextCorrection({approvalId:next.approvalId,claimToken:claimNext.claimToken,actor:'Synthetic executor'}),/source changed/);
 assert.equal((await c.query('select count(*)::int as n from artifacts where kind=\'context_correction\'')).rows[0].n,1);
 await c.query(`update project_files set content_hash=$1 where project_id=$2`,[sourceHash,run.projectId]);
 const secondRun=await createWorkflowRun({projectName:'Synthetic',projectRootUri:project,projectProfile:'custom',projectConfig:{},workflow:workflows.find(v=>v.value.id==='build-feature')!.value,task:'Synthetic cross-run correction',autonomy:'1',policyProfile:'local',policySnapshot:{},policySnapshotHash:'hash'});
 const cross=await requestContextCorrection(project,{...input,runId:secondRun.runId,previousReceiptId:history.entries[0].id,after:'Cross-run corrected fact'});const crossClaim=await claim(cross.approvalId);await executeContextCorrection({approvalId:cross.approvalId,claimToken:crossClaim.claimToken,actor:'Synthetic executor'});
 history=await readContextCorrections(project,node.id);assert.equal(history.entries[0].metadata.after,'Cross-run corrected fact');assert.equal((await verifyRunReceiptChain(secondRun.runId)).valid,true);

 await c.query('begin');for(let i=0;i<22;i++)await appendActionReceipt(c,{runId:run.runId,agentId:'workflow-orchestrator',actionType:'context_correction_recorded',target:node.id,summary:'Synthetic bounded history',metadata:JSON.stringify(history.entries[0].metadata)});await c.query('commit');history=await readContextCorrections(project,node.id);assert.equal(history.entries.length,20);assert.equal(history.truncated,true);assert.equal((await verifyRunReceiptChain(run.runId)).valid,true);
 }finally{await c.end();}}finally{if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid<>pg_backend_pid()',[name]);await admin.query(`drop database if exists ${name}`);await admin.end();}
});
