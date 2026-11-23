import {spawn} from 'node:child_process';
import os from 'node:os';
import {codexCliChildEnvironment} from './codex-cli-environment.js';

export interface CodexQuotaWindow {usedPercent:number;windowDurationMins:number|null;resetsAt:number|null}
export interface CodexNativeQuota {primary?:CodexQuotaWindow;secondary?:CodexQuotaWindow;credits?:{hasCredits:boolean;unlimited:boolean;balance:number|null;unit:'codex-native-credits'}}
/** Only provider-native units. Never convert subscription allowance to dollars. */
export function parseCodexNativeQuota(value:unknown):CodexNativeQuota|undefined {
 const row=(value as any)?.rateLimits;if(!row||typeof row!=='object')return undefined;
 const result:CodexNativeQuota={};
 for(const name of ['primary','secondary'] as const){const window=row[name];if(!window||typeof window.usedPercent!=='number'||!Number.isFinite(window.usedPercent)||window.usedPercent<0||window.usedPercent>100)continue;
  const minutes=window.windowDurationMins,reset=window.resetsAt;
  if(minutes!=null&&(!Number.isSafeInteger(minutes)||minutes<=0)||reset!=null&&(!Number.isSafeInteger(reset)||reset<0))continue;
  result[name]={usedPercent:window.usedPercent,windowDurationMins:minutes??null,resetsAt:reset??null};
 }
 const credit=row.credits;
 if(credit&&typeof credit.hasCredits==='boolean'&&typeof credit.unlimited==='boolean'){
  const numericBalance=typeof credit.balance==='number'&&Number.isFinite(credit.balance)&&credit.balance>=0?credit.balance:null;
  const balance=typeof credit.balance==='string'&&/^\d+(?:\.\d+)?$/u.test(credit.balance)&&Number.isFinite(Number(credit.balance))?Number(credit.balance):numericBalance;
  result.credits={hasCredits:credit.hasCredits,unlimited:credit.unlimited,balance,unit:'codex-native-credits'};
 }
 return Object.keys(result).length?result:undefined;
}

/** Own stdio child; the only requests are initialization and account meter read.
 * No thread, login, reset-credit consumption, messages or inference requests. */
export async function readCodexRateLimits(options:{env?:NodeJS.ProcessEnv;command?:string;argsPrefix?:string[];timeoutMs?:number}={}):Promise<unknown>{
 const parent=options.env??process.env;
 return new Promise(resolve=>{
  const child=spawn(options.command??(parent.CODEX_CLI_BIN?.trim()||'codex'),[...options.argsPrefix??[],'app-server','--stdio'],{cwd:os.tmpdir(),env:codexCliChildEnvironment(parent),stdio:['pipe','pipe','pipe']});
  let buffer='',bytes=0,done=false,initialized=false,killTimer:ReturnType<typeof setTimeout>|undefined;
  const finish=(value:unknown)=>{if(done)return;done=true;clearTimeout(timer);child.stdin.end();child.kill('SIGTERM');killTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},1000);killTimer.unref();resolve(value);};
  const timer=setTimeout(()=>finish(undefined),Math.max(50,Math.min(15000,options.timeoutMs??15000)));
  child.on('error',()=>finish(undefined));child.on('close',()=>{if(killTimer)clearTimeout(killTimer);finish(undefined);});
  child.stdin.on('error',()=>finish(undefined));child.stderr.on('data',()=>{});
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>262144)return finish(undefined);buffer+=chunk.toString('utf8');let index;
   while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);let message:any;try{message=JSON.parse(line);}catch{continue;}
    if(message.id===1&&!initialized){if(message.error)return finish(undefined);initialized=true;child.stdin.write(JSON.stringify({method:'initialized'})+'\n');child.stdin.write(JSON.stringify({id:2,method:'account/rateLimits/read',params:{}})+'\n');}
    else if(message.id===2&&initialized)return finish(message.error?undefined:message.result);
   }
  });
  child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'agent_workflow_credit_measurement',version:'1.0.0'},capabilities:{experimentalApi:true}}})+'\n');
 });
}
