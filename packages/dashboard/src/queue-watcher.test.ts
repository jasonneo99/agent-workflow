import assert from "node:assert/strict";
import test from "node:test";
import {Script} from 'node:vm';
import {setImmediate} from 'node:timers/promises';
import { queueSnapshotSignature, queueWatcherScript } from "./queue-watcher.js";

test("queue signature changes when active progress changes", () => {
  const queued = [{ runId: "run-1", runStatus: "running", completedTasks: 0, queuedTasks: 1, runningTasks: 1, failedTasks: 0 }];
  const progressed = [{ ...queued[0], completedTasks: 1, queuedTasks: 0 }];
  assert.notEqual(queueSnapshotSignature(queued), queueSnapshotSignature(progressed));
});

test("web worker polls the queue without executing it", () => {
  const script = queueWatcherScript();
  assert.match(script, /fetch\(queueUrl/);
  assert.match(script, /queueUrl = "\/api\/queue" \+ \(project \? "\?project="/);
  assert.doesNotMatch(script, /run-worker|queue-action/);
  assert.match(script, /active > 0 \? 2000 : 10000/);
});

test('semantic signature ignores order and clocks but retains blocker and approval changes',()=>{
 const a={runId:'a',runStatus:'blocked',blockedReason:'Exact missing proof',familyAttempts:[{id:'old',status:'failed',blocker:'Preserved cause',approvals:[{id:'one',status:'pending'},{id:'two',status:'approved'}]}]},b={runId:'b',runStatus:'running'};
 assert.equal(queueSnapshotSignature([a,b]),queueSnapshotSignature([b,{...a,startedAt:'new clock',runningLeaseExpiresAt:'new lease',familyAttempts:[{...a.familyAttempts[0],approvals:[...a.familyAttempts[0].approvals].reverse()}]}]));
 assert.notEqual(queueSnapshotSignature([a]),queueSnapshotSignature([{...a,blockedReason:'Different exact proof'}]));
 assert.notEqual(queueSnapshotSignature([a]),queueSnapshotSignature([{...a,familyAttempts:[{...a.familyAttempts[0],approvals:[{id:'one',status:'executed'}]}]}]));
});

test('worker first poll uses the same exact project universe as its rendered baseline',async()=>{
 const rows=[{runId:'scoped-run',runStatus:'blocked'}],messages:any[]=[],urls:string[]=[],timers:Function[]=[],self:any={postMessage:(value:unknown)=>messages.push(value)};
 new Script(queueWatcherScript()).runInNewContext({self,AbortController,setTimeout:(fn:Function)=>{timers.push(fn);return timers.length},clearTimeout:()=>{},fetch:async(url:string)=>{urls.push(url);return {ok:true,json:async()=>rows}}});
 self.onmessage({data:{type:'start',project:'/synthetic/only-one',signature:queueSnapshotSignature(rows)}});await setImmediate();
 assert.equal(urls[0],'/api/queue?project=%2Fsynthetic%2Fonly-one');assert.equal(messages[0].changed,false);
 assert.notEqual(queueSnapshotSignature(rows),queueSnapshotSignature([...rows,{runId:'foreign-run',runStatus:'running'}]),'An unscoped response would reproduce the former reload loop');
});

test('worker stop aborts an in-flight poll and cannot reschedule or publish a stale snapshot',async()=>{
 let resolve!:Function;const messages:any[]=[],signals:AbortSignal[]=[],timers:Function[]=[],self:any={postMessage:(value:unknown)=>messages.push(value)};
 new Script(queueWatcherScript()).runInNewContext({self,AbortController,setTimeout:(fn:Function)=>{timers.push(fn);return timers.length},clearTimeout:()=>{},fetch:async(_url:string,options:any)=>{signals.push(options.signal);return new Promise(r=>{resolve=r})}});
 self.onmessage({data:{type:'start',project:'/synthetic/one',signature:'[]'}});assert.equal(signals.length,1);self.onmessage({data:{type:'stop'}});assert.equal(signals[0].aborted,true);
 resolve({ok:true,json:async()=>[]});await setImmediate();assert.equal(messages.length,0);assert.equal(timers.length,1,'Only the original bounded deadline was registered; no continuing poll survives stop');
});

test('receipt-only activity is sent for in-place replacement without requesting card reload',async()=>{
 const old=[{runId:'one',runStatus:'running',liveActivity:{text:'Read src/a.ts'}}],next=[{...old[0],liveActivity:{text:'Changed src/a.ts'}}];
 assert.equal(queueSnapshotSignature(old),queueSnapshotSignature(next));
 const messages:any[]=[],self:any={postMessage:(v:unknown)=>messages.push(v)};
 new Script(queueWatcherScript()).runInNewContext({self,AbortController,setTimeout:()=>1,clearTimeout:()=>{},fetch:async()=>({ok:true,json:async()=>next})});
 self.onmessage({data:{type:'start',signature:queueSnapshotSignature(old)}});await setImmediate();
 assert.equal(messages[0].changed,false);assert.equal(messages[0].activities[0].liveActivity.text,'Changed src/a.ts');
});
