import assert from 'node:assert/strict';
import test from 'node:test';
import {discoverPartnerProjects,partnerProjectAccess,type PartnerProject} from './queue-partner-projects.js';
const project=(id='11111111-1111-4111-8111-111111111111',root='/synthetic/alpha'):PartnerProject=>({id,name:'Synthetic project',rootUri:root,canonical:true});
test('canonical registered roots must exist exactly, never inherit permissions from aliases or mirrors',async()=>{
 const exact=async(root:string)=>root;
 assert.equal(await partnerProjectAccess(project(),exact),null);
 for(const patch of [{canonical:false},{rootUri:'/synthetic/vendor/source'},{rootUri:'/synthetic/node_modules/source'},{rootUri:'relative'},{rootUri:'/synthetic/../source'},{id:'invalid'}])assert.ok(await partnerProjectAccess({...project(),...patch},exact));
 assert.match(await partnerProjectAccess(project(),async()=>'/synthetic/different')??'',/alias/);
 assert.match(await partnerProjectAccess(project(),async()=>{throw Error('unavailable')})??'',/unavailable/);
});
test('each pass discovers newly queued projects; unavailable owners remain explicit holds',async()=>{
 const a=project(),b=project('22222222-2222-4222-8222-222222222222','/synthetic/beta');let rows=[a];
 const check=async(p:PartnerProject)=>p.rootUri==='/synthetic/missing'?'Exact project access missing':null;
 assert.deepEqual((await discoverPartnerProjects(async()=>rows,check)).projects,[a]);
 rows=[a,b,project('33333333-3333-4333-8333-333333333333','/synthetic/missing')];
 const next=await discoverPartnerProjects(async()=>rows,check);assert.deepEqual(next.projects,[a,b]);assert.equal(next.holds[0].projectId,rows[2].id);assert.match(next.holds[0].reason,/access missing/);
});
test('incomplete queue-wide discovery fails closed instead of silently dispatching a subset',async()=>{
 const result=await discoverPartnerProjects(async()=>Array.from({length:201},()=>project()),async()=>null);
 assert.equal(result.truncated,true);assert.deepEqual(result.projects,[]);assert.match(result.holds[0].reason,/exceeds 200/);
});
