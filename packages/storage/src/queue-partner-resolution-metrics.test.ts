import assert from 'node:assert/strict';
import test from 'node:test';
import {summarizeQueuePartnerResolutionYield} from './queue-partner-resolution-metrics.js';

test('resolution yield counts verified closure and non-resolving turns without task bodies',()=>{
 const report=summarizeQueuePartnerResolutionYield([
  {sourceRunId:'a',strategy:'repair-exact-source',state:'held',blockedSince:'2026-10-26T00:00:00Z',settledAt:'2026-10-26T00:01:00Z'},
  {sourceRunId:'a',strategy:'verify-sealed-candidate',state:'verified',blockedSince:'2026-10-26T00:00:00Z',settledAt:'2026-10-26T00:02:00Z'},
  {sourceRunId:'b',strategy:'invented',state:'failed',blockedSince:null,settledAt:'2026-10-26T00:03:00Z'}
 ]);
 assert.equal(report.totalBlockedFamiliesObserved,2);assert.equal(report.totalAcceptanceGapsClosed,1);assert.equal(JSON.stringify(report).includes('task'),false);
 assert.deepEqual(report.strategies.find(row=>row.strategy==='verify-sealed-candidate'),{strategy:'verify-sealed-candidate',blockedFamiliesObserved:1,attempts:1,acceptanceGapsClosed:1,nonResolvingTurns:0,verifiedClosureRate:1,averageTimeToVerifiedMs:120000});
 assert.equal(report.strategies.find(row=>row.strategy==='unknown')?.nonResolvingTurns,1);
 assert.deepEqual(report.adaptiveRankingShadow,{applied:false,minimumSamplesPerStrategy:20,eligibleStrategies:0,promotionEligible:false,proposedOrder:[]});
});

test('resolution yield rejects malformed time and bounds observations',()=>{
 const rows=Array.from({length:510},(_,i)=>({sourceRunId:String(i),strategy:'discover-missing-scope',state:'held',blockedSince:null,settledAt:'2026-10-26T00:00:00Z'}));
 rows.push({sourceRunId:'bad',strategy:'repair-exact-source',state:'verified',blockedSince:null,settledAt:'invalid'});
 assert.equal(summarizeQueuePartnerResolutionYield(rows).totalAttempts,500);
});

test('adaptive strategy ranking remains shadow-only and requires confident samples',()=>{
 const rows=[];
 for(let i=0;i<20;i++)rows.push({sourceRunId:`repair-${i}`,strategy:'repair-exact-source',state:i<15?'verified':'held',blockedSince:'2026-01-01T00:00:00.000Z',settledAt:`2026-01-01T00:00:${String(i+1).padStart(2,'0')}.000Z`});
 for(let i=0;i<20;i++)rows.push({sourceRunId:`discover-${i}`,strategy:'discover-missing-scope',state:i<8?'verified':'held',blockedSince:'2026-01-01T00:00:00.000Z',settledAt:`2026-01-01T00:01:${String(i+1).padStart(2,'0')}.000Z`});
 const shadow=summarizeQueuePartnerResolutionYield(rows).adaptiveRankingShadow;
 assert.equal(shadow.applied,false);assert.equal(shadow.eligibleStrategies,2);
 assert.equal(shadow.promotionEligible,true);
 assert.deepEqual(shadow.proposedOrder.map(item=>item.strategy),['repair-exact-source','discover-missing-scope']);
 assert.ok(shadow.proposedOrder[0].verifiedClosureLowerBound>shadow.proposedOrder[1].verifiedClosureLowerBound);
});
