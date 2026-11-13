import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {admitManagedGitCommand,executeAllowedCommand} from './command-executor.js';

const project=projectConfigSchema.parse({project:{name:'Synthetic source hash observation'},actions:{allowed_commands:['git *'],blocked_commands:[],command_timeout_ms:5_000}});
const environmentContext={runId:'synthetic-source-hash',requireEnvironment:true,managedSource:true};
const rawHash=(body:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex');

async function fixture(check:(input:{cwd:string;root:string;marker:string;trace:string;git:(...argv:string[])=>string})=>Promise<void>) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-git-hash-'))),cwd=path.join(root,'repo'),home=path.join(root,'home');
 const marker=path.join(root,'filter-called'),trace=path.join(root,'trace.log');
 const keys=['HOME','USERPROFILE','GIT_CONFIG_NOSYSTEM','GIT_CONFIG_GLOBAL','GIT_TRACE'] as const;
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try {
  await fs.mkdir(cwd);await fs.mkdir(home);await fs.mkdir(path.join(cwd,'src'));
  process.env.HOME=home;process.env.USERPROFILE=home;process.env.GIT_CONFIG_NOSYSTEM='1';process.env.GIT_CONFIG_GLOBAL=path.join(home,'absent');delete process.env.GIT_TRACE;
  const git=(...argv:string[])=>{const result=spawnSync('git',argv,{cwd,encoding:'utf8',env:process.env,timeout:5_000});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  git('init','--quiet','--object-format=sha1');
  await fs.writeFile(path.join(cwd,'src','source.dat'),'raw source body\n');
  await fs.writeFile(path.join(cwd,'src','other file.txt'),'second source body\n');
  await fs.writeFile(path.join(cwd,'.gitattributes'),'*.dat filter=synthetic\n');
  const helper=path.join(root,'filter.mjs');
  await fs.writeFile(helper,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'called');process.stdout.write('filtered source body\\n');\n`);
  const filterCommand=[process.execPath,helper].map(word=>'"'+word.replace(/["\\$`]/gu,'\\$&')+'"').join(' ');
  git('config','filter.synthetic.clean',filterCommand);git('config','filter.synthetic.required','true');
  await check({cwd,root,marker,trace,git});
 } finally {
  for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
  await fs.rm(root,{recursive:true,force:true});
 }
}

async function snapshot(root:string):Promise<Record<string,unknown>> {
 const result:Record<string,unknown>={};
 async function visit(directory:string) {
  for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
   const file=path.join(directory,entry.name),stat=await fs.lstat(file),relative=path.relative(root,file);
   if(stat.isSymbolicLink())result[relative]={mode:stat.mode,target:await fs.readlink(file)};
   else if(stat.isDirectory())await visit(file);
   else result[relative]={mode:stat.mode,hash:createHash('sha256').update(await fs.readFile(file)).digest('hex')};
  }
 }
 await visit(root);return result;
}

test('managed hash-object returns raw Git blob hashes without running a configured filter or writing objects',async()=>{
 await fixture(async({cwd,marker,trace,git})=>{
  // The ordinary bare Git command does invoke this real clean filter.
  assert.equal(git('hash-object','src/source.dat'),rawHash('filtered source body\n'));
  assert.equal(await fs.readFile(marker,'utf8'),'called');await fs.unlink(marker);
  const before=await snapshot(cwd);process.env.GIT_TRACE=trace;
  const commandLine='git hash-object src/source.dat "src/other file.txt"';
  const result=await executeAllowedCommand({cwd,project,commandLine,environmentContext});
  assert.equal(result.exitCode,0,result.stderr);assert.equal(result.timedOut,false);
  assert.equal(result.stdout,`${rawHash('raw source body\n')}\n${rawHash('second source body\n')}\n`);
  assert.equal(result.commandLine,commandLine);assert.equal(result.environment,undefined);
  assert.deepEqual(await snapshot(cwd),before);await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  assert.match(await fs.readFile(trace,'utf8'),/built-in: git hash-object --no-filters -- /u);
 });
});

test('managed hash-object rejects options, escape paths and missing or non-regular inputs before Git starts',async()=>{
 await fixture(async({cwd,root,marker,trace})=>{
  await fs.writeFile(path.join(root,'outside.txt'),'outside');
  const before=await snapshot(cwd);process.env.GIT_TRACE=trace;
  const commands=[
   'git hash-object','git hash-object -w src/source.dat','git hash-object --stdin','git hash-object --stdin-paths',
   'git hash-object --path=src/source.dat src/source.dat','git hash-object --filters src/source.dat',
   'git hash-object --no-filters src/source.dat','git hash-object -- src/source.dat','git hash-object -t blob src/source.dat',
   `git hash-object "${path.join(cwd,'src/source.dat')}"`,'git hash-object ../outside.txt',
   'git hash-object src/../src/source.dat','git hash-object ./src/source.dat','git hash-object src//source.dat',
   'git hash-object C:/source.dat','git hash-object "src\\source.dat"','git hash-object src',
   'git hash-object missing.dat','git hash-object src/source.dat missing.dat','git hash-object .git/config',
   'git -c filter.synthetic.clean=cat hash-object src/source.dat','git hash-object src/source.dat --write'
  ];
  for(const commandLine of commands)await assert.rejects(executeAllowedCommand({cwd,project,commandLine,environmentContext}),/Source-control mutations|Prepared Git observations|hash-object/u,commandLine);
  assert.deepEqual(await snapshot(cwd),before);
  for(const file of [marker,trace])await assert.rejects(fs.stat(file),{code:'ENOENT'});
 });
});

