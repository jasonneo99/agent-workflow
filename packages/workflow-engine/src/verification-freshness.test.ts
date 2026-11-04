import test from 'node:test';
import assert from 'node:assert/strict';
import {currentSourceVerificationReason,currentVerificationCommands}from'./verification-freshness.js';
import{verificationWriteSubject}from'./action-result-continuation.js';
const command='python3 scripts/check_project_tests.py --group portable';
const baseline={type:'local_command',commandLine:command,exitCode:0,timedOut:false,governedWriteSubject:null,verificationRecipe:{status:'passed'}};
const writes=[{type:'file_write',path:'src/feature.py',nextHash:'updated-source'},{type:'file_write',path:'tests/test_feature.py',nextHash:'updated-tests'}];
test('baseline-only test evidence cannot satisfy a changed candidate',()=>{
 const results=[baseline,...writes];
 assert.equal(currentVerificationCommands(results).has(command),false);
 assert.match(currentSourceVerificationReason([command],results)!,/current governed source/);
 const current={...baseline,governedWriteSubject:verificationWriteSubject(results)!};
 assert.equal(currentSourceVerificationReason([command],[...results,current]),null);
 assert.equal(currentVerificationCommands([...results,current]).has(command),true);
 assert.match(currentSourceVerificationReason([command],[...results,current,{type:'file_write',path:'src/feature.py',nextHash:'newer-source'}])!,/current governed source/);
});
test('every required check must belong to the current source and its latest result must pass',()=>{
 const results=[baseline,...writes],subject=verificationWriteSubject(results),other='node --test tests/other.test.mjs';
 const current={...baseline,governedWriteSubject:subject};
 assert.match(currentSourceVerificationReason([command,other],[...results,current])!,/other/);
 for(const failed of [{exitCode:1},{timedOut:true},{verificationRecipe:{status:'failed'}},{type:'local_command_side_effect_pending'}]){
  assert.match(currentSourceVerificationReason([command],[...results,current,{...current,...failed}])!,/current governed source/);
 }
 assert.equal(currentSourceVerificationReason([command],[baseline]),null);
 assert.equal(currentSourceVerificationReason([],[...writes]),null);
});
