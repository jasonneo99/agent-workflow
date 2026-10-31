import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyQueueWait} from './queue-wait-reasons.js';

const now=Date.parse('2026-01-01T00:10:00Z');
const row=(patch:Record<string,unknown>={})=>({runId:'11111111-1111-4111-8111-111111111111',available:true,availableAt:'2026-01-01T00:00:00Z',waitSince:'2026-01-01T00:00:00Z',runStatus:'running',coordinatorClaim:false,coordinatorReady:true,requiredProvider:null,allowedPlatforms:[],projectActive:0,dependencyBlocked:false,serialBlocked:false,checkoutUnavailable:false,...patch});
const worker={status:'running',providerIds:['codex-cli'],workerId:'worker',perProjectConcurrency:5};

test('wait reasons identify the first authoritative scheduler constraint',()=>{
 assert.equal(classifyQueueWait(row({available:false,availableAt:'2026-01-01T00:20:00Z'}),worker,now).category,'backoff');
 assert.equal(classifyQueueWait(row({coordinatorClaim:true,coordinatorReady:false}),worker,now).category,'intent-conflict');
 assert.equal(classifyQueueWait(row({coordinatorClaim:true}),worker,now).category,'dedicated-owner');
 assert.equal(classifyQueueWait(row({requiredProvider:'anthropic'}),worker,now).category,'provider');
 assert.equal(classifyQueueWait(row({projectActive:5}),worker,now).category,'capacity');
 assert.equal(classifyQueueWait(row({dependencyBlocked:true}),worker,now).category,'dependency');
 assert.equal(classifyQueueWait(row(),worker,now).category,'eligible');
});

test('class-specific wait budgets become alerts without changing eligibility',()=>{
 const reason=classifyQueueWait(row(),worker,now);assert.equal(reason.overdue,true);assert.equal(reason.budgetMs,30_000);assert.match(reason.reason,/Eligible/);
});
