import {verificationWriteSubject} from './action-result-continuation.js';
import {normalizeActionText} from './action-receipts.js';

type Observation={commandLine?:string;type?:string;exitCode?:number|null;timedOut?:boolean;governedWriteSubject?:string|null;verificationRecipe?:{status?:string}};

/** Scheduling and completion must consume tests for the latest governed postimages. */
export function currentVerificationCommands(actionResults:unknown[]):Set<string> {
 const subject=verificationWriteSubject(actionResults);
 return new Set(actionResults.flatMap(value=>{
  if(!value||typeof value!=='object')return [];
  const action=value as Observation;
  return typeof action.commandLine==='string'&&(!subject||action.governedWriteSubject===subject)
   ?[action.commandLine]:[];
 }));
}

/** A baseline pass cannot certify source subsequently changed by this stage. */
export function currentSourceVerificationReason(commands:string[],actionResults:unknown[]):string|null {
 const subject=verificationWriteSubject(actionResults);
 if(!subject)return null;
 for(const command of new Set(commands)){
  const latest=[...actionResults].reverse().find(value=>value&&typeof value==='object'
   &&typeof(value as Observation).commandLine==='string'
   &&normalizeActionText((value as Observation).commandLine!)===normalizeActionText(command)) as Observation|undefined;
  if(!latest||latest.governedWriteSubject!==subject||!['local_command','local_command_reused'].includes(latest.type??'')
   ||latest.exitCode!==0||latest.timedOut!==false||latest.verificationRecipe?.status==='failed'){
   return 'Required verification has no successful evidence for the current governed source: '+command;
  }
 }
 return null;
}
