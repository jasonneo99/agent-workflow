import {providerAvailabilityScopeKey} from '../../model-providers/src/provider-account-scope.js';
import {classifyProviderFailure,ProviderExecutionError,type ProviderFallbackPolicy} from '../../model-providers/src/fallback.js';
import type {ModelProvider} from '../../model-providers/src/types.js';
import {claimProviderAvailability,recordProviderAvailable,recordProviderFailure,renewProviderProbe} from '../../storage/src/provider-availability.js';

/** One stage-wide budget covers primary, guide, reread and fallback loops. */
export function createProviderCallGuard(policy:ProviderFallbackPolicy,options:{limit?:number;accountScope?:string}={}){
 const configured=options.limit??Number(process.env.AGENTFLOW_STAGE_MODEL_CALL_LIMIT??64);
 const limit=Number.isInteger(configured)?Math.max(1,Math.min(256,configured)):64;
 let calls=0;
 return (provider:ModelProvider):ModelProvider=>({id:provider.id,check:provider.check?.bind(provider),async executeStage(input){
  if(input.abortSignal?.aborted)throw new ProviderExecutionError('configuration','Stage provider call was cancelled before dispatch.');
  if(calls>=limit)throw new ProviderExecutionError('configuration','Stage-wide provider call budget exhausted; inspect existing evidence before continuation.');
  // Reserve before asynchronous admission so concurrent callers cannot overspend.
  calls++;
  // Synthetic providers remain deterministic and do not mutate live availability.
  const key=providerAvailabilityScopeKey(provider.id,{accountScope:options.accountScope});
  let claim:Awaited<ReturnType<typeof claimProviderAvailability>>|null;
  try{claim=provider.id==='mock'?null:await claimProviderAvailability(key);}
  catch{calls--;throw new ProviderExecutionError('configuration','Provider availability admission could not be established; no model call was dispatched.');}
  if(claim&&!claim.allowed){calls--;throw new ProviderExecutionError(claim.failureKind==='account_quota'?'account_quota':'provider_outage','Provider availability is held by a shared cooldown or recovery probe.');}
  const controller=new AbortController();let lost=false;
  const lose=()=>{lost=true;controller.abort();};
  const timer=claim?.probeToken?setInterval(()=>{void renewProviderProbe(claim).then(ok=>{if(!ok)lose();}).catch(lose);},20_000):null;
  timer?.unref();
  try{
   let output;
   try{output=await provider.executeStage({...input,abortSignal:input.abortSignal?AbortSignal.any([input.abortSignal,controller.signal]):controller.signal});}
   catch(error){
    if(claim){const failure=classifyProviderFailure(error);try{await recordProviderFailure(key,failure.kind,policy.circuitCooldownMs,policy.circuitFailureThreshold);}catch{throw new ProviderExecutionError('configuration','Provider failed and its shared recovery observation could not be persisted; inspect receipts before retry.');}}
    throw error;
   }
   if(lost)throw new ProviderExecutionError('configuration','Provider recovery probe ownership was lost; its result cannot close availability.');
   if(claim)try{await recordProviderAvailable(claim);}catch{throw new ProviderExecutionError('configuration','Provider returned a result but availability persistence failed; inspect evidence before retrying inference.');}
   return output;
  }finally{if(timer)clearInterval(timer);}
 }});
}
