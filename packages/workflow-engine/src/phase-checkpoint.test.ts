import assert from 'node:assert/strict';import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {loadWorkflows} from '../../agent-registry/src/loaders.js';
import {projectConfigSchema} from '../../agent-registry/src/schemas.js';
import {constructDynamicWorkflow} from '../../dynamic-workflow/src/index.js';
import {pipelineContract,preparedWorkflow} from '../../run-environments/src/pipeline.js';
import {repairVerifierPolicy} from '../../run-environments/src/repair-checkpoint.js';
import {shouldCheckpointSourcePhase} from './phase-checkpoint.js';

test('prepared feature phases include test authoring in the candidate before the independent verifier',async()=>{
 const project=projectConfigSchema.parse({project:{name:'Synthetic feature'},actions:{allowed_write_paths:['src/**','tests/**']},execution:{repair_commits:{enabled:true,stages:['implement','repair','fix']}}});
 const repair=(await loadWorkflows(fileURLToPath(new URL('../../../',import.meta.url)))).find(w=>w.id==='repair-blocked-item')!;
 const original=constructDynamicWorkflow({goal:'Implement a desktop feature with regression coverage and deploy it',project,executionProfile:'adaptive'}),before=JSON.stringify(original);
 const workflow=preparedWorkflow(original,true,repair),contract=pipelineContract(project,workflow,true);
 const selection=workflow.stages.filter(stage=>shouldCheckpointSourcePhase({stageId:stage.id,checkpointAfter:stage.checkpoint_after,executionPipeline:contract},project)).map(stage=>stage.id);
 assert.equal(JSON.stringify(original),before,'No historical snapshot is rewritten');
 assert.ok(selection.includes('test'));assert.ok(!selection.includes('implement'));
 const author=workflow.stages.find(stage=>stage.id==='test')!,verifier=workflow.stages.find(stage=>stage.id==='verify')!;
 assert.ok(verifier.depends_on?.includes(author.id));assert.equal(author.checkpoint_after,true);
 assert.deepEqual(repairVerifierPolicy(project,author.pattern.type==='verifier').actions.allowed_write_paths,['src/**','tests/**']);
 assert.deepEqual(repairVerifierPolicy(project,verifier.pattern.type==='verifier').actions.allowed_write_paths,[]);
 assert.equal(shouldCheckpointSourcePhase({stageId:'test',checkpointAfter:true,executionPipeline:{...contract,sourceChanges:false}},project),false);
 assert.equal(shouldCheckpointSourcePhase({stageId:'implement'},project),true,'Legacy stage configuration remains compatible');
});
