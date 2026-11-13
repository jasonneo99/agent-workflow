import test from 'node:test';
import assert from 'node:assert/strict';
import {workIntentProjectId,acquireWorkIntent,renewWorkIntent,releaseWorkIntent,listWorkIntents} from './reliability.js';
test('SDK work-intent identities normalize UUIDs and reject split path namespaces before storage',async()=>{
 assert.equal(workIntentProjectId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 for(const projectId of ['/projects/example','example',' ../example','', '11111111-1111-4111-8111-111111111111 ']){
  assert.throws(()=>workIntentProjectId(projectId),/exact project UUID/);
  await assert.rejects(acquireWorkIntent({projectId,owner:'fixture',objective:'fixture'}),/exact project UUID/);
  await assert.rejects(renewWorkIntent({projectId,owner:'fixture',fencingToken:'1'}),/exact project UUID/);
  await assert.rejects(releaseWorkIntent({projectId,owner:'fixture',fencingToken:'1'}),/exact project UUID/);
  await assert.rejects(listWorkIntents(projectId),/exact project UUID/);
 }
});
