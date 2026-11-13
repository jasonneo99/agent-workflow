import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadAgentRecords, loadWorkflowRecords } from '../../agent-registry/src/loaders.js';
import { withClient } from './client.js';
import { queuePartnerGuideActorReadiness } from './queue-partner-guide-readiness.js';
import { seedRegistry } from './postgres.js';

test('Guide registry readiness detects current, missing and stale deployed actors without writes', async () => {
  await withClient(async client => assert.match(String((await client.query('select current_database() name')).rows[0]?.name), /^agentflow_suite_test_[a-f0-9]{32}$/u));
  await seedRegistry(await loadAgentRecords(process.cwd()), await loadWorkflowRecords(process.cwd()));
  const projectId = randomUUID(), runId = randomUUID();
  await withClient(async client => {
    await client.query("insert into projects(id,name,root_uri,profile,config) values($1,'Synthetic Guide readiness',$2,'test','{}')", [projectId, `/synthetic/guide-readiness-${projectId}`]);
    await client.query("insert into workflow_runs(id,project_id,workflow_id,status,task,autonomy) values($1,$2,'build-feature','running','Synthetic Guide registry readiness','2')", [runId, projectId]);
  });
  assert.equal((await queuePartnerGuideActorReadiness(runId)).ready, true);
  assert.equal((await queuePartnerGuideActorReadiness(randomUUID())).reason, 'guide-run-missing');
  const before = await withClient(async client => (await client.query('select count(*)::int count from action_receipts')).rows[0]?.count as number);
  await withClient(async client => client.query("update agents set definition=jsonb_set(definition,'{model_tier}',to_jsonb('reasoning'::text)) where id='workflow-guide'"));
  const stale = await queuePartnerGuideActorReadiness(runId);
  assert.equal(stale.ready, false);
  assert.equal(stale.reason, 'guide-actor-stale');
  const after = await withClient(async client => (await client.query('select count(*)::int count from action_receipts')).rows[0]?.count as number);
  assert.equal(after, before);
});
