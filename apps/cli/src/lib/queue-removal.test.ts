import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {failedCardRemovalSnapshot,parseFailedCardRemovals,removeReviewedFailedCards} from './queue-removal.js';
test('manual selection includes only displayed failed cards and binds original task bytes',()=>{
 const runId=randomUUID(),items=[{runId,runStatus:'failed',task:'Original requirement'},...['running','queued','blocked','completed'].map(runStatus=>({runId:randomUUID(),runStatus,task:'Other work'}))];
 const selected=failedCardRemovalSnapshot(items);assert.equal(selected.length,1);assert.equal(selected[0].runId,runId);
 assert.notEqual(selected[0].taskDigest,failedCardRemovalSnapshot([{...items[0],task:'Changed requirement'}])[0].taskDigest);
 assert.deepEqual(parseFailedCardRemovals(JSON.stringify(selected)),selected);
});
test('malformed, duplicate and broad selections are refused before effects',()=>{
 const item={runId:randomUUID(),taskDigest:'a'.repeat(64)};
 for(const value of ['','all','[]',JSON.stringify([item,item]),JSON.stringify([{...item,runId:'*'}]),JSON.stringify([{...item,taskDigest:''}]),JSON.stringify([{...item,authority:'human'}])])assert.throws(()=>parseFailedCardRemovals(value));
});
test('family-card removal binds every selected failed attempt and does not resurrect withdrawn history',()=>{
 const first={runId:randomUUID(),taskDigest:'a'.repeat(64)},older={runId:randomUUID(),taskDigest:'b'.repeat(64)};
 const card={runId:first.runId,runStatus:'failed',task:'Current attempt',failedRemovalCandidates:[first,older]};
 assert.deepEqual(failedCardRemovalSnapshot([card,card]),[first,older]);
 assert.deepEqual(failedCardRemovalSnapshot([{...card,failedRemovalCandidates:[]}]),[]);
});
test('partial manual removal retains successful receipts and reports every refused item',async()=>{
 const items=Array.from({length:3},()=>({runId:randomUUID(),taskDigest:'a'.repeat(64)})),calls:string[]=[];
 const result=await removeReviewedFailedCards(items,async item=>{calls.push(item.runId);if(item===items[1])throw Error('Unresolved effect');return {ok:item===items[0],error:'Source changed'};});
 assert.deepEqual(calls,items.map(item=>item.runId));assert.deepEqual(result.removed,[items[0].runId]);
 assert.deepEqual(result.refused.map(item=>item.reason),['Unresolved effect','Source changed']);
});
