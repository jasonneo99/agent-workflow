import assert from 'node:assert/strict';
import test from 'node:test';
import {verificationRecipeEvidence} from './verification-recipe-evidence.js';
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
