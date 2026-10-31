import test from 'node:test';
import assert from 'node:assert/strict';
import {commandFailureEligibleForVerifyRetry,verifyRetryBudgetFromEnv} from './command-failure.js';

test('focused Python regressions get existing bounded feedback in single-shot coding stages',()=>{
 for(const command of ['python3 -m unittest tests.test_service -v','python3 -m unittest discover -s tests -p test_service.py -v','python -m unittest tests.test_service']){
  assert.equal(commandFailureEligibleForVerifyRetry({type:'single-shot'},command),true);
 }
 assert.equal(commandFailureEligibleForVerifyRetry({type:'single-shot'},'npm test'),true);
});
test('feedback recognition does not accept broad discovery, arbitrary Python or shell tails',()=>{
 for(const command of ['python3 -m unittest discover -s tests','python3 -m unittest discover -s tests -p test_*.py -v','python3 -m py_compile src/service.py','python3 -c "anything"','python3 -m unittest tests.test_service; echo bypass','python3 -m unittest ../outside']){
  assert.equal(commandFailureEligibleForVerifyRetry({type:'single-shot'},command),false,command);
 }
});
test('disabled and bounded retry settings remain unchanged',()=>{
 assert.equal(verifyRetryBudgetFromEnv({AGENTFLOW_VERIFY_RETRY_BUDGET:'0'}),0);
 assert.equal(verifyRetryBudgetFromEnv({AGENTFLOW_VERIFY_RETRY_BUDGET:'1'}),1);
 assert.equal(verifyRetryBudgetFromEnv({AGENTFLOW_VERIFY_RETRY_BUDGET:'999'}),verifyRetryBudgetFromEnv({AGENTFLOW_VERIFY_RETRY_BUDGET:'1000'}));
});
