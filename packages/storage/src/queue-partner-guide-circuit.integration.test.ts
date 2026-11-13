import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadAgentRecords, loadWorkflowRecords } from '../../agent-registry/src/loaders.js';
import { withClient } from './client.js';
import { buildQueuePartnerGuideCircuitEvent, recordQueuePartnerGuideCircuitOutcome, reserveQueuePartnerGuideCircuitAttempt } from './queue-partner-guide-circuit.js';
import { appendActionReceipt } from './receipt-writer.js';
import { seedRegistry, verifyRunReceiptChain } from './postgres.js';

test('Guide circuit checkpoints catch up transactionally and survive a new storage client', async () => {
  await withClient(async client => assert.match(String((await client.query('select current_database() name')).rows[0]?.name), /^agentflow_suite_test_[a-f0-9]{32}$/u));
  await seedRegistry(await loadAgentRecords(process.cwd()), await loadWorkflowRecords(process.cwd()));
  const projectId = randomUUID();
  const runId = randomUUID();
  await withClient(async client => {
    await client.query('begin');
    await client.query("insert into projects(id,name,root_uri,profile,config) values($1,'Synthetic Guide checkpoint',$2,'test','{}')", [projectId, `/synthetic/guide-checkpoint-${projectId}`]);
    await client.query("insert into workflow_runs(id,project_id,workflow_id,status,task,autonomy) values($1,$2,'build-feature','running','Synthetic Guide checkpoint catch-up','2')", [runId, projectId]);
    let prior = null;
    for (let generation = 1; generation <= 105; generation += 1) {
      const event = buildQueuePartnerGuideCircuitEvent({ projectId, sourceRunId: runId, taskClass: 'build-feature', prior, kind: 'failure', failures: generation, reason: 'synthetic-timeout', recordedAt: new Date(Date.UTC(2026, 9, 29, 0, 0, generation)).toISOString() });
      await appendActionReceipt(client, { runId, agentId: 'workflow-guide', actionType: 'guide_circuit_transition', target: 'guide-circuit:build-feature', summary: `Synthetic generation ${generation}`, metadata: JSON.stringify(event) });
      prior = event;
    }
    await client.query('commit');
  });

  const first = await reserveQueuePartnerGuideCircuitAttempt({ runId, taskClass: 'build-feature', cooldownMs: 60_000, now: new Date('2026-10-29T01:00:00Z') });
  assert.equal(first.allowed, true);
  assert.equal(first.generation, 105);
  await recordQueuePartnerGuideCircuitOutcome({ runId, taskClass: 'build-feature', expectedGeneration: 105, outcome: 'failure', reason: 'synthetic-timeout', failureThreshold: 3, cooldownMs: 60_000, now: new Date('2026-10-29T01:00:01Z') });
  const afterRestart = await reserveQueuePartnerGuideCircuitAttempt({ runId, taskClass: 'build-feature', cooldownMs: 60_000, now: new Date('2026-10-29T01:00:02Z') });
  assert.equal(afterRestart.allowed, false);
  assert.equal(afterRestart.reason, 'durable-circuit-open');
  assert.equal(afterRestart.generation, 106);

  await withClient(async client => {
    const counts = (await client.query("select count(*) filter(where action_type='guide_circuit_transition')::int transitions,count(*) filter(where action_type='guide_circuit_checkpoint')::int checkpoints from action_receipts where run_id=$1", [runId])).rows[0];
    assert.deepEqual(counts, { transitions: 106, checkpoints: 1 });
    const checkpoint = (await client.query("select metadata from action_receipts where run_id=$1 and action_type='guide_circuit_checkpoint'", [runId])).rows[0]?.metadata;
    assert.equal(checkpoint.prefixCount, 80);
    assert.equal(checkpoint.terminalGeneration, 80);
    assert.equal(checkpoint.authority, 'audit-checkpoint-only');
    assert.equal((await client.query("select count(*)::int count from action_receipts where run_id=$1 and action_type='guide_circuit_transition' and (metadata->>'generation')::int<=80", [runId])).rows[0]?.count, 80);
  });
  assert.equal((await verifyRunReceiptChain(runId)).valid, true);

  const before = await withClient(async client => (await client.query('select count(*)::int count from action_receipts where run_id=$1', [runId])).rows[0]?.count as number);
  await withClient(async client => client.query("update action_receipts set metadata=jsonb_set(metadata,'{previousEventDigest}',to_jsonb($2::text)) where run_id=$1 and action_type='guide_circuit_transition' and metadata->>'generation'='106'", [runId, 'f'.repeat(64)]));
  await assert.rejects(reserveQueuePartnerGuideCircuitAttempt({ runId, taskClass: 'build-feature', cooldownMs: 60_000 }), /stale, unauthentic or unbound/u);
  const after = await withClient(async client => (await client.query('select count(*)::int count from action_receipts where run_id=$1', [runId])).rows[0]?.count as number);
  assert.equal(after, before, 'corrupt suffix validation rolls back without appending checkpoint or transition receipts');
});
