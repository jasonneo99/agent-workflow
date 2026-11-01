import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {ProjectConfig} from '../../agent-registry/src/schemas.js';
import {assertFilePathAllowed} from '../../local-tools/src/file-writer.js';
import {executeAllowedFileMutation,normalizeRequestedFileMutation,type RequestedFileMutation} from '../../local-tools/src/file-patcher.js';
import {evaluateActionApprovalRule,evaluateActionRiskAutoApproval} from '../../policy-engine/src/index.js';
import {runProcess,type EnvironmentPlan} from '../../run-environments/src/index.js';
import {verifyRepairCheckpoint,assertRepairCommitEnabled,type RepairCheckpoint} from '../../run-environments/src/repair-checkpoint.js';
import type {RunWorkspace} from '../../run-environments/src/workspace.js';
import {blockWorkflowTask,completeWorkflowTask,recordRunAction,requestActionApproval,withProjectExecutionLock,type ClaimedWorkflowTask} from '../../storage/src/postgres.js';
import type {PreparedTaskExecution} from './run-preparation.js';

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const git=async(cwd:string,args:string[],env?:Record<string,string>,allowFailure=false)=>{
 const result=await runProcess(['git',...args],{cwd,timeoutMs:30000,maxOutputChars:2_000_000,env});
 if(result.timedOut||result.outputTruncated||(!allowFailure&&result.exitCode!==0))throw Error('Verified integration Git operation failed: '+(result.stderr||result.stdout));
 return result;
};
export interface SourceIntegrationFile {path:string;beforeHash:string|null;afterHash:string;mode:string;blob:string;request:RequestedFileMutation;needsWrite:boolean}
export interface SourceIntegrationPlan {workspace:RunWorkspace;candidate:RepairCheckpoint;files:SourceIntegrationFile[];sourceFiles:EnvironmentPlan['sourceFiles'];canonicalHead:string}

/** Fresh verifier evidence must cover the cumulative run-owned delta, not just
 * the final documentation stage. No canonical byte is changed by this preview. */
export async function planSourceIntegration(workspace:RunWorkspace,candidate:RepairCheckpoint,validationReceipt:string):Promise<SourceIntegrationPlan>{
 if(!candidate.receiptPath)throw Error('Integration requires its retained candidate receipt');
 await verifyRepairCheckpoint({cwd:workspace.root,candidateReceipt:path.relative(workspace.root,candidate.receiptPath),validationReceipt});
 const validation=JSON.parse(await fs.readFile(path.join(workspace.root,validationReceipt),'utf8'));
 const sourceFiles=validation.plan.sourceFiles as EnvironmentPlan['sourceFiles'];
 const changed=(await git(workspace.root,['diff','--name-only','-z',workspace.baselineCommit,candidate.commit!])).stdout.split('\0').filter(Boolean);
 const files:SourceIntegrationFile[]=[];
 for(const relative of changed){
  if(!sourceFiles.some(file=>file.path===relative))throw Error('Final verification does not cover this cumulative source change: '+relative);
  const entry=(await git(workspace.root,['ls-tree','-z',candidate.commit!,'--',relative])).stdout.split('\0')[0];
  if(!entry)throw Error('Canonical source deletion needs its own supported explicit action: '+relative);
  const [mode,,blob]=entry.slice(0,entry.indexOf('\t')).split(' ');
  if(!['100644','100755'].includes(mode!)||!blob||entry.slice(entry.indexOf('\t')+1)!==relative)throw Error('Source integration accepts only exact regular files');
  const bytes=await fs.readFile(path.join(workspace.root,relative)),afterHash=sha(bytes);
  const beforeHash=workspace.sourceFiles.find(file=>file.path===relative)?.sha256??null;
  let current:Buffer|null=null;try{const file=path.join(workspace.canonicalRoot,relative);if(!(await fs.lstat(file)).isFile()||await fs.realpath(file)!==file)throw Error('Canonical target is not regular');current=await fs.readFile(file);}catch(error:any){if(error.code!=='ENOENT')throw error;}
  const currentHash=current?sha(current):null;
  if(currentHash!==beforeHash&&currentHash!==afterHash)throw Error('Canonical target changed after preparation: '+relative);
  const patch=beforeHash?(await git(workspace.root,['diff','--no-ext-diff',workspace.baselineCommit,candidate.commit!,'--',relative])).stdout:null;
  const request:RequestedFileMutation=patch?{path:relative,patch,expectedHash:beforeHash,content:null}:{path:relative,content:bytes.toString('utf8')};
  files.push({path:relative,beforeHash,afterHash,mode:mode!,blob,request,needsWrite:currentHash!==afterHash});
 }
 for(const file of sourceFiles){
  if(files.some(changed=>changed.path===file.path))continue;
  const absolute=path.join(workspace.canonicalRoot,file.path),stat=await fs.lstat(absolute);
  if(!stat.isFile()||await fs.realpath(absolute)!==absolute||sha(await fs.readFile(absolute))!==file.sha256)throw Error('A canonical test dependency changed after verification: '+file.path);
 }
 if((await git(workspace.canonicalRoot,['diff','--cached','--name-only','--',...files.map(file=>file.path)])).stdout.trim()&&files.length)throw Error('Canonical integration would consume staged work; preserve it and reconcile the exact owned paths');
 return {workspace,candidate,files,sourceFiles,canonicalHead:(await git(workspace.canonicalRoot,['rev-parse','HEAD'])).stdout.trim()};
}

