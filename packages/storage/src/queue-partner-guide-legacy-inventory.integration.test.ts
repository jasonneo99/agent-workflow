import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadAgentRecords, loadWorkflowRecords } from '../../agent-registry/src/loaders.js';
import { withClient } from './client.js';
import { buildQueuePartnerExperimentExposure } from './queue-partner-experiments.js';
import { buildGuidePolicyTransition, summarizeQueuePartnerGuidePolicy, type QueuePartnerGuideObservation } from './queue-partner-guide-policy.js';
import { legacyGuideEvidenceInventory, legacyGuideEvidenceInventoryPage, reduceLegacyGuideEvidenceSnapshot } from './queue-partner-guide-legacy-inventory.js';
import { appendActionReceipt } from './receipt-writer.js';
import { seedRegistry } from './postgres.js';

test('legacy Guide inventory reads real JSONB evidence without rewriting receipts', async () => {
  await withClient(async client => assert.match(String((await client.query('select current_database() name')).rows[0]?.name), /^agentflow_suite_test_[a-f0-9]{32}$/u));
  await seedRegistry(await loadAgentRecords(process.cwd()), await loadWorkflowRecords(process.cwd()));
  const projectId = randomUUID(), validRun = randomUUID(), corruptRun = randomUUID();
  const observations: QueuePartnerGuideObservation[] = [
    ...Array.from({ length: 40 }, (_, index) => ({ runId: `g${index}`, taskClass: 'build-feature', cohort: 'guided' as const, accepted: index < 39, durationMs: 90 })),
    ...Array.from({ length: 40 }, (_, index) => ({ runId: `u${index}`, taskClass: 'build-feature', cohort: 'unguided' as const, accepted: index < 5, durationMs: 100 })),
  ];
  const report = summarizeQueuePartnerGuidePolicy(observations, 'build-feature');
  const transition = buildGuidePolicyTransition({ projectId, sourceRunId: validRun, report });
  const validExposure = buildQueuePartnerExperimentExposure({ runId: validRun, projectId, workerAgentId: 'implementation-agent', guideArm: 'guided' });
  const corruptExposure = buildQueuePartnerExperimentExposure({ runId: corruptRun, projectId, workerAgentId: 'implementation-agent', guideArm: 'unguided' });
  await withClient(async client => {
    await client.query('begin');
    await client.query("insert into projects(id,name,root_uri,profile,config) values($1,'Synthetic Guide inventory',$2,'test','{}')", [projectId, `/synthetic/guide-inventory-${projectId}`]);
    for (const runId of [validRun, corruptRun]) await client.query("insert into workflow_runs(id,project_id,workflow_id,status,task,autonomy) values($1,$2,'build-feature','completed','Synthetic Guide inventory','2')", [runId, projectId]);
    await appendActionReceipt(client, { runId: validRun, agentId: 'workflow-guide', actionType: 'guide_policy_transition', target: 'guide-policy:build-feature', summary: 'Synthetic legacy policy', metadata: JSON.stringify(transition) });
    await appendActionReceipt(client, { runId: validRun, agentId: 'queue-partner', actionType: 'queue_partner_experiment_exposure', target: 'partner-experiments', summary: 'Synthetic valid exposure', metadata: JSON.stringify(validExposure) });
    await appendActionReceipt(client, { runId: corruptRun, agentId: 'queue-partner', actionType: 'queue_partner_experiment_exposure', target: 'partner-experiments', summary: 'Synthetic corrupt exposure', metadata: JSON.stringify(corruptExposure) });
    await client.query("update action_receipts set metadata=jsonb_set(metadata,'{cohortKey}',to_jsonb('tampered'::text)) where run_id=$1 and action_type='queue_partner_experiment_exposure'", [corruptRun]);
    await client.query('commit');
  });
  const before = await withClient(async client => (await client.query('select count(*)::int count from action_receipts where run_id=any($1::uuid[])', [[validRun, corruptRun]])).rows[0]?.count as number);
  const inventory = await legacyGuideEvidenceInventory(projectId);
  assert.equal(inventory.legacyCompatible, 2);
  assert.equal(inventory.quarantined, 1);
  assert.equal(inventory.affectedProjects, 1);
  const reduced=await reduceLegacyGuideEvidenceSnapshot(projectId,1);
  assert.equal(reduced.manifest.receipts,3);assert.equal(reduced.manifest.pages,3);assert.equal(reduced.manifest.conclusion,'quarantined');assert.equal(reduced.manifest.compatible,2);assert.equal(reduced.manifest.quarantined,1);assert.equal(reduced.manifest.executionAcceptance,'unverified');assert.deepEqual(reduced.manifest.grants,{repair:false,replay:false,approval:false,acceptance:false});
  const signingKey=randomBytes(32),firstReduction=await reduceLegacyGuideEvidenceSnapshot(projectId,1,{signingKey,maxPages:1});
  assert.equal(firstReduction.complete,false);if(firstReduction.complete)throw Error('expected partial reduction');assert.equal(firstReduction.progress.pages,1);assert.equal(firstReduction.authority,'resume-only');assert.deepEqual(firstReduction.grants,{repair:false,replay:false,approval:false,promotion:false,acceptance:false});
  const secondReduction=await reduceLegacyGuideEvidenceSnapshot(projectId,1,{signingKey,maxPages:1,checkpoint:firstReduction.checkpoint});
  assert.equal(secondReduction.complete,false);if(secondReduction.complete)throw Error('expected second partial reduction');assert.equal(secondReduction.progress.pages,2);assert.notEqual(secondReduction.progress.checkpointHash,firstReduction.progress.checkpointHash);
  const resumedReduction=await reduceLegacyGuideEvidenceSnapshot(projectId,1,{signingKey,maxPages:1,checkpoint:secondReduction.checkpoint});
  assert.equal(resumedReduction.complete,true);if(!resumedReduction.complete)throw Error('expected completed reduction');assert.equal(resumedReduction.manifest.receipts,3);assert.equal(resumedReduction.manifest.checkpointHash,reduced.manifest.checkpointHash);assert.equal(resumedReduction.checkpoint,null);
  const firstPage=await legacyGuideEvidenceInventoryPage(projectId,{pageSize:1});
  assert.equal(firstPage.items.length,1);assert.equal(firstPage.complete,false);assert.ok(firstPage.nextCursor);assert.equal(firstPage.authority,'inventory-only');
  const secondPage=await legacyGuideEvidenceInventoryPage(projectId,{pageSize:1,cursor:firstPage.nextCursor!});
  assert.equal(secondPage.pageIndex,2);assert.equal(secondPage.items.length,1);assert.notEqual(secondPage.coverage.checkpointHash,firstPage.coverage.checkpointHash);
  await withClient(async client=>client.query("update action_receipts set receipt_hash=$2 where id=$1",[firstPage.items[0]!.receiptId,'f'.repeat(64)]));
  await assert.rejects(()=>legacyGuideEvidenceInventoryPage(projectId,{pageSize:1,cursor:firstPage.nextCursor!}),/changed after the previous page/);
  const after = await withClient(async client => (await client.query('select count(*)::int count from action_receipts where run_id=any($1::uuid[])', [[validRun, corruptRun]])).rows[0]?.count as number);
  assert.equal(after, before);
});
