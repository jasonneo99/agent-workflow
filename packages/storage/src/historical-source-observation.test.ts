import test from 'node:test';
import assert from 'node:assert/strict';
import {observeHistoricalSourceEffects} from './historical-source-observation.js';

function fixture(){
 const metadata={relativePath:'source.ts',nextHash:'a'.repeat(64),outcome:'applied',existed:true,bytesWritten:12};
 return {files:['source.ts'],review:{receiptHashes:['b'.repeat(64)],artifactUris:['synthetic://write']},
  receipts:[{action_type:'file_write',target:'source.ts',receipt_hash:'b'.repeat(64),metadata}],
  artifacts:[{uri:'synthetic://write',kind:'file_write',content:{...metadata}}]};
}
test('complete paired source observation preserves uncertainty and grants no replay or acceptance',()=>{
 const value=observeHistoricalSourceEffects(fixture());
 assert.equal(value.historicalPreimagesVerified,false);assert.equal(value.replayAuthorized,false);assert.equal(value.originalAcceptance,false);
 const changed=fixture();changed.artifacts[0].content.nextHash='c'.repeat(64);
 assert.throws(()=>observeHistoricalSourceEffects(changed));
});
test('deletes, external effects, unreviewed evidence, missing scope and ambiguous pairing are refused',()=>{
 for(const mutate of [
  (f:ReturnType<typeof fixture>)=>{f.receipts[0].action_type='file_delete';},
  (f:ReturnType<typeof fixture>)=>{f.receipts[0].action_type='external_action';},
  (f:ReturnType<typeof fixture>)=>{f.review.receiptHashes=[];},
  (f:ReturnType<typeof fixture>)=>{f.review.artifactUris=[];},
  (f:ReturnType<typeof fixture>)=>{f.files=[];},
  (f:ReturnType<typeof fixture>)=>{f.receipts[0].metadata.outcome='uncertain';},
  (f:ReturnType<typeof fixture>)=>{f.artifacts[0].kind='executor_output';},
  (f:ReturnType<typeof fixture>)=>{f.receipts[0].metadata.bytesWritten=-1;},
  (f:ReturnType<typeof fixture>)=>{f.receipts.push({...f.receipts[0]});f.review.receiptHashes.push(f.receipts[0].receipt_hash);},
 ]){const f=fixture();mutate(f);assert.throws(()=>observeHistoricalSourceEffects(f));}
});
