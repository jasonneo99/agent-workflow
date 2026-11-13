import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';

export interface QueuePlanControl {version:1;phase:'normal'|'reconciling';reason:string;sourceRunIds?:string[]}
export function restrictedSourceFamilies(families:readonly {familyId:string;sourceRunId:string}[],enrolled:ReadonlySet<string>,sourceRunIds:readonly string[]):Set<string>{
 return new Set(families.filter(f=>enrolled.has(f.familyId)&&sourceRunIds.includes(f.sourceRunId)).map(f=>f.familyId));
}
/** Restriction only: normal mode still needs every ordinary policy/claim gate.
 * A reconciliation hold prevents NEW Partner passes, never cancels owned work.
 */
export async function readQueuePlanControl(root:string):Promise<QueuePlanControl>{
 let file:Awaited<ReturnType<typeof fs.open>>|undefined;
 try{
  file=await fs.open(path.join(root,'.agent-workflow/runtime/queue-plan-control.json'),constants.O_RDONLY|constants.O_NOFOLLOW);
  const stat=await file.stat();if(!stat.isFile()||stat.size>4096)throw Error('Invalid control file');
  const value=JSON.parse(await file.readFile('utf8'));
  if(value?.version!==1||!['normal','reconciling'].includes(value.phase)||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>1000)throw Error('Invalid control value');
  if(value.sourceRunIds!==undefined&&(!Array.isArray(value.sourceRunIds)||!value.sourceRunIds.length||value.sourceRunIds.length>40||new Set(value.sourceRunIds).size!==value.sourceRunIds.length
    ||value.sourceRunIds.some((v:unknown)=>typeof v!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(v))))throw Error('Invalid source restriction');
  return {version:1,phase:value.phase,reason:value.reason,...(value.sourceRunIds?{sourceRunIds:value.sourceRunIds}:{} )};
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return {version:1,phase:'normal',reason:'No active-plan restriction configured.'};
  return {version:1,phase:'reconciling',reason:'Plan control is invalid or unreadable; no new Partner dispatch.'};
 }finally{await file?.close();}
}
