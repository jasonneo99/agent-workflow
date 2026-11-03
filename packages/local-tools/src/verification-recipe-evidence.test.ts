import assert from 'node:assert/strict';
import test from 'node:test';
import {verificationRecipeEvidence,type DeclaredVerificationRule} from './verification-recipe-evidence.js';
const commandLine='python3 -m unittest discover -s tests -p test_synthetic.py -v';
const recipes=[{source_paths:['tests/test_synthetic.py'],test_paths:['tests/test_synthetic.py'],commands:[commandLine],output_paths:[]}];
const base={commandLine,stdout:'',stderr:'Ran 4 tests in 0.1s\n\nOK\n',exitCode:0,timedOut:false};
test('declared unittest recipes need actual passing collection with zero skips',()=>{
 assert.equal(verificationRecipeEvidence(base,recipes)?.status,'passed');
 for(const stderr of ['Ran 0 tests in 0.0s\nOK\n','Ran 4 tests in 0.1s\nOK (skipped=4)\n','Ran 4 tests in 0.1s\nOK (skipped=1)\n','Ran 4 tests in 0.1s\nOK (expected failures=1)\n','unittest completed','Ran 4 tests in 0.1s\nOK\nRan 4 tests in 0.1s\nOK\n'])assert.equal(verificationRecipeEvidence({...base,stderr},recipes)?.status,'failed',stderr);
 for(const patch of [{outputTruncated:true},{timedOut:true},{exitCode:1},{stderr:'\n...[middle truncated]...\nRan 4 tests in 0.1s\nOK\n'}])assert.equal(verificationRecipeEvidence({...base,...patch},recipes)?.status,'failed');
});
test('Node recipes reject zero tests, skipped cases and incomplete summaries',()=>{
 const commandLine='node --test tests/synthetic.test.js',p=[{...recipes[0]!,commands:[commandLine]}];
 const stdout='# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
 assert.equal(verificationRecipeEvidence({...base,commandLine,stdout,stderr:''},p)?.status,'passed');
 for(const text of [stdout.replace('# pass 3','# pass 0'),stdout.replace('# skipped 0','# skipped 1'),stdout.replace('# todo 0','')])assert.equal(verificationRecipeEvidence({...base,commandLine,stdout:text,stderr:''},p)?.status,'failed');
});
test('ordinary commands and undeclared recipes retain their existing semantics',()=>{
 assert.equal(verificationRecipeEvidence({...base,commandLine:'git diff --check'},recipes),undefined);
 assert.equal(verificationRecipeEvidence(base,undefined),undefined);
});

const helperCommand='python3 scripts/check_fixture.py --group portable';
const helperRecipes=[{...recipes[0]!,commands:[helperCommand]}];
const pytestRule:DeclaredVerificationRule={commands:[helperCommand],format:'pytest',minimum_tests:4,expected_tests:4};
const pytestResult={...base,commandLine:helperCommand,stdout:'4 passed in 0.10s\n',stderr:''};

test('trusted selected pytest declarations support helper and quoted interpreter commands',()=>{
 for(const commandLine of [helperCommand,'"/opt/synthetic toolchain/venv/bin/python3" -m pytest tests/test_synthetic.py -q']){
  const declaration={...pytestRule,commands:[commandLine]},owner=[{...recipes[0]!,commands:[commandLine]}];
  assert.deepEqual(verificationRecipeEvidence({...pytestResult,commandLine},owner,declaration),
   {status:'passed',cases:4,passed:4,skipped:0,reason:null});
 }
 const colored={...pytestResult,stdout:'\u001b[32m================ 4 passed in 0.10s ================\u001b[0m\r\n'};
 assert.equal(verificationRecipeEvidence(colored,helperRecipes,pytestRule)?.status,'passed');
});

test('a declared parser still requires raw complete passing collection and its exact size',()=>{
 for(const stdout of ['0 passed in 0.00s\n','no tests ran in 0.00s\n','3 passed in 0.10s\n',
  '5 passed in 0.10s\n','3 passed, 1 skipped in 0.10s\n','3 passed, 1 failed in 0.10s\n',
  '4 passed, 1 deselected in 0.10s\n','4 passed, 1 xfailed in 0.10s\n',
  '4 passed in 0.10s\n4 passed in 0.10s\n']){
  assert.equal(verificationRecipeEvidence({...pytestResult,stdout},helperRecipes,pytestRule)?.status,'failed',stdout);
 }
 for(const patch of [{exitCode:1},{timedOut:true},{outputTruncated:true},
  {stdout:'\n...[middle truncated]...\n4 passed in 0.10s\n'}]){
  assert.equal(verificationRecipeEvidence({...pytestResult,...patch},helperRecipes,pytestRule)?.status,'failed');
 }
});

test('selected parser cannot replace owner membership or literal command binding',()=>{
 assert.equal(verificationRecipeEvidence(pytestResult,undefined,pytestRule),undefined);
 assert.equal(verificationRecipeEvidence(pytestResult,recipes,pytestRule),undefined);
 for(const commands of [['python3 scripts/other_fixture.py'],['python3 *']]){
  const evidence=verificationRecipeEvidence(pytestResult,helperRecipes,{...pytestRule,commands});
  assert.equal(evidence?.status,'failed');
  assert.match(evidence!.reason!,/literal command/u);
 }
 assert.equal(verificationRecipeEvidence(pytestResult,helperRecipes,{...pytestRule,format:'unittest'})?.status,'failed');
});

test('observed passing metadata cannot replace a failed raw declared observation',()=>{
 const forged={...pytestResult,stdout:'1 failed in 0.10s\n',verificationRecipe:{status:'passed',cases:4,passed:4,skipped:0}};
 assert.equal(verificationRecipeEvidence(forged,helperRecipes,pytestRule)?.status,'failed');
 assert.equal(verificationRecipeEvidence(pytestResult,helperRecipes)?.status,'failed');
});

test('trusted declarations reuse the existing unittest and Node parsers for custom commands',()=>{
 const commandLine='"/opt/synthetic toolchain/venv/bin/python3" -m unittest tests.test_synthetic -v';
 const owner=[{...recipes[0]!,commands:[commandLine]}];
 assert.deepEqual(verificationRecipeEvidence({...base,commandLine},owner,
  {commands:[commandLine],format:'unittest',minimum_tests:4}),
  {status:'passed',cases:4,passed:4,skipped:0,reason:null});
 const node='node scripts/check-synthetic.mjs',nodes=[{...recipes[0]!,commands:[node]}];
 const result={...base,commandLine:node,stdout:'# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',stderr:''};
 assert.equal(verificationRecipeEvidence(result,nodes,{commands:[node],format:'node-test',minimum_tests:3})?.status,'passed');
});
