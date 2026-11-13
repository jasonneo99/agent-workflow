export interface GuideBudget {timeoutMs:number;maxInputTokens:number;maxOutputTokens:number;maxCostUsd:number;failureThreshold:number;cooldownMs:number}
export const defaultGuideBudget:GuideBudget={timeoutMs:15_000,maxInputTokens:8_000,maxOutputTokens:800,maxCostUsd:.02,failureThreshold:3,cooldownMs:300_000};
export interface GuideCircuitSeed {failures:number;openedAt?:number;reason?:string}
type State=GuideCircuitSeed;const circuits=new Map<string,State>();
export function resetGuideCircuits(){circuits.clear();}
export function guideCircuitStatus(taskClass:string,now=Date.now(),budget=defaultGuideBudget,circuitKey=taskClass){const state=circuits.get(circuitKey)??{failures:0};const open=state.openedAt!==undefined&&now-state.openedAt<budget.cooldownMs;return {taskClass,open,failures:state.failures,openedAt:state.openedAt??null,reason:state.reason??null,retryAt:open?state.openedAt!+budget.cooldownMs:null};}
function failure(taskClass:string,circuitKey:string,reason:string,now:number,budget:GuideBudget){const state=circuits.get(circuitKey)??{failures:0};state.failures+=1;state.reason=reason;if(state.failures>=budget.failureThreshold)state.openedAt=now;circuits.set(circuitKey,state);return guideCircuitStatus(taskClass,now,budget,circuitKey);}
export async function executeGuideWithinBudget<T extends {output:{usage?:{inputTokens?:number;outputTokens?:number;costUsd?:number}}}>(input:{taskClass:string;circuitKey?:string;initialCircuit?:GuideCircuitSeed;execute:(signal:AbortSignal,maxOutputTokens:number)=>Promise<T>;budget?:GuideBudget;now?:()=>number}){
 const budget=input.budget??defaultGuideBudget,now=input.now??Date.now,circuitKey=input.circuitKey??input.taskClass;if(input.initialCircuit)circuits.set(circuitKey,{...input.initialCircuit});const before=guideCircuitStatus(input.taskClass,now(),budget,circuitKey);if(before.open)return {status:'skipped-circuit' as const,value:null,circuit:before,reason:'task-class-circuit-open'};
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 const execution=input.execute(controller.signal,budget.maxOutputTokens);execution.catch(()=>undefined);
 const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('guide-time-budget-exceeded'));},budget.timeoutMs);});
 try{const value=await Promise.race([execution,timeout]);if(timer)clearTimeout(timer);const usage=value.output.usage??{},inputTokens=usage.inputTokens,outputTokens=usage.outputTokens,costUsd=usage.costUsd;
  const over=inputTokens!==undefined&&inputTokens>budget.maxInputTokens?'input-token-budget-exceeded':outputTokens!==undefined&&outputTokens>budget.maxOutputTokens?'output-token-budget-exceeded':costUsd!==undefined&&costUsd>budget.maxCostUsd?'covered-cost-budget-exceeded':null;
  if(over)return {status:'budget-exceeded' as const,value:null,circuit:failure(input.taskClass,circuitKey,over,now(),budget),reason:over};circuits.delete(circuitKey);return {status:'completed' as const,value,circuit:guideCircuitStatus(input.taskClass,now(),budget,circuitKey),reason:null};
 }catch(error){if(timer)clearTimeout(timer);const reason=controller.signal.aborted?'guide-time-budget-exceeded':error instanceof Error?error.message:'guide-execution-failed';return {status:'failed' as const,value:null,circuit:failure(input.taskClass,circuitKey,reason,now(),budget),reason};}
}
