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

test('malformed and missing availability timestamps retain an honest hold without throwing',()=>{
 for(const availableAt of ['infinity','not-a-date','',null,undefined]){
  const reason=classifyQueueWait(row({available:false,availableAt}),worker,now);
  assert.equal(reason.category,'availability-unknown');assert.match(reason.reason,/missing or invalid/);assert.equal(reason.overdue,false);
  assert.ok(Number.isFinite(reason.waitedMs));assert.ok(Number.isFinite(reason.budgetMs));
 }
 const backoff=classifyQueueWait(row({available:false,availableAt:'2026-01-01T00:20:00Z'}),worker,now);
 assert.equal(backoff.category,'backoff');assert.match(backoff.reason,/2026-01-01T00:20:00.000Z/);
});
test('unknown wait start times never fabricate elapsed time or overdue alerts; prepared entries remain paused',()=>{
 for(const waitSince of ['infinity','invalid','',null,undefined]){
  const reason=classifyQueueWait(row({waitSince}),worker,now);
  assert.equal(reason.category,'eligible');assert.equal(reason.timingKnown,false);assert.equal(reason.waitedMs,0);assert.equal(reason.overdue,false);assert.match(reason.reason,/start time is unavailable/);
 }
 const prepared=classifyQueueWait(row({preparedOnly:true,available:false,availableAt:'infinity',waitSince:'infinity'}),worker,now);
 assert.equal(prepared.category,'prepared');assert.match(prepared.reason,/explicit activation/);assert.equal(prepared.overdue,false);
});
