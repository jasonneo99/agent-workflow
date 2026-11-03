import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';

const scenario=process.env.AGENTFLOW_ADMISSION_CASE;
const runtime=fileURLToPath(new URL('../../../',import.meta.url));
if(!scenario){
 test('runtime enrollment tokens cannot be selected as executable source checks',async()=>{
  const {literalScopeVerificationCommands,defaultProfileVerificationCommands}=await import('./run-preparation.js');
  const command='npm run agentflow -- environments list';
  const project=projectConfigSchema.parse({project:{name:'Synthetic enrollment boundary'},execution:{environments:{default_profile:'portable',profiles:{portable:{kind:'native',platform:`${process.platform}/${process.arch==='x64'?'amd64':process.arch}`,source_paths:['tests'],readiness:[{argv:['node','--version']}],verification:[{commands:[command],format:'pytest'}]}}}},actions:{allowed_commands:['npm *'],verification_recipes:[{source_paths:['tests/test_future.py'],test_paths:['tests/test_future.py'],commands:[command],output_paths:[]}]}});
  assert.deepEqual(await literalScopeVerificationCommands(os.tmpdir(),project,['tests/test_future.py']),[]);
  assert.deepEqual(defaultProfileVerificationCommands(project,[{profile:'portable',spec:project.execution.environments!.profiles.portable!}] as any),[]);
 });
 test('explicit pytest recipes govern covered paths while uncovered paths retain inferred checks',async()=>{
  const {literalScopeVerificationCommands}=await import('./run-preparation.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'explicit-runner-precedence-'));
  const pytest='python3 -m pytest tests/test_feature.py -q',coveredUnittest='python3 -m unittest discover -s tests -p test_feature.py -v',otherUnittest='python3 -m unittest discover -s tests -p test_other.py -v';
  try{
   await fs.mkdir(path.join(root,'src'));await fs.mkdir(path.join(root,'tests'));
   await fs.writeFile(path.join(root,'src/feature.py'),'def feature(): return 1\n');
   await fs.writeFile(path.join(root,'tests/test_feature.py'),'def test_feature():\n    assert 1 == 1\n');
   await fs.writeFile(path.join(root,'tests/test_other.py'),'import unittest\nclass Other(unittest.TestCase):\n    def test_other(self): self.assertTrue(True)\n');
   const project=projectConfigSchema.parse({project:{name:'Synthetic runner precedence'},execution:{environments:{default_profile:'portable',profiles:{portable:{kind:'native',platform:`${process.platform}/${process.arch==='x64'?'amd64':process.arch}`,source_paths:['src','tests'],readiness:[{argv:['node','--version']}],verification:[{commands:[pytest],format:'pytest'}]}}}},actions:{allowed_commands:[pytest,coveredUnittest,otherUnittest],verification_recipes:[{source_paths:['src/feature.py','tests/test_feature.py'],test_paths:['tests/test_feature.py'],commands:[pytest],output_paths:[]}]}}),before=JSON.stringify(project);
   assert.deepEqual(await literalScopeVerificationCommands(root,project,['src/feature.py','tests/test_feature.py','tests/test_other.py']),[pytest,otherUnittest]);
   assert.deepEqual(await literalScopeVerificationCommands(root,project,['src/feature.py']),[pytest],'Changing source alone selects its owner-declared existing regression check');
   const separateReads=structuredClone(project);separateReads.actions.verification_recipes![0]!.source_paths=['src/feature.py'];
   assert.deepEqual(await literalScopeVerificationCommands(root,separateReads,['src/feature.py']),[pytest],'Read-only test inputs need no write-scope enrollment');
   assert.deepEqual(await literalScopeVerificationCommands(root,separateReads,['tests/test_feature.py']),[pytest],'Changing only a declared regression test still selects its owner-specified runner');
   assert.deepEqual(await literalScopeVerificationCommands(root,separateReads,['src/feature.py','tests/test_feature.py','tests/test_other.py']),[pytest,otherUnittest],'A covered test path does not acquire a second inferred runner when both source and tests changed');
   const missingReadBinding=structuredClone(project);missingReadBinding.execution.environments!.profiles.portable!.source_paths=['src'];
   assert.deepEqual(await literalScopeVerificationCommands(root,missingReadBinding,['src/feature.py']),[coveredUnittest],'An owner recipe must bind every declared source and test read to the selected environment');
   assert.deepEqual(await literalScopeVerificationCommands(root,project,['tests/test_other.py']),[otherUnittest]);
   assert.equal(JSON.stringify(project),before);
  }finally{await fs.rm(root,{recursive:true,force:true});}
 });
 test('owner project-script recipes use the selected behavioral contract and preserve uncovered node inference',async()=>{
  const {literalScopeVerificationCommands}=await import('./run-preparation.js');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'script-runner-precedence-'));
  const script='python3 scripts/check_environment.py --group portable',node='node --import tsx --test tests/other.test.mjs',fallback='python3 -m unittest discover -s tests -p test_feature.py -v';
  try{
   await fs.mkdir(path.join(root,'tests'));await fs.writeFile(path.join(root,'tests/test_feature.py'),'def test_feature(): assert True\n');
   const profile={kind:'native',platform:`${process.platform}/${process.arch==='x64'?'amd64':process.arch}`,source_paths:['tests'],readiness:[{argv:['node','--version']}],verification:[{commands:[script],format:'pytest'}]};
   const project=projectConfigSchema.parse({project:{name:'Synthetic script recipe'},execution:{environments:{default_profile:'other',profiles:{other:{...profile,verification:[]},portable:profile},selectors:[{workflow:'feature',stage:'author',command:script,profile:'portable'}]}},actions:{allowed_commands:[script,node,fallback],verification_recipes:[{source_paths:['tests/test_feature.py'],test_paths:['tests/test_feature.py'],commands:[script],output_paths:[]}]}});
   const context={runId:'synthetic-run',workflowId:'feature',stageId:'author'};
   assert.deepEqual(await literalScopeVerificationCommands(root,project,['tests/test_feature.py','tests/other.test.mjs'],context),[script,node]);
   assert.deepEqual(await literalScopeVerificationCommands(root,project,['tests/test_feature.py','tests/other.test.mjs'],{...context,stageId:'review'}),[fallback,node],'An unselected explicit recipe cannot suppress an uncovered path');
   const revoked=structuredClone(project);revoked.actions.allowed_commands=[node,fallback];
   assert.deepEqual(await literalScopeVerificationCommands(root,revoked,['tests/test_feature.py','tests/other.test.mjs'],context),[fallback,node],'Recipes add no command authority');
   project.actions.verification_recipes![0]!.source_paths=['tests/test_future.py'];project.actions.verification_recipes![0]!.test_paths=['tests/test_future.py'];
   assert.deepEqual(await literalScopeVerificationCommands(root,project,['tests/test_future.py'],context),[script],'An owner-declared future test needs no fabricated baseline file');
  }finally{await fs.rm(root,{recursive:true,force:true});}
 });
 test('explicit unittest and node recipes retain their declared runners',async()=>{
  const {literalScopeVerificationCommands}=await import('./run-preparation.js');
  const commands=['python3 -m unittest tests.test_feature -v','node --test tests/feature.test.mjs'];
  const project=projectConfigSchema.parse({project:{name:'Synthetic existing runners'},execution:{environments:{default_profile:'portable',profiles:{portable:{kind:'native',platform:`${process.platform}/${process.arch==='x64'?'amd64':process.arch}`,source_paths:['tests'],readiness:[{argv:['node','--version']}],verification:[{commands:[commands[0]],format:'unittest'},{commands:[commands[1]],format:'node-test'}]}}}},actions:{allowed_commands:commands,verification_recipes:[{source_paths:['tests/test_feature.py'],test_paths:['tests/test_feature.py'],commands:[commands[0]],output_paths:[]},{source_paths:['tests/feature.test.mjs'],test_paths:['tests/feature.test.mjs'],commands:[commands[1]],output_paths:[]}]}});
  assert.deepEqual(await literalScopeVerificationCommands(os.tmpdir(),project,['tests/test_feature.py','tests/feature.test.mjs']),commands);
 });
 test('explicit authoring checks effective grants without rejecting review or unchanged tasks',async()=>{
  const {assertStageWriteAdmission}=await import('./run-preparation.js');
  const project=projectConfigSchema.parse({project:{name:'Synthetic author'},actions:{allowed_write_paths:['src/**'],blocked_write_paths:['src/protected/**']}});
  const author={stagePattern:{type:'executor',requires_source_writes:true}};
  assert.doesNotThrow(()=>assertStageWriteAdmission({...author,executionWritePaths:['src/new.mjs']},project));
  for(const executionWritePaths of [[],['docs/guide.md'],['src/protected/private.mjs']])assert.throws(()=>assertStageWriteAdmission({...author,executionWritePaths},project),/no effective authorized write/);
  assert.throws(()=>assertStageWriteAdmission({stagePattern:{type:'verifier',requires_source_writes:true}},project),/write-capable stage/);
  assert.doesNotThrow(()=>assertStageWriteAdmission({stagePattern:{type:'executor'},executionWritePaths:[]},{...project,actions:{...project.actions,allowed_write_paths:[]}}));
  assert.doesNotThrow(()=>assertStageWriteAdmission({stagePattern:{type:'verifier'},executionWritePaths:[]},project));
 });
 test('source admission preserves enrolled pending requirements without inventing delivery obligations',async()=>{
  const {sourcePhaseAdmission}=await import('./run-preparation.js');
  const contract:any={deliverables:[{id:'installed',description:'Install the approved artifact',status:'pending',requiredGates:['supervision']},{id:'launch',description:'Launch the installed artifact',status:'pending',requiredGates:['supervision']},{id:'ui',description:'Independently inspect the visible UI',status:'pending',requiredGates:['verification']},{id:'source',description:'Source checks pass',status:'verified',requiredGates:['verification']}]},before=JSON.stringify(contract);
  const result=sourcePhaseAdmission(contract);
  assert.deepEqual(result.pendingDeliverables,contract.deliverables.slice(0,3));assert.equal(result.attestsProductDelivery,false);assert.equal(result.grantsDeliveryAuthority,false);
  assert.ok(result.unqualifiedCapabilities.includes('visual-ui'));assert.equal(JSON.stringify(contract),before);
  assert.deepEqual(sourcePhaseAdmission().pendingDeliverables,[],'Source-only contracts gain no deployment requirement');
 });
}
test('actual worker admits required inputs and readiness before any provider call',async t=>{
 if(!scenario){
  for(const name of ['author-no-writes','author-empty-grant','author-readonly-role','missing-prerequisite','readiness-failure','readiness-success','planning-no-baseline','planning-baseline'])await t.test(name,()=>{
   const env:NodeJS.ProcessEnv={AGENTFLOW_ADMISSION_CASE:name,DEFAULT_MODEL_PROVIDER:'mock',AGENTFLOW_FALLBACK_PROVIDER:'mock',OTEL_TRACING_ENABLED:'0',AGENTFLOW_MEMORY_GRAPH:'0',AGENTFLOW_FLEET_USAGE_DIRECT:'false'};
   for(const key of ['HOME','PATH','TMPDIR','TMP','TEMP'])if(process.env[key])env[key]=process.env[key];
   const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--import','tsx','--test',fileURLToPath(import.meta.url)],{env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
   assert.equal(child.error,undefined);assert.equal(child.status,0,(child.stdout??'')+(child.stderr??''));
  });return;
 }
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'worker-admission-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await fs.mkdir(path.join(root,'src'));await fs.mkdir(path.join(root,'tests'));
 await fs.writeFile(path.join(root,'src/source.mjs'),'export const value=1;\n');
 await fs.writeFile(path.join(root,'tests/source.test.mjs'),'throw new Error("ACCEPTANCE_COMMAND_MUST_NOT_RUN_DURING_ADMISSION");\n');
 await fs.writeFile(path.join(root,'readiness.mjs'),scenario==='readiness-failure'?'throw new Error("SYNTHETIC_MISSING_DEPENDENCY");\n':'console.log("SYNTHETIC_RUNTIME_READY");\n');
 const command='node --test tests/source.test.mjs',native=`${process.platform}/${process.arch==='x64'?'amd64':process.arch}`;
 const project=projectConfigSchema.parse({project:{name:'Synthetic worker admission'},policies:{require_approval_for_external_actions:false},execution:{repair_commits:{enabled:true},environments:{default_profile:'source',profiles:{source:{kind:'native',platform:native,source_paths:['src','tests','readiness.mjs'],dependency_paths:scenario==='missing-prerequisite'?['missing-lock.json']:[],readiness:[{argv:['node','readiness.mjs'],expect_output:'SYNTHETIC_RUNTIME_READY'}],verification:[{commands:[command],format:'node-test',minimum_tests:1}]}}}},actions:{allowed_commands:['npm run agentflow -- environments *','npm run agentflow -- repair-checkpoint *','node readiness.mjs',command],allowed_write_paths:scenario==='author-no-writes'?[]:['src/**'],blocked_commands:[],command_timeout_ms:10000}});
 const planning=scenario.startsWith('planning-');
 if(planning){
  const environments=project.execution.environments!;delete environments.default_profile;
  if(scenario==='planning-baseline')environments.baseline_profile='source';
  environments.selectors=[{command,profile:'source'}];
  for(let index=1;index<=4;index++){
   const optionalCommand=`node --test tests/optional-${index}.test.mjs`,profile=`optional-${index}`;
   environments.profiles[profile]={...structuredClone(environments.profiles.source!),platform:process.platform==='darwin'?'linux/amd64':'darwin/arm64',readiness:[{argv:['node',`optional-${index}-readiness.mjs`],attempts:1,interval_ms:250}],verification:[{commands:[optionalCommand],format:'node-test',minimum_tests:1}]};
   environments.selectors.push({command:optionalCommand,profile});project.actions.allowed_commands.push(optionalCommand);
  }
  project.actions.allowed_commands.push('xcodebuild -project Synthetic.xcodeproj');
 }
 const preparedSource=planning||['missing-prerequisite','readiness-failure','readiness-success'].includes(scenario);
 await fs.mkdir(path.join(root,'.agent-workflow'));await fs.writeFile(path.join(root,'.agent-workflow/project.yaml'),JSON.stringify(project));
 const task:any={runId:'synthetic-admission-run',taskId:'synthetic-admission-task',stageId:'author',agentId:'implementation-agent',agentName:'Author',agentPrompt:'Inspect source',workflowId:'feature',workflowTask:'Inspect bounded source',stageGoal:'Inspect source',compiledBrief:'Synthetic fixture',projectId:'synthetic-project',projectRootUri:root,workerId:'synthetic-worker',fencingToken:'1',priorReceipts:[],projectConfig:project,stagePattern:{type:scenario==='author-readonly-role'?'verifier':'executor',requires_source_writes:true},...(scenario==='author-empty-grant'?{executionWritePaths:[]}:{executionWritePaths:['src/new.mjs']}),...(preparedSource?{executionPipeline:{version:1,required:true,isolation:'worktree',sourceChanges:true,sourcePaths:['src/new.mjs'],checkpointStageIds:[]}}:{})};
 if(planning){task.stageId='architecture';task.agentId='technical-architect';task.stagePattern={type:'planner'};delete task.executionWritePaths;delete task.executionPipeline.sourcePaths;}
 const records:any[]=[];let providers=0,blocked:any,failed:any,prepared:any,released=0;
 const replace=async(relative:string,overrides:Record<string,unknown>,strict=false)=>{
  const url=pathToFileURL(path.join(runtime,relative)).href,original=await import(url);
  const defaults=strict?Object.fromEntries(Object.entries(original).map(([key,value])=>[key,typeof value==='function'?()=>{throw Error('Unmocked external boundary '+key);}:value])):original;
  t.mock.module(url,{namedExports:{...defaults,...overrides}});return original;
 };
 const query=async(sql:string)=>({rows:sql.includes('work_intents')?[{valid:1}]:[],rowCount:sql.includes('work_intents')?1:0});
 await replace('packages/storage/src/client.js',{withClient:async(fn:any)=>fn({query})},true);
 await replace('packages/storage/src/postgres.js',{
  claimNextWorkflowTask:async()=>task,startWorkflowTask:async()=>{},assertWorkflowTaskLease:async()=>{},renewWorkflowTaskLease:async()=>true,
  acquireWorkIntent:async(input:any)=>({...input,fencingToken:'1'}),renewWorkIntent:async()=>true,releaseWorkIntent:async()=>{released++;},withClient:async(fn:any)=>fn({query}),
  getArtifactByUri:async()=>null,recordRunAction:async(input:any)=>{records.push(input);return 'db://synthetic/admission/'+records.length;},
  blockWorkflowTask:async(input:any)=>{blocked=input;},failWorkflowTask:async(input:any)=>{failed=input;},completeWorkflowTask:async()=>{throw Error('No acceptance was executed');}
 },true);
 await replace('packages/run-environments/src/workspace.js',{prepareRunWorkspace:async({plans}:any)=>({root,canonicalRoot:root,sourceFiles:plans.flatMap((plan:any)=>plan.sourceFiles),profiles:plans.map((plan:any)=>plan.profile),baselineCommit:'a'.repeat(40),contextRoot:root})});
 const original=await import('./run-preparation.js');
 await replace('packages/workflow-engine/src/run-preparation.js',{prepareTaskExecution:async(...args:any[])=>{prepared=await (original.prepareTaskExecution as any)(...args);return prepared;}});
 await replace('packages/workflow-engine/src/stage-authority.js',{createRenewingStageAuthority:async()=>async()=>{}});
 await replace('packages/workflow-engine/src/recovery-evidence.js',{recoveryEvidence:async()=>''});
 await replace('packages/model-providers/src/routing.js',{selectModelRoute:async()=>({providerId:'mock',modelTier:'standard',reason:'Synthetic boundary'})});
 await replace('packages/model-providers/src/index.js',{executeWithProviderFallback:async()=>{
  providers++;assert.ok(prepared);assert.equal(prepared.readiness[0].status,'ready');assert.deepEqual(prepared.admission.pendingDeliverables,[]);
  if(planning){
   assert.equal(Object.hasOwn(task.executionPipeline,'sourcePaths'),false);assert.equal(Object.hasOwn(task,'executionWritePaths'),false);
   assert.equal(Object.keys(project.execution.environments!.profiles).length,5);assert.equal(project.execution.environments!.default_profile,undefined);
   assert.deepEqual(prepared.readiness.map((item:any)=>item.profile),['source'],'Optional platform profiles are not made ready for an unknown-scope planning task');
  }else await prepared.beforeWrite('src/new.mjs');
  return {output:{outcome:'blocked',blockedReason:'Synthetic stop after successful source admission; acceptance was not executed.',summary:'Admission only',artifact:{},requestedCommands:[],requestedFileWrites:[]},attempts:[],actualProvider:'mock',actualModel:'synthetic',fallbackUsed:false};
 }});
 const {runWorkerOnce}=await import('./executor.js');await runWorkerOnce(1,{recoverExpiredLeases:false});
 assert.equal(failed,undefined);assert.ok(blocked);assert.equal(providers,scenario==='readiness-success'||scenario==='planning-baseline'?1:0);
 if(scenario.startsWith('author-'))assert.match(blocked.reason,/authoring.*(?:write|stage)|write-capable stage/);
 if(scenario==='missing-prerequisite')assert.match(blocked.reason,/ENOENT/);
 if(scenario==='readiness-failure')assert.match(blocked.reason,/SYNTHETIC_MISSING_DEPENDENCY/);
 if(scenario==='planning-no-baseline')assert.match(blocked.reason,/literal declared behavioral verification command/);
 if(preparedSource&&scenario!=='missing-prerequisite')assert.ok(released>0,'Owned preparation intent is released on success or failure');
 if(scenario==='readiness-success'||scenario==='planning-baseline'){
  assert.equal(prepared.admission.attestsProductDelivery,false);assert.equal(await fs.stat(path.join(root,'src/new.mjs')).then(()=>true,()=>false),false);
  assert.equal(records.filter(record=>record.artifactKind==='command_output').length,0);
 }
 if(planning){
  const {selectEnvironment}=await import('../../run-environments/src/index.js');
  const {executeAllowedCommand}=await import('../../local-tools/src/command-executor.js');
  assert.equal(selectEnvironment(project,{runId:task.runId,workflowId:task.workflowId,stageId:task.stageId},'xcodebuild -project Synthetic.xcodeproj'),null);
  await assert.rejects(executeAllowedCommand({cwd:root,project,commandLine:'xcodebuild -project Synthetic.xcodeproj',environmentContext:{runId:task.runId,workflowId:task.workflowId,stageId:task.stageId,requireEnvironment:true}}),/declared prepared environment/);
 }
});
