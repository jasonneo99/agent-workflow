import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const runtime=fileURLToPath(new URL('../../../',import.meta.url));
test('actual worker rejects controller commands before reused evidence, npm preflight, approval or effects',async t=>{
 const scenario=process.env.AGENTFLOW_CONTROLLER_ADMISSION_CASE;
 if(!scenario){
  for(const name of ['missing-package','present-package','prefixed'])await t.test(name,()=>{
   const env:NodeJS.ProcessEnv={AGENTFLOW_CONTROLLER_ADMISSION_CASE:name,DEFAULT_MODEL_PROVIDER:'mock',AGENTFLOW_FALLBACK_PROVIDER:'mock',OTEL_TRACING_ENABLED:'0',AGENTFLOW_MEMORY_GRAPH:'0',AGENTFLOW_FLEET_USAGE_DIRECT:'false'};
   for(const key of ['HOME','PATH','TMPDIR','TMP','TEMP'])if(process.env[key])env[key]=process.env[key];
   const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--import','tsx','--test',fileURLToPath(import.meta.url)],{env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
   assert.equal(child.error,undefined);assert.equal(child.status,0,(child.stdout??'')+(child.stderr??''));
  });return;
 }
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'worker-controller-admission-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 if(scenario==='present-package')await fs.writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{agentflow:'node forbidden.mjs'}}));
 const command=scenario==='prefixed'?'npm --prefix owned run agentflow -- environments list':'npm run agentflow -- environments list';
 const task:any={runId:'synthetic-controller-run',taskId:'synthetic-controller-task',stageId:'inspect',agentId:'implementation-agent',agentName:'Inspector',agentPrompt:'Inspect',workflowId:'feature',workflowTask:'Inspect supplied evidence',stageGoal:'Inspect',compiledBrief:'Synthetic fixture',projectRootUri:root,workerId:'synthetic-worker',fencingToken:'1',priorReceipts:[],projectConfig:{project:{name:'Synthetic controller admission'},policies:{require_approval_for_external_actions:false},actions:{allowed_commands:['npm *'],blocked_commands:[],allowed_write_paths:[]}},stagePattern:{type:'react',maxIterations:2,requiresVerifier:false,promotionGate:'none',stopConditions:[]}};
 const records:any[]=[];let calls=0,lookups=0,preflights=0,effects=0,approvals=0,failed:any;
 const replace=async(relative:string,overrides:Record<string,unknown>,strict=false)=>{
  const url=pathToFileURL(path.join(runtime,relative)).href,original=await import(url);
  const defaults=strict?Object.fromEntries(Object.entries(original).map(([key,value])=>[key,typeof value==='function'?()=>{throw Error('Unmocked external boundary '+key);}:value])):original;
  t.mock.module(url,{namedExports:{...defaults,...overrides}});
 };
 await replace('packages/storage/src/client.js',{withClient:async(fn:any)=>fn({query:async()=>({rows:[]})})},true);
 await replace('packages/storage/src/postgres.js',{
  claimNextWorkflowTask:async()=>task,startWorkflowTask:async()=>{},assertWorkflowTaskLease:async()=>{},renewWorkflowTaskLease:async()=>true,getArtifactByUri:async()=>null,
  findRunActionByIdempotencyKey:async()=>{lookups++;return {runId:task.runId,taskId:task.taskId,uri:'db://synthetic/previous-control',content:{commandLine:command,requestedByTaskId:task.taskId,requestedByStageId:task.stageId,exitCode:0,stdout:'OLD_CONTROL_EVIDENCE',stderr:''}};},
  requestActionApproval:async()=>{approvals++;throw Error('Controller commands cannot receive delegated policy approval');},
  recordRunAction:async(input:any)=>{records.push(input);return 'db://synthetic/controller/'+records.length;},
  blockWorkflowTask:async()=>{},completeWorkflowTask:async()=>{},failWorkflowTask:async(input:any)=>{failed=input;},dismissSupersededActionApprovals:async()=>{}
 },true);
 await replace('packages/local-tools/src/command-executor.js',{executeAllowedCommand:async()=>{effects++;throw Error('Must not spawn');}});
 await replace('packages/workflow-engine/src/command-failure.js',{npmPreflightDiagnostic:()=>{preflights++;return 'Must not inspect npm dependencies';}});
 await replace('packages/workflow-engine/src/stage-authority.js',{createRenewingStageAuthority:async()=>async()=>{}});
 await replace('packages/workflow-engine/src/recovery-evidence.js',{recoveryEvidence:async()=>''});
 await replace('packages/model-providers/src/routing.js',{selectModelRoute:async()=>({providerId:'mock',modelTier:'standard',reason:'Synthetic boundary'})});
 await replace('packages/model-providers/src/index.js',{executeWithProviderFallback:async()=>{
  calls++;return {output:{outcome:calls===1?'completed':'blocked',blockedReason:calls===1?'':'Controller evidence belongs to the orchestrator.',summary:'Consume supplied evidence',artifact:{},requestedCommands:calls===1?[command]:[],requestedFileWrites:[]},attempts:[],actualProvider:'mock',actualModel:'synthetic',fallbackUsed:false};
 }});
 const {runWorkerOnce}=await import('./executor.js');await runWorkerOnce(1,{recoverExpiredLeases:false});
 assert.equal(failed,undefined);assert.ok(calls>0);assert.equal(lookups,0);assert.equal(preflights,0);assert.equal(effects,0);assert.equal(approvals,0);
 const rejected=records.filter(row=>row.actionType==='local_command_rejected');assert.equal(rejected.length,1);assert.match(rejected[0].summary,/Controller command rejected/);
 assert.equal(records.filter(row=>row.actionType==='local_command_reused'||row.artifactKind==='command_output').length,0);
});
