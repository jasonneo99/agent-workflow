import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {acquireWorkIntent,releaseWorkIntent} from '../../../../packages/storage/src/reliability.js';
import {resolveWorkIntentProject} from './work-intent-project.js';

const directory='.agent-workflow/runtime/queue-partner-observation';
export interface PartnerQueueObservation {
 version:1;authority:'evidence-only';checkedAt:string;inventory:number;held:number;
}
function observation(value:any,now=Date.now()):PartnerQueueObservation|null {
 if(value?.version!==1||value.authority!=='evidence-only'||typeof value.checkedAt!=='string'
  ||!Number.isFinite(Date.parse(value.checkedAt))||Date.parse(value.checkedAt)>now+5000
  ||!Number.isInteger(value.inventory)||value.inventory<0||value.inventory>1000
  ||!Number.isInteger(value.held)||value.held<0||value.held>value.inventory)return null;
 return {version:1,authority:'evidence-only',checkedAt:value.checkedAt,inventory:value.inventory,held:value.held};
}

/** A completed executing queue pass, not a dashboard poll, is the only writer.
 * This observation never grants work, retries, acceptance or approval authority.
 */
export function partnerQueueObservation(report:any):PartnerQueueObservation|null {
 if(report?.executionEnabled!==true||report.scope!=='queue'||report.partial===true||!Array.isArray(report.holds))return null;
 return observation({version:1,authority:'evidence-only',checkedAt:report.at,inventory:report.inventory,
  held:new Set(report.holds.map((hold:any)=>hold?.familyId).filter((id:unknown)=>typeof id==='string'&&id)).size});
}
export async function readPartnerQueueObservation(root:string,now=Date.now()):Promise<(PartnerQueueObservation&{stale:boolean})|null>{
 try{
  const file=path.join(root,directory,'latest.json'),stat=await fs.lstat(file);
  if(!stat.isFile()||stat.size>4096)return null;
  const value=observation(JSON.parse(await fs.readFile(file,'utf8')),now);
  return value?{...value,stale:now-Date.parse(value.checkedAt)>45000}:null;
 }catch{return null;}
}
interface ObservationHooks {withIntent(root:string,write:()=>Promise<void>):Promise<void>}
const defaults:ObservationHooks={withIntent:async(root,write)=>{
 const projectId=await resolveWorkIntentProject(root),owner=`queue-partner-observation:${randomUUID()}`;
 const intent=await acquireWorkIntent({projectId,owner,objective:'Record a completed Partner queue check',fileScopes:[directory],ttlSeconds:30});
 try{await write();}finally{await releaseWorkIntent({projectId,owner,fencingToken:intent.fencingToken});}
}};
export async function recordPartnerQueueObservation(root:string,report:unknown,hooks:ObservationHooks=defaults):Promise<boolean>{
 const value=partnerQueueObservation(report);if(!value)return false;
 let recorded=false;
 await hooks.withIntent(root,async()=>{
  if(await fs.realpath(root)!==path.resolve(root))throw Error('Observation requires the canonical runtime root');
  let parent=path.resolve(root);
  for(const segment of directory.split('/')){
   parent=path.join(parent,segment);
   await fs.mkdir(parent,{recursive:false}).catch(error=>{if(error.code!=='EEXIST')throw error;});
   if(await fs.realpath(parent)!==parent)throw Error('Observation directory must not be a symlink');
  }
  const previous=await readPartnerQueueObservation(root);
  if(previous&&Date.parse(previous.checkedAt)>=Date.parse(value.checkedAt))return;
  const file=path.join(parent,'latest.json'),temporary=path.join(parent,`${randomUUID()}.tmp`);
  try{await fs.writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,file);recorded=true;}
  finally{await fs.rm(temporary,{force:true});}
 });
 return recorded;
}
