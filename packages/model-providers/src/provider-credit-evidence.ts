import type {AdaptiveRouteEvidence} from './adaptive-evidence.js';
import {measuredCreditRemainingUsd,type ProviderCreditObservation} from './provider-credits.js';
import {providerAvailabilityScopeKey} from './provider-account-scope.js';
import {readProviderCredits} from '../../storage/src/provider-credits.js';

const cache=new Map<string,{at:number;pending:Promise<ProviderCreditObservation|null>}>();
async function cachedRead(key:string){
 const existing=cache.get(key);if(existing&&Date.now()-existing.at<5000)return existing.pending;
 const pending=readProviderCredits(key).catch(()=>null);cache.set(key,{at:Date.now(),pending});
 if(cache.size>256)cache.delete(cache.keys().next().value!);return pending;
}
/** Historical quality remains evidence; financial claims come only from the
 * current account's durable measurement, never from prompt text. No network. */
export async function enrichAdaptiveRouteCredits(evidence:AdaptiveRouteEvidence[],options:{now?:Date;env?:NodeJS.ProcessEnv;load?:(key:string)=>Promise<ProviderCreditObservation|null>}={}):Promise<AdaptiveRouteEvidence[]>{
 const now=options.now??new Date(),load=options.load??cachedRead;
 return Promise.all(evidence.map(async record=>{
  const {creditRemainingUsd:_amount,creditObservedAt:_time,creditAvailableForCalls:_availability,...base}=record;
  if(!/^[a-z0-9-]{1,64}$/u.test(record.providerId))return base;
  const scopeKey=providerAvailabilityScopeKey(record.providerId,{env:options.env});
  let observation:ProviderCreditObservation|null;try{observation=await load(scopeKey);}catch{return base;}
  if(observation?.scopeKey!==scopeKey||observation.providerId!==record.providerId)return base;
  const age=now.getTime()-Date.parse(observation.observedAt);
  if(observation.status!=='measured'||!Number.isFinite(age)||age<0||age>300000)return base;
  const remaining=measuredCreditRemainingUsd(observation,now);
  const credentialScopeKey=providerAvailabilityScopeKey(record.providerId,{env:{...(options.env??process.env),AGENTFLOW_PROVIDER_ACCOUNT_SCOPE:undefined}});
  const limit=observation.credentialScopeKey===credentialScopeKey?observation.keyLimitRemainingUsd:undefined;
  return {...base,creditObservedAt:observation.observedAt,
   ...(typeof observation.availableForCalls==='boolean'?{creditAvailableForCalls:observation.availableForCalls}:{}),
   ...(remaining===undefined?{}:{creditRemainingUsd:Math.min(remaining,limit??remaining)})};
 }));
}
