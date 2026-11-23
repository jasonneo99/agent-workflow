import assert from 'node:assert/strict';import test from 'node:test';
import {createProviderCreditMonitor} from './provider-credit-monitor.js';import type {ProviderCreditObservation} from '../../../../packages/model-providers/src/provider-credits.js';
const observation=(providerId:string):ProviderCreditObservation=>({version:1,providerId,scopeKey:'a'.repeat(64),observedAt:new Date().toISOString(),status:'unknown',reason:'measurement-unavailable',balances:[],source:'unsupported'});
test('measurement is opt-in, coalesces overlap and refreshes without queue jobs',async()=>{
 let now=1000000,calls=0,records=0;const env:NodeJS.ProcessEnv={};let release!:()=>void;const wait=new Promise<void>(resolve=>release=resolve);
 const monitor=createProviderCreditMonitor({env,now:()=>now,collect:async id=>{calls++;await wait;return observation(id);},record:async()=>{records++;}});
 await monitor.tick();assert.equal(calls,0);env.AGENTFLOW_PROVIDER_CREDIT_MEASUREMENT='1';const a=monitor.tick(),b=monitor.tick();release();await Promise.all([a,b]);assert.equal(calls,3);assert.equal(records,3);assert.equal(monitor.status().unknown,3);
 await monitor.tick();assert.equal(calls,3);now+=240001;await monitor.tick();assert.equal(calls,6);
});
test('a provider or storage failure remains visible and does not stop other measurements',async()=>{
 const monitor=createProviderCreditMonitor({env:{AGENTFLOW_PROVIDER_CREDIT_MEASUREMENT:'true'},collect:async id=>{if(id==='deepseek')throw Error('synthetic private detail');return observation(id);},record:async()=>{}});
 await monitor.tick();assert.equal(monitor.status().status,'partial');assert.equal(monitor.status().failed,1);assert.equal(monitor.status().unknown,2);assert.equal(JSON.stringify(monitor.status()).includes('private'),false);
});
