import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {assertCommandAllowed,executeAllowedCommand} from './command-executor.js';
import {isControllerCommand,workerAllowedCommands} from './controller-commands.js';
import {runEnvironmentCommand} from '../../run-environments/src/index.js';

const commands=['npm run agentflow -- environments list','npm run agentflow -- repair-checkpoint --execute','npm run agentflow -- status',
 'npm --prefix "owned project" run agentflow -- artifacts','npm run --prefix owned agentflow -- status','npm run-script --silent agentflow -- status',
 'npm run -- agentflow -- status','npm.cmd run agentflow -- status','C:\\tools\\npm.cmd run agentflow -- status','agentflow status'];
test('controller enrollment tokens remain policy grants while worker capabilities exclude their invocations',()=>{
 const project=projectConfigSchema.parse({project:{name:'Synthetic capability contract'},actions:{allowed_commands:['npm *','agentflow *',...commands,'npm run agentflow -- environments *','npm run agentflow -- repair-checkpoint *'],blocked_commands:[]}});
 for(const command of commands){assert.equal(isControllerCommand(command),true,command);assert.doesNotThrow(()=>assertCommandAllowed(command,project));}
 for(const capability of ['npm run agentflow -- environments *','npm run agentflow -- repair-checkpoint *'])assert.doesNotThrow(()=>assertCommandAllowed(capability,project));
 for(const command of ['npm test','npm run validate','npm run agentflow-tests','python3 -m unittest tests.test_feature'])assert.equal(isControllerCommand(command),false,command);
 assert.deepEqual(workerAllowedCommands(['npm *','npm run test',...commands]),['npm *','npm run test']);
});
test('nested controller rejection precedes project scripts and npm dependency diagnostics',async()=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'controller-command-'));
 const project=projectConfigSchema.parse({project:{name:'Synthetic worker'},actions:{allowed_commands:['npm *'],blocked_commands:[]}});
 try{
  for(const hasPackage of [false,true]){
   if(hasPackage)await fs.writeFile(path.join(cwd,'package.json'),JSON.stringify({scripts:{agentflow:'node -e "require(\'fs\').writeFileSync(\'EFFECT\',\'bad\')"'}}));
   await assert.rejects(executeAllowedCommand({cwd,project,commandLine:commands[0]!}),/Controller command rejected/);
   let runnerCalls=0;
   await assert.rejects(runEnvironmentCommand({cwd,project,context:{runId:'synthetic-controller'},commandLine:commands[0]!,argv:['npm','run','agentflow','--','environments','list'],runner:async()=>{runnerCalls++;throw Error('Must not run');}}),/Controller command rejected/);
   assert.equal(runnerCalls,0);
   assert.equal(await fs.stat(path.join(cwd,'EFFECT')).then(()=>true,()=>false),false);
  }
 }finally{await fs.rm(cwd,{recursive:true,force:true});}
});
