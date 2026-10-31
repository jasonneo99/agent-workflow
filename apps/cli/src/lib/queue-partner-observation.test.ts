import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {partnerQueueObservation,readPartnerQueueObservation,recordPartnerQueueObservation} from './queue-partner-observation.js';
const report=()=>({at:new Date().toISOString(),scope:'queue',executionEnabled:true,inventory:3,holds:[{familyId:'a'},{familyId:'a'},{familyId:'b'}]});
test('only completed executing queue passes produce a bounded body-free check observation',()=>{
 const current=report(),value=partnerQueueObservation({...current,task:'private task',outcomes:[{source:'private'}]});
 assert.deepEqual(value,{version:1,authority:'evidence-only',checkedAt:current.at,inventory:3,held:2});
 for(const patch of [{executionEnabled:false},{scope:'explicit-projects'},{partial:true},{inventory:undefined},{inventory:1001},{at:'invalid'},{at:new Date(Date.now()+60000).toISOString()},{holds:null}])assert.equal(partnerQueueObservation({...current,...patch}),null);
 assert.doesNotMatch(JSON.stringify(value),/private|outcomes|task/);
});
test('real observation files are intent-scoped, monotonic, stale-aware and never created by previews',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-partner-observation-')));
 let intents=0;
 const hooks={withIntent:async(actual:string,write:()=>Promise<void>)=>{assert.equal(actual,root);intents++;await write();}};
 try{
  assert.equal(await readPartnerQueueObservation(root),null);
  assert.equal(await recordPartnerQueueObservation(root,{...report(),executionEnabled:false},hooks),false);assert.equal(intents,0);
  const current=report();assert.equal(await recordPartnerQueueObservation(root,current,hooks),true);assert.equal(intents,1);
  assert.deepEqual(await readPartnerQueueObservation(root),{...partnerQueueObservation(current),stale:false});
  assert.equal(await recordPartnerQueueObservation(root,{...current,at:new Date(Date.parse(current.at)-1000).toISOString()},hooks),false);
  assert.equal((await readPartnerQueueObservation(root,Date.parse(current.at)+46000))?.stale,true);
  const files=await fs.readdir(path.join(root,'.agent-workflow/runtime/queue-partner-observation'));assert.deepEqual(files,['latest.json']);
  const failed={withIntent:async()=>{throw Error('Another observer owns the scope');}};
  await assert.rejects(recordPartnerQueueObservation(root,report(),failed),/Another observer/);
  assert.equal((await readPartnerQueueObservation(root))?.checkedAt,current.at);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('malformed and symlinked observation files cannot produce a live check',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-partner-observation-'))),dir=path.join(root,'.agent-workflow/runtime/queue-partner-observation');
 try{
  await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'latest.json');
  await fs.writeFile(file,JSON.stringify({...partnerQueueObservation(report()),inventory:-1}));assert.equal(await readPartnerQueueObservation(root),null);
  await fs.writeFile(file,'x'.repeat(4097));assert.equal(await readPartnerQueueObservation(root),null);
  await fs.unlink(file);const target=path.join(root,'foreign.json');await fs.writeFile(target,JSON.stringify(partnerQueueObservation(report())));await fs.symlink(target,file);
  assert.equal(await readPartnerQueueObservation(root),null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