export async function publishSourceIntegration(plan:SourceIntegrationPlan,project:ProjectConfig,assertAuthority:()=>Promise<void>,recordWrite?:(value:Record<string,unknown>)=>Promise<void>):Promise<{commit:string;changed:boolean}>{
 assertRepairCommitEnabled(project);const root=plan.workspace.canonicalRoot;
 for(const file of plan.files){
  await assertAuthority();assertFilePathAllowed(file.path,project);
  if(file.needsWrite){
   const selected=normalizeRequestedFileMutation(file.request);if(!selected)throw Error('Integration has no exact file mutation');
   const result=await withProjectExecutionLock({projectRootUri:root,resource:'file:'+file.path},()=>executeAllowedFileMutation({...selected,request:file.request,cwd:root,project}));
   if(result.nextHash!==file.afterHash)throw Error('Published source differs from the verified candidate');
   await recordWrite?.({...result,integrationCandidate:plan.candidate.commit});
  }
 }
 if(!plan.files.length)return {commit:(await git(root,['rev-parse','HEAD'])).stdout.trim(),changed:false};
 const directory=path.join(root,'.agent-workflow/runtime/run-workspaces',plan.workspace.runId);await fs.mkdir(directory,{recursive:true});
 const index=path.join(directory,randomUUID()+'.index'),env={GIT_INDEX_FILE:index};
 try{
  for(let attempt=0;attempt<3;attempt++){
   await assertAuthority();
   for(const file of plan.files)if(sha(await fs.readFile(path.join(root,file.path)))!==file.afterHash)throw Error('Canonical source moved before commit publication');
   for(const file of plan.sourceFiles)if(!plan.files.some(changed=>changed.path===file.path)&&sha(await fs.readFile(path.join(root,file.path)))!==file.sha256)throw Error('Canonical dependency moved before commit publication');
   const parent=(await git(root,['rev-parse','HEAD'])).stdout.trim(),reference=(await git(root,['symbolic-ref','HEAD'])).stdout.trim();
   await git(root,['read-tree',parent],env);
   for(const file of plan.files)await git(root,['update-index','--add','--cacheinfo',`${file.mode},${file.blob},${file.path}`],env);
   const tree=(await git(root,['write-tree'],env)).stdout.trim();
   if(tree===(await git(root,['rev-parse','HEAD^{tree}'])).stdout.trim())return {commit:parent,changed:false};
   const changed=(await git(root,['diff-tree','--no-commit-id','--name-only','-r','-z',parent,tree])).stdout.split('\0').filter(Boolean);
   if(changed.some(file=>!plan.files.some(owned=>owned.path===file)))throw Error('Integration tree changed outside the verified delta');
   const commit=(await git(root,['-c','user.name=Agent Workflow','-c','user.email=agent-workflow@localhost','commit-tree',tree,'-p',parent,'-p',plan.candidate.commit!,'-m','Integrate independently verified source candidate'])).stdout.trim();
   await assertAuthority();const published=await git(root,['update-ref',reference,commit,parent],undefined,true);
   if(published.exitCode!==0)continue;
   await git(root,['restore','--staged','--source',commit,'--',...plan.files.map(file=>file.path)]);
   return {commit,changed:true};
  }
  throw Error('Canonical branch kept moving; the verified delta and every prior commit were retained');
 }finally{await fs.rm(index,{force:true});await fs.rm(index+'.lock',{force:true});}
}

