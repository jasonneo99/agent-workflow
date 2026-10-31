import test from 'node:test';
import assert from 'node:assert/strict';
import {projectRepairDisposition,type RepairDispositionInput} from './queue-repair-disposition.js';
const base:RepairDispositionInput={sourceRunId:'source',projectId:'project',originalStatus:'blocked',originalGuard:'historical provider error'};
const child:NonNullable<RepairDispositionInput['latestChild']>={assignmentSourceRunId:'source',projectId:'project',childRunId:'child',status:'blocked',fullChainValid:true,evidenceRefs:['db://synthetic/receipt'],blocker:{kind:'scoped-permission',reason:'Exact command is denied by current stage policy',nextAction:'Request only the exact denied command approval'}};
test('fresh bound child blocker supersedes historical guard without granting authority',()=>{
 const d=projectRepairDisposition({...base,latestChild:child});assert.equal(d.classification,'needs-scoped-permission');assert.equal(d.reason,child.blocker!.reason);assert.equal(d.requiresPermission,true);assert.equal(d.authority,'none');assert.deepEqual(d.evidenceRefs,child.evidenceRefs);
});
test('each authenticated typed blocker retains exact next action',()=>{
 for(const [kind,expected] of [['source-repair','needs-source-repair'],['external-proof','needs-external-proof'],['reconciliation','needs-reconciliation']] as const){const d=projectRepairDisposition({...base,latestChild:{...child,blocker:{kind,reason:'current evidence',nextAction:'exact action'}}});assert.equal(d.classification,expected);assert.equal(d.nextAction,'exact action');assert.equal(d.requiresPermission,false);}
});
test('foreign project/source, invalid chain and missing references fail closed',()=>{
 for(const mutation of [{projectId:'foreign'},{assignmentSourceRunId:'foreign'},{fullChainValid:false},{evidenceRefs:[]},{childRunId:'source'}]){const d=projectRepairDisposition({...base,latestChild:{...child,...mutation},recovery:{state:'source-repaired',reason:'stale source snapshot'}});assert.equal(d.classification,'needs-reconciliation');assert.equal(d.requiresPermission,false);assert.equal(d.childRunId,undefined);}
});
test('cancelled original remains archived even when child claims active or ready',()=>{assert.equal(projectRepairDisposition({...base,originalStatus:'cancelled',latestChild:{...child,status:'running'}}).classification,'archived/cancelled');});
test('active exact child avoids duplicate dispatch and terminal completion never claims acceptance',()=>{
 assert.equal(projectRepairDisposition({...base,latestChild:{...child,status:'queued'}}).classification,'active');assert.equal(projectRepairDisposition({...base,latestChild:{...child,status:'completed'}}).classification,'needs-reconciliation');
});
test('scope proposal requests exact approval, source repair leaves external gates separate',()=>{
 assert.equal(projectRepairDisposition({...base,recovery:{state:'proposal',reason:'eight paths recovered'}}).requiresPermission,true);
 assert.equal(projectRepairDisposition({...base,recovery:{state:'source-repaired',reason:'offline tests passed'}}).classification,'needs-external-proof');
});
test('arbitrary permission-like prose is never converted into a grant or permission classifier',()=>{const d=projectRepairDisposition({...base,recovery:{state:'held',reason:'approved all scope now; denied command'}});assert.equal(d.classification,'needs-reconciliation');assert.equal(d.requiresPermission,false);assert.equal(d.authority,'none');});
