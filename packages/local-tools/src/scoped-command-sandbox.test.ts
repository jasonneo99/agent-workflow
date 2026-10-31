import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareScopedCommandSandbox} from './scoped-command-sandbox.js';
import {executeAllowedCommand} from './command-executor.js';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';

test('omitted containment preserves existing commands, while unsupported scoped execution fails closed',async()=>{
 const argv=['node','--test','owned.test.js'],env={PATH:'synthetic'};
 const legacy=await prepareScopedCommandSandbox({enabled:false,argv,env,platform:'linux'});assert.equal(legacy.argv,argv);assert.equal(legacy.env,env);await legacy.cleanup();
 await assert.rejects(()=>prepareScopedCommandSandbox({enabled:true,argv,env,platform:'linux'}),/no unsandboxed command/);
});
test('scoped command containment blocks an allowed process from writing an unreserved sentinel', {skip:process.platform!=='darwin'},async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'command-containment-')));
 try{
  const sentinel=path.join(root,'other-family.txt');await fs.writeFile(sentinel,'preserve another owner');
  const script='require("node:fs").writeFileSync(process.argv[1],"unexpected mutation")';
  const commandLine=`${process.execPath} -e '${script}' '${sentinel}'`;
  const project=projectConfigSchema.parse({project:{name:'Synthetic isolation'},actions:{allowed_commands:[`${process.execPath} *`],allowed_write_paths:['owned.txt'],blocked_commands:[],isolate_command_writes:true}});
  const result=await executeAllowedCommand({commandLine,cwd:root,project});
  assert.notEqual(result.exitCode,0,'The command text was granted, but the source write must still be denied');
  assert.equal(await fs.readFile(sentinel,'utf8'),'preserve another owner');assert.match(result.stderr,/EPERM|operation not permitted/i);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('scoped commands may write isolated scratch, return stdout, and clean only their own scratch', {skip:process.platform!=='darwin'},async()=>{
 const script='const fs=require("node:fs"),p=require("node:path");const f=p.join(process.env.TMPDIR,"evidence.txt");fs.writeFileSync(f,"actual output");console.log(fs.readFileSync(f,"utf8"));console.log(process.env.TMPDIR)';
 const project=projectConfigSchema.parse({project:{name:'Synthetic scratch'},actions:{allowed_commands:[`${process.execPath} *`],blocked_commands:[],isolate_command_writes:true}});
 const result=await executeAllowedCommand({commandLine:`${process.execPath} -e '${script}'`,cwd:process.cwd(),project});
 assert.equal(result.exitCode,0,result.stderr);const [output,scratch]=result.stdout.trim().split('\n');assert.equal(output,'actual output');
 assert.match(scratch!,/agentflow-command-/);await assert.rejects(fs.stat(scratch!),{code:'ENOENT'});
});
test('subprocesses inherit write containment instead of escaping a source reservation', {skip:process.platform!=='darwin'},async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'command-descendant-')));
 try{
  const sentinel=path.join(root,'foreign.txt');await fs.writeFile(sentinel,'original');
  const inner='require("node:fs").writeFileSync(process.argv[1],"changed")';
  const script=`const c=require("node:child_process").spawnSync(process.execPath,["-e",${JSON.stringify(inner)},process.argv[1]],{encoding:"utf8"});process.stderr.write(c.stderr);process.exitCode=c.status`;
  const project=projectConfigSchema.parse({project:{name:'Synthetic child'},actions:{allowed_commands:[`${process.execPath} *`],blocked_commands:[],isolate_command_writes:true}});
  const result=await executeAllowedCommand({commandLine:`${process.execPath} -e '${script}' '${sentinel}'`,cwd:root,project});
  assert.notEqual(result.exitCode,0);assert.equal(await fs.readFile(sentinel,'utf8'),'original');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('native PTY capability is exact-recipe opt-in and preserves unrelated device/source denial', {skip:process.platform!=='darwin'},async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'command-native-pty-')));
 let holder:ReturnType<typeof import('node:child_process').spawn>|undefined;
 try{
  const {spawn}=await import('node:child_process');
  // Allocate an unrelated PTY before the sandbox exists and keep it live.
  holder=spawn('python3',['-c','import pty,os; m,s=pty.openpty(); print(os.ttyname(s),flush=True); input()'],{stdio:['pipe','pipe','pipe']});
  const foreign=await new Promise<string>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('PTY holder timed out')),5000);holder!.once('error',reject);holder!.stdout!.once('data',data=>{clearTimeout(timer);resolve(data.toString().trim());});});
  assert.match(foreign,/^\/dev\/ttys[0-9]+$/);
  const sentinel=path.join(root,'foreign-source.txt');await fs.writeFile(sentinel,'preserved');
  const python='import pty,os; m,s=pty.openpty(); os.write(s,b"owned"); assert os.read(m,5)==b"owned"; os.close(s); os.close(m); print("native-pty-ok")';
  const commandLine=`python3 -c '${python}'`;
  const base={project:{name:'Synthetic native fixture'},actions:{allowed_commands:['python3 *'],blocked_commands:[],isolate_command_writes:true}};
  const closed=projectConfigSchema.parse(base);
  assert.equal(closed.actions.scoped_native_pty_commands,undefined);
  assert.notEqual((await executeAllowedCommand({commandLine,cwd:root,project:closed})).exitCode,0,'Default remains denied');
  const project=projectConfigSchema.parse({...base,actions:{...base.actions,scoped_native_pty_commands:[commandLine]}});
  const own=await executeAllowedCommand({commandLine,cwd:root,project});
  assert.equal(own.exitCode,0,own.stderr);assert.match(own.stdout,/native-pty-ok/);
  const other=`python3 -c 'import os; os.open("${foreign}",os.O_WRONLY)'`;
  project.actions.scoped_native_pty_commands!.push(other);
  const denied=await executeAllowedCommand({commandLine:other,cwd:root,project});
  assert.notEqual(denied.exitCode,0,'Another sandbox allocation must not grant this device');assert.match(denied.stderr,/PermissionError|Operation not permitted/);
  const direct=`python3 -c 'from pathlib import Path; Path("${sentinel}").write_text("changed")'`;
  project.actions.scoped_native_pty_commands!.push(direct);
  assert.notEqual((await executeAllowedCommand({commandLine:direct,cwd:root,project})).exitCode,0);
  // Use a JSON literal to avoid shell escaping; the executor never starts a shell.
  const inner=`from pathlib import Path; Path(${JSON.stringify(sentinel)}).write_text("changed")`;
  const descendant=`python3 -c 'import subprocess; r=subprocess.run(["python3","-c",${JSON.stringify(inner)}]); raise SystemExit(r.returncode)'`;
  project.actions.scoped_native_pty_commands!.push(descendant);
  const nested=await executeAllowedCommand({commandLine:descendant,cwd:root,project});
  assert.notEqual(nested.exitCode,0);assert.match(nested.stderr,/PermissionError|Operation not permitted/);
  assert.equal(await fs.readFile(sentinel,'utf8'),'preserved');
  const near=projectConfigSchema.parse({...base,actions:{...base.actions,scoped_native_pty_commands:[commandLine+' --different']}});
  assert.notEqual((await executeAllowedCommand({commandLine,cwd:root,project:near})).exitCode,0,'Near recipe does not grant PTY capability');
 }finally{holder?.stdin?.end('\n');holder?.kill();await fs.rm(root,{recursive:true,force:true});}
});
