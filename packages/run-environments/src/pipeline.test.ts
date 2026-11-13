import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadWorkflows} from '../../agent-registry/src/loaders.js';
import {projectConfigSchema,workflowSchema} from '../../agent-registry/src/schemas.js';
import {pipelineContract,preparedWorkflow,sourceChangingWorkflow,projectArtifactPaths} from './pipeline.js';
import {verificationCommandMatches} from './evidence.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
test('test contract patterns match literal commands without acting as execution grants',()=>{
 assert.equal(verificationCommandMatches('python3 -m unittest discover -s tests -p test_example.py -v','python3 -m unittest discover -s tests -p test_*.py -v'),true);
 assert.equal(verificationCommandMatches('python3 arbitrary.py','python3 -m unittest *'),false);
 assert.equal(verificationCommandMatches('node --test x.js extra','node --test x.js'),false);
});
test('required normalization preserves source goals and ends every source phase with verification and trusted integration',async()=>{
 const workflows=await loadWorkflows(root),repair=workflows.find(w=>w.id==='repair-blocked-item')!;
 for(const original of workflows.filter(sourceChangingWorkflow)){
  const snapshot=JSON.stringify(original),normalized=preparedWorkflow(original,true,repair);
  assert.equal(JSON.stringify(original),snapshot,'historical definitions are immutable');
  assert.equal(normalized.stages.at(-1)?.runtime_operation,'integrate-source',original.id);
  assert.equal(normalized.stages.at(-2)?.pattern.type,'verifier',original.id);
  assert.ok(normalized.stages.some(stage=>stage.checkpoint_after),original.id);
  assert.equal(new Set(normalized.stages.map(stage=>stage.id)).size,normalized.stages.length);
  for(let i=1;i<normalized.stages.length;i++)assert.ok(normalized.stages[i]!.depends_on?.includes(normalized.stages[i-1]!.id));
  workflowSchema.parse(normalized);
 }
 const agent=workflowSchema.parse({...repair,id:'specialist-task',stages:[{...repair.stages[0],goal:'Keep this original exact task goal.'}]});
 assert.match(preparedWorkflow(agent,true,repair).stages[0]!.goal,/original exact task goal/);
});
test('read-only workflows keep their contracts and installation requirement cannot be opted out by project config',async()=>{
 const workflows=await loadWorkflows(root),repair=workflows.find(w=>w.id==='repair-blocked-item')!;
 const project=projectConfigSchema.parse({project:{name:'Portable fixture'},execution:{pipeline:{required:false}}});
 for(const workflow of workflows.filter(w=>w.execution?.kind==='read-only')){
  assert.equal(preparedWorkflow(workflow,true,repair),workflow);
  const contract=pipelineContract(project,workflow,true,true);
  assert.equal(contract.required,true);assert.equal(contract.isolation,'read-only');assert.equal(contract.preparedOnly,true);
 }
 assert.equal(preparedWorkflow(repair,false,repair),repair);
});
test('prepared source verification retains original requirements and identifies downstream product gates',async()=>{
 const repair=(await loadWorkflows(root)).find(w=>w.id==='repair-blocked-item')!;
 const original=workflowSchema.parse({...repair,stages:repair.stages.map(stage=>stage.pattern.type==='verifier'?{...stage,goal:'Run the explicitly required full source suite.',acceptance_criteria:['The full source suite passes']}:stage)});
 const before=JSON.stringify(original),prepared=preparedWorkflow(original,true,repair),verifier=prepared.stages.find(stage=>stage.pattern.type==='verifier')!;
 assert.equal(JSON.stringify(original),before);
 assert.match(verifier.goal,/Run the explicitly required full source suite\./);
 assert.match(verifier.goal,/declared verification recipes in its selected environment first/);
 assert.match(verifier.goal,/including a required full suite/);
 assert.match(verifier.goal,/downstream required obligations/);
 assert.match(verifier.goal,/does not establish overall product acceptance/);
 assert.deepEqual(verifier.acceptance_criteria,['The full source suite passes']);
 assert.deepEqual(preparedWorkflow(prepared,true,repair),prepared,'Normalization cannot duplicate or change a frozen phase notice');
});
test('single-stage source normalization preserves explicit authoring admission without inventing it',async()=>{
 const repair=(await loadWorkflows(root)).find(workflow=>workflow.id==='repair-blocked-item')!;
 for(const requires_source_writes of [undefined,true,false]){
  const original=workflowSchema.parse({...repair,id:'single-author',stages:[{...repair.stages[0]!,pattern:{...repair.stages[0]!.pattern,...(requires_source_writes===undefined?{}:{requires_source_writes})}}]}),before=JSON.stringify(original);
  const prepared=preparedWorkflow(original,true,repair);
  assert.equal(prepared.stages[0]!.pattern.requires_source_writes,requires_source_writes);
  assert.equal(JSON.stringify(original),before);
 }
});
test('context and roadmap maintenance retain their original stages and exact artifact-only contract',async()=>{
 const workflows=await loadWorkflows(root),repair=workflows.find(w=>w.id==='repair-blocked-item')!;
 const project=projectConfigSchema.parse({project:{name:'Portable fixture',roadmap_path:'docs/ROADMAP.md'}});
 for(const id of ['maintain-context','roadmap-curation']){
  const workflow=workflows.find(w=>w.id===id)!;
  assert.equal(sourceChangingWorkflow(workflow),false);
  assert.equal(preparedWorkflow(workflow,true,repair),workflow);
  const contract=pipelineContract(project,workflow,true);
  assert.equal(contract.isolation,'project-artifacts');assert.equal(contract.sourceChanges,false);
  assert.deepEqual(contract.checkpointStageIds,[]);
  assert.ok(contract.artifactPaths?.length);
  if(id==='roadmap-curation'){
   assert.deepEqual(contract.artifactPaths,['docs/ROADMAP.md']);
   assert.equal(workflow.stages.at(-1)?.approval_required,true);
  }
 }
 const roadmap=workflows.find(w=>w.id==='roadmap-curation')!;
 for(const relative of ['../ROADMAP.md','/ROADMAP.md','.env/notes.md','src/code.ts','.git/config.md','node_modules/notes.md']){
  assert.throws(()=>projectArtifactPaths({...project,project:{...project.project,roadmap_path:relative}},roadmap),/Invalid/);
 }
 assert.throws(()=>workflowSchema.parse({...roadmap,execution:{kind:'project-artifacts',artifact_paths:['src/code.ts']}}));
});
