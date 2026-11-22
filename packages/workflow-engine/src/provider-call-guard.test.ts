import assert from 'node:assert/strict';
import test from 'node:test';
import {createProviderCallGuard} from './provider-call-guard.js';
import type {StageExecutionInput} from '../../model-providers/src/types.js';
const policy={chains:{},maxRetries:1,circuitFailureThreshold:3,circuitCooldownMs:60_000,allowQuotaFallback:false};
test('one stage budget covers separately created provider wrappers',async()=>{
 const guard=createProviderCallGuard(policy,{limit:2});let calls=0;
 const provider=()=>guard({id:'mock',async executeStage(){calls++;return {summary:'ok',artifact:{}};}});
 await provider().executeStage({} as StageExecutionInput);await provider().executeStage({} as StageExecutionInput);
 await assert.rejects(provider().executeStage({} as StageExecutionInput),/Stage-wide provider call budget exhausted/);
 assert.equal(calls,2);
});
test('cancelled dispatch consumes no provider call',async()=>{
 const guard=createProviderCallGuard(policy,{limit:1}),controller=new AbortController();controller.abort();let calls=0;
 const provider=guard({id:'mock',async executeStage(){calls++;return {summary:'ok',artifact:{}};}});
 await assert.rejects(provider.executeStage({abortSignal:controller.signal} as StageExecutionInput),/cancelled before dispatch/);
 await provider.executeStage({} as StageExecutionInput);assert.equal(calls,1);
});
