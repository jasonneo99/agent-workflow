import assert from 'node:assert/strict';
import test from 'node:test';
import {projectConfigSchema} from '../../../../packages/agent-registry/src/schemas.js';
import {planPartnerAdmission,materializeVerificationRecipes} from '../../../../packages/storage/src/partner-recovery-admission.js';

const project=()=>projectConfigSchema.parse({project:{name:'Synthetic recovery'},actions:{allowed_commands:['python3 -m unittest discover -s tests','git diff --check'],blocked_commands:[]}});
test('focused test omissions are actionable admission gaps, never a whitespace-only repair grant',()=>{
 const result=planPartnerAdmission(project(),['src/main.py','tests/test_main.py']);
 assert.deepEqual(result.missingTests,['tests/test_main.py']);
 assert.deepEqual(result.recipes,[{source_paths:['src/main.py','tests/test_main.py'],test_paths:['tests/test_main.py'],commands:['python3 -m unittest discover -s tests -p test_main.py -v'],output_paths:[]}]);
 assert.equal(result.ready,false);
});
test('an allowlisted interpreter still needs its explicit approval rule before admission',()=>{
 const p=project();p.actions.allowed_commands.push('python3 -m unittest discover -s tests -p test_main.py -v');
 const result=planPartnerAdmission(p,['tests/test_main.py']);
 assert.deepEqual(result.missingTests,[]);assert.equal(result.ready,false);
 assert.equal(result.approvalCommands[0],'python3 -m unittest discover -s tests -p test_main.py -v');
});
test('reviewed exact recipes require matching scope, command policy and interpreter approval',()=>{
 const p=project();const command='python3 -m unittest discover -s tests -p test_main.py -v';
 p.actions.allowed_commands.push(command);
 p.actions.approval_rules.push({id:'synthetic-exact',description:'Reviewed fixture',action_type:'local_command',target:command,effect:'auto_execute'});
 assert.equal(planPartnerAdmission(p,['tests/test_main.py']).ready,true);
 p.actions.blocked_commands.push('python3 -m unittest *');
 assert.equal(planPartnerAdmission(p,['tests/test_main.py']).ready,false);
 assert.deepEqual(materializeVerificationRecipes(p,['tests/test_other.py']),[]);
});
test('recipe declarations cannot authorize foreign tests, shell syntax, broad suites or new output paths',()=>{
 const p=project();
 for(const command of ['python3 -c bad','python3 -m unittest discover -s tests','npm test','node --test tests/other.test.js','python3 -m unittest tests.test_main; bad']){
  p.actions.verification_recipes=[{source_paths:['tests/test_main.py'],test_paths:['tests/test_main.py'],commands:[command],output_paths:[]}];
  assert.deepEqual(materializeVerificationRecipes(p,['tests/test_main.py']),[]);
 }
 p.actions.verification_recipes=[{source_paths:['tests/test_main.py'],test_paths:['tests/test_main.py'],commands:['python3 -m unittest tests.test_main -v'],output_paths:['outside']}];
 assert.deepEqual(materializeVerificationRecipes(p,['tests/test_main.py']),[]);
});
test('native, terminal and device gates cannot become automatic offline approval proposals',()=>{
 for(const path of ['tests/test_device.py','tests/test_worker_native.py','tests/test_terminal_session.py','tests/test_host_service.py']){
  const result=planPartnerAdmission(project(),[path]);assert.equal(result.ready,false);assert.deepEqual(result.recipes,[]);
  assert.ok(result.gaps.some(g=>g.startsWith('Separately governed')));
 }
});
