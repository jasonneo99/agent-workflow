import {parseCodexNativeQuota} from '../../model-providers/src/codex-credit-probe.js';
import type {Client} from 'pg';
import type {ProviderCreditObservation} from '../../model-providers/src/provider-credits.js';
import {databaseUrl,withClient} from './client.js';

export const providerCreditsSchemaSql=`create table if not exists provider_credit_observations(
 scope_key text primary key,provider_id text not null,observed_at timestamptz not null,observation jsonb not null
);`;
function checked(input:ProviderCreditObservation){
 const nativeQuota=input.nativeQuota===undefined?undefined:parseCodexNativeQuota({rateLimits:input.nativeQuota});
 if(input.version!==1||!/^[a-f0-9]{64}$/u.test(input.scopeKey)||!/^[a-z0-9-]{1,64}$/u.test(input.providerId)
  ||!Number.isFinite(Date.parse(input.observedAt))||Date.parse(input.observedAt)>Date.now()+10000||!['measured','unknown'].includes(input.status)
  ||!Array.isArray(input.balances)||input.balances.length>2||input.balances.some(b=>!['USD','CNY'].includes(b.currency)||!Number.isFinite(b.remaining)||b.remaining<0)
  ||(input.status==='unknown'&&input.balances.length)||(input.status==='measured'&&!input.balances.length&&!nativeQuota)
  ||(input.nativeQuota!==undefined&&(!nativeQuota||input.providerId!=='codex-cli'||input.source!=='codex-rate-limits'||input.status!=='measured'))
  ||!['unsupported-balance-api','credential-not-configured','custom-endpoint-unqualified','provider-reported','account-balance-unavailable','http-401','http-403','http-402','http-429','measurement-unavailable','invalid-response'].includes(input.reason)&&!/^http-5\d\d$/u.test(input.reason)
  ||!['deepseek-balance','openrouter-key','openrouter-credits','codex-rate-limits','unsupported'].includes(input.source)
  ||new Set(input.balances.map(b=>b.currency)).size!==input.balances.length
  ||(input.keyLimitRemainingUsd!==undefined&&(!Number.isFinite(input.keyLimitRemainingUsd)||input.keyLimitRemainingUsd<0))
  ||(input.credentialScopeKey!==undefined&&!/^[a-f0-9]{64}$/u.test(input.credentialScopeKey))
  ||(input.availableForCalls!==undefined&&typeof input.availableForCalls!=='boolean'))throw Error('Invalid measured provider credit observation');
 // Explicit serialization drops accidental credential/response fields at the boundary.
 return {version:1,providerId:input.providerId,scopeKey:input.scopeKey,observedAt:input.observedAt,status:input.status,
  reason:input.reason,balances:input.balances.map(b=>({currency:b.currency,remaining:b.remaining})),source:input.source,
  ...(nativeQuota?{nativeQuota}:{}),
  ...(input.credentialScopeKey===undefined?{}:{credentialScopeKey:input.credentialScopeKey}),
  ...(input.keyLimitRemainingUsd===undefined?{}:{keyLimitRemainingUsd:input.keyLimitRemainingUsd}),
  ...(input.availableForCalls===undefined?{}:{availableForCalls:input.availableForCalls})};
}
export async function recordProviderCreditsOnClient(c:Client,input:ProviderCreditObservation){
 const observation=checked(input);
 return (await c.query(`insert into provider_credit_observations(scope_key,provider_id,observed_at,observation) values($1,$2,$3,$4::jsonb)
  on conflict(scope_key) do update set provider_id=excluded.provider_id,observed_at=excluded.observed_at,observation=excluded.observation
  where provider_credit_observations.observed_at<excluded.observed_at and provider_credit_observations.provider_id=excluded.provider_id`,[input.scopeKey,input.providerId,input.observedAt,JSON.stringify(observation)])).rowCount===1;
}
export async function readProviderCreditsOnClient(c:Client,scopeKey:string):Promise<ProviderCreditObservation|null>{
 if(!/^[a-f0-9]{64}$/u.test(scopeKey))throw Error('Invalid provider account scope');
 return (await c.query('select observation from provider_credit_observations where scope_key=$1',[scopeKey])).rows[0]?.observation??null;
}
const initialization=new Map<string,Promise<void>>();
async function ready(){const key=databaseUrl();let pending=initialization.get(key);if(!pending){pending=withClient(async c=>{await c.query('begin');try{await c.query("select pg_advisory_xact_lock(hashtext('agentflow:provider-credit-schema'))");await c.query(providerCreditsSchemaSql);await c.query('commit');}catch(error){await c.query('rollback');throw error;}});initialization.set(key,pending);void pending.catch(()=>initialization.delete(key));}await pending;}
export async function recordProviderCredits(input:ProviderCreditObservation){await ready();return withClient(c=>recordProviderCreditsOnClient(c,input));}
export async function readProviderCredits(scopeKey:string){
 try{return await withClient(c=>readProviderCreditsOnClient(c,scopeKey));}
 catch(error){if((error as {code?:string}).code==='42P01')return null;throw error;}
}
