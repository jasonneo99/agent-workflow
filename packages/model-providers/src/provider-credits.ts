import {parseCodexNativeQuota,readCodexRateLimits,type CodexNativeQuota} from './codex-credit-probe.js';
import {providerAvailabilityScopeKey} from './provider-account-scope.js';

export interface ProviderCreditObservation {
 version:1;providerId:string;scopeKey:string;observedAt:string;
 status:'measured'|'unknown';reason:string;
 balances:Array<{currency:'USD'|'CNY';remaining:number}>;
 nativeQuota?:CodexNativeQuota;
 keyLimitRemainingUsd?:number;credentialScopeKey?:string;availableForCalls?:boolean;
 source:'deepseek-balance'|'openrouter-key'|'openrouter-credits'|'codex-rate-limits'|'unsupported';
}
const numeric=(value:unknown):number|undefined=>{
 if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+(?:\.\d+)?$/u.test(value)))return undefined;
 const n=Number(value);return Number.isFinite(n)&&n>=0?n:undefined;
};
async function readJson(response:Response):Promise<any>{
 if(!response.ok){await response.body?.cancel().catch(()=>{});throw Error('http-'+response.status);}
 const reader=response.body?.getReader();if(!reader)throw Error('invalid-response');
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>32768)throw Error('invalid-response');chunks.push(value);}}
 finally{await reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/** Provider-reported data only. No inference, credential-file reads or purchases. */
export async function collectProviderCredits(providerId:string,options:{env?:NodeJS.ProcessEnv;fetch?:typeof fetch;now?:Date;readCodex?:()=>Promise<unknown>}={}):Promise<ProviderCreditObservation>{
 if(!/^[a-z0-9-]{1,64}$/u.test(providerId))throw Error('Invalid provider id');
 const env=options.env??process.env,observedAt=(options.now??new Date()).toISOString();
 const base:ProviderCreditObservation={version:1,providerId,scopeKey:providerAvailabilityScopeKey(providerId,{env}),observedAt,status:'unknown',reason:'unsupported-balance-api',balances:[],source:'unsupported'};
 if(providerId==='codex-cli'){
  let nativeQuota:CodexNativeQuota|undefined;try{nativeQuota=parseCodexNativeQuota(await (options.readCodex??(()=>readCodexRateLimits({env})))());}catch{}
  return nativeQuota?{...base,status:'measured',reason:'provider-reported',source:'codex-rate-limits',nativeQuota}:{...base,reason:'measurement-unavailable',source:'codex-rate-limits'};
 }
 if(!['deepseek','openrouter'].includes(providerId))return base;
 const deepseek=providerId==='deepseek',credentialName=deepseek?'DEEPSEEK_API_KEY':'OPENROUTER_API_KEY',key=env[credentialName];
 if(!key?.trim())return {...base,reason:'credential-not-configured'};
 const credentialScopeKey=providerAvailabilityScopeKey(providerId,{env:{[credentialName]:key}});
 const origin=deepseek?'https://api.deepseek.com':'https://openrouter.ai';
 const configured=env[deepseek?'DEEPSEEK_BASE_URL':'OPENROUTER_BASE_URL']??origin+(deepseek?'/v1':'/api/v1');
 try{const url=new URL(configured);if(url.origin!==origin||url.username||url.password||url.search||url.hash||!(deepseek?['/','/v1','/v1/']:['/api/v1','/api/v1/']).includes(url.pathname))return {...base,reason:'custom-endpoint-unqualified'};}
 catch{return {...base,reason:'custom-endpoint-unqualified'};}
 const get=async(endpoint:string)=>readJson(await (options.fetch??fetch)(origin+endpoint,{method:'GET',headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(8000)}));
 try{
  if(deepseek){
   const body=await get('/user/balance');
   if(typeof body.is_available!=='boolean'||!Array.isArray(body.balance_infos)||!body.balance_infos.length||body.balance_infos.length>16)throw Error('invalid-response');
   const balances:ProviderCreditObservation['balances']=[];
   for(const item of body.balance_infos){const remaining=numeric(item?.total_balance);if(!['USD','CNY'].includes(item?.currency)||remaining===undefined||balances.some(b=>b.currency===item.currency))throw Error('invalid-response');balances.push({currency:item.currency,remaining});}
   return {...base,status:'measured',reason:'provider-reported',source:'deepseek-balance',credentialScopeKey,balances,availableForCalls:body.is_available};
  }
  const body=await get('/api/v1/key'),data=body?.data;
  if(!data||typeof data!=='object'||Array.isArray(data))throw Error('invalid-response');
  const limit=numeric(data.limit_remaining);
  const partial={...base,credentialScopeKey,source:'openrouter-key' as const,reason:'account-balance-unavailable',...(limit===undefined?{}:{keyLimitRemainingUsd:limit})};
  // A key spending cap is not an account balance. Never manufacture funds from it.
  if(data.is_management_key!==true)return partial;
  const credits=await get('/api/v1/credits');
  const total=numeric(credits?.data?.total_credits),used=numeric(credits?.data?.total_usage);
  if(total===undefined||used===undefined)throw Error('invalid-response');
  return {...partial,status:'measured',reason:'provider-reported',source:'openrouter-credits',balances:[{currency:'USD',remaining:Math.max(0,total-used)}]};
 }catch(error){const label=error instanceof Error?error.message:'';return {...base,reason:/^http-(?:401|403|402|429|5\d\d)$/u.test(label)?label:label==='invalid-response'?'invalid-response':'measurement-unavailable'};}
}
/** Stale, future, non-USD and unknown observations cannot become USD funds. */
export function measuredCreditRemainingUsd(observation:ProviderCreditObservation|null|undefined,now=new Date()):number|undefined {
 if(!observation||observation.status!=='measured')return undefined;
 const age=now.getTime()-Date.parse(observation.observedAt);
 if(!Number.isFinite(age)||age<0||age>300000)return undefined;
 const remaining=observation.balances.find(b=>b.currency==='USD')?.remaining;
 return typeof remaining==='number'&&Number.isFinite(remaining)&&remaining>=0?remaining:undefined;
}
