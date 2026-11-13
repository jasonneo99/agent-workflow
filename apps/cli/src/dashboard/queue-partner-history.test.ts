import assert from 'node:assert/strict';import test from 'node:test';
import {renderQueuePartnerHistory} from './queue-partner-history.js';
test('history stays compact, proof-labelled and safe',()=>{const html=renderQueuePartnerHistory({attempts:2,verified:1,items:[{runId:'123e4567-e89b-12d3-a456-426614174000',outcome:'verified',recordedAt:'2026-10-26T00:00:00Z',proof:'independently-verified',durationMs:65000,costUsd:.1,bottleneck:'provider',bottleneckMs:52000,influence:{effect:'confirmed-plan',reason:'Matched verified evidence'}}]});
 assert.match(html,/Learned history · 2 prior attempts · 1 independently verified/);assert.match(html,/Evidence only/);assert.match(html,/1m 5s/);assert.match(html,/\$0\.1000/);assert.match(html,/Slowest phase:<\/strong> provider · 52s/);assert.match(html,/confirmed plan.*Matched verified evidence/);assert.doesNotMatch(html,/blocker|task/);});
test('empty history adds no queue clutter',()=>assert.equal(renderQueuePartnerHistory(undefined),''));
