import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Client } from 'pg';
import { acceptanceDigest } from './acceptance.js';
import type { CoordinatorClaim } from './queue-coordinator.js';
import { RepairedRevisionProofError,captureRepairRevisionManifest,captureRepairRevisionBaselineOnClient,effectiveRepairContractOnClient,repairRevisionRequirementsDigest,repairRevisionManifestHash,repairedRevisionSchemaSql } from './repaired-revision.js';
import { sourceSubjectHash } from '../../workflow-engine/src/source-subject.js';

test('equivalent new run identity cannot alter any original deliverable requirement',()=>{
 const contract={originRunId:'old',subjectHash:'before',deliverables:[{id:'fix',description:'Exact original requirement',requiredGates:['implementation','verification','packaging','supervision'],advisory:false,severity:'block',status:'pending',receipts:{},gaps:[]}]};
 const digest=repairRevisionRequirementsDigest(contract);
 assert.equal(repairRevisionRequirementsDigest({...contract,originRunId:'new',subjectHash:'after'}),digest);
 for(const change of [{id:'another'},{description:'weakened'},{requiredGates:['verification']},{advisory:true},{severity:'info'}]){
  assert.notEqual(repairRevisionRequirementsDigest({...contract,deliverables:[{...contract.deliverables[0],...change}]}),digest);
 }
 assert.throws(()=>repairRevisionRequirementsDigest({deliverables:[]}));
});

