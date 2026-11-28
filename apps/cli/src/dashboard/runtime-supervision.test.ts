import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectRuntimeSupervision} from './runtime-supervision.js';
test('systemd health requires all three observed active units',async()=>{
 const calls:string[]=[];
 const result=await inspectRuntimeSupervision({env:{AGENTFLOW_SUPERVISION:'systemd',AGENTFLOW_MCP_REQUIRED:'false'},platform:'linux',legacyStatus:'missing',probe:async unit=>{calls.push(unit);return 'active';}});
 assert.equal(result.status,'running');assert.equal(result.mcpRequired,false);assert.equal(calls.length,3);
});
test('degraded and unavailable systemd are never healthy',async()=>{
 for(const probe of [async()=> 'inactive',async()=>{throw Error('no bus');}]){
  const result=await inspectRuntimeSupervision({env:{AGENTFLOW_SUPERVISION:'systemd'},platform:'linux',legacyStatus:'running',probe});
  assert.notEqual(result.status,'running');assert.equal(result.mcpRequired,true);
 }
});
test('Linux alone does not waive supervisor or MCP checks',async()=>{
 const result=await inspectRuntimeSupervision({env:{},platform:'linux',legacyStatus:'missing'});
 assert.equal(result.status,'missing');assert.equal(result.mcpRequired,true);
});
