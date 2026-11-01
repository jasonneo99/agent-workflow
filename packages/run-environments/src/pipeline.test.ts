import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadWorkflows} from '../../agent-registry/src/loaders.js';
import {projectConfigSchema,workflowSchema} from '../../agent-registry/src/schemas.js';
import {pipelineContract,preparedWorkflow,sourceChangingWorkflow} from './pipeline.js';
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
 for(const workflow of workflows.filter(w=>!sourceChangingWorkflow(w))){
  assert.equal(preparedWorkflow(workflow,true,repair),workflow);
  const contract=pipelineContract(project,workflow,true,true);
  assert.equal(contract.required,true);assert.equal(contract.isolation,'read-only');assert.equal(contract.preparedOnly,true);
 }
 assert.equal(preparedWorkflow(repair,false,repair),repair);
});