export async function integratePreparedSource(task:ClaimedWorkflowTask,preparation:PreparedTaskExecution,project:ProjectConfig,assertLease:()=>Promise<void>):Promise<'completed'|'blocked'>{
 const workspace=preparation.workspace!;
 const candidate=[...(task.priorStageArtifacts??[])].reverse().find(stage=>stage.artifact.repairCheckpoint)?.artifact.repairCheckpoint as RepairCheckpoint|undefined;
 const verification=[...(task.priorStageArtifacts??[])].reverse().find(stage=>stage.artifact.repairVerification)?.artifact.repairVerification as {validationReceipt?:string}|undefined;
 const block=async(reason:string,extra:Record<string,unknown>={})=>{await blockWorkflowTask({taskId:task.taskId,runId:task.runId,agentId:task.agentId,workerId:task.workerId!,fencingToken:task.fencingToken,summary:reason,reason,artifact:{phase:'source-integration',outcome:'blocked',blockedReason:reason,...extra}});return 'blocked' as const;};
 try{
  if(!candidate||!verification?.validationReceipt)throw Error('Trusted integration requires the independent source checkpoint result');
  const plan=await planSourceIntegration(workspace,candidate,verification.validationReceipt),pending:string[]=[];
  for(const file of plan.files){
   await preparation.beforeWrite(file.path,file.afterHash);
   if(!file.needsWrite)continue;
   const selected=normalizeRequestedFileMutation(file.request)!;
   const rule=evaluateActionApprovalRule({project,actionType:'file_write',target:file.path,bytes:selected.bytes})??evaluateActionRiskAutoApproval({project,actionType:'file_write',target:file.path,bytes:selected.bytes});
   if(project.policies.require_approval_for_external_actions&&rule?.effect!=='auto_execute'){
    const approval=await requestActionApproval({runId:task.runId,taskId:task.taskId,stageId:task.stageId,agentId:task.agentId,actionType:'file_write',target:file.path,rationale:'Publish this exact independently verified source delta into its canonical owning checkout. No deployment, native action or original acceptance is included.',policyDecision:{approvalRequired:true,allowedByPolicy:true,policyProfile:project.execution.policy_profile},payload:{relativePath:file.path,bytes:selected.bytes,payloadHash:sha(selected.payload),mode:selected.isPatch?'patch':'replace',expectedHash:selected.expectedHash,canonicalProjectRoot:workspace.canonicalRoot,projectRootHash:sha(workspace.canonicalRoot),candidateCommit:candidate.commit},idempotencyKey:`integration:${candidate.commit}:${file.path}:${file.afterHash}`});
    pending.push(approval.approvalId);
   }
  }
  if(pending.length)return block('Exact canonical source publication approval and execution are required.',{approvalIds:pending,requestedFileWrites:plan.files.filter(file=>file.needsWrite).map(file=>file.request),candidateCommit:candidate.commit,originalAcceptanceChanged:false});
  const published=await publishSourceIntegration(plan,project,async()=>{await assertLease();await preparation.assertAuthority();},async write=>{await recordRunAction({runId:task.runId,taskId:task.taskId,agentId:task.agentId,actionType:'file_write',target:String(write.relativePath),summary:'Published only the independently verified canonical source delta.',artifactKind:'file_write',artifactContent:{...write,executionMode:'verified-source-integration'}});});
  await recordRunAction({runId:task.runId,taskId:task.taskId,agentId:task.agentId,actionType:'verified_source_integrated',target:published.commit,summary:'Verified source is current in the canonical checkout; original installed/native/product acceptance stays separate.',artifactKind:'source_integration',artifactContent:{...published,candidateCommit:candidate.commit,sourceHash:candidate.sourceHash,files:plan.files.map(file=>file.path),originalAcceptanceChanged:false}});
  await completeWorkflowTask({taskId:task.taskId,runId:task.runId,agentId:task.agentId,workerId:task.workerId!,fencingToken:task.fencingToken,summary:published.changed?'Integrated the independently verified source candidate.':'The independently verified current source already matches the canonical checkout.',artifact:{sourceIntegration:published,repairCheckpoint:candidate,repairVerification:verification,originalAcceptanceChanged:false,acceptance:'unverified'}});
  return 'completed';
 }catch(error){return block(error instanceof Error?error.message:String(error));}
}
