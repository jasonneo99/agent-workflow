import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readFileSync} from 'node:fs';
import {readQueuePlanControl,restrictedSourceFamilies} from './queue-plan-control.js';

test('plan control restricts new admission without creating execution authority',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'queue-plan-control-'));
 try{
  assert.equal((await readQueuePlanControl(root)).phase,'normal');
  const target=path.join(root,'.agent-workflow/runtime/queue-plan-control.json');await fs.mkdir(path.dirname(target),{recursive:true});
  await fs.writeFile(target,JSON.stringify({version:1,phase:'reconciling',reason:'Review current outcomes first.'}));
  assert.equal((await readQueuePlanControl(root)).phase,'reconciling');
  const source='11111111-1111-4111-8111-111111111111';
  await fs.writeFile(target,JSON.stringify({version:1,phase:'normal',reason:'One source canary; ordinary policy still applies.',sourceRunIds:[source]}));
  assert.deepEqual((await readQueuePlanControl(root)).sourceRunIds,[source]);
  for(const sourceRunIds of [[],['foreign'],[source,source],source]){
   await fs.writeFile(target,JSON.stringify({version:1,phase:'normal',reason:'Malformed restriction',sourceRunIds}));
   assert.equal((await readQueuePlanControl(root)).phase,'reconciling');
  }
  for(const value of ['{',JSON.stringify({version:1,phase:'execute-all',reason:'untrusted'}),JSON.stringify({version:1,phase:'normal',reason:''}),' '.repeat(4097)]){
   await fs.writeFile(target,value);assert.equal((await readQueuePlanControl(root)).phase,'reconciling');
  }
  await fs.unlink(target);await fs.symlink(path.join(root,'missing-control'),target);
  assert.equal((await readQueuePlanControl(root)).phase,'reconciling','A symlink must not be treated as an absent restriction');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('canary source restriction selects only an already-enrolled exact original and cannot add a family',()=>{
 const families=[{familyId:'one',sourceRunId:'source-one'},{familyId:'two',sourceRunId:'source-two'},{familyId:'unenrolled',sourceRunId:'source-three'}];
 const enrolled=new Set(['one','two']);
 assert.deepEqual([...restrictedSourceFamilies(families,enrolled,['source-two','source-three'])],['two']);
 assert.deepEqual([...restrictedSourceFamilies(families,enrolled,['descendant-of-one'])],[]);
 assert.deepEqual([...enrolled],['one','two']);
});
test('reconciliation control is consulted before discovery, enrollment or automatic recovery',()=>{
 const code=readFileSync(new URL('../commands/queue-coordinator.ts',import.meta.url),'utf8'),start=code.indexOf('const pass=async('),pass=code.slice(start);
 assert.ok(pass.indexOf('readQueuePlanControl(ctx.rootDir)')>=0);
 assert.ok(pass.indexOf('readQueuePlanControl(ctx.rootDir)')<pass.indexOf('discoverPartnerProjects()'));
 assert.match(pass,/planControl\.phase==='reconciling'[\s\S]*?executionEnabled:false[\s\S]*?newItemLimit:0/);
});
