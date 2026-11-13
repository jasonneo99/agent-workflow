import assert from 'node:assert/strict';import test from 'node:test';
import {classifyFailureOwnership} from './failure-ownership.js';
test('literal approved py_compile wildcard is an Agent Workflow runtime code fix',()=>{
 const result=classifyFailureOwnership({runId:'run',failureReason:'Requested command failed',commandLine:'python3 -m py_compile roles/example/files/*.py',stderr:"[Errno 2] No such file or directory: 'roles/example/files/*.py'"});
 assert.equal(result.owner,'agent-workflow-runtime');assert.equal(result.codeFix,true);assert.equal(result.confidence,'high');
 assert.equal(result.repairRoute,'agent-workflow-runtime');assert.equal(result.requiredWorkerCapability,'python-pycompile-glob-v1');
});
test('ownership classifier refuses to turn policy or native evidence into code authority',()=>{
 const policy=classifyFailureOwnership({runId:'run',failureReason:'Command is not allowed by project policy'});
 assert.equal(policy.owner,'project-policy');assert.equal(policy.repairRoute,'originating-project-policy');assert.equal(policy.requiredWorkerCapability,null);
 assert.equal(classifyFailureOwnership({runId:'run',failureReason:'Connected iPhone unavailable for physical native proof'}).repairRoute,'external-evidence-owner');
 assert.equal(classifyFailureOwnership({runId:'run',failureReason:'Something happened'}).repairRoute,'manual-triage');
});
