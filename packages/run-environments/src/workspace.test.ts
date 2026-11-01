import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {executeAllowedCommand} from '../../local-tools/src/command-executor.js';
import {ENVIRONMENT_COMMAND,planRunEnvironment,runProcess} from './index.js';
import {prepareRunWorkspace} from './workspace.js';
import {createRepairCheckpoint,createCurrentRevisionCheckpoint,REPAIR_COMMIT_COMMAND,verifyRepairCheckpoint} from './repair-checkpoint.js';
import {planSourceIntegration,publishSourceIntegration} from '../../workflow-engine/src/source-integration.js';

async function fixture(){
 const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'prepared-workspace-'))),canonicalRoot=path.join(parent,'project');
 await fs.mkdir(canonicalRoot);await fs.mkdir(path.join(canonicalRoot,'src'));await fs.mkdir(path.join(canonicalRoot,'tests'));await fs.mkdir(path.join(canonicalRoot,'.agent-workflow'));
 const git=async(root:string,...args:string[])=>{const r=await runProcess(['git',...args],{cwd:root,timeoutMs:10000,maxOutputChars:100000});assert.equal(r.exitCode,0,r.stderr);return r.stdout.trim();};
 await fs.writeFile(path.join(canonicalRoot,'.gitignore'),'.agent-workflow/runtime/\n');
 await fs.writeFile(path.join(canonicalRoot,'src/value.js'),'export const value = 1;\n');
 await fs.writeFile(path.join(canonicalRoot,'tests/value.test.js'),"import test from 'node:test';import assert from 'node:assert/strict';import {value} from '../src/value.js';test('value',()=>assert.equal(value,2));\n");
 await fs.writeFile(path.join(canonicalRoot,'unrelated.txt'),'baseline\n');
 await git(canonicalRoot,'init','-b','main');await git(canonicalRoot,'config','user.name','Synthetic Developer');await git(canonicalRoot,'config','user.email','dev@example.com');await git(canonicalRoot,'config','commit.gpgsign','false');
 await git(canonicalRoot,'add','.');await git(canonicalRoot,'commit','-m','Synthetic baseline');
 await fs.writeFile(path.join(canonicalRoot,'AGENTS.md'),'Private runtime context must never enter a candidate commit.\n');
 await fs.writeFile(path.join(canonicalRoot,'.agent-workflow/project.yaml'),'project: {name: private-overlay-fixture}\n');
 await fs.writeFile(path.join(canonicalRoot,'src/value.js'),'export const value = 2;\n');
 await fs.writeFile(path.join(canonicalRoot,'unrelated.txt'),'unrelated staged work\n');await git(canonicalRoot,'add','unrelated.txt');
 const command='node --test tests/value.test.js';
 const project=projectConfigSchema.parse({project:{name:'Portable fixture'},execution:{repair_commits:{enabled:true},environments:{default_profile:'test',profiles:{test:{kind:'native',platform:`${process.platform}/${process.arch==='x64'?'amd64':process.arch}`,source_paths:['src','tests'],readiness:[{argv:['node','--version']}],verification:[{commands:[command],format:'node-test',expected_tests:1}]}}}},actions:{allowed_commands:[command,'node --version',ENVIRONMENT_COMMAND,REPAIR_COMMIT_COMMAND],allowed_write_paths:['src/**','tests/**']}});
 const plan=await planRunEnvironment({cwd:canonicalRoot,project,context:{runId:'fresh-run'}});
 const prepare=()=>prepareRunWorkspace({canonicalRoot,runId:'fresh-run',plans:[plan],runtimeRoot:path.join(parent,'workspaces'),assertAuthority:async()=>{}});
 const validate=async(root:string,taskId:string)=>{const result=await executeAllowedCommand({cwd:root,project,commandLine:command,environmentContext:{runId:'fresh-run',taskId,requireVerification:true,requireEnvironment:true,managedSource:true}});assert.equal(result.verificationRecipe?.status,'passed',result.stderr);return path.relative(root,result.environment!.receiptPath!);};
 return {parent,canonicalRoot,git,project,plan,prepare,validate,cleanup:()=>fs.rm(parent,{recursive:true,force:true})};
}
test('preparation snapshots dirty declared source without consuming canonical staging or committing private context; reuse preserves writes',async()=>{
 const f=await fixture();try{
  const head=await f.git(f.canonicalRoot,'rev-parse','HEAD'),staged=await f.git(f.canonicalRoot,'diff','--cached');
  const workspace=await f.prepare();
  assert.equal(await f.git(f.canonicalRoot,'rev-parse','HEAD'),head);assert.equal(await f.git(f.canonicalRoot,'diff','--cached'),staged);
  assert.equal(await fs.readFile(path.join(workspace.root,'src/value.js'),'utf8'),'export const value = 2;\n');
  assert.equal(await f.git(workspace.root,'status','--porcelain'),'');
  assert.ok(!(await f.git(workspace.root,'ls-files')).includes('project-context'));
  assert.ok(!(await f.git(workspace.root,'ls-files')).includes('AGENTS.md'));
  assert.match(await fs.readFile(path.join(workspace.root,workspace.contextRoot,'AGENTS.md'),'utf8'),/Private runtime context/);
  await fs.writeFile(path.join(workspace.root,'src/value.js'),'export const value = 3;\n');
  assert.equal((await f.prepare()).baselineCommit,workspace.baselineCommit);
  assert.equal(await fs.readFile(path.join(workspace.root,'src/value.js'),'utf8'),'export const value = 3;\n');
 }finally{await f.cleanup();}
});
test('an unchanged current revision needs real fresh independent test evidence and makes no artificial commit',async()=>{
 const f=await fixture();try{
  const workspace=await f.prepare(),validationReceipt=await f.validate(workspace.root,'repair');
  const candidate=await createCurrentRevisionCheckpoint({cwd:workspace.root,project:f.project,runId:workspace.runId,validationReceipt,assertAuthority:async()=>{}});
  await assert.rejects(createCurrentRevisionCheckpoint({cwd:workspace.root,project:f.project,runId:workspace.runId,taskId:'foreign-task',validationReceipt,assertAuthority:async()=>{}}),/another task/);
  assert.equal(candidate.changeStatus,'unchanged');assert.equal(candidate.commit,workspace.baselineCommit);assert.deepEqual(candidate.files,[]);
  await assert.rejects(verifyRepairCheckpoint({cwd:workspace.root,candidateReceipt:path.relative(workspace.root,candidate.receiptPath!),validationReceipt}),/Independent verification/);
  const independent=await f.validate(workspace.root,'verify');
  const plan=await planSourceIntegration(workspace,candidate,independent);
  assert.deepEqual(plan.files,[]);
  const before=await f.git(f.canonicalRoot,'rev-parse','HEAD');
  assert.deepEqual(await publishSourceIntegration(plan,f.project,async()=>{}),{commit:before,changed:false});
  assert.equal(await f.git(f.canonicalRoot,'diff','--cached','--name-only'),'unrelated.txt');
 }finally{await f.cleanup();}
});
test('verified source publication commits only the owned delta and preserves unrelated staged content',async()=>{
 const f=await fixture();try{
  const workspace=await f.prepare();await fs.writeFile(path.join(workspace.root,'src/value.js'),'// reviewed change\nexport const value = 2;\n');
  const validationReceipt=await f.validate(workspace.root,'repair');
  const candidate=await createRepairCheckpoint({cwd:workspace.root,project:f.project,runId:workspace.runId,expectedParent:workspace.baselineCommit,files:['src/value.js'],validationReceipt,execute:true,assertAuthority:async()=>{}});
  const independent=await f.validate(workspace.root,'verify'),plan=await planSourceIntegration(workspace,candidate,independent);
  assert.deepEqual(plan.files.map(file=>file.path),['src/value.js']);
  const before=await f.git(f.canonicalRoot,'diff','--cached');
  const result=await publishSourceIntegration(plan,f.project,async()=>{});
  assert.equal(result.changed,true);assert.equal(await f.git(f.canonicalRoot,'diff','--cached'),before);
  assert.equal((await f.git(f.canonicalRoot,'rev-list','--parents','-n','1','HEAD')).split(' ').length,2,'canonical history must not merge the preparation snapshot or unrelated candidate ancestors');
  assert.equal(await f.git(f.canonicalRoot,'show','--format=','--first-parent','--name-only','HEAD'),'src/value.js');
  assert.match(await fs.readFile(path.join(f.canonicalRoot,'src/value.js'),'utf8'),/reviewed change/);
 }finally{await f.cleanup();}
});
test('canonical dependency drift and aliased workspace parents fail closed before publication',async()=>{
 const f=await fixture();try{
  const real=path.join(f.parent,'elsewhere');await fs.mkdir(real);await fs.symlink(real,path.join(f.parent,'alias'));
  await assert.rejects(prepareRunWorkspace({canonicalRoot:f.canonicalRoot,runId:'alias-run',plans:[f.plan],runtimeRoot:path.join(f.parent,'alias','nested'),assertAuthority:async()=>{}}),/alias/);
  assert.deepEqual(await fs.readdir(real),[]);
  const workspace=await f.prepare(),validationReceipt=await f.validate(workspace.root,'repair');
  const candidate=await createCurrentRevisionCheckpoint({cwd:workspace.root,project:f.project,runId:workspace.runId,validationReceipt,assertAuthority:async()=>{}}),independent=await f.validate(workspace.root,'verify');
  await fs.appendFile(path.join(f.canonicalRoot,'tests/value.test.js'),'// concurrent owner\n');
  await assert.rejects(planSourceIntegration(workspace,candidate,independent),/dependency changed/);
 }finally{await f.cleanup();}
});
