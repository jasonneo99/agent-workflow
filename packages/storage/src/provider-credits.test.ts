import assert from 'node:assert/strict';import test from 'node:test';import {randomUUID} from 'node:crypto';
import {withClient} from './client.js';import {providerCreditsSchemaSql,recordProviderCreditsOnClient,readProviderCreditsOnClient} from './provider-credits.js';
import type {ProviderCreditObservation} from '../../model-providers/src/provider-credits.js';
const observation=(patch:Partial<ProviderCreditObservation>={}):ProviderCreditObservation=>({version:1,providerId:'deepseek',scopeKey:'a'.repeat(64),observedAt:new Date().toISOString(),status:'measured',reason:'provider-reported',balances:[{currency:'USD',remaining:4}],source:'deepseek-balance',...patch});
test('database observations isolate accounts, reject stale overwrite and retain unknown as unknown',async()=>{
 const schema='credit_test_'+randomUUID().replaceAll('-','');await withClient(async c=>{await c.query('begin');try{await c.query(`create schema ${schema}`);await c.query(`set local search_path to ${schema},public`);await c.query(providerCreditsSchemaSql);
 const first=observation();assert.equal(await recordProviderCreditsOnClient(c,first),true);assert.equal(await recordProviderCreditsOnClient(c,first),false);
 assert.equal(await recordProviderCreditsOnClient(c,observation({observedAt:new Date(Date.parse(first.observedAt)-1000).toISOString(),balances:[{currency:'USD',remaining:999}]})),false);
 assert.equal((await readProviderCreditsOnClient(c,first.scopeKey))?.balances[0].remaining,4);assert.equal(await readProviderCreditsOnClient(c,'b'.repeat(64)),null);
 const unknown=observation({observedAt:new Date(Date.parse(first.observedAt)+1000).toISOString(),status:'unknown',reason:'measurement-unavailable',balances:[]});assert.equal(await recordProviderCreditsOnClient(c,unknown),true);assert.deepEqual((await readProviderCreditsOnClient(c,first.scopeKey))?.balances,[]);
 await assert.rejects(()=>recordProviderCreditsOnClient(c,observation({observedAt:new Date(Date.now()+60000).toISOString()})),/Invalid/);
 await assert.rejects(()=>recordProviderCreditsOnClient(c,observation({reason:'synthetic-secret'})),/Invalid/);
 await assert.rejects(()=>recordProviderCreditsOnClient(c,observation({keyLimitRemainingUsd:NaN})),/Invalid/);
 }finally{await c.query('rollback');}});
});
