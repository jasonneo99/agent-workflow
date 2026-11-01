import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ProjectConfig } from '../../agent-registry/src/schemas.js';
import { planRunEnvironment, runProcess, type EnvironmentPlan, type ProcessRunner } from './index.js';
import {verificationCommandMatches} from './evidence.js';

const sha=(body:Buffer|string)=>createHash('sha256').update(body).digest('hex');
const validId=(value:string)=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,126}$/u.test(value);
const safePath=(value:string)=>!!value&&!path.isAbsolute(value)&&!value.includes('\\')&&!value.split('/').some(p=>!p||p==='.'||p==='..');
export interface RunWorkspace {
  version:1;runId:string;canonicalRoot:string;root:string;branch:string;baseRevision:string;baselineCommit:string;commonDirectory:string;
  sourceFiles:EnvironmentPlan['sourceFiles'];verificationCommands:string[];profiles:string[];preparedAt:string;contextRoot:string;
  authority:'isolated-current-source-snapshot';historicalBaselineAdopted:false;
}
export async function pipelineEnvironmentPlans(cwd:string,project:ProjectConfig,runId:string,workflowId:string,stageId:string):Promise<EnvironmentPlan[]> {
  const environments=project.execution.environments;
  if(!environments)throw Error('Prepared source execution needs declared environment profiles; no host fallback is permitted.');
  const profiles=new Map<string,EnvironmentPlan>();
  for(const command of project.actions.allowed_commands.filter(command=>!command.includes('*'))){
    try{
      const plan=await planRunEnvironment({cwd,project,context:{runId,workflowId,stageId},commandLine:command});
      if(plan.spec.verification.some(rule=>rule.commands.some(pattern=>verificationCommandMatches(command,pattern))))profiles.set(plan.profile,plan);
    }catch(error){
      // An unrelated literal command may have no selector. A selected source
      // profile is still validated in full below, never silently downgraded.
      if(!/No environment profile matches/.test(String(error)))throw error;
    }
  }
  if(environments.default_profile&&!profiles.has(environments.default_profile)){
    const plan=await planRunEnvironment({cwd,project,context:{runId,workflowId,stageId,profile:environments.default_profile}});profiles.set(plan.profile,plan);
  }
  if(!profiles.size)throw Error('Prepared source execution has no matching declared behavioral test profile.');
  return [...profiles.values()];
}
export async function prepareRunWorkspace(input:{canonicalRoot:string;runId:string;plans:EnvironmentPlan[];assertAuthority:()=>Promise<void>;runner?:ProcessRunner;runtimeRoot?:string}):Promise<RunWorkspace>{
  if(!validId(input.runId)||!input.plans.length)throw Error('An exact run and nonempty environment plan are required');
  const canonicalRoot=await fs.realpath(input.canonicalRoot),runner=input.runner??runProcess;
  const git=async(cwd:string,args:string[],allowFailure=false)=>{
    const result=await runner(['git',...args],{cwd,timeoutMs:30000,maxOutputChars:2_000_000});
    if(result.timedOut||result.outputTruncated||(!allowFailure&&result.exitCode!==0))throw Error(`Run workspace Git operation failed: ${result.stderr||result.stdout}`);
    return result;
  };
  const ownedParents=async(root:string,relative:string)=>{
    let current=root;
    for(const segment of relative.split('/').slice(0,-1)){
      current=path.join(current,segment);await fs.mkdir(current).catch((error:any)=>{if(error.code!=='EEXIST')throw error;});
      if(!(await fs.lstat(current)).isDirectory()||await fs.realpath(current)!==current)throw Error('Workspace parent is an alias');
    }
  };
  const commonDirectory=(await git(canonicalRoot,['rev-parse','--path-format=absolute','--git-common-dir'])).stdout.trim();
  const evidenceDir=path.join(canonicalRoot,'.agent-workflow/runtime/run-workspaces',input.runId);
  await input.assertAuthority();await ownedParents(canonicalRoot,`.agent-workflow/runtime/run-workspaces/${input.runId}/workspace.json`);
  if(await fs.realpath(evidenceDir)!==evidenceDir)throw Error('Run workspace receipt directory is not project-owned');
  const receipt=path.join(evidenceDir,'workspace.json');
  let existing:RunWorkspace|undefined;
  try{existing=JSON.parse(await fs.readFile(receipt,'utf8'));}catch(error:any){if(error.code!=='ENOENT')throw error;}
  if(existing){
    if(existing.version!==1||existing.runId!==input.runId||existing.canonicalRoot!==canonicalRoot||existing.commonDirectory!==commonDirectory
      ||await fs.realpath(existing.root)!==existing.root||(await git(existing.root,['rev-parse','--path-format=absolute','--git-common-dir'])).stdout.trim()!==commonDirectory
      ||(await git(existing.root,['symbolic-ref','--short','HEAD'])).stdout.trim()!==existing.branch)throw Error('Existing run workspace identity does not match this owning run');
    await git(existing.root,['merge-base','--is-ancestor',existing.baselineCommit,'HEAD']);
    await input.assertAuthority();return existing;
  }
  const lock=path.join(evidenceDir,'preparing');await fs.mkdir(lock).catch((error:any)=>{if(error.code==='EEXIST')throw Error('Run workspace preparation already has an owner; reconcile its lease before continuing');throw error;});
  const token=randomUUID();await fs.writeFile(path.join(lock,'owner'),token,{flag:'wx'});
  try{
    const baseRevision=(await git(canonicalRoot,['rev-parse','HEAD'])).stdout.trim();
    const base=path.resolve(input.runtimeRoot??path.join(path.dirname(canonicalRoot),'.agent-workflow-workspaces',sha(canonicalRoot).slice(0,16)));
    if(base===canonicalRoot||base.startsWith(canonicalRoot+path.sep))throw Error('Run workspaces must be outside the shared checkout');
    await ownedParents(path.parse(base).root,path.relative(path.parse(base).root,path.join(base,'placeholder')));
    if(await fs.realpath(base)!==base)throw Error('Workspace parent is an alias');
    const root=path.join(base,input.runId),branch=`codex/workflow-${input.runId}`;
    await input.assertAuthority();await git(canonicalRoot,['worktree','add','-b',branch,root,baseRevision]);
    const sources=new Map<string,EnvironmentPlan['sourceFiles'][number]>();
    for(const file of input.plans.flatMap(plan=>plan.sourceFiles)){
      const prior=sources.get(file.path);
      if(prior&&(prior.sha256!==file.sha256||prior.mode!==file.mode))throw Error('Source changed between environment plans: '+file.path);
      sources.set(file.path,file);
    }
    const sourceFiles=[...sources.values()].sort((a,b)=>a.path.localeCompare(b.path));
    if(sourceFiles.length>20000)throw Error('Combined workspace source scope exceeds its bound');
    const copied:string[]=[];
    for(const file of sourceFiles){
      if(!safePath(file.path))throw Error('Invalid prepared source path');
      const source=path.join(canonicalRoot,file.path),stat=await fs.lstat(source);
      if(!stat.isFile()||await fs.realpath(source)!==source||stat.size!==file.bytes)throw Error('Prepared source identity changed '+file.path);
      const bytes=await fs.readFile(source);if(sha(bytes)!==file.sha256)throw Error('Prepared source changed '+file.path);
      const destination=path.join(root,file.path);await ownedParents(root,file.path);
      // A tracked symlink in the old commit cannot redirect the new snapshot.
      try{if((await fs.lstat(destination)).isSymbolicLink())throw Error('Workspace source target is a symlink');}catch(error:any){if(error.code!=='ENOENT')throw error;}
      if(await fs.realpath(path.dirname(destination))!==path.dirname(destination))throw Error('Workspace source parent is an alias');
      await fs.writeFile(destination,bytes);await fs.chmod(destination,file.mode);copied.push(file.path);
    }
    const contextRoot='.agent-workflow/runtime/project-context';
    for(const relative of ['AGENTS.md','.agent-workflow/project.yaml','.agent-workflow/context.md','.agent-workflow/commands.md','.agent-workflow/decisions.md']){
      const source=path.join(canonicalRoot,relative);let bytes:Buffer;
      try{const stat=await fs.lstat(source);if(!stat.isFile()||stat.size>2_000_000||await fs.realpath(source)!==source)throw Error('Unsafe project context');bytes=await fs.readFile(source);}catch(error:any){if(error.code==='ENOENT')continue;throw error;}
      const contextPath=contextRoot+'/'+relative.replace('.agent-workflow/',''),destination=path.join(root,contextPath);await ownedParents(root,contextPath);
      try{if((await fs.lstat(destination)).isSymbolicLink())throw Error('Workspace context target is a symlink');}catch(error:any){if(error.code!=='ENOENT')throw error;}
      await fs.writeFile(destination,bytes);
    }
    const ignore=path.join(root,'.gitignore');let previous='';try{if(!(await fs.lstat(ignore)).isFile()||await fs.realpath(ignore)!==ignore)throw Error('Workspace ignore file is not regular');previous=await fs.readFile(ignore,'utf8');}catch(error:any){if(error.code!=='ENOENT')throw error;}
    const lines=['.agent-workflow/runtime/','.agent-workflow/context-gateway/','.agent-workflow/receipts/context-gateway/'];
    await fs.writeFile(ignore,previous+(previous&&!previous.endsWith('\n')?'\n':'')+lines.filter(line=>!previous.split('\n').includes(line)).map(line=>line+'\n').join(''));copied.push('.gitignore');
    for(const file of sourceFiles)if(sha(await fs.readFile(path.join(canonicalRoot,file.path)))!==file.sha256)throw Error('Canonical source moved during preparation '+file.path);
    await input.assertAuthority();
    for(let index=0;index<copied.length;index+=64)await git(root,['add','--force','--',...copied.slice(index,index+64)]);
    await git(root,['-c','user.name=Agent Workflow','-c','user.email=agent-workflow@localhost','commit','--allow-empty','-m','Prepare isolated current-source baseline']);
    const baselineCommit=(await git(root,['rev-parse','HEAD'])).stdout.trim();
    if((await git(root,['status','--porcelain=v1','--untracked-files=all'])).stdout)throw Error('Prepared workspace contains unowned changes');
    const result:RunWorkspace={version:1,runId:input.runId,canonicalRoot,root,branch,baseRevision,baselineCommit,commonDirectory,sourceFiles,
      verificationCommands:[...new Set(input.plans.flatMap(plan=>plan.spec.verification.flatMap(rule=>rule.commands)))].filter(command=>!command.includes('*')),profiles:input.plans.map(plan=>plan.profile),contextRoot,preparedAt:new Date().toISOString(),authority:'isolated-current-source-snapshot',historicalBaselineAdopted:false};
    await input.assertAuthority();await fs.writeFile(receipt,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
  }finally{
    if(await fs.readFile(path.join(lock,'owner'),'utf8')===token){await fs.unlink(path.join(lock,'owner'));await fs.rmdir(lock);}
  }
}
