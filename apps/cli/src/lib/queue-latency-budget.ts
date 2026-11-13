export type QueueLatencyStatus="within"|"warning"|"overdue";
export type QueueLatencyBudget={
 phase:string;workClass:"standard"|"recovery"|"verification"|"operator";
 elapsedMs:number;budgetMs:number;remainingMs:number;progress:number;status:QueueLatencyStatus;
};

type QueueLatencyItem={
 runStatus:string;workflowId:string;runningTasks:number;queuedTasks:number;
 runningStageId:string|null;nextStageId:string|null;oldestRunningAt:string|null;oldestQueuedAt:string|null;
 latestActivityAt:string;startedAt:string;waitReason?:{waitedMs:number;budgetMs:number;category:string};
 approvalWait?:unknown;
};

const elapsed=(value:string|null|undefined,now:number)=>Math.max(0,now-Date.parse(value||new Date(now).toISOString()));
const classify=(item:QueueLatencyItem):QueueLatencyBudget["workClass"]=>{
 const text=`${item.workflowId} ${item.runningStageId??""} ${item.nextStageId??""}`;
 if(/verify|verification|test|review|security|acceptance/iu.test(text))return "verification";
 if(/repair|recovery|debug|incident|triage/iu.test(text))return "recovery";
 return "standard";
};
const result=(phase:string,workClass:QueueLatencyBudget["workClass"],elapsedMs:number,budgetMs:number):QueueLatencyBudget=>{
 const progress=budgetMs>0?elapsedMs/budgetMs:1;
 return {phase,workClass,elapsedMs,budgetMs,remainingMs:Math.max(0,budgetMs-elapsedMs),progress,status:progress>=1?"overdue":progress>=.8?"warning":"within"};
};

export function queueLatencyBudget(item:QueueLatencyItem,now=Date.now()):QueueLatencyBudget{
 if(item.approvalWait||item.waitReason?.category==='approval')return {phase:'awaiting approval',workClass:'operator',elapsedMs:0,budgetMs:0,remainingMs:0,progress:0,status:'within'};
 if(item.waitReason?.category==='prepared')return {phase:'prepared: awaiting activation',workClass:'operator',elapsedMs:0,budgetMs:0,remainingMs:0,progress:0,status:'within'};
 if(item.queuedTasks>0&&item.runningTasks===0&&item.waitReason){
  return result(`waiting: ${item.waitReason.category}`,classify(item),item.waitReason.waitedMs,item.waitReason.budgetMs);
 }
 if(item.runningTasks>0){
  const workClass=classify(item),budgetMs=workClass==="verification"?15*60_000:workClass==="recovery"?20*60_000:10*60_000;
  return result(`running: ${item.runningStageId??"current stage"}`,workClass,elapsed(item.oldestRunningAt??item.latestActivityAt,now),budgetMs);
 }
 if(item.runStatus==="blocked"||item.runStatus==="failed"){
  return result(`${item.runStatus}: operator or recovery decision`,"operator",elapsed(item.latestActivityAt||item.startedAt,now),5*60_000);
 }
 if(item.queuedTasks>0){
  return result(`waiting: ${item.nextStageId??"next stage"}`,classify(item),elapsed(item.oldestQueuedAt??item.startedAt,now),2*60_000);
 }
 return result("lifecycle reconciliation","operator",elapsed(item.latestActivityAt||item.startedAt,now),60_000);
}