test('managed hash-object rejects both file and ancestor symlinks without following them',{skip:process.platform==='win32'?'Creating symlinks requires separate Windows privileges.':false},async()=>{
 await fixture(async({cwd,root,marker,trace})=>{
  await fs.writeFile(path.join(root,'outside.txt'),'outside');
  await fs.symlink(path.join(root,'outside.txt'),path.join(cwd,'linked.dat'));
  await fs.symlink(path.join(cwd,'src'),path.join(cwd,'linked-dir'),'dir');
  const before=await snapshot(cwd);process.env.GIT_TRACE=trace;
  for(const file of ['linked.dat','linked-dir/source.dat'])await assert.rejects(executeAllowedCommand({cwd,project,commandLine:`git hash-object ${file}`,environmentContext}),/hash-object/u);
  assert.deepEqual(await snapshot(cwd),before);
  for(const file of [marker,trace])await assert.rejects(fs.stat(file),{code:'ENOENT'});
 });
});

test('pre-claim Git admission is read-only and enforces owning file read policy without granting command permission',async()=>{
 await fixture(async({cwd,marker,trace})=>{
  await fs.writeFile(path.join(cwd,'.env'),'synthetic-private-value');
  await fs.writeFile(path.join(cwd,'src','blocked.dat'),'synthetic-blocked-value');
  const before=await snapshot(cwd);process.env.GIT_TRACE=trace;
  const input={cwd,project,managedSource:true};
  const commandLine='git hash-object src/source.dat';
  assert.deepEqual(await admitManagedGitCommand({...input,commandLine}),{managedGitRead:true,executionArgv:['git','hash-object','--no-filters','--','src/source.dat']});
  const blocked={...project,actions:{...project.actions,allowed_read_paths:['src/**'],blocked_read_paths:['.env','src/blocked.dat']}};
  for(const file of ['.env','src/blocked.dat']) {
   await assert.rejects(admitManagedGitCommand({...input,project:blocked,commandLine:`git hash-object ${file}`}),/blocked path pattern/u);
   await assert.rejects(executeAllowedCommand({cwd,project:blocked,commandLine:`git hash-object ${file}`,environmentContext}),/blocked path pattern/u);
  }
  await assert.rejects(admitManagedGitCommand({...input,project:{...project,actions:{...project.actions,allowed_read_paths:['docs/**']}},commandLine}),/not allowed by project policy/u);
  await assert.rejects(admitManagedGitCommand({...input,commandLine:'git hash-object -w src/source.dat'}),/hash-object/u);
  assert.deepEqual(await snapshot(cwd),before);
  for(const file of [marker,trace])await assert.rejects(fs.stat(file),{code:'ENOENT'});
 });
});

test('managed hash-object rejects whitespace-disguised paths before policy normalization or Git execution',async()=>{
 await fixture(async({cwd,marker,trace})=>{
  await fs.mkdir(path.join(cwd,' src'));
  for(const file of ['src/public.txt',' src/public.txt','src/public.txt '])await fs.writeFile(path.join(cwd,file),`distinct ${file}`);
  const exactProject={...project,actions:{...project.actions,allowed_read_paths:['src/public.txt'],blocked_read_paths:[]}};
  const before=await snapshot(cwd);process.env.GIT_TRACE=trace;
  for(const relative of [' src/public.txt','src/public.txt ']) {
   const commandLine=`git hash-object "${relative}"`;
   await assert.rejects(admitManagedGitCommand({cwd,project:exactProject,managedSource:true,commandLine}),/hash-object/u);
   await assert.rejects(executeAllowedCommand({cwd,project:exactProject,commandLine,environmentContext}),/hash-object/u);
  }
  assert.deepEqual(await snapshot(cwd),before);
  for(const file of [marker,trace])await assert.rejects(fs.stat(file),{code:'ENOENT'});
 });
});

test('managed hash-object never grants project command authority',async()=>{
 await fixture(async({cwd,trace})=>{
  process.env.GIT_TRACE=trace;
  const commandLine='git hash-object src/source.dat';
  await assert.rejects(executeAllowedCommand({cwd,project:{...project,actions:{...project.actions,allowed_commands:[]}},commandLine,environmentContext}),/not allowed by project policy/u);
  await assert.rejects(executeAllowedCommand({cwd,project:{...project,actions:{...project.actions,blocked_commands:[commandLine]}},commandLine,environmentContext}),/blocked pattern/u);
  await assert.rejects(fs.stat(trace),{code:'ENOENT'});
 });
});
