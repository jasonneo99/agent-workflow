import test from 'node:test';
import assert from 'node:assert/strict';
import {deterministicPrewriteRejection,type RejectedWriteProof} from './rejected-write-reconciliation.js';
import {actionIdempotencyKey} from '../../workflow-engine/src/action-receipts.js';
const proof:RejectedWriteProof={runId:'run',taskId:'task',stageId:'stage',agentId:'agent',target:'docs/example.md',patch:'@@ -1 +1 @@\n-old\n+new\n+extra\n',expectedHash:'a'.repeat(64),idempotencyKey:'',rejectionUri:'artifact://example',rejectionReceiptHash:'b'.repeat(64)};
proof.idempotencyKey=actionIdempotencyKey({...proof,actionType:'file_write',payload:JSON.stringify({patch:proof.patch,expectedHash:proof.expectedHash})});
test('exact historical request permits only deterministic before-write errors',()=>{
 assert.equal(deterministicPrewriteRejection(proof,'File patch rejected: hunk count mismatch; expected -1/+1, received -1/+2.'),true);
 assert.equal(deterministicPrewriteRejection(proof,`File patch rejected: stale preimage hash for docs/example.md; expected ${proof.expectedHash}, found ${'c'.repeat(64)}.`),true);
 for(const error of ['EIO: write failed','Permission denied','No changes needed','File patch rejected: preimage changed before write.','File patch rejected: hunk count mismatch; expected -1/+1, received -1/+2. extra'])assert.equal(deterministicPrewriteRejection(proof,error),false);
});
test('request, preimage, actor, path and request-key drift fail closed',()=>{
 const error='File patch rejected: hunk count mismatch; expected -1/+1, received -1/+2.';
 for(const changed of [{patch:proof.patch+' '},{expectedHash:'c'.repeat(64)},{taskId:'other'},{stageId:'other'},{agentId:'other'},{target:'../outside'},{target:'/absolute'},{target:'docs/other.md'},{idempotencyKey:'f'.repeat(64)},{rejectionReceiptHash:'unhashed'}])assert.equal(deterministicPrewriteRejection({...proof,...changed},error),false);
});

