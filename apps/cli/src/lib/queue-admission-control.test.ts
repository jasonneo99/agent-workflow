import assert from 'node:assert/strict';
import test from 'node:test';
import {deriveQueueAdmissionPressure} from './queue-admission-control.js';

const now=Date.parse('2026-10-26T21:00:00Z');
const worker={status:'running',lastHeartbeatAt:'2026-10-26T20:59:55Z',providerIds:['codex-cli'],concurrency:5};

test('admission exposes only measured free live worker capacity',()=>{
 assert.deepEqual(deriveQueueAdmissionPressure({storageReady:true,activeTasks:2,worker,now}),{storageReady:true,providerReady:true,verifierReady:true,newItemLimit:3,availableProviders:['codex-cli'],unavailableProviders:[]});
 assert.deepEqual(deriveQueueAdmissionPressure({storageReady:true,activeTasks:5,worker,now}),{storageReady:true,providerReady:true,verifierReady:false,newItemLimit:0,availableProviders:['codex-cli'],unavailableProviders:[]});
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,worker:{...worker,concurrency:12},now}).newItemLimit,5,'The shared hard ceiling is five even when a worker advertises more');
});
test('stale, providerless, stopped or invalid worker evidence fails closed for new reservations',()=>{
 for(const patch of [{lastHeartbeatAt:'2026-10-26T20:59:00Z'},{providerIds:[]},{status:'stopped'},{concurrency:NaN}]){
  const result=deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,worker:{...worker,...patch},now});assert.equal(result.newItemLimit,0);assert.equal(result.verifierReady,false);
 }
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:NaN,worker,now}).newItemLimit,0);
});
test('storage pressure blocks new admission independently of worker readiness',()=>{
 assert.deepEqual(deriveQueueAdmissionPressure({storageReady:false,activeTasks:0,worker,now}),{storageReady:false,providerReady:true,verifierReady:true,newItemLimit:0,availableProviders:['codex-cli'],unavailableProviders:[]});
});
test('exact restrictive reservations reduce shared admission without claiming running work',()=>{
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,reservedItems:4,worker:{...worker,concurrency:7},now}).newItemLimit,1);
 const full=deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,reservedItems:5,worker:{...worker,concurrency:7},now});assert.equal(full.newItemLimit,0);
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,reservedItems:NaN,worker,now}).newItemLimit,0);
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,reservedItems:1,verifierReserved:true,worker,now}).verifierReady,false);
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:5,reservedItems:0,worker:{...worker,concurrency:12},now}).newItemLimit,0,'Already observed five active tasks cannot be hidden by fewer family reservations');
});
test('an active provider circuit applies backpressure until its cooldown expires',()=>{
 const circuits={'codex-cli:tier-default':{openedAt:now-10_000}};
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,worker,circuits,now}).providerReady,false);
 assert.deepEqual(deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,worker,circuits,now}).unavailableProviders,['codex-cli']);
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,worker:{...worker,lastHeartbeatAt:'2026-10-26T21:00:55Z'},circuits,now:now+60_000}).providerReady,true);
 assert.equal(deriveQueueAdmissionPressure({storageReady:true,activeTasks:0,worker,circuits:null,now}).providerReady,false,'Unreadable circuit evidence fails closed');
});
