import assert from 'node:assert/strict';
import test from 'node:test';
import {queueHistoryScript,renderQueueHistoryPanel,scoreQueueQuality} from './queue-history.js';

test('queue history panel exposes minute ranges and all requested states',()=>{
 const html=renderQueueHistoryPanel();
 assert.match(html,/Queue history/);assert.match(html,/Queue change/);assert.match(html,/Queue totals/);assert.match(html,/1 hour/);assert.match(html,/6 hours/);assert.match(html,/24 hours/);assert.match(html,/Range-relative lines/);assert.match(html,/hover for exact values/);
 assert.equal((html.match(/<details class="queue-history-disclosure" open>/g)||[]).length,2);assert.match(html,/queue-history-bars/);assert.match(html,/Stacked queue totals/);
 assert.match(html,/queue-history-tooltip/);assert.match(html,/role="tooltip"/);
 assert.match(html,/queue-history-signals/);assert.match(html,/Queue changes over the selected range/);
 assert.match(html,/queue-history-quality/);assert.match(html,/Queue quality/);assert.match(html,/Awaiting history/);
});

test('queue quality rewards throughput but never lets it hide worsening blocked or failed work',()=>{
 assert.deepEqual(scoreQueueQuality([]),{score:null,label:'Awaiting history',tone:'pending',drivers:['No minute samples yet']});
 const healthy=scoreQueueQuality([{active:2,waiting:3,blocked:0,failed:0,completed:0},{active:2,waiting:1,blocked:0,failed:0,completed:6}]);
 assert.equal(healthy.score,100);assert.equal(healthy.tone,'excellent');assert.ok(healthy.drivers.includes('+18 completed throughput'));
 const blocked=scoreQueueQuality([{active:2,waiting:2,blocked:0,failed:0,completed:0},{active:2,waiting:1,blocked:4,failed:0,completed:6}]);
 assert.equal(blocked.score,43);assert.equal(blocked.tone,'degraded');assert.ok(blocked.drivers.some(driver=>driver.includes('blocked increase')));
 const clearingBlocked=scoreQueueQuality([{active:3,waiting:0,blocked:27,failed:0,completed:0},{active:9,waiting:11,blocked:11,failed:0,completed:4}]);
 assert.equal(clearingBlocked.score,48);assert.ok(clearingBlocked.drivers.includes('+16 blocked reduction'));
 const failed=scoreQueueQuality([{active:2,waiting:0,blocked:0,failed:0,completed:0},{active:2,waiting:0,blocked:0,failed:1,completed:20}]);
 assert.ok(failed.score!<=39);assert.equal(failed.tone,'critical');
});

test('queue history client is bounded, read-only and refreshes every minute',()=>{
 const code=queueHistoryScript();
 for(const state of ['active','waiting','blocked','failed','completed'])assert.match(code,new RegExp(state));
 assert.match(code,/Completed since range start/);
 assert.match(code,/createElementNS\(svg\.namespaceURI,'path'\)/);assert.match(code,/queue-history-line/);assert.match(code,/queue-history-point/);
 assert.match(code,/Total queue cards/);assert.match(code,/cardTotal/);assert.match(code,/totalNow/);assert.match(code,/Total cards/);assert.match(code,/queue-history-total-line/);
 assert.match(code,/barSvg/);assert.match(code,/queue-history-bar/);assert.match(code,/largestTotal/);assert.match(code,/segmentHeight/);
 assert.match(code,/point\[key\].*first\[key\]/);assert.match(code,/minimum=Math\.min\(0/);assert.match(code,/maximum=Math\.max\(0/);
 assert.match(code,/queue-history-hit/);assert.match(code,/pointerenter/);assert.match(code,/pointermove/);assert.match(code,/role="tooltip"|queue-history-tooltip/);assert.match(code,/signed\(point\[key\]\)/);
 assert.match(code,/hover or focus any minute for exact values/);
 assert.match(code,/queue-chart-grid/);assert.match(code,/queue-chart-y-label/);assert.match(code,/toLocaleTimeString/);
 assert.match(code,/height=88/);assert.match(code,/barHeight=76/);
 assert.match(code,/change from range start/);assert.match(code,/warning:/);assert.match(code,/blocked','failed','waiting/);
 assert.match(code,/scoreQueueQuality/);assert.match(code,/blocked or failed increases cap the result/);assert.match(code,/queue-history-driver/);
 assert.match(code,/\/api\/queue-history/);assert.match(code,/searchParams\.set\('fresh','1'\)/);assert.match(code,/refresh:load/);assert.match(code,/60000/);assert.match(code,/points\.length>1441/);assert.doesNotMatch(code,/innerHTML|method:\s*['"]POST/);
 new Function(code+';return startQueueHistory;')();
});
