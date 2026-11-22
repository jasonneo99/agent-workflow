import assert from "node:assert/strict";
import test from "node:test";
import { QueueCardSnapshotCache } from "./queue-card-snapshot.js";

test("coalesces cold reads and returns one authoritative snapshot", async () => {
  let calls = 0;
  let release!: (value: string) => void;
  const cache = new QueueCardSnapshotCache<string>(750, 30_000, () => 1_000);
  const load = () => { calls += 1; return new Promise<string>((resolve) => { release = resolve; }); };
  const first = cache.get("all", load);
  const second = cache.get("all", load);
  assert.equal(calls, 1);
  release("fresh");
  assert.equal((await first).value, "fresh");
  assert.equal((await second).value, "fresh");
});

test("returns bounded stale data immediately and exposes its age while refreshing", async () => {
  let now = 0;
  let value = "first";
  let release!: (value: string) => void;
  const cache = new QueueCardSnapshotCache<string>(750, 30_000, () => now);
  await cache.get("all", async () => value);
  now = 900;
  const prior = await cache.get("all", () => new Promise<string>((resolve) => { release = resolve; }));
  assert.deepEqual(prior, { value: "first", capturedAt: 0, ageMs: 900, refreshing: true });
  release("second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await cache.get("all", async () => "unused")).value, "second");
});

test('explicit fresh reads wait for the post-mutation snapshot',async()=>{
 const cache=new QueueCardSnapshotCache<string>();
 await cache.get('all',async()=>'visible');
 let release!:(value:string)=>void;
 const fresh=cache.get('all',()=>new Promise<string>(resolve=>{release=resolve;}),true);
 release('archived');
 assert.equal((await fresh).value,'archived');
 assert.equal((await fresh).refreshing,false);
});

test("does not serve a snapshot beyond the hard stale bound", async () => {
  let now = 0;
  const cache = new QueueCardSnapshotCache<string>(750, 30_000, () => now);
  await cache.get("all", async () => "first");
  now = 30_001;
  const next = await cache.get("all", async () => "second");
  assert.equal(next.value, "second");
  assert.equal(next.refreshing, false);
});
test('a pre-removal load cannot restore withdrawn cards or release a newer in-flight load',async()=>{
 const cache=new QueueCardSnapshotCache<string>();await cache.get('all',async()=>'initial');
 let finishOld!:(value:string)=>void,finishNew!:(value:string)=>void;
 const old=cache.get('all',()=>new Promise<string>(resolve=>{finishOld=resolve;}),true);
 cache.invalidate();
 const fresh=cache.get('all',()=>new Promise<string>(resolve=>{finishNew=resolve;}),true);
 finishOld('before removal');await old;
 const shared=cache.get('all',async()=>{throw Error('Old cleanup released the new load');},true);
 finishNew('after removal');assert.equal((await fresh).value,'after removal');assert.equal((await shared).value,'after removal');
 assert.equal((await cache.get('all',async()=>'unused')).value,'after removal');
});
