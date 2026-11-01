import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {ProjectConfig} from '../../agent-registry/src/schemas.js';
import {assertFilePathAllowed} from '../../local-tools/src/file-writer.js';
import {assertCommandAllowed} from '../../local-tools/src/command-executor.js';
import {materializeVerificationRecipes} from '../../storage/src/partner-recovery-admission.js';
import {assertRepairCommitEnabled} from '../../run-environments/src/repair-checkpoint.js';
import {pipelineEnvironmentPlans,prepareRunWorkspace,type RunWorkspace} from '../../run-environments/src/workspace.js';
import {acquireWorkIntent,renewWorkIntent,releaseWorkIntent,withClient,type ClaimedWorkflowTask} from '../../storage/src/postgres.js';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export interface PreparedTaskExecution {
 root:string;workspace?:RunWorkspace;commands:string[];
 beforeWrite(relative:string,verifiedPostimageHash?:string):Promise<void>;
 assertAuthority():Promise<void>;
 release():Promise<void>;
}
export async function literalScopeVerificationCommands(root:string,project:ProjectConfig,paths:readonly string[]):Promise<string[]>{
 const commands=materializeVerificationRecipes(project,paths);
 for(const relative of paths){
  const test=/^tests\/test_[A-Za-z0-9_]+\.py$/u.test(relative)?relative:relative.endsWith('.py')?`tests/test_${path.basename(relative)}`:null;
  if(test&&await fs.lstat(path.join(root,test)).then(stat=>stat.isFile(),()=>false))commands.push(`python3 -m unittest discover -s tests -p ${path.basename(test)} -v`);
  if(/^[A-Za-z0-9_./-]+\.(?:test|spec)\.[cm]?[jt]s$/u.test(relative))commands.push(`node --import tsx --test ${relative}`);
 }
 return [...new Set(commands)].filter(command=>{try{assertCommandAllowed(command,project);return true;}catch{return false;}});
}
/** Runtime preparation owns an isolated namespace. It never borrows an old
 * run's source permissions or treats a copied checkout as historical enrollment. */
export async function prepareTaskExecution(task:ClaimedWorkflowTask,canonicalRoot:string,project:ProjectConfig,assertLease:()=>Promise<void>):Promise<PreparedTaskExecution>{
 const contract=task.executionPipeline;
 if(!contract?.required)throw Error('A required pipeline contract is missing');
 if(contract.version!==1)throw Error('This worker cannot execute the required pipeline version');
 if(!task.projectId)throw Error('Prepared execution needs the current owning project UUID');
 if(!contract.sourceChanges)return {root:canonicalRoot,commands:[],beforeWrite:async()=>{throw Error('Read-only runs cannot write source; request a source-change workflow.');},assertAuthority:assertLease,release:async()=>{}};
 assertRepairCommitEnabled(project);
 const projectId=task.projectId,owner=`run-workspace:${task.runId}`;
 const namespace=await acquireWorkIntent({projectId,owner,objective:`Prepare isolated execution for ${task.runId}`,fileScopes:[`.agent-workflow/runtime/run-workspaces/${task.runId}`],ttlSeconds:900});
 let writeIntent:{projectId:string;owner:string;fencingToken:string;fileScopes:string[]}|undefined;
 let lost=false;
 const assertAuthority=async()=>{
  await assertLease();if(lost)throw Error('Prepared run ownership was lost');
  const valid=await withClient(async c=>(await c.query('select 1 from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp()',[projectId,owner,namespace.fencingToken])).rowCount);
  if(!valid)throw Error('Prepared workspace intent is not current');
 };
 const renewal=setInterval(()=>{void (async()=>{
  if(!await renewWorkIntent({...namespace,ttlSeconds:900}))lost=true;
  if(writeIntent&&!await renewWorkIntent({...writeIntent,ttlSeconds:900}))lost=true;
 })().catch(()=>{lost=true;});},60000);renewal.unref();
 const release=async()=>{clearInterval(renewal);if(writeIntent)await releaseWorkIntent(writeIntent);await releaseWorkIntent(namespace);};
 try{
  const plans=await pipelineEnvironmentPlans(canonicalRoot,project,task.runId,task.workflowId,task.stageId);
  const workspace=await prepareRunWorkspace({canonicalRoot,runId:task.runId,plans,assertAuthority});
  const beforeWrite=async(relative:string,verifiedPostimageHash?:string)=>{
   await assertAuthority();assertFilePathAllowed(relative,project);
   if(Array.isArray(task.executionWritePaths)&&!task.executionWritePaths.includes(relative))throw Error('This source path is outside the exact new task grant: '+relative);
   const declared=plans.some(plan=>!plan.spec.source_exclude_paths?.some(excluded=>relative===excluded||relative.startsWith(excluded+'/'))&&[...plan.spec.source_paths,...plan.spec.dependency_paths].some(source=>relative===source||relative.startsWith(source+'/')));
   if(!declared)throw Error('A source write needs a declared environment binding: '+relative);
   const original=workspace.sourceFiles.find(file=>file.path===relative),absolute=path.join(canonicalRoot,relative);
   let current:string|null=null;
   try{const stat=await fs.lstat(absolute);if(!stat.isFile()||await fs.realpath(absolute)!==absolute)throw Error('Canonical source is not a regular owning file');current=hash(await fs.readFile(absolute));}catch(error:any){if(error.code!=='ENOENT')throw error;}
   if(current!==(original?.sha256??null)&&current!==verifiedPostimageHash)throw Error('Canonical source changed since this run was prepared: '+relative);
   if(task.executionIntent){
    const intent=await withClient(async c=>(await c.query('select file_scopes from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp()',[projectId,task.executionIntent!.owner,task.executionIntent!.fencingToken])).rows[0]);
    if(!intent)throw Error('The originating source intent is no longer current');
    assertFilePathAllowed(relative,{...project,actions:{...project.actions,allowed_write_paths:intent.file_scopes}});
   }else{
    const sourceOwner=`run-source:${task.runId}:${task.taskId}`,scopes=[...new Set([...(writeIntent?.fileScopes??[]),relative])];
    const acquired=await acquireWorkIntent({projectId,owner:sourceOwner,objective:`Scoped source effects for ${task.runId}/${task.taskId}`,fileScopes:scopes,ttlSeconds:900});
    writeIntent={...acquired,fileScopes:scopes};
   }
  };
  const commands=await literalScopeVerificationCommands(workspace.root,project,task.executionPipeline?.sourcePaths??[]);
  return {root:workspace.root,workspace,commands:commands.length?commands:workspace.verificationCommands,beforeWrite,assertAuthority,release};
 }catch(error){await release();throw error;}
}
