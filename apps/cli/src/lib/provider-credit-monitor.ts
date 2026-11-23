import {collectProviderCredits,type ProviderCreditObservation} from '../../../../packages/model-providers/src/provider-credits.js';
import {recordProviderCredits} from '../../../../packages/storage/src/provider-credits.js';
export interface ProviderCreditMonitorStatus {enabled:boolean;status:'disabled'|'idle'|'running'|'complete'|'partial';lastAttemptAt:string|null;measured:number;unknown:number;failed:number}
/** One bounded observation pass per interval, never an agent or queue run. */
export function createProviderCreditMonitor(options:{env?:NodeJS.ProcessEnv;now?:()=>number;collect?:(id:string)=>Promise<ProviderCreditObservation>;record?:(value:ProviderCreditObservation)=>Promise<unknown>}={}){
 const env=options.env??process.env,now=options.now??Date.now;let last=-Infinity,pending:Promise<void>|null=null;
 let state:ProviderCreditMonitorStatus={enabled:false,status:'disabled',lastAttemptAt:null,measured:0,unknown:0,failed:0};
 return {status:()=>({...state}),tick:async()=>{
  const enabled=/^(?:1|true)$/iu.test(env.AGENTFLOW_PROVIDER_CREDIT_MEASUREMENT??'');
  if(!enabled){state={...state,enabled:false,status:'disabled'};return;}
  if(pending)return pending;
  const configured=Number(env.AGENTFLOW_PROVIDER_CREDIT_INTERVAL_MS??240000),interval=Number.isFinite(configured)?Math.max(30000,Math.min(3600000,configured)):240000;
  if(now()-last<interval)return;
  last=now();state={enabled:true,status:'running',lastAttemptAt:new Date(last).toISOString(),measured:0,unknown:0,failed:0};
  pending=(async()=>{for(const id of ['codex-cli','deepseek','openrouter'])try{
   const value=await (options.collect??(id=>collectProviderCredits(id,{env})))(id);await (options.record??recordProviderCredits)(value);state[value.status==='measured'?'measured':'unknown']++;
  }catch{state.failed++;}state.status=state.failed?'partial':'complete';})();
  try{await pending;}finally{pending=null;}
 }};
}
