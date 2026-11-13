import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveWorkIntentProject} from './work-intent-project.js';
const id='11111111-1111-4111-8111-111111111111',root='/projects/example';
test('canonical path and exact project ID resolve to the same intent namespace',async()=>{
 const hooks={realpath:async(p:string)=>p,lookup:async(p:string)=>p===root?[{id,root}]:[]};
 assert.equal(await resolveWorkIntentProject(root,hooks),id);
 assert.equal(await resolveWorkIntentProject(id,hooks),id);
 assert.equal(await resolveWorkIntentProject('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',hooks),'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
});
test('parent, child, alias, ambiguous and vendor paths never inherit a project lock identity',async()=>{
 const hooks={realpath:async(p:string)=>p,lookup:async()=>[{id,root}]};
 for(const p of ['/projects','/projects/example/child','/projects/example-extra','/projects/example/vendor/product','/projects/example/Vendor/product','/projects/example/NODE_MODULES/product'])await assert.rejects(()=>resolveWorkIntentProject(p,hooks));
 await assert.rejects(()=>resolveWorkIntentProject(root,{...hooks,realpath:async()=>'/other/project'}),/aliases/);
 await assert.rejects(()=>resolveWorkIntentProject(root,{...hooks,lookup:async()=>[{id,root},{id,root}]}),/Exact canonical/);
 await assert.rejects(()=>resolveWorkIntentProject(root,{...hooks,lookup:async()=>[]}),/Exact canonical/);
});