test('manifest hash matches exact enrolled source algorithm including mode',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'revision-manifest-'));
 try{
  await fs.writeFile(path.join(root,'source.txt'),'synthetic source');
  const stat=await fs.stat(path.join(root,'source.txt'));
  const manifest=[{path:'source.txt',mode:stat.mode&0o777,hash:createHash('sha256').update('synthetic source').digest('hex')}];
  assert.equal(repairRevisionManifestHash(manifest),await sourceSubjectHash(root,['source.txt']));
  assert.deepEqual(await captureRepairRevisionManifest(root,['source.txt']),manifest);
  assert.notEqual(repairRevisionManifestHash([{...manifest[0],mode:0}]),repairRevisionManifestHash(manifest));
  await fs.writeFile(path.join(root,'source.txt'),'changed source');
  assert.notEqual(repairRevisionManifestHash(await captureRepairRevisionManifest(root,['source.txt'])),repairRevisionManifestHash(manifest));
  await fs.symlink(path.join(root,'source.txt'),path.join(root,'linked.txt'));
  await assert.rejects(captureRepairRevisionManifest(root,['linked.txt']),/symlink/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('revision evidence schema adds append-only records without mutating original workflows',()=>{
 assert.match(repairedRevisionSchemaSql,/before update or delete/);
 assert.match(repairedRevisionSchemaSql,/raise exception 'Repaired revision records are immutable'/);
 assert.doesNotMatch(repairedRevisionSchemaSql,/update workflow_runs|delete from workflow_runs|alter table workflow_runs/);
});

test('frozen original contracts never fall back to legacy enrollment or accept a swapped enrollment identity',async()=>{
 const claim={sourceRunId:'original',projectId:'project',fileScopes:['source.ts']};
 const contract={version:1,contractId:'frozen',originRunId:'original',projectId:'project',taskHash:acceptanceDigest('Full original task'),subjectHash:'before',sourcePaths:claim.fileScopes,deliverables:[{id:'original',description:'Full original task',requiredGates:['implementation','verification','packaging','supervision']}]};
 const source={project_key:'project',task:'Full original task',evaluation_metadata:{acceptanceContract:contract}};
 const client={query:async()=>{throw new Error('Frozen originals must not query legacy enrollment');}} as unknown as Client;
 const effective=await effectiveRepairContractOnClient(client,source,claim);
 assert.equal(effective.contract,contract);assert.equal(effective.legacy,null);
 await assert.rejects(effectiveRepairContractOnClient(client,source,{...claim,legacyEnrollmentId:'forged'}),/enrollment binding/);
 await assert.rejects(effectiveRepairContractOnClient(client,{...source,evaluation_metadata:{acceptanceContract:{...contract,version:2}}},claim),/frozen contract/);
});

test('missing original contracts require stored validated enrollment rather than caller-supplied legacy identity',async()=>{
 const client={query:async()=>({rows:[],rowCount:0})} as unknown as Client;
 const source={project_key:'project',task:'Full original task',evaluation_metadata:{}};
 const claim={sourceRunId:'original',projectId:'project',fileScopes:['source.ts']};
 await assert.rejects(effectiveRepairContractOnClient(client,source,claim),/frozen contract/);
 await assert.rejects(effectiveRepairContractOnClient(client,source,{...claim,legacyEnrollmentId:'forged'}),/enrollment binding/);
});

test('legacy no-diff candidate retains exact stored provenance and independent four-gate verification',async()=>{
 const source=await fs.readFile(new URL('./repaired-revision.ts',import.meta.url),'utf8');
 assert.match(source,/!writes\.length&&!effective\.legacy/);
 assert.match(source,/repairedHash===contract\.subjectHash&&!effective\.legacy/);
 assert.match(source,/baseline\.legacyEnrollmentId!==claim\.legacyEnrollmentId/);
 assert.match(source,/candidate\.legacyEnrollmentId!==claim\.legacyEnrollmentId/);
 assert.match(source,/row\.payload\.legacyEnrollmentId!==candidate\.legacyEnrollmentId/);
 assert.match(source,/sameOriginalRoute\(source,verification,effective\)/);
 assert.match(source,/Four-gate acceptance or current repaired source missing/);
});

test('expected proof holds are typed without relabeling infrastructure failures',async()=>{
 assert.throws(()=>repairRevisionRequirementsDigest({deliverables:[]}),RepairedRevisionProofError);
 const unavailable=new Error('synthetic database connection failure');
 const client={query:async()=>{throw unavailable;}} as unknown as Client;
 const claim={} as CoordinatorClaim;
 await assert.rejects(captureRepairRevisionBaselineOnClient(client,claim),error=>error===unavailable&&!(error instanceof RepairedRevisionProofError));
});

test('default baseline reads actual filesystem and refuses stale content or mode',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'revision-baseline-'));
 try{
  await fs.writeFile(path.join(root,'source.txt'),'original source');
  const claim:CoordinatorClaim={id:'claim',fence:'1',familyId:'family',sourceRunId:'source',projectId:'project',projectRootUri:root,role:'repair',lane:1,owner:'repair-owner',fingerprint:'failure',intentFence:'1',fileScopes:['source.txt']};
  const contract={version:1,contractId:'original',originRunId:'source',projectId:'project',taskHash:acceptanceDigest('original task'),subjectHash:await sourceSubjectHash(root,claim.fileScopes),sourcePaths:claim.fileScopes,deliverables:[{id:'fix',description:'Original exact requirements',requiredGates:['implementation','verification','packaging','supervision']}]};
  const mock={query:async(sql:string)=>{
   if(sql.includes('from queue_coordinator_assignments q'))return {rows:[{source_run_id:'source',project_id:'project',root_uri:root,intent_fence:'1',family_id:'family',lane:1,fingerprint:'failure',file_scopes:claim.fileScopes,child_id:null}],rowCount:1};
   if(sql.startsWith('select file_scopes'))return {rows:[{file_scopes:claim.fileScopes}],rowCount:1};
   if(sql.startsWith('select *,id::text'))return {rows:[{project_key:'project',task:'original task',evaluation_metadata:{acceptanceContract:contract}}],rowCount:1};
   return {rows:[],rowCount:0};
  }} as unknown as Client;
  const hooks={chain:async()=>true,audit:async()=>{}};
  const baseline=await captureRepairRevisionBaselineOnClient(mock,claim,hooks);
  assert.equal(baseline.sourceHash,contract.subjectHash);
  await fs.writeFile(path.join(root,'source.txt'),'unreceipted replacement');
  await assert.rejects(captureRepairRevisionBaselineOnClient(mock,claim,hooks),/preimage/);
  await fs.writeFile(path.join(root,'source.txt'),'original source');
  const stat=await fs.stat(path.join(root,'source.txt'));
  await fs.chmod(path.join(root,'source.txt'),(stat.mode&0o777)^0o100);
  await assert.rejects(captureRepairRevisionBaselineOnClient(mock,claim,hooks),/preimage/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
