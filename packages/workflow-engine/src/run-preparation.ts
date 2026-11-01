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
import {validProjectArtifactPath,type RunPipelineContract} from '../../run-environments/src/pipeline.js';
import type {EnvironmentPlan} from '../../run-environments/src/index.js';

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export interface PreparedTaskExecution {
 root:string;workspace?:RunWorkspace;commands:string[];
 beforeWrite(relative:string,verifiedPostimageHash?:string):Promise<void>;
 assertAuthority():Promise<void>;
 release():Promise<void>;
}
/** Artifact declarations narrow the current and frozen policies; they never grant source or command authority. */
export function artifactExecutionPolicy(project:ProjectConfig,contract:RunPipelineContract,current=project):ProjectConfig {
 if(contract.sourceChanges||contract.isolation!=='project-artifacts')throw Error('Expected a project-artifact contract');
 const paths=contract.artifactPaths;
 if(!paths?.length||paths.some(relative=>!validProjectArtifactPath(relative,project)||!validProjectArtifactPath(relative,current)))throw Error('Invalid project-artifact contract paths');
 return {...project,actions:{...project.actions,allowed_commands:[],allowed_write_paths:paths.filter(relative=>{
  try{assertFilePathAllowed(relative,project);assertFilePathAllowed(relative,current);return true;}catch{return false;}
 })}};
}
export async function assertPhysicalArtifactPath(root:string,relative:string):Promise<void>{
 const canonical=await fs.realpath(root);let absolute=canonical;
 for(const part of relative.split('/')){
  absolute=path.join(absolute,part);
  try{const stat=await fs.lstat(absolute);if(stat.isSymbolicLink()||await fs.realpath(absolute)!==absolute)throw Error('Project artifact path is an alias');}
  catch(error:any){if(error.code!=='ENOENT')throw error;}
 }
}
export function defaultProfileVerificationCommands(project:ProjectConfig,plans:readonly EnvironmentPlan[]):string[]{
 const name=project.execution.environments?.default_profile;
 const selected=name?plans.find(plan=>plan.profile===name):plans.length===1?plans[0]:undefined;
 return [...new Set(selected?.spec.verification.flatMap(rule=>rule.commands)??[])].filter(command=>{
  if(command.includes('*'))return false;
  try{assertCommandAllowed(command,project);return true;}catch{return false;}
 });
}
async function prepareProjectArtifacts(task:ClaimedWorkflowTask,root:string,project:ProjectConfig,assertLease:()=>Promise<void>):Promise<PreparedTaskExecution>{
 const policy=artifactExecutionPolicy(project,task.executionPipeline!);
 const scopes=policy.actions.allowed_write_paths.filter(relative=>!Array.isArray(task.executionWritePaths)||task.executionWritePaths.includes(relative));
 await assertLease();
 const intent=scopes.length?await acquireWorkIntent({projectId:task.projectId!,owner:`run-artifacts:${task.runId}:${task.taskId}`,objective:`Maintain exact project artifacts for ${task.runId}/${task.taskId}`,fileScopes:scopes,ttlSeconds:900}):undefined;
 let lost=false,released=false;
 const assertAuthority=async()=>{
  await assertLease();if(lost||released)throw Error('Project-artifact ownership was lost');
  if(intent&&!await withClient(async c=>(await c.query('select 1 from work_intents where project_id=$1 and owner=$2 and fencing_token::text=$3 and expires_at>clock_timestamp()',[intent.projectId,intent.owner,intent.fencingToken])).rowCount))throw Error('Project-artifact intent is not current');
 };
 const renewal=intent?setInterval(()=>{void renewWorkIntent({...intent,ttlSeconds:900}).then(ok=>{if(!ok)lost=true;}).catch(()=>{lost=true;});},60000):undefined;renewal?.unref();
 return {root,commands:[],assertAuthority,release:async()=>{released=true;if(renewal)clearInterval(renewal);if(intent)await releaseWorkIntent(intent);},beforeWrite:async(relative)=>{
  await assertAuthority();assertFilePathAllowed(relative,policy);
  if(!scopes.includes(relative))throw Error('Artifact path is outside the exact task grant: '+relative);
  await assertPhysicalArtifactPath(root,relative);
 }};
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
 if(!contract.sourceChanges&&contract.isolation==='project-artifacts')return prepareProjectArtifacts(task,canonicalRoot,project,assertLease);
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
  return {root:workspace.root,workspace,commands:commands.length?commands:defaultProfileVerificationCommands(project,plans),beforeWrite,assertAuthority,release};
 }catch(error){await release();throw error;}
}
