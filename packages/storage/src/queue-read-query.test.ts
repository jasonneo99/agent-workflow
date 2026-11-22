import assert from 'node:assert/strict';
import test from 'node:test';
import type {Client} from 'pg';
import {queryQueuePresentation} from './queue-read-query.js';

for(const reject of [false,true])test(`queue planning restores pooled session state after ${reject?'failure':'success'}`,async()=>{
 let jit='on';const observed:string[]=[];
 const client={async query(text:string,values?:unknown[]){
  if(text==='show jit')return {rows:[{jit}]};
  if(text.includes('set_config')){jit=values?String(values[0]):'off';return {rows:[]};}
  observed.push(jit);if(reject)throw Error('synthetic read failure');return {rows:[{id:1}]};
 }} as unknown as Client;
 if(reject)await assert.rejects(queryQueuePresentation(client,'select synthetic',[]),/synthetic read failure/);
 else assert.deepEqual((await queryQueuePresentation(client,'select synthetic',[])).rows,[{id:1}]);
 assert.deepEqual(observed,['off']);assert.equal(jit,'on');
});
test('queue planning leaves an already disabled session unchanged',async()=>{
 const statements:string[]=[];
 const client={async query(text:string){statements.push(text);return {rows:text==='show jit'?[{jit:'off'}]:[]};}} as unknown as Client;
 await queryQueuePresentation(client,'select synthetic',[]);
 assert.deepEqual(statements,['show jit','select synthetic']);
});
