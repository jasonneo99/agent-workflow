import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bindChildObservation,type ChildObservation} from './queue-repair-disposition-storage.js';
const row:ChildObservation={source_id:'source',project_id:'project',claim_id:'claim',fence:'9',child_id:'child',status:'blocked',metadata:{sourceRunId:'source',queueCoordinatorClaimId:'claim',queueCoordinatorFence:9},reason:'Current exact blocker',receipt_id:'receipt'};
test('exact assignment and valid chain retain current observation without granting authority',()=>{
 const result=bindChildObservation(row,true)!;
 assert.equal(result.fullChainValid,true);assert.equal(result.blocker?.kind,'reconciliation');
 assert.equal(result.blocker?.reason,row.reason);
});
test('foreign claim, source, fence and invalid chain fail closed',()=>{
 for(const metadata of [{...row.metadata,sourceRunId:'foreign'},{...row.metadata,queueCoordinatorClaimId:'foreign'},{...row.metadata,queueCoordinatorFence:10}])assert.equal(bindChildObservation({...row,metadata},true)?.fullChainValid,false);
 assert.equal(bindChildObservation(row,false)?.fullChainValid,false);
});
