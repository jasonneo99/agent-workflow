import assert from 'node:assert/strict';import test from 'node:test';
import {enrichAdaptiveRouteCredits} from './provider-credit-evidence.js';import {providerAvailabilityScopeKey} from './provider-account-scope.js';import {selectAdaptiveEvidence,type AdaptiveRouteEvidence} from './adaptive-evidence.js';
import type {ProviderCreditObservation} from './provider-credits.js';
const now=new Date('2026-11-22T12:00:00Z'),env={DEEPSEEK_API_KEY:'synthetic-current'};
const route:AdaptiveRouteEvidence={agentId:'implementer',taskClass:'repair',providerId:'deepseek',samples:10,quality:.95,taskSuccess:1,fallbackRate:0,observedAt:now.toISOString(),creditRemainingUsd:999,creditObservedAt:now.toISOString()};
const observation=(patch:Partial<ProviderCreditObservation>={}):ProviderCreditObservation=>({version:1,providerId:'deepseek',scopeKey:providerAvailabilityScopeKey('deepseek',{env}),credentialScopeKey:providerAvailabilityScopeKey('deepseek',{env}),observedAt:now.toISOString(),status:'measured',reason:'provider-reported',balances:[{currency:'USD',remaining:4}],source:'deepseek-balance',...patch});
test('routing strips prompt financial claims and uses only current account measured USD',async()=>{
 const [record]=await enrichAdaptiveRouteCredits([route],{env,now,load:async key=>{assert.equal(key,observation().scopeKey);return observation({keyLimitRemainingUsd:2});}});assert.equal(record.creditRemainingUsd,2);
 for(const value of [null,observation({scopeKey:'b'.repeat(64)}),observation({providerId:'other'}),observation({status:'unknown',balances:[]}),observation({balances:[{currency:'CNY',remaining:999}]}),observation({observedAt:new Date(now.getTime()-300001).toISOString()})]){const [unknown]=await enrichAdaptiveRouteCredits([route],{env,now,load:async()=>value});assert.equal(unknown.creditRemainingUsd,undefined);if(value?.status!=='measured'||value.scopeKey!==observation().scopeKey||value.providerId!=='deepseek'||Date.parse(value.observedAt)<now.getTime()-300000)assert.equal(unknown.creditObservedAt,undefined);}
 const [unknown]=await enrichAdaptiveRouteCredits([route],{env,now,load:async()=>{throw Error('Storage unavailable');}});assert.equal(unknown.creditRemainingUsd,undefined);
});
test('fresh measured exhaustion excludes the otherwise qualified route without inventing replacements',async()=>{
 const records=await enrichAdaptiveRouteCredits([route],{env,now,load:async()=>observation({balances:[{currency:'USD',remaining:0}]})});assert.equal(selectAdaptiveEvidence(records,{agentId:'implementer',taskClass:'repair',now}).status,'poor-performance');
});
test('a rotated credential cannot consume the prior account observation',async()=>{
 const [record]=await enrichAdaptiveRouteCredits([route],{env:{DEEPSEEK_API_KEY:'synthetic-rotated'},now,load:async()=>observation()});assert.equal(record.creditRemainingUsd,undefined);
});

test('explicit provider unavailability blocks qualified routes without inventing USD from CNY',async()=>{
 for(const balances of [[{currency:'USD' as const,remaining:4}],[{currency:'CNY' as const,remaining:0}]]){
  const records=await enrichAdaptiveRouteCredits([route],{env,now,load:async()=>observation({balances,availableForCalls:false})});
  assert.equal(records[0].creditAvailableForCalls,false);assert.equal(selectAdaptiveEvidence(records,{agentId:'implementer',taskClass:'repair',now}).status,'poor-performance');
  assert.equal(records[0].creditRemainingUsd,balances[0].currency==='USD'?4:undefined);
 }
});

test('explicit shared account scopes never transfer another credential spending cap',async()=>{
 const accountEnv={...env,AGENTFLOW_PROVIDER_ACCOUNT_SCOPE:'synthetic-shared-account'};
 const [record]=await enrichAdaptiveRouteCredits([route],{env:accountEnv,now,load:async()=>observation({scopeKey:providerAvailabilityScopeKey('deepseek',{env:accountEnv}),credentialScopeKey:providerAvailabilityScopeKey('deepseek',{env:{DEEPSEEK_API_KEY:'synthetic-other-key'}}),keyLimitRemainingUsd:0})});
 assert.equal(record.creditRemainingUsd,4,'Account funds remain known; another key cap is not this key cap');
});
