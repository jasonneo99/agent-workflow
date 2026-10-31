import test from 'node:test';
import assert from 'node:assert/strict';
import {validObsoletePolicyDecision,OBSOLETE_POLICY_CONFIRMATION,type ObsoletePolicyDispositionInput} from './obsolete-policy-disposition.js';
const input:ObsoletePolicyDispositionInput={projectId:'synthetic',authorizationArtifactUri:'artifact://human',runId:'historical',originalTaskDigest:'a'.repeat(64),reviewSourceRunId:'current-source',reviewRunId:'accepted-review',claimId:'claim',claimFence:'1',owner:'owner',intentFence:'1',actor:'human',reason:'A later explicit policy supersedes the historical restriction.',supersedingInstruction:'Scoped product mirror edits may be explicitly approved.',confirmation:OBSOLETE_POLICY_CONFIRMATION};
test('explicit obsolete policy retirement is distinct from historical acceptance',()=>{
 assert.equal(validObsoletePolicyDecision(input),true);
 for(const changed of [{confirmation:'Complete the original contract'},{confirmation:'Archive from active views.'},{actor:''},{reason:''},{supersedingInstruction:''},{originalTaskDigest:'narrative'},{reviewRunId:input.runId},{reviewSourceRunId:input.runId}])assert.equal(validObsoletePolicyDecision({...input,...changed}),false);
});
