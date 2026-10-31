import assert from 'node:assert/strict';
import test from 'node:test';
import {currentQueueCounts,queueHistoryRangeMinutes,queueHistoryReadQuery,queueHistorySignals} from './queue-history.js';

test('queue history separates current delivery states without treating completion as current work',()=>{
 assert.deepEqual(currentQueueCounts([{runStatus:'running',runningTasks:1},{runStatus:'running',queuedTasks:1},{runStatus:'queued',queuedTasks:1},{runStatus:'blocked'},{runStatus:'failed'},{runStatus:'completed'}]),{active:1,waiting:2,blocked:1,failed:1});
});

test('parent running status without task activity is not counted as active',()=>{
 assert.deepEqual(currentQueueCounts([{runStatus:'running',queuedTasks:0,runningTasks:0}]),{active:0,waiting:0,blocked:0,failed:0});
});

test('queue history accepts only bounded named minute ranges',()=>{
 assert.equal(queueHistoryRangeMinutes('1h'),60);
 assert.equal(queueHistoryRangeMinutes('6h'),360);
 assert.equal(queueHistoryRangeMinutes('24h'),1440);
 assert.equal(queueHistoryRangeMinutes('all'),60);
});

test('completed totals accumulate from the selected range start through each observed minute',()=>{
 assert.match(queueHistoryReadQuery,/generate_series/);
 assert.match(queueHistoryReadQuery,/coalesce\(max\(t\.finished_at\),r\.updated_at\) completed_at/);
 assert.match(queueHistoryReadQuery,/date_trunc\('minute',r\.completed_at\)/);
 assert.match(queueHistoryReadQuery,/sum\(coalesce\(c\.completed,0\)\) over\(order by minute rows between unbounded preceding and current row\)/);
 assert.doesNotMatch(queueHistoryReadQuery,/left join completed\s+c\b/u);
});

test('queue changes become status-aware display and Partner action signals',()=>{
 const signals=queueHistorySignals([
  {at:'2026-10-29T10:00:00Z',active:5,waiting:4,blocked:1,failed:2,completed:0},
  {at:'2026-10-29T10:05:00Z',active:3,waiting:2,blocked:3,failed:1,completed:6}
 ]);
 assert.deepEqual(signals.map(({status,delta,tone})=>({status,delta,tone})),[
  {status:'blocked',delta:2,tone:'warning'},{status:'failed',delta:-1,tone:'positive'},
  {status:'waiting',delta:-2,tone:'positive'},{status:'active',delta:-2,tone:'warning'},
  {status:'completed',delta:6,tone:'positive'}
 ]);
 assert.match(signals[0].partnerAction,/newly blocked/);
 assert.match(signals.at(-1)!.partnerAction,/throughput evidence/);
 assert.deepEqual(queueHistorySignals([{at:'2026-10-29T10:00:00Z',active:1,waiting:0,blocked:0,failed:0,completed:0}]),[]);
});

test('blocked or failed growth without completions tells Partner to stop sibling amplification and repair the shared cause',()=>{
 const signals=queueHistorySignals([
  {at:'2026-10-29T10:00:00Z',active:3,waiting:0,blocked:24,failed:0,completed:1},
  {at:'2026-10-29T10:10:00Z',active:2,waiting:1,blocked:33,failed:1,completed:1}
 ]);
 for(const signal of signals.filter(item=>item.status==='blocked'||item.status==='failed')){
  assert.match(signal.partnerAction,/Pause sibling recovery dispatch/);
  assert.match(signal.partnerAction,/preserve live lease owners/);
  assert.match(signal.partnerAction,/repair the shared transport or runtime once/);
  assert.match(signal.partnerAction,/reconcile only duplicates/);
 }
});
