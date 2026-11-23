import assert from 'node:assert/strict';import test from 'node:test';
import {collectProviderCredits,measuredCreditRemainingUsd} from './provider-credits.js';
const now=new Date('2026-11-22T12:00:00Z');
const deep={DEEPSEEK_API_KEY:'synthetic-secret'};
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const fake=(fn:(url:string,init:RequestInit)=>Response|Promise<Response>)=>(async (url:any,init:any)=>fn(String(url),init)) as typeof fetch;
test('DeepSeek measures currency-specific credits without leaking credentials or response extras',async()=>{
 const value=await collectProviderCredits('deepseek',{env:deep,now,fetch:fake((url,init)=>{assert.equal(url,'https://api.deepseek.com/user/balance');assert.equal(init.redirect,'error');assert.equal((init.headers as any).Authorization,'Bearer synthetic-secret');return response({is_available:true,balance_infos:[{currency:'USD',total_balance:'12.50',private:'synthetic-secret'}]});})});
 assert.equal(value.status,'measured');assert.equal(measuredCreditRemainingUsd(value,now),12.5);assert.equal(JSON.stringify(value).includes('synthetic-secret'),false);
 assert.equal(measuredCreditRemainingUsd(value,new Date(now.getTime()+300001)),undefined);assert.equal(measuredCreditRemainingUsd(value,new Date(now.getTime()-1)),undefined);
});
test('CNY balances are measured but never invented as USD',async()=>{
 const value=await collectProviderCredits('deepseek',{env:deep,now,fetch:fake(()=>response({is_available:false,balance_infos:[{currency:'CNY',total_balance:'0.00'}]}))});
 assert.deepEqual(value.balances,[{currency:'CNY',remaining:0}]);assert.equal(value.availableForCalls,false);assert.equal(measuredCreditRemainingUsd(value,now),undefined);
});
test('unsupported, unconfigured and custom endpoints do not dispatch credential requests',async()=>{
 const network=fake(()=>{throw Error('Must not dispatch');});
 for(const [providerId,env] of [['codex-cli',{}],['openai',{OPENAI_API_KEY:'synthetic'}],['deepseek',{}],['deepseek',{...deep,DEEPSEEK_BASE_URL:'http://localhost:1234/v1'}],['deepseek',{...deep,DEEPSEEK_BASE_URL:'https://api.deepseek.com.evil.invalid/v1'}]] as const){const value=await collectProviderCredits(providerId,{env,now,fetch:network});assert.equal(value.status,'unknown');assert.deepEqual(value.balances,[]);}
});
test('HTTP failures and malformed payloads remain unknown rather than zero',async()=>{
 for(const status of [401,402,403,429,500]){const value=await collectProviderCredits('deepseek',{env:deep,now,fetch:fake(()=>response({error:'synthetic-secret'},status))});assert.equal(value.reason,'http-'+status);assert.equal(measuredCreditRemainingUsd(value,now),undefined);assert.ok(!JSON.stringify(value).includes('synthetic-secret'));}
 for(const body of [{is_available:true,balance_infos:[]},{is_available:true,balance_infos:[{currency:'USD',total_balance:null}]},{is_available:true,balance_infos:[{currency:'USD',total_balance:'NaN'}]},{is_available:'yes',balance_infos:[]}])assert.equal((await collectProviderCredits('deepseek',{env:deep,fetch:fake(()=>response(body))})).status,'unknown');
 const value=await collectProviderCredits('deepseek',{env:deep,fetch:fake(()=>new Response('x'.repeat(32769)))});assert.equal(value.status,'unknown');
});
test('OpenRouter key caps and unlimited caps never masquerade as account funds',async()=>{
 for(const limit_remaining of [0,25,null]){let calls=0;const value=await collectProviderCredits('openrouter',{env:{OPENROUTER_API_KEY:'synthetic-key'},now,fetch:fake(url=>{calls++;assert.equal(url,'https://openrouter.ai/api/v1/key');return response({data:{is_management_key:false,limit_remaining,label:'synthetic-key'}});})});assert.equal(calls,1);assert.equal(value.status,'unknown');assert.equal(value.keyLimitRemainingUsd,limit_remaining??undefined);assert.equal(measuredCreditRemainingUsd(value,now),undefined);}
});
test('OpenRouter account balance is measured only with reported management capability',async()=>{
 const value=await collectProviderCredits('openrouter',{env:{OPENROUTER_API_KEY:'synthetic-key'},now,fetch:fake(url=>response(url.endsWith('/key')?{data:{is_management_key:true,limit_remaining:null}}:{data:{total_credits:100.5,total_usage:25.75}}))});assert.equal(value.status,'measured');assert.equal(measuredCreditRemainingUsd(value,now),74.75);
});
test('network diagnostics and redirect failures are scrubbed, and unknown does not reuse old funds',async()=>{
 const value=await collectProviderCredits('deepseek',{env:deep,fetch:fake(()=>{throw Error('synthetic-secret');})});assert.equal(value.reason,'measurement-unavailable');assert.equal(JSON.stringify(value).includes('synthetic-secret'),false);assert.deepEqual(value.balances,[]);
});
