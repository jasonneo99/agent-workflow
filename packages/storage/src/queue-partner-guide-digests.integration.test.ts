import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadAgentRecords, loadWorkflowRecords } from '../../agent-registry/src/loaders.js';
import { withClient } from './client.js';
import { buildQueuePartnerExperimentExposure, validateQueuePartnerExperimentExposure } from './queue-partner-experiments.js';
import { buildGuidePolicyTransition, guidePolicyEvidenceDigest, parseGuidePolicyTransitionHistory, summarizeQueuePartnerGuidePolicy, type QueuePartnerGuideObservation } from './queue-partner-guide-policy.js';
import { appendActionReceipt } from './receipt-writer.js';
import { seedRegistry } from './postgres.js';

test('Guide policy and experiment digests survive real JSONB persistence', async () => {
  await withClient(async client => assert.match(String((await client.query('select current_database() name')).rows[0]?.name), /^agentflow_suite_test_[a-f0-9]{32}$/u));
  await seedRegistry(await loadAgentRecords(process.cwd()), await loadWorkflowRecords(process.cwd()));
  const projectId = randomUUID(), runId = randomUUID();
  const observations: QueuePartnerGuideObservation[] = [
    ...Array.from({ length: 40 }, (_, index) => ({ runId: `g-${index}`, taskClass: 'build-feature', cohort: 'guided' as const, accepted: index < 39, durationMs: 90 })),
    ...Array.from({ length: 40 }, (_, index) => ({ runId: `u-${index}`, taskClass: 'build-feature', cohort: 'unguided' as const, accepted: index < 5, durationMs: 100 })),
  ];
  const report = summarizeQueuePartnerGuidePolicy(observations, 'build-feature');
  const transition = buildGuidePolicyTransition({ projectId, sourceRunId: runId, report, recordedAt: '2026-10-29T00:00:00Z' });
  const exposure = buildQueuePartnerExperimentExposure({ runId, projectId, workerAgentId: 'implementation-agent', guideArm: 'guided', assignedAt: '2026-10-29T00:00:00Z' });
  await withClient(async client => {
    await client.query('begin');
    await client.query("insert into projects(id,name,root_uri,profile,config) values($1,'Synthetic Guide digest',$2,'test','{}')", [projectId, `/synthetic/guide-digest-${projectId}`]);
    await client.query("insert into workflow_runs(id,project_id,workflow_id,status,task,autonomy) values($1,$2,'build-feature','running','Synthetic Guide digest roundtrip','2')", [runId, projectId]);
    await appendActionReceipt(client, { runId, agentId: 'workflow-guide', actionType: 'guide_policy_transition', target: 'guide-policy:build-feature', summary: 'Synthetic policy transition', metadata: JSON.stringify(transition) });
    await appendActionReceipt(client, { runId, agentId: 'queue-partner', actionType: 'queue_partner_experiment_exposure', target: 'partner-experiments', summary: 'Synthetic experiment exposure', metadata: JSON.stringify(exposure) });
    await client.query('commit');
  });
  const rows = await withClient(async client => (await client.query("select action_type,metadata from action_receipts where run_id=$1 and action_type=any($2::text[]) order by created_at", [runId, ['guide_policy_transition', 'queue_partner_experiment_exposure']])).rows);
  const persistedTransition = rows.find(row => row.action_type === 'guide_policy_transition')?.metadata;
  const parsed = parseGuidePolicyTransitionHistory([{ metadata: persistedTransition, createdAt: transition.recordedAt, receiptAuthentic: true }], projectId, 'build-feature', guidePolicyEvidenceDigest(report));
  assert.equal(parsed.quarantined, 0);
  assert.equal(parsed.current?.transitionDigest, transition.transitionDigest);
  const persistedExposure = rows.find(row => row.action_type === 'queue_partner_experiment_exposure')?.metadata;
  assert.equal(validateQueuePartnerExperimentExposure(persistedExposure, runId, projectId)?.exposureDigest, exposure.exposureDigest);
});
