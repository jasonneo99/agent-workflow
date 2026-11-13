import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {pathToFileURL,fileURLToPath} from 'node:url';
const runtime=fileURLToPath(new URL('../../../',import.meta.url));
const at=(p:string)=>pathToFileURL(path.join(runtime,p)).href;
test('actual worker retains a source-bound verified no-change checkpoint without a product write',async t=>{
 if(process.env.AGENTFLOW_NO_CHANGE_WORKER_CHILD!=='1'){
  // Only the provider and storage/lease boundaries are synthetic. Native test
  // execution, Git workspace and current-revision validation stay real.
  const env:NodeJS.ProcessEnv={AGENTFLOW_NO_CHANGE_WORKER_CHILD:'1',DEFAULT_MODEL_PROVIDER:'mock',AGENTFLOW_FALLBACK_PROVIDER:'mock',OTEL_TRACING_ENABLED:'0',AGENTFLOW_MEMORY_GRAPH:'0',AGENTFLOW_FLEET_USAGE_DIRECT:'false'};
  for(const key of ['HOME','PATH','TMPDIR','TMP','TEMP'])if(process.env[key])env[key]=process.env[key];
  const child=spawnSync(process.execPath,['--experimental-test-module-mocks','--import','tsx','--test',fileURLToPath(import.meta.url)],{env,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024});
  const output=(child.stdout??'')+(child.stderr??'');
  console.log(output.split('\n').find(line=>line.startsWith('NO_CHANGE_WORKER_OBSERVATION'))??output.slice(-3000));
  assert.equal(child.error,undefined);assert.equal(child.status,0,output);return;
 }
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'no-change-worker-'))),canonical=path.join(root,'project');
 await fs.mkdir(canonical);t.after(async()=>{await fs.rm(root,{recursive:true,force:true});});
 await fs.mkdir(path.join(canonical,'src'));await fs.mkdir(path.join(canonical,'tests'));
 await fs.writeFile(path.join(canonical,'src/labels.mjs'),"export function normalizeLabel(text) { return text.trim().replace(/\\s+/g, ' '); }\n");
 await fs.writeFile(path.join(canonical,'tests/acceptance.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {normalizeLabel} from '../src/labels.mjs';test('existing normalizer',()=>{assert.equal(normalizeLabel('  Build   UI  '),'Build UI');assert.equal(normalizeLabel('a\\tb\\nc'),'a b c');assert.equal(normalizeLabel('MiXeD Case'),'MiXeD Case');console.log('NO_CHANGE_TEST_OBSERVED');});\n");
 await fs.writeFile(path.join(canonical,'.gitignore'),'.agent-workflow/\n.qualification-observations.json\n');
 const git=(...args:string[])=>execFileSync('git',args,{cwd:canonical,encoding:'utf8'}).trim();
 git('init','-b','main');git('config','user.name','Synthetic Developer');git('config','user.email','dev@example.com');git('config','commit.gpgsign','false');git('config','core.hooksPath','.git/test-hooks');git('add','.');git('commit','-m','Synthetic correct baseline');const canonicalHead=git('rev-parse','HEAD');
 const {projectConfigSchema}=await import(at('packages/agent-registry/src/schemas.ts'));
 const {planRunEnvironment,ENVIRONMENT_COMMAND}=await import(at('packages/run-environments/src/index.ts'));
 const {prepareRunWorkspace}=await import(at('packages/run-environments/src/workspace.ts'));
 const {REPAIR_COMMIT_COMMAND}=await import(at('packages/run-environments/src/repair-checkpoint.ts'));
 const command='node --test tests/acceptance.test.mjs';
 const project=projectConfigSchema.parse({project:{name:'Synthetic verified no-change'},execution:{repair_commits:{enabled:true,stages:['repair']},environments:{default_profile:'native',profiles:{native:{kind:'native',platform:process.platform+'/'+(process.arch==='x64'?'amd64':process.arch),source_paths:['src','tests'],readiness:[{argv:['node','--version']}],verification:[{commands:[command],format:'node-test',expected_tests:1}]}}}},policies:{require_approval_for_external_actions:false},actions:{allowed_commands:[command,'node --version',ENVIRONMENT_COMMAND,REPAIR_COMMIT_COMMAND],allowed_write_paths:[]}});
 await fs.mkdir(path.join(canonical,'.agent-workflow'));await fs.writeFile(path.join(canonical,'.agent-workflow/project.yaml'),JSON.stringify(project));
 await fs.writeFile(path.join(root,'trusted.yaml'),'commands: []\n');process.env.AGENTFLOW_TRUSTED_COMMANDS_FILE=path.join(root,'trusted.yaml');
 const runId='synthetic-no-change-run',taskId='synthetic-no-change-task';
 const plan=await planRunEnvironment({cwd:canonical,project,context:{runId}});
 const workspace=await prepareRunWorkspace({canonicalRoot:canonical,runId,plans:[plan],runtimeRoot:path.join(root,'workspaces'),assertAuthority:async()=>{}});
 const task:any={runId,taskId,stageId:'repair',checkpointAfter:true,agentId:'implementation-agent',agentName:'Synthetic Implementer',agentPrompt:'Inspect only',workflowId:'repair-blocked-item',workflowTask:'Verify the existing normalizer and return a no-change result if it is correct. No source writes are permitted.',stageGoal:'Verify existing behavior',compiledBrief:'Synthetic no-change fixture',projectId:'synthetic-project',projectRootUri:canonical,workerId:'synthetic-worker',fencingToken:'1',priorReceipts:[],projectConfig:project,stagePattern:{type:'react',maxIterations:3,requiresVerifier:false,promotionGate:'none',stopConditions:[]},executionPipeline:{version:1,required:true,isolation:'worktree',sourceChanges:true,sourcePaths:[],checkpointStageIds:['repair']}};
 const records:any[]=[],artifacts=new Map<string,any>();let completed:any,blocked:any,failed:any,calls=0,claims=0;
 const replace=async(p:string,overrides:Record<string,unknown>,strict=false)=>{const url=at(p),original=await import(url);const defaults=strict?Object.fromEntries(Object.entries(original).map(([k,v])=>[k,typeof v==='function'?()=>{throw Error('Unexpected external boundary '+k);}:v])):original;t.mock.module(url,{namedExports:{...defaults,...overrides}});};
 await replace('packages/storage/src/client.ts',{withClient:async(fn:any)=>fn({query:async(sql:string)=>{if(sql.includes('to_regclass'))return {rows:[]};assert.match(sql,/from artifacts a/);return {rows:[]};}})},true);
 await replace('packages/storage/src/postgres.ts',{
  claimNextWorkflowTask:async()=>task,startWorkflowTask:async()=>{},assertWorkflowTaskLease:async()=>{},renewWorkflowTaskLease:async()=>true,
  getArtifactByUri:async(uri:string)=>artifacts.get(uri)??null,findRunActionByIdempotencyKey:async()=>null,
  recordRunAction:async(input:any)=>{const uri='db://synthetic/'+records.length;const row={uri,runId,taskId,kind:input.artifactKind,content:input.artifactContent};records.push({...input,uri});artifacts.set(uri,row);return uri;},
  claimSideEffect:async()=>{claims++;return {status:'claimed',claimToken:'synthetic-claim'};},finalizeSideEffect:async()=>true,dismissSupersededActionApprovals:async()=>{},
  completeWorkflowTask:async(input:any)=>{completed=input;},blockWorkflowTask:async(input:any)=>{blocked=input;},failWorkflowTask:async(input:any)=>{failed=input;}
 },true);
 await replace('packages/workflow-engine/src/stage-authority.ts',{createRenewingStageAuthority:async()=>async()=>{}});
 await replace('packages/workflow-engine/src/run-preparation.ts',{prepareTaskExecution:async()=>({root:workspace.root,workspace,commands:[command],beforeWrite:async()=>{throw Error('No source writes permitted');},assertAuthority:async()=>{},release:async()=>{}})});
 await replace('packages/workflow-engine/src/recovery-evidence.ts',{recoveryEvidence:async()=>''});
 await replace('packages/model-providers/src/routing.ts',{selectModelRoute:async()=>({providerId:'mock',modelTier:'standard',reason:'Synthetic deterministic fixture'})});
 await replace('packages/model-providers/src/index.ts',{providerFromEnv:()=>{throw Error('No live provider');},executeWithProviderFallback:async({stageInput}:any)=>{calls++;if(calls>1)assert.ok(stageInput.priorReceipts.some((r:any)=>r.summary.includes('NO_CHANGE_TEST_OBSERVED')));return {output:{outcome:'completed',summary:calls===1?'Inspect the existing correct normalizer using its required check.':'Existing implementation verified; no files changed.',artifact:{findings:['Existing behavior meets the contract; no files changed.'],nextAction:'Retain the verified current revision.'},requestedCommands:calls===1?[command]:[],requestedFileWrites:[]},attempts:[],actualProvider:'mock',actualModel:'synthetic',fallbackUsed:false};}});
 const {runWorkerOnce}=await import(at('packages/workflow-engine/src/executor.ts'));
 const result=await runWorkerOnce(1,{recoverExpiredLeases:false});
 const commandRecord=records.find(r=>r.artifactKind==='command_output');assert.ok(commandRecord);assert.equal(commandRecord.artifactContent.exitCode,0);assert.equal(commandRecord.artifactContent.verificationRecipe.status,'passed');
 console.log('NO_CHANGE_WORKER_OBSERVATION '+JSON.stringify({result,calls,claims,blockedReason:blocked?.reason,failed,commandTypes:blocked?.artifact?.actionResults?.filter((r:any)=>r.commandLine).map((r:any)=>r.type??null),checkpointActions:records.filter(r=>r.artifactKind==='repair_commit_candidate').map(r=>r.actionType)}));
 assert.equal(failed,undefined);assert.equal(result.completed,1,'Actual passing unchanged source must reach a verified no-change checkpoint, not a prose rejection');assert.ok(completed);assert.equal(blocked,undefined);assert.equal(calls,2);assert.equal(claims,1);
 const candidate=records.find(r=>r.actionType==='current_revision_checkpoint');assert.ok(candidate);assert.deepEqual(candidate.artifactContent.files,[]);assert.equal(candidate.artifactContent.changeStatus,'unchanged');assert.equal(candidate.artifactContent.commit,workspace.baselineCommit);assert.equal(git('rev-parse','HEAD'),canonicalHead);assert.equal(git('status','--porcelain'),'');
 assert.equal(completed.artifact.repairCheckpoint.commit,workspace.baselineCommit);
});
