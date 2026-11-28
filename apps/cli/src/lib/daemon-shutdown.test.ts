import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createDaemonShutdown} from './daemon-shutdown.js';
test('signals interrupt a long idle wait immediately and handlers are released',async()=>{
 const host=new EventEmitter();let count=0;
 const shutdown=createDaemonShutdown(()=>count++,host);
 const started=Date.now();const waiting=shutdown.wait(60_000);
 host.emit('SIGTERM');host.emit('SIGINT');await waiting;
 assert.equal(count,1);assert.equal(shutdown.requested(),true);assert.ok(Date.now()-started<1000);
 shutdown.close();assert.equal(host.listenerCount('SIGTERM'),0);assert.equal(host.listenerCount('SIGINT'),0);
});
test('stop admission while draining owned work, including rejected work',async()=>{
 const shutdown=createDaemonShutdown(()=>{},new EventEmitter());let finish!:()=>void;let drained=false;
 const owned=new Promise<void>(resolve=>{finish=resolve;});shutdown.stop();
 const draining=shutdown.drain([owned,Promise.reject(Error('recorded failure'))]).then(()=>{drained=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);
 finish();await draining;assert.equal(drained,true);shutdown.close();
});