import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';
import {appendActionReceipt} from './receipt-writer.js';
import {chainReceipt} from '../../workflow-engine/src/receipt-chain.js';
import {authenticateRejectedWriteProof,reconcileRejectedWriteOnClient,archiveReconciledEffectKeys} from './rejected-write-reconciliation.js';
test('PostgreSQL: exact rejected request is idempotently reconciled without changing reservation or run; ambiguity and tampering fail',async()=>{
 await withClient(async c=>{await c.query('begin');try{
 const schema='rejected_write_'+randomUUID().replaceAll('-','');
 await c.query(`create schema ${schema};set local search_path to ${schema},public;
 create table workflow_runs(id uuid primary key,project_id uuid,status text);
 create table workflow_tasks(id uuid primary key,run_id uuid,stage_id text,agent_id text,status text);
 create table side_effect_receipts(project_id text,idempotency_key text,operation text,target text,receipt jsonb,status text,claim_expires_at timestamptz,created_at timestamptz);
 create table artifacts(id uuid default gen_random_uuid(),run_id uuid,task_id uuid,kind text,uri text,content jsonb,created_at timestamptz default clock_timestamp());
 create table agents(id text primary key);
 insert into agents values('agent'),('operator'),('workflow-orchestrator');
 create table action_receipts(id uuid default gen_random_uuid(),run_id uuid,agent_id text references agents(id),action_type text,target text,summary text,metadata jsonb,prev_hash text,receipt_hash text,metadata_serialization_version int,created_at timestamptz);
 create table work_intents(project_id text,owner text,fencing_token bigint,expires_at timestamptz,file_scopes jsonb);`);
 const runId=randomUUID(),taskId=randomUUID(),projectId=randomUUID(),rejectionUri=`db://workflow_runs/${runId}/action_rejection/example`,authorizationArtifactUri=`db://workflow_runs/${runId}/direct_human_prerequisite_authorization/example`;
 const p={...proof,runId,taskId,rejectionUri};
 p.idempotencyKey=actionIdempotencyKey({...p,actionType:'file_write',payload:JSON.stringify({patch:p.patch,expectedHash:p.expectedHash})});
 await c.query("insert into workflow_runs values($1,$2,'blocked')",[runId,projectId]);
 await c.query("insert into workflow_tasks values($1,$2,$3,$4,'blocked')",[taskId,runId,p.stageId,p.agentId]);
 const createdAt=new Date(Date.now()-10800000),expires=new Date(Date.now()-7200000),rejectedAt=new Date(Date.now()-9000000);
 await c.query("insert into side_effect_receipts values($1,$2,'file_write',$3,'{}','pending',$4,$5)",[runId,p.idempotencyKey,p.target,expires,createdAt]);
 const rejection={actionType:'file_write',target:p.target,error:'File patch rejected: hunk count mismatch; expected -1/+1, received -1/+2.',requestedByTaskId:taskId,requestedByStageId:p.stageId};
 const receipt=chainReceipt('GENESIS',{runId,agentId:p.agentId,actionType:'file_write_rejected',target:p.target,summary:rejection.error,metadata:JSON.stringify(rejection),metadataSerializationVersion:2,createdAt:rejectedAt.toISOString()});p.rejectionReceiptHash=receipt.receiptHash;
 await c.query("insert into artifacts(run_id,task_id,kind,uri,content,created_at) values($1,$2,'action_rejection',$3,$4,$5)",[runId,taskId,rejectionUri,JSON.stringify(rejection),rejectedAt]);
 await c.query('insert into action_receipts(run_id,agent_id,action_type,target,summary,metadata,prev_hash,receipt_hash,metadata_serialization_version,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,2,$9)',[runId,p.agentId,'file_write_rejected',p.target,rejection.error,JSON.stringify(rejection),'GENESIS',p.rejectionReceiptHash,rejectedAt]);
 const p2={...p,patch:p.patch+'+another\n',rejectionUri:rejectionUri+'/second'};
 p2.idempotencyKey=actionIdempotencyKey({...p2,actionType:'file_write',payload:JSON.stringify({patch:p2.patch,expectedHash:p2.expectedHash})});
 const secondCreated=new Date(rejectedAt.getTime()+10000),secondRejected=new Date(rejectedAt.getTime()+20000);
 await c.query("insert into side_effect_receipts values($1,$2,'file_write',$3,'{}','pending',$4,$5)",[runId,p2.idempotencyKey,p.target,expires,secondCreated]);
 const secondRejection={...rejection,error:'File patch rejected: hunk count mismatch; expected -1/+1, received -1/+3.'};
 const secondReceipt=chainReceipt(receipt.receiptHash,{runId,agentId:p.agentId,actionType:'file_write_rejected',target:p.target,summary:secondRejection.error,metadata:JSON.stringify(secondRejection),metadataSerializationVersion:2,createdAt:secondRejected.toISOString()});p2.rejectionReceiptHash=secondReceipt.receiptHash;
 await c.query("insert into artifacts(run_id,task_id,kind,uri,content,created_at) values($1,$2,'action_rejection',$3,$4,$5)",[runId,taskId,p2.rejectionUri,JSON.stringify(secondRejection),secondRejected]);
 await c.query('insert into action_receipts(run_id,agent_id,action_type,target,summary,metadata,prev_hash,receipt_hash,metadata_serialization_version,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,2,$9)',[runId,p.agentId,'file_write_rejected',p.target,secondRejection.error,JSON.stringify(secondRejection),receipt.receiptHash,p2.rejectionReceiptHash,secondRejected]);
 const authorization={version:1,source:'direct-human-current-chat',instruction:'Fix the reconciliation prerequisites.',scope:['Exact synthetic historical rejection']};
 await c.query("insert into artifacts(run_id,kind,uri,content) values($1,'direct_human_prerequisite_authorization',$2,$3)",[runId,authorizationArtifactUri,JSON.stringify(authorization)]);
 await appendActionReceipt(c,{runId,agentId:'operator',actionType:'direct_human_prerequisite_authorization',target:authorizationArtifactUri,summary:'Synthetic retained human instruction.',metadata:JSON.stringify(authorization)});
 assert.equal(await authenticateRejectedWriteProof(c,p),true);
 assert.equal(await authenticateRejectedWriteProof(c,p2),false,'An earlier overlapping claim requires its own authenticated no-effect proof first');
 const before=(await c.query('select * from side_effect_receipts')).rows;
 const input={projectId,owner:'operator',intentFence:'1',actor:'Example Human via Client',reason:'Exact synthetic historical patch rejection',authorizationArtifactUri,confirmation:'Reconcile proven pre-write rejection only.' as const,proof:p};
 await c.query('insert into work_intents values($1,$2,1,clock_timestamp()+interval \'10 minutes\',$3)',[projectId,input.owner,JSON.stringify([`runtime/history-reconciliation/${runId}`])]);
 const uri=await reconcileRejectedWriteOnClient(c,input);
 assert.equal(await reconcileRejectedWriteOnClient(c,input),uri,'JSONB key reordering must not duplicate reconciliation');
 assert.equal((await c.query("select count(*)::int n from artifacts where kind='prewrite_rejection_reconciliation'")).rows[0].n,1);
 const humanAudit=(await c.query("select agent_id,metadata from action_receipts where action_type='prewrite_rejection_reconciled'")).rows[0];assert.equal(humanAudit.agent_id,'workflow-orchestrator');assert.equal(humanAudit.metadata.actor,'Example Human via Client');
 assert.deepEqual(await archiveReconciledEffectKeys(c,[runId]),[`${runId}:${p.idempotencyKey}`]);
 assert.equal(await authenticateRejectedWriteProof(c,p2),true,'An authenticated earlier rejection strictly before the next claim resolves only that overlap');
 assert.deepEqual((await c.query('select * from side_effect_receipts')).rows,before);
 assert.equal((await c.query('select status from workflow_runs')).rows[0].status,'blocked');
 const negatives=[
 "update side_effect_receipts set status='completed'",
 "update side_effect_receipts set operation='local_command'",
 "update side_effect_receipts set claim_expires_at=clock_timestamp()+interval '1 minute'",
 "update side_effect_receipts set receipt='{\"partialWrite\":true}'",
 "update workflow_tasks set status='running'",
 "update action_receipts set summary='tampered' where action_type='file_write_rejected'",
 "insert into side_effect_receipts select project_id,'other-key',operation,target,receipt,status,claim_expires_at,created_at from side_effect_receipts",
 `insert into artifacts(run_id,task_id,kind,content) values('${runId}','${taskId}','file_write','${JSON.stringify({idempotencyKey:p.idempotencyKey})}')`
 ];
 for(const sql of negatives){await c.query('savepoint negative_case');await c.query(sql);assert.equal(await authenticateRejectedWriteProof(c,p),false,sql);assert.deepEqual(await archiveReconciledEffectKeys(c,[runId]),[],sql);await c.query('rollback to savepoint negative_case');}
 const secondUri=await reconcileRejectedWriteOnClient(c,{...input,proof:p2});assert.equal(await reconcileRejectedWriteOnClient(c,{...input,proof:p2}),secondUri);
 assert.deepEqual((await archiveReconciledEffectKeys(c,[runId])).sort(),[`${runId}:${p.idempotencyKey}`,`${runId}:${p2.idempotencyKey}`].sort());
 await c.query('savepoint completed_attempt');await c.query("update workflow_runs set status='completed'");
 assert.equal(await authenticateRejectedWriteProof(c,p),true,'No-effect evidence does not change a completed attempt acceptance');await c.query('rollback to savepoint completed_attempt');
 await assert.rejects(reconcileRejectedWriteOnClient(c,{...input,proof:{...p,patch:p.patch+'x'}}),/proof missing/);
 await assert.rejects(reconcileRejectedWriteOnClient(c,{...input,authorizationArtifactUri:authorizationArtifactUri+'/missing'}),/authorization missing/);
 await c.query("update work_intents set expires_at=clock_timestamp()-interval '1 second'");
 await assert.rejects(reconcileRejectedWriteOnClient(c,input),/proof missing/);
 }finally{await c.query('rollback');}});
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {executeAllowedFilePatch} from '../../local-tools/src/file-patcher.js';
test('real patch executor emits both qualifying errors before changing the target',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'prewrite-proof-'));
 try{
 const target='example.txt',original='old\n',expectedHash=createHash('sha256').update(original).digest('hex');
 await fs.writeFile(path.join(cwd,target),original);
 const project=projectConfigSchema.parse({project:{name:'synthetic-reconciliation'},actions:{allowed_write_paths:[target]}});
 for(const request of [{patch:'@@ -1 +1 @@\n-old\n+new\n+extra\n',expectedHash},{patch:'@@ -1 +1 @@\n-old\n+new\n',expectedHash:'0'.repeat(64)},{patch:'@@ -1 +1 @@\n expected-different\n',expectedHash}]){
 const p={...proof,target,...request};p.idempotencyKey=actionIdempotencyKey({...p,actionType:'file_write',payload:JSON.stringify(request)});
 let error='';try{await executeAllowedFilePatch({relativePath:target,...request,cwd,project});}catch(e){error=(e as Error).message;}
 assert.equal(deterministicPrewriteRejection(p,error),true,error);
 assert.equal(await fs.readFile(path.join(cwd,target),'utf8'),original);
 }
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});
