export class PartnerPlanningStopped extends Error{constructor(){super('Coordinator is draining; no new planning or reservation.');}}
export function assertPartnerPlanningOpen(shouldStop?:()=>boolean){if(shouldStop?.())throw new PartnerPlanningStopped();}
/** Recheck after asynchronous discovery before the caller can start effects. */
export async function partnerPreparationStep<T>(prepare:()=>Promise<T>,shouldStop?:()=>boolean):Promise<T>{
 assertPartnerPlanningOpen(shouldStop);const value=await prepare();assertPartnerPlanningOpen(shouldStop);return value;
}
/** One watch, rolling bounded passes. Actual reservations/policies remain final
 * authority; a completion wake only asks for a fresh plan. Stop drains owned
 * work without cancellation, claim reset, or starting another consumer.
 */
export async function watchPartnerQueue<T>(options:{
 pass(onSettled:()=>void):Promise<T>;
 report(result:T):void;
 intervalMs:number;
 signal:AbortSignal;
}){
 if(!Number.isInteger(options.intervalMs)||options.intervalMs<1)throw Error('Invalid watch interval');
 const active=new Set<Promise<void>>();let pendingWake=false,listener:(()=>void)|undefined,fatal:unknown,failed=false;
 const wake=()=>{pendingWake=true;listener?.();};
 const wait=async()=>{
  if(pendingWake){pendingWake=false;return;}
  await new Promise<void>(resolve=>{
   const done=()=>{clearTimeout(timer);listener=undefined;resolve();};
   const timer=setTimeout(done,options.intervalMs);listener=done;
  });
  pendingWake=false;
 };
 options.signal.addEventListener('abort',wake);
 try{
  while(!options.signal.aborted&&!failed){
   // At most five owned item-bearing passes plus one planning pass. No busy
   // loop is generated merely because a read-only/held pass finishes.
   if(active.size<6){
    const pass=Promise.resolve().then(async()=>{if(!options.signal.aborted)options.report(await options.pass(wake));}).catch(error=>{failed=true;fatal=error;wake();}).finally(()=>active.delete(pass));
    active.add(pass);
   }
   await wait();
  }
  await Promise.all([...active]);
  if(failed)throw fatal;
 }finally{options.signal.removeEventListener('abort',wake);listener?.();}
}
