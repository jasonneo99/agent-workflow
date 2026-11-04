import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {executeAllowedCommand} from './command-executor.js';

async function withGitFixture(check:(fixture:{cwd:string;commit:string;trace:string;marker:string;output:string})=>Promise<void>) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-git-inspection-')));
 const cwd=path.join(root,'repo'),home=path.join(root,'home'),trace=path.join(root,'trace.log'),marker=path.join(root,'helper-calls'),output=path.join(cwd,'output.txt');
 const keys=['HOME','USERPROFILE','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_TRACE'] as const;
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try {
  await fs.mkdir(cwd);await fs.mkdir(home);
  process.env.HOME=home;process.env.USERPROFILE=home;process.env.GIT_CONFIG_NOSYSTEM='1';process.env.GIT_CONFIG_GLOBAL=path.join(home,'missing-config');delete process.env.GIT_TRACE;
  const git=(...args:string[])=>{
   const result=spawnSync('git',args,{cwd,env:process.env,encoding:'utf8',timeout:5_000});
   assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  git('init','--quiet');git('config','user.name','Synthetic Fixture');git('config','user.email','fixture@example.invalid');
  const hooks=path.join(root,'empty-hooks');await fs.mkdir(hooks);git('config','core.hooksPath',hooks);
  await fs.writeFile(path.join(cwd,'tracked.txt'),'before\n');await fs.writeFile(path.join(cwd,'.gitattributes'),'*.txt diff=synthetic\n');
  git('add','.');git('commit','--quiet','--no-gpg-sign','-m','baseline');
  await fs.writeFile(path.join(cwd,'tracked.txt'),'committed change\n');git('add','tracked.txt');git('commit','--quiet','--no-gpg-sign','-m','change');
  const commit=git('rev-parse','HEAD');
  await fs.writeFile(path.join(cwd,'tracked.txt'),'uncommitted content must survive\n');
  await fs.writeFile(path.join(cwd,'staged.txt'),'staged content must survive\n');git('add','staged.txt');
  const helper=path.join(root,'helper.mjs');
  await fs.writeFile(helper,`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(marker)},'called\\n');process.stdout.write('synthetic helper output');\n`);
  const helperCommand=[process.execPath,helper].map(word=>'"'+word.replace(/["\\$`]/gu,'\\$&')+'"').join(' ');
  git('config','diff.external',helperCommand);git('config','diff.synthetic.textconv',helperCommand);git('config','alias.inspect','!'+helperCommand);
  process.env.GIT_TRACE=trace;
  await check({cwd,commit,trace,marker,output});
 } finally {
  for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  await fs.rm(root,{recursive:true,force:true});
 }
}

async function snapshot(root:string):Promise<Record<string,{hash:string;mode:number}>> {
 const result:Record<string,{hash:string;mode:number}>={};
 async function visit(directory:string) {
  for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
   const file=path.join(directory,entry.name);
   if(entry.isDirectory())await visit(file);
   else {const stat=await fs.lstat(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink());result[path.relative(root,file)]={hash:createHash('sha256').update(await fs.readFile(file)).digest('hex'),mode:stat.mode};}
  }
 }
 await visit(root);return result;
}

const project=projectConfigSchema.parse({project:{name:'Synthetic managed Git inspection'},actions:{allowed_commands:['git *'],blocked_commands:[],command_timeout_ms:5_000}});
const environmentContext={runId:'synthetic-git-inspection',requireEnvironment:true,managedSource:true};

test('managed diff-tree observes committed filenames without changing source, index or HEAD or invoking helpers',async()=>{
 await withGitFixture(async({cwd,commit,trace,marker})=>{
  const before=await snapshot(cwd);
  for(const revision of [commit,'HEAD']) {
   const commandLine=`git diff-tree --no-commit-id --name-status -r ${revision}`;
   const result=await executeAllowedCommand({cwd,project,commandLine,environmentContext});
   assert.equal(result.exitCode,0,result.stderr);assert.equal(result.timedOut,false);assert.equal(result.stdout,'M\ttracked.txt\n');
   assert.equal(result.commandLine,commandLine);assert.equal(result.environment,undefined);assert.equal(result.verificationRecipe,undefined);
  }
  assert.deepEqual(await snapshot(cwd),before);
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  const actualTrace=await fs.readFile(trace,'utf8');
  assert.match(actualTrace,/built-in: git diff-tree --no-ext-diff --no-textconv --no-commit-id --name-status -r /u);
 });
});

test('managed diff-tree rejects output, helper, config, aliases and unknown forms before spawning',async()=>{
 await withGitFixture(async({cwd,commit,trace,marker,output})=>{
  const before=await snapshot(cwd),base=`git diff-tree --no-commit-id --name-status -r ${commit}`;
  const rejected=[
   ...['--output=output.txt','--output output.txt','--out=output.txt','--out output.txt','-O tracked.txt','--ext-diff','--textconv','--filters','--no-index','--stdin','--unknown','--no-commit-i','--'].map(option=>`${base} ${option}`),
   `git diff-tree --no-commit-i --name-status -r ${commit}`,
   `git diff-tree --no-commit-id --name-sta -r ${commit}`,
   `git diff-tree --no-commit-id --name-status -r ${commit} ${commit}`,
   `git diff-tree --no-commit-id --name-status -r HEAD~1`,
   `git -c diff.external=synthetic diff-tree --no-commit-id --name-status -r ${commit}`,
   `git --config-env=diff.external=SYNTHETIC_HELPER diff-tree --no-commit-id --name-status -r ${commit}`,
   `git --git-dir=.git diff-tree --no-commit-id --name-status -r ${commit}`,
   `git -C . diff-tree --no-commit-id --name-status -r ${commit}`,
   'git inspect','git config alias.inspect synthetic','git add .','git commit -m synthetic','git reset --hard','git update-ref refs/heads/synthetic HEAD'
  ];
  for(const commandLine of rejected)await assert.rejects(executeAllowedCommand({cwd,project,commandLine,environmentContext}),/Source-control mutations|Prepared Git observations/u,commandLine);
  assert.deepEqual(await snapshot(cwd),before);
  for(const file of [trace,marker,output])await assert.rejects(fs.stat(file),{code:'ENOENT'});
 });
});

test('managed diff-tree still requires project permission and rejects shell syntax',async()=>{
 await withGitFixture(async({cwd,commit,trace})=>{
  const commandLine=`git diff-tree --no-commit-id --name-status -r ${commit}`;
  await assert.rejects(executeAllowedCommand({cwd,project:{...project,actions:{...project.actions,allowed_commands:[]}},commandLine,environmentContext}),/not allowed by project policy/u);
  await assert.rejects(executeAllowedCommand({cwd,project:{...project,actions:{...project.actions,blocked_commands:[commandLine]}},commandLine,environmentContext}),/blocked pattern/u);
  for(const suffix of [' > output.txt','; git add .',' | cat'])await assert.rejects(executeAllowedCommand({cwd,project,commandLine:commandLine+suffix,environmentContext}),/shell metacharacters/u);
  await assert.rejects(fs.stat(trace),{code:'ENOENT'});
 });
});
